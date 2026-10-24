// Spark sync, data layer only: downloads and keeps the public data every
// Spark wallet needs, and nothing about this wallet. The Spark cryptography
// (is this coin mine?) is the spark client's job; this module hands it bytes.
//
//   Anonymity sets: per coin group, `spark.getsparkanonymitysetmeta` then
//   `spark.getsparkanonymitysetsector` in sectors of 1,500 coins. The server
//   lists a group newest block first, so an update only fetches the first
//   (newSize - oldSize) entries. Stored oldest first (the reverse of the
//   server's list, as Campfire's cache keeps it; a spend hands the library
//   the server's order again, newest first, as Campfire does on read),
//   as packed bytes in chunks; a download in progress is pinned to its block
//   hash so it can resume after the app was closed; a shrinking set or a
//   newest coin that no longer matches (a reorg) re-fetches the group.
//
//   Used linking tags: `spark.getusedcoinstagstxhashes(startNumber)` returns
//   every tag after the first startNumber; fetched with a small overlap so a
//   short reorg cannot slip one past, de-duplicated, and kept as
//   lTagHash ‖ txid (SHA256d("tag_hash\0" ‖ tag), as libspark's identify
//   reports it for each coin) — 64 bytes a tag.
//
//   Mempool: `spark.getmempoolsparktxids` and `spark.getmempoolsparktxs` for
//   the ones not seen yet; memory only.
//
//   Set hashes (audit D-09): verifyGroup() recomputes a group's hash from the
//   coins held (spark_sethash.js) and compares it with the one the server
//   reported, placing the coins in their blocks with blockchain.block.txids
//   (the same blocks for every wallet that checks the group).
//
// Privacy: everything here is the same download for every wallet; no own
// txid, coin or address is ever sent. Fetching one's own transactions by id
// would tell the server which coins are whose (research §3.6) and is not done
// here.

import { base64ToBytes, bytesToBase64, hashToHex, bytesToHex, hexToBytes, Reader, compactSize, concatBytes, equalBytes } from './bytes.js';
import { lTagHash } from './tx.js';
import { extendSetHash, SetHashError } from './spark_sethash.js';
import { t } from '../i18n.js';

export const SECTOR_SIZE = 1500;
/** Tags re-read on each update (about 3 KB): Firo's ChainLocks keep reorgs to a block or two. */
export const TAG_OVERLAP = 30;
const TAG_CHUNK = 10000;
/** Store layout: set/<group>/meta, set/<group>/c/<seq>, tags/meta, tags/c/<seq>. */
const TAGS_META = 'tags/meta';

export class SparkSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'server' | 'store' | 'reorg'
  }
}

// ---------------------------------------------------------------- coin entries

/**
 * One anonymity-set entry from the server, base64 [coin, txHash, context] →
 * {coin, txHash, context}. `coin` is the first element exactly as the server
 * sent it (firod serializes the coin together with its tx hash and context
 * there; libspark reads the coin from the front and ignores the rest).
 */
/** A Spark coin is a few hundred bytes; its serial context, a few kB. Larger is not a coin (audit D-13). */
export const MAX_COIN_BYTES = 4096;
export const MAX_CONTEXT_BYTES = 1 << 20;
/** No group holds more coins than this (Firo's groups close well before). */
export const MAX_SET_SIZE = 1 << 20;
/** A group's first coins searched for the newest coin of the group before (firod carries over ≥ 8,000). */
const CARRY_SEARCH = 16384;
/** Hashes kept of a group's newest blocks, to compare with a server a little behind (audit D-09). */
export const SET_CHECKPOINTS = 64;

export function decodeSetEntry(e) {
  const out = { coin: base64ToBytes(e[0]), txHash: base64ToBytes(e[1]), context: base64ToBytes(e[2]) };
  // The coin field may end with its tx hash and serial context (as packCoins recognises); the
  // limit is on the coin itself. Serial contexts reach ~65 kB on mainnet (big spends).
  const body = coinBody(out).length;
  if (body === 0 || body > MAX_COIN_BYTES || out.context.length > MAX_CONTEXT_BYTES) throw new SparkSyncError('server', t('The server sent a coin of an impossible size.'));
  return out;
}

/**
 * The serialized coin of a set entry: `coin` without the tx hash and serial context firod appends
 * to it there. What firod hashes into the set hash (spark_sethash.js).
 */
