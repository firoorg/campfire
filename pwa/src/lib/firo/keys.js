// Firo keys, compatible with Campfire / Stack Wallet:
//   BIP39 phrase (12 or 24 words created here; any BIP39 length restored)
//   + optional passphrase → BIP32 seed →
//   m/44'/136'/0'/0/i  receive P2PKH addresses   (testnet coin type 1)
//   m/44'/136'/0'/1/i  change P2PKH addresses
//   m/44'/136'/0'/6/1  the 32-byte Spark key material handed to the Spark client
// Transparent keys are compressed secp256k1; WIF is version 0xd2 (main) /
// 0xb9 (test) with the 0x01 compression flag.
//
// Secrets are Uint8Arrays so they can be zeroed; the phrase is a JS string
// and cannot be, so callers should drop it once the keys exist.

import { HDKey } from '../../vendor/noble/scure-bip32/index.js';
import { generateMnemonic as bip39Generate, validateMnemonic as bip39Validate, mnemonicToSeedWebcrypto } from '../../vendor/noble/scure-bip39/index.js';
import { wordlist as ENGLISH } from '../../vendor/noble/scure-bip39/wordlists/english.js';
import { secp256k1 } from '../../vendor/noble/noble-curves/secp256k1.js';
import { pubkeyToAddress, base58checkEncode, base58checkDecode, scriptHash } from './address.js';
import { p2pkhScript } from './script.js';
import { hash160 } from './bytes.js';
import { CHAIN_RECEIVE, CHAIN_CHANGE, CHAIN_SPARK, SPARK_KEY_INDEX, bip44Path } from './params.js';

export const MNEMONIC_LENGTHS = Object.freeze([12, 15, 18, 21, 24]);

export class KeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'mnemonic' | 'key' | 'path'
  }
}

export function wipe(...arrays) {
  for (const a of arrays) if (a && typeof a.fill === 'function') a.fill(0);
}

// ---------------------------------------------------------------- BIP39

