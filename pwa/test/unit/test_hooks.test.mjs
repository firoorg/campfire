// The browser suites read the app through window.__campfire (src/app.js, between the
// <test-hooks> markers). A release has no use for it: tools/build.mjs leaves it out of builds with
// the real engine, keeps it in stand-in builds, and keeps it in a real one only on request
// (--test-hooks, for local checks; never published).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { throwawayKey, SIGN_SKIP } from './helpers/throwaway_key.mjs';

const pwa = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('src/app.js marks its test hooks once', () => {
  const src = readFileSync(join(pwa, 'src', 'app.js'), 'utf8');
  assert.equal(src.split('// <test-hooks>').length, 2);
  assert.equal(src.split('// </test-hooks>').length, 2);
  const block = src.slice(src.indexOf('// <test-hooks>'), src.indexOf('// </test-hooks>'));
  assert.match(block, /window\.__campfire = Object\.freeze\(/);
});

test('a real-engine build has no window.__campfire; a stand-in build and --test-hooks keep it', { skip: SIGN_SKIP }, async () => {
  const key = await throwawayKey();
  const tmp = mkdtempSync(join(tmpdir(), 'campfire-hooks-'));
  const appOf = (out, ...args) => {
    execFileSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', join(tmp, out), '--version', '0.0.3', '--quiet', ...key.args, ...args], { cwd: pwa, stdio: ['ignore', 'ignore', 'pipe'] });
    return readFileSync(join(tmp, out, 'app.js'), 'utf8');
  };
  try {
    const real = appOf('real');
    assert.ok(!real.includes('window.__campfire'), 'no hooks in a release');
    assert.ok(!real.includes('<test-hooks>'));
    assert.match(real, /boot\(\)\.catch/, 'the rest of app.js is there');
    assert.ok(appOf('fake', '--engine', 'fake').includes('window.__campfire = Object.freeze('));
    assert.ok(appOf('local', '--test-hooks').includes('window.__campfire = Object.freeze('));
    const r = spawnSync(process.execPath, [join(pwa, 'tools', 'build.mjs'), '--out', join(tmp, 'pub'), '--version', '0.0.3', '--quiet', ...key.args, '--published', join(tmp, 'published.json'), '--test-hooks', '--publish'], { cwd: pwa, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--test-hooks/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    key.cleanup();
  }
});
