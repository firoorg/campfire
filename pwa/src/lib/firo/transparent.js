// The transparent side of a Firo wallet over ElectrumX: BIP44 address
// discovery (gap limit 20 on the receive and the change chain), script-hash
// subscriptions, history, UTXOs computed from that history, balances, fee
// rates and coin selection, and building + signing a send.
//
// Store keys (under the wallet's store):
//   t/addr        {chains: {0: {derived, lastUsed, issued}, 1: {...}}, status: {scripthash: status}}
//   t/hist        {scripthash: [{tx_hash, height}]}
//   t/tx/<txid>   {hex, height, time, inputs, proof?, failedAt?, disagreed?}   (inputs: the server's
//                 verbose vin values, a fallback; proof: the Merkle proof's verdict, see utxos())
//   t/frozen      ['txid:vout', …]
//   pending       {txid: {hex, height, time, resent?, unsure?, dropped?, noSecondSince?, oneNode?,
//                 letGo?}}: this wallet's own payments, recorded before they are broadcast (audit
//                 FM-1), until they are in a block.
//                 Outside t/ so that a Rescan keeps them.
//
// Privacy: subscribing to an address tells the server it belongs to the same
// person as the other addresses on that connection. That is how every
// Electrum wallet works; the UI says so (research §3.6).
//
// For callers that choose the coins themselves (the Rosen stream, coin control):
//   planExplicit({utxos, outputs, feePerKb, changeScript, dust, minRelayFeePerKb, subtractFee})
//     → {inputs, outputs, fee, change, size}     every given coin is spent, nothing else
//   paymentsTo({client, net, to, from, minHeight}) → [{txid, height, value, fromMatches}]
//     transactions paying address `to`, and whether an input came from address `from`

import { CHAIN_RECEIVE, CHAIN_CHANGE, GAP_LIMIT } from './params.js';
import { decodeTx, buildSignedTransaction, estimateSize, feeForSize, SEQUENCE_LOCKTIME } from './tx.js';
import { classifyOutputScript } from './script.js';
import { scriptHash, addressToScript } from './address.js';
import { bytesToHex } from './bytes.js';
import { wipe } from './keys.js';
import { PROVEN } from './history.js';
import { t } from '../i18n.js';

export class TransparentError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code; // 'insufficient' | 'dust' | 'not-synced' | 'invalid-address' | 'server'
    Object.assign(this, extra);
  }
}

const KEY = Object.freeze({ addr: 't/addr', hist: 't/hist', frozen: 't/frozen', pending: 'pending', conflicts: 't/conflicts', mnSpendable: 't/mnSpendable' });

/** A masternode's collateral: exactly 1,000 FIRO in one coin. */
export const MN_COLLATERAL = 1000n * 100000000n;

/** How long the coins of a payment let go of are reused first: long past any relay or reorganisation (P7, X3). */
export const CONFLICT_KEEP_MS = 48 * 3600 * 1000;

/** What a transaction record keeps in the store (the rest, `decoded`, is rebuilt from hex). */
const STORED = ['hex', 'height', 'time', 'firstSeen', 'inputs', 'proof', 'failedAt', 'disagreed', 'dropped'];
const storedOf = (rec) => Object.fromEntries(STORED.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));

const chainsInit = () => ({ [CHAIN_RECEIVE]: { derived: 0, lastUsed: -1, issued: 0 }, [CHAIN_CHANGE]: { derived: 0, lastUsed: -1, issued: 0 } });

export class TransparentWallet {
  constructor({ net, keys, client, store, gapLimit = GAP_LIMIT, minConfirmations = 1, txBatch = 25 }) {
    this.net = net;
    this.keys = keys;
    this.client = client;
    this.store = store;
    this.gapLimit = gapLimit;
    this.minConfirmations = minConfirmations;
    this.txBatch = txBatch;
    this.addr = { chains: chainsInit(), status: {} };
    this.hist = {};
    this.txs = new Map(); // txid → record (with .decoded)
    this.frozen = new Set();
    this.byScripthash = new Map(); // scripthash → address entry
    this.pending = new Map(); // txid → own payment not in a block yet (see `pending` above)
    // outpoint → {txid, at}: coins of a payment of ours that was let go of (refused and forgotten, or
    // dropped) while it may still have reached the network: the next payment spends one of them, so
    // the two conflict and at most one is ever mined (audit of 0.1.8, X3 / P7).
    this.conflicts = new Map();
    // Coins of exactly 1,000 FIRO, as Campfire does (audit P3): locked as a masternode's collateral
    // unless the network says they are not one ('no'), or the person unlocked one (mnSpendable).
    this.collateral = new Map(); // outpoint -> 'yes' | 'no' (asked each session)
    this.mnSpendable = new Set(); // outpoints the person chose to spend anyway
    this.loaded = false;
  }

