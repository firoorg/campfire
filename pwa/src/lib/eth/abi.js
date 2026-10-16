// A small Solidity ABI codec, a port of the desktop app's
// lib/wallets/ethereum/uniswap/abi.dart: the types Uniswap and the token transfers
// calls use (uintN/intN, address, bool, bytes, bytesN, string, T[] and
// tuples, nested), encoded exactly as `abi.encode` does, so every byte a
// transaction carries is visible here and pinned by tests against Foundry's
// `cast calldata` / `cast abi-encode`.
//
// Values: uint/int → bigint (a safe integer or decimal/0x string is
// accepted), address → '0x…' string, bool → boolean, bytes/bytesN →
// Uint8Array (or 0x-hex), string → string, arrays and tuples → arrays.
//
// Decoding is stricter than the Dart port, because results come from an RPC
// server: offsets and lengths must stay inside the data, and padding must be
// clean (a uint8 whose word has other bits set, or a bool of 2, is refused).

import { keccak256, isAddress, toChecksumAddress } from './crypto.js';
import { bytesToHex, toBytes, toBigInt, bigIntToBytes, bytesToBigInt, concatBytes } from './hex.js';

export class AbiError extends Error {
  constructor(message) {
    super(message);
    this.code = 'abi';
  }
}

const WORD = 32;
const TWO256 = 1n << 256n;

function word(v) {
  return bigIntToBytes(v, WORD);
}

function readWord(data, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + WORD > data.length) throw new AbiError('ABI data too short');
  return bytesToBigInt(data.subarray(offset, offset + WORD));
}

function readOffset(data, at) {
  const v = readWord(data, at);
  if (v > BigInt(data.length)) throw new AbiError('ABI offset out of range');
  return Number(v);
}

function intValue(value, what) {
  try {
    return toBigInt(value);
  } catch {
    throw new AbiError(`${what}: not an integer`);
  }
}

/** Parses "uint256", "(address,bool,bytes)[]", "((address,uint24),bytes)". */
export function parseType(type) {
  const t = String(type).replace(/\s+/g, '');
  if (t.endsWith('[]')) return { kind: 'array', element: parseType(t.slice(0, -2)), dynamic: true };
  if (/\[\d+\]$/.test(t)) throw new AbiError(`fixed-size arrays are not supported: ${t}`);
  if (t.startsWith('(')) {
    if (!t.endsWith(')')) throw new AbiError(`bad tuple: ${t}`);
    const inner = t.slice(1, -1);
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '(') depth++;
      else if (inner[i] === ')') depth--;
      else if (inner[i] === ',' && depth === 0) {
        parts.push(inner.slice(start, i));
        start = i + 1;
      }
      if (depth < 0) throw new AbiError(`bad tuple: ${t}`);
    }
    if (depth !== 0) throw new AbiError(`bad tuple: ${t}`);
    if (inner.length) parts.push(inner.slice(start));
    const components = parts.map(parseType);
    return { kind: 'tuple', components, dynamic: components.some((c) => c.dynamic) };
  }
  if (t === 'address') return { kind: 'address', dynamic: false };
  if (t === 'bool') return { kind: 'bool', dynamic: false };
  if (t === 'bytes') return { kind: 'bytes', dynamic: true };
  if (t === 'string') return { kind: 'string', dynamic: true };
  let m = /^bytes(\d+)$/.exec(t);
  if (m) {
    const len = Number(m[1]);
    if (len < 1 || len > 32) throw new AbiError(`bad type: ${t}`);
    return { kind: 'fixedBytes', length: len, dynamic: false };
  }
  m = /^(u?)int(\d*)$/.exec(t);
  if (m) {
    const bits = m[2] === '' ? 256 : Number(m[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) throw new AbiError(`bad type: ${t}`);
    return { kind: m[1] ? 'uint' : 'int', bits, dynamic: false };
  }
  throw new AbiError(`unsupported ABI type: ${t}`);
}

function headSize(t) {
  if (t.dynamic) return WORD;
  if (t.kind === 'tuple') return t.components.reduce((s, c) => s + headSize(c), 0);
  return WORD;
}

function encodeValue(t, value) {
  switch (t.kind) {
    case 'uint': {
      const v = intValue(value, `uint${t.bits}`);
      if (v < 0n || v >= 1n << BigInt(t.bits)) throw new AbiError(`uint${t.bits} out of range: ${v}`);
      return word(v);
    }
    case 'int': {
      const v = intValue(value, `int${t.bits}`);
      const limit = 1n << BigInt(t.bits - 1);
      if (v >= limit || v < -limit) throw new AbiError(`int${t.bits} out of range: ${v}`);
      return word(v < 0n ? TWO256 + v : v);
    }
    case 'address': {
      if (!isAddress(value)) throw new AbiError(`not an address (or a bad checksum): ${value}`);
      return word(BigInt(value));
    }
    case 'bool':
      if (typeof value !== 'boolean') throw new AbiError('bool: expected true or false');
      return word(value ? 1n : 0n);
    case 'fixedBytes': {
      const b = toBytes(value);
      if (b.length !== t.length) throw new AbiError(`bytes${t.length}: got ${b.length} bytes`);
      const out = new Uint8Array(WORD);
      out.set(b);
      return out;
    }
    case 'bytes':
    case 'string': {
      const b = t.kind === 'string' ? new TextEncoder().encode(String(value)) : toBytes(value);
      const out = new Uint8Array(WORD + Math.ceil(b.length / WORD) * WORD);
      out.set(word(BigInt(b.length)));
      out.set(b, WORD);
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new AbiError('array: expected a list');
      const body = encodeTuple(value.map(() => t.element), value);
      return concatBytes(word(BigInt(value.length)), body);
    }
    case 'tuple':
      if (!Array.isArray(value)) throw new AbiError('tuple: expected a list');
      return encodeTuple(t.components, value);
    default:
      throw new AbiError(`cannot encode ${t.kind}`);
  }
}

