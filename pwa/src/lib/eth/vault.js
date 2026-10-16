// The Ethereum key at rest. The Ethereum wallet has its own recovery words
// (as in the desktop app), or was imported from a private key; the words are
// never stored, only the 32-byte key (derived from them, or as typed), sealed
// the same way in both cases under the Firo wallet's secret
// (app.dbPass). The password and passkey envelopes in lib/session.js already
// open dbPass, so unlocking, Face ID and Change password need nothing new,
// and locking (which forgets dbPass) also locks the Ethereum key.
//
// Key-encryption key:
//   every Firo wallet: dbPass is 32 random bytes (64 hex)
//     → HKDF-SHA256(dbPass bytes, random 16-byte salt, info "campfire-firo-eth-key-v1")
//   a wallet whose secret a person chose (record.imported; none today, kept
//     for safety): PBKDF2-SHA256(dbPass, salt, >= 600,000 rounds), no easier to
//     attack than the password envelope itself.
// The envelope is AES-256-GCM over sk ‖ address (52 bytes) with every
// envelope field bound as additional data, so a lowered round count, a
// swapped KDF or another wallet's id makes it fail to open. The address is
// derived again from the opened key and must match.

import { privateKeyToAddress, wipe, ETH_PATH, MNEMONIC_LENGTHS } from './crypto.js';
import { hexToBytes, bytesToHex, concatBytes } from './hex.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, toHex, b64, unb64 } from '../envelope.js';
import { store } from '../store.js';
import { ETH_RECORD_KEY, ethRecordKind, ETH_KINDS } from './record.js';
import { KDF_HKDF, KDF_PBKDF2, VaultError, kdfFor, checkIterations, deriveWrappingKey as kdfDerive } from '../kdf.js';

export { ETH_RECORD_KEY, ethRecordKind };
export { KDF_HKDF, KDF_PBKDF2, VaultError, kdfFor, checkIterations };
export const ETH_KEY_INFO = 'campfire-firo-eth-key-v1';
const VERSION = 1;
const KIND = 'eth-key';

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

function aad(env) {
  return enc.encode(JSON.stringify([env.v, env.kind, env.walletId, env.ethId, env.kdf, env.iterations || 0, env.salt]));
}

/** The key-encryption key for an envelope under dbPass (lib/kdf.js); the Ethereum key's by default. */
export function deriveWrappingKey(env, dbPass, info = ETH_KEY_INFO) {
  return kdfDerive(env, dbPass, info);
}

/**
 * The AES-256-GCM key for another envelope sealed under the same dbPass (the
 * NEAR Intents' swap records): env {kdf, salt, iterations?}, a different HKDF
 * `info` per purpose. The same derivation and checks as the Ethereum key's.
 */
export async function sealingKey(env, dbPass, info) {
  if (typeof info !== 'string' || !info || info === ETH_KEY_INFO) throw new VaultError('malformed', 'A sealing key needs its own purpose.');
  if (env.kdf !== KDF_HKDF && env.kdf !== KDF_PBKDF2) throw new VaultError('malformed', 'Unknown key derivation.');
  if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
  return deriveWrappingKey(env, dbPass, info);
}