  // ------------------------------------------------------------ persistence

  async load() {
    this.addr = (await this.store.get(KEY.addr)) ?? { chains: chainsInit(), status: {} };
    this.hist = (await this.store.get(KEY.hist)) ?? {};
    this.frozen = new Set((await this.store.get(KEY.frozen)) ?? []);
    for (const k of await this.store.keys('t/tx/')) {
      const rec = await this.store.get(k);
      if (!rec?.hex) continue;
      // 0.1.3 marked a failed proof by setting the height to 0 (and the next sync put it back):
      // the block it claimed is its height again, and the proof gates it (FE-1).
      if (rec.claimedHeight > 0 && !(rec.height > 0)) rec.height = rec.claimedHeight;
      delete rec.claimedHeight;
      this.txs.set(k.slice(5), { ...rec, decoded: decodeTx(rec.hex, this.net) });
    }
    this.pending = new Map(Object.entries((await this.store.get(KEY.pending)) ?? {}));
    this.conflicts = new Map(Object.entries((await this.store.get(KEY.conflicts)) ?? {}));
    this.mnSpendable = new Set((await this.store.get(KEY.mnSpendable)) ?? []);
    // A payment of ours not in the history yet is known from its own bytes (after a Rescan too).
    for (const [txid, p] of this.pending) if (!this.txs.has(txid) && p?.hex) this.txs.set(txid, this._pendingRecord(txid, p));
    for (const chain of [CHAIN_RECEIVE, CHAIN_CHANGE]) {
      for (let i = 0; i < this.addr.chains[chain].derived; i++) this._entry(chain, i);
    }
    this.loaded = true;
  }

  async _saveAddr() {
    await this.store.put(KEY.addr, this.addr);
  }

  /** Writes one transaction record. */
  async putTx(txid, rec) {
    await this.store.put(`t/tx/${txid}`, storedOf(rec));
  }

  // ------------------------------------------------------------ own payments before a block (FM-1)

  _pendingRecord(txid, p) {
    const decoded = decodeTx(p.hex, this.net);
    return { hex: p.hex, height: 0, time: null, firstSeen: p.time ?? Math.floor(Date.now() / 1000), inputs: null, decoded, ...(p.dropped ? { dropped: true } : {}) };
  }

  /** Resolves false when the store refused the write (the engine is closed), else true. */
  async _savePending() {
    return (await this.store.put(KEY.pending, Object.fromEntries(this.pending))) !== false;
  }

  /**
   * A payment of this wallet, signed and about to be broadcast: kept (and its coins spent) from
   * now on, whatever the broadcast answers or fails to, until it is in a block or the network
   * says it is not there (audit FM-1: an unanswered broadcast left nothing behind, so the next
   * payment picked other coins and paid twice). height: the tip it was made at.
   *
   * A write that fails (storage full) and did not land leaves nothing behind, in memory either, and
   * rejects with its error (release re-audit R-2: kept in memory, the follow-up sent it two blocks
   * after the screens had said "not sent"); a write the store refuses (the engine is closed: R1-2)
   * likewise, resolving false. One that landed, or cannot be told, keeps it: resolves true.
   * unsure: written down in doubt (the engine's broadcast has not been answered yet: release
   * re-audit 3 RE3-1), cleared once the node answers or the network shows it.
   */
  async addPending({ txid, hex, height, unsure = false, to, toAll }) {
    const decoded = decodeTx(hex, this.net);
    if (decoded.txid !== txid) throw new TransparentError('build', t('The transaction does not have the id it was given.'));
    const p = { hex, height: Number.isSafeInteger(height) ? height : null, time: Math.floor(Date.now() / 1000), ...(unsure ? { unsure: true } : {}), ...(typeof to === 'string' && to ? { to } : {}), ...(Array.isArray(toAll) && toAll.length > 1 ? { toAll: toAll.filter((x) => typeof x === 'string').slice(0, 20) } : {}) };
    const before = this.pending.get(txid);
    const added = !this.txs.has(txid);
    const rec = this.txs.get(txid);
    const wasDropped = Boolean(rec && rec.dropped);
    this.pending.set(txid, p);
    if (added) this.txs.set(txid, this._pendingRecord(txid, p));
    // The same bytes again after "did not go through" (release re-audit R1-4: the record kept
    // `dropped`, so its coins looked free while it was pending again).
    else if (wasDropped) delete rec.dropped;
    const undo = () => {
      if (before) this.pending.set(txid, before);
      else this.pending.delete(txid);
      if (added) this.txs.delete(txid);
      else if (wasDropped) rec.dropped = true;
    };
    let written;
    try {
      written = await this._savePending();
    } catch (e) {
      if ((await this._pendingOnDisk(txid, hex)) !== false) return true;
      undo();
      throw e;
    }
    if (written === false) {
      undo();
      return false;
    }
    return true;
  }

