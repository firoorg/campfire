// Ethereum data that would link the Firo wallet to a public Ethereum address
// if anyone who can read this device's storage could read it: what this
// device sent (a signed transaction names its sender) and the NEAR Intents
// swaps. Sealed like the key (lib/eth/vault.js): AES-256-GCM under a key
// derived from the Firo wallet's secret, HKDF for its random secret
// (PBKDF2 >= 600,000 rounds for a chosen one, as the key), with
// its own info string ("campfire-firo-eth-data-v1") so the data key is never
// the key's key.
//
// A record keeps its salt when it is rewritten, so the derived key is reused:
// a PBKDF2 wallet pays its 600,000 rounds once per unlock, not on every write.
// The derived keys are non-extractable and forgotten on lock
// (forgetDataKeys()). Every envelope field, the record's name and the
// Ethereum wallet it belongs to are bound as additional data.

import { VaultError, KDF_PBKDF2, kdfFor, deriveWrappingKey, checkIterations, walletOf } from './vault.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, b64, unb64 } from '../envelope.js';
import { store } from '../store.js';
import { t } from '../i18n.js';

export const ETH_DATA_INFO = 'campfire-firo-eth-data-v1';
const VERSION = 1;
const KIND = 'eth-data';
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// "walletId|kdf|salt|iterations" -> {tag, key}; a key is used only with the secret it came from,
// known by a digest of it: never the secret itself, which outlived Lock here on a path that had
// not loaded an Ethereum screen (public audit, P17).
const cache = new Map();
// The apps whose Lock already drops these keys.
const hooked = new WeakSet();

async function tagOf(dbPass) {
  const bytes = dbPass instanceof Uint8Array ? dbPass : enc.encode(String(dbPass));
  return b64(new Uint8Array(await subtle().digest('SHA-256', bytes)));
}

async function keyFor(env, dbPass) {
  const id = [env.walletId, env.kdf, env.salt, env.iterations || 0].join('|');
  const tag = await tagOf(dbPass);
  const hit = cache.get(id);
  if (hit && hit.tag === tag) return hit.key;
  const key = await deriveWrappingKey(env, dbPass, ETH_DATA_INFO);
  cache.set(id, { tag, key });
  return key;
}

/** Lock drops the keys derived for `app`, whichever path first sealed or opened data (P17). */
function forgetOnLock(app) {
  if (!app || !app.lockHooks || hooked.has(app)) return;
  hooked.add(app);
  app.lockHooks.add(forgetDataKeys);
}

/** Drops every derived data key (on lock, and when the Ethereum wallet is removed). */
export function forgetDataKeys() {
  cache.clear();
}

/** The cache itself, for the unit tests (that it never holds the secret, and Lock empties it). */
export const __cacheForTests = () => cache;

function aad(env) {
  return enc.encode(JSON.stringify([env.v, env.kind, env.name, env.walletId, env.ethId, env.kdf, env.iterations || 0, env.salt]));
}

function sameShape(env, name) {
  return Boolean(env) && env.v === VERSION && env.kind === KIND && env.name === name && typeof env.walletId === 'string' && typeof env.ethId === 'string' && typeof env.salt === 'string' && typeof env.iv === 'string' && typeof env.ct === 'string';
}

/** Seals `value` (JSON) as record `name` of the Ethereum wallet `ethId`. */
export async function sealData(app, name, value, { ethId, kv = store } = {}) {
  const w = walletOf(app);
  forgetOnLock(app);
  if (typeof ethId !== 'string' || !ethId) throw new VaultError('missing', t('No Ethereum wallet to seal the data for.'));
  const kdf = kdfFor(w.imported);
  const prev = await kv.get(name);
  const reuse = sameShape(prev, name) && prev.walletId === w.walletId && prev.ethId === ethId && prev.kdf === kdf;
  const env = { v: VERSION, kind: KIND, name, walletId: w.walletId, ethId, kdf, salt: reuse ? prev.salt : b64(randomBytes(16)) };
  if (kdf === KDF_PBKDF2) {
    env.iterations = reuse ? prev.iterations : PBKDF2_MIN_ITERATIONS;
    checkIterations(env.iterations);
  }
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, await keyFor(env, w.dbPass), enc.encode(JSON.stringify(value)));
  const out = { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
  await kv.set(name, out);
  return out;
}

/**
 * Opens record `name` of the Ethereum wallet `ethId`. null when there is none,
 * or when it belongs to an Ethereum wallet that has since been removed.
 */
export async function openData(app, name, { ethId, kv = store } = {}) {
  const w = walletOf(app);
  forgetOnLock(app);
  const env = await kv.get(name);
  if (env == null) return null;
  if (!sameShape(env, name)) throw new VaultError('malformed', t('Not a sealed Ethereum record.'));
  if (env.walletId !== w.walletId) throw new VaultError('mismatch', t('This record belongs to another Firo wallet.'));
  if (env.ethId !== ethId) return null;
  const want = kdfFor(w.imported);
  if (env.kdf !== want) throw new VaultError(want === KDF_PBKDF2 ? 'weak' : 'malformed', t('This record uses the wrong key derivation for this wallet; refusing it.'));
  if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
  else if (env.iterations !== undefined) throw new VaultError('malformed', t('Unexpected round count.'));
  let pt;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, await keyFor(env, w.dbPass), unb64(env.ct));
  } catch {
    throw new VaultError('wrong_secret', t('The Ethereum record did not open.'));
  }
  return JSON.parse(dec.decode(pt));
}
