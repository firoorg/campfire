// What this device signed and sent on Ethereum and BNB Chain, newest first, sealed
// (lib/eth/sealed.js). Each transaction is written here BEFORE it is
// broadcast: its hash is keccak256(raw), known from the signed bytes, so a
// payment that left during a network error can still be followed, and sent
// again with the identical bytes (never re-signed, so never twice).
//
// Entry (amounts as decimal strings, they go through JSON):
//   {hash, raw, nonce, from, to, asset, token, amount, gasLimit, maxFeePerGas,
//    maxPriorityFeePerGas, createdAt, sentAt, state, receipt, error, chain}
// chain: 'ethereum' | 'bsc' (entries written before BNB Chain have none: Ethereum).
// state: 'signed'   saved, not yet accepted by the server
//        'pending'  the server took it; waiting for a block
//        'confirmed' | 'failed' (mined; status 1 / 0: the fee was spent)
//        'replaced' another transaction with its nonce was mined instead, shown by the
//                   server and signed by this wallet (replacedBy: its hash, replacedIn: its block);
//                   or, with replacedBy null and replacedUnseen {block, servers}, its nonce used
//                   for good by a transaction neither the server in use nor a second one could
//                   show, and neither knowing this one (lib/eth/send.js, release re-audit R-1)
//        'rejected' the server refused the bytes, and kept refusing them for
//                   lib/eth/send.js REFUSAL_WATCH_MS while their hash stayed unknown
// failedSeen: {block, said} while the server in use shows a failed receipt no second server has
//   confirmed yet (lib/eth/send.js failureVerdict, X7): held open, in doubt.
// unsureSince: set (ms) while an open entry's server says its nonce is used up but cannot show
//   what used it (lib/eth/send.js followOnce): it may still be mined, so the screens say not to
//   send it again yet. Cleared once it is mined, shown replaced, or the server sees it again.
//   nonceUsedAt: the block at which this device first saw that (R-1: how long it has been so).
// refusedAt: set (ms) while an open entry's bytes are refused by the server: it may still have
//   passed them on, so the screens say "not sent yet" and not to send it again yet. Cleared once
//   the server takes them, or it is mined or shown replaced.

import { sealData, openData } from './sealed.js';
import { ETH_OUTBOX_KEY } from './record.js';
import { store } from '../store.js';
import { tokenBySymbol, nativeFor } from './tokens.js';
import { formatUnits } from './units.js';

export const OUTBOX_STATES = Object.freeze(['signed', 'pending', 'confirmed', 'failed', 'replaced', 'rejected']);
/**
 * How long a broadcast may wait for its answer (EthRpc's 20 s, with room): a 'signed' entry with
 * no answer on record younger than this may still be on its way out, and is said so (lib/eth/send.js
 * doubtText); it is in doubt either way (release re-audit R-4, re-audit 3 RE3-5).
 */
export const BROADCAST_ANSWER_MS = 60 * 1000;
/** Entries kept; open ones (signed, pending) are never dropped. */
export const OUTBOX_MAX = 100;
/**
 * How long a 'rejected' entry is looked at again (lib/eth/send.js recheckClosed, audit BM-2): its
 * "Not sent" is one server's word. Kept in the outbox for that long whatever its size (R-7).
 */
export const REJECTED_FOLLOW_MS = 30 * 24 * 3600 * 1000;
const OPEN = new Set(['signed', 'pending']);

const HASH = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,78}$/;

export function isOpen(entry) {
  return OPEN.has(entry.state);
}

/** The chain an entry was sent on. */
export function entryChain(entry) {
  return entry && entry.chain === 'bsc' ? 'bsc' : 'ethereum';
}

/** What an entry is, in words: "the payment of 12.5 rsFIRO", "the swap of 0.1 ETH", "the permission for rsFIRO". */
export function entryWords(e) {
  const key = entryChain(e);
  const asset = e.token ? tokenBySymbol(e.asset, key) : nativeFor(key);
  const amount = asset ? `${formatUnits(BigInt(e.amount), asset.decimals)} ${e.asset}` : e.asset;
  if (e.kind === 'approve' || e.kind === 'approveReset') return `the permission for ${e.asset}`;
  if (e.kind === 'swap') return `the swap of ${amount}`;
  if (e.kind === 'raw' && typeof e.label === 'string' && e.label) return `"${e.label.slice(0, 80)}" (${amount})`;
  return `the payment of ${amount}`;
}

/**
 * Whether a 'signed' entry's broadcast has no answer on record (release re-audit R-4): it ended in
 * an error that was not a refusal, the page died mid-broadcast, or its broadcast is still under way
 * (re-audit 3 RE3-5: R-4 waited BROADCAST_ANSWER_MS first, and a second signing from another
 * screen during the broadcast took the next nonce: both could be mined). The server may have taken
 * it, and the next transaction would then take the next nonce. One look settles it: the server
 * knows it ('pending'), or takes the same bytes again.
 */
