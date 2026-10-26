// The hash Firo gives a Spark anonymity set, computed from the coins themselves (audit D-09: the
// wallet passed the server's `setHash` to the spend with the server's coins and checked the proof
// against that same pair, so a server could hand over fewer or other coins under the real hash and
// still have the payment built; whether it was built told the server whether this wallet's coin was
// among the ones it kept).
//
// How firod makes it (src/spark/state.cpp, ConnectBlockSpark): every block that adds coins to the
// newest group G sets
//
//     hash(G, block) = SHA256d( hash(G, the group's previous block with coins) ‖ coin_1 ‖ … ‖ coin_k )
//
// over that block's new coins, serialized (the coin as a set entry carries it, without the tx hash
// and serial context firod appends there), in the block's own order. Where the group has no
// previous hash:
//   - a new group G > 1 starts from group G−1's last hash (GetAnonymitySetHash is empty for G, so
//     firod falls back to G−1's). Its set begins with the ≥ 8,000 coins it carries over from G−1's
//     newest blocks (ZC_SPARK_SET_START_SIZE); those are G−1's blocks, hashed in G−1's chain, not G's;
//   - group 1 starts from nothing, and (before Chaum V2, which is all of group 1) the lookup stops
//     before a group's first block: group 1's first block is in no hash, and its second block
//     hashes its own coins alone.
//
// Measured against Firo's servers on 2026-10-12, both exactly:
//   group 11: 19,322 coins (8,000 carried over, 11,322 in 2,765 blocks) → the reported setHash, from
//             group 10's last hash;
//   group 1:  31,994 coins in 12,939 blocks (the first, 5 coins at height 819,301, left out).
//
// The blocks: a set entry does not say which block its coin is in, so the coins' transactions are
// looked up in the blocks' transaction lists (blockchain.block.txids, the same answer for every
// wallet). Coins of one block are not grouped by transaction (a transaction's coins can be split by
// another's), so block boundaries come from the heights, never from changes of txid.

import { sha256d, concatBytes } from './bytes.js';
import { t } from '../i18n.js';

export class SetHashError extends Error {
  constructor(message) {
    super(message);
    this.code = 'set-order';
  }
}

/** One block's step: SHA256d(previous hash ‖ the block's coins, serialized, in the block's order). */
export function setHashStep(prev, coins) {
  return sha256d(concatBytes(prev, ...coins));
}

/**
 * Coins of a set, oldest first as Campfire stores them ({txid, body}), and the block of each known
 * transaction → the blocks they fill, oldest first, each block's coins in firod's order. Campfire
 * keeps a set as the reverse of the server's list (newest block first, each block's coins in
 * order), so a block's coins come back reversed here. Stops at the first coin whose block is not
 * known; every coin after it must be unknown too (a set in chain order). Throws SetHashError when
 * the coins are not in the order of their blocks, which no real set can be.
 * -> {blocks: [{height, coins: [body]}], placed}
 */
export function blocksOf(coins, heightOf) {
  const blocks = [];
  let placed = 0;
  while (placed < coins.length && heightOf.has(coins[placed].txid)) {
    const h = heightOf.get(coins[placed].txid);
    const last = blocks[blocks.length - 1];
    if (last && h === last.height) last.coins.push(coins[placed].body);
    else if (last && h < last.height) throw new SetHashError(t('The coins are not in the order of their blocks.'));
    else blocks.push({ height: h, coins: [coins[placed].body] });
    placed++;
  }
  for (let i = placed; i < coins.length; i++) if (heightOf.has(coins[i].txid)) throw new SetHashError(t('The coins are not in the order of their blocks.'));
  for (const b of blocks) b.coins.reverse();
  return { blocks, placed };
}

/**
 * Carries a set hash on over more coins of the set: reads the transaction lists of the blocks after
 * `height` (up to `tipHeight`, at most `maxHeights` of them, stopping once every coin is placed),
 * then hashes the whole blocks found.
 *
 * @param {object} o
 * @param {Uint8Array} o.hash        the hash so far (empty: none yet)
 * @param {number} o.height          the block it was at; the coins below are in later blocks
 * @param {{txid: string, body: Uint8Array}[]} o.coins  the next coins of the set, oldest first
 * @param {number} o.tipHeight       read no further than this
 * @param {(heights: number[]) => Promise<Map<number, string[]>>} o.blockTxids  every txid of each block
 * @param {number} [o.maxHeights]    blocks to read at most in this call
 * @param {boolean} [o.skipFirst]    group 1: its first block is in no hash
 * @returns {Promise<{hash: Uint8Array, height: number, placed: number, skipFirst: boolean,
 *   checkpoints: {placed: number, hash: Uint8Array, height: number}[], read: number, reachedTip: boolean}>}
 *   `placed` coins are in the result; checkpoints: the hash after each block (placed so far).
 */
export async function extendSetHash({ hash, height, coins, tipHeight, blockTxids, maxHeights = Infinity, skipFirst = false, batch = 500 }) {
  const need = new Set(coins.map((c) => c.txid));
  const heightOf = new Map();
  let h = height + 1;
  let read = 0;
  while (h <= tipHeight && read < maxHeights && heightOf.size < need.size) {
    const n = Math.min(tipHeight - h + 1, maxHeights - read, batch * 4);
    const heights = Array.from({ length: n }, (_, i) => h + i);
    // A few batches at a time: the connection answers them in turn.
    const parts = [];
    for (let i = 0; i < heights.length; i += batch) parts.push(heights.slice(i, i + batch));
    const answers = await Promise.all(parts.map((p) => blockTxids(p)));
    for (const m of answers) {
      for (const [bh, ids] of m) for (const item of ids) if (need.has(item)) heightOf.set(item, bh);
    }
    h += n;
    read += n;
  }
  const { blocks, placed } = blocksOf(coins, heightOf);
  let x = hash;
  let first = skipFirst;
  const checkpoints = [];
  let count = 0;
  for (const b of blocks) {
    count += b.coins.length;
    if (first) first = false;
    else x = setHashStep(x, b.coins);
    checkpoints.push({ placed: count, hash: x, height: b.height });
  }
  // All placed: the next coins of the set will be in blocks after the newest one here. Otherwise
  // the next coin is in a block after the last one read.
  const at = placed === coins.length ? (blocks.length ? blocks[blocks.length - 1].height : height) : h - 1;
  return { hash: x, height: at, placed, skipFirst: first, checkpoints, read, reachedTip: h > tipHeight };
}
