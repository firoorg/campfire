// Firo output scripts: build the ones this wallet writes (P2PKH, EX, OP_RETURN)
// and recognise every kind a Firo transaction can carry, from Firo Core's
// script.h / script.cpp (opcodes 0xc1-0xc9 Zerocoin/Sigma/Lelantus, 0xd1-0xd3
// Spark, 0xe0 EX addresses, 0xe1 Spark name fees).

import { BytesError, Reader, bytesToUtf8, compactSize, concatBytes } from './bytes.js';
import { t } from '../i18n.js';

export const OP = Object.freeze({
  OP_0: 0x00,
  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
  OP_PUSHDATA4: 0x4e,
  OP_RETURN: 0x6a,
  OP_DROP: 0x75,
  OP_DUP: 0x76,
  OP_EQUAL: 0x87,
  OP_EQUALVERIFY: 0x88,
  OP_HASH160: 0xa9,
  OP_CHECKSIG: 0xac,
  OP_ZEROCOINMINT: 0xc1,
  OP_ZEROCOINSPEND: 0xc2,
  OP_SIGMAMINT: 0xc3,
  OP_SIGMASPEND: 0xc4,
  OP_LELANTUSMINT: 0xc5,
  OP_LELANTUSJMINT: 0xc6,
  OP_LELANTUSJOINSPLIT: 0xc7,
  OP_ZEROCOINTOSIGMAREMINT: 0xc8,
  OP_LELANTUSJOINSPLITPAYLOAD: 0xc9,
  OP_SPARKMINT: 0xd1,
  OP_SPARKSMINT: 0xd2,
  OP_SPARKSPEND: 0xd3,
  OP_EXCHANGEADDR: 0xe0,
  OP_SPARKNAMEID: 0xe1,
});

/** OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG */
export function p2pkhScript(hash20) {
  checkHash20(hash20);
  return concatBytes(Uint8Array.of(OP.OP_DUP, OP.OP_HASH160, 20), hash20, Uint8Array.of(OP.OP_EQUALVERIFY, OP.OP_CHECKSIG));
}

/** OP_HASH160 <20> OP_EQUAL */
export function p2shScript(hash20) {
  checkHash20(hash20);
  return concatBytes(Uint8Array.of(OP.OP_HASH160, 20), hash20, Uint8Array.of(OP.OP_EQUAL));
}

/** OP_EXCHANGEADDR OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG: what an EX address pays to. */
export function exchangeScript(hash20) {
  return concatBytes(Uint8Array.of(OP.OP_EXCHANGEADDR), p2pkhScript(hash20));
}

/** The minimal push of `data` (as Bitcoin's CScript << vector does). */
export function pushData(data) {
  const n = data.length;
  if (n < OP.OP_PUSHDATA1) return concatBytes(Uint8Array.of(n), data);
  if (n <= 0xff) return concatBytes(Uint8Array.of(OP.OP_PUSHDATA1, n), data);
  if (n <= 0xffff) return concatBytes(Uint8Array.of(OP.OP_PUSHDATA2, n & 0xff, n >> 8), data);
  return concatBytes(Uint8Array.of(OP.OP_PUSHDATA4, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24), data);
}

/**
 * OP_RETURN <data>: an unspendable output carrying `data` (for the Rosen
 * Bridge). One data push, as Firo Core's nulldata template expects; the whole
 * script must fit MAX_OP_RETURN_RELAY.
 */
export function opReturnScript(data, maxScript = 16384) {
  if (!(data instanceof Uint8Array)) throw new BytesError(t('OP_RETURN data must be bytes.'));
  const s = concatBytes(Uint8Array.of(OP.OP_RETURN), pushData(data));
  if (s.length > maxScript) throw new BytesError(t('OP_RETURN data is too large ({length} bytes).', { length: data.length }));
  return s;
}

function checkHash20(h) {
  if (!(h instanceof Uint8Array) || h.length !== 20) throw new BytesError(t('A script hash is 20 bytes.'));
}

/** Script → [{op, data?}]; throws on a push running past the end. */
export function parseScript(script) {
  const out = [];
  const r = new Reader(script);
  while (r.remaining > 0) {
    const op = r.u8();
    if (op > 0 && op < OP.OP_PUSHDATA1) out.push({ op, data: r.bytes(op) });
    else if (op === OP.OP_PUSHDATA1) out.push({ op, data: r.bytes(r.u8()) });
    else if (op === OP.OP_PUSHDATA2) out.push({ op, data: r.bytes(r.u16()) });
    else if (op === OP.OP_PUSHDATA4) out.push({ op, data: r.bytes(r.u32()) });
    else out.push({ op });
  }
  return out;
}

function isP2PKHAt(s, o) {
  return s.length >= o + 25 && s[o] === OP.OP_DUP && s[o + 1] === OP.OP_HASH160 && s[o + 2] === 20 && s[o + 23] === OP.OP_EQUALVERIFY && s[o + 24] === OP.OP_CHECKSIG;
}

