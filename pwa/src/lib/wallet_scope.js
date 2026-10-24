// Which wallet the app's own store (lib/store.js) is talking about, when there are several.
//
// Every wallet has a stable id (app.record.id, 16 hex characters). What belongs to one wallet
// lives under keys that carry it:
//   - New per-wallet data uses walletKey(app, name) = 'w:<id>:<name>' for every wallet. Deleting
//     the wallet removes every key under 'w:<id>:', whether or not the code that wrote it was
//     loaded in this page. This is the one rule for data added from now on (address book, hidden
//     tokens, ...): key it with walletKey(), and its delete is already done.
//   - Data kept under plain names by modules that predate several wallets ('eth', 'eth-outbox',
//     'buy'; WALLET_KEYS below) keeps those names for the wallet in the first slot and is
//     'w:<id>:<name>' for every other wallet. The code that
//     reads and writes them did not change: lib/store.js passes each such key through
//     mapWalletKey(), which names it for the selected wallet. While that wallet is locked such a key
//     can be read but not written, so nothing late from a wallet just left can land in the next one.
//   - walletStore(record) is a store bound to one wallet for good: code that keeps working after a
//     switch (a buy controller, NEAR Intents) writes through it, so a late write
//     still lands in its own wallet.
//   - Preferences: WALLET_PREF_KEYS are per wallet (in 'prefs' for slot0, as before; in
//     'w:<id>:prefs' for the others); every other preference is the app's (lib/wallets.js).
// onWalletRemoved(fn): for memory or storage outside this store. It runs only if the module that
// registered it was loaded in this page, so it is never the way to delete stored data.

import { setKeyMap, rawStore } from './store.js';
import { t } from './i18n.js';

export const WALLET_PREFIX = 'w:';
/** Per-wallet keys from before several wallets: plain names for slot0, 'w:<id>:<name>' otherwise. */
export const WALLET_KEYS = Object.freeze(['eth', 'eth-outbox', 'buy']);
export const WALLET_KEY_PREFIXES = Object.freeze([]);
/** Preferences that belong to one wallet: the backup reminder. */
export const WALLET_PREF_KEYS = Object.freeze(['backupPromptSnoozedUntil']);
/**
 * The app's own keys, the same whichever wallet is open: 'prefs' (server, auto-lock, Ethereum
 * server and history, prices, the Home Screen tip, the wallet last opened), 'wallet' (the first
 * slot's record) and the Uniswap pool search cursor (public chain data).
 */
export const APP_KEYS = Object.freeze(['prefs', 'wallet']);
export const APP_KEY_PREFIXES = Object.freeze(['uniswap-scan:']);
const ID = /^[0-9a-f]{16}$/;

export class WalletScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'none' | 'locked' | 'bad_id' | 'bad_name'
  }
}

export const isWalletId = (id) => typeof id === 'string' && ID.test(id);
export const prefixOf = (id) => {
  if (!isWalletId(id)) throw new WalletScopeError('bad_id', t('Not a wallet id.'));
  return `${WALLET_PREFIX}${id}:`;
};

/**
 * Whether a record is the first slot's. Every record this app writes says so (true or false); one
 * that does not is from a single-wallet version, which only ever had the first slot.
 */
export const inSlot0 = (record) => record.slot0 !== false;

/** True for a key named before several wallets that belongs to one wallet. */
export function isWalletKey(k) {
  return typeof k === 'string' && (WALLET_KEYS.includes(k) || WALLET_KEY_PREFIXES.some((p) => k.startsWith(p)));
}

/** Where `record`'s copy of such a key lives. */
export function keyFor(record, k) {
  return inSlot0(record) ? k : `${prefixOf(record.id)}${k}`;
}

/**
 * The key for per-wallet data added from now on: 'w:<id>:<name>' for the open (or selected)
 * wallet, app.record. Deleting the wallet removes it (and every other key under its prefix).
 */
export function walletKey(app, name) {
  const r = app && app.record;
  if (!r) throw new WalletScopeError('none', t('No wallet is open.'));
  if (typeof name !== 'string' || name.length === 0) throw new WalletScopeError('bad_name', t('A per-wallet key needs a name.'));
  return `${prefixOf(r.id)}${name}`;
}

// ---------------------------------------------------------------- the selected wallet
const scope = { record: null, open: false };

/** The wallet the screens are about (selected on the unlock screen, or open). app.js sets it with app.record. */
export function setScopeRecord(record) {
  scope.record = record || null;
}

/** Whether that wallet is unlocked. app.js sets it with app.dbPass. */
export function setScopeOpen(open) {
  scope.open = Boolean(open);
}

export function scopeState() {
  return { id: scope.record ? scope.record.id : null, slot0: Boolean(scope.record && inSlot0(scope.record)), open: scope.open };
}

/** What lib/store.js uses for a key: itself, or the selected wallet's name for it. */
export function mapWalletKey(k, write = false, s = scope) {
  if (!isWalletKey(k)) return k;
  if (!s.record) throw new WalletScopeError('none', t('No wallet is open.'));
  if (write && !s.open) throw new WalletScopeError('locked', t('Unlock the wallet first.'));
  return keyFor(s.record, k);
}

setKeyMap((k, write) => mapWalletKey(k, write));

/**
 * A store bound to one wallet: its per-wallet keys always name that wallet, whichever is selected
 * later. kv: lib/store.js rawStore, or a Map-backed one in the unit tests.
 */
export function walletStore(record, kv = rawStore) {
  if (!record || !isWalletId(record.id)) throw new WalletScopeError('none', t('No wallet is open.'));
  const bound = { id: record.id, slot0: inSlot0(record) };
  const map = (k) => (isWalletKey(k) ? keyFor(bound, k) : k);
  return {
    walletId: bound.id,
    get: (k) => kv.get(map(k)),
    set: (k, v) => kv.set(map(k), v),
    del: (k) => kv.del(map(k)),
    batch: (ops) => kv.batch(ops.map(([op, k, v]) => [op, map(k), v])),
  };
}

// ---------------------------------------------------------------- removal hooks
const removed = new Set();

/** fn(id) runs after wallet `id` is deleted from this device (memory, other storage). Returns an unsubscribe. */
export function onWalletRemoved(fn) {
  removed.add(fn);
  return () => removed.delete(fn);
}

export async function runRemovedHooks(id) {
  for (const fn of removed) {
    try {
      await fn(id);
    } catch (e) {
      console.warn('[campfire] wallet removal hook', e && e.message);
    }
  }
}
