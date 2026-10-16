import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseSignature, verifyManifest, verifyFile, compareVersions, ReleaseError, RELEASE_APP_ID } from '../../src/lib/release.js';
import { throwawayKey, SIGN_SKIP } from './helpers/throwaway_key.mjs';

const s = webcrypto.subtle;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const enc = (o) => Buffer.from(JSON.stringify(o));

async function keypair() {
  const k = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await s.exportKey('jwk', k.publicKey);
  return { priv: k.privateKey, pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
}
async function sign(priv, bytes) {
  return Buffer.from(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, bytes)).toString('base64');
}

async function makeRelease(priv, { version = '1.0.0', files = { 'index.html': 'hello', 'app.js': 'console.log(1)' } } = {}) {
  const entries = Object.entries(files).map(([path, c]) => ({ path, sha256: sha(Buffer.from(c)), size: Buffer.byteLength(c) }));
  const manifest = enc({ app: RELEASE_APP_ID, version, files: entries });
  const release = enc({ app: RELEASE_APP_ID, version, created: 'now', manifest_sha256: sha(manifest), file_count: entries.length });
  return { manifest, release, sig: await sign(priv, release), entries, files };
}

test('a good release verifies end to end', async () => {
  const k = await keypair();
  const r = await makeRelease(k.priv);
  const rel = await verifyReleaseSignature(r.release, r.sig, k.pub);
  const m = await verifyManifest(rel, r.manifest);
  for (const e of m.files) await verifyFile(e, Buffer.from(r.files[e.path]));
  assert.equal(rel.version, '1.0.0');
});

test('a tampered file is refused', async () => {
  const k = await keypair();
  const r = await makeRelease(k.priv);
  const rel = await verifyReleaseSignature(r.release, r.sig, k.pub);
  const m = await verifyManifest(rel, r.manifest);
  const e = m.files.find((f) => f.path === 'app.js');
  await assert.rejects(verifyFile(e, Buffer.from('console.log(2)')), (x) => x instanceof ReleaseError && x.code === 'file_mismatch');
  await assert.rejects(verifyFile(e, Buffer.from('console.log(1) ')), (x) => x.code === 'file_mismatch');
});

test('a bad signature is refused (edited release.json, garbage, truncated)', async () => {
  const k = await keypair();
  const r = await makeRelease(k.priv);
  const edited = Buffer.from(r.release.toString().replace('1.0.0', '9.9.9'));
  await assert.rejects(verifyReleaseSignature(edited, r.sig, k.pub), (x) => x.code === 'bad_signature');
  await assert.rejects(verifyReleaseSignature(r.release, 'AAAA', k.pub), (x) => x.code === 'bad_signature');
  await assert.rejects(verifyReleaseSignature(r.release, r.sig.slice(0, 40), k.pub), (x) => x.code === 'bad_signature');
});

test('a release signed by another key is refused', async () => {
  const good = await keypair();
  const evil = await keypair();
  const r = await makeRelease(evil.priv);
  await assert.rejects(verifyReleaseSignature(r.release, r.sig, good.pub), (x) => x.code === 'bad_signature');
});

test('the embedded key must be a public P-256 key', async () => {
  const k = await keypair();
  const r = await makeRelease(k.priv);
  await assert.rejects(verifyReleaseSignature(r.release, r.sig, { ...k.pub, crv: 'P-384' }), (x) => x.code === 'malformed');
  await assert.rejects(verifyReleaseSignature(r.release, r.sig, { ...k.pub, d: 'x' }), (x) => x.code === 'malformed');
});

test('manifest must hash to the signed value and be well formed', async () => {
  const k = await keypair();
  const r = await makeRelease(k.priv);
  const rel = await verifyReleaseSignature(r.release, r.sig, k.pub);
  const other = enc({ app: RELEASE_APP_ID, version: '1.0.0', files: [] });
  await assert.rejects(verifyManifest(rel, other), (x) => x.code === 'manifest_mismatch');
  for (const bad of ['../etc/passwd', '/abs', 'a b']) {
    const r2 = await makeRelease(k.priv, { files: { [bad]: 'x' } });
    const rel2 = await verifyReleaseSignature(r2.release, r2.sig, k.pub);
    await assert.rejects(verifyManifest(rel2, r2.manifest), (x) => x.code === 'malformed', bad);
  }
});

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
});

const here = dirname(fileURLToPath(import.meta.url));
const pwa = join(here, '..', '..');
// Only stat()ed below (its mode), never read: no test reads the release key.
const keyPath = process.env.CAMPFIRE_FIRO_RELEASE_KEY || join(homedir(), '.config', 'campfire-firo', 'pwa_release_key.jwk');
// BEAM Campfire's release key: this app must never be signed with it (nor trust it).
const BEAM_RELEASE_X = 'nHc0TAS1zffyZvN4tSmEyelt5vpEB-QDUEgHSNztzpc';