  /** Whether the stored pending payments hold `txid` with these bytes: true, false, or null (cannot be read). */
  async _pendingOnDisk(txid, hex) {
    try {
      const m = await this.store.get(KEY.pending);
      return Boolean(m && Object.prototype.hasOwnProperty.call(m, txid) && m[txid] && m[txid].hex === hex);
    } catch {
      return null;
    }
  }

  /**
   * The node refused it (an answer, not a silence): it is forgotten and its coins are free again.
   * Resolves whether the store forgot it too (false: refused, the engine is closed).
   */
  /**
   * Keeps the coins `hex` spends as conflict coins (see this.conflicts): its payment is let go of while
   * it may still be on the network. A write that fails leaves them in memory: the safe side.
   */
  async keepConflicts(txid, hex) {
    let decoded;
    try {
      decoded = decodeTx(hex, this.net);
    } catch {
      return;
    }
    const at = Date.now();
    for (const i of decoded.vin) if (i.txid) this.conflicts.set(`${i.txid}:${i.vout}`, { txid, at });
    await this._saveConflicts().catch(() => {});
  }

  /** The conflict coins still kept (not older than CONFLICT_KEEP_MS): outpoint keys. */
  conflictCoins(now = Date.now()) {
    const out = new Set();
    for (const [k, v] of this.conflicts) if (now - (v?.at ?? 0) < CONFLICT_KEEP_MS) out.add(k);
    return out;
  }

  async _saveConflicts() {
    const now = Date.now();
    for (const [k, v] of this.conflicts) if (now - (v?.at ?? 0) >= CONFLICT_KEEP_MS) this.conflicts.delete(k);
    return (await this.store.put(KEY.conflicts, Object.fromEntries(this.conflicts))) !== false;
  }

  async removePending(txid) {
    const p = this.pending.get(txid);
    // Let go of while it may have reached the network: its coins are spent first by the next payment.
    if (p?.hex) await this.keepConflicts(txid, p.hex);
    this.pending.delete(txid);
    if (!this.historyHeights().has(txid)) {
      this.txs.delete(txid);
      await this.store.del(`t/tx/${txid}`);
    }
    return this._savePending();
  }

  /** In a block now: the history keeps it from here, it is no longer followed. */
  async settlePending(txid) {
    if (!this.pending.delete(txid)) return;
    await this._savePending();
  }

  /**
   * Changes a pending payment's bookkeeping ({resent, unsure, dropped, height, noSecondSince,
   * oneNode, letGo}); undefined removes a field. Resolves whether the store took it (false: refused,
   * the engine is closed; undefined: no such payment).
   */
  async updatePending(txid, patch) {
    const p = this.pending.get(txid);
    if (!p) return undefined;
    Object.assign(p, patch);
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete p[k];
    const rec = this.txs.get(txid);
    if (rec && 'dropped' in patch) {
      if (patch.dropped) rec.dropped = true;
      else delete rec.dropped;
    }
    // Dropped: its coins are free again, and spent first by the next payment (P7: a resend with other
    // coins paid twice once the original went out after all).
    if (patch.dropped && p.hex) await this.keepConflicts(txid, p.hex);
    return this._savePending();
  }

  _entry(chain, index) {
    const e = this.keys.address(chain, index);
    this.byScripthash.set(e.scripthash, e);
    return e;
  }

  // ------------------------------------------------------------ addresses

  /** Every derived address with whether it has history. */
  addresses() {
    return [...this.byScripthash.values()].map((e) => ({ ...e, used: (this.hist[e.scripthash]?.length ?? 0) > 0 }));
  }

  isOwnScript(script) {
    return this.byScripthash.has(scriptHash(script));
  }

  ownEntryForScript(script) {
    return this.byScripthash.get(scriptHash(script)) ?? null;
  }

  _firstUnused(chain) {
    const c = this.addr.chains[chain];
    for (let i = 0; i < c.derived; i++) {
      const e = this.keys.address(chain, i);
      if (!(this.hist[e.scripthash]?.length > 0)) return e;
    }
    return this._entry(chain, c.derived);
  }