export function coinBody({ coin, txHash, context }) {
  const suffix = concatBytes(txHash, compactSize(context.length), context);
  return coin.length > suffix.length && equalBytes(coin.subarray(coin.length - suffix.length), suffix) ? coin.subarray(0, coin.length - suffix.length) : coin;
}

/** An id for one download of a set (M2). */
function newGen() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A set's description is believed only within reason: no billion-coin group (audit D-13). */
function checkMeta(meta) {
  if (!meta || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > MAX_SET_SIZE) throw new SparkSyncError('server', t('The server described a set of an impossible size.'));
  return meta;
}

/** {coin, txHash, context}[] → bytes. The repeated tx hash and context at the end of `coin` are stored once. */
export function packCoins(entries) {
  const parts = [];
  for (const { coin, txHash, context } of entries) {
    if (txHash.length !== 32) throw new SparkSyncError('server', t('A coin\'s tx hash is not 32 bytes.'));
    const suffix = concatBytes(txHash, compactSize(context.length), context);
    const dup = coin.length > suffix.length && equalBytes(coin.subarray(coin.length - suffix.length), suffix);
    const body = dup ? coin.subarray(0, coin.length - suffix.length) : coin;
    parts.push(Uint8Array.of(dup ? 1 : 0), compactSize(body.length), body, txHash, compactSize(context.length), context);
  }
  return concatBytes(...parts);
}

/** bytes → {coin, txHash, context}[] with `coin` rebuilt byte for byte as the server sent it. */
export function unpackCoins(bytes) {
  const r = new Reader(bytes);
  const out = [];
  while (r.remaining > 0) {
    const flags = r.u8();
    const body = r.varbytes(1 << 20);
    const txHash = r.bytes(32);
    const context = r.varbytes(1 << 24); // real serial contexts exceed 64 KB (65,641 bytes seen in group 11)
    const coin = flags & 1 ? concatBytes(body, txHash, compactSize(context.length), context) : body;
    out.push({ coin, txHash, context });
  }
  return out;
}

/** {lTagHash (hex), txid (hex)}[] ↔ 64-byte records (both 32 bytes, display order). */
export function packTags(items) {
  const out = new Uint8Array(items.length * 64);
  items.forEach((tx, i) => {
    out.set(hexToBytes(tx.lTagHash), i * 64);
    out.set(hexToBytes(tx.txid), i * 64 + 32);
  });
  return out;
}

export function unpackTags(bytes) {
  const out = [];
  for (let o = 0; o + 64 <= bytes.length; o += 64) out.push({ lTagHash: bytesToHex(bytes.subarray(o, o + 32)), txid: bytesToHex(bytes.subarray(o + 32, o + 64)) });
  return out;
}

const pad = (n) => String(n).padStart(8, '0');

// ---------------------------------------------------------------- the syncer

export class SparkSync {
  /**
   * @param {object} o
   * @param {import('./electrum.js').ElectrumClient} o.client
   * @param {{get,put,del,keys}} o.store  where the cache lives (may be shared by wallets of one network)
   */
  constructor({ client, store, sectorSize = SECTOR_SIZE, tagOverlap = TAG_OVERLAP }) {
    this.client = client;
    this.store = store;
    this.sectorSize = sectorSize;
    this.tagOverlap = tagOverlap;
    this.mempool = new Map(); // txid → {coins, serialContext, lTagHashes, isLocked, isMint}
  }

  // ------------------------------------------------------------ sets

  async latestGroupId() {
    return this.client.sparkLatestCoinId();
  }

  /** The stored state of a group: {groupId, blockHash, setHash, size, chunks, pending} or null. */
  async groupState(groupId) {
    return (await this.store.get(`set/${groupId}/meta`)) ?? null;
  }

  async _saveGroup(st) {
    st.updatedAt = Math.floor(Date.now() / 1000);
    await this.store.put(`set/${st.groupId}/meta`, st);
  }

  /** A pass that adds up: a later one that does not may begin again once (its `again` mark goes). */
  async _matched(key, v) {
    if (!v.again) return;
    delete v.again;
    await this.store.put(key, v);
  }

  async dropGroup(groupId) {
    for (const k of await this.store.keys(`set/${groupId}/`)) await this.store.del(k);
  }

