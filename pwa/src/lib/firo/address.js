// Firo addresses: transparent P2PKH/P2SH (base58check, one version byte), EX
// "exchange" addresses (base58check, three version bytes, paying to
// OP_EXCHANGEADDR + P2PKH) and the outer shape of Spark addresses (bech32m,
// HRP "sm"/"st", 84 bytes). Whether a Spark address's points are valid is the
// Spark library's call (spark client validateAddress); here it is only shape.
//
// ElectrumX indexes outputs by "script hash": SHA-256 of the output script,
// byte-reversed, in hex.

import { createBase58check, bech32m } from '../../vendor/noble/scure-base/index.js';
import { sha256, hash160, bytesToHex, reverse } from './bytes.js';
import { p2pkhScript, p2shScript, exchangeScript, classifyOutputScript } from './script.js';
import { isValidSparkName } from './params.js';

const b58c = createBase58check(sha256);

export class AddressError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid-address';
  }
}

/** base58check(version ‖ payload). */
export function base58checkEncode(bytes) {
  return b58c.encode(bytes);
}

/** base58check → bytes; throws AddressError on a bad checksum or alphabet. */
export function base58checkDecode(text) {
  try {
    return b58c.decode(text);
  } catch {
    throw new AddressError('Not a valid address (checksum or characters).');
  }
}

export function p2pkhAddress(hash20, net) {
  return base58checkEncode(Uint8Array.of(net.p2pkh, ...hash20));
}

export function p2shAddress(hash20, net) {
  return base58checkEncode(Uint8Array.of(net.p2sh, ...hash20));
}

export function exchangeAddress(hash20, net) {
  return base58checkEncode(Uint8Array.of(...net.exAddress, ...hash20));
}

/** A compressed public key's P2PKH address. */
export function pubkeyToAddress(pubkey, net) {
  return p2pkhAddress(hash160(pubkey), net);
}

/**
 * A transparent or EX address → {type: 'p2pkh'|'p2sh'|'exchange', hash, script}.
 * Throws AddressError for anything else, including the other network's addresses.
 */
export function decodeTransparent(text, net) {
  if (typeof text !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(text)) throw new AddressError('Not a Firo address.');
  const b = base58checkDecode(text);
  if (b.length === 21) {
    const hash = b.slice(1);
    if (b[0] === net.p2pkh) return { type: 'p2pkh', hash, script: p2pkhScript(hash) };
    if (b[0] === net.p2sh) return { type: 'p2sh', hash, script: p2shScript(hash) };
  }
  if (b.length === 23 && b[0] === net.exAddress[0] && b[1] === net.exAddress[1] && b[2] === net.exAddress[2]) {
    const hash = b.slice(3);
    return { type: 'exchange', hash, script: exchangeScript(hash) };
  }
  throw new AddressError(`Not a ${net.name} address.`);
}

/** The output script for a transparent or EX address. */
export function addressToScript(text, net) {
  return decodeTransparent(text, net).script;
}

/** The address an output script pays, or null (Spark mints, OP_RETURN, …). EX scripts give EX addresses; name-fee scripts their P2PKH. */
export function scriptToAddress(script, net) {
  const c = classifyOutputScript(script);
  switch (c.type) {
    case 'p2pkh':
    case 'spark-name-fee':
      return p2pkhAddress(c.hash, net);
    case 'p2sh':
      return p2shAddress(c.hash, net);
    case 'exchange':
      return exchangeAddress(c.hash, net);
    case 'p2pk':
      return c.pubkey.length === 33 || c.pubkey.length === 65 ? pubkeyToAddress(c.pubkey, net) : null;
    default:
      return null;
  }
}

/** ElectrumX script hash: hex of reversed SHA-256(script). */
export function scriptHash(script) {
  return bytesToHex(reverse(sha256(script)));
}

export function addressScriptHash(text, net) {
  return scriptHash(addressToScript(text, net));
}

// ---------------------------------------------------------------- Spark (shape only)

/** 16-byte encrypted diversifier + two 34-byte points. */
export const SPARK_ADDRESS_BYTES = 84;

/**
 * Whether `text` has the shape of a Spark address on `net`: bech32m, HRP
 * "sm" (main) or "st" (test), 84 bytes inside. Does not check the points.
 */
export function isSparkAddressShape(text, net) {
  if (typeof text !== 'string' || text.length < 100 || text.length > 200) return false;
  if (text !== text.toLowerCase()) return false;
  try {
    const { prefix, words } = bech32m.decode(text, 200);
    if (prefix !== net.sparkHrp) return false;
    return bech32m.fromWords(words).length === SPARK_ADDRESS_BYTES;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- what was typed

/**
 * What a person typed or pasted into "To": WALLET_API's classifyAddress.
 * {kind: 'spark'|'transparent'|'exchange'|'spark-name'|'invalid', address?, name?, error?}
 * A leading "@" marks a Spark name; a bare word that is no address but a valid
 * name is taken as one too. Addresses of the other network are invalid.
 */
export function classifyAddress(text, net) {
  const t = String(text ?? '').trim();
  if (!t) return { kind: 'invalid', error: 'Enter an address.' };
  const lower = t.toLowerCase();
  if (lower.startsWith('s') && /^s[a-z]1/.test(lower)) {
    if (isSparkAddressShape(lower, net)) return { kind: 'spark', address: lower };
    if (lower.slice(0, 2) !== net.sparkHrp && lower.length > 100) return { kind: 'invalid', error: 'That Spark address is for another network.' };
  }
  try {
    const d = decodeTransparent(t, net);
    return { kind: d.type === 'exchange' ? 'exchange' : 'transparent', address: t };
  } catch {
    // not transparent
  }
  const name = t.startsWith('@') ? t.slice(1) : t;
  if (isValidSparkName(name)) return { kind: 'spark-name', name };
  return { kind: 'invalid', error: 'This is not a Firo address or Spark name.' };
}
