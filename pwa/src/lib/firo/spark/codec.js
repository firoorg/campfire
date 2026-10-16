// SPDX-License-Identifier: MIT
// The byte codec between JS and the Spark wasm exports (C++ side: pwa/spark/src/codec.h).
//
// Fields, little endian, no padding: u8, u32, i32, u64, i64, bytes/str (u32 length then
// the bytes; str = UTF-8), fixed(N) (exactly N bytes). The Writer only collects the parts
// and their total length, so a 32,768-coin anonymity set is copied once, straight into
// wasm memory, and never concatenated or turned into JSON on the JS side.

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

export class SparkError extends Error {
  constructor(message, code = 'spark') {
    super(message);
    this.name = 'SparkError';
    this.code = code;
  }
}

export function invalid(message) {
  return new SparkError(message, 'invalid-argument');
}

// ---- conversions --------------------------------------------------------------------------

const HEX = /^[0-9a-fA-F]*$/;

export function hexToBytes(hex, what = 'hex') {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX.test(hex)) throw invalid(`${what} must be an even-length hex string`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Uint8Array | ArrayBuffer | DataView/TypedArray view | hex string -> Uint8Array (no copy for Uint8Array). */
export function toBytes(v, what = 'bytes') {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return hexToBytes(v, what);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw invalid(`${what} must be bytes (Uint8Array) or hex`);
}

export function fixedBytes(v, n, what) {
  const b = toBytes(v, what);
  if (b.length !== n) throw invalid(`${what} must be ${n} bytes, got ${b.length}`);
  return b;
}

export function reversedHex(hex, what) {
  const b = hexToBytes(hex, what);
  b.reverse();
  return b;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** Amount-like input (decimal string, bigint or safe integer) -> bigint. */
export function toBigInt(v, what = 'amount') {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw invalid(`${what} must be an integer (use a string or bigint above 2^53)`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^-?[0-9]+$/.test(v)) return BigInt(v);
  throw invalid(`${what} must be an integer, a decimal string or a bigint`);
}

export function toU32(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw invalid(`${what} must be an integer 0..4294967295`);
  return v;
}

export function toI32(v, what) {
  if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw invalid(`${what} must be a 32-bit integer`);
  return v;
}

// ---- writer -------------------------------------------------------------------------------

export class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
    this.small = new Uint8Array(64);
    this.smallLen = 0;
  }

  flushSmall() {
    if (this.smallLen) {
      this.parts.push(this.small.slice(0, this.smallLen));
      this.smallLen = 0;
    }
  }

  push(b) {
    if (b.length <= 16) {
      if (this.smallLen + b.length > this.small.length) this.flushSmall();
      this.small.set(b, this.smallLen);
      this.smallLen += b.length;
    } else {
      this.flushSmall();
      this.parts.push(b);
    }
    this.length += b.length;
    return this;
  }

  u8(v) {
    if (!Number.isInteger(v) || v < 0 || v > 255) throw invalid('u8 out of range');
    return this.push(Uint8Array.of(v));
  }

  flag(v) {
    return this.u8(v ? 1 : 0);
  }

  u32(v, what = 'value') {
    toU32(v, what);
    return this.push(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff));
  }

  i32(v, what = 'value') {
    toI32(v, what);
    return this.u32(v >>> 0);
  }

  u64(v, what = 'value') {
    const n = toBigInt(v, what);
    if (n < 0n || n > U64_MAX) throw invalid(`${what} must be 0..2^64-1`);
    return this.push(le64(n));
  }

  i64(v, what = 'value') {
    const n = toBigInt(v, what);
    if (n < I64_MIN || n > I64_MAX) throw invalid(`${what} must fit in 64 signed bits`);
    return this.push(le64(BigInt.asUintN(64, n)));
  }

  bytes(b) {
    this.u32(b.length, 'length');
    if (b.length) this.push(b);
    return this;
  }

  str(s) {
    if (typeof s !== 'string') throw invalid('expected a string');
    return this.bytes(enc.encode(s));
  }

  fixed(b, n, what) {
    if (b.length !== n) throw invalid(`${what} must be ${n} bytes`);
    return this.push(b);
  }

  /** Appends an already encoded run of fields (e.g. a packed coin list). */
  raw(b) {
    if (b.length) this.push(b);
    return this;
  }

  /** Copies everything into dst (a Uint8Array view of exactly this.length bytes). */
  writeInto(dst) {
    this.flushSmall();
    let off = 0;
    for (const p of this.parts) {
      dst.set(p, off);
      off += p.length;
    }
    if (off !== this.length) throw new SparkError('codec: length mismatch');
  }

  toBytes() {
    const out = new Uint8Array(this.length);
    this.writeInto(out);
    return out;
  }
}

function le64(n) {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}

// ---- reader -------------------------------------------------------------------------------

export class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.off = 0;
  }

  need(n) {
    if (n > this.b.length - this.off) throw new SparkError('codec: truncated result');
  }

  u8() {
    this.need(1);
    return this.b[this.off++];
  }

  u32() {
    this.need(4);
    const b = this.b;
    const o = this.off;
    this.off += 4;
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  i32() {
    return this.u32() | 0;
  }

  u64() {
    this.need(8);
    let n = 0n;
    for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(this.b[this.off + i]);
    this.off += 8;
    return n;
  }

  i64() {
    return BigInt.asIntN(64, this.u64());
  }

  bytes() {
    const n = this.u32();
    return this.fixed(n);
  }

  str() {
    return dec.decode(this.bytes());
  }

  fixed(n) {
    this.need(n);
    const out = this.b.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }

  rest() {
    return this.fixed(this.b.length - this.off);
  }

  end() {
    if (this.off !== this.b.length) throw new SparkError('codec: trailing bytes in result');
  }
}

export function utf8(s) {
  return enc.encode(s);
}

export function fromUtf8(b) {
  return dec.decode(b);
}

// ---- packed coin lists ------------------------------------------------------------------------

/**
 * Packs coins for spark_identify_coins / anonymity sets without per-call re-encoding:
 *   identify: [{ coin, context }]  ->  { count, data }   data = count * (bytes coin, bytes context)
 *   sets:     [coin, ...]           ->  { count, data }   data = count * (bytes coin)
 * A wallet can keep sets in this form (e.g. in IndexedDB) and pass them as they are.
 */
export function packCoins(coins, withContext) {
  const w = new Writer();
  for (const c of coins) {
    if (withContext) {
      w.bytes(toBytes(c.coin ?? c.serializedCoin, 'coin'));
      w.bytes(toBytes(c.context ?? c.serializedCoinContext ?? new Uint8Array(0), 'context'));
    } else {
      w.bytes(toBytes(c, 'coin'));
    }
  }
  return { count: coins.length, data: w.toBytes() };
}

export function isPacked(v) {
  return v && typeof v === 'object' && Number.isInteger(v.count) && v.data instanceof Uint8Array;
}