test("the committed public key is this app's own, not BEAM Campfire's", () => {
  const pub = JSON.parse(readFileSync(join(pwa, 'keys', 'release_public.jwk'), 'utf8'));
  assert.equal(pub.kty, 'EC');
  assert.equal(pub.crv, 'P-256');
  assert.notEqual(pub.x, BEAM_RELEASE_X);
  assert.equal(pub.d, undefined, 'no private part in the repository');
  assert.equal(RELEASE_APP_ID, 'campfire-firo-pwa');
});

test('the private release key is readable by its owner only', { skip: !existsSync(keyPath) && 'no release key on this machine' }, () => {
  assert.equal(statSync(keyPath).mode & 0o077, 0, 'mode 0600');
});

test('tools/build.mjs output verifies with the key it was signed with (a throwaway pair; never the release key)', { skip: SIGN_SKIP }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'campfire-build-'));
  const key = await throwawayKey();
  try {
    execFileSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', out, '--version', '0.0.7', '--quiet', ...key.args], { cwd: pwa });
    const pub = key.pub;
    const committed = JSON.parse(readFileSync(join(pwa, 'keys', 'release_public.jwk'), 'utf8'));
    await assert.rejects(verifyReleaseSignature(readFileSync(join(out, 'release.json')), readFileSync(join(out, 'release.sig'), 'utf8'), committed), (e) => e.code === 'bad_signature', 'a test build never passes for a release');
    const rel = await verifyReleaseSignature(readFileSync(join(out, 'release.json')), readFileSync(join(out, 'release.sig'), 'utf8'), pub);
    const m = await verifyManifest(rel, readFileSync(join(out, 'manifest.json')));
    for (const f of m.files) await verifyFile(f, readFileSync(join(out, f.path)));
    assert.equal(rel.version, '0.0.7');
    const versionJs = readFileSync(join(out, 'lib', 'version.js'), 'utf8');
    const loader = (versionJs.match(/LOADER = "(sw-[0-9a-f]{16}\.js)"/) || [])[1];
    assert.ok(loader, 'version.js names the loader');
    assert.equal(existsSync(join(out, 'sw.js')), false, 'no fixed-name sw.js: the loader is content-addressed');
    const sw = readFileSync(join(out, loader), 'utf8');
    assert.equal(createHash('sha256').update(sw).digest('hex').slice(0, 16), loader.slice(3, 19), 'the name is the hash of the bytes');
    assert.ok(m.files.some((f) => f.path === loader), 'the loader is in the signed manifest');
    assert.ok(sw.includes('async function verifyReleaseSignature'), 'release.js is inlined into the loader');
    assert.ok(sw.includes(pub.x), 'the public key is built into the loader');
    assert.ok(!sw.includes('0.0.7'), 'nothing release-specific in the loader');
    assert.ok(!/__[A-Z_]+__/.test(sw.replace(/__campfire_(state|install|server)/g, '')), 'no placeholders left');
    assert.ok(sw.includes('function normalizeServerAddress'), 'the own-server rules are inlined into the loader');
    assert.ok(!/^(export|import) /m.test(sw), 'the loader is a classic script');
    assert.equal(rel.app, 'campfire-firo-pwa');
    assert.ok(!m.files.some((f) => /^(vendor\/engine|shaders|dapp|node_probe)/.test(f.path)), 'nothing of the BEAM engine or dApps ships');
    assert.ok(!versionJs.includes('/*__') && !versionJs.includes('__LOADER__'));
    // Same loader code, other release: same name (a phone's registered loader URL never changes bytes).
    const out2 = mkdtempSync(join(tmpdir(), 'campfire-build-'));
    try {
      execFileSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', out2, '--version', '0.0.8', '--quiet', ...key.args], { cwd: pwa });
      assert.ok(existsSync(join(out2, loader)), 'a later release keeps the same loader name');
      assert.equal(readFileSync(join(out2, loader), 'utf8'), sw);
    } finally {
      rmSync(out2, { recursive: true, force: true });
    }
    const all = m.files.map((f) => readFileSync(join(out, f.path)).toString('latin1')).join('\n');
    assert.ok(!all.includes(key.d), 'the private key is not in the release');
  } finally {
    rmSync(out, { recursive: true, force: true });
    key.cleanup();
  }
});

test('a test key needs its own private half: --public without --key is refused before any key is read', { skip: SIGN_SKIP }, async () => {
  const key = await throwawayKey();
  const out = mkdtempSync(join(tmpdir(), 'campfire-build-'));
  try {
    const r = spawnSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', out, '--version', '0.0.7', '--quiet', '--public', key.args[3]], { cwd: pwa, encoding: 'utf8', env: { ...process.env, CAMPFIRE_FIRO_RELEASE_KEY: join(key.dir, 'no-such-key.jwk') } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--public needs --key/);
  } finally {
    rmSync(out, { recursive: true, force: true });
    key.cleanup();
  }
});
