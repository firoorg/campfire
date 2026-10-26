// Buying FIRO through buyfiro.app, without any screen: the coins it takes,
// what an amount buys (asked again on every change, the latest question
// only), a deposit address for one buy (kept on this device before it is
// shown), and where each open buy is (asked as often as buyfiro.app says, less
// often while it cannot be reached, never again once it has ended).
//
// One controller per unlocked wallet (lib/buy/wiring.js); it outlives the
// screens, so buys are followed after their screen closes. It follows them
// only while the wallet is unlocked and the page is visible: the wiring
// pauses it otherwise, and locking disposes of it.

import { BuyError, sortAssets } from './buyfiro.js';
import { makeOrder, withStatus, sameAs } from './store.js';

/** The time the controller reads, and its timers: schedule(ms, fn) → cancel(). */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  schedule(ms, fn) {
    const t = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(t);
  },
});

const ASSETS_TTL_MS = 10 * 60 * 1000;

export class BuyController {
  constructor({ client, store, clock = systemClock, autoPoll = true, quoteDelayMs = 400, defaultPollMs = 15000, maxBackoffMs = 5 * 60 * 1000, orderRetries = 2 }) {
    this.client = client;
    this.store = store;
    this.clock = clock;
    /** Follow open buys on timers (tests call pollDue themselves). */
    this.autoPoll = autoPoll;
    /** How long typing must pause before a price is asked for. */
    this.quoteDelayMs = quoteDelayMs;
    /** Between two looks at a buy, when buyfiro.app does not say. */
    this.defaultPollMs = defaultPollMs;
    /** The longest wait between looks while buyfiro.app cannot be reached. */
    this.maxBackoffMs = maxBackoffMs;
    /** Extra tries of a deposit-address request that got no answer. */
    this.orderRetries = orderRetries;

    this._listeners = new Set();
    this._disposed = false;
    this._assets = null; // {list, at}
    this._limits = null;
    this._refusedBelowUsd = null;

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
    /** Buys whose last write failed: written again with the next look. */
    this._unsaved = new Set();
    /** FIRO addresses made for an order request that got no answer, by the request: asking again with them returns the same order. */
    this._pendingAddress = new Map();
    /** A deposit-address request on its way, by what it asks: a second tap waits for the same answer. */
    this._placing = new Map();
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

  // ---------------------------------------------------------------- coins

  /** The coins buyfiro.app takes, in picker order (kept ten minutes). */
  async assets({ refresh = false } = {}) {
    const c = this._assets;
    if (!refresh && c && this.clock.now() - c.at < ASSETS_TTL_MS) return c.list;
    const list = sortAssets(await this.client.assets());
    this._assets = { list, at: this.clock.now() };
    return list;
  }

  /** The smallest-buy hint last read. */
  get limits() {
    return this._limits;
  }

  /**
   * What to say up front about the smallest buy: the figure buyfiro.app last
   * observed, else the one a refused price stated here. buyfiro.app's own floor
   * (our_minimum_usd, $5) is not said: the route's floor is far higher and the
   * $5 would only mislead. A hint only: a price decides.
   */
  get minimumHintUsd() {
    return this._limits?.upstreamObservedMinimumUsd ?? this._refusedBelowUsd ?? null;
  }

  /** Reads the smallest-buy hint; the last one is kept when buyfiro.app cannot be reached. */
  async refreshLimits() {
    try {
      this._limits = await this.client.limits();
      this._changed();
    } catch (e) {
      if (!(e instanceof BuyError)) throw e;
      // The form says nothing about a minimum until a quote does.
    }
    return this._limits;
  }

  // --------------------------------------------------------------- quotes

  /** What is being priced: {asset, amount (BuyAmount), refundAddress}, or null. */
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
      const q = await this.client.quote({ assetId: r.asset.assetId, amount: r.amount, refundAddress: r.refundAddress });
      if (seq !== this._quoteSeq || this._disposed) return;
      this._quote = q;
    } catch (e) {
      const err = e instanceof BuyError ? e : new BuyError('network');
      if (err.code === 'amount_below_upstream_minimum' && err.minimumUsd != null) this._refusedBelowUsd = err.minimumUsd;
      if (seq !== this._quoteSeq || this._disposed) return;
      this._quoteError = err;
    }
    this._quoting = false;
    this._changed();
  }

  // --------------------------------------------------------------- orders

  /** Every buy (of walletId when given), newest first. */
  orders(walletId = null) {
    return [...this._orders.values()].filter((o) => walletId === null || o.walletId === walletId).sort((a, b) => b.createdAt - a.createdAt);
  }

  order(depositAddress) {
    return this._orders.get(depositAddress) || null;
  }

  /** Why the last look at a buy got no answer (null after one that did). */
  pollError(depositAddress) {
    return this._pollErrors.get(depositAddress) || null;
  }

  /** When the next look at a buy is due (ms; null: never, it has ended). */
  dueAt(depositAddress) {
    return this._dueAt.get(depositAddress) ?? null;
  }

  /** Loads the buys kept on this device and follows the open ones (once; later calls wait for the first). */
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
      if (!this._orders.has(o.depositAddress)) this._orders.set(o.depositAddress, o);
      if (o.isOpen && !this._dueAt.has(o.depositAddress)) this._dueAt.set(o.depositAddress, now);
    }
    this._changed();
    this._arm();
  }

  /**
   * A deposit address for `amount` of `asset`, the FIRO going to a new address
   * of the wallet walletId (newWalletAddress() makes it). The buy is on this
   * device before this returns. A request that got no answer is sent again as
   * it was, and buyfiro.app returns the same order for it; a second call while
   * one is on its way gets the same answer (as Sell's: two at once each made a
   * FIRO address of their own, so two buys, two deposit addresses, release
   * verification 0.1.8).
   */
  placeOrder(args) {
    const key = [args.asset.assetId, args.amount.raw, args.refundAddress, args.walletId].join('|');
    const running = this._placing.get(key);
    if (running) return running;
    const p = this._place(args, key).finally(() => this._placing.delete(key));
    this._placing.set(key, p);
    return p;
  }

  async _place({ asset, amount, refundAddress, walletId, newWalletAddress, quote = null }, key) {
    await this.resumeAll();
    let walletAddress = this._pendingAddress.get(key);
    if (!walletAddress) {
      walletAddress = await newWalletAddress();
      this._pendingAddress.set(key, walletAddress);
    }
    let answer = null;
    for (let attempt = 0; answer === null; attempt++) {
      try {
        answer = await this.client.order({ assetId: asset.assetId, amount, walletAddress, refundAddress, blockchain: asset.blockchain });
      } catch (e) {
        if (!(e instanceof BuyError) || !e.unreachable || attempt >= this.orderRetries) throw e;
      }
    }
    const order =
      this._orders.get(answer.depositAddress) ||
      makeOrder({
        depositAddress: answer.depositAddress,
        assetId: asset.assetId,
        symbol: asset.symbol,
        chain: asset.blockchain,
        contract: asset.contractAddress,
        decimals: asset.decimals,
        sendAmount: amount.text,
        sendAmountRaw: amount.raw,
        walletAddress,
        walletId,
        refundAddress,
        createdAt: this.clock.now(),
        estimate: answer.estimate ?? quote?.estimate ?? null,
        deadline: answer.deadline,
        etaSeconds: answer.etaSeconds ?? quote?.etaSeconds ?? null,
        lastState: 'awaiting_deposit',
        sandbox: this.client.sandbox,
      });
    // On this device before anything shows the address.
    await this.store.save(order);
    this._pendingAddress.delete(key);
    this._orders.set(order.depositAddress, order);
    if (order.isOpen) this._dueAt.set(order.depositAddress, this.clock.now() + this.defaultPollMs);
    this._changed();
    this._arm();
    return order;
  }

  /** Stops following buys (the page is hidden). */
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

  /** Looks at every open buy whose turn it is. */
  async pollDue() {
    if (this._disposed || this._paused) return;
    const now = this.clock.now();
    const due = [...this._orders.values()].filter((o) => o.isOpen && !this._busy.has(o.depositAddress) && !((this._dueAt.get(o.depositAddress) ?? -Infinity) > now)).map((o) => o.depositAddress);
    for (const a of due) await this.poll(a);
    this._arm();
  }

  /** Looks at the buy paid at depositAddress once, now. */
  async poll(depositAddress) {
    const o = this._orders.get(depositAddress);
    if (!o || !o.isOpen || this._disposed || this._busy.has(depositAddress)) return o || null;
    this._busy.add(depositAddress);
    try {
      const s = await this.client.status(depositAddress);
      // The record as it is NOW, with buyfiro.app's fields from its answer (audit FM-2).
      const cur = this._orders.get(depositAddress) || o;
      const next = withStatus(cur, s, this.clock.now());
      this._failures.delete(depositAddress);
      this._pollErrors.delete(depositAddress);
      this._orders.set(depositAddress, next);
      if (!sameAs(next, cur) || this._unsaved.has(depositAddress)) await this._saveQuietly(next);
      if (next.isOpen) this._dueAt.set(depositAddress, this.clock.now() + (s.pollAfterMs ?? this.defaultPollMs));
      else this._dueAt.delete(depositAddress);
      return this._orders.get(depositAddress) || next;
    } catch (e) {
      const err = e instanceof BuyError ? e : new BuyError('network');
      this._pollErrors.set(depositAddress, err);
      const n = (this._failures.get(depositAddress) || 0) + 1;
      this._failures.set(depositAddress, n);
      this._dueAt.set(depositAddress, this.clock.now() + this._backoff(n, err.retryAfterMs));
      return o;
    } finally {
      this._busy.delete(depositAddress);
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

  /** Writes `o` (the record in memory); a failed write is kept in memory and written with the next look. */
  async _saveQuietly(o) {
    try {
      await this.store.save(o);
      if (this._orders.get(o.depositAddress) === o) this._unsaved.delete(o.depositAddress);
    } catch {
      this._unsaved.add(o.depositAddress);
    }
  }

  /** Wakes up when the next open buy is due. */
  _arm() {
    if (!this.autoPoll || this._paused || this._disposed) return;
    if (this._wake) this._wake();
    this._wake = null;
    let next = null;
    for (const o of this._orders.values()) {
      const at = this._dueAt.get(o.depositAddress);
      if (!o.isOpen || at === undefined || this._busy.has(o.depositAddress)) continue;
      if (next === null || at < next) next = at;
    }
    if (next === null) return;
    this._wake = this.clock.schedule(Math.max(0, next - this.clock.now()), () => {
      this._wake = null;
      this.pollDue();
    });
  }
}
