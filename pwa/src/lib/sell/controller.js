// Selling FIRO through buyfiro.app, without any screen: the chains and tokens
// it pays, what an amount brings (asked again on every change, the latest
// question only), a deposit address for one sell (kept on this device before
// it is shown), that this wallet paid it (written down before and after the
// payment leaves), and where each open sell is (asked as often as buyfiro.app
// says, less often while it cannot be reached, never again once it has ended).
//
// One controller per unlocked wallet (lib/sell/wiring.js); it outlives the
// screens, so sells are followed after their screen closes. It follows them
// only while the wallet is unlocked and the page is visible: the wiring
// pauses it otherwise, and locking disposes of it.

import { SellError, sameToken } from './sellfiro.js';
import { makeOrder, withStatus, withSending, withSent, withUnsure, sameAs } from './store.js';
import { systemClock } from '../buy/controller.js';
import { t } from '../i18n.js';

export { systemClock };

const LIST_TTL_MS = 10 * 60 * 1000;

/** The same payout destination: chain, token and address (buyfiro.app keeps one open sell per destination). */
export function samePayout(a, b) {
  return Boolean(a && b) && a.chainId === b.chainId && sameToken(a.token, b.token) && String(a.address).toLowerCase() === String(b.address).toLowerCase();
}

export class SellController {
  constructor({ client, store, clock = systemClock, autoPoll = true, quoteDelayMs = 400, defaultPollMs = 15000, maxBackoffMs = 5 * 60 * 1000, orderRetries = 2 }) {
    this.client = client;
    this.store = store;
    this.clock = clock;
    /** Follow open sells on timers (tests call pollDue themselves). */
    this.autoPoll = autoPoll;
    /** How long typing must pause before a price is asked for. */
    this.quoteDelayMs = quoteDelayMs;
    /** Between two looks at a sell, when buyfiro.app does not say. */
    this.defaultPollMs = defaultPollMs;
    /** The longest wait between looks while buyfiro.app cannot be reached. */
    this.maxBackoffMs = maxBackoffMs;
    /** Extra tries of a deposit-address request that got no answer. */
    this.orderRetries = orderRetries;

    this._listeners = new Set();
    this._disposed = false;
    this._chains = null; // {value, at}
    this._tokens = new Map(); // "chainId|symbol" -> {value, at}
    this._limits = null; // {payoutKey, value}
    this._refusedBelowFiro = null;

    this._quoteRequest = null;
    this._quote = null;
    this._quoteError = null;
    this._quoting = false;
    this._quoteSeq = 0;
    this._quoteCancel = null;

    this._orders = new Map();
    this._dueAt = new Map();
    this._failures = new Map();
    this._pollErrors = new Map();
    this._busy = new Set();
    /** Orders whose last write failed: written again with the next change. */
    this._unsaved = new Set();
    /** How many answers buyfiro.app gave about each sell (lookNow: did a look answer?). */
    this._answers = new Map();
    /** The look at a sell on its way, if any: a second caller waits for the same answer. */
    this._inflight = new Map();
    /** A deposit-address request on its way, by what it asks: a second tap waits for the same answer. */
    this._placing = new Map();
    /** Sells whose "payment started" mark is being written now: a second mark waits for nothing, it is refused. */
    this._marking = new Set();
    this._resuming = null;
    this._paused = false;
    this._wake = null;
  }

