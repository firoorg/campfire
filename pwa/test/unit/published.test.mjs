// One version, one build: tools/build.mjs refuses to sign a version deploy/published.json lists
// with another manifest, and --publish records the build it makes (tools/published.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePublished, publishedConflict, withPublished, renderPublished } from '../../tools/published.mjs';
import { compareVersions } from '../../src/lib/release.js';
import { throwawayKey, SIGN_SKIP } from './helpers/throwaway_key.mjs';

const pwa = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('a listed version signs only with its own manifest; a new version or the same build is fine', () => {
  const p = parsePublished(renderPublished({ releases: { '0.1.0': { manifest_sha256: A, created: '2026-10-12T13:37:18.197Z' } } }));
  assert.equal(publishedConflict(p, { version: '0.1.0', manifest_sha256: A }), null, 'the same build again');
  assert.equal(publishedConflict(p, { version: '0.1.1', manifest_sha256: B }), null, 'a new version');
  assert.match(publishedConflict(p, { version: '0.1.0', manifest_sha256: B }), /version 0\.1\.0 was already published as another build \(manifest aaaaaaaaaaaaaaaa…, 2026-10-12T13:37:18\.197Z\).*Raise "version"/);
  const next = withPublished(p, { version: '0.1.1', manifest_sha256: B, created: 'now', loader: 'sw-x.js', file_count: 3 });
  assert.deepEqual(next.releases['0.1.1'], { manifest_sha256: B, created: 'now', loader: 'sw-x.js', file_count: 3 });
  assert.equal(withPublished(next, { version: '0.1.1', manifest_sha256: B, created: 'later' }), next, 'recording the same build twice changes nothing');
  assert.throws(() => withPublished(p, { version: '0.1.0', manifest_sha256: B }), /already published/);
  assert.deepEqual(parsePublished('').releases, {}, 'no file yet: nothing published');
  assert.throws(() => parsePublished('{"releases":{"0.1":{"manifest_sha256":"x"}}}'), /bad entry/);
});

test('the committed list has the release on the web (0.1.0) and package.json has moved past it', () => {
  const p = parsePublished(readFileSync(join(pwa, 'deploy', 'published.json'), 'utf8'));
  // pwa.buyfiro.app's release.json on 2026-10-12 (audit E: verified against the live files).
  assert.equal(p.releases['0.1.0'].manifest_sha256, '33e479fa1a5e0ca131e3961038e3922cc441ec90a84067ca4ad6596b9041158e');
  const pkg = JSON.parse(readFileSync(join(pwa, 'package.json'), 'utf8'));
  assert.equal(compareVersions(pkg.version, '0.1.0'), 1, 'two different 0.1.0 builds exist: the next release has its own number');
  const lock = JSON.parse(readFileSync(join(pwa, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('the build refuses a listed version with other contents, and --publish records what it built', { skip: SIGN_SKIP }, async () => {
  const key = await throwawayKey();
  const tmp = mkdtempSync(join(tmpdir(), 'campfire-published-'));
  const list = join(tmp, 'published.json');
  const build = (out, ...args) => spawnSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', join(tmp, out), '--version', '0.0.4', '--quiet', ...key.args, '--published', list, ...args], { cwd: pwa, encoding: 'utf8' });
  try {
    writeFileSync(list, renderPublished({ releases: { '0.0.4': { manifest_sha256: A, created: '2026-01-01T00:00:00.000Z' } } }));
    const refused = build('a');
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /version 0\.0\.4 was already published as another build/);
    assert.throws(() => readFileSync(join(tmp, 'a', 'release.sig')), 'nothing signed');
    // A version not listed: built; --publish records it.
    writeFileSync(list, renderPublished({ releases: {} }));
    const ok = build('b', '--publish');
    assert.equal(ok.status, 0, ok.stderr);
    const rel = JSON.parse(readFileSync(join(tmp, 'b', 'release.json'), 'utf8'));
    const p = parsePublished(readFileSync(list, 'utf8'));
    assert.deepEqual(p.releases['0.0.4'], { manifest_sha256: rel.manifest_sha256, created: rel.created, loader: rel.loader, file_count: rel.file_count });
    // The same sources again: the same manifest, allowed; another build of 0.0.4: refused.
    assert.equal(build('c').status, 0);
    assert.equal(build('d', '--mirrors', 'none').status, 0, 'the mirror list is in release.json, not the manifest: the same build');
    const changed = build('e', '--loader-note', 'another build');
    assert.notEqual(changed.status, 0, 'other bytes under a published version: refused');
    assert.match(changed.stderr, /already published as another build/);
    assert.equal(JSON.parse(readFileSync(list, 'utf8')).releases['0.0.4'].manifest_sha256, rel.manifest_sha256, 'the list is unchanged');
    const stand = build('f', '--engine', 'fake', '--publish');
    assert.notEqual(stand.status, 0, 'a stand-in build is never published');
    assert.match(stand.stderr, /--publish/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    key.cleanup();
  }
});