  /** The address to show on Receive: the newest one handed out that has not been paid yet. */
  receiveAddress() {
    const c = this.addr.chains[CHAIN_RECEIVE];
    const first = this._firstUnused(CHAIN_RECEIVE);
    const issued = this.keys.address(CHAIN_RECEIVE, Math.max(first.index, c.issued ?? 0));
    return this.hist[issued.scripthash]?.length ? first : issued;
  }

  /**
   * A fresh receive address. Stays within the gap limit (at most 20 unpaid
   * addresses after the last paid one), so a restore still finds every coin;
   * at the limit the newest unpaid one is handed out again.
   */
  async newReceiveAddress() {
    const c = this.addr.chains[CHAIN_RECEIVE];
    const cur = this.receiveAddress().index;
    const next = Math.min(cur + 1, c.lastUsed + this.gapLimit);
    c.issued = Math.max(next, cur);
    const e = this._entry(CHAIN_RECEIVE, c.issued);
    if (c.issued >= c.derived) {
      c.derived = c.issued + 1;
      if (this.client.connected) await this.client.subscribeScripthash(e.scripthash).catch(() => {});
    }
    await this._saveAddr();
    return e;
  }

  /** Where change goes: the first unused change address. */
  changeAddress() {
    return this._firstUnused(CHAIN_CHANGE);
  }

  // ------------------------------------------------------------ sync

  /**
   * Discovers addresses, refreshes the history of those whose status
   * changed, fetches transactions not seen before. onProgress({done, total}).
   * Returns {changed}.
   */
  async sync({ onProgress } = {}) {
    if (!this.loaded) await this.load();
    let changed = false;
    const shChanged = [];
    for (const chain of [CHAIN_RECEIVE, CHAIN_CHANGE]) {
      const c = this.addr.chains[chain];
      // Subscribe to everything derived so far, then extend until `gapLimit` unused in a row.
      let start = 0;
      for (;;) {
        const end = Math.max(c.derived, c.lastUsed + 1 + this.gapLimit);
        if (start >= end) break;
        const entries = [];
        for (let i = start; i < end; i++) entries.push(this._entry(chain, i));
        const statuses = await this.client.subscribeScripthashes(entries.map((e) => e.scripthash));
        for (const e of entries) {
          const st = statuses[e.scripthash];
          if (st !== null && st !== undefined) c.lastUsed = Math.max(c.lastUsed, e.index);
          if ((this.addr.status[e.scripthash] ?? null) !== (st ?? null)) shChanged.push(e.scripthash);
          this.addr.status[e.scripthash] = st ?? null;
        }
        c.derived = Math.max(c.derived, end);
        start = end;
      }
    }
    await this._saveAddr();
    onProgress?.({ done: 0, total: shChanged.length });
    if (shChanged.length) {
      changed = true;
      const res = await this.client.batch(shChanged.map((sh) => ['blockchain.scripthash.get_history', [sh]]));
      shChanged.forEach((sh, i) => {
        if (res[i] instanceof Error) throw res[i];
        this.hist[sh] = res[i];
      });
      await this.store.put(KEY.hist, this.hist);
    }
    await this._fetchTxs(onProgress);
    return { changed };
  }

  /** A status notification for one of our script hashes. Returns true if anything changed. */
  async onStatus(sh, status) {
    const e = this.byScripthash.get(sh);
    if (!e) return false;
    if ((this.addr.status[sh] ?? null) === (status ?? null)) return false;
    this.addr.status[sh] = status ?? null;
    this.hist[sh] = await this.client.getHistory(sh);
    const c = this.addr.chains[e.chain];
    if (this.hist[sh].length && e.index > c.lastUsed) {
      c.lastUsed = e.index;
      // Keep `gapLimit` fresh addresses watched after the last used one.
      const entries = [];
      for (let i = c.derived; i <= c.lastUsed + this.gapLimit; i++) entries.push(this._entry(e.chain, i));
      if (entries.length) {
        c.derived = c.lastUsed + this.gapLimit + 1;
        const st = await this.client.subscribeScripthashes(entries.map((x) => x.scripthash));
        for (const x of entries) this.addr.status[x.scripthash] = st[x.scripthash] ?? null;
      }
    }
    await this._saveAddr();
    await this.store.put(KEY.hist, this.hist);
    await this._fetchTxs();
    return true;
  }

  /** History entries across all addresses: txid → height (the server's; ≤ 0 = mempool). */
  historyHeights() {
    const m = new Map();
    for (const list of Object.values(this.hist)) for (const h of list) m.set(h.tx_hash, h.height);
    return m;
  }

