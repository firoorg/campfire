// The security headers Campfire must be served with. One list, used by the
// dev server (tools/serve.mjs), the build (which writes deploy/_headers and
// checks deploy/nginx.conf against it) and the service worker (which re-applies
// them to every response it serves from its cache).
//
// Why each one:
// - COOP + COEP make the page cross-origin isolated (SharedArrayBuffer stays
//   available for the Spark engine's WebAssembly, should it use threads).
// - CORP same-origin: no other site can embed our files.
// - CSP: scripts only from this origin; 'wasm-unsafe-eval' is what
//   WebAssembly.instantiate needs (no 'unsafe-eval'). connect-src names:
//   - Firo's four ElectrumX servers over wss (src/lib/servers.js FIRO_SERVERS):
//     the wallet syncs and broadcasts through them, nothing else. The person's
//     own server, when they add one, is added by the service worker to the
//     pages and workers it serves (securityHeaders(server) below, the same
//     function inlined into sw.js): exactly that wss origin, never a wildcard.
//     A static host's headers never name it; they only cover the first load,
//     before the service worker takes over.
//   - The Ethereum and BNB Chain servers from one list, src/lib/eth/hosts.js
//     (connectSources()): the servers the person can pick from per chain (the
//     app asks the one picked about the address, never a fallback, and only
//     once there is an Ethereum & BNB wallet; a server with a path, that exact
//     path) and CoinGecko's price path (only after the person allows prices).
//     All in one release, because this policy is inlined into the loader and
//     changing it renames the loader. The person's own Ethereum / BNB Chain
//     server, when they add one, is added by the service worker like the own
//     ElectrumX server: exactly its origin (scheme, host, port), one per chain,
//     checked by src/lib/evm_server_address.js (securityHeaders(server, evm)).
//   - Buy FIRO's API (src/lib/buy/hosts.js, buyConnectSources()): that one
//     path, not the whole host, and only once the person opens Buy FIRO.
//   - Sell FIRO's API (src/lib/sell/hosts.js, sellConnectSources()): that one
//     path too, and only once the person opens Sell FIRO (or has a sell open).
//     The payout's block explorer page is a link the person taps.
//   - NEAR Intents' 1Click API (src/lib/intents/hosts.js,
//     intentsConnectSources()): that one path, and only once the person opens
//     that screen.
//   Explorer pages (explorer.firo.org, etherscan.io, NEAR Intents' explorer) are
//   links the person taps: navigation only, never in connect-src.
//
// Not here yet: the Rosen bridge's own lookups (Ergo's box lookup, Firo's insight API) would each
// come in as an exact path when a feature needs them (the loader is renamed with it).

import { connectSources as ethConnectSources } from '../src/lib/eth/hosts.js';
import { buyConnectSources } from '../src/lib/buy/hosts.js';
import { sellConnectSources } from '../src/lib/sell/hosts.js';
import { intentsConnectSources } from '../src/lib/intents/hosts.js';
import { FIRO_SERVERS } from '../src/lib/servers.js';
import { cspWithServer } from '../src/lib/server_address.js';
import { cspWithEvmServers } from '../src/lib/evm_server_address.js';

export const SERVERS = [...FIRO_SERVERS];

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  `connect-src 'self' ${SERVERS.join(' ')} ${ethConnectSources().join(' ')} ${buyConnectSources().join(' ')} ${sellConnectSources().join(' ')} ${intentsConnectSources().join(' ')}`,
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  // camera=(self): Scan reads an address QR code with the camera (lib/qr_scan.js), in this
  // page only.
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  // HTTPS only, for a year: a browser that has opened the wallet once never loads it over plain
  // HTTP again, even from a typed address or an old link. No preload, no subdomains: a copy on
  // someone else's host is not committed to anything beyond its own name.
  'Strict-Transport-Security': 'max-age=31536000',
};

