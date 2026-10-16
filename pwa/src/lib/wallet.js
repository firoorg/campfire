// The running wallet as the screens see it: balances, payments, sync state, and the few actions
// a person can take. One instance per page. It wraps the Firo engine (WALLET_API.md) that
// lib/chain.js picks, and turns its satoshi strings into BigInt for the screens; nothing here
// knows whether the engine is the real one or the stand-in.

import { createBackend } from './chain.js';
import { assessSync } from './sync.js';
import { toSats, toSatString } from './amount.js';
import { openWalletStore } from './wallet_store.js';
import { sealedStore } from './sealed_store.js';
import { timeOfHeight } from './heights.js';
import { needThisTab } from './one_tab.js';
import { cleanMemo } from './payments.js';

/** Firo's confirmations before a payment counts as done (Campfire: minConfirms 1). */
export const MIN_CONFIRMATIONS = 1;
/** A Spark memo holds this many bytes (UTF-8) at most: 31 characters in English (lib/payments.js). */
export const SPARK_MEMO_MAX = 31;

const ZERO = () => ({ private: { available: 0n, pending: 0n, checking: 0n }, public: { available: 0n, pending: 0n } });

/** A payment still waiting for its first confirmation. */
export const isPendingTx = (tx) => !(Number(tx && tx.confirmations) >= MIN_CONFIRMATIONS);

/** The balance a payment touched, for its row: private (Spark), public (transparent), or the move between. */
export function txSide(tx) {
  switch (tx && tx.kind) {
    case 'privatize':
      return 'privatize';
    case 'transparent':
    case 'coinbase':
    case 'masternode':
      return 'public';
    default:
      return 'private'; // spark, spark-name, lelantus
  }
}

export const SIDE_WORDS = Object.freeze({ private: 'Private', public: 'Public', privatize: 'Public → Private' });

/** What a payment was, in words: "Received", "Privatizing", "Sent to yourself"… */
export function txTitle(tx) {
  // A payment of ours the network does not have (the engine asked two nodes): nothing left. Or one
  // the person let go on the word of the node in use (RE3-3).
  if (tx.dropped) return tx.letGo ? 'Let go' : 'Did not go through';
  const p = isPendingTx(tx);
  if (tx.kind === 'privatize') return p ? 'Privatizing' : 'Privatized';
  if (tx.kind === 'spark-name') return p ? 'Registering a Spark name' : 'Spark name registered';
  if (tx.direction === 'self') return p ? 'Sending to yourself' : 'Sent to yourself';
  if (tx.direction === 'in') {
    if (tx.kind === 'coinbase') return p ? 'Mining reward (waiting)' : 'Mining reward';
    if (tx.kind === 'masternode') return p ? 'Masternode payment (waiting)' : 'Masternode payment';
    if (tx.kind === 'lelantus') return p ? 'Moving from Lelantus' : 'Moved from Lelantus';
    return p ? 'Receiving' : 'Received';
  }
  return p ? 'Sending' : 'Sent';
}

