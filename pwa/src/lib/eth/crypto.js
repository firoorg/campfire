// Ethereum keys: keccak-256, secp256k1 signatures, BIP39 phrases, the BIP32
// path Stack Wallet uses (m/44'/60'/0'/0/0) and EIP-55 addresses. A thin
// layer over the vendored noble/scure code (src/vendor/noble/, pinned in its
// VENDOR.json).
//
// Two noble 2.x behaviours this file exists to pin down:
// * sign() and recoverPublicKey() hash the message with SHA-256 first unless
//   given {prehash:false}. Ethereum signs a keccak digest as it is, so every
//   call here passes prehash:false.
// * The 'recovered' signature format is 65 bytes [recid, r, s], recovery byte
//   FIRST. Ethereum's r‖s‖v puts it last; rsvSignature() reorders.
//
// Secrets are Uint8Arrays so they can be zeroed (wipe()); the phrase itself
// is a JS string and cannot be, so callers should drop it as soon as the key
// is derived.

import { keccak_256 } from '../../vendor/noble/noble-hashes/sha3.js';
import { secp256k1 } from '../../vendor/noble/noble-curves/secp256k1.js';
import { HDKey } from '../../vendor/noble/scure-bip32/index.js';
import { generateMnemonic, validateMnemonic, mnemonicToSeedWebcrypto } from '../../vendor/noble/scure-bip39/index.js';
import { wordlist as ENGLISH } from '../../vendor/noble/scure-bip39/wordlists/english.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToBigInt, bigIntToBytes, concatBytes } from './hex.js';

export const ETH_PATH = "m/44'/60'/0'/0/0";
/** What a person may type: 12 words (created here), or any BIP39 length when importing. */
export const MNEMONIC_LENGTHS = Object.freeze([12, 15, 18, 21, 24]);
const SECP_N = secp256k1.Point.Fn.ORDER;

export class EthKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'mnemonic' | 'key' | 'signature' | 'address'
  }
}

export function keccak256(data) {
  return keccak_256(typeof data === 'string' ? utf8ToBytes(data) : data);
}

export function wipe(...arrays) {
  for (const a of arrays) if (a && typeof a.fill === 'function') a.fill(0);
}

// ---------------------------------------------------------------- addresses

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** EIP-55 mixed-case checksum form of a 20-byte address. */
export function toChecksumAddress(address) {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) throw new EthKeyError('address', 'Not an Ethereum address.');
  const lower = address.slice(2).toLowerCase();
  const h = bytesToHex(keccak256(lower), false);
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/**
 * Whether `address` is a usable address. All-lowercase and all-uppercase
 * forms carry no checksum and are accepted; a mixed-case one must match its
 * EIP-55 checksum, since a mistyped character usually breaks it.
 */
