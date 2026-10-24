// tools/check_deploy.mjs against a deployment held in memory: what it accepts, and each thing it
// must flag, including what audit E measured on the live host (a CDN rewriting Cache-Control:
// no-cache to max-age=14400 for .js/.css/.png/.svg/.ttf).
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { checkDeploy, expectedHeaders } from '../../tools/check_deploy.mjs';
import { mimeFor } from '../../tools/headers.mjs';
import { RELEASE_APP_ID } from '../../src/lib/release.js';

const s = webcrypto.subtle;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const BASE = 'https://wallet.example/app/';

async function signer() {
  const k = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await s.exportKey('jwk', k.publicKey);
  return { priv: k.privateKey, pub: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
}

/** A small signed deployment: { files: path -> Buffer } including the three release files. */
async function site(priv, { engine = 'real' } = {}) {
  const loaderBody = 'self.addEventListener("fetch", () => {});\n';
  const loader = `sw-${sha(Buffer.from(loaderBody)).slice(0, 16)}.js`;
  const files = {
    'index.html': Buffer.from('<!doctype html><title>Campfire</title>'),
    'app.js': Buffer.from('console.log(1);'),
    'css/app.css': Buffer.from('body{}'),
    'lib/version.js': Buffer.from(`export const LOADER = ${JSON.stringify(loader)};\n`),
    [loader]: Buffer.from(loaderBody),
  };
  const entries = Object.entries(files).map(([path, b]) => ({ path, sha256: sha(b), size: b.length }));
  const manifest = Buffer.from(JSON.stringify({ app: RELEASE_APP_ID, version: '1.0.0', files: entries }));
  const release = Buffer.from(JSON.stringify({ app: RELEASE_APP_ID, version: '1.0.0', created: '2026-10-12T00:00:00.000Z', manifest_sha256: sha(manifest), file_count: entries.length, loader, engine }));
  const sig = Buffer.from(Buffer.from(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, release)).toString('base64'));
  return { loader, files: { ...files, 'manifest.json': manifest, 'release.json': release, 'release.sig': sig } };
}

/** A host serving `files` under BASE with the production headers; tweak(rel, headers, body) may change an answer. */
function host(files, tweak = () => {}) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url, method: init.method });
    const rel = url.startsWith(BASE) ? decodeURIComponent(url.slice(BASE.length)) : null;
    const headers = { ...expectedHeaders(rel || ''), 'Content-Type': mimeFor(rel || '') };
    let body = rel !== null && rel in files ? files[rel] : null;
    let status = body ? 200 : 404;
    const t = tweak(rel, headers, body);
    if (t) ({ body = body, status = status } = t);
    return new Response(body || 'not found', { status, headers });
  };
  return { fetchImpl, asked };
}

test('a deployment that matches its signed release: OK, with GET requests only', async () => {
  const k = await signer();
  const { files } = await site(k.priv);
  const h = host(files);
  const r = await checkDeploy({ base: BASE, publicJwk: k.pub, fetchImpl: h.fetchImpl });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.equal(r.files, 5);
  assert.ok(h.asked.every((a) => a.method === 'GET'), 'read-only');
  assert.ok(h.asked.some((a) => /__campfire_check_deploy_/.test(a.url)), 'a 404 was looked at too');
});

test('what audit E saw live: Cache-Control rewritten to max-age=14400 for scripts, styles and the loader', async () => {
  const k = await signer();
  const { files, loader } = await site(k.priv);
  const cdn = host(files, (rel, headers) => {
    if (/\.(js|css|png|svg|ttf)$/.test(rel || '')) headers['Cache-Control'] = 'max-age=14400';
  });
  const r = await checkDeploy({ base: BASE, publicJwk: k.pub, fetchImpl: cdn.fetchImpl });
  assert.equal(r.ok, false);
  for (const p of ['app.js', 'css/app.css', 'lib/version.js', loader]) assert.ok(r.problems.includes(`${p}: Cache-Control: max-age=14400 (want no-cache)`), p);
  assert.ok(!r.problems.some((p) => p.startsWith('index.html')), 'index.html kept no-cache');
});

test('flagged: an altered file, a missing policy, the loader without its own policy, a test build, a forged release', async () => {
  const k = await signer();
  const { files, loader } = await site(k.priv);
  // One file changed after signing.
  let r = await checkDeploy({ base: BASE, publicJwk: k.pub, fetchImpl: host(files, (rel) => (rel === 'app.js' ? { body: Buffer.from('console.log(2);') } : null)).fetchImpl });
  assert.ok(r.problems.some((p) => /^app\.js: not the signed file/.test(p)), r.problems.join('\n'));
  // The page policy missing on index.html; the page policy (not the loader's) on the loader.
  r = await checkDeploy({
    base: BASE,
    publicJwk: k.pub,
    fetchImpl: host(files, (rel, headers) => {
      if (rel === 'index.html') delete headers['Content-Security-Policy'];
      if (rel === loader) headers['Content-Security-Policy'] = expectedHeaders('index.html')['Content-Security-Policy'];
    }).fetchImpl,
  });
  assert.ok(r.problems.some((p) => p.startsWith('index.html: Content-Security-Policy: missing')));
  assert.ok(r.problems.some((p) => p.startsWith(`${loader}: Content-Security-Policy: default-src 'self'`)));
  // A stand-in-engine build on a public address.
  const fake = await site(k.priv, { engine: 'fake' });
  r = await checkDeploy({ base: BASE, publicJwk: k.pub, fetchImpl: host(fake.files).fetchImpl });
  assert.ok(r.problems.some((p) => /engine "fake" is a test build/.test(p)));
  // Signed with another key.
  const other = await signer();
  r = await checkDeploy({ base: BASE, publicJwk: other.pub, fetchImpl: host(files).fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /^release: This update is not signed with the Campfire release key/);
  // Nothing published there.
  r = await checkDeploy({ base: BASE, publicJwk: k.pub, fetchImpl: host({}).fetchImpl });
  assert.match(r.problems[0], /^release: release\.json: HTTP 404/);
});
