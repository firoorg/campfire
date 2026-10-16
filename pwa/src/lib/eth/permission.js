// What permission (ERC-20 allowance) a swap needs, decided in ONE place for every path that can offer
// or sign one: Uniswap's first check behind Swap, the Allow sheet as it opens, after an earlier
// permission settled and before every retry, and PancakeSwap's Allow (release audit 0.1.5, final).
//
// Everything is read at one block: the server's newest, once it is no older than the block that
// confirmed (or showed in effect) this wallet's newest permission for that token and spender. A
// load-balanced server answers each request from some backend; one behind that block would show the
// permission missing and offer a second one, so it is waited for a few times, then refused: the
// decision either comes back fresh and block-consistent, or throws, and the screens offer "Allow"
// only on a fresh decision ("Couldn't check the permission… Nothing was sent" otherwise).

import { EthRpcError } from './rpc.js';
import { entryChain } from './outbox.js';

/**
 * The server's newest block once it is at least `minBlock`, asked `tries` times `waitMs` apart; then
 * EthRpcError('behind'), naming the server.
 */
export async function headNotBefore(rpc, minBlock = 0, { tries = 5, waitMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const head = await rpc.blockNumber();
    if (head >= minBlock) return head;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  const name = rpc && rpc.host && rpc.host.name ? rpc.host.name : 'The server';
  throw new EthRpcError('behind', `${name} is behind the block that confirmed your permission.`);
}

/** allowance(block) at the server's newest block, once it is at least `minBlock` (see headNotBefore). */
export async function allowanceNotBefore(rpc, minBlock, allowance, opts = {}) {
  return allowance(await headNotBefore(rpc, minBlock, opts));
}

/**
 * The decision: {kind: 'none' | 'approve' | 'resetThenApprove', current, block}, every figure read
 * at `block`. allowance(block): the token's allowance for the spender; need: the amount the swap
 * moves; probe(block): whether an approve from a non-zero allowance goes through at that block
 * (USDT's says no), asked only when the allowance is non-zero and short. Throws when anything cannot
 * be read (the server behind, down, refusing): "couldn't check", never a guess.
 */
export async function decidePermission(rpc, { minBlock = 0, allowance, need, probe = null, tries, waitMs }) {
  const block = await headNotBefore(rpc, minBlock, { ...(tries ? { tries } : {}), ...(waitMs !== undefined ? { waitMs } : {}) });
  const current = await allowance(block);
  if (current >= need) return { kind: 'none', current, block };
  if (current > 0n && probe && !(await probe(block))) return { kind: 'resetThenApprove', current, block };
  return { kind: 'approve', current, block };
}

/**
 * The newest block at which this wallet's permission for `token` (to `spender`, when given) on `chain`
 * is known to have changed: a confirmed approve's receipt, the block a permission was seen in effect
 * without a receipt (seenInEffectAt: a server that keeps receipts to itself), or a confirmed swap
 * paying with that token (it used the permission up; a backend behind it would still show it). An
 * entry mined but never closed (a server that keeps receipts to itself: its nonce below `mined`, the
 * account's mined count read at `block`) counts as that block: the figures the next decision reads
 * must come from a block that has it (release audit 0.1.6, S2). 0 when none.
 */
export function permissionMinBlock(outbox, { chain, token, spender = null, mined = null, block = null }) {
  const t = String(token || '').toLowerCase();
  const sp = spender ? String(spender).toLowerCase() : null;
  let min = 0;
  for (const e of outbox || []) {
    if (e.kind !== 'approve' && e.kind !== 'approveReset' && e.kind !== 'swap') continue;
    if (entryChain(e) !== chain || String(e.token || '').toLowerCase() !== t) continue;
    // A swap's entry names no spender: on each chain it spends through the one this screen asks about.
    if (sp && e.kind !== 'swap' && String(e.spender || '').toLowerCase() !== sp) continue;
    if (e.state === 'confirmed' && e.receipt && Number.isSafeInteger(Number(e.receipt.blockNumber))) min = Math.max(min, Number(e.receipt.blockNumber));
    if (Number.isSafeInteger(e.seenInEffectAt)) min = Math.max(min, e.seenInEffectAt);
    // Replaced: the one that took its place (signed with this key, maybe on another device) may have
    // changed the permission; the figures must come from the block it was mined in, or the newest seen.
    if (e.state === 'replaced') {
      if (e.replacedIn != null && Number.isSafeInteger(Number(e.replacedIn))) min = Math.max(min, Number(e.replacedIn));
      if (e.replacedUnseen && Number.isSafeInteger(Number(e.replacedUnseen.block))) min = Math.max(min, Number(e.replacedUnseen.block));
    }
    // Open entries only (a failed or rejected one changed nothing to wait for; a replaced one has its block above).
    if (mined !== null && mined !== undefined && Number.isSafeInteger(Number(block)) && (e.state === 'signed' || e.state === 'pending')) {
      try {
        if (BigInt(e.nonce) < BigInt(mined)) min = Math.max(min, Number(block));
      } catch {
        /* no nonce: nothing to add */
      }
    }
  }
  return min;
}

/**
 * permissionMinBlock for wallet `w` (an EthWallet, or anything with its state): the mined count and
 * the block of its last balance read on `chain` come from w.state.chains[chain].
 */
export function walletPermissionFloor(w, chain, token, spender = null) {
  const c = (w && w.state && w.state.chains && w.state.chains[chain]) || {};
  return permissionMinBlock(w && w.state ? w.state.outbox : [], { chain, token, spender, mined: c.minedNonce ?? null, block: c.block ?? null });
}