export function isAddress(address) {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

/** 0x + 40 lowercase hex, for comparing and for JSON-RPC; throws on a bad checksum. */
export function normAddress(address) {
  if (!isAddress(address)) throw new EthKeyError('address', 'Not an Ethereum address, or its checksum is wrong.');
  return address.toLowerCase();
}

/** 65-byte uncompressed (or 33-byte compressed) public key → checksummed address. */
export function publicKeyToAddress(pub) {
  const full = pub.length === 65 ? pub : secp256k1.Point.fromBytes(pub).toBytes(false);
  if (full.length !== 65 || full[0] !== 4) throw new EthKeyError('key', 'Not a secp256k1 public key.');
  return toChecksumAddress(bytesToHex(keccak256(full.subarray(1)).subarray(12)));
}

export function privateKeyToAddress(sk) {
  checkSecretKey(sk);
  return publicKeyToAddress(secp256k1.getPublicKey(sk, false));
}

function checkSecretKey(sk) {
  if (!(sk instanceof Uint8Array) || sk.length !== 32 || !secp256k1.utils.isValidSecretKey(sk)) throw new EthKeyError('key', 'Not a valid secp256k1 secret key.');
}

// ---------------------------------------------------------------- private keys as typed

const KEY_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * What a person typed into "Recovery words or private key": 'key', 'words'
 * or 'empty'. A key is one unbroken run with a 0x prefix, a digit, or more
 * than 8 hex letters: BIP39 words have no digits and at most 8 letters, so
 * a first word such as "add" or "face" still counts as words.
 */
export function secretKind(text) {
  const t = String(text).trim();
  if (!t) return 'empty';
  if (/\s/.test(t)) return 'words';
  if (/^0x/i.test(t) || /\d/.test(t) || /^[0-9a-f]{9,}$/i.test(t)) return 'key';
  return 'words';
}

/** Trimmed, without 0x, lowercase: the 64 hex characters if it is a key. */
export function normalizePrivateKey(text) {
  return String(text).trim().replace(/^0x/i, '').toLowerCase();
}

/**
 * Why `text` is not a usable private key, or null: 'format' (not 64 hex
 * characters, with `length` of what is there and whether it is all hex) or
 * 'range' (0, or not below the curve order n).
 */
export function privateKeyProblem(text) {
  const hex = normalizePrivateKey(text);
  if (!KEY_HEX_RE.test(hex)) return { code: 'format', length: hex.length, hex: /^[0-9a-f]*$/.test(hex) };
  const k = BigInt(`0x${hex}`);
  if (k <= 0n || k >= SECP_N) return { code: 'range' };
  return null;
}

/** A typed private key → its 32 bytes; throws EthKeyError('key'). The caller wipes them. */
export function privateKeyFromText(text) {
  const p = privateKeyProblem(text);
  if (p) throw new EthKeyError('key', p.code === 'range' ? 'That private key is not valid.' : 'A private key is 64 characters, 0-9 and a-f.');
  const sk = hexToBytes(normalizePrivateKey(text));
  checkSecretKey(sk);
  return sk;
}

// ---------------------------------------------------------------- signatures

/**
 * Signs a 32-byte digest as it is (RFC 6979 deterministic k, low s as
 * Ethereum requires). Returns {r, s, yParity}.
 */
export function signDigest(digest, sk) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new EthKeyError('signature', 'A digest is 32 bytes.');
  checkSecretKey(sk);
  const rec = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered', lowS: true });
  try {
    const recid = rec[0];
    // 2 and 3 mean r overflowed the group order: probability ~2^-128, and not
    // expressible as an Ethereum yParity.
    if (recid !== 0 && recid !== 1) throw new EthKeyError('signature', 'Unusable signature; try again.');
    return { r: bytesToBigInt(rec.subarray(1, 33)), s: bytesToBigInt(rec.subarray(33, 65)), yParity: recid };
  } finally {
    wipe(rec);
  }
}

/** r‖s‖v with v = 27 + yParity: what EIP-712 permits and personal_sign expect. */
export function rsvSignature({ r, s, yParity }) {
  return concatBytes(bigIntToBytes(r, 32), bigIntToBytes(s, 32), Uint8Array.of(27 + yParity));
}

/** The address that made {r, s, yParity} over `digest`. Refuses high s (EIP-2). */
export function recoverAddress(digest, { r, s, yParity }) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new EthKeyError('signature', 'A digest is 32 bytes.');
  if (yParity !== 0 && yParity !== 1) throw new EthKeyError('signature', 'yParity must be 0 or 1.');
  if (r <= 0n || r >= SECP_N || s <= 0n || s > SECP_N / 2n) throw new EthKeyError('signature', 'Signature out of range.');
  const rec = concatBytes(Uint8Array.of(yParity), bigIntToBytes(r, 32), bigIntToBytes(s, 32));
  return publicKeyToAddress(secp256k1.recoverPublicKey(rec, digest, { prehash: false }));
}

