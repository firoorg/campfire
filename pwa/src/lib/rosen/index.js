// SPDX-License-Identifier: MIT
// The Bridge screen's Rosen module (lib/bridge_rosen.js loads it): quote and cross, on top of
// lib/rosen/rosen.js. The screen has already asked "no refunds — bridge it?" and the password or
// Face ID; this module builds the crossing, reads its own bytes back against the plan, and only
// then sends it. Any mismatch stops it before anything leaves the wallet.
//
//   LOCK                                  Rosen's lock addresses (LOCK.firo: what the Bridge looks for among
//                                         this wallet's payments in doubt, lib/bridge_rosen.js)
//   quote({ from, to, amount, firoUsd })  -> { minBridgeFee, bridgeFee, networkFee, receive, live, costPct, zeroFrom, eta, warnings }
//   cross({ app, from, to, amount, destination, quote })
//     FIRO -> chain: one FIRO transaction from this wallet's public coins: the lock payment and its
//       OP_RETURN, change back to this wallet; resolves { txid, eventId }.
//     chain -> FIRO: rsFIRO.transfer(Rosen's lock, amount) with the payload appended, through
//       lib/eth/send_raw.js (its own review and confirmation); resolves { hash }.

import { quote as rosenQuote, firoLockOutputs, verifyFiroLockTx, evmExitCall, verifyEvmExitCall, eventIdOfFiroLock, RosenError, ETA, NETWORK_FEE } from './rosen.js';

export { LOCK } from './rosen.js';
import { wallet } from '../wallet.js';
import { network as firoNetwork } from '../firo/params.js';
import { t } from '../i18n.js';

const NET = firoNetwork('main');
/** The most the FIRO lock transaction may pay in network fee (also the margin chooseCoins keeps). */
export const MAX_LOCK_FEE = 1000000n;
/** A typical lock transaction's size: two P2PKH inputs, the lock output, the OP_RETURN, change. */
const LOCK_TX_BYTES = 10 + 2 * 148 + 34 + 11 + 60 + 34;

/** The FIRO network fee the lock is expected to pay at `feePerKb` (shown before approval). */
export function expectedLockFee(feePerKb) {
  const rate = BigInt(feePerKb);
  return (rate * BigInt(LOCK_TX_BYTES) + 999n) / 1000n;
}

export function quote({ from, to, amount, firoUsd }) {
  return rosenQuote({ from, to, amount: BigInt(amount), firoUsd });
}

/**
 * Public coins covering amount + a margin for the fee, largest first (no wallet-wide sweep). The
 * coins of a payment let go of while it may still be out there come first, all of them (P7, audit
 * E6): this lock and that payment then cannot both be mined.
 */
async function chooseCoins(backend, amount) {
  const coins = (await backend.coins.list()).filter((c) => c.kind === 'transparent' && c.spendable && !c.frozen);
  coins.sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  const need = BigInt(amount) + MAX_LOCK_FEE; // + the network fee's budget; the builder sets the exact fee
  // Every let-go coin, then others only while still short (second audit N13: one more was added
  // after them whether needed or not, tying another coin to this lock on the chain).
  const out = coins.filter((c) => c.spendFirst);
  let sum = out.reduce((s, c) => s + BigInt(c.amount), 0n);
  for (const c of coins) {
    if (sum >= need) break;
    if (c.spendFirst) continue;
    out.push(c);
    sum += BigInt(c.amount);
  }
  if (sum >= need) return out;
  const have = coins.reduce((s, c) => s + BigInt(c.amount), 0n);
  throw new RosenError('amount', t('Bridging needs {amount} FIRO in your public balance (confirmed); it has {amount2}. Move private FIRO to public first.', { amount: fmt(need), amount2: fmt(have) }));
}
// '1,234.5' in every language and on every device (a locale's comma invites a wrong amount).
const fmt = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });

/** The oldest FIRO price a crossing is signed on: Rosen ignores one that declares under its minimum at its own price. */
export const PRICE_FRESH_MS = 10 * 60000;