  async _fetchTxs(onProgress) {
    const heights = this.historyHeights();
    const need = [];
    for (const [txid, height] of heights) {
      const rec = this.txs.get(txid);
      // New, or newly confirmed (its block time is wanted), or moved by a reorg, or back after it
      // was given up on.
      if (!rec || (height > 0 && rec.height !== height) || rec.dropped) need.push(txid);
    }
    // Transactions that left our history (dropped from the mempool) are forgotten; not a payment
    // of ours still followed (pending): its absence from one node's list proves nothing (FM-1).
    for (const txid of [...this.txs.keys()]) {
      if (!heights.has(txid) && !this.pending.has(txid)) {
        const rec = this.txs.get(txid);
        // A payment of ours gone from the list (a reorganisation, a node that lies): its coins are
        // spent first by the next payment, so it and a resend cannot both be mined (audit X6).
        if (
          rec?.hex &&
          rec.decoded?.vin.some((i) => {
            const out = i.txid ? this.txs.get(i.txid)?.decoded.vout[i.vout] : null;
            return Boolean(out && this.isOwnScript(out.script));
          })
        )
          await this.keepConflicts(txid, rec.hex);
        this.txs.delete(txid);
        await this.store.del(`t/tx/${txid}`);
      }
    }
    let done = 0;
    for (let i = 0; i < need.length; i += this.txBatch) {
      const part = need.slice(i, i + this.txBatch);
      const res = await this.client.batch(part.map((item) => ['blockchain.transaction.get', [item, true]]));
      for (let j = 0; j < part.length; j++) {
        const v = res[j];
        if (v instanceof Error) throw v;
        if (!v || typeof v.hex !== 'string') throw new TransparentError('server', t('The server sent a bad transaction.'));
        const decoded = decodeTx(v.hex, this.net);
        if (decoded.txid !== part[j]) throw new TransparentError('server', t('The server sent a different transaction than asked for.'));
        const height = heights.get(part[j]);
        const prev = this.txs.get(part[j]);
        const rec = {
          hex: v.hex,
          height: height > 0 ? height : 0,
          time: height > 0 ? v.blocktime ?? v.time ?? null : prev?.time ?? Math.floor(Date.now() / 1000),
          firstSeen: prev?.firstSeen ?? Math.floor(Date.now() / 1000),
          inputs: Array.isArray(v.vin) ? v.vin.map((x) => (x.coinbase ? null : { valueSat: x.valueSat ?? null, address: x.address ?? null })) : null,
        };
        this.txs.set(part[j], { ...rec, decoded });
        await this.putTx(part[j], rec);
      }
      done += part.length;
      onProgress?.({ done, total: need.length });
    }
    // Heights of transactions already held may have changed (reorg to mempool).
    for (const [txid, height] of heights) {
      const rec = this.txs.get(txid);
      if (rec && height <= 0 && rec.height !== 0) {
        rec.height = 0;
        // Out of its block: whatever was proven about that block no longer holds.
        delete rec.proof;
        delete rec.failedAt;
        delete rec.disagreed;
        await this.putTx(txid, rec);
      }
    }
  }

  // ------------------------------------------------------------ coins and balance

  /**
   * Unspent outputs to our addresses, from our own history: outputs to us
   * that no transaction in that history spends. Spendable (and counted as confirmed) only when its
   * transaction is proven to be in its block (audit D-01, FE-1: a node's word alone let an invented
   * payment be counted and spent); until then confirmations is 0 and `unproven` says why.
   */
  utxos(tipHeight) {
    const spent = new Set();
    // A payment of ours the network does not have (dropped) spends nothing and pays nothing.
    for (const r of this.txs.values()) if (!r.dropped) for (const i of r.decoded.vin) if (i.txid) spent.add(`${i.txid}:${i.vout}`);
    const out = [];
    for (const [txid, r] of this.txs) {
      if (r.dropped) continue;
      for (const o of r.decoded.vout) {
        if (o.type !== 'p2pkh') continue;
        const e = this.ownEntryForScript(o.script);
        if (!e || spent.has(`${txid}:${o.n}`)) continue;
        const height = r.height > 0 ? r.height : null;
        const proven = PROVEN.has(r.proof);
        const confirmations = height && tipHeight && proven ? Math.max(0, tipHeight - height + 1) : 0;
        const coinbase = r.decoded.isCoinbase;
        const mature = !coinbase || confirmations >= this.net.coinbaseMaturity;
        const k = `${txid}:${o.n}`;
        // A masternode's collateral (or a coin that may be one, unchecked): kept out like a frozen coin.
        const collateral = o.value === MN_COLLATERAL && this.collateral.get(k) !== 'no' && !this.mnSpendable.has(k);
        const frozen = this.frozen.has(k) || collateral;
        out.push({
          txid,
          vout: o.n,
          value: o.value,
          height,
          confirmations,
          unproven: height !== null && !proven,
          address: e.address,
          chain: e.chain,
          index: e.index,
          script: o.script,
          coinbase,
          frozen,
          ...(collateral ? { collateral: true } : {}),
          spendable: mature && confirmations >= this.minConfirmations && !frozen,
        });
      }
    }
    return out;
  }

