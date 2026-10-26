// Several Firo wallets on one device. One runs at a time (one engine, lib/wallet.js); the others
// sit locked, each with its own record (sealed recovery words, password envelope, passkey),
// engine database (lib/wallet_store.js), settings and data.
//
// Where each wallet lives:
//   first slot (slot0)  record 'wallet', per-wallet data under plain names ('eth', 'buy', ...;
//                       lib/wallet_scope.js WALLET_KEYS), its per-wallet preferences inside 'prefs'.
//   any other wallet    record 'w:<id>:wallet', data 'w:<id>:<name>', preferences 'w:<id>:prefs'.
//   every wallet        whatever newer code keeps under walletKey() (lib/wallet_scope.js), and
//                       its engine database "campfire-firo-w-<id>" (deleted with it).
// No balance is kept for a locked wallet: the switcher says it is locked (audit A-1; earlier
// versions kept 'w:<id>:balance' in the clear, removed at start by forgetStoredBalances).
// A new wallet takes the first slot when it is free, otherwise a place of its own.

import { rawStore, getPrefs, setPrefs, DEFAULT_PREFS } from './store.js';
import { deleteWalletStore } from './wallet_store.js';
import { SPARK_CACHE_DB } from './chain.js';
import { setTheme } from './theme.js';
import { WALLET_PREFIX, WALLET_KEYS, WALLET_KEY_PREFIXES, WALLET_PREF_KEYS, prefixOf, isWalletId, inSlot0, setScopeRecord, runRemovedHooks } from './wallet_scope.js';
import { oneTab, OtherTabError } from './one_tab.js';
import { t, tk, tn } from './i18n.js';

export { walletKey, walletStore, onWalletRemoved, WALLET_PREF_KEYS } from './wallet_scope.js';

export const SLOT0_RECORD_KEY = 'wallet';
export const FIRST_NAME = tk('Wallet 1');
export const MAX_NAME = 32;

export class WalletsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'name' | 'slot_taken' | 'missing' | 'open'
  }
}

export { inSlot0 };
export const recordKey = (record) => (inSlot0(record) ? SLOT0_RECORD_KEY : `${prefixOf(record.id)}wallet`);
export const walletPrefsKey = (record) => (inSlot0(record) ? 'prefs' : `${prefixOf(record.id)}prefs`);
export const balanceKey = (id) => `${prefixOf(id)}balance`;

function validRecord(r) {
  return Boolean(r) && typeof r === 'object' && isWalletId(r.id) && Boolean(r.envelopes && r.envelopes.password);
}

/** The name people see: the record's own, or "Wallet 1" for a first wallet without one. */
export function nameOf(record) {
  if (!record) return '';
  if (typeof record.name === 'string' && record.name.trim()) return record.name.trim();
  return inSlot0(record) ? t(FIRST_NAME) : t('Wallet');
}

/** Spaces tidied; at most MAX_NAME characters. */
export function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
}

const sameName = (a, b) => cleanName(a).toLocaleLowerCase() === cleanName(b).toLocaleLowerCase();

/** null when `name` can be used for a wallet (other than exceptId), else what to change, in words. */
export function nameProblem(name, list, exceptId = null) {
  const n = cleanName(name);
  if (!n) return t('Give the wallet a name.');
  if ([...n].length > MAX_NAME) return tn({ one: 'Use {n} character or fewer.', other: 'Use {n} characters or fewer.' }, MAX_NAME);
  if (list.some((r) => r.id !== exceptId && sameName(nameOf(r), n))) return t('You already have a wallet named "{n}". Choose another name.', { n });
  return null;
}

/** "Wallet 2", "Wallet 3"...: the first free one after the wallets there are. */
export function nextName(list) {
  let n = list.length + 1;
  while (list.some((r) => sameName(nameOf(r), t('Wallet {n}', { n })))) n++;
  return t('Wallet {n}', { n });
}

/** As the desktop app lists them: by name (numbers in order), then oldest first. */
export function sortWallets(list) {
  return [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }) || (a.createdAt || 0) - (b.createdAt || 0));
}

/** Every wallet on this device, sorted; each record says where it lives (slot0). */
export async function listWallets(kv = rawStore) {
  const out = [];
  const first = await kv.get(SLOT0_RECORD_KEY);
  if (validRecord(first)) out.push({ ...first, slot0: true });
  for (const k of await kv.keys(WALLET_PREFIX)) {
    const m = /^w:([0-9a-f]{16}):wallet$/.exec(k);
    if (!m || out.some((r) => r.id === m[1])) continue;
    const r = await kv.get(k);
    if (validRecord(r) && r.id === m[1]) out.push({ ...r, slot0: false });
  }
  return sortWallets(out);
}

/** Where a new wallet goes: the first slot when it is free. */
export function placeFor(list) {
  return { slot0: !list.some((r) => inSlot0(r)) };
}

/**
 * Writes a wallet's record where it lives. Refuses to write over another wallet's record (the
 * first slot holds one record only), so no wallet's envelopes can be replaced by another's.
 */