  /**
   * Brings one group up to date. onProgress({groupId, done, total}) counts
   * coins fetched in this run. Returns {groupId, size, added, blockHash,
   * setHash, refetched}.
   */
  async syncGroup(groupId, { onProgress } = {}) {
    // Every download of a set from its first coin has an id of its own (fifth audit M2): a wallet that
    // last looked at the set under another id (or none) looks at it whole. The cache is shared by every
    // wallet on the device, so no wallet's look can clear it for another, and nothing is lost if the
    // download is cut short.
    let st = (await this.groupState(groupId)) ?? { groupId, blockHash: null, setHash: null, size: 0, nextSeq: 0, chunks: [], pending: null, gen: newGen() };
    let refetched = false;
    const sizeBefore = st.size;
    let meta = checkMeta(await this.client.sparkSetMeta(groupId));

    // An update left half done by an earlier run is finished first (pinned to its own block),
    // then the group is brought from there to the newest block.
    for (let round = 0; round < 4; round++) {
      if (!st.pending) {
        if (st.blockHash === meta.blockHash && st.size === meta.size) break; // up to date
        let consistent = meta.size >= st.size;
        if (consistent && st.size > 0) consistent = await this._newestStillThere(groupId, st, meta);
        if (!consistent) {
          await this.dropGroup(groupId);
          st = { groupId, blockHash: null, setHash: null, size: 0, nextSeq: 0, chunks: [], pending: null, gen: newGen() };
          refetched = true;
        }
        const count = meta.size - st.size;
        const sectors = Math.ceil(count / this.sectorSize);
        st.pending = { blockHash: meta.blockHash, setHash: meta.setHash, size: meta.size, from: st.size, count, sectors, next: 0, seqBase: st.nextSeq, seqs: [] };
        await this._saveGroup(st);
      }
      try {
        await this._fetchPending(st, onProgress);
      } catch (e) {
        // The pinned block is no longer in the chain: start this update again from the new tip.
        if (e.code === 'server' && /blockHash|anonymity set/i.test(e.message)) {
          for (const seq of st.pending.seqs) await this.store.del(`set/${groupId}/c/${pad(seq)}`);
          st.pending = null;
          await this._saveGroup(st);
          meta = checkMeta(await this.client.sparkSetMeta(groupId));
          continue;
        }
        throw e;
      }
    }
    return { groupId, size: st.size, added: refetched ? st.size : st.size - sizeBefore, blockHash: st.blockHash, setHash: st.setHash, refetched, gen: st.gen ?? null };
  }

  /** Whether our newest stored coin is still at its place in the server's list as of `meta`. */
  async _newestStillThere(groupId, st, meta) {
    const last = st.chunks[st.chunks.length - 1];
    if (!last) return true;
    const stored = unpackCoins(await this.store.get(`set/${groupId}/c/${pad(last.seq)}`));
    const newest = stored[stored.length - 1];
    const at = meta.size - st.size; // its index in the server's newest-first list
    const got = await this.client.sparkSetSector(groupId, meta.blockHash, at, at + 1);
    if (got.length !== 1) return false;
    const e = decodeSetEntry(got[0]);
    return equalBytes(e.coin, newest.coin) && equalBytes(e.txHash, newest.txHash);
  }

  async _fetchPending(st, onProgress) {
    const p = st.pending;
    const g = st.groupId;
    onProgress?.({ groupId: g, done: Math.min(p.next * this.sectorSize, p.count), total: p.count });
    while (p.next < p.sectors) {
      const start = p.next * this.sectorSize;
      const end = Math.min(p.count, start + this.sectorSize);
      const raw = await this.client.sparkSetSector(g, p.blockHash, start, end);
      if (raw.length !== end - start) throw new SparkSyncError('server', t('The server sent {length} coins instead of {n}.', { length: raw.length, n: end - start }));
      // Oldest first: sector i of the newest-first list lands before sector i-1.
      const seq = p.seqBase + (p.sectors - 1 - p.next);
      const entries = raw.map(decodeSetEntry).reverse();
      await this.store.put(`set/${g}/c/${pad(seq)}`, packCoins(entries));
      p.seqs.push(seq);
      p.next++;
      await this._saveGroup(st);
      onProgress?.({ groupId: g, done: end, total: p.count });
    }
    // Done: the new chunks follow the old ones, oldest first.
    const added = [];
    let from = p.from;
    for (let i = p.sectors - 1; i >= 0; i--) {
      const count = Math.min(this.sectorSize, p.count - i * this.sectorSize);
      added.push({ seq: p.seqBase + (p.sectors - 1 - i), count, from });
      from += count;
    }
    st.chunks.push(...added);
    st.nextSeq = p.seqBase + p.sectors;
    st.blockHash = p.blockHash;
    st.setHash = p.setHash;
    st.size = p.size;
    st.pending = null;
    await this._saveGroup(st);
  }

