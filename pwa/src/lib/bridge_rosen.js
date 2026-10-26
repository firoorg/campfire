// The Bridge screen's seam to the Rosen bridge (FIRO ⇄ rsFIRO on Ethereum or BNB Chain).
//
// The Rosen stream owns lib/rosen/ (fees read live, the OP_RETURN and calldata builders that
// re-parse their own bytes before signing). Until it is merged, this file answers quotes with
// the published fee rule and refuses to move anything: a crossing has no refund, so nothing is
// sent by a stand-in. The module it loads must offer:
//
//   quote({ from, to, amount })  from/to: 'firo' | 'ethereum' | 'bsc' (one of them 'firo');
//                                amount: BigInt sats (FIRO and rsFIRO both have 8 decimals)
//     -> { minBridgeFee, bridgeFee, networkFee, receive (BigInt sats), live (bool) }
//        bridgeFee = max(minBridgeFee, 0.5% of amount); minBridgeFee is Rosen's $10 in FIRO today.
//   LOCK.firo                    Rosen's FIRO lock address: a crossing from FIRO is a payment to it
//                                (read here at runtime, so the Bridge never holds a copy of its own)
//   cross({ app, from, to, amount, destination, quote })  -> { txid } | { hash, sent, refused }
//        FIRO -> chain: the engine's rosen.lock (one transaction: the lock payment and its
//        OP_RETURN); chain -> FIRO: lib/eth's sendRaw with the transfer's appended payload
//        (refused: its server refused it, though it may have passed it on; the person is then on
//        the payment's status screen, "Not sent yet").
//
// Everything the screen says about money is worked out here, from those figures.

import { sendOutcome, followVerdict } from './send_outcome.js';
import { t, tk, lazyWords } from './i18n.js';

export const ROSEN_RATE_BPS = 50n; // 0.5%
export const MIN_FEE_USD = 10;
const STUB_MIN_FEE_SATS = 1054000000n; // 10.54 FIRO: $10 at the price of 2026-10-12, when no price is known
const NETWORK_FEE = Object.freeze({ bsc: 1669737n, ethereum: 2643766n, firo: 500452n });
const WARN_COST = 3; // percent

export const CHAINS = Object.freeze({
  ethereum: lazyWords({ id: 'ethereum', name: 'Ethereum', eta: tk('Can take several hours'), etaShort: 'hours' }),
  bsc: lazyWords({ id: 'bsc', name: 'BNB Chain', eta: tk('About 40 minutes'), etaShort: tk('~40 min') }),
});
export const TO_FIRO_ETA = tk('25 to 60 minutes');

let mod = null;
/** Rosen's FIRO lock address, from the loaded module (null until it is loaded, and with the stand-in). */
let firoLock = null;
/**
 * The Rosen module, or the stand-in quote while it is not part of this build. A module that does
 * not name its FIRO lock address is not used: the Bridge could not see a lock of its own in doubt.
 */
export async function rosen() {
  if (mod) return mod;
  try {
    const path = './rosen/index.js'; // a variable: a build without lib/rosen/ still loads
    const m = await import(path);
    const lock = m && m.LOCK && m.LOCK.firo;
    if (m && typeof m.quote === 'function' && typeof m.cross === 'function' && isRosenFiroAddress(lock)) {
      firoLock = lock;
      return (mod = m);
    }
  } catch {
    // Not part of this build, or a load that failed this once: the stand-in for now, asked again next time.
    return stub;
  }
  return (mod = stub);
}

/**
 * Rosen's FIRO lock address as lib/rosen states it (release re-audit 3: read at runtime, not a
 * copy kept equal by a test), or null before rosen() has loaded it (the Bridge loads it first).
 */
export function rosenFiroLock() {
  return firoLock;
}

/** Rosen's fee rule for the stand-in: $10 in FIRO (at `firoUsd`, else the 2026-10-12 figure) or 0.5%. */
export function stubQuote({ from = null, to, amount, firoUsd = null }) {
  const min = Number.isFinite(firoUsd) && firoUsd > 0 ? BigInt(Math.ceil((MIN_FEE_USD / firoUsd) * 1e8)) : STUB_MIN_FEE_SATS;
  const pct = (BigInt(amount) * ROSEN_RATE_BPS) / 10000n;
  const bridgeFee = pct > min ? pct : min;
  const networkFee = NETWORK_FEE[to] || 0n;
  const receive = BigInt(amount) - bridgeFee - networkFee;
  return { from, to, amount: BigInt(amount), minBridgeFee: min, bridgeFee, networkFee, receive: receive > 0n ? receive : 0n, live: false };
}

const stub = Object.freeze({
  stub: true,
  quote: async (p) => stubQuote(p),
  cross: async () => {
    const e = new Error(t('Bridging is not in this version yet: it comes with the Rosen update. Nothing was sent.'));
    e.code = 'NotYet';
    throw e;
  },
});

