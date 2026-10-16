// Which Firo nodes (ElectrumX servers) the wallet reads the blockchain from, seen from the page.
// They only serve public chain data: keys, signing and Spark proofs never leave the device.
//
// Firo's public nodes (FIRO_SERVERS) are in every page's Content-Security-Policy
// (tools/headers.mjs), and by default the engine uses them all: it starts with one (the one the
// person picked, prefs.node, if any) and moves to the next when one stops answering. The person can
// instead name their own node (Settings -> Firo nodes): then that one only, never a fallback and
// never a cross-check, so nothing else learns their IP address or which payments are theirs.
//
// A page's policy is fixed when it loads. The service worker adds the own server to the policy
// of every page it serves from then on (sw.js "set-server"), so moving to a server this page's
// policy does not name takes one reload: the wallet locks, the app reopens, and unlock connects
// there. Moving back to Firo's servers needs none: they are in every policy.
//
// The person's own Ethereum / BNB Chain server (one per chain) goes the same way: checked by the
// service worker first (sw.js "check-evm-server": this page may not reach it yet), then its
// origin handed to the worker ("set-evm-server"), the choice saved in prefs, and one reload unless
// this page's policy already names it. Its address rules are lib/evm_server_address.js (here,
// and inlined into the worker); the Ethereum code itself stays off the first screen.

import { normalizeServerAddress } from './server_address.js';
import { normalizeEvmServer, cleanEvmOrigins, ownEvmServerOf, EVM_SERVER_PREFS, EVM_OWN } from './evm_server_address.js';

export const FIRO_SERVER_HOSTS = Object.freeze(['electrumx.firo.org', 'electrumx01.firo.org', 'electrumx02.firo.org', 'electrumx03.firo.org']);
export const FIRO_WSS_PORT = 50004;
/** The servers' WebSocket origins, as the CSP lists them. */
export const FIRO_SERVERS = Object.freeze(FIRO_SERVER_HOSTS.map((h) => `wss://${h}:${FIRO_WSS_PORT}`));
/** prefs.server: FIRO_POOL for Firo's public nodes, or the person's own "host:port". prefs.node: the public node tried first. */
export const FIRO_POOL = 'firo';

const META_CACHE = 'campfire-meta';
const OWN_SERVER_KEY = '__campfire_server';
const SWITCH_NOTE = 'campfire-server-switched';
const RECONCILE_KEY = 'campfire-server-reconciled';
const EVM_SERVERS_KEY = '__campfire_evm';
const EVM_SWITCH_NOTE = 'campfire-evm-switched';
const EVM_CHAIN_NAMES = Object.freeze({ ethereum: 'Ethereum', bsc: 'BNB Chain' });

/** The own server this page's policy was served with (read once at boot). */
let servedWith = null;
/** The own Ethereum / BNB Chain servers' origins this page's policy was served with: {ethereum, bsc} (read once at boot). */
let servedEvm = cleanEvmOrigins(null);

export const isOwnServer = (v) => typeof v === 'string' && v !== FIRO_POOL && normalizeServerAddress(v).ok;

/** The node list the engine gets for these preferences, in the order it tries them: [wss://…]. */
export function serversFor(prefs) {
  const v = prefs && prefs.server;
  if (isOwnServer(v)) return [`wss://${normalizeServerAddress(v).address}`];
  const first = prefs && FIRO_SERVER_HOSTS.includes(prefs.node) ? `wss://${prefs.node}:${FIRO_WSS_PORT}` : null;
  return first ? [first, ...FIRO_SERVERS.filter((u) => u !== first)] : [...FIRO_SERVERS];
}

/** In words, for Settings: "Firo's public nodes" or "Your own node: host:port". */
export function serverWords(prefs) {
  const v = prefs && prefs.server;
  return isOwnServer(v) ? `Your own node: ${normalizeServerAddress(v).address}` : "Firo's public nodes";
}

/** The own server the service worker adds to connect-src now, or null. */
export async function loaderServer() {
  try {
    const r = await (await caches.open(META_CACHE)).match(new URL(OWN_SERVER_KEY, document.baseURI).href);
    const v = r ? await r.json() : null;
    const n = v && v.server ? normalizeServerAddress(v.server) : null;
    return n && n.ok ? n.address : null;
  } catch {
    return null;
  }
}

function askLoader(msg, timeoutMs = 10000) {
  const sw = typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return Promise.reject(new Error('Your own server works in the installed app only.'));
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => reject(new Error('The app did not answer in time.')), timeoutMs);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve(e.data);
    };
    sw.postMessage(msg, [ch.port2]);
  });
}

