// A build with the stand-in engine (--engine fake: sample balances, no Firo network) is signed
// like a release. It must never become what a real address serves: release.json says which
// engine it carries, the loader installs a stand-in release only on a test host (localhost,
// *.test), and the build never writes one into dist/, the folder a release is deployed from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLoader } from './helpers/sw_sandbox.mjs';
import { throwawayKey, SIGN_SKIP } from './helpers/throwaway_key.mjs';
import { engineAllowed, isTestHostname } from '../../src/lib/update_sources.js';
import { isTestHost } from '../../src/lib/chain.js';
import { RELEASE_APP_ID } from '../../src/lib/release.js';

const s = webcrypto.subtle;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pwa = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function signer() {
  const k = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await s.exportKey('jwk', k.publicKey);
  return { priv: k.privateKey, pub: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
}

/** release.json, .sig and manifest.json of a one-file release, as bytes by path. */
async function served(priv, extra = {}) {
  const files = { 'index.html': 'hello' };
  const entries = Object.entries(files).map(([path, c]) => ({ path, sha256: sha(Buffer.from(c)), size: Buffer.byteLength(c) }));
  const manifest = Buffer.from(JSON.stringify({ app: RELEASE_APP_ID, version: '1.0.1', files: entries }));
  const release = Buffer.from(JSON.stringify({ app: RELEASE_APP_ID, version: '1.0.1', created: '2026-10-12T00:00:00.000Z', manifest_sha256: sha(manifest), file_count: 1, ...extra }));
  const sig = Buffer.from(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, release)).toString('base64');
  return { 'release.json': release, 'release.sig': Buffer.from(sig), 'manifest.json': manifest, ...Object.fromEntries(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)])) };
}

const net = (scope, files) => async (url) => {
  const path = url.startsWith(scope) ? url.slice(scope.length) : null;
  if (path === null || !(path in files)) return new Response('not found', { status: 404 });
  return new Response(files[path], { status: 200 });
};

test('the rule: a stand-in release runs only on a test host; a release that names no engine is real', () => {
  assert.equal(engineAllowed({ engine: 'real' }, 'pwa.buyfiro.app'), true);
  assert.equal(engineAllowed({}, 'pwa.buyfiro.app'), true, 'releases before the field: real');
  assert.equal(engineAllowed({ engine: 'fake' }, 'pwa.buyfiro.app'), false);
  assert.equal(engineAllowed({ engine: 'other' }, 'vsnation.github.io'), false, 'anything but real is not real');
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'campfire.test', 'mirror.test']) assert.equal(engineAllowed({ engine: 'fake' }, h), true, h);
  // The loader's copy of the rule and lib/chain.js's agree.
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'campfire.test', 'a.b.test', 'test', 'localhost.example', 'pwa.buyfiro.app', 'x.test.example', '', null, undefined]) {
    assert.equal(isTestHostname(h), isTestHost(h), String(h));
  }
});

test('the loader refuses a stand-in release on a real address, at first install and in a tapped check', async () => {
  const k = await signer();
  const fake = await served(k.priv, { engine: 'fake' });
  const real = await served(k.priv, { engine: 'real' });
  const legacy = await served(k.priv);

  const scope = 'https://pwa.example.org/';
  const sw = await loadLoader({ pub: k.pub, scope, fetch: net(scope, fake) });
  await assert.rejects(sw.fetchVerifiedRelease(new URL(scope)), (e) => e.code === 'test_build' && /test build/.test(e.message));
  for (const ok of [real, legacy]) {
    const sw2 = await loadLoader({ pub: k.pub, scope, fetch: net(scope, ok) });
    assert.equal((await sw2.fetchVerifiedRelease(new URL(scope))).release.version, '1.0.1');
  }
  // On a test host the stand-in installs (the browser suites).
  for (const local of ['http://localhost:8781/', 'http://campfire.test:8811/']) {
    const sw3 = await loadLoader({ pub: k.pub, scope: local, fetch: net(local, fake) });
    assert.equal((await sw3.fetchVerifiedRelease(new URL(local))).release.engine, 'fake');
  }
  // Check for updates on a real address: refused, with the reason, and nothing staged.
  await sw.writeState({ current: { version: '1.0.0', manifestSha: 'm100', cache: 'campfire-1.0.0-m100', files: {}, sources: [] }, pending: null });
  const r = await sw.checkUpdate();
  assert.equal(r.result, 'refused');
  assert.match(r.reason, /test build/);
  assert.equal((await sw.readState()).pending, null);
});

test('the build says which engine a release carries, and never writes a stand-in build into dist/', { skip: SIGN_SKIP }, async () => {
  const key = await throwawayKey();
  const dirs = [];
  const build = (...args) => {
    const out = mkdtempSync(join(tmpdir(), 'campfire-engine-'));
    dirs.push(out);
    execFileSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', out, '--version', '0.0.6', '--quiet', ...key.args, ...args], { cwd: pwa, stdio: ['ignore', 'ignore', 'pipe'] });
    return JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'));
  };
  try {
    assert.equal(build().engine, 'real');
    assert.equal(build('--engine', 'fake').engine, 'fake');
    const hadDist = existsSync(join(pwa, 'dist'));
    const r = spawnSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', join(pwa, 'dist'), '--quiet', '--engine', 'fake', ...key.args], { cwd: pwa, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'refused');
    assert.match(r.stderr, /dist-fake/);
    assert.equal(existsSync(join(pwa, 'dist')), hadDist, 'dist/ untouched');
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    key.cleanup();
  }
});