  get sandbox() {
    return this.client.sandbox;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _changed() {
    if (this._disposed) return;
    for (const fn of this._listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  dispose() {
    this._disposed = true;
    if (this._quoteCancel) this._quoteCancel();
    if (this._wake) this._wake();
    this._wake = null;
    this._listeners.clear();
  }

  // -------------------------------------------------------------- payouts

  /** The chains buyfiro.app pays on (kept ten minutes): {chains, recommended}. */
  async payoutChains({ refresh = false } = {}) {
    const c = this._chains;
    if (!refresh && c && this.clock.now() - c.at < LIST_TTL_MS) return c.value;
    const value = await this.client.payoutChains();
    this._chains = { value, at: this.clock.now() };
    return value;
  }

  /** The tokens buyfiro.app pays on chainId, all or those called `symbol` (kept ten minutes). */
  async payoutTokens(chainId, { symbol = null } = {}) {
    const key = `${chainId}|${symbol ? symbol.toUpperCase() : ''}`;
    const c = this._tokens.get(key);
    if (c && this.clock.now() - c.at < LIST_TTL_MS) return c.value;
    const value = await this.client.payoutTokens(chainId, { symbol });
    this._tokens.set(key, { value, at: this.clock.now() });
    return value;
  }

  /** The smallest and largest sell for the payout last asked about. */
  get limits() {
    return this._limits ? this._limits.value : null;
  }

  /** The smallest sell to say up front (FIRO): buyfiro.app's figure, else the one a refused price stated here. A hint: a price decides. */
  get minimumHintFiro() {
    return this._limits?.value?.minimumFiro ?? this._refusedBelowFiro ?? null;
  }

  /** Reads the limits for a payout; the last ones are kept when buyfiro.app cannot be reached. */
  async refreshLimits(payout) {
    try {
      const value = await this.client.limits(payout);
      this._limits = { payoutKey: payout ? `${payout.chainId}|${payout.token}` : '', value };
      this._changed();
    } catch (e) {
      if (!(e instanceof SellError)) throw e;
      // The form says nothing about a minimum until a quote does.
    }
    return this.limits;
  }

  // --------------------------------------------------------------- quotes

  /** What is being priced: {amount (satoshi), payout}, or null. */
  get quoteRequest() {
    return this._quoteRequest;
  }

  /** The price of quoteRequest, once known. */
  get quote() {
    return this._quote;
  }

  /** Why quoteRequest has no price. */
  get quoteError() {
    return this._quoteError;
  }

  /** A price is being asked for (or about to be). */
  get quoting() {
    return this._quoting;
  }

  /** Prices `request` once typing pauses; the answer to any earlier request is dropped. Null clears the price. */
  requestQuote(request, { afterMs = null } = {}) {
    if (this._quoteCancel) this._quoteCancel();
    const seq = ++this._quoteSeq;
    this._quoteRequest = request;
    this._quote = null;
    this._quoteError = null;
    this._quoting = request !== null;
    this._changed();
    if (request === null) return;
    this._quoteCancel = this.clock.schedule(afterMs ?? this.quoteDelayMs, () => this._runQuote(seq, request));
  }

  /** Forgets the price being asked for without telling anyone (a form opening or closing). */
  cancelQuote() {
    if (this._quoteCancel) this._quoteCancel();
    this._quoteSeq++;
    this._quoteRequest = null;
    this._quote = null;
    this._quoteError = null;
    this._quoting = false;
  }

  /** Asks for the same price again, now ("Try again"). */
  requote() {
    if (this._quoteRequest) this.requestQuote(this._quoteRequest, { afterMs: 0 });
  }

  async _runQuote(seq, r) {
    if (seq !== this._quoteSeq || this._disposed) return;
    try {
      const q = await this.client.quote({ amount: r.amount, payout: r.payout });
      if (seq !== this._quoteSeq || this._disposed) return;
      this._quote = q;
    } catch (e) {
      const err = e instanceof SellError ? e : new SellError('network');
      if (err.belowMinimum && err.minimumFiro != null) this._refusedBelowFiro = err.minimumFiro;
      if (seq !== this._quoteSeq || this._disposed) return;
      this._quoteError = err;
    }
    this._quoting = false;
    this._changed();
  }

  // --------------------------------------------------------------- orders

  /** Every sell (of walletId when given), newest first. */
  orders(walletId = null) {
    return [...this._orders.values()].filter((o) => walletId === null || o.walletId === walletId).sort((a, b) => b.createdAt - a.createdAt);
  }

  order(orderId) {
    return this._orders.get(orderId) || null;
  }

  /** Why the last look at a sell got no answer (null after one that did). */
  pollError(orderId) {
    return this._pollErrors.get(orderId) || null;
  }

  /** When the next look at a sell is due (ms; null: never, it has ended). */
  dueAt(orderId) {
    return this._dueAt.get(orderId) ?? null;
  }

  /** Loads the sells kept on this device and follows the open ones (once; later calls wait for the first). */
  resumeAll() {
    if (!this._resuming) this._resuming = this._resume();
    return this._resuming;
  }

  async _resume() {
    let stored;
    try {
      stored = await this.store.all();
    } catch (e) {
      // The next screen that opens asks again.
      this._resuming = null;
      this.loadError = e;
      this._changed();
      return;
    }
    this.loadError = null;
    const now = this.clock.now();
    for (const o of stored) {
      if (!this._orders.has(o.orderId)) this._orders.set(o.orderId, o);
      if (o.isOpen && !this._dueAt.has(o.orderId)) this._dueAt.set(o.orderId, now);
    }
    this._changed();
    this._arm();
  }

  /**
   * A deposit address for selling `amount` (satoshi) of walletId's FIRO, paid
   * as payout ({chainId, chainName, token, symbol, address, own}). Paying from
   * the private balance asks for a Spark deposit address, and takes a
   * transparent one (fellBack) when buyfiro.app has Spark deposits off. The sell
   * is on this device before this returns. A request that got no answer is sent
   * again as it was, and buyfiro.app returns the same order for it; a second
   * call while one is on its way gets the same answer.
   */
  placeOrder({ amount, payout, payFrom, walletId, quote = null }) {
    const key = [amount, payout.chainId, String(payout.token).toLowerCase(), String(payout.address).toLowerCase(), payFrom, walletId].join('|');
    const running = this._placing.get(key);
    if (running) return running;
    const p = this._place({ amount, payout, payFrom, walletId, quote }).finally(() => this._placing.delete(key));
    this._placing.set(key, p);
    return p;
  }

  async _place({ amount, payout, payFrom, walletId, quote }) {
    await this.resumeAll();
    let depositKind = payFrom === 'private' ? 'spark' : 'firo';
    let fellBack = false;
    let answer = null;
    for (let attempt = 0; answer === null; ) {
      try {
        answer = await this.client.order({ amount, payout, depositKind });
      } catch (e) {
        if (e instanceof SellError && e.code === 'spark_unavailable' && depositKind === 'spark') {
          // Spark deposits are off at buyfiro.app: the same sell to a transparent address, said on its screen.
          depositKind = 'firo';
          fellBack = true;
          continue;
        }
        if (!(e instanceof SellError) || !e.unreachable || attempt >= this.orderRetries) throw e;
        attempt++;
      }
    }
    const known = this._orders.get(answer.orderId);
    // buyfiro.app's one open sell for this payout, made from another wallet on this device or from
    // another device (reused, and not this wallet's): never paid again from here (audit of 0.1.8, X4).
    if (answer.reused && !(known && known.walletId === walletId)) {
      throw new SellError('order_exists', { orderId: answer.orderId, elsewhere: true, amountFiro: Number(amount) / 1e8 });
    }
    // The same order again (a retry, or buyfiro.app's one open sell per destination): what this device knows of it stays.
    const order =
      known && known.walletId === walletId
        ? known
        : makeOrder({
            orderId: answer.orderId,
            walletId,
            amount,
            depositKind: answer.depositKind,
            depositAddress: answer.depositAddress,
            sparkDepositAddress: answer.sparkDepositAddress,
            payFrom,
            fellBack,
            payout,
            createdAt: this.clock.now(),
            receiveUsd: answer.receiveUsd ?? quote?.receiveUsd ?? null,
            expiresAt: answer.expiresInMs != null ? this.clock.now() + answer.expiresInMs : null,
            lastState: 'awaiting_deposit',
            payable: answer.payable,
            sandbox: this.client.sandbox,
          });
    // On this device before anything shows the address.
    await this.store.save(order);
    this._orders.set(order.orderId, order);
    if (order.isOpen) this._dueAt.set(order.orderId, this.clock.now() + this.defaultPollMs);
    this._changed();
    this._arm();
    return order;
  }

  /**
   * This wallet is about to pay orderId: written down first, so that if the
   * page dies mid-payment the sell is not offered for payment again. Throws
   * (and nothing may be sent) when it could not be written, and with code
   * 'paid' when the sell already carries a payment (sent, or one that may have
   * left) or another mark of it is being written right now: the mark is in
   * memory only once it is on disk, so two ways in at once both found the sell
   * unmarked and both paid it (release verification 0.1.8).
   */
  async markSending(orderId, { retry = false } = {}) {
    const o = this._orders.get(orderId);
    if (!o) throw new Error(t('No such sell on this device.'));
    if (o.sentTxid || o.unsureTxid) throw Object.assign(new Error(t('This sell already has a payment from this wallet, so nothing more was sent.')), { code: 'paid' });
    // Every way in is refused here, not only on the screen (audit of 0.1.8, X4): paid from another
    // wallet by the person's word, or a payment from here already started (only the person's own
    // "I looked: it isn't there" may try again).
    if (o.paidElsewhereAt) throw Object.assign(new Error(t('You said you paid this sell from another wallet, so nothing was sent from this one.')), { code: 'paid' });
    if (o.sendStartedAt && !retry) throw Object.assign(new Error(t('A payment for this sell has already started, so nothing more was sent.')), { code: 'paid' });
    if (this._marking.has(orderId)) throw Object.assign(new Error(t('A payment for this sell is already on its way, so nothing more was sent.')), { code: 'paid' });
    this._marking.add(orderId);
    try {
      const at = this.clock.now();
      const next = withSending(o, at);
      await this.store.save(next);
      // A look that answered meanwhile changed the record: the mark goes on top of it, and is
      // written again with it (audit FM-2).
      const cur = this._orders.get(orderId);
      if (cur === o) {
        this._orders.set(orderId, next);
        this._written(next);
        this._changed();
        return next;
      }
      const merged = withSending(cur, at);
      this._orders.set(orderId, merged);
      await this._saveQuietly(merged);
      this._changed();
      return merged;
    } finally {
      this._marking.delete(orderId);
    }
  }

  /**
   * This wallet paid orderId: its transaction and the balance it came from.
   * Kept in memory even when the write fails (it is written again with the
   * next change), so the screen never offers to pay it again.
   */
  async markSent(orderId, { txid, from }) {
    const o = this._orders.get(orderId);
    if (!o) return null;
    const next = withSent(o, { txid, from, at: this.clock.now() });
    this._orders.set(orderId, next);
    await this._saveQuietly(next);
    // buyfiro.app sees a deposit within minutes: look sooner than usual once.
    if (next.isOpen) this._dueAt.set(orderId, Math.min(this._dueAt.get(orderId) ?? Infinity, this.clock.now() + this.defaultPollMs));
    this._changed();
    this._arm();
    return next;
  }

  /**
   * This wallet's payment of orderId got no answer from the node (lib/send_outcome.js 'unsure'):
   * it may have left. Its txid is kept with the sell (in memory even when the write fails), so the
   * sell is followed by that payment and never offered for payment again until the engine lets
   * it go.
   */
  async markUnsure(orderId, { txid, from, height = null }) {
    const o = this._orders.get(orderId);
    if (!o || o.sentTxid) return o || null;
    const next = withUnsure(o, { txid, from, height, at: this.clock.now() });
    this._orders.set(orderId, next);
    await this._saveQuietly(next);
    this._changed();
    return next;
  }

  /**
   * Nothing left the wallet for orderId: the engine refused the payment before broadcasting it,
   * or a node refused it. The sell may be paid again. Only for what the engine names as such.
   */
  async markNotSent(orderId) {
    const o = this._orders.get(orderId);
    // Never a sell carrying a payment that left or may have left (markDropped settles those).
    if (!o || o.sentTxid || o.unsureTxid || !o.sendStartedAt) return o || null;
    const next = makeOrder({ ...o, sendStartedAt: null });
    this._orders.set(orderId, next);
    await this._saveQuietly(next);
    this._changed();
    return next;
  }

  /**
   * The engine says the network does not have this wallet's payment `txid` of orderId (its Tx is
   * dropped: it did not go through, its coins are free again): the sell may be paid again
   * (release audit FM-1). Only for the payment the sell carries.
   */
  async markDropped(orderId, { txid }) {
    const o = this._orders.get(orderId);
    if (!o || !txid || (o.unsureTxid !== txid && o.sentTxid !== txid)) return o || null;
    const next = makeOrder({ ...o, sendStartedAt: null, sentTxid: null, sentFrom: null, sentAt: null, unsureTxid: null, unsureHeight: null });
    this._orders.set(orderId, next);
    await this._saveQuietly(next);
    this._changed();
    return next;
  }

  /**
   * The person paid orderId from another wallet ("Pay from another wallet"): the started mark is
   * set with it, so this wallet never offers to pay it too (audit FM-10). Written before it shows.
   */
  async markPaidElsewhere(orderId) {
    const o = this._orders.get(orderId);
    if (!o) return null;
    if (o.paidElsewhereAt) return o;
    if (o.sentTxid || o.unsureTxid || o.sendStartedAt) {
      // This wallet's own payment started too: both are kept and said (the screen warns that the
      // sell may be paid twice), never silently ignored (audit of 0.1.8, X4).
      const both = makeOrder({ ...o, paidElsewhereAt: this.clock.now() });
      await this.store.save(both);
      this._orders.set(orderId, both);
      this._written(both);
      this._changed();
      return both;
    }
    const at = this.clock.now();
    const next = makeOrder({ ...withSending(o, at), paidElsewhereAt: at });
    await this.store.save(next);
    const cur = this._orders.get(orderId);
    const final = cur === o ? next : makeOrder({ ...withSending(cur, at), paidElsewhereAt: at });
    this._orders.set(orderId, final);
    if (final === next) this._written(next);
    else await this._saveQuietly(final);
    this._changed();
    return final;
  }

  /**
   * Whether "I haven't paid it" may undo sell `o`'s "paid from another wallet": nothing of this
   * wallet's own started since (FM-10). The sell's screen and the Sell form (when buyfiro.app
   * refuses a new sell to that payout because of it, release re-audit R-9) both ask.
   */
  canUnmarkPaidElsewhere(o) {
    return Boolean(o && o.paidElsewhereAt && !o.sentTxid && !o.unsureTxid && o.sendStartedAt === o.paidElsewhereAt);
  }

  /** "I haven't paid it": undoes markPaidElsewhere, unless this wallet's own payment started since. */
  async unmarkPaidElsewhere(orderId) {
    const o = this._orders.get(orderId);
    if (!this.canUnmarkPaidElsewhere(o)) return o || null;
    const next = makeOrder({ ...o, paidElsewhereAt: null, sendStartedAt: null });
    this._orders.set(orderId, next);
    await this._saveQuietly(next);
    this._changed();
    return next;
  }

  /** Stops following sells (the page is hidden). */
  pause() {
    this._paused = true;
    if (this._wake) this._wake();
    this._wake = null;
  }

  /** Follows them again, everything that is due first. */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this.pollDue();
  }

  /** Looks at every open sell whose turn it is. */
  async pollDue() {
    if (this._disposed || this._paused) return;
    const now = this.clock.now();
    const due = [...this._orders.values()].filter((o) => o.isOpen && !this._busy.has(o.orderId) && !((this._dueAt.get(o.orderId) ?? -Infinity) > now)).map((o) => o.orderId);
    for (const id of due) await this.poll(id);
    this._arm();
  }

  /**
   * Asks buyfiro.app where orderId is right now, for a decision (paying it), waiting at most
   * timeoutMs: {order (as it is after the look), answered (buyfiro.app answered about this sell)}.
   * A look already on its way counts once it answers.
   */
  async lookNow(orderId, { timeoutMs = 15000 } = {}) {
    const before = this._answers.get(orderId) || 0;
    let cancel = () => {};
    const late = new Promise((res) => {
      cancel = this.clock.schedule(timeoutMs, res);
    });
    await Promise.race([this.poll(orderId).catch(() => null), late]);
    cancel();
    return { order: this._orders.get(orderId) || null, answered: (this._answers.get(orderId) || 0) > before };
  }

  /** Looks at the sell orderId once, now (a look on its way is waited for, not doubled). */
  poll(orderId) {
    const o = this._orders.get(orderId);
    if (!o || !o.isOpen || this._disposed) return Promise.resolve(o || null);
    if (this._busy.has(orderId)) return this._inflight.get(orderId) || Promise.resolve(o);
    const p = this._look(orderId, o).finally(() => this._inflight.delete(orderId));
    this._inflight.set(orderId, p);
    return p;
  }

  async _look(orderId, o) {
    this._busy.add(orderId);
    try {
      const s = await this.client.status(orderId);
      // A sell paid somewhere else than it was asked for is not this sell's answer.
      if (s.payout && ((s.payout.address && s.payout.address.toLowerCase() !== o.payout.address.toLowerCase()) || (s.payout.chainId != null && s.payout.chainId !== o.payout.chainId))) throw new SellError('unexpected_answer');
      // The record as it is NOW: a payment marked while buyfiro.app was answering (markSending,
      // markSent) stays; only buyfiro.app's fields come from its answer (audit FM-2).
      const cur = this._orders.get(orderId) || o;
      const next = withStatus(cur, s, this.clock.now());
      this._failures.delete(orderId);
      this._pollErrors.delete(orderId);
      this._answers.set(orderId, (this._answers.get(orderId) || 0) + 1);
      this._orders.set(orderId, next);
      if (!sameAs(next, cur) || this._unsaved.has(orderId)) await this._saveQuietly(next);
      if (next.isOpen) this._dueAt.set(orderId, this.clock.now() + (s.pollAfterMs ?? this.defaultPollMs));
      else this._dueAt.delete(orderId);
      return this._orders.get(orderId) || next;
    } catch (e) {
      const err = e instanceof SellError ? e : new SellError('network');
      this._pollErrors.set(orderId, err);
      const n = (this._failures.get(orderId) || 0) + 1;
      this._failures.set(orderId, n);
      this._dueAt.set(orderId, this.clock.now() + this._backoff(n, err.retryAfterMs));
      return o;
    } finally {
      this._busy.delete(orderId);
      this._changed();
      this._arm();
    }
  }

  /** The wait after `failures` looks in a row got no answer: twice the usual each time, at most maxBackoffMs, never less than retryAfterMs. */
  _backoff(failures, retryAfterMs) {
    let wait = Math.min(this.defaultPollMs * 2 ** Math.min(failures, 10), this.maxBackoffMs);
    if (retryAfterMs != null && retryAfterMs > wait) wait = retryAfterMs;
    return wait;
  }

  /**
   * Writes `o` (the record in memory: callers set it first); a failed write is kept in memory
   * and written with the next change or look.
   */
  async _saveQuietly(o) {
    try {
      await this.store.save(o);
      this._written(o);
    } catch {
      this._unsaved.add(o.orderId);
    }
  }

  /** `o` is on disk: nothing left to write, unless a newer record took its place meanwhile (its own write decides). */
  _written(o) {
    if (this._orders.get(o.orderId) === o) this._unsaved.delete(o.orderId);
  }

  /** Wakes up when the next open sell is due. */
  _arm() {
    if (!this.autoPoll || this._paused || this._disposed) return;
    if (this._wake) this._wake();
    this._wake = null;
    let next = null;
    for (const o of this._orders.values()) {
      const at = this._dueAt.get(o.orderId);
      if (!o.isOpen || at === undefined || this._busy.has(o.orderId)) continue;
      if (next === null || at < next) next = at;
    }
    if (next === null) return;
    this._wake = this.clock.schedule(Math.max(0, next - this.clock.now()), () => {
      this._wake = null;
      this.pollDue();
    });
  }
}