/** Tells the service worker which own server to allow (null: none). */
export async function setLoaderServer(address) {
  const r = await askLoader({ type: 'set-server', server: address });
  if (!r || r.result !== 'saved') throw new Error(r && r.reason ? r.reason : 'This copy of the app cannot use your own server yet. Check for updates, then try again.');
  return r.server;
}

export const canUseOwnServer = () => Boolean(typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller);

// ---------------------------------------------------------------- own Ethereum / BNB Chain servers

/** A loader that predates own Ethereum / BNB Chain servers (LOADER_API 1) answers "unknown request". */
const OLD_LOADER = 'This copy of the app cannot use your own server yet: close Firo PWA and open it again (it finishes its last update), then try again.';

/** The own Ethereum / BNB Chain servers' origins the service worker adds to connect-src now: {ethereum, bsc}. */
export async function loaderEvmServers() {
  try {
    const r = await (await caches.open(META_CACHE)).match(new URL(EVM_SERVERS_KEY, document.baseURI).href);
    return cleanEvmOrigins(r ? await r.json() : null);
  } catch {
    return cleanEvmOrigins(null);
  }
}

/** Whether this page's policy names `origin` as `chain`'s own server (it can be reached without a reload). */
export const servedEvmOrigin = (chain) => servedEvm[chain] || null;

/**
 * Has the service worker ask `url` the questions of lib/evm_server_check.js, as `chain`'s server.
 * Resolves {url, origin, note, report}; throws with a plain sentence when the address is refused or
 * the worker cannot ask.
 */
export async function checkEvmWithLoader(chain, url, { timeoutMs = 60000 } = {}) {
  const n = normalizeEvmServer(url);
  if (!n.ok) throw new Error(n.error);
  const r = await askLoader({ type: 'check-evm-server', chain, url: n.url }, timeoutMs);
  if (r && r.result === 'checked' && r.report && typeof r.report === 'object') return { url: r.url, origin: r.origin, note: n.note, report: r.report };
  if (r && r.result === 'error' && /unknown request/.test(String(r.reason))) throw new Error(OLD_LOADER);
  throw new Error(r && r.reason ? r.reason : OLD_LOADER);
}

/** Tells the service worker `chain`'s own server (an address, or null: none). Returns the origin it keeps. */
export async function setLoaderEvmServer(chain, url) {
  const r = await askLoader({ type: 'set-evm-server', chain, url });
  if (r && r.result === 'saved') return r.origin || null;
  if (r && r.result === 'error' && /unknown request/.test(String(r.reason))) throw new Error(OLD_LOADER);
  throw new Error(r && r.reason ? r.reason : OLD_LOADER);
}

/**
 * Makes `url` (already checked: checkEvmWithLoader) `chain`'s only server: the service worker adds
 * its origin to the policy, prefs remember it, and - unless this page's policy already names it -
 * the wallet locks and the app reopens. Returns 'now' or 'reload'.
 */
export async function useOwnEvmServer(app, chain, url) {
  const keys = EVM_SERVER_PREFS[chain];
  if (!keys) throw new Error('Not a chain this wallet holds coins on.');
  const n = normalizeEvmServer(url);
  if (!n.ok) throw new Error(n.error);
  const origin = await setLoaderEvmServer(chain, n.url);
  await app.setPrefs({ [keys.pick]: EVM_OWN, [keys.url]: n.url });
  if (servedEvm[chain] === origin) return 'now';
  await app.lock('server');
  try {
    sessionStorage.setItem(EVM_SWITCH_NOTE, JSON.stringify({ chain, name: n.port ? `${n.host}:${n.port}` : n.host }));
  } catch {
    /* only for the line on the unlock screen */
  }
  location.reload();
  return 'reload';
}

/**
 * Back to a listed server of `chain` (`id`, checked by the caller against lib/eth/hosts.js): no
 * reload, they are in every policy. The own server's origin leaves the policy of every page served
 * from now on; its address stays in prefs, so "Your own server" can offer it again.
 */
export async function useListedEvmServer(app, chain, id) {
  const keys = EVM_SERVER_PREFS[chain];
  if (!keys) throw new Error('Not a chain this wallet holds coins on.');
  if (ownEvmServerOf(app.prefs, chain) || servedEvm[chain]) await setLoaderEvmServer(chain, null).catch((e) => console.warn('[campfire] own server', e.message));
  await app.setPrefs({ [keys.pick]: id });
}

