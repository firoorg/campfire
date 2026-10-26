// Who may open the wallet, and how: creating it (new words, recovery words, or an encrypted
// backup file), the password and passkey envelopes, unlocking, re-confirming before a payment,
// and wiping it.
//
// Each wallet has a random 32-byte secret (app.dbPass while unlocked; dropped on lock). It is
// kept only inside the password and passkey envelopes (lib/envelope.js), and it is the key to the
// wallet's sealed recovery words (lib/seed_vault.js), which the engine needs at every unlock.

import { newDbPassword, sealWithPassword, openWithPassword, sealWithPrf, openWithPrf, toHex, randomBytes, unb64, EnvelopeError, passwordEnvelopeOutdated } from './envelope.js';
import { createPasskey, evaluatePrf } from './passkey.js';
import { sealSeed, openSeed } from './seed_vault.js';
import { refreshPersistence } from './storage.js';
import { listWallets, placeFor, saveRecord, nextName, cleanName, nameProblem, closeOpenWallet, loadPrefs, rememberOpened, removeWallet } from './wallets.js';
import { serversFor, isOwnServer } from './servers.js';
import { birthdayNow } from './heights.js';
import { passwordWeakness, MIN_PASSWORD } from './password_strength.js';
import { oneTab } from './one_tab.js';
import { t } from './i18n.js';

const setWalletRecord = (r) => saveRecord(r);

export { MIN_PASSWORD };
export const WORD_COUNTS = Object.freeze([12, 24]);
/**
 * A fingerprint of a wallet's words and passphrase, kept with its record (public audit, PN: the same
 * words added twice made two wallets, each with its own payment records, so neither knew what the
 * other had spent). Taken from the wallet's BIP39 seed (PBKDF2-HMAC-SHA512, 2,048 rounds), then
 * SHA-256 under its own label: with the words stolen, testing a passphrase against it costs what
 * deriving the wallet and looking it up on the chain costs anyway (audit K2: a plain SHA-256 of
 * words and passphrase, in the record kept unencrypted, was a far faster test).
 */
export async function wordsFingerprint(mnemonic, passphrase = '') {
  const norm = String(mnemonic ?? '').normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: enc.encode(`mnemonic${String(passphrase ?? '').normalize('NFKD')}`), iterations: 2048 }, key, 512));
  const label = enc.encode('campfire-firo-words-v2\n');
  const bytes = new Uint8Array(label.length + seed.length);
  bytes.set(label);
  bytes.set(seed, label.length);
  seed.fill(0);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 32);
}

/** The wallet on this device made from these words and passphrase, or null (wallets made before this are known once unlocked). */
export async function walletWithWords(words, passphrase = '') {
  const fp = await wordsFingerprint(Array.isArray(words) ? words.join(' ') : words, passphrase);
  return (await listWallets()).find((w) => w && w.wordsFp === fp) || null;
}

/** What a restore takes: any BIP39 length (another wallet may have made 15, 18 or 21 words: PN). */
export const RESTORE_WORD_COUNTS = Object.freeze([12, 15, 18, 21, 24]);

/**
 * null when `pw` may be the wallet's password (and matches `confirm`, when given), else what to
 * change, in words. Long enough and not one of a cracker's first guesses (lib/password_strength.js).
 */
export function passwordProblem(pw, confirm) {
  const weak = passwordWeakness(pw);
  if (weak) return weak.text;
  if (confirm !== undefined && pw !== confirm) return t("The two passwords don't match.");
  return null;
}

/** Where a new wallet goes and what it is called (lib/wallets.js). */
async function placeNewWallet(app) {
  const list = await listWallets();
  const { slot0 } = placeFor(list);
  const asked = app.setup && app.setup.name;
  const name = asked && !nameProblem(asked, list) ? cleanName(asked) : nextName(list);
  return { slot0, name };
}

/** Adding a wallet while another is open: that one closes first. */
async function closeCurrent(app) {
  if (app.dbPass || app.wallet.session) await closeOpenWallet(app);
}

/** The new wallet is the open one (and the one the app opens first: awaited, RE1-5). */
async function opened(app, record, dbPass) {
  app.record = record;
  app.dbPass = dbPass;
  app.prefs = await loadPrefs(record);
  await rememberOpened(app);
}

/**
 * Creates the wallet from app.setup and seals its words under a fresh random secret, itself
 * sealed under the person's password. app.setup: {mode: 'create' | 'restore' | 'file', words
 * (array of 12 or 24; restored: any BIP39 length), passphrase, birthday (block height or null), name?, adding?}. The words
 * leave app.setup here.
 */
