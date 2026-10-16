// Without the domain: the pure pieces (wording, progress) and the
// configuration that must agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastCheckText } from '../../src/lib/update.js';
import { progressLine, STALL_MS, SLOW_START_MS, NO_START_MS } from '../../src/screens/install.js';
import { persistenceText } from '../../src/lib/storage.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

test('"Last checked" line: never, up to date, ready, no update source', () => {
  const now = 1_800_000_000_000;
  assert.match(lastCheckText(null, now), /^Never checked\./);
  assert.equal(lastCheckText({ at: now - 5 * 60000, result: 'none' }, now), 'Last checked 5 min ago: you have the latest version.');
  assert.equal(lastCheckText({ at: now - 10_000, result: 'ready', version: '0.1.3' }, now), 'Last checked just now: version 0.1.3 is ready to install.');
  assert.equal(lastCheckText({ at: now - 3 * 3600_000, result: 'unreachable' }, now), 'Last checked 3 h ago: no update source was reachable; your app keeps working.');
  assert.equal(lastCheckText({ at: now - 4 * 86400_000, result: 'refused' }, now), 'Last checked 4 days ago: an update was refused.');
});

test('first-run progress line counts files and MB; before the signature check it says so', () => {
  assert.equal(progressLine(null), 'Starting setup…');
  assert.equal(progressLine({ state: 'checking', total: 0 }), 'Checking the release signature…');
  assert.equal(progressLine({ total: 64, done: 15, doneBytes: 7_512_345, totalBytes: 7_705_000 }), '15 of 64 files checked · 7.5 of 7.7 MB');
  assert.ok(STALL_MS >= 15000 && STALL_MS <= 60000, 'a stall is called after a reasonable quiet time');
  // Measured on the iOS Simulator: Safari took ~50 s to start the first service worker. Waiting for
  // that must never be called a stalled download.
  assert.ok(SLOW_START_MS >= 30000 && NO_START_MS >= 120000 && NO_START_MS > SLOW_START_MS);
});

test('storage wording', () => {
  assert.equal(persistenceText(true), 'kept');
  assert.equal(persistenceText(false), 'may be cleared by the system');
  assert.equal(persistenceText(null), 'unknown in this browser');
});

test('the installed app makes no request on its own: no update check at start, no explorer, no loader re-check', () => {
  // The wallet's own traffic is the engine's (ElectrumX over wss); nothing else is asked by the shell.
  const app = readFileSync(join(src, 'app.js'), 'utf8');
  assert.ok(!/updates\.check\(/.test(app), 'app.js does not check for updates by itself');
  assert.ok(!/register\(/.test(app), 'app.js does not register the service worker (lib/loader.js does, at first install)');
  const wallet = readFileSync(join(src, 'lib', 'wallet.js'), 'utf8');
  assert.ok(!/explorer\/status/.test(wallet), 'the wallet asks no explorer');
  const home = readFileSync(join(src, 'screens', 'home.js'), 'utf8');
  const about = readFileSync(join(src, 'screens', 'about.js'), 'utf8');
  for (const [name, text] of [['home', home], ['about', about]]) assert.ok(!/loaderCheck|fetch\(/.test(text), `${name} fetches nothing`);
  const sw = readFileSync(join(src, 'sw.js'), 'utf8');
  assert.ok(/status: 404/.test(sw), 'the worker answers unknown paths itself');
  assert.ok(!/__BUILD_VERSION__|SW_VERSION/.test(sw), 'the loader carries no release version, so its name is stable');
});

test('static splash: index.html shows the app before any script, with no inline script or style', () => {
  const html = readFileSync(join(src, 'index.html'), 'utf8');
  assert.match(html, /<div id="app"><main class="screen splash"/);
  assert.match(html, /Starting Firo PWA/);
  assert.ok(!/beam/i.test(html), 'nothing of BEAM is left');
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), 'no inline script');
  assert.ok(!/style=|<style/.test(html), 'no inline style (CSP style-src self)');
});