/**
 * What the screen shows for a quote: the cost as a percent, the amount from which the fee is
 * just 0.5% (200 times the minimum: 0.5% of it is the minimum), whether to warn or refuse.
 */
export function assess(amount, q) {
  const a = BigInt(amount);
  const fees = q.bridgeFee + q.networkFee;
  const costPercent = a > 0n ? Number((fees * 10000n) / a) / 100 : null;
  return {
    fees,
    costPercent,
    breakEven: q.zeroFrom ?? q.minBridgeFee * 200n, // $2,000 of value at today's price (Rosen's module), else 200 x the minimum
    refuse: a <= 0n || fees >= a,
    warn: costPercent != null && costPercent > WARN_COST,
    small: q.bridgeFee === q.minBridgeFee && a < q.minBridgeFee * 200n,
  };
}

/** A FIRO destination for Rosen: transparent "a…" only (Spark, Lelantus and exchange addresses are not). */
export const isRosenFiroAddress = (s) => /^a[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(s || '').trim());
export const isEvmAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());

/** Rosen's refusals before any bytes leave (lib/rosen/rosen.js RosenError). */
const ROSEN_REFUSALS = new Set(['no-price', 'too-small', 'destination', 'route', 'mismatch', 'amount', 'fee']);

/**
 * What a failed crossing means (release audit FM-1): {kind: 'not-yet' | 'not-sent' | 'unsure' |
 * 'unknown', txid}. rsFIRO -> FIRO fails only before its review signs anything (after it, the
 * review resolves and the payment's status screen follows it); FIRO -> chain is one Firo
 * transaction, and the engine's words decide (lib/send_outcome.js): never "nothing was sent"
 * for a lock that may have left.
 */
export function crossFailure(e, { toFiro = false } = {}) {
  if (e && e.code === 'NotYet') return { kind: 'not-yet', txid: null };
  if (toFiro || (e && (e.beforeBroadcast === true || ROSEN_REFUSALS.has(e.code)))) return { kind: 'not-sent', txid: null };
  const out = sendOutcome(e);
  return { kind: out.kind, txid: out.txid };
}

// FIRO locks that may have left (the node didn't answer), as this page remembers them: it knows
// their chain. The Bridge offers nothing new until the wallet has the lock in a block or says the
// network does not have it. The page's memory alone dies with a reload, a relaunch or another
// tab taking the wallet over, while the engine still follows the lock and resends it: so the
// wallet's own payments count too (walletLocks, release re-audit R-3).
const unsureLocks = [];

/**
 * The wallet's own payments to Rosen's FIRO lock that may have left (its Tx says unsure: no answer
 * from the node, not seen on the network yet, not let go): {txid, at, amount, to: null} each, as
 * the engine follows them whatever the page remembers (lib/firo/history.js: an outgoing public
 * payment's counterparty is its first output to someone else, the lock address). The lock address
 * is lib/rosen's own (rosenFiroLock): none before it is loaded, and nothing can be bridged before.
 */
function walletLocks(w) {
  const lock = firoLock;
  const txs = (w && w.state && w.state.txs) || [];
  if (!lock) return [];
  return txs.filter((item) => item && item.direction === 'out' && item.unsure === true && !item.dropped && !(item.confirmations > 0) && item.counterparty === lock).map((tx) => ({ txid: tx.txid, at: null, amount: tx.amount, to: null }));
}

/** A lock that may have left: {txid, at, amount (sats), to (chain key)}. */
export function rememberUnsureLock(lock) {
  if (lock && lock.txid && !unsureLocks.some((x) => x.txid === lock.txid)) unsureLocks.push({ ...lock });
}

/**
 * The newest lock still in doubt for wallet `w`: {lock, verdict: 'checking'}, from the page's
 * memory, else from the wallet's own payments (R-3: it survives a reload); or one the network does
 * not have (Tx.dropped: {lock, verdict: 'gone'}, said once, from the page's memory); or null. A
 * lock in a block is forgotten (Activity has it).
 */
export function unsureLock(w) {
  let gone = null;
  for (let i = unsureLocks.length - 1; i >= 0; i--) {
    const lock = unsureLocks[i];
    const v = followVerdict(lock, w);
    if (v === 'checking') return { lock, verdict: v };
    unsureLocks.splice(i, 1);
    if (v === 'gone' && !gone) gone = { lock, verdict: v };
  }
  const held = walletLocks(w)[0];
  return held ? { lock: held, verdict: 'checking' } : gone;
}

/** Forgets every lock in doubt (tests; a locked wallet keeps nothing of them). */
export function forgetUnsureLocks() {
  unsureLocks.length = 0;
}

/**
 * Whether a crossing was handed over (cross()'s answer): a FIRO lock the node took ({txid}), or
 * an rsFIRO payment its server took ({hash, sent}). A server that refused it or never answered
 * (FM-4) is followed on the payment's status screen instead: not "Sent to Rosen".
 */
export function crossHandedOver(result) {
  if (!result) return false;
  if (result.txid) return true;
  return result.sent !== false && !result.refused;
}