export async function createWallet(app, password) {
  const setup = app.setup;
  if (setup && setup.mode === 'watch') return createWatchWallet(app, password);
  const counts = setup && setup.mode === 'create' ? WORD_COUNTS : RESTORE_WORD_COUNTS;
  if (!setup || !Array.isArray(setup.words) || !counts.includes(setup.words.length)) throw new Error(t('No recovery words to create the wallet from.'));
  const id = toHex(randomBytes(8));
  const dbPass = newDbPassword();
  const envelope = await sealWithPassword(dbPass, password, id);
  const words = setup.words.slice();
  const passphrase = String(setup.passphrase || '');
  try {
    const wordsFp = await wordsFingerprint(words.join(' '), passphrase);
    const twin = (await listWallets()).find((w) => w && w.wordsFp === wordsFp);
    if (twin) throw Object.assign(new Error(t('these words are already on this device as "{name}". Open that wallet instead.', { name: twin.name })), { code: 'same-words', walletId: twin.id });
    const seed = await sealSeed(dbPass, id, { mnemonic: words.join(' '), passphrase });
    await closeCurrent(app);
    const { slot0, name } = await placeNewWallet(app);
    const restored = setup.mode !== 'create';
    // A new wallet has no history before today: its birthday is about now (a day early). A restore
    // reads from the start unless the person gave a block or a date.
    const birthday = !restored ? birthdayNow() : Number.isSafeInteger(setup.birthday) && setup.birthday >= 0 ? setup.birthday : null;
    // Words written down and checked (create: the three-word check), or typed in (restore), are
    // with the person. From a backup file they never saw them: Home reminds them (wordsReminderDue).
    const wordsConfirmed = setup.mode !== 'file';
    const record = { id, name, createdAt: Date.now(), restored, words: words.length, passphrase: Boolean(passphrase), birthday, newWallet: !restored, wordsFp, seed, envelopes: { password: envelope, passkey: null }, setupDone: false, slot0, wordsConfirmed };
    // Saved and selected together: a hand-over to another tab waits for both (re-audit RE1-5).
    await oneTab().whileBusy(async () => {
      await saveRecord(record);
      setup.words.fill('');
      setup.words = null;
      setup.passphrase = '';
      await opened(app, record, dbPass);
    });
    await refreshPersistence(app, { request: true });
    return record;
  } finally {
    words.fill('');
  }
}

/**
 * A watch-only wallet from app.setup {mode: 'watch', viewKey (Spark full view key, hex), xpub?,
 * birthday?}: it sees payments and cannot spend. The key is sealed like words would be.
 */
async function createWatchWallet(app, password) {
  const setup = app.setup;
  const viewKey = String(setup.viewKey || '').trim().toLowerCase();
  const xpub = String(setup.xpub || '').trim();
  if (!viewKey && !xpub) throw new Error(t('No view key to create the watch-only wallet from.'));
  const id = toHex(randomBytes(8));
  const dbPass = newDbPassword();
  const envelope = await sealWithPassword(dbPass, password, id);
  const seed = await sealSeed(dbPass, id, { viewKey, xpub });
  await closeCurrent(app);
  const { slot0, name } = await placeNewWallet(app);
  const birthday = Number.isSafeInteger(setup.birthday) && setup.birthday >= 0 ? setup.birthday : null;
  const record = { id, name, createdAt: Date.now(), restored: true, watchOnly: true, words: 0, passphrase: false, birthday, newWallet: false, seed, envelopes: { password: envelope, passkey: null }, setupDone: false, slot0 };
  // Saved and selected together: a hand-over to another tab waits for both (re-audit RE1-5).
  await oneTab().whileBusy(async () => {
    await saveRecord(record);
    setup.viewKey = '';
    setup.xpub = '';
    await opened(app, record, dbPass);
  });
  await refreshPersistence(app, { request: true });
  return record;
}

/** Adding another wallet (Add a wallet: lib/wallets.js, screens/add_wallet.js) rather than the first one. */
export function isAdding(app) {
  return Boolean(app && app.setup && app.setup.adding);
}

/** The open wallet's recovery words and passphrase (only while it is unlocked). */
export async function openSeedFor(app) {
  if (!app.dbPass || !app.record) {
    const e = new Error(t('Unlock the wallet first.'));
    e.code = 'locked';
    throw e;
  }
  return openSeed(app.dbPass, app.record.id, app.record.seed);
}

/**
 * Starts the engine on the open wallet: the words come out of the seed vault, go to the engine,
 * and are dropped here. A wallet made on this device has no history before it was made.
 */
export async function startOpenWallet(app) {
  const w = app.wallet;
  if (w.session && w.run && w.run.walletId === app.record.id) return;
  if (w.session) await w.stop();
  let seed = await openSeedFor(app);
  // A wallet made before fingerprints: its own, from its words now that they are open (PN).
  if (!app.record.watchOnly && !app.record.wordsFp && seed.mnemonic) {
    try {
      app.record = { ...app.record, wordsFp: await wordsFingerprint(seed.mnemonic, seed.passphrase) };
      await setWalletRecord(app.record);
    } catch {
      // Next unlock.
    }
  }
  try {
    await w.start({
      walletId: app.record.id,
      ...(app.record.watchOnly ? { viewOnly: { sparkFullViewKey: seed.viewKey || undefined, xpub: seed.xpub || undefined } } : {}),
      mnemonic: seed.mnemonic,
      passphrase: seed.passphrase,
      birthdayHeight: app.record.birthday,
      newWallet: Boolean(app.record.newWallet),
      servers: serversFor(app.prefs),
      ownNode: isOwnServer(app.prefs && app.prefs.server),
      sparkTxDetails: app.prefs && app.prefs.exactSparkDates === true ? 'decoy' : 'none',
      // The engine's data is sealed under this wallet's secret (audit A-1).
      seal: { dbPass: app.dbPass, imported: Boolean(app.record.imported) },
    });
  } finally {
    seed = null;
  }
}

