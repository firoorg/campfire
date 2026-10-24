// The person's own Ethereum / BNB Chain server, seen from the service worker (src/sw.js as the build
// assembles it, run in a sandbox): "check-evm-server" asks the address the questions of
// lib/evm_server_check.js before anything is saved (a page cannot reach an address its policy does
// not name yet); "set-evm-server" keeps only the origin, after lib/evm_server_address.js took the
// address; every page served from then on has exactly that origin added to connect-src, next to the
// own Firo server's. Nothing the page sends goes into a header unchecked, and what is kept is
// checked again when it is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadLoader } from './helpers/sw_sandbox.mjs';
import { SECURITY_HEADERS, CSP } from '../../tools/headers.mjs';

async function testPub() {
  const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await webcrypto.subtle.exportKey('jwk', k.publicKey);
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
}

const hex = (n) => `0x${n.toString(16)}`;

/** A JSON-RPC server on chain `chainId` that answers every question of the check. */
function rpcAnswer(body, { chainId = 1, head = 5000, receipt = 'ok' } = {}) {
  const m = JSON.parse(body);
  const now = Math.floor(Date.now() / 1000);
  let out;
  if (m.method === 'eth_chainId') out = { result: hex(chainId) };
  else if (m.method === 'eth_getBlockByNumber') {
    const n = m.params[0] === 'latest' ? head : Number(BigInt(m.params[0]));
    out = { result: { number: hex(n), timestamp: hex(now - 5), transactions: [`0x${'cd'.repeat(32)}`] } };
  } else if (m.method === 'eth_getTransactionReceipt') out = receipt === 'refused' ? { error: { code: -32602, message: 'Archive requests require a personal token' } } : { result: { transactionHash: m.params[0], status: '0x1' } };
  else if (m.method === 'eth_call') out = { result: `0x${head.toString(16).padStart(64, '0')}` };
  else out = { error: { code: -32601, message: 'no' } };
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...out }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Sends one message to the loader the way a page does (a MessageChannel port) and returns its answer. */
async function ask(sw, data) {
  let answer;
  const waits = [];
  sw.handlers.message({ data, ports: [{ postMessage: (m) => (answer = m) }], waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return answer;
}

/** A page of an installed release, served by the loader's fetch handler: its response. */
async function servePage(sw) {
  // The page's real hash: the loader hashes each file again as it serves it (audit K1).
  const sha = [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('<!doctype html>')))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await sw.writeState({ current: { version: '1.0.0', cache: 'campfire-1.0.0-test', files: { 'index.html': sha } }, pending: null });
  await (await sw.caches.open('campfire-1.0.0-test')).put('https://wallet.example/index.html', new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
  let reply;
  sw.handlers.fetch({ request: { method: 'GET', url: 'https://wallet.example/index.html' }, respondWith: (p) => (reply = p) });
  return reply;
}

const connectSrc = (csp) => csp.split('; ').find((d) => d.startsWith('connect-src ')).split(' ').slice(1);

test('the loader is at contract level 2 (it knows the own Ethereum / BNB Chain servers) and says so', async () => {
  const sw = await loadLoader({ pub: await testPub(), fetch: async () => new Response('', { status: 404 }) });
  assert.equal(sw.LOADER_API, 2);
  const st = await ask(sw, { type: 'status' });
  assert.equal(st.api, 2);
});

test('check-evm-server: the address checked from the worker (no address of the wallet asked), and its report handed back; nothing is saved', async () => {
  const seen = [];
  const sw = await loadLoader({
    pub: await testPub(),
    fetch: async (url, init) => {
      seen.push({ url, init });
      return rpcAnswer(init.body, { chainId: 56 });
    },
  });
  const r = await ask(sw, { type: 'check-evm-server', chain: 'bsc', url: 'https://BSC.example.com:8545/v1/KEY' });
  assert.equal(r.result, 'checked');
  assert.equal(r.url, 'https://bsc.example.com:8545/v1/KEY');
  assert.equal(r.origin, 'https://bsc.example.com:8545');
  assert.equal(r.report.ok, true, JSON.stringify(r.report));
  assert.ok(seen.length >= 4);
  for (const { url, init } of seen) {
    assert.equal(url, 'https://bsc.example.com:8545/v1/KEY', 'the URL as typed (normalized), nothing else');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.mode, 'cors');
    assert.equal(init.redirect, 'error');
  }
  assert.deepEqual(await sw.readEvmServers(), { ethereum: null, bsc: null }, 'a check saves nothing');
  // The wrong chain: the report says so (the page refuses to save it).
  const wrong = await ask(sw, { type: 'check-evm-server', chain: 'ethereum', url: 'https://bsc.example.com:8545/v1/KEY' });
  assert.equal(wrong.result, 'checked');
  assert.equal(wrong.report.problem, 'wrong_chain');
});

test('check-evm-server refuses before asking anything: an address it does not take, a chain it does not know', async () => {
  const seen = [];
  const sw = await loadLoader({ pub: await testPub(), fetch: async (url) => (seen.push(url), new Response('', { status: 404 })) });
  for (const url of ['http://eth.example.com', 'https://user:pw@eth.example.com', 'javascript:alert(1)', 'https://[2001:db8::1]', '', null, 42]) {
    const r = await ask(sw, { type: 'check-evm-server', chain: 'ethereum', url });
    assert.equal(r.result, 'refused', String(url));
    assert.ok(typeof r.reason === 'string' && r.reason.length > 10);
  }
  for (const chain of ['polygon', '__proto__', 'constructor', null, undefined]) assert.equal((await ask(sw, { type: 'check-evm-server', chain, url: 'https://eth.example.com' })).result, 'refused', String(chain));
  assert.deepEqual(seen, [], 'no request for any of them');
});

test('set-evm-server keeps the origin only (never the path or its key); every page served from then on has it in connect-src, and only it', async () => {
  const sw = await loadLoader({ pub: await testPub(), fetch: async () => new Response('', { status: 404 }) });
  let r = await ask(sw, { type: 'set-evm-server', chain: 'ethereum', url: 'https://eth.example.com:8545/v3/SECRETKEY' });
  assert.deepEqual(r, { result: 'saved', chain: 'ethereum', origin: 'https://eth.example.com:8545' });
  r = await ask(sw, { type: 'set-evm-server', chain: 'bsc', url: 'http://[::1]:8545' });
  assert.deepEqual(r, { result: 'saved', chain: 'bsc', origin: 'http://localhost:8545' });
  // What the worker keeps: two origins, no path, no key.
  const kept = await (await (await sw.caches.open(sw.META_CACHE)).match('https://wallet.example/__campfire_evm')).text();
  assert.deepEqual(JSON.parse(kept), { ethereum: 'https://eth.example.com:8545', bsc: 'http://localhost:8545' });
  assert.ok(!kept.includes('SECRETKEY'));
  // A page served now.
  const page = await servePage(sw);
  const csp = page.headers.get('Content-Security-Policy');
  assert.deepEqual(connectSrc(csp).slice(0, -2), connectSrc(CSP), 'appended, nothing else moved');
  assert.deepEqual(connectSrc(csp).slice(-2), ['https://eth.example.com:8545', 'http://localhost:8545']);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== 'Content-Security-Policy') assert.equal(page.headers.get(k), v, k);
  // With the own Firo server too: both, Firo's first.
  await ask(sw, { type: 'set-server', server: 'electrum.example.com:50004' });
  const both = connectSrc((await servePage(sw)).headers.get('Content-Security-Policy'));
  assert.deepEqual(both.slice(-3), ['wss://electrum.example.com:50004', 'https://eth.example.com:8545', 'http://localhost:8545']);
  // Back to the listed servers on one chain: out of the next page's policy; the other stays.
  r = await ask(sw, { type: 'set-evm-server', chain: 'ethereum', url: null });
  assert.deepEqual(r, { result: 'saved', chain: 'ethereum', origin: null });
  await ask(sw, { type: 'set-server', server: null });
  assert.deepEqual(connectSrc((await servePage(sw)).headers.get('Content-Security-Policy')).slice(-1), ['http://localhost:8545']);
  await ask(sw, { type: 'set-evm-server', chain: 'bsc', url: null });
  assert.equal((await servePage(sw)).headers.get('Content-Security-Policy'), CSP, 'none left: the static policy');
  assert.equal(await (await sw.caches.open(sw.META_CACHE)).match('https://wallet.example/__campfire_evm'), undefined, 'and nothing kept');
});