  /**
   * Coins of a group, oldest first, from index `from` (up to, not including, `to`):
   * [{index, coin, txHash, context}]. `txHash` is in internal byte order; `txid` gives it as
   * display hex.
   */
  async coins(groupId, { from = 0, to = Infinity } = {}) {
    const st = await this.groupState(groupId);
    if (!st) return [];
    const out = [];
    for (const c of st.chunks) {
      if (c.from + c.count <= from || c.from >= to) continue;
      const entries = unpackCoins(await this.store.get(`set/${groupId}/c/${pad(c.seq)}`));
      entries.forEach((e, i) => {
        const index = c.from + i;
        if (index >= from && index < to) out.push({ index, groupId, ...e, txid: hashToHex(e.txHash) });
      });
    }
    return out;
  }

  /** What the spend proof needs for one group: {groupId, blockHash, setHash, size, coins} (coins oldest first). */
  async anonymitySet(groupId) {
    const st = await this.groupState(groupId);
    if (!st || st.pending || !st.blockHash) throw new SparkSyncError('store', t('Spark group {groupId} is not downloaded yet.', { groupId }));
    return { groupId, blockHash: st.blockHash, blockHashHex: hashToHex(base64ToBytes(st.blockHash)), setHash: st.setHash, size: st.size, coins: await this.coins(groupId) };
  }

  // ------------------------------------------------------------ set hashes

  /**
   * How far a group's hash has been recomputed: {size, hash, startHash, height, carry, skipFirst,
   * unhashed (group 1: the coins of its first block, which no hash covers), checkpoints:
   * [{size, hash, height}]} (hashes base64), {bad: {size, setHash}}, or null.
   */
  async verifiedState(groupId) {
    const v = (await this.store.get(`set/${groupId}/verified`)) ?? null;
    // A check begun again that has not got going yet is no state of a set (sixth audit hardening).
    return v && v.restart ? null : v;
  }

  /**
   * Recomputes a group's set hash from the coins held, the way firod makes it (spark_sethash.js),
   * and compares it with the hash the server reported for them: the hash a payment over this set
   * commits to (audit D-09). Progress is kept (set/<group>/verified, beside what syncGroup writes,
   * never over it), so a later call carries on, and a set that only grew is checked over its new
   * coins alone. Network errors are thrown.
   *
   * -> {state, groupId, size, setHash, read (blocks read)}; state:
   *    'match'    the coins held give exactly the reported hash;
   *    'mismatch' they do not, are not in the order of their blocks, or the group does not begin
   *               with the newest coins of the group before it: this is not the network's set;
   *    'partial'  not every coin placed yet (`maxHeights` reached, or a coin's block is past
   *               `tipHeight`): call again.
   */
  /**
   * One check of a group at a time (third audit H2: the background proof and a payment's check of the
   * same group at once could write over each other's progress, and say for a moment that two nodes
   * disagreed). The rest as _verifyGroup.
   */
  async verifyGroup(groupId, opts = {}) {
    this._verifying ??= new Map();
    const before = this._verifying.get(groupId) ?? Promise.resolve();
    let done;
    const mine = new Promise((r) => (done = r));
    const turn = before.then(() => mine);
    this._verifying.set(groupId, turn);
    await before.catch(() => {});
    try {
      return await this._verifyGroup(groupId, opts);
    } finally {
      done();
      if (this._verifying.get(groupId) === turn) this._verifying.delete(groupId);
    }
  }