  /** {available, pending} in satoshi (BigInt). Pending: unconfirmed and immature coins. Frozen coins count in neither. */
  balance(tipHeight) {
    let available = 0n;
    let pending = 0n;
    let mnLocked = 0n; // coins of 1,000 FIRO kept as masternode collateral (P3): said, never hidden
    for (const u of this.utxos(tipHeight)) {
      if (u.collateral) mnLocked += u.value;
      if (u.frozen) continue;
      if (u.spendable) available += u.value;
      else pending += u.value;
    }
    return { available, pending, mnLocked };
  }

  async setFrozen(txid, vout, frozen) {
    const k = `${txid}:${vout}`;
    if (frozen) this.frozen.add(k);
    else this.frozen.delete(k);
    await this.store.put(KEY.frozen, [...this.frozen]);
    // A coin of 1,000 FIRO: unfreezing it is the person's choice to spend it although it may back a
    // masternode (the screen warns first); freezing it again puts the collateral lock back.
    const isMnSize = [...this.txs.entries()].some(([item, r]) => item === txid && r.decoded.vout.some((o) => o.n === Number(vout) && o.value === MN_COLLATERAL));
    if (isMnSize) {
      if (frozen) this.mnSpendable.delete(k);
      else this.mnSpendable.add(k);
      await this.store.put(KEY.mnSpendable, [...this.mnSpendable]);
    }
  }

  // ------------------------------------------------------------ fees

  /**
   * Fee rates in sat/kB: {fast (2 blocks), normal (6), slow (12), min}. Never below the relay fee,
   * never above net.maxFeePerKb: both numbers come from the server, and an absurd one would
   * otherwise be paid as asked (audit D-03).
   */
  async feeRates() {
    const cap = (v) => (v > this.net.maxFeePerKb ? this.net.maxFeePerKb : v);
    const min = await this.client.relayFee().catch(() => this.net.minRelayFeePerKb);
    const floor = cap(min > this.net.minRelayFeePerKb ? min : this.net.minRelayFeePerKb);
    const est = async (n) => {
      const v = await this.client.estimateFee(n).catch(() => null);
      return v === null || v < floor ? floor : cap(v);
    };
    const [fast, normal, slow] = [await est(2), await est(6), await est(12)];
    return { fast, normal, slow, min: floor };
  }

  // ------------------------------------------------------------ sending

  /**
   * Picks coins and works out change and fee. outputs: [{script, value}]
   * (value BigInt; OP_RETURN outputs 0). With `sendAll` every spendable coin
   * goes, and the one paying output receives what is left after the fee.
   * With `subtractFee` the fee comes out of the first paying output.
   */
  planSend({ outputs, feePerKb, tipHeight, subtractFee = false, sendAll = false, utxos = null }) {
    const coins = (utxos ?? this.utxos(tipHeight)).filter((u) => u.spendable);
    const keep = this.conflictCoins();
    return selectCoins({
      utxos: coins,
      mustInclude: coins.filter((u) => keep.has(`${u.txid}:${u.vout}`)),
      outputs,
      feePerKb,
      changeScript: this.changeAddress().script,
      dust: this.net.dust,
      minRelayFeePerKb: this.net.minRelayFeePerKb,
      subtractFee,
      sendAll,
    });
  }

  /** Signs a plan from planSend. Locktime = tip height (as Firo Core's wallet does). */
  signPlan(plan, tipHeight) {
    const keys = [];
    try {
      const inputs = plan.inputs.map((u) => {
        const sk = this.keys.privateKey(u.chain, u.index);
        keys.push(sk);
        return { txid: u.txid, vout: u.vout, value: u.value, script: u.script, sk };
      });
      return buildSignedTransaction({ inputs, outputs: plan.outputs, locktime: tipHeight ?? 0, sequence: SEQUENCE_LOCKTIME, dust: this.net.dust, maxMoney: this.net.maxMoney });
    } finally {
      wipe(...keys);
    }
  }
}

// ---------------------------------------------------------------- coin selection

