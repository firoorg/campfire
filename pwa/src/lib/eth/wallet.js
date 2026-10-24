// The EVM wallet while Campfire is unlocked: one key, one address, on Ethereum and BNB Chain
// (lib/eth/chains.js). Its address (read from the sealed key, which is zeroed again at once),
// its balances on each chain, what this device sent (the sealed outbox, both chains) and, when
// the person allows it, the history Stack Wallet's index keeps for the address on Ethereum
// (BNB Chain has no such index here: only what this device sent is listed there).
//
// Nothing here runs by itself: the screens call refresh() while they are open and visible.
// Every request goes to the one server picked for that chain (a listed one, lib/eth/hosts.js, or
// the person's own), never another, but for one case: a transaction stuck "Not sure yet" (the
// server says its nonce is used and can't show by what) is checked with a second listed server,
// which then sees the address (otherRpcs, release re-audit R-1) - never while the person's own
// server is in use: then no listed server learns the address. The history index is Stack
// Wallet's whichever server is picked, and is asked only while "History from Stack Wallet" is on.
//
// Locking forgets the address, the derived data keys and this object
// (forgetEthWallet(), called from the app's lock hooks).

import { getEthRecord, withEthKey, removeEthKey, VaultError } from './vault.js';
import { EthRpc, EthRpcError } from './rpc.js';
import { DEFAULT_RPC, RPC_HOSTS, RPC_PREF, RPC_URL_PREF, CUSTOM_RPC, HISTORY_HOST, ownServerEntry } from './hosts.js';
import { tokensFor, nativeFor } from './tokens.js';
import { CHAIN_KEYS, chainOf } from './chains.js';
import { encodeCall, abiDecode } from './abi.js';
import { loadOutbox, clearOutbox, isOpen, entryChain, updateOutbox, promised, openSwapOf } from './outbox.js';
import { fetchHistory, mergeActivity } from './history.js';
import { forgetDataKeys } from './sealed.js';
import { followOnce, recheckClosed, settledByIndex, REJECTED_FOLLOW_MS } from './send.js';
import { otherServers, SECOND_TRIES, SECOND_TIMEOUT_MS } from './second_opinion.js';
import { bscServerNote } from './server_notes.js';
import { store } from '../store.js';
import { t } from '../i18n.js';

/**
 * The person's settings for one chain: its server (the default unless one was picked: a listed one,
 * or their own, CUSTOM_RPC with its address), history (Ethereum only). A saved id that is no longer
 * listed (BNB Chain's PublicNode, 2026-10-14) or an own address that is not one reads as the default.
 * custom: the person's own server is in use.
 */
export function evmPrefs(app, chainKey = 'ethereum') {
  const chain = chainOf(chainKey);
  const p = (app && app.prefs) || {};
  const list = RPC_HOSTS[chain.key];
  const picked = p[RPC_PREF[chain.key]];
  const custom = picked === CUSTOM_RPC;
  // The person's own server whose saved address the rules no longer take is refused and said so
  // (lib/eth/rpc.js 'unusable'), never quietly swapped for a listed server, which would then learn
  // the address they kept from them (release audit 0.1.5, N2).
  const own = custom ? ownServerEntry(chain.key, p[RPC_URL_PREF[chain.key]]) || unusableOwn(chain.key) : null;
  const host = own || list.find((x) => x.id === picked) || list.find((x) => x.id === DEFAULT_RPC[chain.key]);
  // Stack Wallet's history index is a listed server too: not asked while the person's own Ethereum
  // server is in use, so it never learns the address they keep from listed servers (B1).
  const wanted = chain.history === 'stackwallet' && p.ethHistory !== false;
  return { chain, rpcId: host.id, host, custom, history: wanted && !custom, historyHeld: wanted && custom, historyHost: HISTORY_HOST };
}

const UNUSABLE = {};
/** The stand-in for an own server whose saved address is not one any more: every request is refused. */
function unusableOwn(chainKey) {
  if (!UNUSABLE[chainKey]) UNUSABLE[chainKey] = Object.freeze({ id: CUSTOM_RPC, name: 'your own server', host: null, url: null, origin: null, chain: chainKey, custom: true, unusable: true, logs: null });
  return UNUSABLE[chainKey];
}

// ---------------------------------------------------------------- BNB Chain's server changed (S4)
//
// Someone who had picked PublicNode for BNB Chain (no longer listed: it refuses receipts) is moved to
// the default, BNB Chain's official server, which then sees their address: never before they were
// told (lib/eth/server_notes.js). Every BNB Chain request this wallet makes waits until the note was
// shown (app.bscNote, over whichever Ethereum & BNB screen asks first, which takes it).

