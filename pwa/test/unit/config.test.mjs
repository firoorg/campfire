// The privacy-relevant configuration agrees everywhere it is written down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVERS as HEADER_SERVERS, CSP, SECURITY_HEADERS, LOADER_CSP, MIME, headersFor, nginxHeaderLines, securityHeaders } from '../../tools/headers.mjs';
import { BUILTIN_SOURCES } from '../../src/lib/update_sources.js';
import { FIRO_SERVERS, FIRO_SERVER_HOSTS, FIRO_POOL, serversFor } from '../../src/lib/servers.js';
import { DEFAULT_PREFS } from '../../src/lib/store.js';
import { connectSources, ETH_RPC_HOSTS, DEFAULT_ETH_RPC, PRICE_HOST, TX_EXPLORER, originOf, txExplorerUrl } from '../../src/lib/eth/hosts.js';
import { buyConnectSources } from '../../src/lib/buy/hosts.js';
import { sellConnectSources } from '../../src/lib/sell/hosts.js';
import { intentsConnectSources, intentsApiBase, intentsExplorerUrl } from '../../src/lib/intents/hosts.js';

const pwa = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test("the app uses exactly the servers the CSP allows: Firo's four ElectrumX servers over wss, by default", () => {
  assert.deepEqual(FIRO_SERVERS, HEADER_SERVERS);
  assert.deepEqual(FIRO_SERVERS, [
    'wss://electrumx.firo.org:50004',
    'wss://electrumx01.firo.org:50004',
    'wss://electrumx02.firo.org:50004',
    'wss://electrumx03.firo.org:50004',
  ]);
  assert.equal(FIRO_SERVER_HOSTS.length, 4);
  assert.equal(DEFAULT_PREFS.server, FIRO_POOL);
  assert.deepEqual(serversFor(DEFAULT_PREFS), FIRO_SERVERS);
});

const connectSrc = (csp) => csp.split('; ').find((d) => d.startsWith('connect-src ')).split(' ').slice(1);

test('CSP without an own server: the static headers, unchanged', () => {
  assert.equal(securityHeaders(), SECURITY_HEADERS);
  assert.equal(securityHeaders(null), SECURITY_HEADERS);
  assert.ok(!connectSrc(CSP).some((s) => s.startsWith('wss://') && !HEADER_SERVERS.includes(s)), "only Firo's servers are wss sources");
  assert.ok(!connectSrc(CSP).includes('wss:') && !connectSrc(CSP).includes('*'), 'no wildcard');
});

test('CSP with an own server: exactly one extra wss origin in connect-src, every other header and directive as before', () => {
  for (const [given, origin] of [
    ['127.0.0.1:9443', 'wss://127.0.0.1:9443'],
    ['wss://Electrum.Example.com:50004/', 'wss://electrum.example.com:50004'],
    ['my-electrum.example.org', 'wss://my-electrum.example.org:50004'],
  ]) {
    const h = securityHeaders(given);
    for (const k of Object.keys(SECURITY_HEADERS)) if (k !== 'Content-Security-Policy') assert.equal(h[k], SECURITY_HEADERS[k], k);
    const before = CSP.split('; ');
    const after = h['Content-Security-Policy'].split('; ');
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) if (!before[i].startsWith('connect-src ')) assert.equal(after[i], before[i]);
    const extra = connectSrc(h['Content-Security-Policy']).filter((s) => !connectSrc(CSP).includes(s));
    assert.deepEqual(extra, [origin]);
    assert.deepEqual(connectSrc(h['Content-Security-Policy']).slice(0, -1), connectSrc(CSP), 'appended, nothing else moved');
  }
  // One of Firo's servers given as an own server adds nothing (it is already allowed).
  assert.equal(securityHeaders('electrumx01.firo.org:50004')['Content-Security-Policy'], CSP);
  // Anything that is not host:port never reaches the header.
  for (const bad of ["evil.com:443; script-src *", 'a.com:443 wss:', '*:443', 'wss://*.com:1', '[::1]:50004', 'h:1/x', 'ws://plain.example:50003', 'tcp://e.example:50001']) assert.throws(() => securityHeaders(bad), bad);
});