/**
 * Chooses inputs for `outputs` at `feePerKb` (sat/kB).
 * Returns {inputs, outputs (with change appended if any), fee, change, size}.
 * Throws TransparentError 'insufficient' (with .needed, .available) or 'dust'.
 *
 * Strategy: the smallest single coin that covers everything, else the
 * largest coins first; change below dust is left to the fee.
 */
export function selectCoins({ utxos, outputs, feePerKb, changeScript, dust = 1000n, minRelayFeePerKb = 1000n, subtractFee = false, sendAll = false, mustInclude = [] }) {
  if (!Array.isArray(outputs) || outputs.length === 0) throw new TransparentError('build', t('Nothing to send.'));
  const scripts = outputs.map((o) => o.script);
  const target = outputs.reduce((s, o) => s + o.value, 0n);
  const payIndex = outputs.findIndex((o) => classifyOutputScript(o.script).type !== 'nulldata');
  if (payIndex < 0 && (sendAll || subtractFee)) throw new TransparentError('build', t('There is no output to take the fee from.'));
  const available = utxos.reduce((s, u) => s + u.value, 0n);
  const fee = (n, withChange) => feeForSize(estimateSize(n, withChange ? [...scripts, changeScript] : scripts), feePerKb, minRelayFeePerKb);

  if (sendAll) {
    if (utxos.length === 0) throw new TransparentError('insufficient', t('There are no coins to send.'), { needed: 0n, available: 0n });
    const f = fee(utxos.length, false);
    const others = target - outputs[payIndex].value;
    const v = available - others - f;
    if (v < dust) throw new TransparentError('insufficient', t('After the fee there is too little left to send.'), { needed: others + f + dust, available });
    const outs = outputs.map((o, i) => (i === payIndex ? { ...o, value: v } : o));
    return { inputs: utxos.slice(), outputs: outs, fee: f, change: 0n, size: estimateSize(utxos.length, scripts) };
  }

  for (const o of outputs) if (classifyOutputScript(o.script).type !== 'nulldata' && o.value < dust) throw new TransparentError('dust', t('An amount is too small to send (under 0.00001 FIRO).'));

  const finish = (inputs) => {
    const sum = inputs.reduce((s, u) => s + u.value, 0n);
    const n = inputs.length;
    const outs = outputs.map((o) => ({ ...o }));
    const withChange = (f, change) => {
      outs.push({ script: changeScript, value: change, change: true });
      return { inputs, outputs: outs, fee: f, change, size: estimateSize(n, outs.map((o) => o.script)) };
    };
    const noChange = (f) => ({ inputs, outputs: outs, fee: f, change: 0n, size: estimateSize(n, scripts) });
    if (!subtractFee) {
      const fC = fee(n, true);
      if (sum >= target + fC && sum - target - fC >= dust) return withChange(fC, sum - target - fC);
      // Change would be dust: none, and what is left over goes to the fee.
      if (sum >= target + fee(n, false)) return noChange(sum - target);
      return null;
    }
    // The fee comes out of the first paying output.
    if (sum < target) return null;
    const left = sum - target;
    const f = left >= dust ? fee(n, true) : fee(n, false);
    outs[payIndex].value -= f;
    if (outs[payIndex].value < dust) throw new TransparentError('dust', t('After the fee the amount is too small to send.'));
    return left >= dust ? withChange(f, left) : noChange(f + left);
  };

  const asc = utxos.slice().sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  // 0. A coin of a payment let go of while it may be on the network (mustInclude) is always one of
  // them: then the two conflict, and at most one is ever mined (P7, X3). The largest such coin, then
  // the others largest first.
  if (mustInclude.length) {
    const keys = new Set(utxos.map((u) => `${u.txid}:${u.vout}`));
    const first = mustInclude.filter((u) => keys.has(`${u.txid}:${u.vout}`)).sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0))[0];
    if (first) {
      const picked = [first];
      const r0 = finish(picked);
      if (r0) return r0;
      for (const u of asc.slice().reverse()) {
        if (u === first) continue;
        picked.push(u);
        const r = finish(picked);
        if (r) return r;
      }
      const needed = target + fee(Math.max(1, utxos.length), true);
      throw new TransparentError('insufficient', t('Not enough spendable public FIRO for this amount and fee.'), { needed, available });
    }
  }
  // 1. the smallest single coin that covers it
  for (const u of asc) {
    const r = finish([u]);
    if (r) return r;
  }
  // 2. largest first
  const desc = asc.slice().reverse();
  const picked = [];
  for (const u of desc) {
    picked.push(u);
    const r = finish(picked);
    if (r) return r;
  }
  const needed = target + fee(Math.max(1, utxos.length), true);
  throw new TransparentError('insufficient', t('Not enough spendable public FIRO for this amount and fee.'), { needed, available });
}

