// Key envelopes: how the wallet's database password is kept on the device.
//
// Each wallet gets a random 32-byte database password (hex). The engine needs
// it to open wallet.db; it is never shown, logged or stored in the clear.
// It is stored only inside envelopes (AES-256-GCM, random 12-byte IV), each
// sealed under one key-encryption key (KEK):
//
//   password envelope: KEK = scrypt(password, random 16-byte salt, N 2^16, r 8, p 1)  (version 2)
//                      Version 1, PBKDF2-SHA256 (>= 600,000 rounds), still opens, and is sealed again
//                      as version 2 the next time the password is typed (public audit, P9: PBKDF2
//                      costs a graphics card little per guess; scrypt needs 64 MiB of memory for each).
//   passkey envelope:  KEK = HKDF-SHA256(WebAuthn PRF output, salt, info "campfire-firo-kek-v1")
//                      (envelopes made before 0.1.4 have no `info` field and used the label of the code
//                      this app was ported from, "beam-campfire-kek-v1"; they still open)
//
// The envelope's own fields (version, kind, wallet id, rounds, credential id,
// salts) are bound as AES-GCM additional data, so changing any of them makes
// the envelope fail to open instead of, say, quietly lowering the rounds.
// Works in browsers and in Node 22 (globalThis.crypto).

export const PBKDF2_MIN_ITERATIONS = 600000;
export const KEK_INFO = 'campfire-firo-kek-v1';
const LEGACY_KEK_INFO = 'beam-campfire-kek-v1';
const ENVELOPE_VERSION = 1;
/** A password envelope under scrypt (P9). */
const SCRYPT_VERSION = 2;
/** scrypt's cost: 64 MiB and well under a second on a phone; what a new password envelope uses. */
export const SCRYPT = Object.freeze({ N: 2 ** 16, r: 8, p: 1 });
/** What an envelope may ask for, no more (a changed record must not hang the unlock), no less. */
const SCRYPT_LIMITS = Object.freeze({ minN: 2 ** 15, maxN: 2 ** 20, minR: 8, maxR: 16, maxP: 4 });