test("CSP with the person's own Ethereum / BNB Chain servers: exactly their origins appended to connect-src, nothing else changed", () => {
  const h = securityHeaders(null, { ethereum: 'https://eth.example.com:8545', bsc: 'http://127.0.0.1:8545' });
  for (const k of Object.keys(SECURITY_HEADERS)) if (k !== 'Content-Security-Policy') assert.equal(h[k], SECURITY_HEADERS[k], k);
  const before = CSP.split('; ');
  const after = h['Content-Security-Policy'].split('; ');
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) if (!before[i].startsWith('connect-src ')) assert.equal(after[i], before[i]);
  assert.deepEqual(connectSrc(h['Content-Security-Policy']).slice(0, -2), connectSrc(CSP), 'appended, nothing else moved');
  assert.deepEqual(connectSrc(h['Content-Security-Policy']).slice(-2), ['https://eth.example.com:8545', 'http://127.0.0.1:8545']);
  // With the own Firo server too: that one first, then the EVM ones.
  const both = securityHeaders('my.electrum.example.com:50004', ['https://bsc.example.org']);
  assert.deepEqual(connectSrc(both['Content-Security-Policy']).slice(-2), ['wss://my.electrum.example.com:50004', 'https://bsc.example.org']);
  // A listed origin given again adds nothing; nulls are nothing.
  assert.equal(securityHeaders(null, { ethereum: 'https://eth2.stackwallet.com', bsc: null })['Content-Security-Policy'], CSP);
  assert.equal(securityHeaders(null, { ethereum: null, bsc: null }), SECURITY_HEADERS);
  assert.equal(securityHeaders(null, []), SECURITY_HEADERS);
  // Only an origin (no path, query, credentials, wildcard, other scheme) ever reaches the header.
  for (const bad of ['https://eth.example.com/v3/KEY', 'https://eth.example.com/', "https://e.example.com; script-src *", 'https://*.example.com', 'https:', '*', 'http://eth.example.com', 'wss://eth.example.com', 'https://u:p@eth.example.com', 'https://[2001:db8::1]', 'http://[::1]:8545', 'https://Eth.Example.com'])
    assert.throws(() => securityHeaders(null, [bad]), bad);
});

test('the own server is a page policy only: the loader keeps its own', () => {
  assert.equal(headersFor('sw-0123456789abcdef.js')['Content-Security-Policy'], LOADER_CSP);
  assert.ok(!LOADER_CSP.includes('wss:'), 'the loader reaches no server');
  assert.equal(headersFor('index.html')['Content-Security-Policy'], CSP, 'deployments serve the static page policy');
  assert.notEqual(securityHeaders('127.0.0.1:9443')['Content-Security-Policy'], LOADER_CSP);
});