export async function saveRecord(record, kv = rawStore) {
  if (!validRecord(record)) throw new WalletsError('missing', t('Not a wallet record.'));
  const value = { ...record, slot0: inSlot0(record) };
  await kv.update(recordKey(record), (prev) => {
    if (prev && prev.id !== record.id) throw new WalletsError('slot_taken', t('Another wallet is kept there; nothing was written.'));
    return value;
  });
  return value;
}

/** The wallet to show first: the one last opened, else the first slot's, else any. */
export function initialWallet(list, prefs) {
  const last = prefs && prefs.lastWalletId;
  return list.find((r) => r.id === last) || list.find((r) => inSlot0(r)) || list[0] || null;
}

// ---------------------------------------------------------------- preferences
/**
 * The app's preferences with `record`'s own (WALLET_PREF_KEYS) on top. The first slot's own are
 * in 'prefs' itself, as a single-wallet version kept them.
 */
export async function loadPrefs(record, kv = rawStore) {
  const p = await getPrefs(kv);
  if (!record || inSlot0(record)) return p;
  const own = (await kv.get(walletPrefsKey(record))) || {};
  for (const k of WALLET_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(own, k)) p[k] = own[k];
    else if (Object.prototype.hasOwnProperty.call(DEFAULT_PREFS, k)) p[k] = DEFAULT_PREFS[k];
    else delete p[k];
  }
  return p;
}

/** Saves a change: the wallet's own preferences to the wallet, the rest to the app. Returns loadPrefs(record). */
export async function savePrefs(record, patch, kv = rawStore) {
  if (!record || inSlot0(record)) {
    await setPrefs(patch, kv);
    return loadPrefs(record, kv);
  }
  const mine = {};
  const app = {};
  for (const [k, v] of Object.entries(patch || {})) (WALLET_PREF_KEYS.includes(k) ? mine : app)[k] = v;
  if (Object.keys(app).length) await setPrefs(app, kv);
  if (Object.keys(mine).length) await kv.update(walletPrefsKey(record), (prev) => ({ ...(prev && typeof prev === 'object' ? prev : {}), ...mine }));
  return loadPrefs(record, kv);
}

// ---------------------------------------------------------------- no stored balance
/**
 * Removes the balances earlier versions kept for the switcher ('w:<id>:balance', in the clear: it
 * told anyone with a copy of this browser's data what each wallet holds). Run at start; returns
 * how many went.
 */
export async function forgetStoredBalances(kv = rawStore) {
  const stale = (await kv.keys(WALLET_PREFIX)).filter((k) => /^w:[0-9a-f]{16}:balance$/.test(k));
  if (stale.length) await kv.batch(stale.map((k) => ['del', k]));
  return stale.length;
}

// ---------------------------------------------------------------- open, switch, remove
/** Points the store's per-wallet keys at `record` (app.js, with app.record). */
export function scopeTo(record) {
  setScopeRecord(record);
}

/** Makes `record` the selected wallet while nothing is open (the unlock screen's picker, after a switch or a delete). */
export async function selectWallet(app, record, kv = rawStore) {
  if (app.dbPass) throw new WalletsError('open', t('Lock the open wallet first.'));
  app.record = record || null;
  app.afterUnlock = null;
  app.prefs = await loadPrefs(app.record, kv);
}

/** After an unlock: this wallet comes up first next time. */
export function rememberOpened(app) {
  if (!app.record) return Promise.resolve();
  return app.setPrefs({ lastWalletId: app.record.id }).catch(() => {});
}

/**
 * Closes the open wallet before another is made or restored: what the lock does (its secrets
 * forgotten, every lock hook run) and the engine stopped.
 */
export async function closeOpenWallet(app) {
  app.dbPass = null;
  app.afterUnlock = null;
  app.nav.clear();
  app.runLockHooks();
  await app.wallet.stop();
}

/** Which wallet the engine runs now, or null. */
export function runningWallet(app, list) {
  const run = app.wallet.run;
  return (run && list.find((r) => r.id === run.walletId)) || null;
}

/** Locks the open wallet as the lock button does and shows the unlock screen for `target`. */
export async function switchWallet(app, target) {
  const from = app.record;
  if (from && from.id === target.id) return;
  await app.lock('switch', { beforeUnlock: () => selectWallet(app, target), params: { from: from ? nameOf(from) : null } });
}

/** The keys that go with `target`, as one batch: its prefix, and for the first slot its plain names and preferences. */
export async function removalOps(target, kv = rawStore) {
  const ops = (await kv.keys(prefixOf(target.id))).map((k) => ['del', k]);
  const prefs = await kv.get('prefs');
  const nextPrefs = prefs && typeof prefs === 'object' ? { ...prefs } : null;
  if (inSlot0(target)) {
    ops.push(['del', SLOT0_RECORD_KEY]);
    for (const k of WALLET_KEYS) ops.push(['del', k]);
    for (const p of WALLET_KEY_PREFIXES) for (const k of await kv.keys(p)) ops.push(['del', k]);
    if (nextPrefs) for (const k of WALLET_PREF_KEYS) delete nextPrefs[k];
  }
  if (nextPrefs && nextPrefs.lastWalletId === target.id) delete nextPrefs.lastWalletId;
  if (nextPrefs) ops.push(['set', 'prefs', nextPrefs]);
  return ops;
}