/** Whether `env`'s parameters are ones this version would use: throws EnvelopeError otherwise. */
export function checkScrypt({ N, r, p }) {
  const pow2 = Number.isSafeInteger(N) && N > 0 && (N & (N - 1)) === 0;
  if (!pow2 || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) throw new EnvelopeError('malformed', 'Bad scrypt parameters.');
  if (N < SCRYPT_LIMITS.minN || r < SCRYPT_LIMITS.minR || p < 1) throw new EnvelopeError('weak', 'Too weak scrypt parameters; refusing.');
  if (N > SCRYPT_LIMITS.maxN || r > SCRYPT_LIMITS.maxR || p > SCRYPT_LIMITS.maxP) throw new EnvelopeError('malformed', 'This wallet record asks for an implausible key cost, so it was not opened.');
}

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class EnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'wrong_secret' | 'malformed' | 'weak'
  }
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function toHex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function b64(u8) {
  let s = '';
  const a = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

export function unb64(s) {
  if (typeof s !== 'string') throw new EnvelopeError('malformed', 'bad base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh random database password: 32 bytes as 64 hex characters. */
export function newDbPassword() {
  return toHex(randomBytes(32));
}

function aad(env) {
  return enc.encode(
    JSON.stringify([
      env.v,
      env.kind,
      env.walletId,
      env.iterations || 0,
      env.credId || '',
      env.salt || '',
      // Bound only where present, so envelopes made before it still open.
      ...(env.info ? [env.info] : []),
      // A version 2 password envelope binds its scrypt cost too.
      ...(env.v === SCRYPT_VERSION ? [env.kdf, env.N, env.r, env.p] : []),
    ]),
  );
}

/** The scrypt key-encryption key (non-extractable AES-256-GCM). */
async function scryptKek(password, salt, { N, r, p }) {
  const { scryptAsync } = await import('../vendor/noble/noble-hashes/scrypt.js');
  const raw = await scryptAsync(enc.encode(password.normalize('NFC')), salt, { N, r, p, dkLen: 32, asyncTick: 10, maxmem: 256 * 1024 * 1024 });
  try {
    return await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

async function passwordKek(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function prfKek(prfOutput, salt, info = KEK_INFO) {
  const ikm = prfOutput instanceof Uint8Array ? prfOutput : new Uint8Array(prfOutput);
  if (ikm.length < 32) throw new EnvelopeError('malformed', 'PRF output too short');
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(env, kek, secret) {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, kek, enc.encode(secret));
  return { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

async function open(env, kek) {
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, kek, unb64(env.ct));
    return dec.decode(pt);
  } catch {
    throw new EnvelopeError('wrong_secret', 'The envelope did not open.');
  }
}

function checkShape(env, kind) {
  const versionOk = env && (env.v === ENVELOPE_VERSION || (kind === 'password' && env.v === SCRYPT_VERSION && env.kdf === 'scrypt'));
  if (!versionOk || env.kind !== kind || typeof env.walletId !== 'string')
    throw new EnvelopeError('malformed', 'Not a Campfire envelope.');
  if (typeof env.iv !== 'string' || typeof env.ct !== 'string' || typeof env.salt !== 'string')
    throw new EnvelopeError('malformed', 'Envelope fields missing.');
}

/**
 * A password envelope: scrypt (version 2) unless `kdf: 'pbkdf2'` asks for the version 1 kind (kept
 * for tests of what older versions wrote).
 */
export async function sealWithPassword(secret, password, walletId, { kdf = 'scrypt', iterations = PBKDF2_MIN_ITERATIONS, scrypt = SCRYPT } = {}) {
  if (typeof password !== 'string' || password.length === 0) throw new EnvelopeError('malformed', 'Empty password');
  const salt = randomBytes(16);
  if (kdf === 'scrypt') {
    checkScrypt(scrypt);
    const env = { v: SCRYPT_VERSION, kind: 'password', walletId, kdf: 'scrypt', N: scrypt.N, r: scrypt.r, p: scrypt.p, salt: b64(salt) };
    return seal(env, await scryptKek(password, salt, scrypt), secret);
  }
  if (iterations < PBKDF2_MIN_ITERATIONS) throw new EnvelopeError('weak', 'Too few PBKDF2 rounds');
  const env = { v: ENVELOPE_VERSION, kind: 'password', walletId, iterations, salt: b64(salt) };
  return seal(env, await passwordKek(password, salt, iterations), secret);
}

/** More rounds than any version asks for: a record with more was changed, and would hang the unlock (public audit, PN-keys). */
export const PBKDF2_MAX_ITERATIONS = 20000000;

/** Whether a password envelope is of the old kind (PBKDF2): sealed again under scrypt once the password is typed (P9). */
export function passwordEnvelopeOutdated(env) {
  return Boolean(env) && env.kind === 'password' && env.v === ENVELOPE_VERSION;
}

export async function openWithPassword(env, password) {
  checkShape(env, 'password');
  if (env.v === SCRYPT_VERSION) {
    checkScrypt(env);
    return open(env, await scryptKek(password, unb64(env.salt), env));
  }
  if (!Number.isSafeInteger(env.iterations) || env.iterations < PBKDF2_MIN_ITERATIONS)
    throw new EnvelopeError('weak', 'This envelope asks for too few PBKDF2 rounds; refusing it.');
  if (env.iterations > PBKDF2_MAX_ITERATIONS) throw new EnvelopeError('malformed', 'This wallet record asks for an implausible number of key rounds, so it was not opened.');
  return open(env, await passwordKek(password, unb64(env.salt), env.iterations));
}

/** prfOutput: the 32-byte WebAuthn PRF result for this credential and prfSalt. */
export async function sealWithPrf(secret, prfOutput, walletId, credId, prfSalt) {
  if (typeof credId !== 'string' || !credId) throw new EnvelopeError('malformed', 'Missing credential id');
  const salt = randomBytes(16);
  const env = { v: ENVELOPE_VERSION, kind: 'passkey', walletId, credId, prfSalt: b64(prfSalt), salt: b64(salt), info: KEK_INFO };
  return seal(env, await prfKek(prfOutput, salt), secret);
}

export async function openWithPrf(env, prfOutput) {
  checkShape(env, 'passkey');
  // No label: an envelope from before 0.1.4 (see the top). Any other label is not one we made.
  if (env.info !== undefined && env.info !== KEK_INFO) throw new EnvelopeError('malformed', 'Not a Campfire envelope.');
  return open(env, await prfKek(prfOutput, unb64(env.salt), env.info === undefined ? LEGACY_KEK_INFO : KEK_INFO));
}