test("connect-src: this origin, Firo's servers, the Ethereum servers of lib/eth/hosts.js, Buy FIRO's and Sell FIRO's API paths and NEAR Intents' 1Click API path only", () => {
  const sources = connectSrc(CSP);
  assert.deepEqual(sources, ["'self'", ...FIRO_SERVERS, ...connectSources(), ...buyConnectSources(), ...sellConnectSources(), ...intentsConnectSources()]);
  // Buy FIRO: the buy API path only, never the whole host.
  assert.equal(buyConnectSources().length, 1);
  assert.match(buyConnectSources()[0], /^https:\/\/[a-z0-9.-]+\/api\/([a-z0-9/_-]+\/)?$/, 'an API path, never a bare host');
  assert.ok(!sources.includes(new URL(buyConnectSources()[0]).origin));
  // Sell FIRO: the sell API path only; its payout explorers are links, never contacted.
  assert.deepEqual(sellConnectSources(), ['https://buyfiro.app/api/v1/sell/']);
  assert.ok(!sources.some((s) => /scan\.|explorer/.test(s)), 'no payout explorer is contacted');
  // NEAR Intents: the 1Click API path only (tokens, quote, status), never the whole host.
  assert.deepEqual(intentsConnectSources(), ['https://1click.chaindefuser.com/v0/']);
  assert.equal(intentsApiBase(), 'https://1click.chaindefuser.com/v0');
  assert.ok(!sources.includes('https://1click.chaindefuser.com'));
  assert.ok(!sources.some((s) => s.includes('explorer.near-intents.org')), 'its explorer is a link the person taps, never contacted by the app');
  assert.equal(intentsExplorerUrl(), 'https://explorer.near-intents.org');
  for (const s of connectSources()) assert.match(s, /^https:\/\/[a-z0-9.-]+(\/[a-z0-9/._-]*)?$/, s);
  assert.ok(connectSources().includes('https://api.coingecko.com/api/v3/simple/price'), "CoinGecko's price path (FIRO and ETH prices, only once allowed)");
  assert.ok(ETH_RPC_HOSTS.some((h) => h.id === DEFAULT_ETH_RPC));
  assert.ok(!sources.some((s) => s.includes(TX_EXPLORER.host)), 'the block explorer is a link the person taps, never contacted by the app');
  assert.ok(!sources.some((s) => /beam/i.test(s)), 'nothing of BEAM is left');
  assert.ok(!CSP.includes('explorer'), 'no explorer is contacted');
  assert.ok(!CSP.includes("'unsafe-eval'") && !CSP.includes("'unsafe-inline'"));
});

test('the block explorer link is built only for a transaction hash', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  assert.equal(txExplorerUrl(hash), `${originOf(TX_EXPLORER)}/tx/${hash}`);
  for (const bad of ['', '0x12', `${hash}/../x`, `javascript:${hash}`, null]) assert.throws(() => txExplorerUrl(bad));
  assert.equal(PRICE_HOST.path, '/api/v3/simple/price');
});