/**
 * P2PKH + OP_SPARKNAMEID <name> OP_DROP <spark address> OP_DROP: the fee
 * output of a Spark name registration (Firo Core CScript::IsSparkNameFee).
 * Returns {hash, name, address} or null.
 */
export function parseSparkNameFeeScript(s) {
  if (s.length < 30 || !isP2PKHAt(s, 0) || s[25] !== OP.OP_SPARKNAMEID) return null;
  let ops;
  try {
    ops = parseScript(s.subarray(26));
  } catch {
    return null;
  }
  if (ops.length !== 4 || !ops[0].data || ops[1].op !== OP.OP_DROP || !ops[2].data || ops[3].op !== OP.OP_DROP) return null;
  try {
    return { hash: s.slice(3, 23), name: bytesToUtf8(ops[0].data), address: bytesToUtf8(ops[2].data) };
  } catch {
    return null;
  }
}

/**
 * The fee output's script of a Spark name registration: `baseScript` (the P2PKH script of the
 * community fund address) + OP_SPARKNAMEID <name> OP_DROP <spark address> OP_DROP, the inverse of
 * parseSparkNameFeeScript.
 */
export function sparkNameFeeScript(baseScript, name, sparkAddress) {
  const enc = new TextEncoder();
  return concatBytes(baseScript, Uint8Array.of(OP.OP_SPARKNAMEID), pushData(enc.encode(name)), Uint8Array.of(OP.OP_DROP), pushData(enc.encode(sparkAddress)), Uint8Array.of(OP.OP_DROP));
}

/**
 * What an output script is: {type, hash?, data?, name?, sparkAddress?}.
 * type: 'p2pkh' | 'p2sh' | 'exchange' | 'p2pk' | 'nulldata' | 'spark-mint' |
 * 'spark-smint' | 'spark-name-fee' | 'lelantus-mint' | 'lelantus-jmint' |
 * 'sigma-mint' | 'zerocoin-mint' | 'nonstandard'.
 */
export function classifyOutputScript(s) {
  if (s.length === 25 && isP2PKHAt(s, 0)) return { type: 'p2pkh', hash: s.slice(3, 23) };
  if (s.length === 23 && s[0] === OP.OP_HASH160 && s[1] === 20 && s[22] === OP.OP_EQUAL) return { type: 'p2sh', hash: s.slice(2, 22) };
  if (s.length === 26 && s[0] === OP.OP_EXCHANGEADDR && isP2PKHAt(s, 1)) return { type: 'exchange', hash: s.slice(4, 24) };
  const nameFee = parseSparkNameFeeScript(s);
  if (nameFee) return { type: 'spark-name-fee', hash: nameFee.hash, name: nameFee.name, sparkAddress: nameFee.address };
  if (s.length > 0) {
    switch (s[0]) {
      case OP.OP_SPARKMINT:
        return { type: 'spark-mint' };
      case OP.OP_SPARKSMINT:
        return { type: 'spark-smint' };
      case OP.OP_LELANTUSMINT:
        return { type: 'lelantus-mint' };
      case OP.OP_LELANTUSJMINT:
        return { type: 'lelantus-jmint' };
      case OP.OP_SIGMAMINT:
        return { type: 'sigma-mint' };
      case OP.OP_ZEROCOINMINT:
        return { type: 'zerocoin-mint' };
      case OP.OP_RETURN: {
        let data = null;
        try {
          const ops = parseScript(s.subarray(1));
          data = ops.length === 1 && ops[0].data ? ops[0].data : ops.length === 0 ? new Uint8Array(0) : null;
        } catch {
          data = null;
        }
        return { type: 'nulldata', data };
      }
      default:
    }
  }
  if ((s.length === 35 && s[0] === 33) || (s.length === 67 && s[0] === 65)) {
    if (s[s.length - 1] === OP.OP_CHECKSIG) return { type: 'p2pk', pubkey: s.slice(1, s.length - 1) };
  }
  return { type: 'nonstandard' };
}

/** A scriptSig's privacy opcode, if the input is not a regular one: 'spark-spend' | 'lelantus-joinsplit' | 'sigma-spend' | 'zerocoin-spend' | 'remint' | null. */
export function classifyInputScript(scriptSig) {
  if (!scriptSig || scriptSig.length === 0) return null;
  switch (scriptSig[0]) {
    case OP.OP_SPARKSPEND:
      return 'spark-spend';
    case OP.OP_LELANTUSJOINSPLIT:
    case OP.OP_LELANTUSJOINSPLITPAYLOAD:
      return 'lelantus-joinsplit';
    case OP.OP_SIGMASPEND:
      return 'sigma-spend';
    case OP.OP_ZEROCOINSPEND:
      return 'zerocoin-spend';
    case OP.OP_ZEROCOINTOSIGMAREMINT:
      return 'remint';
    default:
      return null;
  }
}

/** Serialized size of an output with this script: value (8) + CompactSize + script. */
export function outputSize(script) {
  return 8 + compactSize(script.length).length + script.length;
}
