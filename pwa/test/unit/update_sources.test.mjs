// Update sources: the order they are asked in, the address a person adds, and
// the rules every source is held to (lib/update_sources.js, run by the loader).
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SOURCES, normalizeSource, updateSources, releaseSources, loaderCompatible, readRelease, findUpdate, createdOf, MAX_ADDED_SOURCES } from '../../src/lib/update_sources.js';
import { ReleaseError, RELEASE_APP_ID, verifyFile } from '../../src/lib/release.js';
import { lastCheckText, refusalText, releaseDate, staleRelease, ownServesInstalled } from '../../src/lib/update.js';
import { progressText, triedText } from '../../src/lib/update_ui.js';
import { throwawayKey, SIGN_SKIP } from './helpers/throwaway_key.mjs';

const OWN = 'https://wallet.example.org/';

// ---------------------------------------------------------------- the list
test('built-in copies: https folders of the public release, freshest first', () => {
  assert.deepEqual([...BUILTIN_SOURCES], [
    'https://raw.githubusercontent.com/vsnation/campfire-firo-pwa/release/',
    'https://vsnation.github.io/campfire-firo-pwa/',
    'https://cdn.jsdelivr.net/gh/vsnation/campfire-firo-pwa@release/',
  ]);
  for (const s of BUILTIN_SOURCES) assert.equal(normalizeSource(s).url, s, 'already normal');
  assert.throws(() => BUILTIN_SOURCES.push('x'), 'frozen');
});