// ---------------------------------------------------------------- what a delete also clears
/** The shared Spark cache (public chain data, but it shows a Firo wallet ran here and how far it read). */
async function deleteSparkCache() {
  if (!(await oneTab().confirmWrite())) throw new OtherTabError();
  return new Promise((resolve) => {
    try {
      const r = indexedDB.deleteDatabase(SPARK_CACHE_DB);
      r.onsuccess = r.onerror = () => resolve();
      // Still open in this page: it goes once the page closes.
      r.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Tells the password manager that keeps the wallet's passkey (iCloud Keychain, Google Password
 * Manager) that it is gone, so it can remove it (WebAuthn Signal API; Chrome 132+, Safari 26+).
 * A site cannot delete a passkey itself: where this is missing, the delete screen says where to.
 */
async function signalPasskeyGone(credId) {
  const PKC = globalThis.PublicKeyCredential;
  if (!PKC || typeof PKC.signalUnknownCredential !== 'function' || !globalThis.location) return;
  await PKC.signalUnknownCredential({ rpId: globalThis.location.hostname, credentialId: credId });
}

/** Notifications already on the screen or in the notification list may name the wallet or a payment. */
async function closeShownNotifications() {
  const sw = globalThis.navigator && globalThis.navigator.serviceWorker;
  const reg = sw ? await sw.getRegistration() : null;
  if (reg && typeof reg.getNotifications === 'function') for (const n of await reg.getNotifications()) n.close();
  if (typeof globalThis.navigator.clearAppBadge === 'function') await globalThis.navigator.clearAppBadge();
}

/** Campfire's own keys in this browser's localStorage (the theme, the update check and an added update address). */
function clearAppLocalStorage(storage) {
  if (!storage) return;
  const mine = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (typeof k === 'string' && k.startsWith('campfire-')) mine.push(k);
  }
  for (const k of mine) storage.removeItem(k);
  if (mine.includes('campfire-theme')) setTheme('system', { storage });
}

const quietly = async (fn) => {
  try {
    await fn();
  } catch (e) {
    console.warn('[campfire] after the delete:', e && e.message);
  }
};

/**
 * Deletes one wallet from this device: its engine database (and only its), its record with the
 * sealed words and envelopes, and every key that is its. The others are not touched. Its passkey
 * is reported gone to the password manager that keeps it, and notifications still shown are
 * closed. The last wallet takes the app's settings with it, the shared Spark cache and
 * Campfire's localStorage too. When it was the selected wallet, another one is selected (locked).
 * @returns {Promise<{others: object[]}>}
 */
export async function removeWallet(app, target, { kv = rawStore, deleteDb = deleteWalletStore, deleteSharedCache = deleteSparkCache, storage = globalThis.localStorage, signalPasskeyGone: signal = signalPasskeyGone, closeNotifications = closeShownNotifications } = {}) {
  const list = await listWallets(kv);
  if (!list.some((r) => r.id === target.id)) throw new WalletsError('missing', t('That wallet is not on this device any more.'));
  const others = list.filter((r) => r.id !== target.id);
  const selected = Boolean(app.record && app.record.id === target.id);
  const running = Boolean(app.wallet.run && app.wallet.run.walletId === target.id);
  if (selected) {
    app.dbPass = null;
    app.setup = null;
    app.afterUnlock = null;
    app.nav.clear();
    app.runLockHooks();
  }
  if (selected || running) await app.wallet.stop();
  const gone = list.find((r) => r.id === target.id);
  const passkey = gone && gone.envelopes && gone.envelopes.passkey;
  // The engine database and the record with its keys: a hand-over to another tab waits for both
  // (release re-audit RE1-6: split, the other tab listed a wallet whose database was gone).
  await oneTab().whileBusy(async () => {
    await deleteDb(target.id);
    if (others.length) await kv.batch(await removalOps(target, kv));
    else await kv.clear();
  });
  await runRemovedHooks(target.id);
  if (passkey && typeof passkey.credId === 'string') await quietly(() => signal(passkey.credId));
  await quietly(closeNotifications);
  if (!others.length) {
    await quietly(deleteSharedCache);
    await quietly(() => clearAppLocalStorage(storage));
  }
  if (selected) {
    const prefs = await getPrefs(kv);
    await selectWallet(app, initialWallet(others, prefs), kv);
  }
  return { others };
}

/** Renames a wallet (open or not). */
export async function renameWallet(app, target, name, kv = rawStore) {
  const list = await listWallets(kv);
  const problem = nameProblem(name, list, target.id);
  if (problem) throw new WalletsError('name', problem);
  const clean = cleanName(name);
  if (app.record && app.record.id === target.id) {
    app.record = { ...app.record, name: clean };
    await saveRecord(app.record, kv);
    return app.record;
  }
  const r = list.find((x) => x.id === target.id);
  if (!r) throw new WalletsError('missing', t('That wallet is not on this device any more.'));
  return saveRecord({ ...r, name: clean }, kv);
}