/** Trims, lowercases and single-spaces what a person typed or pasted. */
export function normalizeMnemonic(phrase) {
  return String(phrase ?? '').normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** A fresh English phrase of 12 (128-bit) or 24 (256-bit) words. */
export function generateMnemonic(words = 24) {
  if (words !== 12 && words !== 24) throw new KeyError('mnemonic', 'Use 12 or 24 words.');
  return bip39Generate(ENGLISH, words === 12 ? 128 : 256);
}

/**
 * WALLET_API validateMnemonic: {ok: true} or {ok: false, error, code, position?}.
 * code: 'length' | 'word' (position is 1-based) | 'checksum'.
 */
export function validateMnemonic(phrase) {
  const words = normalizeMnemonic(phrase).split(' ').filter(Boolean);
  if (!MNEMONIC_LENGTHS.includes(words.length)) {
    return { ok: false, code: 'length', error: `A recovery phrase has 12, 15, 18, 21 or 24 words; this has ${words.length}.` };
  }
  const bad = words.findIndex((w) => !ENGLISH.includes(w));
  if (bad >= 0) return { ok: false, code: 'word', position: bad + 1, error: `Word ${bad + 1} is not on the BIP39 word list.` };
  if (!bip39Validate(words.join(' '), ENGLISH)) return { ok: false, code: 'checksum', error: 'These words do not form a valid phrase. Check each word and their order.' };
  return { ok: true };
}

/** The 64-byte BIP39 seed. Refuses an invalid phrase: a mistyped phrase is another, empty wallet. */
export async function mnemonicToSeed(phrase, passphrase = '') {
  const v = validateMnemonic(phrase);
  if (!v.ok) throw new KeyError('mnemonic', v.error);
  if (typeof passphrase !== 'string') throw new KeyError('mnemonic', 'The passphrase must be text.');
  return mnemonicToSeedWebcrypto(normalizeMnemonic(phrase), passphrase.normalize('NFKD'));
}

// ---------------------------------------------------------------- WIF

/** 32-byte key → WIF (compressed). */
export function toWif(sk, net) {
  checkSecretKey(sk);
  const b = new Uint8Array(34);
  b[0] = net.wif;
  b.set(sk, 1);
  b[33] = 0x01;
  try {
    return base58checkEncode(b);
  } finally {
    wipe(b);
  }
}

/** WIF → {sk, compressed}; throws KeyError for another network's key. */
export function fromWif(wif, net) {
  let b;
  try {
    b = base58checkDecode(wif);
  } catch {
    throw new KeyError('key', 'Not a WIF private key.');
  }
  try {
    if (b[0] !== net.wif) throw new KeyError('key', `Not a ${net.name} private key.`);
    if (b.length === 34 && b[33] === 0x01) return { sk: b.slice(1, 33), compressed: true };
    if (b.length === 33) return { sk: b.slice(1, 33), compressed: false };
    throw new KeyError('key', 'Not a WIF private key.');
  } finally {
    wipe(b);
  }
}

function checkSecretKey(sk) {
  if (!(sk instanceof Uint8Array) || sk.length !== 32 || !secp256k1.utils.isValidSecretKey(sk)) throw new KeyError('key', 'Not a valid secp256k1 secret key.');
}

/** Compressed 33-byte public key. */
export function publicKeyOf(sk) {
  checkSecretKey(sk);
  return secp256k1.getPublicKey(sk, true);
}

// ---------------------------------------------------------------- BIP32

function parsePath(path) {
  if (!/^m(\/\d+'?)+$/.test(path)) throw new KeyError('path', `Bad derivation path: ${path}`);
  return path
    .split('/')
    .slice(1)
    .map((p) => Number(p.replace("'", '')) + (p.endsWith("'") ? 0x80000000 : 0));
}

/** Derives `path` from `node`, wiping every intermediate private key. Returns a new node. */
function derivePath(node, path) {
  let cur = node;
  for (const index of parsePath(path)) {
    const next = cur.deriveChild(index);
    if (cur !== node) cur.wipePrivateData();
    cur = next;
  }
  return cur;
}

/**
 * The keys of one Firo wallet. Built from a seed (full) or an account xpub
 * (view-only: addresses, no signing, no Spark key).
 */
export class FiroKeys {
  /** @private use FiroKeys.fromMnemonic / fromSeed / fromXpub */
  constructor(net, { account, viewOnly }) {
    this.net = net;
    this.viewOnly = viewOnly;
    this._account = account; // HDKey at m/44'/coin'/0'
    this._chains = new Map(); // chain → HDKey
    this._addr = new Map(); // `${chain}/${index}` → entry
  }

  static async fromMnemonic(phrase, passphrase, net) {
    const seed = await mnemonicToSeed(phrase, passphrase);
    try {
      return FiroKeys.fromSeed(seed, net);
    } finally {
      wipe(seed);
    }
  }

  static fromSeed(seed, net) {
    const root = HDKey.fromMasterSeed(seed, net.bip32);
    try {
      const account = derivePath(root, `m/44'/${net.coinType}'/0'`);
      const keys = new FiroKeys(net, { account, viewOnly: false });
      // The Spark key sits on the account's chain 6; derive it now so the root can go.
      keys._spark = derivePath(account, `m/${CHAIN_SPARK}/${SPARK_KEY_INDEX}`);
      return keys;
    } finally {
      root.wipePrivateData();
    }
  }

  /** View-only from the account-level extended public key (xpub… / tpub…). */
  static fromXpub(xpub, net) {
    let account;
    try {
      account = HDKey.fromExtendedKey(xpub, net.bip32);
    } catch {
      throw new KeyError('key', `Not a ${net.name} extended public key.`);
    }
    if (account.privateKey) {
      account.wipePrivateData();
      throw new KeyError('key', 'That is a private key. A view-only wallet takes the public key (xpub).');
    }
    if (account.depth !== 3) throw new KeyError('key', "Use the account key (m/44'/136'/0'), depth 3.");
    return new FiroKeys(net, { account, viewOnly: true });
  }

  _chain(chain) {
    if (!this._account) throw new KeyError('key', 'The keys were wiped.');
    let c = this._chains.get(chain);
    if (!c) {
      c = this._account.deriveChild(chain);
      this._chains.set(chain, c);
    }
    return c;
  }

  /** {chain, index, path, address, pubkey, script, scripthash} for a transparent address. */
  address(chain, index) {
    if (chain !== CHAIN_RECEIVE && chain !== CHAIN_CHANGE) throw new KeyError('path', 'Transparent chains are 0 and 1.');
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new KeyError('path', 'Bad address index.');
    const k = `${chain}/${index}`;
    let e = this._addr.get(k);
    if (!e) {
      const node = this._chain(chain).deriveChild(index);
      const pubkey = node.publicKey;
      node.wipePrivateData();
      const script = p2pkhScript(hash160(pubkey));
      e = Object.freeze({ chain, index, path: bip44Path(this.net, chain, index), address: pubkeyToAddress(pubkey, this.net), pubkey, script, scripthash: scriptHash(script) });
      this._addr.set(k, e);
    }
    return e;
  }

  /** The 32-byte private key of a transparent address (a copy; the caller wipes it). */
  privateKey(chain, index) {
    if (this.viewOnly) throw new KeyError('key', 'This is a view-only wallet.');
    const node = this._chain(chain).deriveChild(index);
    try {
      return Uint8Array.from(node.privateKey);
    } finally {
      node.wipePrivateData();
    }
  }

  wif(chain, index) {
    const sk = this.privateKey(chain, index);
    try {
      return toWif(sk, this.net);
    } finally {
      wipe(sk);
    }
  }

  /** The Spark key material: the private key at m/44'/coin'/0'/6/1 (a copy). */
  sparkKeyMaterial() {
    if (this.viewOnly || !this._spark) throw new KeyError('key', 'This wallet has no Spark spend key.');
    return Uint8Array.from(this._spark.privateKey);
  }

  /** Account-level extended public key (xpub / tpub) for view-only wallets. */
  xpub() {
    if (!this._account) throw new KeyError('key', 'The keys were wiped.');
    return this._account.publicExtendedKey;
  }

  /** Forget every private key held here. */
  wipe() {
    for (const c of this._chains.values()) c.wipePrivateData();
    this._chains.clear();
    if (this._spark) this._spark.wipePrivateData();
    if (this._account) this._account.wipePrivateData();
    this._spark = null;
    this._account = null;
  }
}

export { ENGLISH as BIP39_ENGLISH };