test('order: own address, then the copies, then the added address; each once', () => {
  const s = updateSources({ own: OWN, added: ['https://copy.example.net/campfire'] });
  assert.deepEqual(s.map((x) => [x.kind, x.url]), [
    ['own', OWN],
    ...BUILTIN_SOURCES.map((u) => ['builtin', u]),
    ['added', 'https://copy.example.net/campfire/'],
  ]);
  assert.equal(s[0].own, true);
  assert.ok(s.slice(1).every((x) => x.own === false));
  assert.equal(s[1].host, 'raw.githubusercontent.com');
  // Installed from GitHub Pages: that copy is the own address, asked once, first.
  const pages = updateSources({ own: 'https://vsnation.github.io/campfire-firo-pwa/', added: ['vsnation.github.io/campfire-firo-pwa/index.html', 'https://raw.githubusercontent.com/vsnation/campfire-firo-pwa/release/'] });
  assert.deepEqual(pages.map((x) => x.kind), ['own', 'builtin', 'builtin']);
  assert.equal(pages.filter((x) => x.host === 'vsnation.github.io').length, 1);
  // The release's own list replaces the built-in one; bad entries and extra added ones are dropped.
  const custom = updateSources({ own: OWN, builtins: ['https://m.example/', 'http://insecure.example/'], added: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'] });
  assert.deepEqual(custom.map((x) => x.url), [OWN, 'https://m.example/', 'https://a.example/', 'https://b.example/', 'https://c.example/']);
  assert.equal(MAX_ADDED_SOURCES, 3);
});

test('a release names its own list (signed); missing means none named', () => {
  assert.equal(releaseSources({}), null);
  assert.deepEqual(releaseSources({ update_sources: [] }), []);
  assert.deepEqual(releaseSources({ update_sources: ['https://m.example/x', 'https://m.example/x/', 'ftp://no', 42] }), ['https://m.example/x/']);
  assert.equal(releaseSources({ update_sources: Array.from({ length: 30 }, (_, i) => `https://m${i}.example/`) }).length, 10);
});

// ---------------------------------------------------------------- an added address
test('an added address: https only, no credentials, a folder with a trailing slash', () => {
  const ok = (input, url) => assert.deepEqual(normalizeSource(input), { ok: true, url }, input);
  ok('https://copy.example.net/campfire', 'https://copy.example.net/campfire/');
  ok('  https://copy.example.net/campfire/  ', 'https://copy.example.net/campfire/');
  ok('copy.example.net/campfire', 'https://copy.example.net/campfire/');
  ok('copy.example.net', 'https://copy.example.net/');
  ok('copy.example.net:8443/x', 'https://copy.example.net:8443/x/');
  ok('HTTPS://Copy.Example.NET/A', 'https://copy.example.net/A/');
  ok('https://copy.example.net/campfire/index.html', 'https://copy.example.net/campfire/');
  ok('https://copy.example.net/campfire/release.json', 'https://copy.example.net/campfire/');
  ok('https://copy.example.net/campfire/?utm=1#top', 'https://copy.example.net/campfire/');
  ok('https://xn--bcher-kva.example/', 'https://xn--bcher-kva.example/');
  const bad = (input, re) => {
    const r = normalizeSource(input);
    assert.equal(r.ok, false, input);
    assert.match(r.reason, re, input);
  };
  bad('', /Paste the address/);
  bad('   ', /Paste the address/);
  bad(null, /Paste the address/);
  bad('http://copy.example.net/campfire/', /https:\/\//);
  bad('ftp://copy.example.net/', /https:\/\//);
  bad('javascript:alert(1)', /isn't a web address|https/);
  bad('data:text/html,hi', /isn't a web address|https/);
  bad('https://user:secret@copy.example.net/', /user name and password/);
  bad('https://user@copy.example.net/', /user name and password/);
  bad(`https://copy.example.net/${'a'.repeat(2100)}`, /too long/);
  bad('https://', /isn't a web address/);
  bad('https:// spaced.example/', /isn't a web address/);
});

// ---------------------------------------------------------------- the loader a release needs
test('a release from another copy must run under the loader that is running now', () => {
  const me = { name: 'sw-aaaaaaaaaaaaaaaa.js', compat: 'c1' };
  assert.equal(loaderCompatible({ loader: 'sw-aaaaaaaaaaaaaaaa.js', loader_compat: 'zz' }, me), true, 'the same loader');
  assert.equal(loaderCompatible({ loader: 'sw-bbbbbbbbbbbbbbbb.js', loader_compat: 'c1' }, me), true, 'another loader that serves pages the same way');
  assert.equal(loaderCompatible({ loader: 'sw-bbbbbbbbbbbbbbbb.js', loader_compat: 'c2' }, me), false, 'another loader that serves pages differently');
  assert.equal(loaderCompatible({ loader: 'sw-bbbbbbbbbbbbbbbb.js' }, me), false, 'no compat value: not provably the same');
  assert.equal(loaderCompatible({}, me), false, 'a release that names no loader');
  assert.equal(loaderCompatible({ loader: 'sw-bbbbbbbbbbbbbbbb.js', loader_compat: 'c1' }, { name: 'sw-x.js', compat: null }), false, 'a loader that knows no compat value');
});

// ---------------------------------------------------------------- reading a release (real signatures)
const s = webcrypto.subtle;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const enc = (o) => Buffer.from(JSON.stringify(o));

async function signer() {
  const k = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await s.exportKey('jwk', k.publicKey);
  return { priv: k.privateKey, pub: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y } };
}

async function signedRelease(priv, { version = '1.0.1', app = RELEASE_APP_ID, files = { 'index.html': 'hello', 'app.js': 'console.log(1)' } } = {}) {
  const entries = Object.entries(files).map(([path, c]) => ({ path, sha256: sha(Buffer.from(c)), size: Buffer.byteLength(c) }));
  const manifest = enc({ app, version, files: entries });
  const release = enc({ app, version, created: 'now', manifest_sha256: sha(manifest), file_count: entries.length, loader: 'sw-aaaaaaaaaaaaaaaa.js', loader_compat: 'c1' });
  const sig = Buffer.from(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, release)).toString('base64');
  return { 'release.json': release, 'release.sig': Buffer.from(sig), 'manifest.json': manifest, files };
}

const getter = (served) => async (path) => {
  if (!(path in served)) throw new ReleaseError('unreachable', `${path}: HTTP 404`);
  return new Uint8Array(served[path]);
};

test('reading a release: signed and matching -> the release; not this app, unsigned, edited or a web page -> refused or "no release here"', async () => {
  const k = await signer();
  const good = await signedRelease(k.priv);
  const { release, manifest } = await readRelease(getter(good), k.pub);
  assert.equal(release.version, '1.0.1');
  assert.equal(manifest.files.length, 2);

  // Another app's release (even well signed): nothing for this app here.
  const other = await signedRelease(k.priv, { app: 'some-other-app' });
  await assert.rejects(readRelease(getter(other), k.pub), (e) => e.code === 'unreachable');
  // A parking page or an error page where release.json should be.
  await assert.rejects(readRelease(getter({ 'release.json': Buffer.from('<!doctype html><h1>For sale</h1>') }), k.pub), (e) => e.code === 'unreachable');
  // Signed by someone else.
  const evil = await signer();
  const forged = await signedRelease(evil.priv, { version: '9.9.9' });
  await assert.rejects(readRelease(getter(forged), k.pub), (e) => e.code === 'bad_signature');
  // Version edited after signing.
  const edited = { ...good, 'release.json': Buffer.from(good['release.json'].toString().replace('1.0.1', '1.0.2')) };
  await assert.rejects(readRelease(getter(edited), k.pub), (e) => e.code === 'bad_signature');
  // A file list that is not the signed one.
  const swapped = { ...good, 'manifest.json': (await signedRelease(k.priv, { files: { 'index.html': 'evil' } }))['manifest.json'] };
  await assert.rejects(readRelease(getter(swapped), k.pub), (e) => e.code === 'manifest_mismatch');
  // No signature file.
  const { 'release.sig': _sig, ...noSig } = good;
  await assert.rejects(readRelease(getter(noSig), k.pub), (e) => e.code === 'unreachable');
});

// ---------------------------------------------------------------- choosing a source
const ME = { name: 'sw-aaaaaaaaaaaaaaaa.js', compat: 'c1' };
const INSTALLED = { version: '1.0.0', manifestSha: 'm100' };

function rel(version, { manifestSha = `m${version.replace(/\./g, '')}`, loader = ME.name, compat = ME.compat } = {}) {
  return { release: { app: RELEASE_APP_ID, version, manifest_sha256: manifestSha, loader, loader_compat: compat }, manifest: { files: [] } };
}

/**
 * A world of sources: each answers with a release, or throws. Counts what was
 * asked and what was staged.
 */
function world(answers, { stageFails = {} } = {}) {
  const asked = [];
  const staged = [];
  const sources = updateSources({ own: OWN, builtins: ['https://m1.example/', 'https://m2.example/'], added: ['https://added.example/'] });
  return {
    sources,
    asked,
    staged,
    fetchRelease: async (src) => {
      asked.push(src.host);
      const a = answers[src.host];
      if (a === undefined || a === 'down') throw new ReleaseError('unreachable', `Could not download release.json from ${src.host}.`);
      if (a === 'nocors') throw new TypeError('Failed to fetch');
      if (a instanceof Error) throw a;
      return a;
    },
    stage: async (src, r) => {
      if (stageFails[src.host]) throw stageFails[src.host];
      staged.push([src.host, r.release.version]);
    },
  };
}

const run = (w, extra = {}) => findUpdate({ sources: w.sources, installed: INSTALLED, loader: ME, fetchRelease: w.fetchRelease, stage: w.stage, ...extra });

test('every source is asked; the newest signed release wins, and on a tie the own address', async () => {
  // A tie: the own address's copy, even though a copy answered too.
  const tie = world({ 'wallet.example.org': rel('1.0.1'), 'm1.example': rel('1.0.1') });
  const r = await run(tie);
  assert.equal(r.result, 'ready');
  assert.deepEqual(r.from, { host: 'wallet.example.org', own: true });
  assert.deepEqual(tie.asked, ['wallet.example.org', 'm1.example', 'm2.example', 'added.example'], 'all of them, in order');
  assert.deepEqual(tie.staged, [['wallet.example.org', '1.0.1']]);
  assert.deepEqual(r.tried.map((t) => [t.host, t.outcome]), [['wallet.example.org', 'ready'], ['m1.example', 'not_needed'], ['m2.example', 'unreachable'], ['added.example', 'unreachable']]);
  // Up to date everywhere: "none", confirmed by the own address.
  const current = world({ 'wallet.example.org': rel('1.0.0'), 'm1.example': rel('1.0.0') });
  const r2 = await run(current);
  assert.equal(r2.result, 'none');
  assert.deepEqual(r2.from, { host: 'wallet.example.org', own: true });
  assert.equal(r2.ownVersion, '1.0.0');
  // Newer at a copy than at the own address: the copy's (a frozen address cannot hold the app back).
  const frozen = world({ 'wallet.example.org': rel('1.0.0'), 'm1.example': rel('1.0.1'), 'm2.example': rel('1.0.2') });
  const r3 = await run(frozen);
  assert.equal(r3.result, 'ready');
  assert.equal(r3.version, '1.0.2');
  assert.deepEqual(r3.from, { host: 'm2.example', own: false });
  assert.deepEqual(frozen.staged, [['m2.example', '1.0.2']]);
  assert.equal(r3.ownVersion, '1.0.0', 'what the own address served is reported');
});

test('the own address is gone: the newest signed release among the copies is used', async () => {
  const w = world({ 'm1.example': rel('1.0.1'), 'm2.example': rel('1.0.2') });
  const r = await run(w);
  assert.equal(r.result, 'ready');
  assert.equal(r.version, '1.0.2');
  assert.deepEqual(r.from, { host: 'm2.example', own: false });
  assert.deepEqual(w.asked, ['wallet.example.org', 'm1.example', 'm2.example', 'added.example']);
  assert.deepEqual(w.staged, [['m2.example', '1.0.2']]);
  assert.deepEqual(r.tried.map((t) => [t.host, t.outcome]), [['wallet.example.org', 'unreachable'], ['m1.example', 'not_needed'], ['m2.example', 'ready'], ['added.example', 'unreachable']]);
  // The newest cannot be had intact anywhere: the next newer one is still an update.
  const broken = new ReleaseError('file_mismatch', 'A file in this update (app.js) is not the one that was signed.');
  const w2 = world({ 'm1.example': rel('1.0.1'), 'm2.example': rel('1.0.2') }, { stageFails: { 'm2.example': broken } });
  const r2 = await run(w2);
  assert.equal(r2.result, 'ready');
  assert.equal(r2.version, '1.0.1');
  assert.equal(r2.tried[2].outcome, 'refused');
});

test('a newer release that cannot be had intact is not "up to date", even when the own address confirms the installed one', async () => {
  const broken = new ReleaseError('file_mismatch', 'A file in this update (app.js) is not the one that was signed.');
  const w = world({ 'wallet.example.org': rel('1.0.0'), 'm1.example': rel('1.0.1') }, { stageFails: { 'm1.example': broken } });
  const r = await run(w);
  assert.equal(r.result, 'refused');
  assert.deepEqual(r.from, { host: 'm1.example', own: false });
  assert.equal(r.ownVersion, '1.0.0');
  // A copy that sends something unsigned does not override a confirmed "up to date".
  const forged = world({ 'wallet.example.org': rel('1.0.0'), 'm1.example': new ReleaseError('bad_signature', 'This update is not signed with the Campfire release key.') });
  assert.equal((await run(forged)).result, 'none');
});

test('release dates: the newest signed release anyone knows of, with its date', async () => {
  const dated = (v, created) => {
    const r = rel(v);
    r.release.created = created;
    return r;
  };
  const w = world({ 'wallet.example.org': dated('1.0.0', '2026-01-02T00:00:00.000Z'), 'm1.example': dated('0.9.0', '2025-06-01T00:00:00.000Z') });
  const r = await findUpdate({ sources: w.sources, installed: { ...INSTALLED, created: null }, loader: ME, fetchRelease: w.fetchRelease, stage: w.stage });
  assert.equal(r.result, 'none');
  assert.deepEqual(r.newest, { version: '1.0.0', created: '2026-01-02T00:00:00.000Z' });
  // Nothing answered: what the installed copy knows.
  const r2 = await findUpdate({ sources: world({}).sources, installed: { ...INSTALLED, created: '2025-12-01T00:00:00.000Z' }, loader: ME, fetchRelease: world({}).fetchRelease, stage: async () => {} });
  assert.deepEqual(r2.newest, { version: '1.0.0', created: '2025-12-01T00:00:00.000Z' });
  // A newer one staged: its date.
  const w3 = world({ 'm1.example': dated('1.0.1', '2026-03-01T00:00:00.000Z') });
  const r3 = await run(w3);
  assert.equal(r3.created, '2026-03-01T00:00:00.000Z');
  assert.deepEqual(r3.newest, { version: '1.0.1', created: '2026-03-01T00:00:00.000Z' });
  // Not a date: ignored.
  assert.equal(createdOf({ created: 'now' }), null);
  assert.equal(createdOf({}), null);
});

test('no CORS, no release, another app, a broken signature: noted, and the next source is asked', async () => {
  const w = world({ 'wallet.example.org': 'nocors', 'm1.example': new ReleaseError('bad_signature', 'This update is not signed with the Campfire release key.'), 'm2.example': new ReleaseError('unreachable', 'No Campfire release is published at this address.'), 'added.example': rel('1.0.3') });
  const r = await run(w);
  assert.equal(r.result, 'ready');
  assert.equal(r.version, '1.0.3');
  assert.deepEqual(r.from, { host: 'added.example', own: false });
  assert.deepEqual(r.tried.map((t) => t.outcome), ['unreachable', 'refused', 'unreachable', 'ready']);
});

test('a tampered file at a copy: nothing from it is kept as a release; the next copy is asked', async () => {
  const tampered = new ReleaseError('file_mismatch', 'A file in this update (app.js) is not the one that was signed.');
  const w = world({ 'm1.example': rel('1.0.1'), 'm2.example': rel('1.0.1') }, { stageFails: { 'm1.example': tampered } });
  const r = await run(w);
  assert.equal(r.result, 'ready');
  assert.deepEqual(r.from, { host: 'm2.example', own: false });
  assert.deepEqual(w.staged, [['m2.example', '1.0.1']]);
  assert.equal(r.tried[1].outcome, 'refused');
  assert.match(r.tried[1].reason, /app\.js/);
  // Only that copy: refused, the reason names the file and the copy.
  const w2 = world({ 'm1.example': rel('1.0.1') }, { stageFails: { 'm1.example': tampered } });
  const r2 = await run(w2);
  assert.equal(r2.result, 'refused');
  assert.deepEqual(r2.from, { host: 'm1.example', own: false });
  assert.equal(refusalText(r2), 'From the copy at m1.example: A file in this update (app.js) is not the one that was signed.');
  assert.deepEqual(w2.staged, []);
  // The real check behind stage(): one byte off, refused.
  await assert.rejects(verifyFile({ path: 'app.js', size: 3, sha256: sha(Buffer.from('abc')) }, Buffer.from('abd')), (e) => e.code === 'file_mismatch');
});

test('downgrades and look-alikes are never staged: older is "up to date", the same version with other files is refused', async () => {
  const w = world({ 'm1.example': rel('0.9.9'), 'm2.example': rel('1.0.0') });
  const r = await run(w);
  assert.equal(r.result, 'none', 'the same version: up to date');
  assert.deepEqual(r.tried.map((t) => t.outcome), ['unreachable', 'older', 'same', 'unreachable']);
  const older = world({ 'wallet.example.org': rel('0.1.0'), 'm1.example': rel('0.9.0') });
  const r2 = await run(older);
  assert.equal(r2.result, 'none', 'only older releases anywhere: nothing newer, up to date');
  assert.deepEqual(older.staged, []);
  const lookalike = world({ 'm1.example': rel('1.0.0', { manifestSha: 'other' }), 'm2.example': rel('1.0.0') });
  const r3 = await run(lookalike);
  assert.equal(r3.result, 'none');
  assert.equal(r3.tried[1].outcome, 'refused');
  assert.match(r3.tried[1].reason, /different release claims version 1\.0\.0/);
  const onlyLookalike = world({ 'm1.example': rel('1.0.0', { manifestSha: 'other' }) });
  assert.equal((await run(onlyLookalike)).result, 'refused');
});

test('nothing answers: unreachable, every source named in order', async () => {
  const w = world({});
  const r = await run(w);
  assert.equal(r.result, 'unreachable');
  assert.deepEqual(r.tried.map((t) => t.host), ['wallet.example.org', 'm1.example', 'm2.example', 'added.example']);
  assert.equal(triedText(r.tried), "Asked: this app's address, m1.example, m2.example and added.example.");
});

test('a release whose loader the running one cannot stand in for comes only from the own address', async () => {
  const newLoader = rel('1.0.1', { loader: 'sw-bbbbbbbbbbbbbbbb.js', compat: 'c2' });
  const w = world({ 'm1.example': newLoader, 'm2.example': newLoader });
  const r = await run(w);
  assert.equal(r.result, 'needs_own_address');
  assert.equal(r.version, '1.0.1');
  assert.deepEqual(w.staged, [], 'not even downloaded from a copy');
  const own = world({ 'wallet.example.org': newLoader });
  const r2 = await run(own);
  assert.equal(r2.result, 'ready', 'from the own address it stages (its loader comes along)');
  // A new loader that serves pages the same way: fine from a copy.
  const same = world({ 'm1.example': rel('1.0.1', { loader: 'sw-bbbbbbbbbbbbbbbb.js', compat: 'c1' }) });
  assert.equal((await run(same)).result, 'ready');
  // A refusal elsewhere does not hide that a newer release exists.
  const mixed = world({ 'm1.example': new ReleaseError('bad_signature', 'x'), 'm2.example': newLoader });
  assert.equal((await run(mixed)).result, 'needs_own_address');
  // The own address still serves the installed release: newer exists, only from there; and the page may move to its loader.
  const lagging = world({ 'wallet.example.org': rel('1.0.0'), 'm1.example': newLoader });
  const r3 = await run(lagging);
  assert.equal(r3.result, 'needs_own_address');
  assert.equal(r3.ownVersion, '1.0.0');
  assert.equal(ownServesInstalled(r3), true);
  assert.equal(ownServesInstalled(await run(world({ 'm1.example': rel('1.0.0') }))), false, 'only a copy confirmed it');
});

test('dates and age, in words', () => {
  assert.equal(releaseDate('2026-10-12T13:37:18.197Z'), '12 Oct 2026');
  assert.equal(releaseDate('soon'), null);
  const now = Date.parse('2026-10-12T00:00:00.000Z');
  assert.equal(staleRelease('2026-06-01T00:00:00.000Z', now), null, 'four months: fine');
  assert.deepEqual(staleRelease('2026-01-02T00:00:00.000Z', now), { date: '2 Jan 2026', months: 9 });
  assert.equal(staleRelease(null, now), null);
  assert.equal(lastCheckText({ at: now, result: 'none', created: '2026-10-12T13:37:18.197Z' }, now), 'Last checked just now: you have the latest version, released 12 Oct 2026.');
  assert.equal(lastCheckText({ at: now, result: 'none' }, now), 'Last checked just now: you have the latest version.');
  assert.equal(progressText({ step: 'asking', total: 4, answered: 0 }), 'Looking for the newest version in 4 places…');
  assert.equal(progressText({ step: 'asking', total: 4, answered: 2 }), 'Looking for the newest version: 2 of 4 places checked');
  assert.equal(progressText({ step: 'asking', total: 1, answered: 0 }), "Asking this app's address…");
});

test('an update already verified is offered again without a download', async () => {
  const w = world({ 'm1.example': rel('1.0.1') });
  const r = await run(w, { pending: { version: '1.0.1', manifestSha: 'm101', from: { host: 'm2.example', own: false } } });
  assert.equal(r.result, 'ready');
  assert.deepEqual(w.staged, []);
  assert.deepEqual(r.from, { host: 'm2.example', own: false }, 'named after where its bytes came from');
});

test('progress and result wording', async () => {
  assert.equal(progressText({ step: 'checking', host: 'x', own: true }), "Asking this app's address…");
  assert.equal(progressText({ step: 'checking', host: 'cdn.jsdelivr.net', own: false }), 'Asking a copy at cdn.jsdelivr.net…');
  assert.equal(progressText({ step: 'downloading', host: 'cdn.jsdelivr.net', own: false, version: '0.1.9', done: 40, total: 203 }), 'Downloading 0.1.9 from a copy at cdn.jsdelivr.net: 40 of 203 files checked');
  const now = 1_800_000_000_000;
  assert.equal(lastCheckText({ at: now, result: 'ready', version: '0.1.9', host: 'cdn.jsdelivr.net' }, now), 'Last checked just now: version 0.1.9 is ready to install (from a copy at cdn.jsdelivr.net).');
  assert.equal(lastCheckText({ at: now, result: 'applied', version: '0.1.9', host: 'cdn.jsdelivr.net' }, now), "Last checked just now: updated to 0.1.9 from a copy at cdn.jsdelivr.net, checked against Firo PWA's signature.");
  assert.equal(lastCheckText({ at: now, result: 'applied', version: '0.1.9', host: null }, now), "Last checked just now: updated to 0.1.9, checked against Firo PWA's signature.");
  assert.equal(lastCheckText({ at: now, result: 'needs_own_address', version: '0.2.0' }, now), "Last checked just now: version 0.2.0 needs this app's address to install; your app keeps working.");
  assert.equal(refusalText({ reason: 'This update is not signed with the Campfire release key.', from: { host: 'wallet.example.org', own: true } }), 'This update is not signed with the Campfire release key.');
});

// ---------------------------------------------------------------- the build writes it down
const here = dirname(fileURLToPath(import.meta.url));
const pwa = join(here, '..', '..');

test('the build signs the loader, its compat value and the sources into release.json; --mirrors changes only the release', { skip: SIGN_SKIP }, async () => {
  const dirs = [];
  const key = await throwawayKey();
  const build = (...args) => {
    const out = mkdtempSync(join(tmpdir(), 'campfire-src-'));
    dirs.push(out);
    execFileSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', out, '--version', '0.0.9', '--quiet', ...key.args, ...args], { cwd: pwa, stdio: ['ignore', 'ignore', 'pipe'] });
    const release = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'));
    const loader = readFileSync(join(out, 'lib', 'version.js'), 'utf8').match(/LOADER = "(sw-[0-9a-f]{16}\.js)"/)[1];
    return { out, release, loader, sw: readFileSync(join(out, loader), 'utf8') };
  };
  try {
    const a = build();
    assert.equal(a.release.loader, a.loader);
    assert.match(a.release.loader_compat, /^[0-9a-f]{64}$/);
    assert.deepEqual(a.release.update_sources, [...BUILTIN_SOURCES]);
    assert.ok(a.sw.includes(`const LOADER_COMPAT = ${JSON.stringify(a.release.loader_compat)};`), 'the loader carries its own compat value');
    assert.ok(readFileSync(join(a.out, 'lib', 'version.js'), 'utf8').includes(`export const LOADER_COMPAT = ${JSON.stringify(a.release.loader_compat)};`), 'the pages know their release loader\'s compat value');
    assert.match(a.sw, /compat: LOADER_COMPAT,/, 'and the loader tells pages its own (status)');
    assert.ok(a.sw.includes('async function findUpdate') && a.sw.includes('const BUILTIN_SOURCES'), 'lib/update_sources.js is inlined');
    assert.ok(!/^import /m.test(a.sw), 'no import left in the loader');
    const b = build('--mirrors', 'https://mirror.test:8812/,https://mirror2.test:8813/');
    assert.deepEqual(b.release.update_sources, ['https://mirror.test:8812/', 'https://mirror2.test:8813/']);
    assert.equal(b.loader, a.loader, 'the list travels in the signed release; the loader is unchanged');
    assert.deepEqual(build('--mirrors', 'none').release.update_sources, []);
    const c = build('--loader-note', 'test build');
    assert.notEqual(c.loader, a.loader, 'other loader bytes, other name');
    assert.equal(c.release.loader_compat, a.release.loader_compat, '... serving pages the same way');
    // One above the loader's own (sw.js LOADER_API).
    const api = Number(readFileSync(join(pwa, 'src', 'sw.js'), 'utf8').match(/const LOADER_API = \/\*__LOADER_API__\*\/ (\d+);/)[1]);
    const d = build('--loader-api', String(api + 1));
    assert.notEqual(d.release.loader_compat, a.release.loader_compat, 'another page <-> loader contract: another compat value');
    assert.throws(() => build('--mirrors', 'http://insecure.test/'));
  } finally {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    key.cleanup();
  }
});