function encodeTuple(components, values) {
  if (values.length !== components.length) throw new AbiError(`tuple of ${components.length} given ${values.length} values`);
  const headLength = components.reduce((s, c) => s + headSize(c), 0);
  const heads = [];
  const tails = [];
  let tailLength = 0;
  components.forEach((c, i) => {
    const enc = encodeValue(c, values[i]);
    if (c.dynamic) {
      heads.push(word(BigInt(headLength + tailLength)));
      tails.push(enc);
      tailLength += enc.length;
    } else heads.push(enc);
  });
  return concatBytes(...heads, ...tails);
}

function checkPadding(bytes, from, to) {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) throw new AbiError('dirty ABI padding');
}

function decodeValue(t, data, offset) {
  switch (t.kind) {
    case 'uint': {
      const v = readWord(data, offset);
      if (v >= 1n << BigInt(t.bits)) throw new AbiError(`uint${t.bits} out of range`);
      return v;
    }
    case 'int': {
      let v = readWord(data, offset);
      if (v >= 1n << 255n) v -= TWO256;
      const limit = 1n << BigInt(t.bits - 1);
      if (v >= limit || v < -limit) throw new AbiError(`int${t.bits} out of range`);
      return v;
    }
    case 'address': {
      readWord(data, offset);
      checkPadding(data, offset, offset + 12);
      return toChecksumAddress(bytesToHex(data.subarray(offset + 12, offset + WORD)));
    }
    case 'bool': {
      const v = readWord(data, offset);
      if (v > 1n) throw new AbiError('bool out of range');
      return v === 1n;
    }
    case 'fixedBytes':
      readWord(data, offset);
      checkPadding(data, offset + t.length, offset + WORD);
      return data.slice(offset, offset + t.length);
    case 'bytes':
    case 'string': {
      const len = readWord(data, offset);
      const start = offset + WORD;
      if (len > BigInt(data.length - start)) throw new AbiError('ABI bytes run past the data');
      const end = start + Number(len);
      const padded = start + Math.ceil(Number(len) / WORD) * WORD;
      if (padded > data.length) throw new AbiError('ABI bytes padding missing');
      checkPadding(data, end, padded);
      const b = data.slice(start, end);
      return t.kind === 'string' ? new TextDecoder().decode(b) : b;
    }
    case 'array': {
      const n = readWord(data, offset);
      const body = offset + WORD;
      // Each element takes at least one word of head: a length beyond that is a lie.
      if (n * BigInt(headSize(t.element)) > BigInt(data.length - body)) throw new AbiError('ABI array longer than the data');
      const count = Number(n);
      return decodeTuple(new Array(count).fill(t.element), data, body);
    }
    case 'tuple':
      return decodeTuple(t.components, data, offset);
    default:
      throw new AbiError(`cannot decode ${t.kind}`);
  }
}

function decodeTuple(components, data, offset) {
  const out = [];
  let head = offset;
  for (const c of components) {
    if (c.dynamic) out.push(decodeValue(c, data, offset + readOffset(data, head)));
    else out.push(decodeValue(c, data, head));
    head += headSize(c);
  }
  return out;
}

function typesOf(types) {
  return Array.isArray(types) ? types.join(',') : types;
}

/** abi.encode(values…) for the comma-separated `types` (or an array of type strings). */
export function abiEncode(types, values) {
  const t = parseType(`(${typesOf(types)})`);
  return encodeValue(t, values);
}

/** abi.decode(data, (types…)) → array of values. */
export function abiDecode(types, data) {
  const t = parseType(`(${typesOf(types)})`);
  return decodeValue(t, toBytes(data), 0);
}

/** The canonical signature with spaces removed: "transfer(address,uint256)". */
function canonical(signature) {
  const s = String(signature).replace(/\s+/g, '');
  if (!/^[A-Za-z_$][\w$]*\(.*\)$/.test(s)) throw new AbiError(`bad signature: ${signature}`);
  return s;
}

/** The 4-byte function selector. */
export function selector(signature) {
  return keccak256(canonical(signature)).slice(0, 4);
}

export function selectorHex(signature) {
  return bytesToHex(selector(signature));
}

/** topic0 of an event: keccak256 of its signature, as 0x-hex (how getLogs takes it). */
export function eventTopic(signature) {
  return bytesToHex(keccak256(canonical(signature)));
}

function argTypes(signature) {
  const s = canonical(signature);
  return s.slice(s.indexOf('(') + 1, -1);
}

/** Calldata: selector ‖ abi.encode(args), the argument types read from the signature. */
export function encodeCall(signature, args = []) {
  return concatBytes(selector(signature), abiEncode(argTypes(signature), args));
}

/** Decodes calldata against `signature`; refuses a different selector. */
export function decodeCall(signature, data) {
  const b = toBytes(data);
  const sel = selector(signature);
  if (b.length < 4 || b[0] !== sel[0] || b[1] !== sel[1] || b[2] !== sel[2] || b[3] !== sel[3]) throw new AbiError(`not a call to ${signature}`);
  return abiDecode(argTypes(signature), b.subarray(4));
}

/** An address as a 32-byte log topic (indexed address parameter), 0x-hex. */
export function addressTopic(address) {
  if (!isAddress(address)) throw new AbiError(`not an address: ${address}`);
  return bytesToHex(word(BigInt(address)));
}
