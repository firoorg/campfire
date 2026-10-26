// The recovery words of a wallet, kept on this device so the engine can open the wallet at each
// unlock (WALLET_API.md open({mnemonic, passphrase})). Firo's engine derives every key from them;
// unlike a wallet database file, there is nothing else to open.
//
// Sealed, never in the clear: AES-256-GCM under a key made with HKDF-SHA256 from the wallet's
// random 32-byte secret (app.dbPass, which itself is kept only inside the password and passkey
// envelopes, lib/envelope.js), its own info string, a random salt and IV. Every header field and
// the wallet id are additional data: a sealed seed moved to another wallet, or edited, does not
// open. The words come out only while the wallet is unlocked (start, Backup -> Show the words,
// the encrypted backup file), and are dropped as soon as they were used.

import { randomBytes, b64, unb64 } from './envelope.js';
import { t } from './i18n.js';

export const SEED_INFO = 'campfire-firo-seed-v1';
const VERSION = 1;
const KIND = 'firo-seed';
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class SeedError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'malformed' | 'wrong_secret' | 'locked'
  }
}

function hexBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) throw new SeedError('locked', t('Unlock the wallet first.'));
  return Uint8Array.from(hex.match(/../g), (x) => parseInt(x, 16));
}

async function keyOf(dbPass, salt) {
  const base = await subtle().importKey('raw', hexBytes(dbPass), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(SEED_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const aad = (env) => enc.encode(JSON.stringify([env.v, env.kind, env.walletId, env.salt]));

/** {mnemonic, passphrase} sealed for wallet `walletId` under its secret `dbPass` (64 hex). */
export async function sealSeed(dbPass, walletId, { mnemonic, passphrase = '', viewKey = '', xpub = '' }) {
  const watch = !mnemonic && (viewKey || xpub);
  if (!watch && (typeof mnemonic !== 'string' || !mnemonic.trim())) throw new SeedError('malformed', t('No recovery words to keep.'));
  const salt = randomBytes(16);
  const env = { v: VERSION, kind: KIND, walletId, salt: b64(salt) };
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, await keyOf(dbPass, salt), enc.encode(JSON.stringify(watch ? { viewKey: String(viewKey || ''), xpub: String(xpub || '') } : { mnemonic, passphrase: String(passphrase || '') })));
  return { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** The words and passphrase back, or SeedError('wrong_secret'). */
export async function openSeed(dbPass, walletId, env) {
  if (!env || env.v !== VERSION || env.kind !== KIND || typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') throw new SeedError('malformed', t('This wallet keeps no recovery words this app can read.'));
  if (env.walletId !== walletId) throw new SeedError('wrong_secret', t('These recovery words belong to another wallet.'));
  const key = await keyOf(dbPass, unb64(env.salt)); // a missing secret is 'locked', not a wrong one
  let pt;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, key, unb64(env.ct));
  } catch {
    throw new SeedError('wrong_secret', t('The recovery words did not open.'));
  }
  const o = JSON.parse(dec.decode(pt));
  // A watch-only wallet keeps a Spark view key and/or an xpub instead of words.
  if (!o.mnemonic && (o.viewKey || o.xpub)) return { mnemonic: null, passphrase: '', viewKey: String(o.viewKey || ''), xpub: String(o.xpub || '') };
  return { mnemonic: String(o.mnemonic), passphrase: String(o.passphrase || '') };
}