/** After the reload that moves to an own Ethereum / BNB Chain server, unlock says which: "Ethereum: host" words, or null. */
export function takeEvmSwitchNote() {
  try {
    const v = sessionStorage.getItem(EVM_SWITCH_NOTE);
    sessionStorage.removeItem(EVM_SWITCH_NOTE);
    const j = v ? JSON.parse(v) : null;
    return j && EVM_CHAIN_NAMES[j.chain] && typeof j.name === 'string' ? { chain: EVM_CHAIN_NAMES[j.chain], name: j.name.slice(0, 260) } : null;
  } catch {
    return null;
  }
}

/** After the reload that moves to an own server, unlock says which server it will connect to. */
export function takeSwitchNote() {
  try {
    const v = sessionStorage.getItem(SWITCH_NOTE);
    sessionStorage.removeItem(SWITCH_NOTE);
    return v;
  } catch {
    return null;
  }
}

/**
 * Makes `address` the only server: the service worker adds it to the policy, prefs remember it,
 * and - unless this page's policy already names it - the wallet locks and the app reopens on it.
 * Returns 'reload' or 'restarted'.
 */
export async function useOwnServer(app, address) {
  const n = normalizeServerAddress(address);
  if (!n.ok) throw new Error(n.error);
  await setLoaderServer(n.address);
  await app.setPrefs({ server: n.address });
  if (servedWith === n.address) {
    if (app.wallet.session) await app.wallet.setServers(serversFor(app.prefs), { ownNode: true });
    return 'restarted';
  }
  await app.lock('server');
  try {
    sessionStorage.setItem(SWITCH_NOTE, n.address);
  } catch {
    /* only for the line on the unlock screen */
  }
  location.reload();
  return 'reload';
}

/** Back to Firo's public nodes: no reload. The own node leaves the policy of every page served from now on. */
export async function useFiroServers(app) {
  await setLoaderServer(null).catch((e) => console.warn('[campfire] own server', e.message));
  await app.setPrefs({ server: FIRO_POOL });
  if (app.wallet.session) await app.wallet.setServers(serversFor(app.prefs), { ownNode: false });
}

/**
 * One of Firo's public nodes first, now: the others stay behind it, so the wallet still moves on
 * by itself when it stops answering. Leaves an own node, if one was in use.
 */
export async function usePublicNode(app, host) {
  if (!FIRO_SERVER_HOSTS.includes(host)) throw new Error("That is not one of Firo's public nodes.");
  if (isOwnServer(app.prefs.server)) await setLoaderServer(null).catch((e) => console.warn('[campfire] own server', e.message));
  await app.setPrefs({ server: FIRO_POOL, node: host });
  if (app.wallet.session) await app.wallet.setServers(serversFor(app.prefs), { ownNode: false });
}

/**
 * At boot: the page's policy and the person's choice agree. An own server (Firo's ElectrumX, or an
 * Ethereum / BNB Chain one) the worker does not know yet is handed to it, with one reload for all of
 * them; a server the worker still allows but nobody uses is dropped. Returns true when it reloads.
 */
export async function reconcileOwnServer(app) {
  servedWith = await loaderServer();
  servedEvm = await loaderEvmServers();
  if (!canUseOwnServer()) return false;
  const want = isOwnServer(app.prefs.server) ? normalizeServerAddress(app.prefs.server).address : null;
  const wantEvm = {};
  for (const k of Object.keys(EVM_SERVER_PREFS)) wantEvm[k] = ownEvmServerOf(app.prefs, k);
  // Nobody uses it any more: out of the next page's policy (no reload needed for that).
  if (want === null && servedWith !== null) await setLoaderServer(null).catch(() => {});
  for (const k of Object.keys(wantEvm)) if (!wantEvm[k] && servedEvm[k]) await setLoaderEvmServer(k, null).catch(() => {});
  const missingFiro = want !== null && servedWith !== want;
  const missingEvm = Object.keys(wantEvm).filter((k) => wantEvm[k] && servedEvm[k] !== wantEvm[k].origin);
  if (!missingFiro && !missingEvm.length) return false;
  const signature = JSON.stringify([missingFiro ? want : null, ...missingEvm.map((k) => [k, wantEvm[k].origin])]);
  let tried = null;
  try {
    tried = sessionStorage.getItem(RECONCILE_KEY);
    sessionStorage.setItem(RECONCILE_KEY, signature);
  } catch {
    return false;
  }
  if (tried === signature) return false;
  try {
    if (missingFiro) await setLoaderServer(want);
    for (const k of missingEvm) await setLoaderEvmServer(k, wantEvm[k].url);
  } catch {
    return false;
  }
  location.reload();
  return true;
}