/** When a payment was, in words: its date, "about <date>" for a private one found while restoring, or "". */
export function txWhen(tx, fmt) {
  if (tx.time) return fmt(tx.time);
  if (tx.timeApprox) return `about ${new Date(tx.timeApprox * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return isPendingTx(tx) ? 'Just now' : '';
}

/** "+", "−" or "" (a move inside the wallet, or a payment that did not go through). */
export function txSign(tx) {
  if (tx.dropped) return '';
  if (tx.direction === 'in') return '+';
  if (tx.direction === 'out') return '−';
  return '';
}

/**
 * The engine's Tx with BigInt amounts. time may be null (unconfirmed, or a private coin found
 * while restoring): then timeApprox is about when its block (heightApprox) was made, from the tip.
 */
export function mapTx(t, tip = null) {
  const time = t.time == null ? null : Number(t.time) || null;
  const approxHeight = Number.isFinite(Number(t.heightApprox)) && t.heightApprox != null ? Number(t.heightApprox) : null;
  return {
    txid: String(t.txid),
    height: t.height == null ? null : Number(t.height),
    heightApprox: approxHeight,
    time,
    timeApprox: time == null && approxHeight != null ? timeOfHeight(approxHeight, tip) : null,
    confirmations: Number(t.confirmations) || 0,
    direction: t.direction,
    kind: t.kind,
    amount: toSats(t.amount || '0'),
    fee: toSats(t.fee || '0'),
    // Written by whoever paid: printable text only, as any memo shown (lib/payments.js, PN).
    memo: typeof t.memo === 'string' && cleanMemo(t.memo, 256) ? cleanMemo(t.memo, 256) : null,
    counterparty: typeof t.counterparty === 'string' && t.counterparty ? t.counterparty : null,
    // Every one paid, when more than one (N12: "Paid before?" saw only the first).
    counterparties: Array.isArray(t.counterparties) ? t.counterparties.filter((x) => typeof x === 'string' && x).slice(0, 20) : null,
    // Ours, broadcast with no answer and not seen on the network yet: it may have left (audit FM-1).
    unsure: t.unsure === true,
    // Ours, and the network does not have it: it did not go through, its coins are free again.
    dropped: t.dropped === true,
    // Dropped because the person let it go on the word of the node in use alone (release re-audit 3 RE3-3).
    letGo: t.letGo === true,
    // Ours, and the node in use says it never received it, with no second node to ask for an hour:
    // the person may let it go (wallet.letGo), told it is one node's word (RE3-3).
    oneNode: t.oneNode === true,
    // To us, in a block on the node's word, not proven yet (audit FE-1): not confirmed, not spendable.
    unproven: t.unproven === true,
  };
}

const balanceOf = (b) => ({
  private: { available: toSats((b && b.private && b.private.available) || '0'), pending: toSats((b && b.private && b.private.pending) || '0'), checking: toSats((b && b.private && b.private.checking) || '0') },
  public: { available: toSats((b && b.public && b.public.available) || '0'), pending: toSats((b && b.public && b.public.pending) || '0'), mnLocked: toSats((b && b.public && b.public.mnLocked) || '0') },
});

const recipients = (to) => (to || []).map((r) => ({ address: String(r.address), amount: toSatString(r.amount), ...(r.memo ? { memo: String(r.memo) } : {}) }));

export class Wallet {
  constructor() {
    this.backend = null;
    this.run = null;
    this.listeners = new Set();
    this.unsub = null;
    this.ticker = null;
    this.gen = 0;
    this.state = this.emptyState();
  }

  emptyState() {
    return {
      running: false,
      raw: null,
      connected: false,
      server: null,
      tip: null,
      balance: ZERO(),
      txs: [],
      // The payment list was read in full at least once this run (lib/payment_notice.js: the first read is history).
      txsLoaded: false,
      receive: { spark: null, transparent: null },
      viewOnly: false,
      everConnected: false,
      lostAt: null,
      sync: assessSync({ raw: null, now: Date.now() / 1000 }),
    };
  }

  /** The engine, while a wallet is open (null otherwise). */
  get session() {
    return this.backend;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    const s = this.state;
    s.sync = assessSync({ raw: s.raw, everConnected: s.everConnected, lostAt: s.lostAt, now: Date.now() / 1000 });
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /**
   * Opens a wallet: its own engine store (lib/wallet_store.js), the words from the seed vault.
   * newWallet: words made on this device just now, so there is no history before today (the
   * engine may start at the tip). The words are not kept here.
   */
  async start({ walletId, mnemonic, passphrase = '', viewOnly = null, birthdayHeight = null, newWallet = false, servers = null, ownNode = false, network = 'main', store = null, sparkTxDetails = 'none', seal = null }) {
    if (this.backend) throw new Error('The wallet is already open.');
    // One tab at a time (lib/one_tab.js): never an engine in a tab that does not hold the wallet.
    needThisTab();
    const gen = ++this.gen;
    // seal: {dbPass, imported} — the engine's data is sealed under the unlocked wallet's secret.
    const st = store || (seal && seal.dbPass ? await sealedStore(openWalletStore(walletId), { walletId, dbPass: seal.dbPass, imported: Boolean(seal.imported) }) : openWalletStore(walletId));
    const list = (servers || []).map((x) => (typeof x === 'string' ? { url: x } : { url: String(x.url) }));
    const b = await createBackend({ network, ...(list.length ? { servers: list } : {}), ownNode: Boolean(ownNode), store: st, sparkTxDetails: sparkTxDetails === 'decoy' ? 'decoy' : 'none' });
    if (gen !== this.gen) return;
    this.backend = b;
    this.run = { walletId, store: st };
    this.state = this.emptyState();
    this.state.running = true;
    this.unsub = b.subscribe((raw) => {
      if (this.backend === b) this.absorb(raw);
    });
    try {
      if (viewOnly) await b.openViewOnly({ ...viewOnly, ...(Number.isSafeInteger(birthdayHeight) ? { birthdayHeight } : {}) });
      else await b.open({ mnemonic, passphrase, ...(Number.isSafeInteger(birthdayHeight) ? { birthdayHeight } : {}), ...(newWallet ? { newWallet: true } : {}) });
    } catch (e) {
      if (this.backend === b) await this.stop();
      throw e;
    }
    if (this.backend !== b) return;
    this.absorb(b.getState());
    // Ages ("made 2 min ago") and the offline grace move on with the clock.
    this.ticker = setInterval(() => this.emit(), 5000);
  }

  absorb(raw) {
    const s = this.state;
    const now = Date.now() / 1000;
    if (raw.connected) {
      s.everConnected = true;
      s.lostAt = null;
    } else if (s.connected) s.lostAt = now;
    s.raw = raw;
    s.connected = Boolean(raw.connected);
    s.server = raw.server || null;
    s.tip = raw.tip || null;
    s.viewOnly = Boolean(raw.viewOnly);
    // Private coins received that this node's lists cannot confirm (P4): {code, otherServer} or null.
    s.privateCheck = raw.privateCheck && typeof raw.privateCheck.code === 'string' ? { code: raw.privateCheck.code, otherServer: raw.privateCheck.otherServer === true } : null;
    s.balance = balanceOf(raw.balance);
    s.txs = (Array.isArray(raw.txs) ? raw.txs : []).map((t) => mapTx(t, raw.tip));
    if (raw.sync && raw.sync.phase === 'done') s.txsLoaded = true;
    s.receive = { spark: (raw.receive && raw.receive.spark) || null, transparent: (raw.receive && raw.receive.transparent) || null };
    this.emit();
  }

  async stop() {
    this.gen++;
    clearInterval(this.ticker);
    this.ticker = null;
    if (this.unsub) this.unsub();
    this.unsub = null;
    const b = this.backend;
    const st = this.run && this.run.store;
    this.backend = null;
    this.run = null;
    if (b) await b.close().catch((e) => console.warn('[campfire] close', e && e.message));
    if (st && typeof st.close === 'function') await st.close().catch(() => {});
    this.state = this.emptyState();
    this.emit();
  }

  need() {
    if (!this.backend) {
      const e = new Error('The wallet is not open. Unlock it and try again.');
      e.code = 'not-open';
      throw e;
    }
    return this.backend;
  }

  // ------------------------------------------------------------ reading
  /** What can be spent now from 'private' or 'public', in sats. */
  available(from = 'private') {
    return this.state.balance[from === 'public' ? 'public' : 'private'].available;
  }

  /** Private + public, spendable now. */
  total() {
    return this.state.balance.private.available + this.state.balance.public.available;
  }

  /**
   * A payment is between send() and the end of its broadcast (audit FE-4): auto-lock waits for it,
   * so a lock cannot land between writing it down and sending it.
   */
  paymentUnderWay() {
    return Boolean(this.backend && this.backend.paymentInFlight);
  }

  // ------------------------------------------------------------ actions
  classifyAddress(text) {
    return this.backend ? this.backend.classifyAddress(String(text || '')) : { kind: 'invalid' };
  }

  resolveSparkName(name) {
    return this.need().resolveSparkName(name);
  }

  /** A name about to be paid: checked with a second server and against the address paid before. */
  resolveSparkNameForPayment(name, opts) {
    return this.need().resolveSparkNameForPayment(name, opts);
  }

  pinSparkName(name, address) {
    return this.need().pinSparkName(name, address);
  }

  /** {from, to: [{address, amount (BigInt sats), memo?}], subtractFee} -> {fee, total, change (BigInt), warnings}. */
  async quote({ from, to, subtractFee = false }) {
    const q = await this.need().quote({ from, to: recipients(to), subtractFee });
    return { fee: toSats(q.fee), total: toSats(q.total), change: toSats(q.change), warnings: Array.isArray(q.warnings) ? q.warnings.map(String) : [] };
  }

  /**
   * Builds, signs and broadcasts. -> {txid}. The engine's error passes through as it is: its code,
   * and for 'unsure' (no answer after it reached a node: it may have left, and is followed) its
   * txid. Only 'unsure' may have left the wallet; the screens must not offer the same payment
   * again until the payment's Tx says dropped (audit FM-1).
   * expect: {fee, total} (BigInt sats), the figures the person confirmed: the engine refuses any
   * other plan with code 'fee-changed', its new fee, total and change on the error as BigInt
   * (audit FE-3); nothing is built or sent then.
   */
  async send({ from, to, subtractFee = false, expect = null }) {
    const req = { from, to: recipients(to), subtractFee };
    if (expect) req.expect = { fee: toSatString(expect.fee), total: toSatString(expect.total) };
    try {
      return await this.need().send(req);
    } catch (e) {
      if (e && e.code === 'fee-changed') {
        for (const k of ['fee', 'total', 'change']) if (e[k] != null) e[k] = toSats(e[k]);
      }
      throw e;
    }
  }

  /**
   * Lets go of a payment of this wallet the Firo node in use says it never received, once no second
   * node could confirm it for an hour (its Tx says oneNode): its coins are free again, and it says
   * it did not go through, by the person's choice (Tx.letGo). Release re-audit 3 RE3-3: never done by
   * the engine on one node's word. Errors: 'not-offered', 'seen' (the node has it now), 'offline',
   * 'not-open' (locked meanwhile, also while the node was asked: RE4-2), 'storage'.
   * -> {txid, letGo: true}
   */
  async letGo(txid) {
    const b = this.need();
    const r = await b.letGo(String(txid));
    if (this.backend === b) this.absorb(b.getState());
    return r;
  }

  /**
   * After a private payment was stopped because a server's list of private coins did not check out
   * (the error says otherServer): the next server of the list, and those lists fetched again from
   * it (audit D-09). -> {server}
   */
  useAnotherServer() {
    return this.need().useAnotherServer();
  }

  /** Public -> private. amount: BigInt sats, or 'all'. -> {txid}; errors as send() ('unsure' with txid). */
  async privatize(amount = 'all', { subtractFee = false, expect = null } = {}) {
    return this.need().privatize({ amount: amount === 'all' ? 'all' : toSatString(amount), ...(subtractFee ? { subtractFee: true } : {}), ...(expect ? { expect: { fee: toSatString(expect.fee), total: toSatString(expect.total) } } : {}) });
  }

  newSparkAddress() {
    return this.need().newSparkAddress();
  }

  newTransparentAddress() {
    return this.need().newTransparentAddress();
  }

  rescan(fromHeight = null) {
    return this.need().rescan(Number.isSafeInteger(fromHeight) ? { fromHeight } : {});
  }

  clearSparkCache() {
    return this.need().clearSparkCache();
  }

  /** One node's newest block and answer time, on its own short connection: {ok, height?, ms?, error?}. */
  checkNode(url) {
    return this.need().checkNode(url);
  }

  /** urls: ['wss://host:port', ...]; ownNode: they are the person's own node (nothing is cross-checked). */
  setServers(urls, { ownNode = false } = {}) {
    return this.need().setServers(urls.map((url) => ({ url: String(url) })), { ownNode: Boolean(ownNode) });
  }

  exportSparkViewKey() {
    return this.need().exportSparkViewKey();
  }

  /** The public side's account xpub (m/44'/136'/0'): another wallet watches the public payments with it. */
  exportXpub() {
    return this.need().exportXpub();
  }

  // ---- Coins

  /** Every unspent coin: [{id, kind 'transparent'|'spark', amount (BigInt), address?, confirmations?, frozen, spendable, memo?, label?}]. */
  async coins() {
    return (await this.need().coins.list()).map((c) => ({ ...c, amount: toSats(c.amount) }));
  }

  /** Keeps a public coin out of payments (or lets it back in). */
  freezeCoin(id, frozen = true) {
    return this.need().coins.freeze(id, frozen);
  }

  /** A note on a coin, kept on this device (empty removes it). */
  labelCoin(id, text) {
    return this.need().coins.label(id, text);
  }

  // ---- Spark names

  /** This wallet's names, from the full list: [{name, address, validUntil (block height) | null, additionalInfo | null}]. */
  myNames() {
    return this.need().sparkNames.listDetailed();
  }

  /**
   * One of this wallet's names asked about by name: {validUntil, additionalInfo}. Only when the
   * person asks (myNames() comes from the full list; a server whose list lacks the expiry says
   * null there), as it tells the server which name is this wallet's (audit D-10).
   */
  nameDetails(name) {
    return this.need().sparkNames.details(name);
  }

  /** Whether `name` is free to register (checked against the full list, no per-name query). */
  nameIsFree(name) {
    return this.need().sparkNames.isFree(name);
  }

  /** The price of `name` for `years`, in whole FIRO (by length: 1,000 / 100 / 10 / 1 a year). */
  nameFeeFiro(name, years = 1) {
    return this.need().sparkNames.feeFiro(name, years);
  }

  /** What registering (or, with renew, renewing) `name` would cost: {fee, total} in satoshi (BigInt). */
  async quoteName({ name, years = 1, additionalInfo = '', renew = false }) {
    const n = this.need().sparkNames;
    const q = renew ? await n.quoteRenew({ name, years }) : await n.quote({ name, years, additionalInfo });
    return { fee: BigInt(q.fee), total: BigInt(q.total) };
  }

  /** Registers `name` to this wallet's Spark address, paid from the private balance. expect: {fee, total} as shown. -> {txid} */
  registerName({ name, years = 1, additionalInfo = '', expect = null }) {
    return this.need().sparkNames.register({ name, years, additionalInfo, ...(expect ? { expect: { fee: String(expect.fee), total: String(expect.total) } } : {}) });
  }

  /** Renews one of this wallet's names for `years` more. expect: {fee, total} as shown. -> {txid} */
  renewName({ name, years = 1, expect = null }) {
    return this.need().sparkNames.renew({ name, years, ...(expect ? { expect: { fee: String(expect.fee), total: String(expect.total) } } : {}) });
  }
}

export const wallet = new Wallet();