/**
 * Once a new wallet is in step with the network for the first time, its birthday becomes the
 * block it was in step at when that is earlier than the estimate it was made with (the clock was
 * ahead): a later rescan or restore of the backup file never starts after a payment.
 */
export async function noteFirstSync(app, tipHeight) {
  const r = app.record;
  if (!r || !r.newWallet || !Number.isSafeInteger(tipHeight) || tipHeight <= 0) return;
  const real = Math.max(0, tipHeight - 12);
  if (r.birthday != null && r.birthday <= real) return;
  app.record = { ...r, birthday: real };
  await setWalletRecord(app.record);
}

/** "Later" on Home's reminder: a week (a per-wallet preference, lib/wallet_scope.js). */
export const WORDS_REMINDER_SNOOZE_MS = 7 * 24 * 3600 * 1000;

/**
 * Whether Home asks the person to write the recovery words down: the wallet came from a backup
 * file (its words were never shown here), they have not said they wrote them down, and "Later" is
 * not running. The file and its password are one copy, easily lost with this device; the browser
 * can also clear its storage (persist() is asked for, not promised).
 */
export function wordsReminderDue(record, prefs, now = Date.now()) {
  if (!record || record.watchOnly || record.wordsConfirmed !== false) return false;
  const until = Number(prefs && prefs.backupPromptSnoozedUntil);
  return !(Number.isFinite(until) && until > now);
}

/** The person wrote the words down (Settings -> Backup -> Show my recovery words -> "I wrote them down"). */
export async function markWordsConfirmed(app) {
  if (!app.record || app.record.wordsConfirmed !== false) return;
  app.record = { ...app.record, wordsConfirmed: true };
  await setWalletRecord(app.record);
}

/** After an encrypted backup reached the share sheet or downloads. */
export async function markExported(app) {
  app.record = { ...app.record, exportedAt: Date.now() };
  await setWalletRecord(app.record);
}

export async function addPasskey(app) {
  if (!app.dbPass) throw new Error(t('Unlock the wallet first.'));
  const { credId, prfSalt, prf } = await createPasskey(app.record.id, app.record.name);
  const env = await sealWithPrf(app.dbPass, prf, app.record.id, credId, prfSalt);
  prf.fill(0);
  app.record = { ...app.record, envelopes: { ...app.record.envelopes, passkey: env } };
  await setWalletRecord(app.record);
}

export async function removePasskey(app) {
  app.record = { ...app.record, envelopes: { ...app.record.envelopes, passkey: null } };
  await setWalletRecord(app.record);
}

export function hasPasskey(app) {
  return Boolean(app.record && app.record.envelopes && app.record.envelopes.passkey);
}

/**
 * @returns the wallet's secret, or throws EnvelopeError('wrong_secret'). An envelope of the old kind
 * (PBKDF2) is sealed again under scrypt now that the password is here (public audit, P9); if that
 * cannot be saved it stays as it was, still opens, and is sealed again the next time.
 */
export async function openWithPasswordFor(app, password) {
  const env = app.record.envelopes.password;
  const secret = await openWithPassword(env, password);
  if (passwordEnvelopeOutdated(env)) {
    try {
      const next = await sealWithPassword(secret, password, app.record.id);
      if (app.record.envelopes.password === env) {
        app.record = { ...app.record, envelopes: { ...app.record.envelopes, password: next } };
        await setWalletRecord(app.record);
      }
    } catch {
      // Kept as it was: it still opens.
    }
  }
  return secret;
}

export async function openWithPasskeyFor(app) {
  const env = app.record.envelopes.passkey;
  const prf = await evaluatePrf(env.credId, unb64(env.prfSalt), { walletId: app.record.id, walletName: app.record.name });
  try {
    return await openWithPrf(env, prf);
  } finally {
    prf.fill(0);
  }
}

export async function changePassword(app, current, next) {
  await openWithPassword(app.record.envelopes.password, current); // throws if wrong
  if (!app.dbPass) throw new Error(t('Unlock the wallet first.'));
  const env = await sealWithPassword(app.dbPass, next, app.record.id);
  app.record = { ...app.record, envelopes: { ...app.record.envelopes, password: env } };
  await setWalletRecord(app.record);
}

export async function markSetupDone(app) {
  app.record = { ...app.record, setupDone: true };
  await setWalletRecord(app.record);
}

/**
 * Removes the selected wallet from this device: its engine database, record, envelopes, sealed
 * words and everything that is its (lib/wallets.js removeWallet); the other wallets stay.
 */
export async function wipeWallet(app, target = app.record) {
  return removeWallet(app, target);
}

export { EnvelopeError };