  async _verifyGroup(groupId, { tipHeight, maxHeights = Infinity, blockTxids = (hs) => this.client.blockTxids(hs), _again = false } = {}) {
    const st = await this.groupState(groupId);
    if (!st || st.pending || !st.blockHash) throw new SparkSyncError('store', t('Spark group {groupId} is not downloaded yet.', { groupId }));
    const key = `set/${groupId}/verified`;
    const result = (state, read = 0) => ({ state, groupId, size: st.size, setHash: st.setHash, read });
    const bad = async (read = 0) => {
      await this.store.put(key, { bad: { size: st.size, setHash: st.setHash } });
      return result('mismatch', read);
    };
    if (st.size === 0) return result('match');
    let v = (await this.store.get(key)) ?? null;
    // A pass begun again, kept as such even before it got going (fifth audit L1: the mark was set only
    // once the new pass had started, so one that failed to start forgot it).
    let again = _again;
    let againAt = null;
    if (v && v.restart) {
      again = true;
      againAt = v.at ?? null;
      v = null;
    }
    if (v && v.bad) {
      if (v.bad.size === st.size && v.bad.setHash === st.setHash) return result('mismatch');
      v = null; // the set changed since: from the start again
    }
    if (v && v.size > st.size) v = null;
    const fromStart = !v;
    if (!v) {
      try {
        v = await this._hashStart(groupId, st);
        // A pass begun again after one that did not add up: a mismatch at its end is final, however
        // many parts it takes (fourth audit N3: in parts, every finished pass began again, and a
        // node whose set never adds up was read without end and never said so).
        if (again) {
          v.again = true;
          v.againAt = againAt ?? st.blockHash; // the set's block when it began again (L2)
        }
      } catch (e) {
        if (e instanceof SetHashError) return bad();
        throw e;
      }
      await this.store.put(key, v);
    }
    let read = 0;
    if (v.size < st.size) {
      const coins = (await this.coins(groupId, { from: v.size, to: st.size })).map((c) => ({ txid: c.txid, body: coinBody(c) }));
      let r;
      try {
        r = await extendSetHash({ hash: base64ToBytes(v.hash), height: v.height, coins, tipHeight, blockTxids, maxHeights, skipFirst: !!v.skipFirst });
      } catch (e) {
        if (!(e instanceof SetHashError)) throw e;
        r = null;
      }
      if (r) {
        read = r.read;
        const base = v.size;
        const checkpoints = [...(v.checkpoints ?? []), ...r.checkpoints.map((c) => ({ size: base + c.placed, hash: bytesToBase64(c.hash), height: c.height }))].slice(-SET_CHECKPOINTS);
        // Group 1's first block is in no hash: how many coins that is, for the second server to compare one by one.
        const unhashed = v.skipFirst && !r.skipFirst && r.checkpoints.length ? r.checkpoints[0].placed : v.unhashed ?? 0;
        v = { ...v, size: base + r.placed, hash: bytesToBase64(r.hash), height: r.height, skipFirst: r.skipFirst, unhashed, checkpoints };
        await this.store.put(key, v);
        if (v.size < st.size) return result('partial', read);
      }
      if (r && v.hash === st.setHash) return (await this._matched(key, v), result('match', read));
    } else if (v.hash === st.setHash) {
      return (await this._matched(key, v), result('match'));
    }
    // Not the hash reported. Carried on from an earlier check: once more from the very start (the
    // newest blocks may have been replaced), else this set is not the network's.
    // Once more from the start: when this pass did not itself begin again, and either no pass did or
    // the set has moved on to another block since (fifth audit L2: two honest reorganisations in one
    // pass made it final). Each beginning again needs a new block, so it never runs without end.
    if (!fromStart && !again && (!v.again || v.againAt !== st.blockHash)) {
      await this.store.put(key, { restart: true, at: st.blockHash });
      const r2 = await this._verifyGroup(groupId, { tipHeight, maxHeights: Math.max(0, maxHeights - read), blockTxids, _again: true });
      return { ...r2, read: r2.read + read };
    }
    return bad(read);
  }