/** r‖s‖v (v 27/28 or 0/1) → {r, s, yParity}. */
export function parseRsvSignature(sig) {
  const b = typeof sig === 'string' ? hexToBytes(sig) : sig;
  if (b.length !== 65) throw new EthKeyError('signature', 'A signature is 65 bytes.');
  const v = b[64];
  const yParity = v >= 27 ? v - 27 : v;
  if (yParity !== 0 && yParity !== 1) throw new EthKeyError('signature', 'Bad recovery byte.');
  return { r: bytesToBigInt(b.subarray(0, 32)), s: bytesToBigInt(b.subarray(32, 64)), yParity };
}

// ---------------------------------------------------------------- BIP39 / BIP32

/** Trims, lowercases and single-spaces what a person typed or pasted. */
export function normalizeMnemonic(phrase) {
  return String(phrase).normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** A fresh phrase: 12 words (128 bits) or 24 (256 bits), English list. */
export function newMnemonic(words = 12) {
  if (words !== 12 && words !== 24) throw new EthKeyError('mnemonic', 'Use 12 or 24 words.');
  return generateMnemonic(ENGLISH, words === 12 ? 128 : 256);
}

/**
 * Why `phrase` cannot be used, or null: 'length' (not one of `lengths`),
 * 'word' (with the 1-based position of the first word not in the list) or
 * 'checksum' (all words known, but the last one does not fit the others).
 */
export function mnemonicProblem(phrase, lengths = MNEMONIC_LENGTHS) {
  const words = normalizeMnemonic(phrase).split(' ').filter(Boolean);
  if (!lengths.includes(words.length)) return { code: 'length', words: words.length };
  const bad = words.findIndex((w) => !ENGLISH.includes(w));
  if (bad >= 0) return { code: 'word', position: bad + 1 };
  if (!validateMnemonic(words.join(' '), ENGLISH)) return { code: 'checksum' };
  return null;
}

export function isValidMnemonic(phrase, lengths = MNEMONIC_LENGTHS) {
  return mnemonicProblem(phrase, lengths) === null;
}

/** BIP39 seed (64 bytes). Validates the phrase first: the seed of a mistyped phrase is a different, empty wallet. */
export async function mnemonicToSeed(phrase, passphrase = '', lengths = MNEMONIC_LENGTHS) {
  const p = normalizeMnemonic(phrase);
  const problem = mnemonicProblem(p, lengths);
  if (problem) throw new EthKeyError('mnemonic', `Invalid recovery phrase (${problem.code}).`);
  if (typeof passphrase !== 'string') throw new EthKeyError('mnemonic', 'The passphrase must be text.');
  return mnemonicToSeedWebcrypto(p, passphrase);
}

/** The 32-byte secret key at `path` under `seed`, wiping every intermediate node. */
export function deriveSecretKey(seed, path = ETH_PATH) {
  if (!/^m(\/\d+'?)+$/.test(path)) throw new EthKeyError('key', `Bad derivation path: ${path}`);
  let node = HDKey.fromMasterSeed(seed);
  try {
    for (const part of path.split('/').slice(1)) {
      const index = Number(part.replace("'", '')) + (part.endsWith("'") ? 0x80000000 : 0);
      const child = node.deriveChild(index);
      node.wipePrivateData();
      node = child;
    }
    return node.privateKey; // a copy
  } finally {
    node.wipePrivateData();
  }
}

/** Phrase (+ optional BIP39 passphrase) → {sk, address} at m/44'/60'/0'/0/0, as Flutter's getPrivateKey. */
export async function ethKeyFromMnemonic(phrase, passphrase = '', { path = ETH_PATH, lengths = MNEMONIC_LENGTHS } = {}) {
  const seed = await mnemonicToSeed(phrase, passphrase, lengths);
  try {
    const sk = deriveSecretKey(seed, path);
    return { sk, address: privateKeyToAddress(sk) };
  } finally {
    wipe(seed);
  }
}

export { ENGLISH as BIP39_ENGLISH };
