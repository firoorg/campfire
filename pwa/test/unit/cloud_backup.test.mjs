// The optional copy in iCloud Drive (Settings -> Backup): where the file can go on each
// platform, and the words that say how. The copy is wallet.db re-keyed like Export wallet.db
// (covered by the e2e), so these check only what differs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudPlatform, CLOUD_MIN_PASSWORD } from '../../src/lib/export.js';
import { cloudText } from '../../src/screens/backup.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

test('where a saved file can reach the cloud: iPhone and iPad (a Mac with touch) share, a Mac downloads', () => {
  assert.equal(cloudPlatform({ userAgent: IPHONE, maxTouchPoints: 5 }), 'ios');
  assert.equal(cloudPlatform({ userAgent: IPAD, maxTouchPoints: 5 }), 'ios');
  assert.equal(cloudPlatform({ userAgent: IPAD, maxTouchPoints: 0 }), 'mac');
  assert.equal(cloudPlatform({ userAgent: ANDROID, maxTouchPoints: 5 }), 'other');
  assert.equal(cloudPlatform({ userAgent: WINDOWS, maxTouchPoints: 0 }), 'other');
  assert.equal(cloudPlatform({}), 'other');
  assert.equal(cloudPlatform(undefined), 'other');
});

test('a copy in the cloud needs a long password, and the words say why', () => {
  assert.ok(CLOUD_MIN_PASSWORD >= 12);
  for (const where of ['ios', 'mac', 'other']) {
    const t = cloudText(where);
    assert.match(t.lock, new RegExp(`at least ${CLOUD_MIN_PASSWORD} characters`));
    assert.match(t.lock, /AES-256/);
    assert.match(t.lead, /^Optional\./, 'never pushed: the card says it is optional');
    assert.match(t.lead, /Restore from a backup file/, 'and how the copy comes back');
    assert.ok(t.steps.length >= 2);
  }
});

test('iPhone: Save to Files, then iCloud Drive; Mac: Downloads, then Finder; elsewhere: no iCloud', () => {
  const ios = cloudText('ios');
  assert.equal(ios.title, 'Keep a copy in iCloud Drive');
  assert.equal(ios.save, 'Save to iCloud Drive');
  assert.ok(ios.steps.some((s) => /Save to Files/.test(s)) && ios.steps.some((s) => /iCloud Drive/.test(s)));
  assert.match(ios.done('shared'), /Files → iCloud Drive/);
  assert.match(ios.done('downloaded'), /downloads/);
  const mac = cloudText('mac');
  assert.equal(mac.title, 'Keep a copy in iCloud Drive');
  assert.ok(mac.steps.some((s) => /Finder/.test(s)));
  assert.match(mac.done('downloaded'), /Finder/);
  const other = cloudText('other');
  assert.equal(other.title, 'Keep a copy in your cloud storage');
  for (const s of [other.title, other.lead, other.lock, other.cta, other.save, ...other.steps, other.done('shared'), other.done('downloaded')]) {
    assert.ok(!/iCloud|Apple/.test(s), `no Apple words off Apple devices: ${s}`);
  }
});
