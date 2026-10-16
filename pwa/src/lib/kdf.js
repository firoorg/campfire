// SPDX-License-Identifier: MIT
// The key derivation every sealed record on this device shares (the Ethereum key, the engine's
// store, the swap and bridge records): a key-encryption key from the wallet's unlocked secret
// (app.dbPass). Its own module, with no curve code, because the engine's sealed store needs it on
// the first screen while the Ethereum code must stay unloaded until Ethereum is opened.
//
//   every wallet: dbPass is 32 random bytes (64 hex) -> HKDF-SHA256(dbPass, salt, info)
//   a secret a person chose (record.imported) -> PBKDF2-SHA256(dbPass, salt, >= 600,000 rounds)

import { PBKDF2_MIN_ITERATIONS, unb64 } from './envelope.js';

export const KDF_HKDF = 'hkdf-sha256';
export const KDF_PBKDF2 = 'pbkdf2-sha256';
// Above this, opening would hang the page for minutes: a corrupted or hostile record.
export const MAX_ITERATIONS = 20000000;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'locked' | 'missing' | 'exists' | 'wrong_secret' | 'malformed' | 'weak' | 'mismatch'
  }
}

/** Which KDF a wallet's sealed records must use. */
export function kdfFor(imported) {
  return imported ? KDF_PBKDF2 : KDF_HKDF;
}

export function checkIterations(n) {
  if (!Number.isSafeInteger(n)) throw new VaultError('malformed', 'Bad PBKDF2 round count.');
  if (n < PBKDF2_MIN_ITERATIONS) throw new VaultError('weak', 'Too few PBKDF2 rounds; refusing.');
  if (n > MAX_ITERATIONS) throw new VaultError('malformed', 'Implausible PBKDF2 round count.');
}

/**
 * The AES-256-GCM key-encryption key for an envelope {kdf, salt, iterations?} under dbPass.
 * `info` separates uses: each kind of record has its own.
 */
export async function deriveWrappingKey(env, dbPass, info) {
  if (typeof info !== 'string' || !info) throw new VaultError('malformed', 'A sealing key needs its own purpose.');
  if (typeof dbPass !== 'string' || dbPass.length === 0) throw new VaultError('locked', 'Unlock the wallet first.');
  const salt = unb64(env.salt);
  if (env.kdf === KDF_HKDF) {
    if (!/^[0-9a-f]{64}$/.test(dbPass)) throw new VaultError('malformed', "This wallet's database password is not a random one; it cannot use HKDF.");
    const ikm = Uint8Array.from(dbPass.match(/../g), (x) => parseInt(x, 16));
    try {
      const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
      return await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally {
      ikm.fill(0);
    }
  }
  const pw = enc.encode(dbPass.normalize('NFC'));
  try {
    const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
    return await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: env.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    pw.fill(0);
  }
}