/**
 * Spends exactly `utxos` (all of them) to `outputs`, change to `changeScript`
 * unless it would be dust (then it goes to the fee). With `subtractFee` the
 * fee comes out of the first paying output. Throws 'insufficient' / 'dust'.
 */
export function planExplicit({ utxos, outputs, feePerKb, changeScript, dust = 1000n, minRelayFeePerKb = 1000n, subtractFee = false }) {
  if (!Array.isArray(utxos) || utxos.length === 0) throw new TransparentError('build', t('Choose at least one coin to spend.'));
  if (!Array.isArray(outputs) || outputs.length === 0) throw new TransparentError('build', t('Nothing to send.'));
  const seen = new Set();
  for (const u of utxos) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) throw new TransparentError('build', t('The same coin is chosen twice.'));
    seen.add(k);
  }
  const scripts = outputs.map((o) => o.script);
  const sum = utxos.reduce((s, u) => s + u.value, 0n);
  const target = outputs.reduce((s, o) => s + o.value, 0n);
  const payIndex = outputs.findIndex((o) => classifyOutputScript(o.script).type !== 'nulldata');
  for (const o of outputs) if (classifyOutputScript(o.script).type !== 'nulldata' && o.value < dust) throw new TransparentError('dust', t('An amount is too small to send (under 0.00001 FIRO).'));
  const n = utxos.length;
  const fC = feeForSize(estimateSize(n, [...scripts, changeScript]), feePerKb, minRelayFeePerKb);
  const fN = feeForSize(estimateSize(n, scripts), feePerKb, minRelayFeePerKb);
  const outs = outputs.map((o) => ({ ...o }));
  if (subtractFee) {
    if (payIndex < 0) throw new TransparentError('build', t('There is no output to take the fee from.'));
    if (sum < target) throw new TransparentError('insufficient', t('The chosen coins are less than the amount.'), { needed: target, available: sum });
    const left = sum - target;
    const f = left >= dust ? fC : fN;
    outs[payIndex].value -= f;
    if (outs[payIndex].value < dust) throw new TransparentError('dust', t('After the fee the amount is too small to send.'));
    if (left >= dust) outs.push({ script: changeScript, value: left, change: true });
    return { inputs: utxos.slice(), outputs: outs, fee: left >= dust ? f : f + left, change: left >= dust ? left : 0n, size: estimateSize(n, outs.map((o) => o.script)) };
  }
  if (sum >= target + fC && sum - target - fC >= dust) {
    outs.push({ script: changeScript, value: sum - target - fC, change: true });
    return { inputs: utxos.slice(), outputs: outs, fee: fC, change: sum - target - fC, size: estimateSize(n, outs.map((o) => o.script)) };
  }
  if (sum >= target + fN) return { inputs: utxos.slice(), outputs: outs, fee: sum - target, change: 0n, size: estimateSize(n, scripts) };
  throw new TransparentError('insufficient', t('The chosen coins do not cover the amount and the fee.'), { needed: target + fN, available: sum });
}

/**
 * Transactions that pay address `to` (from its ElectrumX history, newest
 * first), each with the value paid to `to` and whether any input came from
 * address `from` (the server's verbose input addresses). Fetches every
 * transaction in `to`'s history at or above `minHeight` (mempool included).
 * Asking about `to` tells the server you care about it.
 */
export async function paymentsTo({ client, net, to, from = null, minHeight = 0 }) {
  const toScript = addressToScript(to, net);
  const hist = (await client.getHistory(scriptHash(toScript))).filter((h) => h.height <= 0 || h.height >= minHeight);
  const res = await client.batch(hist.map((h) => ['blockchain.transaction.get', [h.tx_hash, true]]));
  const out = [];
  hist.forEach((h, i) => {
    const v = res[i];
    if (v instanceof Error || !v?.hex) return;
    const d = decodeTx(v.hex, net);
    if (d.txid !== h.tx_hash) return;
    const value = d.vout.filter((o) => bytesToHex(o.script) === bytesToHex(toScript)).reduce((s, o) => s + o.value, 0n);
    const fromMatches = from ? (v.vin ?? []).some((x) => x && x.address === from) : null;
    out.push({ txid: d.txid, height: h.height > 0 ? h.height : null, value, fromMatches, decoded: d });
  });
  out.sort((a, b) => (a.height === null ? -1 : b.height === null ? 1 : b.height - a.height));
  return out;
}