function addressMatches(sk, address) {
  try {
    return privateKeyToAddress(sk).toLowerCase() === String(address).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Seals {sk, address} for the Firo wallet `walletId`.
 * imported: whether that wallet's secret was chosen by a person (see the top of this file).
 */
export async function sealEthKey({ sk, address, dbPass, walletId, imported, ethId = toHex(randomBytes(8)), iterations = PBKDF2_MIN_ITERATIONS }) {
  if (typeof walletId !== 'string' || !walletId) throw new VaultError('missing', 'No Firo wallet to seal the Ethereum key under.');
  if (!(sk instanceof Uint8Array) || sk.length !== 32 || !addressMatches(sk, address)) throw new VaultError('mismatch', 'The key does not belong to that address.');
  const kdf = kdfFor(imported);
  const env = { v: VERSION, kind: KIND, walletId, ethId, kdf, salt: b64(randomBytes(16)) };
  if (kdf === KDF_PBKDF2) {
    checkIterations(iterations);
    env.iterations = iterations;
  }
  const iv = randomBytes(12);
  const pt = concatBytes(sk, hexToBytes(address));
  try {
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, await deriveWrappingKey(env, dbPass), pt);
    return { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  } finally {
    wipe(pt);
  }
}

/**
 * Opens an envelope → {sk, address}. The caller zeroes sk (wipe) when done;
 * withEthKey() does it for you.
 */
export async function openEthKey(env, { dbPass, walletId, imported }) {
  if (!env || env.v !== VERSION || env.kind !== KIND || typeof env.walletId !== 'string' || typeof env.ethId !== 'string') throw new VaultError('malformed', 'Not an Ethereum key envelope.');
  if (typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new VaultError('malformed', 'Envelope fields missing.');
  if (env.walletId !== walletId) throw new VaultError('mismatch', 'This Ethereum key belongs to another Firo wallet.');
  const want = kdfFor(imported);
  if (env.kdf !== want) {
    // An imported wallet's key under HKDF would be one guessed password away.
    throw new VaultError(want === KDF_PBKDF2 ? 'weak' : 'malformed', 'This envelope uses the wrong key derivation for this wallet; refusing it.');
  }
  if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
  else if (env.iterations !== undefined) throw new VaultError('malformed', 'Unexpected round count.');
  const key = await deriveWrappingKey(env, dbPass);
  let pt;
  try {
    pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, key, unb64(env.ct)));
  } catch {
    throw new VaultError('wrong_secret', 'The Ethereum key did not open.');
  }
  try {
    if (pt.length !== 52) throw new VaultError('malformed', 'Bad Ethereum key length.');
    const sk = pt.slice(0, 32);
    const address = privateKeyToAddress(sk);
    if (address.toLowerCase() !== bytesToHex(pt.subarray(32))) {
      wipe(sk);
      throw new VaultError('mismatch', 'The opened key does not match its address.');
    }
    return { sk, address };
  } finally {
    wipe(pt);
  }
}

// ---------------------------------------------------------------- record and app adapter
//
// The record lives next to the wallet record in the app's own store
// ("campfire-firo-app", key 'eth', per Firo wallet), so deleting that wallet
// removes it:
//   words: {v, id, createdAt, kind: 'words', words, passphrase, path, envelope}
//   key:   {v, id, createdAt, kind: 'key', envelope}
// kind: what brings the wallet back, so Settings shows the right backup;
// records written before private keys could be imported have none and are
// words (ethRecordKind). words: how many the person has written down;
// passphrase: whether a BIP39 passphrase was used (never the passphrase
// itself). The envelope is the same for both kinds. The address is only
// inside it: in the clear it would link this Firo wallet to a public
// Ethereum address for anyone who can read the storage.

/** {walletId, imported, dbPass} of the unlocked Firo wallet, or a VaultError. */
export function walletOf(app) {
  if (!app || !app.record || typeof app.record.id !== 'string') throw new VaultError('missing', 'There is no Firo wallet on this device.');
  if (!app.dbPass) throw new VaultError('locked', 'Unlock the wallet first.');
  // record.imported: a wallet whose secret a person chose (none today); read directly so
  // this module does not pull in the session code.
  return { walletId: app.record.id, imported: Boolean(app.record.imported), dbPass: app.dbPass };
}

export async function getEthRecord(kv = store) {
  return (await kv.get(ETH_RECORD_KEY)) || null;
}

/**
 * Seals and stores a key: derived from words (kind 'words', with how many),
 * or a private key as typed (kind 'key'). Refuses to replace one unless asked.
 */
export async function saveEthKey(app, { sk, address, kind = 'words', words, passphrase = false, path = ETH_PATH }, { kv = store, replace = false } = {}) {
  const w = walletOf(app);
  if (!ETH_KINDS.includes(kind)) throw new VaultError('malformed', 'Unknown kind of Ethereum wallet.');
  if (kind === 'words' && !MNEMONIC_LENGTHS.includes(words)) throw new VaultError('malformed', 'An Ethereum wallet has 12, 15, 18, 21 or 24 words.');
  if (kind === 'key' && (words !== undefined || passphrase)) throw new VaultError('malformed', 'A private key has no words or passphrase.');
  if (!replace && (await getEthRecord(kv))) throw new VaultError('exists', 'This device already has an Ethereum wallet.');
  const envelope = await sealEthKey({ sk, address, dbPass: w.dbPass, walletId: w.walletId, imported: w.imported });
  const base = { v: VERSION, id: envelope.ethId, createdAt: Date.now(), kind };
  const record = kind === 'key' ? { ...base, envelope } : { ...base, words, passphrase: Boolean(passphrase), path, envelope };
  await kv.set(ETH_RECORD_KEY, record);
  return record;
}

/** Opens the stored key → {sk, address}; the caller wipes sk. */
export async function openEthKeyFor(app, kv = store) {
  const w = walletOf(app);
  const record = await getEthRecord(kv);
  if (!record) throw new VaultError('missing', 'There is no Ethereum wallet on this device.');
  if (record.v !== VERSION || !record.envelope || record.envelope.ethId !== record.id || !ethRecordKind(record)) throw new VaultError('malformed', 'Not an Ethereum wallet record.');
  return openEthKey(record.envelope, w);
}

/** Runs fn({sk, address}) with the key open, and zeroes the key afterwards whatever happens. */
export async function withEthKey(app, fn, kv = store) {
  const k = await openEthKeyFor(app, kv);
  try {
    return await fn(k);
  } finally {
    wipe(k.sk);
  }
}

export async function removeEthKey(kv = store) {
  await kv.del(ETH_RECORD_KEY);
}
