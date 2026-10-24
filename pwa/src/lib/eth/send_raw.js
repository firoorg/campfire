// A token payment with extra bytes after its arguments, on Ethereum or BNB Chain, for features
// built elsewhere that need one (the Rosen bridge's exit: rsFIRO.transfer(lock, amount) followed
// by Rosen's payload, lib/rosen/). The caller says what it means in words; the person sees only
// that, the address it goes to and the network fee (screens/eth_raw_review.js: never "raw data",
// never hex), confirms with Face ID or the password, and it is signed, saved to the outbox and
// broadcast like any payment from this wallet.
//
//   sendRaw(app, { chain, to, data, value = 0n, meaning, allow })
//     chain    'ethereum' | 'bsc' (or 1 | 56)
//     to       the token contract: rsFIRO on that chain unless `allow` names others (addresses)
//     data     0xa9059cbb ‖ recipient ‖ amount ‖ any extra bytes (hex string or bytes)
//     value    must be 0: a token call carries no ETH or BNB
//     meaning  {title, amountText, rows: [[label, value], …], warning}: what the person reads
//   -> Promise<{hash, refused}>, or rejects with an Error whose .message is plain words; .code
//      'cancelled' when the person backed out, 'refused' when the call breaks a rule here,
//      'locked' when there is no unlocked EVM wallet, 'not_enough' when the balance is short.
//      refused: true when the chain's server refused the signed bytes. It has most likely not
//      left, but the server may have passed it on first, so it is signed, saved and followed
//      (lib/eth/send.js) and the person is on its status screen ("Not sent yet"): the caller
//      must neither say it was sent nor offer to send it again.
//
// Also the two read helpers the bridge screen needs: evmAddress(app), tokenBalance(app, chain, symbol).

import { decodeCall } from './abi.js';
import { toBytes, bytesToHex } from './hex.js';
import { isAddress, toChecksumAddress } from './crypto.js';
import { chainOf } from './chains.js';
import { tokensFor, rsfiroOn, tokenBySymbol } from './tokens.js';
import { t } from '../i18n.js';

export const TRANSFER_SELECTOR = '0xa9059cbb';
const MAX_EXTRA_BYTES = 1024;
const MAX_TEXT = 200;

export class RawSendError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'cancelled' | 'refused' | 'locked' | 'not_enough' | 'server'
  }
}

const clean = (v, max = MAX_TEXT) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** The caller's words, cleaned: printable, short, at most 8 rows. Throws when there is no title or amount. */
export function cleanMeaning(meaning) {
  const m = meaning && typeof meaning === 'object' ? meaning : {};
  const title = clean(m.title, 80);
  const amountText = clean(m.amountText, 80);
  if (!title || !amountText) throw new RawSendError('refused', t('The request does not say what it does, so nothing is shown or sent.'));
  const rows = (Array.isArray(m.rows) ? m.rows : [])
    .filter((r) => Array.isArray(r) && r.length >= 2)
    .slice(0, 8)
    .map(([k, v]) => [clean(k, 40), clean(v)])
    .filter(([k, v]) => k && v);
  return { title, amountText, rows, warning: clean(m.warning, 400) || null };
}

/**
 * Checks a raw token call against the rules, without asking anyone:
 * -> {chain, token, to (checksummed), recipient (checksummed), amount (bigint), extraBytes, data (hex)}.
 * Throws RawSendError('refused') with the reason in words.
 */
