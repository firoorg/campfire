// The seam between the screens and the Firo engine: the ONE module that picks the backend.
//
// Screens and lib/wallet.js never import a backend directly; they ask this module, so the
// switch from the stand-in to the real engine is one line here (ENGINE below), nothing else.
//
//   'real'  lib/firo/backend.js (the core stream: ElectrumX over wss, Spark through the injected
//           client of lib/firo/spark/, Firo's sparkmobile in WebAssembly workers).
//   'fake'  lib/backend_fake.js: deterministic, in memory, no network. Implements the whole
//           contract (WALLET_API.md) so every screen and the e2e suites run without a server.
//
// With ENGINE = 'real', a page on a test host (localhost, 127.0.0.1 or a reserved *.test name)
// whose server answers /__dev/flags with fakeBackend: true (tools/serve.mjs --fake-backend, the
// e2e hosts) gets the stand-in, so the browser suites run without the network. A production host
// is never one of those names: the real engine always.
//
// Amounts cross this seam as satoshi strings (8 decimals), heights as numbers, times as unix
// seconds. lib/wallet.js turns them into BigInt for the screens.
import { oneTab, OtherTabError } from './one_tab.js';

export const ENGINE = 'real'; // 'fake': the stand-in everywhere

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** localhost and RFC 2606's reserved .test names: never a public deployment. */
export const isTestHost = (host) => DEV_HOSTS.has(host) || /\.test$/.test(String(host || ''));

/** True on a test host whose server asks for the stand-in (never on a real host). */
async function devWantsFake() {
  const loc = globalThis.location;
  if (!loc || !isTestHost(loc.hostname)) return false;
  try {
    const r = await fetch('__dev/flags', { cache: 'no-store' });
    if (!r.ok) return false;
    const flags = await r.json();
    return Boolean(flags && flags.fakeBackend === true);
  } catch {
    return false;
  }
}

let picked = null;

/** Which backend this page uses: 'fake' or 'real' (decided once per page). */
export function backendKind() {
  if (!picked) picked = ENGINE === 'real' ? devWantsFake().then((fake) => (fake ? 'fake' : 'real')) : Promise.resolve('fake');
  return picked;
}

/** Tests only: pin the engine for this page or process ('fake' | 'real'). */
export function useEngine(kind) {
  picked = Promise.resolve(kind === 'real' ? 'real' : 'fake');
}

let sparkClient = null;
let sharedCache = null;

/**
 * The Spark client (Firo's sparkmobile in WebAssembly workers), one per page, adapted to the
 * engine's interface; null where it cannot start (the engine then turns Spark off and says so).
 */
async function spark() {
  if (sparkClient) return sparkClient;
  try {
    const [{ createSparkClient }, { adaptSparkClient }] = await Promise.all([import('./firo/spark/client.js'), import('./firo/spark_adapter.js')]);
    sparkClient = adaptSparkClient(createSparkClient());
  } catch (e) {
    console.warn('[campfire] Spark is not available here:', e && e.message);
    sparkClient = null;
  }
  return sparkClient;
}

/** Spark's public data (coin sets, spent tags) is the same for every wallet: one cache for all. */
async function sparkCache() {
  if (sharedCache) return sharedCache;
  const { createIdbStore } = await import('./firo/store.js');
  return (sharedCache = tabGuarded(createIdbStore(SPARK_CACHE_DB)));
}

/**
 * One tab at a time (lib/one_tab.js): the cache's writes go ahead only in the tab holding the wallet
 * (a tab that let go, or lost the lock while frozen, would write back a set it read before).
 */
export function tabGuarded(store, tab = oneTab()) {
  const check = () =>
    tab.confirmWrite().then((ok) => {
      if (!ok) throw new OtherTabError();
    });
  return {
    ...store,
    get: (k) => store.get(k),
    keys: (p) => store.keys(p),
    put: (k, v) => check().then(() => store.put(k, v)),
    del: (k) => check().then(() => store.del(k)),
    close: () => (typeof store.close === 'function' ? store.close() : undefined),
  };
}
export const SPARK_CACHE_DB = 'campfire-firo-spark-cache';

/** Lets the shared Spark cache's database go (this tab hands the wallet to another one). */
export async function closeSparkCache() {
  const c = sharedCache;
  sharedCache = null;
  if (c && typeof c.close === 'function') await c.close();
}

/**
 * A backend (WALLET_API.md createBackend): {network, servers, store, sparkTxDetails}. The real
 * engine gets the Spark client and the shared Spark cache here; the stand-in needs neither.
 */
export async function createBackend(opts = {}) {
  if ((await backendKind()) === 'real') {
    const mod = await import('./firo/backend.js');
    const indexed = typeof indexedDB !== 'undefined';
    return mod.createBackend({ ...opts, spark: opts.spark === undefined ? await spark() : opts.spark, ...(indexed && !opts.sharedStore ? { sharedStore: await sparkCache() } : {}) });
  }
  return (await import('./backend_fake.js')).createBackend(opts);
}

/** Key helpers that need no wallet and no network (Backend.generateMnemonic / validateMnemonic). */
export async function keys() {
  const b = await createBackend({ network: 'main', store: memoryStore(), spark: null, sharedStore: memoryStore() });
  return {
    generateMnemonic: (words = 24) => b.generateMnemonic(words),
    validateMnemonic: (text) => b.validateMnemonic(text),
  };
}

/** The contract's store shape over a Map: {get, put, del, keys(prefix)}, all async. */
export function memoryStore(map = new Map()) {
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    put: async (k, v) => void map.set(k, structuredClone(v)),
    del: async (k) => void map.delete(k),
    keys: async (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

/** Errors the contract names (WALLET_API.md "Errors"): their .message may be shown as it is. */
export const ERROR_CODES = Object.freeze(['offline', 'insufficient', 'invalid-address', 'dust', 'not-synced', 'server', 'NotYet']);

/** A NotYet error is a feature of a later milestone: the screens say "not in this version yet". */
export const isNotYet = (e) => Boolean(e) && e.code === 'NotYet';
