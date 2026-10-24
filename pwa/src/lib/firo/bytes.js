// Bytes for the Firo code: hex, base64, little-endian integers, Bitcoin
// CompactSize, and the two hashes every Bitcoin-family chain uses (SHA256d for
// ids and checksums, HASH160 for addresses). Strict parsing throughout: a
// silently truncated byte string is a different transaction.
//
// Two orders for 32-byte hashes, as in Firo Core: "internal" (the bytes as
// hashed and as serialized in transactions) and "display" (reversed, the hex
// people and ElectrumX use for txids and block hashes).
// i18n-ignore-file: byte and hex helpers: a message here means malformed data from a bug or a server, shown as it is

import { sha256 } from '../../vendor/noble/noble-hashes/sha2.js';
import { ripemd160 } from '../../vendor/noble/noble-hashes/legacy.js';

export class BytesError extends Error {
  constructor(message) {
    super(message);
    this.code = 'bytes';
  }
}

const HEX_RE = /^[0-9a-fA-F]*$/;

/** Even-length hex (no 0x) → bytes. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new BytesError(`Not even-length hex: ${String(hex).slice(0, 24)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Bytes → lowercase hex, no prefix. */
export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** A reversed copy. */
export function reverse(bytes) {
  return Uint8Array.from(bytes).reverse();
}

/** Display hex (txid, block hash) → internal byte order. */
export function hashFromHex(hex) {
  const b = hexToBytes(hex);
  if (b.length !== 32) throw new BytesError('A hash is 32 bytes.');
  return b.reverse();
}

/** Internal byte order → display hex. */
export function hashToHex(bytes) {
  if (bytes.length !== 32) throw new BytesError('A hash is 32 bytes.');
  return bytesToHex(reverse(bytes));
}

export function concatBytes(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function utf8ToBytes(s) {
  return new TextEncoder().encode(s);
}

/** Strict UTF-8 → string; throws on invalid sequences. */
export function bytesToUtf8(b) {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();

/** Standard base64 (with padding), as firod's EncodeBase64 writes it. */
export function base64ToBytes(s) {
  if (typeof s !== 'string' || s.length % 4 !== 0) throw new BytesError('Not base64.');
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  const n = (s.length / 4) * 3 - pad;
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((j) => {
      const c = s.charCodeAt(i + j);
      if (c === 61 && i + j >= s.length - pad) return 0; // '='
      const x = c < 128 ? B64_INDEX[c] : -1;
      if (x < 0) throw new BytesError('Not base64.');
      return x;
    });
    const w = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < n) out[o++] = (w >> 16) & 0xff;
    if (o < n) out[o++] = (w >> 8) & 0xff;
    if (o < n) out[o++] = w & 0xff;
  }
  return out;
}

export function bytesToBase64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const w = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(w >> 18) & 63] + B64[(w >> 12) & 63];
    s += i + 1 < b.length ? B64[(w >> 6) & 63] : '=';
    s += i + 2 < b.length ? B64[w & 63] : '=';
  }
  return s;
}

/** SHA-256 twice: txids, block hashes, base58 checksums. */
export function sha256d(data) {
  return sha256(sha256(data));
}

/** RIPEMD-160 of SHA-256: the 20 bytes in a P2PKH address. */
export function hash160(data) {
  return ripemd160(sha256(data));
}

export { sha256 };

// ---------------------------------------------------------------- reading

/** A cursor over bytes; every read checks it stays inside them. */
export class Reader {
  constructor(bytes, offset = 0) {
    this.b = bytes;
    this.o = offset;
  }

  get remaining() {
    return this.b.length - this.o;
  }

  need(n) {
    if (n < 0 || this.o + n > this.b.length) throw new BytesError('Unexpected end of data.');
  }

  bytes(n) {
    this.need(n);
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }

  u8() {
    this.need(1);
    return this.b[this.o++];
  }

  u16() {
    this.need(2);
    const v = this.b[this.o] | (this.b[this.o + 1] << 8);
    this.o += 2;
    return v;
  }

  u32() {
    this.need(4);
    const v = (this.b[this.o] | (this.b[this.o + 1] << 8) | (this.b[this.o + 2] << 16)) + this.b[this.o + 3] * 0x1000000;
    this.o += 4;
    return v;
  }

  i32() {
    const v = this.u32();
    return v >= 0x80000000 ? v - 0x100000000 : v;
  }

  u64() {
    const lo = BigInt(this.u32());
    const hi = BigInt(this.u32());
    return (hi << 32n) | lo;
  }

  /** Bitcoin CompactSize; refuses non-canonical encodings like Firo Core does. */
  varint() {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = this.u16();
      if (v < 0xfd) throw new BytesError('Non-canonical CompactSize.');
      return v;
    }
    if (first === 0xfe) {
      const v = this.u32();
      if (v < 0x10000) throw new BytesError('Non-canonical CompactSize.');
      return v;
    }
    const v = this.u64();
    if (v < 0x100000000n) throw new BytesError('Non-canonical CompactSize.');
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new BytesError('CompactSize too large.');
    return Number(v);
  }

  /** CompactSize length then that many bytes. */
  varbytes(max = 0x02000000) {
    const n = this.varint();
    if (n > max) throw new BytesError('Length too large.');
    return this.bytes(n);
  }
}

// ---------------------------------------------------------------- writing

/** Collects parts and joins them once. */
export class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(b) {
    this.parts.push(b);
    this.length += b.length;
    return this;
  }

  u8(v) {
    return this.push(Uint8Array.of(v & 0xff));
  }

  u16(v) {
    return this.push(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff));
  }

  u32(v) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new BytesError(`Not a uint32: ${v}`);
    return this.push(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff));
  }

  i32(v) {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new BytesError(`Not an int32: ${v}`);
    return this.u32(v >>> 0);
  }

  u64(v) {
    let x = BigInt(v);
    if (x < 0n || x >= 1n << 64n) throw new BytesError('Not a uint64.');
    const out = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return this.push(out);
  }

  varint(n) {
    return this.push(compactSize(n));
  }

  varbytes(b) {
    return this.varint(b.length).push(b);
  }

  toBytes() {
    return concatBytes(...this.parts);
  }
}

/** Bitcoin CompactSize encoding of a non-negative integer. */
export function compactSize(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new BytesError(`Bad length: ${n}`);
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >>> 8);
  if (n <= 0xffffffff) return Uint8Array.of(0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);
  const w = new Writer();
  w.u8(0xff).u64(n);
  return w.toBytes();
}