export function unanswered(e) {
  return e.state === 'signed' && !e.sentAt && !e.refusedAt;
}

/**
 * The open entries (of `chainKey`, or every chain) whose fate is in doubt: the server says their
 * nonce is used up but shows nothing (unsureSince), it refused their bytes (refusedAt), or their
 * broadcast got no answer (unanswered, R-4). Each may still be mined, so nothing else is signed on
 * that chain meanwhile: it would take the next nonce, and both could go through (audit BM-1).
 */
export function inDoubt(list, chainKey = null) {
  return (list || []).filter((e) => isOpen(e) && (Boolean(e.unsureSince) || Boolean(e.failedSeen) || (e.state === 'signed' && Boolean(e.refusedAt)) || unanswered(e)) && (chainKey === null || entryChain(e) === chainKey));
}

/**
 * Permissions of this wallet still on their way (signed or pending) for `token` on `chain` (and to
 * `spender`, when given): approve and its reset step, newest first. While one is out, another is
 * never offered (release audit 0.1.5, S1): it would cost a second fee for the same permission.
 */
export function openApprovals(list, { chain, token, spender = null }) {
  const t = String(token || '').toLowerCase();
  const sp = spender ? String(spender).toLowerCase() : null;
  return (list || []).filter(
    (e) => isOpen(e) && (e.kind === 'approve' || e.kind === 'approveReset') && entryChain(e) === chain && String(e.token || '').toLowerCase() === t && (!sp || String(e.spender || '').toLowerCase() === sp),
  );
}

/**
 * Whether an open entry is still waiting to be mined, as far as `mined` says: the account's mined
 * transaction count on its chain (read with the balances), or null when not known. One whose nonce
 * is below it is mined (or its place taken): its effect is in the balance already, though its entry
 * may stay open (a server that keeps receipts to itself never lets it close). Unknown: still waiting.
 */
function unmined(e, mined) {
  if (mined === null || mined === undefined) return true;
  try {
    return BigInt(e.nonce) >= BigInt(mined);
  } catch {
    return true;
  }
}

/**
 * Whether `e` still holds what it promised in a balance read with `mined` (the account's mined count)
 * at block `block`: an open entry until it is mined (unmined), and one that confirmed or failed AFTER
 * that read too: its nonce at or above `mined`, or, the count not known, its receipt in a later block.
 * The balance read before it still holds that money, so it must not be spendable again until the
 * next read (release audit 0.1.6, S1: a follow-up closing an entry between the read and the screen).
 */
function holds(e, mined, block) {
  if (isOpen(e)) return unmined(e, mined);
  if (e.state !== 'confirmed' && e.state !== 'failed') return false;
  const at = e.receipt && e.receipt.blockNumber != null ? Number(e.receipt.blockNumber) : null;
  const known = block !== null && block !== undefined && Number.isSafeInteger(Number(block));
  if (mined !== null && mined !== undefined) {
    // The mined count read with the balances decides: a transaction it does not count yet is not in
    // them. A receipt at or before the read block that the count disagrees with is a reorganisation
    // (or a sibling block at the tip): it is mined again soon, so it keeps holding, but never for good:
    // past SETTLED_DEPTH blocks it is gone (a fork used as one's own server, a lying receipt) and its
    // money is in the balance (release audit 0.1.7, S4).
    if (at !== null && Number.isSafeInteger(at) && known && Number(block) - at > SETTLED_DEPTH) return false;
    try {
      return BigInt(e.nonce) >= BigInt(mined);
    } catch {
      return false;
    }
  }
  // No count: its receipt's block against the read's.
  return at !== null && Number.isSafeInteger(at) && known && at > Number(block);
}

/** Blocks after which a receipt older than the balance read can no longer be a confirmation it missed. */
const SETTLED_DEPTH = 64;

/**
 * What this wallet's open transactions (signed or pending) on `chainKey` have already promised, by
 * the bytes signed: {native: wei (each one's coin, and its fee at most: gasLimit × maxFeePerGas),
 * tokens: Map(lowercase token address → units)}. A permission moves no tokens; its fee counts. A
 * balance read at 'latest' still holds these until they are mined, so a second payment built on it
 * would fail on chain and its fee be lost (release audit 0.1.6). mined, block: the account's mined
 * count on that chain and the block the balances were read at: entries below the count are mined
 * already (in the balance) and do not count; one that confirmed or failed after that read still does
 * (holds()). A failed one only spent its fee.
 */
