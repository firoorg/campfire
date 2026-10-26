// SPDX-License-Identifier: MIT
// The Rosen bridge between FIRO and rsFIRO (Ethereum and BNB Chain): what a crossing costs, the
// bytes that ask for it, and how its arrival is recognised. There is NO refund: a lock with a
// wrong destination, a wrong chain byte, no payload, or a bridge fee below Rosen's minimum is
// ignored by Rosen's watchers forever and the coins are gone. So every builder here is paired
// with a decoder, and a crossing is only signed after its own bytes were read back and matched.
//
// The payload, the same on every route (owner's measured reference, 2026-10-12):
//   [toChain u8][bridgeFee u64 BE, FIRO satoshi][networkFee u64 BE, FIRO satoshi][len u8][destination]
//   toChain: ergo 0x00, ethereum 0x03, binance (BNB Chain) 0x04, firo 0x07
//   destination: an EVM address's 20 bytes (len 0x14), or a FIRO transparent address's P2PKH
//   output script 76 a9 14 <hash160> 88 ac (len 0x19). Spark, EX and Lelantus addresses are not
//   Rosen destinations.
//   FIRO -> chain: one FIRO transaction paying `amount` to Rosen's FIRO lock address, with the
//   payload in an OP_RETURN output of the same transaction.
//   chain -> FIRO: rsFIRO.transfer(Rosen's lock on that chain, amount) with the payload appended
//   after the call's arguments.
//   Delivered = amount - bridgeFee - networkFee (the fees come out of the amount).
//
// The fee: bridgeFee = the larger of $10 worth of FIRO and 0.5% of the amount, in
// both directions; so from $2,000 of value (2000 / price FIRO) a crossing costs 0.5%. Declaring
// more than Rosen's minimum is always accepted, declaring less loses the coins: the wallet rounds
// the $10 up, refuses to quote without a price rather than guess, and refuses to cross on a price
// more than ten minutes old (lib/rosen/index.js cross).
// networkFee is the destination chain's cost in FIRO: BNB Chain 0.01669737 (identical on every
// completed lock), Ethereum 0.05 (it drifts; 0.0264 was charged lately, so 0.05 is declared as
// the safe figure), FIRO 0.00500452.
//
// Tracking without Rosen's API (it refuses browsers): FIRO -> chain: Rosen's lock on that chain
// sends rsFIRO.transfer(destination, delivered) with the 32-byte event id appended, the event id
// being BLAKE2b-256 of the lock transaction id as lowercase hex text. chain -> FIRO: a FIRO payment
// to the destination whose inputs are signed by Rosen's FIRO lock address, for the delivered
// amount (a few satoshi above, at most).

import { blake2b } from '../../vendor/noble/noble-hashes/blake2.js';
import { keccak_256 } from '../../vendor/noble/noble-hashes/sha3.js';
import { decodeTransparent, scriptToAddress, pubkeyToAddress } from '../firo/address.js';
import { decodeTx } from '../firo/tx.js';
import { parseScript } from '../firo/script.js';
import { network as firoNetwork } from '../firo/params.js';

export const CHAIN_CODE = Object.freeze({ ergo: 0x00, ethereum: 0x03, bsc: 0x04, firo: 0x07 });
const CODE_CHAIN = Object.freeze({ 0x00: 'ergo', 0x03: 'ethereum', 0x04: 'bsc', 0x07: 'firo' });

/** Rosen's lock addresses (contracts release 7.1.1, checked on live crossings): lib/rosen/lock.js. */
import { LOCK } from './lock.js';
import { t, tk, lazyWords } from '../i18n.js';
export { LOCK };
/** rsFIRO, 8 decimals, 1:1 with FIRO. */
export const RSFIRO = Object.freeze({
  ethereum: '0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2',
  bsc: '0x13cdb5f7f398f6af2cc3b34eb04476af3488853f',
});
/** The destination chain's cost, declared in FIRO satoshi. */
export const NETWORK_FEE = Object.freeze({ bsc: 1669737n, ethereum: 5000000n, firo: 500452n });
/** How long a crossing takes, as measured. */
export const ETA = lazyWords({ bsc: tk('About 40 minutes'), ethereum: tk('Can take several hours'), firo: tk('25 to 60 minutes') });

