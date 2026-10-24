// What the loader (sw.js) and the page (lib/loader.js) send when they fetch release files and the
// loader script: never cookies, not even to the app's own address. A cookie set for the parent
// domain (any *.example script can set one) rides along on every same-origin request that
// carries credentials; a large one makes the CDN refuse the request outright (HTTP 520), which
// would take updates and loader checks down with it. The app sets no cookies, so nothing is lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { loadLoader } from './helpers/sw_sandbox.mjs';

async function testPub() {
  const k = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await webcrypto.subtle.exportKey('jwk', k.publicKey);
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
}

test('the loader fetches release files without cookies, from its own address and from copies', async () => {
  const seen = [];
  const sw = await loadLoader({
    pub: await testPub(),
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response('nope', { status: 404 });
    },
  });
  for (const base of ['https://wallet.example/', 'https://copy.example.net/campfire/']) {
    await assert.rejects(sw.fetchBytes(new URL(base), 'release.json'), (e) => e.code === 'unreachable');
  }
  assert.deepEqual(seen.map((s) => s.url), ['https://wallet.example/release.json', 'https://copy.example.net/campfire/release.json']);
  for (const { url, init } of seen) {
    assert.equal(init.credentials, 'omit', `${url}: no cookies`);
    assert.equal(init.cache, 'no-store', `${url}: past any HTTP cache`);
    assert.equal(init.referrerPolicy, 'no-referrer', `${url}: no referrer`);
  }
});

test("the page checks the loader's bytes without cookies", async () => {
  const seen = [];
  const prev = { fetch: globalThis.fetch, document: globalThis.document };
  globalThis.document = { baseURI: 'https://wallet.example/' };
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response('self.x = 1;', { status: 200, headers: { 'Content-Type': 'text/javascript' } });
  };
  try {
    const { loaderServed } = await import('../../src/lib/loader.js');
    assert.equal(await loaderServed('sw-0123456789abcdef.js'), false, 'other bytes than the name says');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://wallet.example/sw-0123456789abcdef.js');
    assert.equal(seen[0].init.credentials, 'omit');
    assert.equal(seen[0].init.cache, 'no-store');
  } finally {
    globalThis.fetch = prev.fetch;
    globalThis.document = prev.document;
  }
});

test('after a move: the loader is asked for the way the browser installs it, and only a script with other bytes counts as other', async () => {
  const signedBytes = 'self.signed = 1;';
  const sha = createHash('sha256').update(signedBytes).digest('hex');
  const name = `sw-${sha.slice(0, 16)}.js`;
  const prev = { fetch: globalThis.fetch, document: globalThis.document };
  globalThis.document = { baseURI: 'https://wallet.example/' };
  let answer = null;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  try {
    const { loaderBytes, loaderServed } = await import('../../src/lib/loader.js');
    const js = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
    answer = js(signedBytes);
    assert.equal(await loaderBytes(name, sha, { asInstall: true }), 'same');
    assert.equal(seen.at(-1).init.headers['Service-Worker'], 'script', 'asked like an install');
    assert.equal(seen.at(-1).init.credentials, 'omit');
    answer = js(signedBytes);
    assert.equal(await loaderBytes(name, null, { asInstall: true }), 'same', 'without the signed hash: the name');
    answer = js(`${signedBytes}\n// changed\n`);
    assert.equal(await loaderBytes(name, sha, { asInstall: true }), 'other');
    answer = new Response('<h1>parked</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    assert.equal(await loaderBytes(name, sha, { asInstall: true }), 'unknown', 'a parking page is nothing the browser would install');
    answer = new Response('busy', { status: 503 });
    assert.equal(await loaderBytes(name, sha, { asInstall: true }), 'unknown');
    answer = new TypeError('Failed to fetch');
    assert.equal(await loaderBytes(name, sha, { asInstall: true }), 'unknown');
    assert.equal(await loaderBytes('../evil.js', sha), 'unknown', 'only a loader name');
    // The page's pre-check (loaderServed) is a plain request.
    answer = js(signedBytes);
    assert.equal(await loaderServed(name, sha), true);
    assert.deepEqual(seen.at(-1).init.headers, {});
  } finally {
    globalThis.fetch = prev.fetch;
    globalThis.document = prev.document;
  }
});
