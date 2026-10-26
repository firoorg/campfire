// The engine's own storage for ONE wallet: an IndexedDB database of its own,
// "campfire-firo-w-<wallet id>", handed to the backend as its store (WALLET_API.md:
// {get, put, del, keys(prefix)}, all async). The engine keeps its caches there (Spark coin
// sets, spent tags, transaction history), which can be large, so they stay out of the app's
// small key-value store (lib/store.js) and go with the wallet: removeWallet() deletes the whole
// database. Nothing secret is written here by the app; what the engine writes is its business.

import { oneTab, OtherTabError } from './one_tab.js';
import { t } from './i18n.js';

export const WALLET_DB_PREFIX = 'campfire-firo-w-';
const STORE = 'kv';
const ID = /^[0-9a-f]{16}$/;

export const walletDbName = (id) => {
  if (!ID.test(String(id))) throw new Error(t('Not a wallet id.'));
  return `${WALLET_DB_PREFIX}${id}`;
};

function openDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error(t('Storage is busy in another tab. Close other Firo PWA tabs and reload.')));
  });
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** The store for wallet `id` (opened on first use; close() lets it go). */
export function openWalletStore(id) {
  const name = walletDbName(id);
  let dbp = null;
  const db = () => (dbp = dbp || openDb(name));
  // One tab at a time (lib/one_tab.js): only the tab holding the wallet writes its engine's data. A
  // tab that let it go, or lost it while frozen, would write back cursors, coins and payments older
  // than the other tab's.
  const writable = (mode) =>
    mode !== 'readwrite'
      ? Promise.resolve()
      : oneTab()
          .confirmWrite()
          .then((ok) => {
            if (!ok) throw new OtherTabError();
          });
  const run = (mode, fn) =>
    writable(mode).then(db).then(
      (d) =>
        new Promise((resolve, reject) => {
          const item = d.transaction(STORE, mode);
          let out;
          Promise.resolve(fn(item.objectStore(STORE))).then((v) => (out = v), reject);
          item.oncomplete = () => resolve(out);
          item.onerror = () => reject(item.error);
          item.onabort = () => reject(item.error || new Error(t('storage aborted')));
        }),
    );
  return {
    name,
    get: (k) => run('readonly', (s) => req(s.get(k))),
    put: (k, v) => run('readwrite', (s) => req(s.put(v, k))).then(() => undefined),
    del: (k) => run('readwrite', (s) => req(s.delete(k))).then(() => undefined),
    keys: (prefix = '') => run('readonly', (s) => req(s.getAllKeys(prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined))).then((ks) => ks.map(String)),
    close: async () => {
      if (!dbp) return;
      const d = await dbp.catch(() => null);
      dbp = null;
      if (d) d.close();
    },
  };
}

/** Deletes wallet `id`'s engine database. Resolves when it is gone (or never existed). */
export async function deleteWalletStore(id) {
  const name = walletDbName(id);
  if (!(await oneTab().confirmWrite())) throw new OtherTabError();
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    // Another tab still has it open: it goes once that tab lets go; this one is done.
    r.onblocked = () => resolve();
  });
}