export async function cross({ app, from, to, amount, destination, quote: q, backend: engine = null, now = Date.now() }) {
  const a = BigInt(amount);
  // The quote must be this very route's, for this very amount: a quote for another chain declares
  // another network fee, and declaring less than Rosen needs loses the coins (release audit 0.1.7,
  // verification 5: switching chain while the new balance was read sent the old chain's quote).
  let fits = false;
  try {
    fits = Boolean(q) && q.from === from && q.to === to && BigInt(q.amount) === a && NETWORK_FEE[to] !== undefined && BigInt(q.networkFee) === NETWORK_FEE[to] && BigInt(q.bridgeFee) >= (a * 50n) / 10000n;
    // Something must arrive, and the fee is never under Rosen's minimum the quote itself named.
    if (fits) fits = BigInt(q.bridgeFee) + BigInt(q.networkFee) < a && (q.minBridgeFee == null || BigInt(q.bridgeFee) >= BigInt(q.minBridgeFee));
  } catch {
    fits = false; // a field missing or unreadable: never a guess
  }
  if (!fits) {
    throw Object.assign(new RosenError('mismatch', t('The fees shown were for another route or amount, so nothing was sent. Check the amounts again, then bridge.')), { beforeBroadcast: true });
  }
  // The price the fee was worked out on, recent, here too and not only on the screen (audit P1:
  // a quote of any age was signed; FIRO fallen since put the fee under Rosen's $10 minimum).
  if (!q || !Number.isFinite(q.priceAt) || q.priceAt <= 0 || now - q.priceAt > PRICE_FRESH_MS || q.priceAt > now + 60000) {
    throw Object.assign(new RosenError('stale', t('The FIRO price these fees were worked out on is more than ten minutes old, so nothing was sent. Look at the fees again, then bridge.')), { beforeBroadcast: true });
  }
  // The fees declared are the quote's, the ones the person saw (checked above for this route and amount).
  const fees = { bridgeFee: BigInt(q.bridgeFee), networkFee: BigInt(q.networkFee) };
  if (from === 'firo') {
    let built;
    try {
      const backend = engine ?? wallet.need();
      const plan = { to, destination, amount: a, ...fees, ...firoLockOutputs({ to, destination, amount: a, ...fees }, NET) };
      const coins = await chooseCoins(backend, a);
      built = await backend.buildTransparentTx({ inputs: coins.map((c) => c.id), outputs: plan.outputs });
      const change = new Set(built.outputs.filter((o) => o.change).map((o) => o.address));
      const problems = verifyFiroLockTx(built.hex, plan, { net: NET, isOwnChange: (addr) => change.has(addr) });
      if (problems.length) throw new RosenError('mismatch', t('The crossing did not match its plan, so it was not sent: {value}', { value: problems.join(' ') }));
      // The FIRO network fee: a few thousand satoshi on Firo today. More than the 0.01 FIRO this
      // module budgets for it means a server asked for something absurd (audit D-03): refuse.
      if (BigInt(built.fee) > MAX_LOCK_FEE) throw new RosenError('fee', t('The FIRO network fee came out at {amount} FIRO, far above normal, so nothing was sent. Try again, or choose another server in Settings.', { amount: fmt(built.fee) }));
    } catch (e) {
      // Nothing was broadcast: certain (the Bridge may say "Nothing was sent").
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { beforeBroadcast: true });
    }
    const backend = engine ?? wallet.need();
    let txid;
    try {
      ({ txid } = await backend.broadcastTx(built.hex));
    } catch (e) {
      // The engine's words decide (lib/send_outcome.js, release audit FM-1): 'offline' never
      // reached a node, 'server' is a node's refusal: not sent. 'unsure' reached a node with no
      // answer: the lock may have left, and it is followed by its txid.
      if (e && e.code === 'unsure' && !e.txid) e.txid = built.txid;
      throw e;
    }
    return { txid, eventId: eventIdOfFiroLock(txid), eta: ETA[to] };
  }
  if (to !== 'firo') throw new RosenError('route', t('Rosen moves FIRO to rsFIRO and back.'));
  const plan = { from, destination, amount: a, ...fees };
  const call = evmExitCall(plan, NET);
  const problems = verifyEvmExitCall(call, plan, NET);
  if (problems.length) throw new RosenError('mismatch', t('The crossing did not match its plan, so it was not sent: {value}', { value: problems.join(' ') }));
  const { sendRaw } = await import('../eth/send_raw.js');
  const receive = a - fees.bridgeFee - fees.networkFee;
  return sendRaw(app, {
    chain: from,
    to: call.to,
    data: call.data,
    value: 0n,
    meaning: {
      title: t('Bridge rsFIRO to FIRO'),
      amountText: `${fmt(a)} rsFIRO`,
      rows: [
        [t('Arrives'), t('about {amount} FIRO, in your public balance', { amount: fmt(receive) })],
        [t('To'), destination],
        [t('Rosen fee'), `${fmt(fees.bridgeFee + fees.networkFee)} FIRO`],
        [t('Time'), ETA.firo],
      ],
      warning: t('Bridges cannot be undone.'),
    },
    // Signed only while the price its fee was worked out on is fresh (second audit, N2: the review
    // could be confirmed any time later, and FIRO fallen since put the fee under Rosen's minimum).
    notAfter: q.priceAt + PRICE_FRESH_MS,
    lateText: t('The FIRO price these fees were worked out on is now more than ten minutes old. Go back to the Bridge and look at the fees again.'),
  });
}
