// The key-value store the Firo engine keeps its cache in, as WALLET_API
// describes it: { get(key), put(key, value), del(key), keys(prefix) }, all
// async. Values are anything structured clone takes (objects, BigInt,
// Uint8Array). Two implementations:
//   createMemoryStore()       for tests and throwaway sessions
//   createIdbStore(name)      IndexedDB, one object store, string keys
// plus prefixStore(store, prefix) to give one wallet (or the shared Spark
// cache) its own corner of a store.

/** An in-memory store. Values are kept as given (not copied). */
import { t } from '../i18n.js';

export function createMemoryStore() {
  const m = new Map();
  return {
    async get(key) {
      return m.has(key) ? m.get(key) : undefined;
    },
    async put(key, value) {
      m.set(String(key), value);
    },
    async del(key) {
      m.delete(key);
    },
    /** Keys starting with `prefix`, sorted. */
    async keys(prefix = '') {
      return [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    /** For tests and the probe: rough bytes held. */
    sizeBytes() {
      let n = 0;
      for (const [k, v] of m) n += k.length + approxSize(v);
      return n;
    },
    _map: m,
  };
}

function approxSize(v) {
  if (v instanceof Uint8Array) return v.length;
  if (typeof v === 'string') return v.length;
  if (typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean') return 8;
  if (Array.isArray(v)) return v.reduce((s, x) => s + approxSize(x), 0);
  if (v && typeof v === 'object') return Object.entries(v).reduce((s, [k, x]) => s + k.length + approxSize(x), 0);
  return 0;
}

/**
 * An IndexedDB-backed store: database `dbName`, object store `kv`. Works with
 * any IndexedDB factory (`indexedDB` in browsers, fake-indexeddb in tests).
 */
export function createIdbStore(dbName, { indexedDB: idb = globalThis.indexedDB, storeName = 'kv' } = {}) {
  if (!idb) throw new Error(t('IndexedDB is not available.'));
  let dbp = null;
  const db = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = idb.open(dbName, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(storeName);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error(t('Storage is busy in another tab. Close the other tabs and reload.')));
    });
    return dbp;
  };
  const run = (mode, fn) =>
    db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const item = d.transaction(storeName, mode);
          let out;
          const r = fn(item.objectStore(storeName));
          if (r) r.onsuccess = () => (out = r.result);
          item.oncomplete = () => resolve(out);
          item.onerror = () => reject(item.error);
          item.onabort = () => reject(item.error || new Error(t('Storage write was aborted (is the disk full?).')));
        }),
    );
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    put: (key, value) => run('readwrite', (s) => s.put(value, String(key))).then(() => undefined),
    del: (key) => run('readwrite', (s) => s.delete(key)).then(() => undefined),
    keys: (prefix = '') =>
      run('readonly', (s) => s.getAllKeys(prefix ? IDBKeyRangeFor(idb, prefix) : undefined)).then((ks) => (ks ?? []).map(String).sort()),
    async close() {
      if (dbp) (await dbp).close();
      dbp = null;
    },
  };
}

function IDBKeyRangeFor(idb, prefix) {
  const KR = globalThis.IDBKeyRange ?? idb.IDBKeyRange;
  if (!KR) return undefined;
  return KR.bound(prefix, prefix + '￿', false, false);
}

/** A view of `store` where every key is `prefix` + key. keys() returns keys without the prefix. */
export function prefixStore(store, prefix) {
  return {
    get: (k) => store.get(prefix + k),
    put: (k, v) => store.put(prefix + k, v),
    del: (k) => store.del(prefix + k),
    keys: async (p = '') => (await store.keys(prefix + p)).map((k) => k.slice(prefix.length)),
  };
}

/** Deletes every key under `prefix`. */
export async function clearPrefix(store, prefix) {
  for (const k of await store.keys(prefix)) await store.del(k);
}