export const MIN_FEE_USD = 10;
// The bridge fee is exactly max($10 in FIRO at the live price, 0.5%), the network fee on top (this
// wallet's rule, 2026-10-15; it replaced a 10% margin over the $10). Rosen ignores a crossing that
// declares under its own minimum, so the price must be recent when it is signed: the Bridge refuses a
// quote whose price is more than ten minutes old (screens/bridge.js).
const MARGIN = 1;
/** A FIRO price outside this band is not believed (a glitch, or a wrong answer): no quote. */
export const PRICE_BAND_USD = Object.freeze({ min: 0.05, max: 50 });
const RATE_BPS = 50n; // 0.5%
const SAT = 100000000n;
export const TRANSFER_SELECTOR = 'a9059cbb';

export class RosenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'no-price' | 'too-small' | 'destination' | 'route' | 'mismatch' | 'amount'
  }
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function unhex(s) {
  const item = String(s).replace(/^0x/i, '');
  if (!/^([0-9a-f]{2})*$/i.test(item)) throw new RosenError('mismatch', t('Not hex.'));
  const out = new Uint8Array(item.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(item.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const u64be = (v) => {
  const b = new Uint8Array(8);
  let x = BigInt(v);
  if (x < 0n || x >= 1n << 64n) throw new RosenError('amount', t('An amount does not fit.'));
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
};
const readU64 = (b, o) => {
  let x = 0n;
  for (let i = 0; i < 8; i++) x = (x << 8n) | BigInt(b[o + i]);
  return x;
};

/** EIP-55: a mixed-case address must carry the right checksum; all lower or upper case is accepted. */
export function evmAddressBytes(addr) {
  const s = String(addr ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new RosenError('destination', t('That is not an Ethereum / BNB Chain address (0x and 40 hex digits).'));
  const body = s.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase()) {
    const h = hex(keccak_256(new TextEncoder().encode(body.toLowerCase())));
    for (let i = 0; i < 40; i++) {
      const c = body[i];
      if (/[a-f]/i.test(c) && (parseInt(h[i], 16) >= 8) !== (c === c.toUpperCase())) throw new RosenError('destination', t('The address checksum does not match: check it was copied in full.'));
    }
  }
  return unhex(body);
}

/** A FIRO transparent (a…) address as Rosen's 25-byte P2PKH script; anything else is refused. */
export function firoDestinationScript(addr, net = firoNetwork('main')) {
  const s = String(addr ?? '');
  if (/^s[mt]1/i.test(s)) throw new RosenError('destination', t('Rosen cannot pay a private (Spark) address. Use a public (a…) address of this wallet; you can privatize it afterwards.'));
  let d;
  try {
    d = decodeTransparent(s, net);
  } catch {
    throw new RosenError('destination', t('That is not a FIRO address.'));
  }
  if (d.type !== 'p2pkh') throw new RosenError('destination', t('Rosen pays only ordinary public FIRO addresses (starting with a), not EX or script addresses.'));
  return d.script;
}

/** The payload bytes. `to`: 'ethereum' | 'bsc' | 'firo'. */
export function encodePayload({ to, bridgeFee, networkFee, destination }, net) {
  if (!(to in NETWORK_FEE)) throw new RosenError('route', t('Rosen does not go to {to} from here.', { to }));
  const dest = to === 'firo' ? firoDestinationScript(destination, net) : evmAddressBytes(destination);
  const out = new Uint8Array(1 + 8 + 8 + 1 + dest.length);
  out[0] = CHAIN_CODE[to];
  out.set(u64be(bridgeFee), 1);
  out.set(u64be(networkFee), 9);
  out[17] = dest.length;
  out.set(dest, 18);
  return out;
}

/** The payload read back: {to, bridgeFee, networkFee, destination (address text), raw}. */
export function decodePayload(bytes, net = firoNetwork('main')) {
  const b = bytes instanceof Uint8Array ? bytes : unhex(bytes);
  if (b.length < 18) throw new RosenError('mismatch', t('The payload is too short.'));
  const to = CODE_CHAIN[b[0]];
  if (!to) throw new RosenError('mismatch', t('Unknown Rosen chain code {value}.', { value: b[0] }));
  const len = b[17];
  if (b.length !== 18 + len) throw new RosenError('mismatch', t('The payload length does not add up.'));
  const dest = b.subarray(18);
  let destination;
  if (to === 'firo') {
    if (len !== 25) throw new RosenError('mismatch', t('A FIRO destination is a 25-byte script.'));
    destination = scriptToAddress(dest, net);
    if (!destination) throw new RosenError('mismatch', t('The FIRO destination is not an address.'));
  } else {
    if (len !== 20) throw new RosenError('mismatch', t('An EVM destination is 20 bytes.'));
    destination = `0x${hex(dest)}`;
  }
  return { to, bridgeFee: readU64(b, 1), networkFee: readU64(b, 9), destination, raw: hex(b) };
}

/**
 * What a crossing of `amount` (FIRO satoshi, BigInt) costs and delivers.
 * from/to: one of them 'firo', the other 'ethereum' | 'bsc'. firoUsd: FIRO's price in USD.
 */
export function quote({ from, to, amount, firoUsd }) {
  if (!((from === 'firo' && (to === 'ethereum' || to === 'bsc')) || (to === 'firo' && (from === 'ethereum' || from === 'bsc')))) throw new RosenError('route', t('Rosen moves FIRO to rsFIRO on Ethereum or BNB Chain, and back.'));
  const a = BigInt(amount);
  if (a <= 0n) throw new RosenError('amount', t('Enter an amount.'));
  if (!(Number.isFinite(firoUsd) && firoUsd > 0)) throw new RosenError('no-price', t("FIRO's price could not be read, so Rosen's minimum fee cannot be worked out. Try again in a moment."));
  if (firoUsd < PRICE_BAND_USD.min || firoUsd > PRICE_BAND_USD.max) throw new RosenError('no-price', t('FIRO\'s price came back as ${firoUsd}, which cannot be right, so Rosen\'s minimum fee cannot be worked out. Nothing was sent; try again later.', { firoUsd }));
  // $10 in FIRO, rounded up to whole satoshi (in fact to 1/10,000 FIRO).
  const minBridgeFee = ceilTo(BigInt(Math.ceil(((MIN_FEE_USD * MARGIN) / firoUsd) * 1e8)), 10000n);
  const pct = ceilTo((a * RATE_BPS + 9999n) / 10000n, 1n);
  const bridgeFee = pct > minBridgeFee ? pct : minBridgeFee;
  const networkFee = NETWORK_FEE[to];
  const receive = a - bridgeFee - networkFee;
  const costPct = Number(((bridgeFee + networkFee) * 1000000n) / a) / 10000;
  // Where 0.5% reaches the declared minimum: from here on the fee is just 0.5%.
  const zeroFrom = ceilTo(minBridgeFee * 200n, SAT);
  const q = { from, to, amount: a, minBridgeFee, bridgeFee, networkFee, receive: receive > 0n ? receive : 0n, costPct, zeroFrom, eta: ETA[to === 'firo' ? 'firo' : to], live: true, ok: receive > 0n, warnings: [] };
  if (receive <= 0n) q.warnings.push(t('The fees are more than the amount: nothing would arrive.'));
  else if (costPct > 3) q.warnings.push(t('Fees take {costPct}% of this amount.', { costPct: costPct.toFixed(2) }));
  return q;
}
const ceilTo = (v, step) => ((v + step - 1n) / step) * step;

// ---------------------------------------------------------------- FIRO -> chain

/** The outputs of the FIRO lock transaction: the lock payment and the OP_RETURN, together. */
export function firoLockOutputs({ to, destination, amount, bridgeFee, networkFee }, net) {
  if (to !== 'ethereum' && to !== 'bsc') throw new RosenError('route', t('A FIRO lock goes to Ethereum or BNB Chain.'));
  const payload = encodePayload({ to, bridgeFee, networkFee, destination }, net);
  return { outputs: [{ address: LOCK.firo, amount: String(amount) }, { opReturn: hex(payload) }], payload: hex(payload) };
}

/**
 * Reads a signed FIRO lock transaction back and checks it against the plan before it is
 * broadcast. Returns [] when it matches, else the problems in words. `isOwnChange(address)`
 * says whether any other paid address is this wallet's own.
 */
export function verifyFiroLockTx(rawHex, plan, { net = firoNetwork('main'), isOwnChange = () => false } = {}) {
  const problems = [];
  let d;
  try {
    d = decodeTx(rawHex, net);
  } catch (e) {
    return [t('The transaction could not be read back: {message}', { message: e.message })];
  }
  const locks = d.vout.filter((o) => o.address === LOCK.firo);
  const datas = d.vout.filter((o) => o.type === 'nulldata');
  if (locks.length !== 1) problems.push(t('It pays Rosen\'s lock address {length} times instead of once.', { length: locks.length }));
  else if (BigInt(locks[0].value) !== BigInt(plan.amount)) problems.push(t('The amount to Rosen is not the amount planned.'));
  if (datas.length !== 1) problems.push(t('It does not carry exactly one Rosen payload.'));
  else {
    const got = hex(datas[0].data ?? new Uint8Array(0));
    if (got !== plan.payload) problems.push(t('The Rosen payload in the transaction is not the one planned.'));
    try {
      const p = decodePayload(datas[0].data, net);
      if (p.to !== plan.to) problems.push(t('The payload names another chain.'));
      if (p.destination.toLowerCase() !== String(plan.destination).toLowerCase()) problems.push(t('The payload names another destination.'));
      if (p.bridgeFee !== BigInt(plan.bridgeFee) || p.networkFee !== BigInt(plan.networkFee)) problems.push(t('The payload declares other fees.'));
    } catch (e) {
      problems.push(t('The payload does not read back: {message}', { message: e.message }));
    }
  }
  for (const o of d.vout) {
    if (o.type === 'nulldata' || o.address === LOCK.firo) continue;
    if (!o.address || !isOwnChange(o.address)) problems.push(t('It also pays {value}, which is not this wallet\'s change.', { value: o.address ?? t('an unknown script') }));
  }
  return problems;
}

// ---------------------------------------------------------------- chain -> FIRO

/** The rsFIRO call of an exit: transfer(Rosen's lock, amount) with the payload appended. */
export function evmExitCall({ from, destination, amount, bridgeFee, networkFee }, net) {
  if (from !== 'ethereum' && from !== 'bsc') throw new RosenError('route', t('An exit starts on Ethereum or BNB Chain.'));
  const payload = encodePayload({ to: 'firo', bridgeFee, networkFee, destination }, net);
  const word = (h) => h.padStart(64, '0');
  const data = `0x${TRANSFER_SELECTOR}${word(LOCK[from].slice(2))}${word(BigInt(amount).toString(16))}${hex(payload)}`;
  return { chain: from, to: RSFIRO[from], data, value: 0n, payload: hex(payload) };
}

/** Reads an exit call back; [] when it is exactly the plan. */
export function verifyEvmExitCall(call, plan, net = firoNetwork('main')) {
  const problems = [];
  const d = String(call.data ?? '').toLowerCase().replace(/^0x/, '');
  if (String(call.to).toLowerCase() !== RSFIRO[plan.from]) problems.push(t('It is not a call to rsFIRO on that chain.'));
  if (BigInt(call.value ?? 0) !== 0n) problems.push(t('It would also send ETH or BNB.'));
  if (d.slice(0, 8) !== TRANSFER_SELECTOR) problems.push(t('It is not a token transfer.'));
  if (`0x${d.slice(8 + 24, 8 + 64)}` !== LOCK[plan.from]) problems.push(t("It does not pay Rosen's lock address."));
  if (BigInt(`0x${d.slice(8 + 64, 8 + 128) || '0'}`) !== BigInt(plan.amount)) problems.push(t('The amount is not the one planned.'));
  try {
    const p = decodePayload(d.slice(8 + 128), net);
    if (p.to !== 'firo') problems.push(t('The payload does not go to FIRO.'));
    if (p.destination !== plan.destination) problems.push(t('The payload names another FIRO address.'));
    if (p.bridgeFee !== BigInt(plan.bridgeFee) || p.networkFee !== BigInt(plan.networkFee)) problems.push(t('The payload declares other fees.'));
  } catch (e) {
    problems.push(t('The payload does not read back: {message}', { message: e.message }));
  }
  return problems;
}

// ---------------------------------------------------------------- tracking

/** Rosen's event id of a FIRO lock: BLAKE2b-256 of the txid as lowercase hex text. */
export function eventIdOfFiroLock(txid) {
  return hex(blake2b(new TextEncoder().encode(String(txid).toLowerCase()), { dkLen: 32 }));
}

// A check of Rosen's delivery shape, used by the protocol simulation (test/unit/rosen_sim.test.mjs),
// not by the app: no screen relies on it (second audit, X-misc).
/**
 * FIRO -> chain arrival: a transaction FROM Rosen's lock on that chain TO rsFIRO, calling
 * transfer(destination, delivered) with the lock's event id appended. tx: {from, to, input}.
 */
export function isEvmDelivery(tx, { to, destination, receive, lockTxid }) {
  if (!tx || String(tx.from).toLowerCase() !== LOCK[to] || String(tx.to).toLowerCase() !== RSFIRO[to]) return false;
  const d = String(tx.input ?? '').toLowerCase().replace(/^0x/, '');
  if (d.slice(0, 8) !== TRANSFER_SELECTOR) return false;
  if (`0x${d.slice(8 + 24, 8 + 64)}` !== String(destination).toLowerCase()) return false;
  if (BigInt(`0x${d.slice(8 + 64, 8 + 128) || '0'}`) !== BigInt(receive)) return false;
  return d.slice(8 + 128) === eventIdOfFiroLock(lockTxid);
}

// A check of Rosen's delivery shape, used by the protocol simulation (test/unit/rosen_sim.test.mjs),
// not by the app: no screen relies on it (second audit, X-misc).
/**
 * chain -> FIRO arrival: a FIRO transaction with an input signed by Rosen's FIRO lock address
 * paying `destination` at least `receive` and at most `receive + slack`. Rosen takes only what the
 * FIRO payout costs (~450 satoshi) of the declared 0.00500452 network fee, so a payout lands up to
 * the declared network fee above the estimate (measured: 2,984.99999548 for 2,984.99499548).
 */
export function isFiroPayout(rawHex, { destination, receive, slack = NETWORK_FEE.firo }, net = firoNetwork('main')) {
  let d;
  try {
    d = decodeTx(rawHex, net);
  } catch {
    return false;
  }
  const fromLock = d.vin.some((i) => {
    const pk = inputPubkey(i.scriptSig);
    return pk !== null && pubkeyToAddress(pk, net) === LOCK.firo;
  });
  if (!fromLock) return false;
  return d.vout.some((o) => o.address === destination && BigInt(o.value) >= BigInt(receive) && BigInt(o.value) <= BigInt(receive) + slack);
}

/** The public key a P2PKH input reveals (the last push of its scriptSig, 33 or 65 bytes), or null. */
export function inputPubkey(scriptSig) {
  if (!scriptSig || !scriptSig.length) return null;
  try {
    const ops = parseScript(scriptSig);
    const last = ops[ops.length - 1];
    return last && last.data && (last.data.length === 33 || last.data.length === 65) ? last.data : null;
  } catch {
    return null;
  }
}