export function checkRawCall({ chain, to, data, value = 0n, allow = null }) {
  let c;
  try {
    c = chainOf(chain);
  } catch {
    throw new RawSendError('refused', t('This can only be sent on Ethereum or BNB Chain.'));
  }
  if (typeof to !== 'string' || !isAddress(to)) throw new RawSendError('refused', t('The contract address is not a valid address.'));
  const target = to.toLowerCase();
  const allowed = Array.isArray(allow) && allow.length ? allow.map((a) => String(a).toLowerCase()) : [rsfiroOn(c.key).address];
  if (!allowed.includes(target)) throw new RawSendError('refused', t('Only a payment of rsFIRO on {name} can be sent this way.', { name: c.name }));
  const token = tokensFor(c.key).find((token) => token.address === target);
  if (!token) throw new RawSendError('refused', t('That contract is not a token this wallet knows on {name}.', { name: c.name }));
  let v;
  try {
    v = BigInt(value);
  } catch {
    throw new RawSendError('refused', t('The amount of coin attached is not a number.'));
  }
  if (v !== 0n) throw new RawSendError('refused', t('A token payment carries no {symbol}.', { symbol: c.native.symbol }));
  let bytes;
  try {
    bytes = toBytes(data);
  } catch {
    throw new RawSendError('refused', t('The payment data could not be read.'));
  }
  if (bytes.length < 68 || bytesToHex(bytes.subarray(0, 4)) !== TRANSFER_SELECTOR) throw new RawSendError('refused', t('Only a token transfer can be sent this way.'));
  if (bytes.length - 68 > MAX_EXTRA_BYTES) throw new RawSendError('refused', t('The extra information is too long.'));
  let recipient;
  let amount;
  try {
    [recipient, amount] = decodeCall('transfer(address,uint256)', bytes.subarray(0, 68));
  } catch {
    throw new RawSendError('refused', t('The token transfer could not be read.'));
  }
  if (amount <= 0n) throw new RawSendError('refused', t('The amount must be more than zero.'));
  if (/^0x0{40}$/i.test(recipient)) throw new RawSendError('refused', t('The payment goes to the zero address: it would be lost.'));
  return { chain: c, token, to: toChecksumAddress(target), recipient: toChecksumAddress(recipient), amount, extraBytes: bytes.length - 68, data: bytesToHex(bytes) };
}

// ---------------------------------------------------------------- the review screen's requests

const pending = new Map();
let nextId = 1;

/** The request the review screen shows (screens/eth_raw_review.js). */
export function rawRequest(id) {
  return pending.get(Number(id)) || null;
}

/**
 * Claims request `id` for one review screen: true the first time only. A second review over the same
 * request (the first left while it signs, then Back) gets false and must never offer it again: it
 * would sign a second payment (release audit 0.1.7, verification 2).
 */
export function claimRawRequest(id) {
  const r = pending.get(Number(id));
  if (!r || r.claimed) return false;
  r.claimed = true;
  return true;
}

/**
 * What the review tells its caller once the call was signed and broadcast (lib/eth/send.js
 * broadcast()'s {entry, sent}): {hash, sent, refused}. sent false: the server did not take it,
 * refused (refused: true) or no answer at all (a network error): either way it is followed on
 * its status screen, and it is not "sent" (audit FM-4).
 */
export function rawOutcome(r) {
  return { hash: r.entry.hash, sent: Boolean(r.sent), refused: !r.sent && Boolean(r.entry.refusedAt) };
}

/** Ends a request once: resolve({hash, sent, refused}) or reject(error). */
export function settleRawRequest(id, { hash = null, error = null, refused = false, sent = true } = {}) {
  const r = pending.get(Number(id));
  if (!r) return;
  pending.delete(Number(id));
  if (error) r.reject(error);
  else r.resolve({ hash, sent: sent !== false, refused: Boolean(refused) });
}

/**
 * Opens the review for a raw token call; resolves with {hash, sent, refused} once it was signed
 * and broadcast (sent false: the server did not take it, or did not answer; refused: it said no,
 * though it may have passed it on), or rejects in plain
 * words (code 'cancelled' when the person backs out).
 */
