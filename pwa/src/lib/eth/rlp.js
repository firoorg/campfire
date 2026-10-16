// RLP, Ethereum's serialization for transactions. An item is a byte string
// (Uint8Array) or a list of items. Integers are encoded as minimal big-endian
// byte strings (0 → empty). Decoding accepts only the canonical encoding, so
// one transaction has exactly one byte form and therefore one hash.

import { bigIntToBytes, toBigInt, concatBytes } from './hex.js';

export class RlpError extends Error {
  constructor(message) {
    super(message);
    this.code = 'rlp';
  }
}

function lengthPrefix(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const lb = bigIntToBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + lb.length), lb);
}

/**
 * item: Uint8Array | bigint | non-negative safe integer | array of items.
 * Strings are refused on purpose: "0x12" could be hex or text.
 */
export function rlpEncode(item) {
  if (Array.isArray(item)) {
    const body = concatBytes(...item.map(rlpEncode));
    return concatBytes(lengthPrefix(body.length, 0xc0), body);
  }
  let bytes;
  if (item instanceof Uint8Array) bytes = item;
  else if (typeof item === 'bigint' || typeof item === 'number') {
    const v = toBigInt(item);
    if (v < 0n) throw new RlpError('negative integer');
    bytes = bigIntToBytes(v);
  } else throw new RlpError(`cannot encode ${typeof item}`);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return concatBytes(lengthPrefix(bytes.length, 0x80), bytes);
}

function readLength(data, pos, n) {
  if (pos + n > data.length) throw new RlpError('truncated length');
  if (data[pos] === 0) throw new RlpError('length with leading zero');
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + data[pos + i];
  if (len < 56) throw new RlpError('long form for a short length');
  if (!Number.isSafeInteger(len)) throw new RlpError('length too large');
  return len;
}

function decodeAt(data, pos) {
  if (pos >= data.length) throw new RlpError('truncated');
  const b = data[pos];
  if (b < 0x80) return { item: data.slice(pos, pos + 1), end: pos + 1 };
  if (b < 0xb8) {
    const len = b - 0x80;
    const end = pos + 1 + len;
    if (end > data.length) throw new RlpError('truncated string');
    if (len === 1 && data[pos + 1] < 0x80) throw new RlpError('single byte below 0x80 must be its own encoding');
    return { item: data.slice(pos + 1, end), end };
  }
  if (b < 0xc0) {
    const n = b - 0xb7;
    const len = readLength(data, pos + 1, n);
    const start = pos + 1 + n;
    if (start + len > data.length) throw new RlpError('truncated string');
    return { item: data.slice(start, start + len), end: start + len };
  }
  let start;
  let len;
  if (b < 0xf8) {
    len = b - 0xc0;
    start = pos + 1;
  } else {
    const n = b - 0xf7;
    len = readLength(data, pos + 1, n);
    start = pos + 1 + n;
  }
  const end = start + len;
  if (end > data.length) throw new RlpError('truncated list');
  const items = [];
  let p = start;
  while (p < end) {
    const r = decodeAt(data, p);
    if (r.end > end) throw new RlpError('item runs past its list');
    items.push(r.item);
    p = r.end;
  }
  return { item: items, end };
}

/** Bytes → item; refuses trailing bytes and every non-canonical form. */
export function rlpDecode(data) {
  if (!(data instanceof Uint8Array)) throw new RlpError('expected bytes');
  const { item, end } = decodeAt(data, 0);
  if (end !== data.length) throw new RlpError('trailing bytes');
  return item;
}

/** A decoded byte string as an integer; refuses leading zeros (not canonical). */
export function rlpToBigInt(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new RlpError('expected a byte string');
  if (bytes.length > 0 && bytes[0] === 0) throw new RlpError('integer with leading zero');
  if (bytes.length > 32) throw new RlpError('integer too large');
  let v = 0n;
  for (const x of bytes) v = (v << 8n) | BigInt(x);
  return v;
}
