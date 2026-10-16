// The few paths the loader (sw.js) lets go to the network as they are (release.json, its
// signature, the web manifest, loader scripts, /__dev/ on a test host) are fetched only, never
// opened as a page, a frame or a worker (public audit, P5): a host, or anyone who could put a file
// there, that served its own HTML or script on one of them ran it beside the wallet, unchecked, and
// it could register a loader of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { loadLoader } from './helpers/sw_sandbox.mjs';

async function testPub() {
  const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await webcrypto.subtle.exportKey('jwk', k.publicKey);
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
}

/** What the loader does with a request: 'network' (lets it go), or the status it answers itself. */
async function route(sw, url, { mode = 'cors', destination = '' } = {}) {
  let answered = null;
  sw.handlers.fetch({ request: { method: 'GET', url, mode, destination }, respondWith: (p) => (answered = p) });
  if (!answered) return 'network';
  return (await answered).status;
}

test('pass-through paths: fetched by the page, yes; opened as a page, frame, worker or script, no', async () => {
  const sw = await loadLoader({ pub: await testPub(), fetch: async () => new Response('', { status: 404 }) });
  const base = 'https://wallet.example/';
  for (const p of ['release.json', 'release.sig', 'manifest.json', 'sw-0123456789abcdef.js', 'sw.js', '_headers']) {
    assert.equal(await route(sw, base + p), 'network', `${p}: a fetch goes to the network`);
    assert.equal(await route(sw, base + p, { mode: 'navigate', destination: 'document' }), 404, `${p}: never a page`);
    for (const destination of ['iframe', 'worker', 'sharedworker', 'script', 'style', 'object', 'embed']) assert.equal(await route(sw, base + p, { destination }), 404, `${p} as ${destination}`);
  }
  assert.equal(await route(sw, base + 'manifest.json', { destination: 'manifest' }), 'network', 'the web manifest');
  // /__dev/ on a production host: nothing reaches the network.
  assert.equal(await route(sw, base + '__dev/flags'), 404);
  const dev = await loadLoader({ pub: await testPub(), scope: 'http://localhost:8781/', fetch: async () => new Response('', { status: 404 }) });
  assert.equal(await route(dev, 'http://localhost:8781/__dev/flags'), 'network', 'on a test host it answers');
  assert.equal(await route(dev, 'http://localhost:8781/__dev/x.html', { mode: 'navigate', destination: 'document' }), 404);
});

test('audit K1: once installed, every page in scope comes from the checked copy: a form\'s POST and a name that cannot be read too; a copy changed on this device is not run', async () => {
  const sw = await loadLoader({ pub: await testPub(), fetch: async () => new Response('<script>host</script>', { status: 200 }) });
  const base = 'https://wallet.example/';
  const page = new TextEncoder().encode('<!doctype html><title>Campfire</title>');
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sha = hex(await webcrypto.subtle.digest('SHA-256', page));
  await sw.writeState({ current: { version: '0.1.8', cache: 'campfire-test', files: { 'index.html': sha }, sources: [] }, pending: null });
  const c = await sw.caches.open('campfire-test');
  await c.put(base + 'index.html', new Response(page));
  const nav = { mode: 'navigate', destination: 'document' };
  const answer = async (method, url, how = nav) => {
    let p = null;
    sw.handlers.fetch({ request: { method, url, ...how }, respondWith: (x) => (p = x) });
    return p ? p : 'network';
  };
  const ok = await answer('GET', base + 'index.html');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '<!doctype html><title>Campfire</title>');
  for (const p of ['a%ZZ', 'x%E0%A4%A', 'index.html%']) assert.equal((await answer('GET', base + p)).status, 404, `${p}: never the host's page`);
  assert.equal((await answer('POST', base + 'index.html')).status, 404, 'a POST page: never the host\'s');
  assert.equal((await answer('POST', base + 'anything', { mode: 'navigate', destination: 'document' })).status, 404);
  assert.equal((await answer('POST', base + 'x', { mode: 'cors', destination: 'script' })).status, 404);
  assert.equal(await answer('POST', base + 'x', { mode: 'cors', destination: '' }), 'network', 'the app\'s own requests of another kind are left as they are');
  // Changed on this device after it was checked: not run.
  await c.put(base + 'index.html', new Response('<!doctype html><script>changed</script>'));
  const bad = await answer('GET', base + 'index.html');
  assert.equal(bad.status, 500);
  assert.match(await bad.text(), /changed on this device/);
});