/**
 * Whether BNB Chain's requests wait for the note. Not once it was shown in this session
 * (app.bscNoteShown), even when saving that failed: the note then comes again at the next start,
 * and nothing waits meanwhile (release audit 0.1.5: a failed save held every BNB Chain request).
 */
export function bscHeld(app) {
  const n = bscServerNote(app && app.prefs);
  return Boolean(n && n.picked && app && typeof app.bscNote === 'function' && !app.bscNoteShown);
}

/** Resolves once BNB Chain's requests may go (at once when nothing is held); refused once the wallet locks. */
async function bscGate(app) {
  while (bscHeld(app)) {
    if (!app.dbPass) throw new EthRpcError('locked', t('The wallet is locked.'));
    app.bscNote();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Ethereum's settings, as the screens always read them. */
export function ethPrefs(app) {
  return evmPrefs(app, 'ethereum');
}

/** An entry's look failed: the error, with the chain and the entry it is about (followOpen). */
function tagged(err, chain, hash) {
  const e = err && typeof err === 'object' ? err : new Error(String(err));
  return Object.freeze({ code: e.code === undefined ? null : e.code, message: String(e.message || e), chain, hash });
}

const freshChain = () => ({
  native: null, // the chain's coin in wei, or null until asked
  tokens: new Map(), // symbol -> units (null when the token did not answer)
  block: null,
  minedNonce: null, // the account's mined transaction count (read with the balances), or null when not known
  checkedAt: null,
  loading: false,
  error: null, // the server's problem: {host, message, code}
});

export class EthWallet {
  constructor(app, record, kv) {
    this.app = app;
    this.kv = kv;
    this.walletId = app.record.id;
    this.ethId = record.id;
    this.record = record;
    this.listeners = new Set();
    this._rpcs = {};
    this._followErrors = new Map(); // entry hash -> the error of its last look (followOpen)
    this._chainRuns = {}; // chain key -> the balance read under way (refreshChain)
    this._refreshRun = null; // the refresh() under way
    const chains = Object.fromEntries(CHAIN_KEYS.map((k) => [k, freshChain()]));
    this.state = {
      address: null,
      chains,
      loading: false,
      outbox: [],
      history: { txs: [], transfers: [], error: null, at: null },
    };
    // Ethereum's figures under their first names (eth, tokens, block, checkedAt, error).
    const eth = () => this.state.chains.ethereum;
    Object.defineProperties(this.state, {
      eth: { get: () => eth().native, set: (v) => (eth().native = v), enumerable: true },
      tokens: { get: () => eth().tokens, set: (v) => (eth().tokens = v), enumerable: true },
      block: { get: () => eth().block, set: (v) => (eth().block = v), enumerable: true },
      checkedAt: { get: () => eth().checkedAt, set: (v) => (eth().checkedAt = v), enumerable: true },
      error: { get: () => eth().error, set: (v) => (eth().error = v), enumerable: true },
    });
  }

  /** The client for `chainKey`'s server picked now (a new one when the choice changes). */
  rpcFor(chainKey = 'ethereum') {
    const { host, chain } = evmPrefs(this.app, chainKey);
    const cur = this._rpcs[chain.key];
    // The same listed server, or the person's own at the same address: the same client.
    const same = cur && cur.host && cur.host.id === host.id && (!host.custom || cur.host.url === host.url);
    if (!same) this._rpcs[chain.key] = new EthRpc(host, this._gateFor(chain.key));
    return this._rpcs[chain.key];
  }

  /** The request gate of `chainKey`'s clients: BNB Chain's wait for its server note (S4). */
  _gateFor(chainKey) {
    return chainKey === 'bsc' ? { gate: () => bscGate(this.app) } : {};
  }

  /**
   * Clients of the other listed servers of `chainKey` (at most SECOND_TRIES; the first that answers
   * settles it, send.js closeIfNonceGone), made only when a transaction's nonce is said used with
   * nothing shown: the second opinion that can end it (R-1). None while the person's own server is
   * in use: they chose to tell no other server their address (the in-doubt notice offers to check
   * it with a listed server, by switching to it, instead).
   */
  otherRpcs(chainKey) {
    const { rpcId, chain, custom } = evmPrefs(this.app, chainKey);
    if (custom) return [];
    return otherServers(chain.key, rpcId)
      .slice(0, SECOND_TRIES)
      .map((h) => new EthRpc(h, { timeoutMs: SECOND_TIMEOUT_MS, ...this._gateFor(chain.key) }));
  }

  /** Ethereum's client. */
  get rpc() {
    return this.rpcFor('ethereum');
  }

  /** One chain's figures: {native, tokens, block, checkedAt, loading, error}. */
  chain(chainKey = 'ethereum') {
    return this.state.chains[chainOf(chainKey).key];
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (e) {
        console.error(e);
      }
    }
  }

  async open() {
    if (!this.state.address) {
      this.state.address = await withEthKey(this.app, async ({ address }) => address, this.kv);
      this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
    }
    return this;
  }

  /** {eth: the chain's coin, ...symbol} as prepareSend() wants them, for `chainKey`. */
  balances(chainKey = 'ethereum') {
    const c = this.chain(chainKey);
    const b = { eth: c.native };
    for (const [k, v] of c.tokens) b[k] = v;
    return b;
  }

  /**
   * What open transactions on `chainKey` hold of each balance: {eth: the chain's coin (amounts and
   * fees at most), ...symbol} (outbox.js promised). Zero for what nothing holds.
   */
  held(chainKey = 'ethereum') {
    const k = chainOf(chainKey).key;
    const p = promised(this.state.outbox, k, { mined: this.chain(k).minedNonce ?? null, block: this.chain(k).block ?? null });
    const out = { eth: p.native };
    for (const token of tokensFor(k)) out[token.symbol] = p.tokens.get(token.address.toLowerCase()) ?? 0n;
    return out;
  }

  /**
   * balances(chainKey) less what open transactions on that chain already promised (held): what a new
   * payment, swap or Max may use. A figure not read yet stays null. The amounts held come along as
   * .held (never a token's symbol), for the words.
   */
  spendable(chainKey = 'ethereum') {
    const k = chainOf(chainKey).key;
    const b = this.balances(k);
    const held = this.held(k);
    const out = {};
    for (const [sym, v] of Object.entries(b)) {
      const x = held[sym] ?? 0n;
      out[sym] = typeof v === 'bigint' ? (v > x ? v - x : 0n) : v;
    }
    Object.defineProperty(out, 'held', { value: held, enumerable: false });
    return out;
  }

  /**
   * This wallet's swap on `chainKey` paying with `token` (an address; null: the coin) still waiting to
   * be mined, or null (outbox.js openSwapOf, with the mined count read with the balances).
   */
  openSwap(chainKey, token) {
    const k = chainOf(chainKey).key;
    return openSwapOf(this.state.outbox, { chain: k, token, mined: this.chain(k).minedNonce ?? null, block: this.chain(k).block ?? null });
  }

  /** spendable(chainKey) of one asset (the chain's coin or a token), or null while not read. */
  spendableOf(chainKey, asset) {
    const s = this.spendable(chainKey);
    const sym = asset && asset.symbol === nativeFor(chainOf(chainKey).key).symbol ? 'eth' : asset && asset.symbol;
    return sym in s ? s[sym] : null;
  }

  /** What open transactions hold of one asset on `chainKey` (0n when nothing). */
  heldOf(chainKey, asset) {
    const h = this.held(chainKey);
    const sym = asset && asset.symbol === nativeFor(chainOf(chainKey).key).symbol ? 'eth' : asset && asset.symbol;
    return h[sym] ?? 0n;
  }

  async reloadOutbox() {
    this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
    this.emit();
    return this.state.outbox;
  }

  /**
   * One chain's balances: its coin, the block and every known token (one server, three requests).
   * A read of that chain already under way is shared, never answered with the figures from before
   * it (a screen opened meanwhile kept those: the Uniswap swap showed "Balance 0 ETH" for good while
   * BNB Chain's read from Home was still out, e2e 2026-10-14). fresh: also read again once that one
   * is done, for a screen that needs what is true now (a swap, on every visit).
   */
  async refreshChain(chainKey, { fresh = false } = {}) {
    const c = this.chain(chainKey);
    const k = chainOf(chainKey).key;
    const running = this._chainRuns[k];
    if (running) {
      await running;
      if (!fresh) return c;
      // Another caller may have started a read after this one asked: that one is fresh enough.
      if (this._chainRuns[k]) return this._chainRuns[k];
    }
    const run = this._readChain(k).finally(() => {
      if (this._chainRuns[k] === run) this._chainRuns[k] = null;
    });
    this._chainRuns[k] = run;
    return run;
  }

  async _readChain(chainKey) {
    const c = this.chain(chainKey);
    const address = this.state.address;
    const rpc = this.rpcFor(chainKey);
    const tokens = tokensFor(chainKey);
    c.loading = true;
    this.emit();
    try {
      const calls = tokens.map((token) => ({ to: token.address, data: encodeCall('balanceOf(address)', [address]) }));
      const block = await rpc.blockNumber();
      // Every figure from ONE block, so the mined transaction count and the balances agree: open
      // entries below the count are in the balances already (held(), spendable(), openSwap()). A
      // load-balanced server answering them from backends a block apart could otherwise free money
      // a transaction still holds. The newest block; a backend that does not have it yet answers
      // "unknown block" (never an older figure), and all three are asked again three blocks back.
      // The count not read: unknown, and every open entry still counts (release audit 0.1.6).
      const readAt = async (at) => {
        const mined = typeof rpc.getTransactionCount === 'function' ? rpc.getTransactionCount(address, at).catch(() => null) : null;
        return Promise.all([rpc.getBalance(address, at), rpc.multicall(calls, { block: at }), mined]);
      };
      let figures;
      let at = block;
      try {
        figures = await readAt(at);
      } catch (e) {
        if (!(e instanceof EthRpcError && e.isMissingState)) throw e;
        at = Math.max(0, block - 3);
        figures = await readAt(at);
      }
      const [native, answers, minedNonce] = figures;
      c.native = native;
      // The block the figures are from (what held() and openSwap() compare transactions against).
      c.block = at;
      c.minedNonce = typeof minedNonce === 'bigint' ? minedNonce : null;
      const map = new Map();
      tokens.forEach((token, i) => {
        const r = answers[i];
        map.set(token.symbol, r && r.success && r.data.length === 32 ? abiDecode('uint256', r.data)[0] : null);
      });
      c.tokens = map;
      c.checkedAt = Date.now();
      c.error = null;
    } catch (e) {
      c.error = { host: rpc.host, message: e.message, code: e.code };
    }
    c.loading = false;
    return c;
  }

  /**
   * Every chain's balances (each its own server), then Ethereum's history when allowed. A refresh
   * already under way is shared (its answer, not the state from before it).
   */
  refresh() {
    if (!this._refreshRun) {
      this._refreshRun = this._refreshAll().finally(() => {
        this._refreshRun = null;
      });
    }
    return this._refreshRun;
  }

  async _refreshAll() {
    this.state.loading = true;
    this.emit();
    try {
      await Promise.all(CHAIN_KEYS.map((k) => this.refreshChain(k)));
      if (ethPrefs(this.app).history) {
        try {
          const h = await fetchHistory(this.state.address);
          this.state.history = { ...h, error: null, at: Date.now() };
        } catch (e) {
          this.state.history = { ...this.state.history, error: e.message };
        }
      } else this.state.history = { txs: [], transfers: [], error: null, at: null };
      try {
        this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
        await this.settleFromIndex();
      } catch {
        /* keep what we had: locked mid-way */
      }
    } finally {
      this.state.loading = false;
      this.emit();
    }
    return this.state;
  }

  /**
   * Hashes that may have taken `e`'s nonce, from what this wallet already holds: another
   * transaction of the outbox with the same nonce on the same chain, and the history index's
   * (Ethereum). Each is still checked on the server before it counts (send.js findNonceTaker).
   */
  nonceTwins(e) {
    const chain = entryChain(e);
    const me = e.from.toLowerCase();
    const out = this.state.outbox.filter((o) => o.hash !== e.hash && entryChain(o) === chain && o.from.toLowerCase() === me && o.nonce === e.nonce).map((o) => o.hash);
    if (chain === 'ethereum') for (const tx of this.state.history.txs) if (tx.from === me && tx.nonce !== null && String(tx.nonce) === e.nonce && tx.hash !== e.hash) out.push(tx.hash);
    return out;
  }

  /**
   * One look at every open transaction this device sent, each on its own chain; and, slowly
   * (send.js REJECTED_LOOK_MS), at the recent ones a server called never sent (audit BM-2).
   * One entry's trouble never stops the others' look (release audit 0.1.5, S2: a BNB Chain
   * server refusing receipts held up every Ethereum payment behind it): each entry's error is
   * kept for it (followError(hash), followErrors(chainKey)), tagged with its chain and hash, and
   * forgotten at its next look that goes through. Never throws for an entry's error.
   */
  async followOpen({ now = Date.now() } = {}) {
    let changed = false;
    for (const e of this.state.outbox.filter(isOpen)) {
      const chainKey = entryChain(e);
      try {
        const next = await followOnce(this.app, this.rpcFor(chainKey), e, { ethId: this.ethId, kv: this.kv, candidates: this.nonceTwins(e), others: () => this.otherRpcs(chainKey) });
        this._followErrors.delete(e.hash);
        if (next.state !== e.state || next.receipt !== e.receipt || next.unsureSince !== e.unsureSince || next.refusedAt !== e.refusedAt) changed = true;
      } catch (err) {
        this._followErrors.set(e.hash, tagged(err, chainKey, e.hash));
        // An entry this look moved on before the error (the server has it: 'pending') still counts.
        changed = true;
      }
    }
    // A 'replaced' the history index says was mined: only the server in use's receipt undoes it (RE2-5).
    const minedByIndex = new Set(this.state.history.txs.filter((item) => item.blockNumber != null).map((tx) => tx.hash));
    const recheck = (x) => (x.state === 'rejected' && now - x.createdAt < REJECTED_FOLLOW_MS) || (x.state === 'replaced' && entryChain(x) === 'ethereum' && minedByIndex.has(x.hash.toLowerCase()));
    for (const e of this.state.outbox.filter(recheck)) {
      const next = await recheckClosed(this.app, this.rpcFor(entryChain(e)), e, { ethId: this.ethId, kv: this.kv }).catch(() => e);
      if (next.state !== e.state) changed = true;
    }
    if (changed) await this.reloadOutbox();
    return changed;
  }

  /** The error of the last look at entry `hash` ({code, message, chain, hash}), or null when it went through. */
  followError(hash) {
    return this._followErrors.get(String(hash || '').toLowerCase()) || this._followErrors.get(hash) || null;
  }

  /** The errors of the last look at `chainKey`'s open entries, newest entry first. */
  followErrors(chainKey) {
    const k = chainOf(chainKey).key;
    return [...this._followErrors.values()].filter((x) => x.chain === k);
  }

  /** Entries closed as never sent that the history index saw mined: settled by it (audit BM-2; never a 'replaced': RE2-5). */
  async settleFromIndex() {
    let changed = false;
    for (const e of this.state.outbox) {
      const patch = settledByIndex(e, this.state.history.txs);
      if (!patch) continue;
      await updateOutbox(this.app, e.hash, patch, { ethId: this.ethId, kv: this.kv }).catch(() => null);
      changed = true;
    }
    if (changed) this.state.outbox = await loadOutbox(this.app, { ethId: this.ethId, kv: this.kv });
    return changed;
  }

  /** What moved, on every chain (or only `chainKey`): open ones first, then newest. */
  activity(chainKey = null) {
    const h = this.state.history;
    const keys = chainKey ? [chainOf(chainKey).key] : CHAIN_KEYS;
    const items = keys.flatMap((k) => mergeActivity({ address: this.state.address, outbox: this.state.outbox, txs: h.txs, transfers: h.transfers, chain: k }));
    if (keys.length === 1) return items;
    const open = (i) => (i.state === 'signed' || i.state === 'pending' ? 1 : 0);
    return items.sort((a, b) => open(b) - open(a) || (b.at ?? 0) - (a.at ?? 0));
  }
}

/** The native coin of a chain, for screens that only have the key. */
export const coinOf = (chainKey) => nativeFor(chainKey);

let current = null;

/**
 * The EVM wallet (Ethereum and BNB Chain) of the unlocked Firo wallet, opened; null when this
 * device has none. Throws VaultError('locked') when locked.
 */
export async function ethWallet(app, { kv = store } = {}) {
  if (!app || !app.dbPass || !app.record) throw new VaultError('locked', t('Unlock the wallet first.'));
  const record = await getEthRecord(kv);
  if (!record) {
    current = null;
    return null;
  }
  if (!current || current.app !== app || current.walletId !== app.record.id || current.ethId !== record.id) current = new EthWallet(app, record, kv);
  // BNB Chain's server changed under someone who used it: told on the first screen that opens this
  // wallet (app.bscNote; lib/eth/server_notes.js), before anything of theirs goes to the new one.
  if (bscServerNote(app.prefs) && typeof app.bscNote === 'function' && !app.bscNoteShown) app.bscNote();
  return current.open();
}

/** On lock: the address, the derived data keys and the cached wallet are forgotten. */
export function forgetEthWallet() {
  current = null;
  forgetDataKeys();
}

/** Removes the EVM wallet from this device: the sealed key and what it sent. The coins stay on their chains. */
export async function removeEthWallet(kv = store) {
  await clearOutbox(kv);
  await removeEthKey(kv);
  forgetEthWallet();
}