export async function sendRaw(app, { chain, to, data, value = 0n, meaning, allow = null, notAfter = null, lateText = null } = {}) {
  const call = checkRawCall({ chain, to, data, value, allow });
  const words = cleanMeaning(meaning);
  // A request that holds only until a time (the Bridge's price): its review signs nothing after it,
  // however long it stays open (second audit of 0.1.8, N2).
  if (Number.isFinite(notAfter)) Object.assign(words, { notAfter, lateText: clean(lateText, 300) || t('This request is too old to sign now. Go back and start it again.') });
  const { ethWallet } = await import('./wallet.js');
  let w;
  try {
    w = await ethWallet(app);
  } catch {
    throw new RawSendError('locked', t('Unlock the wallet first.'));
  }
  if (!w) throw new RawSendError('locked', t('There is no Ethereum / BNB Chain wallet on this device yet.'));
  const c = await w.refreshChain(call.chain.key);
  if (c.error) throw new RawSendError('server', t('{name}\'s server didn\'t answer: {message}', { name: call.chain.name, message: c.error.message }));
  // What may be sent: the balance less what transactions still on their way hold (release audit 0.1.6).
  const have = w.spendableOf(call.chain.key, call.token);
  if (have == null) throw new RawSendError('server', t('The {symbol} balance on {name} is not known yet. Try again in a moment.', { symbol: call.token.symbol, name: call.chain.name }));
  if (call.amount > have) throw new RawSendError('not_enough', w.heldOf(call.chain.key, call.token) > 0n ? t('That\'s more {symbol} than this wallet can send now on {name}: some of it is held for a transaction still on its way.', { symbol: call.token.symbol, name: call.chain.name }) : t('That\'s more {symbol} than this wallet has on {name}.', { symbol: call.token.symbol, name: call.chain.name }));
  return openRawRequest(app, call, words);
}

/** Registers a checked call for the review screen and opens it; settles with what the review says. */
export function openRawRequest(app, call, words, { watchMs = 1000 } = {}) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { id, call, words, resolve, reject, back: app.currentName || 'ethHome', backParams: app.params || {} });
    app.go('ethRawReview', { id });
  });
  // Never claimed by a review (left before its screen loaded, its load failed, or the app went to
  // Unlock or another tab instead): "cancelled" once the review is no longer on screen, so nothing
  // waits for it for ever (the Bridge would say "still being sent" until a reload).
  const watch = () => {
    const r = pending.get(id);
    if (!r || r.claimed) return;
    if (app.currentName !== 'ethRawReview') return settleRawRequest(id, { error: new RawSendError('cancelled', t('Cancelled: nothing was sent.')) });
    setTimeout(watch, watchMs);
  };
  setTimeout(watch, 0);
  return promise;
}

// ---------------------------------------------------------------- read helpers

/** The EVM wallet's address ('0x…', checksummed), or null when there is none (or it is locked). */
export async function evmAddress(app) {
  try {
    const { ethWallet } = await import('./wallet.js');
    const w = await ethWallet(app);
    return w ? toChecksumAddress(w.state.address) : null;
  } catch {
    return null;
  }
}

/**
 * What can be sent of `symbol` ('rsFIRO', 'USDT', or the chain's coin 'ETH' / 'BNB') on `chain`
 * ('ethereum' | 'bsc', or 1 | 56), in base units (rsFIRO: 8 decimals): the balance less what
 * transactions still on their way hold (release audit 0.1.6); null when unknown. Asks the chain's
 * server once when nothing was read yet.
 */
export async function tokenBalance(app, chain, symbol) {
  let c;
  try {
    c = chainOf(chain);
  } catch {
    return null;
  }
  const asset = tokenBySymbol(symbol, c.key);
  if (!asset) return null;
  try {
    const { ethWallet } = await import('./wallet.js');
    const w = await ethWallet(app);
    if (!w) return null;
    if (w.chain(c.key).checkedAt == null) await w.refreshChain(c.key);
    const v = w.spendableOf(c.key, asset);
    return typeof v === 'bigint' ? v : null;
  } catch {
    return null;
  }
}
