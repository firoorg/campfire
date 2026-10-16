// The encrypted backup file (Settings -> Backup -> "Save an encrypted backup", and the cloud copy):
// the wallet's recovery words, its BIP39 passphrase, the block it was made at and its name, in
// one small JSON file that opens only with a password. Welcome -> "Restore from a backup file"
// reads it back. Nothing is uploaded: the file goes to the share sheet or the downloads.
//
// Format (v2, from 0.1.8): {app: "campfire-firo", kind: "wallet-backup", v: 2, kdf: "scrypt", N, r,
// p, salt, iv, ct, created}. Key = scrypt(password NFC, salt, N, r, p) -> AES-256-GCM (public
// audit, P9: PBKDF2 costs a graphics card little per guess; scrypt needs 64 MiB of memory for each,
// and a copy in a cloud account can be guessed at for as long as anyone likes). v1, PBKDF2-SHA256
// with iterations (>= 600,000), still restores. Every header field is additional data, so an edited
// header (a lower cost, another app) makes the file refuse to open; a file asking for less than this
// version would, or for an implausible cost, is refused before any guess is tried. The plaintext is
// {mnemonic, passphrase, birthday, name, network}.
//
// The file is the wallet: anyone with the file and its password can take the money. A copy
// kept in a cloud account can be attacked offline for as long as anyone likes, so its password
// is at least CLOUD_MIN_PASSWORD characters (screens/backup.js asks for a longer one when needed).

import { PBKDF2_MIN_ITERATIONS, randomBytes, b64, unb64, SCRYPT, checkScrypt } from './envelope.js';

export const BACKUP_APP = 'campfire-firo';
export const BACKUP_KIND = 'wallet-backup';
export const BACKUP_VERSION = 2;
/** The first format (PBKDF2): still restored. */
const BACKUP_V1 = 1;
export const BACKUP_MAX_BYTES = 64 * 1024;
export const CLOUD_MIN_PASSWORD = 12;
const MAX_ITERATIONS = 20000000;
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'not_backup' | 'weak' | 'wrong_password' | 'too_big' | 'empty'
  }
}

export function backupFileName(now = new Date()) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `campfire-firo-backup-${d}.json`;
}

const header = (f) => (f.v === BACKUP_V1 ? { app: f.app, kind: f.kind, v: f.v, kdf: f.kdf, iterations: f.iterations, salt: f.salt } : { app: f.app, kind: f.kind, v: f.v, kdf: f.kdf, N: f.N, r: f.r, p: f.p, salt: f.salt });
const aad = (f) => enc.encode(JSON.stringify(header(f)));

async function keyOf(password, f) {
  const pw = enc.encode(String(password).normalize('NFC'));
  if (f.v === BACKUP_V1) {
    const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(f.salt), iterations: f.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const { scryptAsync } = await import('../vendor/noble/noble-hashes/scrypt.js');
  const raw = await scryptAsync(pw, unb64(f.salt), { N: f.N, r: f.r, p: f.p, dkLen: 32, asyncTick: 10, maxmem: 256 * 1024 * 1024 });
  try {
    return await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } finally {
    raw.fill(0);
  }
}

/** The backup's JSON text. secret: {mnemonic, passphrase?, birthday?, name?, network?}. */
export async function makeBackup(secret, password, { kdf = 'scrypt', iterations = PBKDF2_MIN_ITERATIONS, scrypt = SCRYPT, now = new Date() } = {}) {
  if (!secret || typeof secret.mnemonic !== 'string' || !secret.mnemonic.trim()) throw new BackupError('empty', 'Nothing to back up.');
  if (typeof password !== 'string' || !password) throw new BackupError('weak', 'Choose a password for the file.');
  const salt = randomBytes(16);
  let f;
  if (kdf === 'scrypt') {
    checkScrypt(scrypt);
    f = { app: BACKUP_APP, kind: BACKUP_KIND, v: BACKUP_VERSION, kdf: 'scrypt', N: scrypt.N, r: scrypt.r, p: scrypt.p, salt: b64(salt) };
  } else {
    // The first format, as 0.1.7 and before wrote it (kept for the tests of restoring one).
    if (iterations < PBKDF2_MIN_ITERATIONS) throw new BackupError('weak', 'Too few PBKDF2 rounds.');
    f = { app: BACKUP_APP, kind: BACKUP_KIND, v: BACKUP_V1, kdf: 'pbkdf2-sha256', iterations, salt: b64(salt) };
  }
  const iv = randomBytes(12);
  const body = { mnemonic: secret.mnemonic, passphrase: String(secret.passphrase || ''), birthday: Number.isSafeInteger(secret.birthday) ? secret.birthday : null, name: String(secret.name || ''), network: secret.network === 'test' ? 'test' : 'main' };
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(f) }, await keyOf(password, f), enc.encode(JSON.stringify(body)));
  return JSON.stringify({ ...f, iv: b64(iv), ct: b64(new Uint8Array(ct)), created: now.toISOString().slice(0, 10) }, null, 1) + '\n';
}

/** A File ready for the share sheet or a download. */
export async function makeBackupFile(secret, password, opts) {
  const text = await makeBackup(secret, password, opts);
  return new File([text], backupFileName(opts && opts.now), { type: 'application/json' });
}

/** The parsed header of a backup file's text, or BackupError('not_backup'). Pure, no password. */
export function readBackupHeader(text) {
  if (typeof text !== 'string' || text.length > BACKUP_MAX_BYTES) throw new BackupError(typeof text === 'string' ? 'too_big' : 'not_backup', 'This is not a Campfire backup file.');
  let f;
  try {
    f = JSON.parse(text);
  } catch {
    throw new BackupError('not_backup', 'This is not a Firo PWA backup file.');
  }
  if (!f || f.app !== BACKUP_APP || f.kind !== BACKUP_KIND || typeof f.salt !== 'string' || typeof f.iv !== 'string' || typeof f.ct !== 'string') throw new BackupError('not_backup', 'This is not a Campfire backup file.');
  if (f.v === BACKUP_V1) {
    if (f.kdf !== 'pbkdf2-sha256') throw new BackupError('not_backup', 'This is not a Firo PWA backup file.');
    if (!Number.isSafeInteger(f.iterations) || f.iterations < PBKDF2_MIN_ITERATIONS || f.iterations > MAX_ITERATIONS) throw new BackupError('weak', 'This file asks for an unsafe number of key rounds; it was not opened.');
  } else if (f.v === BACKUP_VERSION) {
    if (f.kdf !== 'scrypt') throw new BackupError('not_backup', 'This is not a Firo PWA backup file.');
    try {
      checkScrypt(f);
    } catch {
      throw new BackupError('weak', 'This file asks for an unsafe key cost; it was not opened.');
    }
  } else {
    throw new BackupError('not_backup', 'This backup was made by a newer Firo PWA. Update this app, then try again.');
  }
  return f;
}

/** {mnemonic, passphrase, birthday, name, network} from the file's text and its password. */
export async function openBackup(text, password) {
  const f = readBackupHeader(text);
  let pt;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(f.iv), additionalData: aad(f) }, await keyOf(password, f), unb64(f.ct));
  } catch {
    throw new BackupError('wrong_password', "That password doesn't open this backup. Check it and try again.");
  }
  const o = JSON.parse(dec.decode(pt));
  return { mnemonic: String(o.mnemonic || ''), passphrase: String(o.passphrase || ''), birthday: Number.isSafeInteger(o.birthday) ? o.birthday : null, name: String(o.name || ''), network: o.network === 'test' ? 'test' : 'main' };
}
