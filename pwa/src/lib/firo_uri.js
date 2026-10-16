// Firo addresses and "firo:" payment links, by their shape only. Pure: no network, no checksum.
// The engine (lib/wallet.js classifyAddress) checks an address for real before anything is paid;
// this module only says what a pasted or scanned text looks like, so a scan lands on the right
// screen and the address book refuses obvious junk.
//
// Shapes (Firo mainnet, as the Campfire app knows them: lib/wallets/crypto_currency/coins/firo.dart,
// libspark util.h):
//   spark        "sm1…": bech32m, human part "sm", 60+ data characters (about 144 in all).
//                Testnet Spark addresses start "st1…"; this app is mainnet only, so they are not one.
//   transparent  base58, 34 characters, starting with "a" or "Z" (P2PKH version 0x52).
//   exchange     "EX…": base58, Firo's exchange addresses (they take payments from a public
//                balance only; the engine enforces it).
//   spark-name   "@alice": letters, digits, "." and "-", up to 20 characters after the "@". The
//                "@" is what marks a name here; the engine resolves it to a Spark address.
//
// A "firo:" link (BIP21 style, as Campfire's address_utils.dart reads it):
//   firo:<address>?amount=1.5&label=…&message=…&memo=…
// amount is FIRO with at most 8 decimals; message fills the Spark memo when the link has no memo
// of its own and the address is a Spark address (firo-qt treats message as the Spark memo).

import { parseAmount, formatAmount, toInputString } from './amount.js';

export const FIRO_SCHEME = 'firo';
/** Spark memos are this long at most (Campfire's send screen); a longer one from a link is cut here. */
const MEMO_KEEP = 256;

const SPARK = /^sm1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{60,}$/;
const TRANSPARENT = /^[aZ][1-9A-HJ-NP-Za-km-z]{33}$/;
const EXCHANGE = /^EX[1-9A-HJ-NP-Za-km-z]{30,40}$/;
const NAME = /^@([a-zA-Z0-9][a-zA-Z0-9.-]{0,19})$/;
const AMOUNT = /^(\d+(\.\d+)?|\.\d+)$/;

const decode = (x) => {
  try {
    return decodeURIComponent(x.replace(/\+/g, ' '));
  } catch {
    return x;
  }
};

/** Printable text only, single-spaced: what a link may put in a field. */
function clean(raw, max = MEMO_KEEP) {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, max).join('');
}

/**
 * What `text` looks like: 'spark' | 'transparent' | 'exchange' | 'spark-name', or null.
 * Spaces and line breaks inside an address (a paste split across lines) are ignored; a Spark
 * address in capitals (some QR encoders upper-case bech32) counts.
 */
export function addressShape(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s) return null;
  if (NAME.test(s)) return 'spark-name';
  if (SPARK.test(s) || (s === s.toUpperCase() && SPARK.test(s.toLowerCase()))) return 'spark';
  if (EXCHANGE.test(s)) return 'exchange';
  if (TRANSPARENT.test(s)) return 'transparent';
  return null;
}

/** The address as it is kept and sent: no spaces; a Spark address in lower case. */
export function normalizeAddress(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  return addressShape(s) === 'spark' ? s.toLowerCase() : s;
}

/** The name in "@alice" (lower case), or null. */
export function sparkNameOf(text) {
  const m = NAME.exec(String(text ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * A "firo:" link -> {address, shape, amount (BigInt sats) | null, label, message, memo} or null when
 * `text` is not a firo: link. address is '' when the link holds no address this app knows (the
 * caller says so). A bad amount is left out, never guessed.
 */
export function parseFiroUri(text) {
  const s = String(text ?? '').trim();
  const m = /^firo:(?:\/\/)?([^?#]*)(?:\?([^#]*))?/i.exec(s);
  if (!m) return null;
  const raw = decode(m[1]).replace(/\s+/g, '');
  const shape = addressShape(raw);
  const address = shape ? normalizeAddress(raw) : '';
  const params = {};
  for (const part of (m[2] || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decode(i < 0 ? part : part.slice(0, i)).toLowerCase();
    if (!(k in params)) params[k] = decode(i < 0 ? '' : part.slice(i + 1));
  }
  // BIP21: a parameter starting "req-" must be understood, or the link is not to be paid. One this
  // wallet does not know: refused, and named (public audit, PN: it was ignored).
  const required = Object.keys(params).filter((k) => k.startsWith('req-'));
  if (required.length) return { address: '', shape: null, amount: null, label: '', message: '', memo: '', required };
  let amount = null;
  if (params.amount != null && AMOUNT.test(params.amount)) {
    try {
      const v = parseAmount(params.amount);
      if (v > 0n) amount = v;
    } catch {
      amount = null;
    }
  }
  const label = params.label != null ? clean(params.label, 100) : '';
  const message = params.message != null ? clean(params.message) : '';
  let memo = params.memo != null ? clean(params.memo) : '';
  if (!memo && message && shape === 'spark') memo = message;
  return { address, shape, amount, label, message, memo: shape === 'spark' ? memo : '' };
}

/**
 * The "firo:" link Receive shows as a QR code: the address, and the amount when one is asked for.
 * Without an amount, the plain address (every wallet reads that).
 */
export function firoUri({ address, amount = null, memo = '', label = '' } = {}) {
  const a = normalizeAddress(address);
  if (!addressShape(a) || addressShape(a) === 'spark-name') throw new Error('not a Firo address');
  const q = [];
  if (amount != null && BigInt(amount) > 0n) q.push(`amount=${toInputString(BigInt(amount))}`);
  if (label) q.push(`label=${encodeURIComponent(clean(label, 100))}`);
  if (memo && addressShape(a) === 'spark') q.push(`memo=${encodeURIComponent(clean(memo))}`);
  return q.length ? `${FIRO_SCHEME}:${a}?${q.join('&')}` : a;
}

/** "1.5" from sats, as the amount field holds it. */
export const amountText = (sats) => formatAmount(sats, { group: false });
