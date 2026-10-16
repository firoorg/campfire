// Bytes, hex and big-endian integers for the Ethereum code. Everything that
// leaves or enters JSON-RPC is 0x-hex; everything inside is Uint8Array or
// BigInt. Parsing is strict (no odd lengths, no stray characters) because a
// silently truncated or padded value is a different value on chain.

export class HexError extends Error {
  constructor(message) {
    super(message);
    this.code = 'hex';
  }
}

const HEX_RE = /^[0-9a-fA-F]*$/;

export function strip0x(s) {
  return typeof s === 'string' && (s.startsWith('0x') || s.startsWith('0X')) ? s.slice(2) : s;
}

/** '0x…' or bare hex of even length → bytes. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string') throw new HexError('expected a hex string');
  const h = strip0x(hex);
  if (h.length % 2 !== 0 || !HEX_RE.test(h)) throw new HexError(`not even-length hex: ${hex.length > 24 ? hex.slice(0, 24) + '…' : hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes, prefix = true) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return prefix ? `0x${s}` : s;
}

/** Bytes as given, or decoded from hex. */
export function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return hexToBytes(v);
  throw new HexError('expected bytes or a hex string');
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
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function utf8ToBytes(s) {
  return new TextEncoder().encode(s);
}

/** Big-endian unsigned integer. */
export function bytesToBigInt(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

/** Non-negative integer → big-endian bytes: minimal (0 → empty) or left-padded to `length`. */
export function bigIntToBytes(value, length) {
  let v = toBigInt(value);
  if (v < 0n) throw new HexError('negative integer');
  const out = [];
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if (length === undefined) return Uint8Array.from(out);
  if (out.length > length) throw new HexError(`integer does not fit in ${length} bytes`);
  const padded = new Uint8Array(length);
  padded.set(out, length - out.length);
  return padded;
}

/** bigint, safe integer, or a decimal / 0x string → BigInt; anything else throws. */
export function toBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new HexError(`not a safe integer: ${v}`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|-?\d+)$/.test(v)) return BigInt(v);
  throw new HexError(`not an integer: ${String(v).slice(0, 40)}`);
}

/** JSON-RPC QUANTITY: '0x' + minimal hex ('0x0' for zero). */
export function toQuantity(v) {
  const n = toBigInt(v);
  if (n < 0n) throw new HexError('negative quantity');
  return `0x${n.toString(16)}`;
}

/** JSON-RPC QUANTITY → BigInt. Some nodes answer '0x' for zero; that is accepted. */
export function fromQuantity(q) {
  if (typeof q !== 'string' || !/^0x[0-9a-fA-F]*$/.test(q)) throw new HexError(`not a quantity: ${String(q).slice(0, 40)}`);
  return q === '0x' ? 0n : BigInt(q);
}

/** A QUANTITY that must fit a JS number (block numbers, indexes). */
export function fromQuantityNumber(q) {
  const n = fromQuantity(q);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new HexError('quantity too large');
  return Number(n);
}