export function promised(list, chainKey, { mined = null, block = null } = {}) {
  const big = (v) => {
    try {
      const n = BigInt(v);
      return n > 0n ? n : 0n;
    } catch {
      return 0n;
    }
  };
  let native = 0n;
  const tokens = new Map();
  for (const e of list || []) {
    if (entryChain(e) !== chainKey || !holds(e, mined, block)) continue;
    native += big(e.gasLimit) * big(e.maxFeePerGas);
    if (e.state === 'failed' || e.kind === 'approve' || e.kind === 'approveReset') continue;
    if (!e.token) native += big(e.amount);
    else {
      const k = String(e.token).toLowerCase();
      tokens.set(k, (tokens.get(k) || 0n) + big(e.amount));
    }
  }
  return { native, tokens };
}

/**
 * This wallet's newest open swap on `chain` paying with `token` (an address; null: the chain's coin),
 * or null. While it is on its way, another swap of that token is not built: both would read the same
 * permission (and Uniswap's Permit2 signature number) at 'latest', and the second one would fail on
 * chain, its fee lost (release audit 0.1.6). mined, block: as for promised(): one mined already
 * holds nothing; one mined after the balances were read still holds until the next read (the next
 * swap's permission figures must come from a block that has it).
 */
export function openSwapOf(list, { chain, token, mined = null, block = null }) {
  const t = token ? String(token).toLowerCase() : null;
  return (list || []).find((e) => e.kind === 'swap' && entryChain(e) === chain && (e.token ? String(e.token).toLowerCase() : null) === t && holds(e, mined, block)) || null;
}

/** Whether `e` is an entry this module wrote (records come back from storage; check them). */
export function validEntry(e) {
  return (
    Boolean(e) &&
    typeof e === 'object' &&
    HASH.test(e.hash) &&
    typeof e.raw === 'string' &&
    /^0x02[0-9a-f]+$/.test(e.raw) &&
    UINT.test(e.nonce) &&
    ADDR.test(e.from) &&
    ADDR.test(e.to) &&
    typeof e.asset === 'string' &&
    (e.token === null || ADDR.test(e.token)) &&
    UINT.test(e.amount) &&
    OUTBOX_STATES.includes(e.state) &&
    Number.isFinite(e.createdAt) &&
    (e.chain === undefined || e.chain === 'ethereum' || e.chain === 'bsc')
  );
}

// One write at a time: two quick updates must not each read the old list.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

/**
 * An entry closed as 'replaced' before audit D-04 (the nonce alone, no replacing transaction shown:
 * no replacedBy) is not proven: it is open again, "Not sure yet", and followed (it may have been
 * mined after all; release audit FM-9). Written so with the next write of the outbox. One closed
 * on two servers' word (replacedUnseen, R-1) is not reopened.
 */
function reopenUnproven(e) {
  return e.state === 'replaced' && !e.replacedBy && !e.replacedUnseen ? { ...e, state: 'pending', unsureSince: e.unsureSince || e.createdAt } : e;
}

export async function loadOutbox(app, { ethId, kv = store } = {}) {
  const list = await openData(app, ETH_OUTBOX_KEY, { ethId, kv });
  return Array.isArray(list) ? list.filter(validEntry).map(reopenUnproven) : [];
}

/**
 * Every open entry and every 'rejected' one still looked at again (REJECTED_FOLLOW_MS: dropping it
 * would end its re-check, release re-audit R-7), then the newest other closed ones up to
 * OUTBOX_MAX in all. `list` is newest first.
 */
export function trimOutbox(list, now = Date.now()) {
  const keep = (e) => isOpen(e) || (e.state === 'rejected' && now - e.createdAt < REJECTED_FOLLOW_MS);
  let room = Math.max(0, OUTBOX_MAX - list.filter(keep).length);
  return list.filter((e) => keep(e) || room-- > 0);
}

/** Saves a signed transaction before it is broadcast. */
export function addToOutbox(app, entry, { ethId, kv = store } = {}) {
  if (!validEntry(entry)) return Promise.reject(new Error('Not an outbox entry.'));
  return serial(async () => {
    const list = (await loadOutbox(app, { ethId, kv })).filter((e) => e.hash !== entry.hash);
    const next = trimOutbox([entry, ...list].sort((a, b) => b.createdAt - a.createdAt));
    await sealData(app, ETH_OUTBOX_KEY, next, { ethId, kv });
    return entry;
  });
}

/** Merges `patch` into the entry `hash`; returns the updated entry (or null when there is none). */
export function updateOutbox(app, hash, patch, { ethId, kv = store } = {}) {
  return serial(async () => {
    const list = await loadOutbox(app, { ethId, kv });
    const i = list.findIndex((e) => e.hash === hash);
    if (i < 0) return null;
    const next = { ...list[i], ...patch, hash: list[i].hash, raw: list[i].raw, nonce: list[i].nonce, from: list[i].from };
    if (!validEntry(next)) throw new Error('That update would break the outbox entry.');
    list[i] = next;
    await sealData(app, ETH_OUTBOX_KEY, list, { ethId, kv });
    return next;
  });
}

export function clearOutbox(kv = store) {
  return serial(() => kv.del(ETH_OUTBOX_KEY));
}
