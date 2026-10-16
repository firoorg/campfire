// Permit2, the way Uniswap's router is allowed to take a token. A port of
// the desktop app's lib/wallets/ethereum/uniswap/permit2.dart.
//
// 1. Once per token and amount, the token is approved to Permit2: an
//    ordinary on-chain approve, for exactly the amount being swapped (never
//    "unlimited").
// 2. For each swap the wallet signs a PermitSingle: this router may take this
//    amount of this token until a time half an hour away. The signature
//    travels inside the swap transaction (the router's PERMIT2_PERMIT
//    command), so it costs no extra transaction, and it is worthless after
//    the swap or after the half hour.
//
// The EIP-712 digest is tx.js's permitSingleDigest (checked in its tests
// against Permit2's DOMAIN_SEPARATOR() on chain). This file reads the
// allowances, builds the PermitSingle, and checks a signature before it goes
// into a transaction: 65 bytes, r ‖ s ‖ v with v 27 or 28, made by the owner.

import { encodeCall, abiDecode } from '../abi.js';
import { normAddress, parseRsvSignature, recoverAddress } from '../crypto.js';
import { toBytes } from '../hex.js';
import { permitSingleDigest, permit2PermitInput } from '../tx.js';
import { ADDRESSES } from './constants.js';

const MAX_U160 = (1n << 160n) - 1n;
const MAX_U48 = (1n << 48n) - 1n;

export class PermitError extends Error {
  constructor(message) {
    super(message);
    this.code = 'permit';
  }
}

/** The token's ERC-20 allowance from `owner` to Permit2. */
export async function tokenAllowance(rpc, token, owner, block = 'latest') {
  const r = await rpc.ethCall({ to: token, data: encodeCall('allowance(address,address)', [normAddress(owner), ADDRESSES.permit2]) }, block);
  return abiDecode('uint256', r)[0];
}

/** What Permit2 currently lets `spender` (the router) take of `owner`'s `token` → {amount, expiration, nonce}. */
export async function permitAllowance(rpc, token, owner, spender = ADDRESSES.universalRouter, block = 'latest') {
  const r = await rpc.ethCall({ to: ADDRESSES.permit2, data: encodeCall('allowance(address,address,address)', [normAddress(owner), normAddress(token), normAddress(spender)]) }, block);
  const [amount, expiration, nonce] = abiDecode('uint160,uint48,uint48', r);
  return { amount, expiration: Number(expiration), nonce: Number(nonce) };
}

/** Covers `needed` for at least another `margin` seconds after `now` (unix seconds). */
export function allowanceCovers(a, needed, now, margin = 120) {
  return a.amount >= needed && a.expiration > now + margin;
}

/**
 * The PermitSingle to sign: the router may take exactly `amount` of `token`
 * until now + life (seconds), with Permit2's current `nonce` for this
 * owner, token and spender.
 */
export function buildPermitSingle({ token, amount, nonce, now, life, spender = ADDRESSES.universalRouter }) {
  const a = BigInt(amount);
  if (a <= 0n || a > MAX_U160) throw new PermitError('A permit is for a positive amount that fits uint160.');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(life) || life <= 0) throw new PermitError('A permit needs a time and a lifetime.');
  if (!Number.isSafeInteger(nonce) || nonce < 0 || BigInt(nonce) > MAX_U48) throw new PermitError('Bad Permit2 nonce.');
  const until = now + life;
  if (BigInt(until) > MAX_U48) throw new PermitError('Bad permit expiry.');
  return Object.freeze({ token: normAddress(token), amount: a, expiration: until, nonce, spender: normAddress(spender), sigDeadline: BigInt(until) });
}

/** The 32-byte EIP-712 digest the wallet signs. */
export function permitDigest(permit) {
  return permitSingleDigest(permit);
}

/**
 * Refuses a signature Permit2 would not take from `owner`: not 65 bytes,
 * v not 27/28 at the end (r ‖ s ‖ v order), or made by another key.
 * Returns the bytes.
 */
export function checkPermitSignature(permit, signature, owner) {
  const sig = toBytes(signature);
  if (sig.length !== 65) throw new PermitError('A permit signature is 65 bytes.');
  if (sig[64] !== 27 && sig[64] !== 28) throw new PermitError('A permit signature ends with v = 27 or 28 (r ‖ s ‖ v).');
  let signer;
  try {
    signer = recoverAddress(permitDigest(permit), parseRsvSignature(sig));
  } catch {
    throw new PermitError('The permit signature does not verify.');
  }
  if (signer.toLowerCase() !== normAddress(owner)) throw new PermitError('The permit was signed by another key.');
  return sig;
}

/** The router's PERMIT2_PERMIT input: abi.encode(PermitSingle, bytes signature). */
export function permitRouterInput(permit, signature) {
  return permit2PermitInput(permit, toBytes(signature));
}

/** approve(Permit2, amount) calldata, for the token being paid with. */
export function approvePermit2Call(amount) {
  return encodeCall('approve(address,uint256)', [ADDRESSES.permit2, BigInt(amount)]);
}