  /**
   * Where a group's hash begins (spark_sethash.js): group 1 from nothing, its first block left out;
   * group G > 1 from group G-1's last hash, after the coins it carries over from G-1 (found as the
   * group's first coins up to G-1's newest coin, and when G-1 is held, compared with its newest
   * coins one by one). -> {size, hash, height, carry, skipFirst, checkpoints}; throws SetHashError.
   */
  async _hashStart(groupId, st) {
    if (groupId <= 1) {
      // From the block of the group's first coin (the same coin for every wallet).
      const [c0] = await this.coins(groupId, { from: 0, to: 1 });
      return { size: 0, hash: '', startHash: '', height: (await this._txHeight(c0.txid)) - 1, carry: 0, skipFirst: true, checkpoints: [] };
    }
    const prev = await this.groupState(groupId - 1);
    let prevHash;
    let prevNewest;
    let prevTail = null;
    if (prev && !prev.pending && prev.blockHash && prev.size > 0) {
      prevHash = prev.setHash;
      prevTail = await this.coins(groupId - 1, { from: Math.max(0, prev.size - CARRY_SEARCH) });
      prevNewest = prevTail[prevTail.length - 1];
    } else {
      const m = checkMeta(await this.client.sparkSetMeta(groupId - 1));
      prevHash = m.setHash;
      const raw = await this.client.sparkSetSector(groupId - 1, m.blockHash, 0, 1);
      if (raw.length !== 1) throw new SparkSyncError('server', t('The server sent no newest coin of group {n}.', { n: groupId - 1 }));
      prevNewest = decodeSetEntry(raw[0]);
    }
    const head = await this.coins(groupId, { from: 0, to: Math.min(st.size, CARRY_SEARCH) });
    const target = coinBody(prevNewest);
    const at = head.findIndex((c) => equalBytes(coinBody(c), target));
    if (at < 0 || at + 1 >= st.size) throw new SetHashError(t('Group {groupId} does not begin with the newest coins of group {n}.', { groupId, n: groupId - 1 }));
    const carry = at + 1;
    if (prevTail) {
      const tail = prevTail.slice(-carry);
      if (tail.length !== carry || tail.some((c, i) => !equalBytes(coinBody(c), coinBody(head[i])))) throw new SetHashError(t('Group {groupId} does not carry over the newest coins of group {n}.', { groupId, n: groupId - 1 }));
    }
    // startHash: where this chain began, which a second server must confirm as G-1's last hash; a
    // server could otherwise move the start into G's own blocks, past coins never hashed here.
    // G's own blocks come after G-1's last block: the block of its newest coin, a coin at the same
    // place for every wallet (no question about this wallet's coins).
    return { size: carry, hash: prevHash, startHash: prevHash, height: await this._txHeight(head[carry - 1].txid), carry, checkpoints: [] };
  }

  /** The block a transaction is in, as the server says (only a starting point: the hash decides). */
  async _txHeight(txid) {
    // Only the height is read (as the anchors are: _placeRestored in backend.js).
    const v = await this.client.request('blockchain.transaction.get', [txid, true]);
    if (!v || !Number.isSafeInteger(v.height) || v.height <= 0) throw new SparkSyncError('server', t('The server gave no block for a coin of the set.'));
    return v.height;
  }

  // ------------------------------------------------------------ used tags

  async tagState() {
    return (await this.store.get(TAGS_META)) ?? null;
  }

  /**
   * Fetches the used tags the server lists after our cursor. A wallet that
   * has never synced tags starts at `startAt` (0 for a restore; a recent
   * count for a new wallet, which cannot have spent anything before it
   * existed). onProgress({done, total}). Returns {added, count}.
   */
  async syncTags({ startAt = 0, onProgress } = {}) {
    let st = await this.tagState();
    if (st && startAt < st.firstCursor) {
      // A restore needs tags from before where this cache began: start the cache over.
      for (const k of await this.store.keys('tags/')) await this.store.del(k);
      st = null;
    }
    st ??= { cursor: startAt, firstCursor: startAt, stored: 0, nextSeq: 0, chunks: [] };
    const from = Math.max(st.firstCursor, st.cursor - (st.stored > 0 ? this.tagOverlap : 0));
    onProgress?.({ done: 0, total: null });
    const raw = await this.client.sparkUsedTags(from);
    // The overlap: entries we already hold are skipped.
    const recent = new Set();
    if (st.stored > 0 && from < st.cursor) {
      for (const item of await this._lastTags(st, st.cursor - from)) recent.add(item.lTagHash);
    }
    const items = [];
    for (const [tagB64, txB64] of raw) {
      const tag = base64ToBytes(tagB64);
      const tx = base64ToBytes(txB64);
      if (tag.length !== 34 || tx.length !== 32) throw new SparkSyncError('server', t('A used tag entry has the wrong size.'));
      const h = lTagHash(tag);
      if (recent.has(h)) continue;
      recent.add(h);
      items.push({ lTagHash: h, txid: hashToHex(tx) });
    }
    for (let i = 0; i < items.length; i += TAG_CHUNK) {
      const part = items.slice(i, i + TAG_CHUNK);
      const seq = st.nextSeq++;
      await this.store.put(`tags/c/${pad(seq)}`, packTags(part));
      st.chunks.push({ seq, count: part.length, from: st.stored });
      st.stored += part.length;
    }
    st.cursor = from + raw.length;
    st.updatedAt = Math.floor(Date.now() / 1000);
    await this.store.put(TAGS_META, st);
    onProgress?.({ done: raw.length, total: raw.length });
    return { added: items.length, count: st.stored, cursor: st.cursor };
  }