// The loader (sw-<hash>.js) is a worker, not a page: the policy on ITS response
// decides what it may fetch, and the browser applies it every time the worker
// starts. It fetches releases: from this origin, or, when that does not answer
// a tapped "Check for updates", from the copies in src/lib/update_sources.js or
// an address the person added - any https address, since a downloaded file is
// kept only after the release signature and its SHA-256 checked out. And, only
// when the person adds their own Ethereum / BNB Chain server, it asks that
// server the questions of src/lib/evm_server_check.js before it is saved (no
// address of the wallet in them): an https address, or a node on this device
// over http (localhost, 127.0.0.1: any port). It runs no other script and loads
// nothing else. Pages keep CSP above (the loader puts SECURITY_HEADERS on every
// page it serves): pages never fetch updates, and never reach an address their
// own policy does not name.
export const LOADER_CSP = ["default-src 'none'", "connect-src 'self' https: http://localhost:* http://127.0.0.1:*"].join('; ');
export const LOADER_FILE = /^sw(-[0-9a-f]+)?\.js$/;

// Every file of a release may be read by any origin, so any copy of the app can
// serve updates to installs whose own address is gone (GitHub Pages already
// sends this).
export const RELEASE_CORS = { 'Access-Control-Allow-Origin': '*' };

/** The headers a deployment sends for a path under the app's folder (rel: path relative to it, no leading slash). */
export function headersFor(rel) {
  const clean = String(rel).replace(/^\/+/, '');
  const h = { ...SECURITY_HEADERS, ...RELEASE_CORS };
  if (LOADER_FILE.test(clean)) h['Content-Security-Policy'] = LOADER_CSP;
  return h;
}

/**
 * What deploy/nginx.conf must contain (tools/build.mjs and the unit tests check
 * it): every header, the page policy and the loader's from one map on $uri, and
 * CORS on every file.
 */
export function nginxHeaderLines() {
  const lines = [];
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== 'Content-Security-Policy') lines.push(`add_header ${k} "${v}" always;`);
  lines.push('add_header Content-Security-Policy $campfire_csp always;');
  lines.push('add_header Access-Control-Allow-Origin "*" always;');
  lines.push(`default "${CSP}";`);
  lines.push(`"~/sw(-[0-9a-f]+)?\\.js$" "${LOADER_CSP}";`);
  return lines;
}

/**
 * A page's (or a page worker's) headers with the person's own ElectrumX server
 * ("host:port") and their own Ethereum / BNB Chain servers' origins (a list, or
 * {chain: origin}) in connect-src; none: SECURITY_HEADERS unchanged. The loader
 * serves pages this way (sw.js pageHeaders, the same functions inlined); its own
 * response keeps LOADER_CSP above.
 */
export function securityHeaders(ownServer = null, evmServers = null) {
  const evm = (Array.isArray(evmServers) ? evmServers : Object.values(evmServers || {})).filter((o) => o != null);
  if (ownServer == null && !evm.length) return SECURITY_HEADERS;
  return { ...SECURITY_HEADERS, 'Content-Security-Policy': cspWithEvmServers(cspWithServer(CSP, ownServer), evm) };
}

/** deploy/_headers (Cloudflare Pages format), as tools/build.mjs writes and checks it. */
export function renderHeaders() {
  const lines = ['# Generated by tools/build.mjs from tools/headers.mjs. Cloudflare Pages format. Netlify reads it too but', '# has no "!": there the loader would get both policies (the stricter wins), so give it its own with a host rule.', '/*'];
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) lines.push(`  ${k}: ${v}`);
  lines.push('  Access-Control-Allow-Origin: *');
  lines.push('  Cache-Control: no-cache');
  lines.push('');
  lines.push('# The loader is a worker: its own policy lets it fetch updates from other copies');
  lines.push('# (pages keep the one above). "!" removes a header for a path (Cloudflare Pages).');
  lines.push('/sw-*.js');
  lines.push('  ! Content-Security-Policy');
  lines.push(`  Content-Security-Policy: ${LOADER_CSP}`);
  return lines.join('\n') + '\n';
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.sig': 'text/plain; charset=utf-8',
  '.jwk': 'application/json',
};

export function mimeFor(path) {
  const i = path.lastIndexOf('.');
  return (i >= 0 && MIME[path.slice(i).toLowerCase()]) || 'application/octet-stream';
}