test('cross-origin isolation headers are present', () => {
  assert.equal(SECURITY_HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Embedder-Policy'], 'require-corp');
});

test('deploy configs carry the same headers, and no proxy is left', () => {
  const nginx = readFileSync(join(pwa, 'deploy', 'nginx.conf'), 'utf8');
  const headers = readFileSync(join(pwa, 'deploy', '_headers'), 'utf8');
  for (const line of nginxHeaderLines()) assert.ok(nginx.includes(line), `nginx: ${line.slice(0, 60)}`);
  // nginx drops server-level add_header in any location that has its own: none may.
  const server = nginx.slice(nginx.indexOf('server {'));
  assert.ok(!/location[^{]*\{[^}]*add_header/.test(server), 'no add_header inside a location block');
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.ok(headers.includes(`${k}: ${v}`), `_headers: ${k}`);
  assert.ok(!/proxy_pass|recovery|explorer|beam/i.test(nginx), 'no proxy, nothing of BEAM');
  // Every type the loader serves, nginx serves the same (audit E-9).
  const types = nginx.slice(nginx.indexOf('types {'), nginx.indexOf('}', nginx.indexOf('types {')));
  const charsetTypes = (nginx.match(/charset_types ([^;]+);/) || [, ''])[1].split(/\s+/);
  assert.match(nginx, /^\s*charset utf-8;$/m);
  for (const [ext, mime] of Object.entries(MIME)) {
    const [type, param] = mime.split('; ');
    assert.match(types, new RegExp(`${type.replace(/[+/.]/g, '\\$&')}[^;]*\\b${ext.slice(1)}\\b`), `nginx types: ${ext}`);
    assert.equal(charsetTypes.includes(type), param === 'charset=utf-8', `nginx charset for ${ext}`);
  }
  assert.ok(!/recovery|explorer|beam|wasm-client/i.test(headers));
});

test('the loader gets its own policy (it may fetch signed updates from any https copy); pages keep theirs; every release file is readable by any copy', () => {
  // https: any copy of a release; and, only for a person's own Ethereum / BNB Chain server before it
  // is saved, the questions of lib/evm_server_check.js, which may go to a node on this device.
  assert.equal(LOADER_CSP, "default-src 'none'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*");
  assert.ok(!/connect-src[^;]* http:( |;|$)/.test(LOADER_CSP), 'never all of http');
  for (const p of ['sw-0123456789abcdef.js', '/sw-0123456789abcdef.js', 'sw.js']) assert.equal(headersFor(p)['Content-Security-Policy'], LOADER_CSP, p);
  for (const p of ['index.html', 'app.js', 'lib/sw-0123456789abcdef.js', 'release.json']) assert.equal(headersFor(p)['Content-Security-Policy'], CSP, p);
  assert.ok(!CSP.includes('https:;') && !/connect-src[^;]* https:( |;|$)/.test(CSP), 'the page policy names its hosts, never all of https');
  for (const p of ['index.html', 'release.json', 'release.sig', 'manifest.json', 'sw-0123456789abcdef.js']) assert.equal(headersFor(p)['Access-Control-Allow-Origin'], '*', p);
  // Everything else is the same set on every path.
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== 'Content-Security-Policy') assert.equal(headersFor('sw-0123456789abcdef.js')[k], v, k);
  const headers = readFileSync(join(pwa, 'deploy', '_headers'), 'utf8');
  assert.match(headers, /\n\/\*\n(?:  [^\n]+\n)*  Access-Control-Allow-Origin: \*\n/);
  assert.ok(headers.includes(`/sw-*.js\n  ! Content-Security-Policy\n  Content-Security-Policy: ${LOADER_CSP}\n`));
});

test('no source file reaches out to another origin', () => {
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const offenders = [];
  const ends = (f, ...p) => f.endsWith(join(...p));
  for (const f of walk(join(pwa, 'src'))) {
    if (!/\.(js|html|css|webmanifest)$/.test(f)) continue;
    const s = readFileSync(f, 'utf8');
    // Third-party code (src/vendor/): its URLs are references in comments. It must not make requests of its own.
    if (f.startsWith(join(pwa, 'src', 'vendor') + '/')) {
      assert.ok(!/\b(fetch\(|XMLHttpRequest|WebSocket|importScripts|sendBeacon|EventSource)/.test(s), `${f} makes requests`);
      continue;
    }
    for (const m of s.matchAll(/https?:\/\/[^\s'"`)<]+/g)) {
      const u = m[0];
      if (/^http:\/\/www\.w3\.org\/2000\/svg/.test(u)) continue; // SVG namespace, not a request
      // The Ethereum servers (exactly what connect-src lists) and the block explorer's
      // address, whose transaction pages the person may open with a tap: only in this file.
      if (ends(f, 'lib', 'eth', 'hosts.js') && (connectSources().includes(u) || u === originOf(TX_EXPLORER))) continue;
      // The public copies of the release, asked only by a tapped Check for updates (from the
      // loader, after this app's own address): exactly the list, only in this file.
      // Besides those, only the scheme it puts in front of a typed address, and its wording.
      if (ends(f, 'lib', 'update_sources.js') && (BUILTIN_SOURCES.includes(u) || u === 'https://${s}' || u === 'https://.')) continue;
      // Firo's block explorer page of a transaction, a plain link the person taps in a payment's
      // details (the app fetches nothing from it): only explorer.firo.org, only in this file.
      if (ends(f, 'lib', 'payments.js') && /^https:\/\/explorer\.firo\.org\//.test(u)) continue;
      // The person's own Ethereum / BNB Chain server: the schemes it takes, said in words, and
      // examples on reserved names (RFC 2606) or this device. These files reach out to nothing:
      // the address typed is checked by the service worker, then asked by lib/eth/rpc.js.
      if ((ends(f, 'lib', 'evm_server_address.js') || ends(f, 'screens', 'eth_servers.js')) && /^https?:\/\/(?:$|[^a-z0-9]|localhost\b|(?:[a-z0-9-]+\.)*example\.(?:com|org|net)\b)/i.test(u)) continue;
      offenders.push(`${f.slice(pwa.length)}: ${u}`);
    }
  }
  assert.deepEqual(offenders, []);
});
