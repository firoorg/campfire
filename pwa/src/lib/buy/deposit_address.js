// Whether a deposit address buyfiro.app gives is an address of the coin's own chain, before it
// is shown to be paid. The address comes from buyfiro.app's answer; a wrong one (another chain's,
// a typo, a page that is not buyfiro.app's) must never reach the screen, since a payment to it is
// lost. Shapes, and checksums wherever the chain has one: EVM 0x addresses (EIP-55 when written
// in mixed case), Bitcoin-family bech32 / bech32m and base58check with each chain's version
// bytes, Tron's base58check, Solana's 32-byte base58 keys, XRP's own base58 with its checksum,
// and the shapes of the rest. A chain not known here gets only a loose check (printable, no
// spaces, 20 to 128 characters), so a new coin buyfiro.app adds still works.
//
// The vendored noble/scure code does the decoding (src/vendor/noble/, pinned in VENDOR.json).

import { bech32, bech32m, base58, base58xrp, createBase58check } from '../../vendor/noble/scure-base/index.js';
import { sha256 } from '../../vendor/noble/noble-hashes/sha2.js';
import { keccak_256 } from '../../vendor/noble/noble-hashes/sha3.js';

/** Chains whose addresses are Ethereum's (0x and 40 hex digits). */
export const EVM_CHAINS = Object.freeze(new Set(['eth', 'arb', 'base', 'op', 'bsc', 'pol', 'avax', 'gnosis', 'scroll', 'bera', 'monad', 'xlayer', 'plasma', 'abs']));

const b58check = createBase58check(sha256);
const attempt = (f) => {
  try {
    return f();
  } catch {
    return null;
  }
};
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** 0x and 40 hex digits; in mixed case, the EIP-55 checksum must hold. */
export function isEvmAddress(a) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const h = hex(keccak_256(new TextEncoder().encode(body.toLowerCase())));
  for (let i = 0; i < 40; i++) if (body[i] !== (parseInt(h[i], 16) >= 8 ? body[i].toUpperCase() : body[i].toLowerCase())) return false;
  return true;
}

/** A segwit address of `hrp`: version 0 in bech32 (20 or 32 bytes), versions 1-16 in bech32m. */
function segwit(hrp, a) {
  const s = a.toLowerCase();
  if ((a !== s && a !== a.toUpperCase()) || !s.startsWith(`${hrp}1`)) return false;
  const v0 = attempt(() => bech32.decode(s));
  if (v0 && v0.prefix === hrp && v0.words[0] === 0) {
    const p = attempt(() => bech32.fromWords(v0.words.slice(1)));
    return Boolean(p) && (p.length === 20 || p.length === 32);
  }
  const v1 = attempt(() => bech32m.decode(s));
  if (v1 && v1.prefix === hrp && v1.words[0] >= 1 && v1.words[0] <= 16) {
    const p = attempt(() => bech32m.fromWords(v1.words.slice(1)));
    return Boolean(p) && p.length >= 2 && p.length <= 40;
  }
  return false;
}

/** base58check whose payload is `len` bytes starting with one of `prefixes` (each a list of bytes). */
function base58With(a, prefixes, len = 21) {
  const p = attempt(() => b58check.decode(a));
  return Boolean(p) && p.length === len && prefixes.some((pre) => pre.every((b, i) => p[i] === b));
}

/** bech32 or bech32m (`kind`) with this prefix, up to `limit` characters (Cardano's and Zcash's are long). */
function bechOf(kind, prefix, a, limit = 90) {
  const d = attempt(() => (kind === 'm' ? bech32m : bech32).decode(a, limit));
  return Boolean(d) && d.prefix === prefix;
}

/** XRP: base58 in Ripple's alphabet, version 0, 20 bytes, checksum sha256d. */
function xrp(a) {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) return false;
  const b = attempt(() => base58xrp.decode(a));
  if (!b || b.length !== 25 || b[0] !== 0) return false;
  const sum = sha256(sha256(b.subarray(0, 21)));
  return sum.subarray(0, 4).every((x, i) => x === b[21 + i]);
}

/** Solana-family: a 32-byte ed25519 key in base58. */
function svm(a) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  const b = attempt(() => base58.decode(a));
  return Boolean(b) && b.length === 32;
}

const P2PKH_P2SH = [[0x00], [0x05]];
const RULES = {
  btc: (a) => segwit('bc', a) || base58With(a, P2PKH_P2SH),
  bitcoin: (a) => segwit('bc', a) || base58With(a, P2PKH_P2SH),
  // Litecoin's old P2SH version (5, '3…') is Bitcoin's: only its own M… and L… are taken.
  ltc: (a) => segwit('ltc', a) || base58With(a, [[0x30], [0x32]]),
  doge: (a) => base58With(a, [[0x1e], [0x16]]),
  dash: (a) => base58With(a, [[0x4c], [0x10]]),
  bch: (a) => /^(bitcoincash:)?[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$/.test(a) || base58With(a, P2PKH_P2SH),
  zec: (a) => base58With(a, [[0x1c, 0xb8], [0x1c, 0xbd]], 22) || bechOf('m', 'tex', a) || bechOf('', 'zs', a) || bechOf('m', 'u', a, 1000),
  tron: (a) => base58With(a, [[0x41]]),
  sol: svm,
  fogo: svm,
  xrp,
  ton: (a) => /^[A-Za-z0-9_-]{48}$/.test(a) || /^[A-Za-z0-9+/]{48}$/.test(a) || /^-?\d{1,3}:[0-9a-fA-F]{64}$/.test(a),
  stellar: (a) => /^G[A-Z2-7]{55}$/.test(a),
  cardano: (a) => bechOf('', 'addr', a, 1000) || /^(Ae2|DdzFF)[1-9A-HJ-NP-Za-km-z]{50,}$/.test(a),
  sui: (a) => /^0x[0-9a-fA-F]{64}$/.test(a),
  aptos: (a) => /^0x[0-9a-fA-F]{1,64}$/.test(a),
  movement: (a) => /^0x[0-9a-fA-F]{1,64}$/.test(a),
  starknet: (a) => /^0x[0-9a-fA-F]{1,64}$/.test(a),
  near: (a) => /^[0-9a-f]{64}$/.test(a) || /^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/.test(a),
  aleo: (a) => bechOf('m', 'aleo', a),
  hypercore: isEvmAddress,
};

/** Whether rules for `blockchain` are known here (else only the loose check applies). */
export function knownChain(blockchain) {
  return EVM_CHAINS.has(blockchain) || Object.hasOwn(RULES, blockchain);
}

/** Whether `address` can be an address on `blockchain` (buyfiro.app's chain id: 'btc', 'eth', 'tron'…). */
export function isDepositAddressOf(address, blockchain) {
  // Printable, without spaces, of a sane length: every chain's address is.
  if (typeof address !== 'string' || !/^[\x21-\x7e]{2,128}$/.test(address)) return false;
  if (EVM_CHAINS.has(blockchain)) return isEvmAddress(address);
  const rule = RULES[blockchain];
  return rule ? Boolean(rule(address)) : address.length >= 20;
}