  async _lastTags(st, n) {
    const out = [];
    for (let i = st.chunks.length - 1; i >= 0 && out.length < n; i--) {
      const items = unpackTags(await this.store.get(`tags/c/${pad(st.chunks[i].seq)}`));
      out.unshift(...items);
    }
    return out.slice(-n);
  }

  /** Stored tags from position `from` (in our store), oldest first: [{index, lTagHash, txid}]. */
  async tags({ from = 0 } = {}) {
    const st = await this.tagState();
    if (!st) return [];
    const out = [];
    for (const c of st.chunks) {
      if (c.from + c.count <= from) continue;
      unpackTags(await this.store.get(`tags/c/${pad(c.seq)}`)).forEach((item, i) => {
        if (c.from + i >= from) out.push({ index: c.from + i, ...item });
      });
    }
    return out;
  }

  /**
   * Which of `lTagHashes` (hex) are used: Map lTagHash → spending txid. Scans the stored tags once,
   * those at store positions [from, to).
   */
  async findUsed(lTagHashes, { from = 0, to = Infinity } = {}) {
    const want = new Set(lTagHashes);
    const found = new Map();
    if (want.size === 0 || to <= from) return found;
    const st = await this.tagState();
    if (!st) return found;
    for (const c of st.chunks) {
      if (c.from + c.count <= from || c.from >= to) continue;
      const b = await this.store.get(`tags/c/${pad(c.seq)}`);
      for (let o = 0, i = c.from; o + 64 <= b.length; o += 64, i++) {
        if (i < from || i >= to) continue;
        const h = bytesToHex(b.subarray(o, o + 32));
        if (want.has(h)) found.set(h, bytesToHex(b.subarray(o + 32, o + 64)));
      }
    }
    return found;
  }

  // ------------------------------------------------------------ mempool

  /**
   * Refreshes the Spark transactions in the mempool: fetches the data of new
   * ones, forgets those that left. Returns {txs (Map), added: [txid], removed: [txid]}.
   */
  async syncMempool() {
    const ids = (await this.client.sparkMempoolTxids()).map((b) => hashToHex(base64ToBytes(b)));
    const now = new Set(ids);
    const removed = [];
    for (const txid of this.mempool.keys()) {
      if (!now.has(txid)) {
        this.mempool.delete(txid);
        removed.push(txid);
      }
    }
    const fresh = ids.filter((item) => !this.mempool.has(item));
    const added = [];
    for (let i = 0; i < fresh.length; i += 50) {
      const part = fresh.slice(i, i + 50);
      const res = await this.client.sparkMempoolTxs(part);
      for (const [key, v] of Object.entries(res)) {
        const txid = /^[0-9a-f]{64}$/.test(key) ? key : hashToHex(base64ToBytes(key));
        const lTags = v['lTags '] ?? v.lTags ?? [];
        const isMint = lTags.length === 1 && lTags[0] === 'MintTX';
        this.mempool.set(txid, {
          txid,
          isMint,
          lTagHashes: isMint ? [] : lTags.map((item) => lTagHash(base64ToBytes(item))),
          serialContext: base64ToBytes((v.serial_context ?? [''])[0] ?? ''),
          coins: (v.coins ?? []).map((c) => base64ToBytes(c)),
          isLocked: v.isLocked === true,
        });
        added.push(txid);
      }
    }
    return { txs: this.mempool, added, removed };
  }

  // ------------------------------------------------------------ housekeeping

  /** Forget every set and every tag (Settings → clear Spark cache). */
  async clear() {
    for (const k of await this.store.keys('set/')) await this.store.del(k);
    for (const k of await this.store.keys('tags/')) await this.store.del(k);
    this.mempool.clear();
  }

  /** Bytes held by the stored sets and tags (packed). */
  async cacheBytes() {
    let n = 0;
    for (const k of [...(await this.store.keys('set/')), ...(await this.store.keys('tags/'))]) {
      const v = await this.store.get(k);
      if (v instanceof Uint8Array) n += v.length;
    }
    return n;
  }
}

