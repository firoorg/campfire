// The loader (src/sw.js, assembled exactly as tools/build.mjs assembles it) running in Node, with
// a stand-in for what a browser gives a service worker: its registration and address, an
// in-memory Cache Storage, and a fetch the test answers. Returns the loader's own functions, so a
// test runs the real code rather than a copy of it.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loaderSource } from '../../../tools/loader_source.mjs';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src');

const keyOf = (k) => (typeof k === 'string' ? k : k.url);

/** Cache Storage in memory (what sw.js uses of it). */
export function memoryCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (k) => (m.has(keyOf(k)) ? m.get(keyOf(k)).clone() : undefined),
      put: async (k, resp) => void m.set(keyOf(k), new Response(await resp.arrayBuffer(), { status: resp.status, headers: resp.headers })),
      delete: async (k) => m.delete(keyOf(k)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  return { open, keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), has: async (n) => stores.has(n), stores };
}

/**
 * pub: the public JWK built into this loader. scope: the app's folder. fetch(url, init): the
 * network, as the test wants it. Returns the loader's functions plus { self, caches, handlers }.
 */
export async function loadLoader({ pub, scope = 'https://wallet.example/', name = 'sw-0000000000000000.js', fetch: net }) {
  const { source, loaderCompat } = await loaderSource({ srcDir, pub });
  const handlers = {};
  const self = {
    registration: { scope, showNotification: async () => {} },
    location: new URL(name, scope),
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  const caches = memoryCaches();
  // eslint-disable-next-line no-new-func
  const run = new Function('self', 'caches', 'fetch', `${source}\nreturn { fetchBytes, fetchVerifiedRelease, checkUpdate, applyUpdate, readState, writeState, stageRelease, pageHeaders, readEvmServers, writeEvmServer, readOwnServer, LOADER_COMPAT, LOADER_NAME, LOADER_API, META_CACHE };`);
  const api = run(self, caches, (url, init) => net(url, init));
  return { ...api, self, caches, handlers, loaderCompat };
}