test('set-evm-server refuses what the address rules refuse, and keeps what it had', async () => {
  const sw = await loadLoader({ pub: await testPub(), fetch: async () => new Response('', { status: 404 }) });
  await ask(sw, { type: 'set-evm-server', chain: 'bsc', url: 'https://bsc.example.com' });
  for (const url of ["https://e.example.com; script-src 'unsafe-inline'", 'https://*.example.com', 'http://eth.example.com', 'wss://eth.example.com', 'https://u:p@eth.example.com', 'https://eth.example.com/#x', 'https://eth.example.com/../x', 'https://[::2]', 42, {}]) {
    const r = await ask(sw, { type: 'set-evm-server', chain: 'bsc', url });
    assert.equal(r.result, 'refused', String(url));
  }
  assert.equal((await ask(sw, { type: 'set-evm-server', chain: 'polygon', url: 'https://p.example.com' })).result, 'refused');
  assert.deepEqual(await sw.readEvmServers(), { ethereum: null, bsc: 'https://bsc.example.com' });
});

test('what the worker kept is checked again when read: a tampered entry never reaches a header', async () => {
  const sw = await loadLoader({ pub: await testPub(), fetch: async () => new Response('', { status: 404 }) });
  const meta = await sw.caches.open(sw.META_CACHE);
  await meta.put('https://wallet.example/__campfire_evm', new Response(JSON.stringify({ ethereum: "https://e.example.com; script-src 'unsafe-eval'", bsc: 'https://b.example.com/path', polygon: 'https://p.example.com' })));
  assert.deepEqual(await sw.readEvmServers(), { ethereum: null, bsc: null });
  assert.equal((await servePage(sw)).headers.get('Content-Security-Policy'), CSP);
  // pageHeaders itself refuses anything but an origin.
  assert.throws(() => sw.pageHeaders(null, { ethereum: 'https://e.example.com/x' }));
  assert.equal(sw.pageHeaders(null, { ethereum: null, bsc: null }), sw.pageHeaders(null));
});
