// Without the domain, end to end: the installed Google Chrome (headless), ONE
// persistent browser profile restarted cold between steps, and a test server for
// the app's web address that can be switched to every way a domain dies. The
// engine is the stand-in (lib/backend_fake.js, chosen by lib/chain.js), so no
// Firo server is needed and nothing is spent.
//
//   npm run e2e:offline
//
// The address is http://campfire.test:8793/ (Chrome maps the name with
// --host-resolver-rules and treats it as a secure origin), so it can also be
// made unresolvable. The test server counts every request it receives.
//
// 1. First run: the static splash, then live progress; the server dies midway;
//    setup says so; nothing partial is served; on reopen setup RESUMES (files
//    already verified are not downloaded again) and completes.
// 2. Installed, address alive: create a wallet, sync. Zero requests reach the
//    address except the browser's own loader probe.
// 3. For each of: server stopped (connection refused), name unresolvable,
//    404 for everything, a 200 HTML parking page for everything:
//    cold start -> unlock -> Synced -> save the encrypted backup file -> delete
//    -> restore from that file (the same wallet) -> Synced -> delete -> create a
//    new wallet -> Synced. Zero requests reached the address except loader
//    probes. For 404 / 5xx / parking: the browser's update of the loader fails
//    and the installed loader and its copy stay. "Check for updates" says no
//    update source is reachable; the app works. The public copies of the
//    release (lib/update_sources.js) are made unresolvable in this browser: the
//    tapped check asks each of them for release.json, after the address, and
//    nothing else.
// 4. Hostile takeover: the address serves different loader code (200, valid
//    JS). The browser installs it (no web API prevents that); the running page
//    locks the wallet and shows the warning.
//
// After the core stream's merge (lib/chain.js ENGINE = 'real') this suite runs the real engine,
// which reaches Firo's ElectrumX servers: the address is still never needed, which is the point.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, normalize, sep, resolve as resolvePath } from 'node:path';
import { chromium } from 'playwright-core';
import { PWA, CHROME, recordedPage, shot, waitScreen, foreignHosts, sleep, SHOTS } from './harness.mjs';
import { waitSynced } from './flows.mjs';
import { headersFor, mimeFor } from '../../tools/headers.mjs';
import { BUILTIN_SOURCES } from '../../src/lib/update_sources.js';

const PORT = Number(process.env.CAMPFIRE_OFFLINE_PORT || 8793);
const HOST = 'campfire.test';
const ORIGIN = `http://${HOST}:${PORT}/`;
const PASSWORD = `off-${randomBytes(6).toString('hex')}`;
const tid = (id) => `[data-testid="${id}"]`;
const pkg = JSON.parse(readFileSync(join(PWA, 'package.json'), 'utf8'));

const HOSTILE_SW = `// not Campfire
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(new Response('<h1>Not Campfire</h1>', { headers: { 'Content-Type': 'text/html' } })));
`;
const PARKING = '<!doctype html><html><head><title>campfire.test is for sale</title></head><body><h1>This domain is parked</h1><p>Buy it now!</p></body></html>';

// The public copies are unreachable in this browser, like everything else the address had.
const COPY_HOSTS = [...new Set(BUILTIN_SOURCES.map((u) => new URL(u).host))];
const isCopyProbe = (u) => BUILTIN_SOURCES.some((b) => u === `${b}release.json`);

let tmp, rel, loader, total;
let mode = 'normal';
let slowMs = 0;
const reqs = [];
let server = null;
const sockets = new Set();
let ctx = null;
let page = null;
let rec = null;
const allRecs = [];

// ---------------------------------------------------------------- the web address
function handler(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  reqs.push({ method: req.method, path, sw: String(req.headers['service-worker'] || ''), dest: String(req.headers['sec-fetch-dest'] || ''), mode });
  const send = (code, body, type, extra = {}) => {
    res.writeHead(code, { ...headersFor(path), 'Content-Type': type, 'Cache-Control': 'no-cache', ...extra });
    res.end(body);
  };
  if (mode === 'notfound') return send(404, 'Not Found', 'text/plain');
  if (mode === 'error500') return send(503, 'Service Unavailable', 'text/plain');
  if (mode === 'parking') return send(200, PARKING, 'text/html; charset=utf-8');
  if (mode === 'hostile' && path === `/${loader}`) return send(200, HOSTILE_SW, 'application/javascript');
  const serveFile = async () => {
    let rp = decodeURIComponent(path);
    if (rp.endsWith('/')) rp += 'index.html';
    const full = normalize(join(rel, rp));
    if (!full.startsWith(rel + sep)) return send(403, 'no', 'text/plain');
    try {
      const st = await stat(full);
      if (!st.isFile()) throw new Error('dir');
      send(200, await readFile(full), mimeFor(full));
    } catch {
      send(404, 'not found', 'text/plain');
    }
  };
  if (slowMs) setTimeout(serveFile, slowMs);
  else serveFile();
}

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    server.listen(PORT, '127.0.0.1', resolve);
  });
}

async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  for (const so of sockets) so.destroy();
  await new Promise((r) => s.close(() => r()));
}

// Two requests come from Chrome itself, not from the app: the loader re-check
// (Service-Worker: script), and - Chrome desktop's "ServiceWorkerAutoPreload" -
// one copy of the navigation sent to the network while the service worker
// wakes up, whose answer Chrome throws away (the page is still served by the
// worker; coldStart() asserts that for every navigation). Measured: with
// --disable-features=ServiceWorkerAutoPreload that request is gone. WebKit has
// no such feature.
const isLoaderProbe = (r) => r.path === `/${loader}` && r.sw === 'script';
const isAutoPreload = (r) => r.path === '/' && r.dest === 'document' && r.sw === '';
let coldStarts = 0;

/** Requests the address received since `from`, minus the two browser-made ones above. */
function originRequests(from) {
  return reqs.slice(from).filter((r) => !isLoaderProbe(r) && !isAutoPreload(r));
}
const autoPreloads = (from) => reqs.slice(from).filter(isAutoPreload).length;
const loaderProbes = (from) => reqs.slice(from).filter(isLoaderProbe).length;

// ---------------------------------------------------------------- the browser
async function coldStart({ unresolvable = false, goto = true, waitUntil = 'load', extraArgs = [] } = {}) {
  if (ctx) await ctx.close().catch(() => {});
  ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    executablePath: CHROME,
    headless: !process.env.HEADED,
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
    args: [
      `--host-resolver-rules=MAP ${HOST} ${unresolvable ? '~NOTFOUND' : '127.0.0.1'}, ${COPY_HOSTS.map((h) => `MAP ${h} ~NOTFOUND`).join(', ')}`,
      `--unsafely-treat-insecure-origin-as-secure=http://${HOST}:${PORT}`,
      '--disable-features=AutofillServerCommunication',
      ...extraArgs,
    ],
  });
  for (const p of ctx.pages()) await p.close().catch(() => {});
  // Headless Chrome has no share sheet: take the download path (the iPhone uses the share sheet).
  // And Chrome closes the page on a second download in a reused headless profile (reproduced with a
  // ten-line page, not this app): after the first real download, the test takes the file the app
  // hands to the download instead - the same Blob, captured when the app makes its blob: URL.
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
      Object.defineProperty(Navigator.prototype, 'canShare', { value: undefined, configurable: true });
    } catch {
      /* fine */
    }
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => {
      window.__lastBlob = b;
      return make(b);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (window.__captureDownloads && this.download && window.__lastBlob) {
        const name = this.download;
        window.__lastBlob.arrayBuffer().then((buf) => {
          const u8 = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
          window.__captured = { name, b64: btoa(bin) };
        });
        return undefined;
      }
      return click.call(this);
    };
  });
  ({ page, rec } = await recordedPage(ctx, { label: 'offline' }));
  allRecs.push(rec);
  page.on('crash', () => console.log('# PAGE CRASHED'));

  coldStarts++;
  if (goto) {
    const resp = await page.goto(ORIGIN, { waitUntil });
    page.__fromSW = resp ? resp.fromServiceWorker() : null;
  }
  return page;
}

async function screenNow(p = page) {
  return p.evaluate(() => document.getElementById('app') && document.getElementById('app').dataset.screen);
}

/** Synced (the engine's sync done, connected, a fresh tip). */
async function syncedHere(label) {
  await waitSynced(page, 5 * 60000);
  const st = await page.evaluate(() => window.__campfire.sync());
  assert.equal(st.state, 'synced', `${label}: synced`);
  console.log(`# ${label}: Synced at block ${st.height}`);
  return st.height;
}

/** The rule: nothing but Chrome's own two requests, and the page itself came from the worker. */
function assertOnlyBrowserRequests(from, starts, label, allow = () => false) {
  const stray = originRequests(from).filter((r) => !allow(r));
  assert.deepEqual(stray, [], `${label}: a request reached the address`);
  assert.ok(autoPreloads(from) <= starts, `${label}: at most one auto-preload per cold start`);
}

// ---------------------------------------------------------------- flows
async function unlock() {
  await waitScreen(page, 'unlock', 60000);
  if (!(await page.isVisible(tid('unlock-pw')))) await page.click(tid('use-password'));
  await page.fill(tid('unlock-pw'), PASSWORD);
  await page.click(tid('unlock-submit'));
  await waitScreen(page, 'home', 60000);
}

async function untilHome() {
  const t0 = Date.now();
  for (;;) {
    const s = await screenNow();
    if (s === 'home') return;
    if (s === 'passkeySetup') await page.click(tid('passkey-skip')).catch(() => {});
    if (Date.now() - t0 > 5 * 60000) throw new Error(`stuck on ${s}`);
    await sleep(300);
  }
}

async function createNew() {
  await waitScreen(page, 'welcome', 60000);
  await page.click(tid('create'));
  await waitScreen(page, 'backup');
  await page.waitForSelector('[data-testid="words"] .word');
  await page.click(tid('reveal'));
  const words = await page.$$eval('[data-testid="words"] .word span:last-child', (els) => els.map((e) => e.textContent));
  await page.click(tid('wrote-down'));
  await waitScreen(page, 'confirmWords');
  for (const pos of await page.$$eval('[data-position]', (els) => els.map((e) => Number(e.dataset.position)))) {
    await page.click(`[data-position="${pos}"] [data-word="${words[pos - 1]}"]`);
  }
  words.fill('');
  await page.click(tid('confirm-words'));
  await waitScreen(page, 'setPassword');
  await page.fill(tid('pw1'), PASSWORD);
  await page.fill(tid('pw2'), PASSWORD);
  await page.click(tid('save-password'));
  await untilHome();
}

let realDownloadDone = false;

/** Settings -> Backup -> Save an encrypted backup file (the password is long enough to be the file's). */
async function exportBackup(name, { screenshot = false } = {}) {
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('backup-row'));
  await waitScreen(page, 'backup');
  if (screenshot) await shot(page, 'offline-05-backup');
  await page.click(tid('export-start'));
  await page.fill(tid('export-pw'), PASSWORD);
  await page.click(tid('export-continue'));
  await page.waitForSelector(tid('export-save'), { timeout: 120000 });
  if (screenshot) await shot(page, 'offline-06-backup-ready');
  const dest = join(tmp, 'exports', `${name}.json`);
  mkdirSync(join(tmp, 'exports'), { recursive: true });
  let fileName;
  if (!realDownloadDone) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(tid('export-save'))]);
    await dl.saveAs(dest);
    fileName = dl.suggestedFilename();
    realDownloadDone = true;
    console.log(`# ${name}: a real Chrome download`);
  } else {
    await page.evaluate(() => {
      window.__captured = null;
      window.__captureDownloads = true;
    });
    await page.click(tid('export-save'));
    const got = await page.waitForFunction(() => window.__captured, null, { timeout: 30000 }).then((h) => h.jsonValue());
    writeFileSync(dest, Buffer.from(got.b64, 'base64'));
    fileName = got.name;
  }
  assert.match(fileName, /^campfire-firo-backup-\d{4}-\d\d-\d\d\.json$/);
  const file = JSON.parse(readFileSync(dest, 'utf8'));
  assert.equal(file.app, 'campfire-firo');
  assert.ok(!JSON.stringify(file).includes(PASSWORD), 'the password is not in the file');
  console.log(`# ${name}: backup file of ${readFileSync(dest).length} bytes`);
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await waitSynced(page, 120000);
  return dest;
}

async function deleteWallet() {
  await page.evaluate(() => window.__campfire.go('deleteWallet'));
  await waitScreen(page, 'deleteWallet');
  await page.fill(tid('delete-confirm'), 'DELETE');
  await page.click(tid('delete-submit'));
  await waitScreen(page, 'welcome', 60000);
}

/** Welcome -> Restore from a backup file -> the file and its password -> a password for this device -> Home. */
async function restoreFromFile(file, password) {
  await waitScreen(page, 'welcome');
  await page.click(tid('restore-file'));
  await waitScreen(page, 'restoreFile');
  await page.setInputFiles(tid('backup-file'), file);
  await page.waitForSelector(tid('backup-pw'), { state: 'visible' });
  await page.fill(tid('backup-pw'), password);
  await page.click(tid('backup-open'));
  await waitScreen(page, 'setPassword');
  await page.fill(tid('pw1'), PASSWORD);
  await page.fill(tid('pw2'), PASSWORD);
  await page.click(tid('save-password'));
  await untilHome();
}

/**
 * A wallet from a backup file never showed its words: Home asks to write them down (audit A-10).
 * 'later': snoozed for a week; 'written': Show my words -> the words -> "I wrote them down".
 */
async function wordsReminder(how) {
  await waitScreen(page, 'home');
  await page.waitForSelector(tid('backup-prompt'));
  assert.match(await page.textContent(tid('backup-prompt')), /Write down your recovery words\. This wallet came from a backup file\./);
  if (how === 'later') {
    await page.click(tid('backup-prompt-later'));
    await page.waitForSelector(tid('backup-prompt'), { state: 'detached' });
    const until = await page.evaluate(async () => (await (await import('./lib/store.js')).getPrefs()).backupPromptSnoozedUntil);
    assert.ok(until > Date.now() + 6 * 86400000, 'a week');
    return;
  }
  await page.click(tid('backup-prompt-show'));
  await waitScreen(page, 'backup');
  await page.click(tid('show-words'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(tid('words-done'));
  assert.equal(await page.textContent(tid('words-done')), 'I wrote them down');
  await page.click(tid('words-done'));
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await sleep(300);
  assert.equal(await page.locator(tid('backup-prompt')).count(), 0, 'gone once written down');
}

async function checkForUpdates() {
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('check-updates'));
}

async function swState() {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { controller: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.split('/').pop(), active: reg && reg.active && reg.active.scriptURL.split('/').pop(), installing: Boolean(reg && (reg.installing || reg.waiting)) };
  });
}

// ---------------------------------------------------------------- setup
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-offline-'));
  // OFFLINE_REL_DIR: a release as published (the GitHub release zip, unpacked)
  // instead of a fresh build, to prove that a copy made from it stands alone.
  rel = process.env.OFFLINE_REL_DIR ? resolvePath(process.env.OFFLINE_REL_DIR) : join(tmp, 'rel');
  if (!process.env.OFFLINE_REL_DIR) execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', rel, '--version', pkg.version, '--quiet', '--engine', 'fake'], { cwd: PWA });
  loader = readFileSync(join(rel, 'lib', 'version.js'), 'utf8').match(/LOADER = "(sw-[0-9a-f]+\.js)"/)[1];
  total = JSON.parse(readFileSync(join(rel, 'manifest.json'), 'utf8')).files.length;
  await startServer();
  console.log(`# release ${JSON.parse(readFileSync(join(rel, 'release.json'), 'utf8')).version}: ${total} files, loader ${loader}; screenshots: ${SHOTS}`);
});

after(async () => {
  if (ctx) await ctx.close().catch(() => {});
  await stopServer();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1. first run
test('first run: splash at once, live progress, the address dies midway, nothing partial is served, reopening resumes and completes', { timeout: 10 * 60000 }, async () => {
  slowMs = 300;
  await coldStart({ waitUntil: 'commit' });
  // Before any script ran: the static splash from index.html, never a blank page.
  await page.waitForFunction(() => document.styleSheets.length > 0 && /Starting Campfire/.test(document.getElementById('app')?.textContent || ''), null, { timeout: 30000, polling: 50 });
  await sleep(150);
  await shot(page, 'offline-01-splash');
  await waitScreen(page, 'install', 120000);
  await page.waitForFunction(() => Number(document.querySelector('main.install')?.dataset.done || 0) >= 12, null, { timeout: 180000, polling: 200 });
  assert.match(await page.textContent(tid('install-line')), /^\d+ of \d+ files checked · [\d.]+ of [\d.]+ MB$/);
  await shot(page, 'offline-02-first-run-progress');
  const doneBefore = Number(await page.evaluate(() => document.querySelector('main.install').dataset.done));

  // The address dies in the middle of setup.
  await stopServer();
  await page.waitForSelector(tid('install-retry'), { timeout: 180000 });
  await shot(page, 'offline-03-setup-stopped');
  const msg = await page.textContent(tid('install-status'));
  assert.match(msg, /kept/, 'it says the files already checked are kept');
  const partial = await page.evaluate(async () => {
    const meta = await caches.open('campfire-meta');
    const st = await (await meta.match(new URL('__campfire_state', location.href).href)).json();
    const staged = st.staging ? (await (await caches.open(st.staging)).keys()).length : 0;
    return { controlled: Boolean(navigator.serviceWorker.controller), current: st.current, staging: st.staging, staged };
  });
  console.log(`# setup interrupted after ${doneBefore} files on screen; ${partial.staged} verified files kept in ${partial.staging}`);
  assert.equal(partial.controlled, false, 'not controlled: nothing is served from a partial copy');
  assert.equal(partial.current, null, 'not counted as installed');
  assert.ok(partial.staged >= 1, 'verified files are kept for the next run');

  // Reopening while the address is down shows nothing from the partial copy.
  const probe = await ctx.newPage();
  const failed = await probe.goto(ORIGIN).then(() => false, () => true);
  assert.equal(failed, true, 'with nothing installed, a cold open has no app to show');
  await probe.close();

  // The address is back: reopen; setup continues from what was already verified.
  slowMs = 0;
  await startServer();
  const from = reqs.length;
  await coldStart();
  await waitScreen(page, 'welcome', 180000);
  const prog = await page.evaluate(async () => {
    const meta = await caches.open('campfire-meta');
    return (await meta.match(new URL('__campfire_install', location.href).href)).json();
  });
  const swDownloads = reqs.slice(from).filter((r) => r.dest === 'empty' && !/^\/(release\.json|release\.sig|manifest\.json)$/.test(r.path)).length;
  console.log(`# resumed: ${prog.resumed} of ${prog.total} files reused, ${swDownloads} downloaded in the second run`);
  assert.equal(prog.state, 'done');
  assert.ok(prog.resumed >= partial.staged, 'every file verified in the first run was reused');
  assert.equal(swDownloads, total - prog.resumed, 'only the missing files were downloaded');
  const sw = await swState();
  assert.equal(sw.controller, loader, 'now served by the content-addressed loader');
  assert.equal(await page.evaluate(() => self.crossOriginIsolated), true);
});

// ---------------------------------------------------------------- 2. installed, address alive
test('installed, address alive: create a wallet and sync; nothing but the loader probe reaches the address', { timeout: 10 * 60000 }, async () => {
  const from = reqs.length;
  await coldStart();
  assert.equal(page.__fromSW, true, 'the page came from the verified copy');
  await createNew();
  await syncedHere('new wallet (address alive)');
  assertOnlyBrowserRequests(from, 1, 'address alive');
  // Strictly zero: the same cold start with Chrome's auto-preload switched off.
  const from2 = reqs.length;
  await coldStart({ extraArgs: ['--disable-features=AutofillServerCommunication,ServiceWorkerAutoPreload'] });
  assert.equal(page.__fromSW, true);
  await unlock();
  await syncedHere('address alive, auto-preload off');
  assert.deepEqual(reqs.slice(from2).filter((r) => !isLoaderProbe(r)), [], 'auto-preload off: not one request reached the address');
  console.log(`# auto-preload off: ${reqs.length - from2} requests reached the address (loader probes only)`);
  console.log(`# address alive, after install: ${reqs.length - from} requests reached it, all Chrome's own (loader probes ${loaderProbes(from)}, auto-preload ${autoPreloads(from)})`);
});

// ---------------------------------------------------------------- 3. the address dies, four ways
const WAYS = [
  { name: 'stopped', label: 'server stopped (connection refused)' },
  { name: 'unresolvable', label: 'name unresolvable (DNS)' },
  { name: 'notfound', label: '404 for every path' },
  { name: 'parking', label: '200 HTML parking page for every path' },
];

for (const way of WAYS) {
  test(`without the address - ${way.label}: cold start, unlock, Synced, backup file, restore from it, create; zero requests`, { timeout: 15 * 60000 }, async () => {
    if (way.name === 'stopped') await stopServer();
    else if (!server) await startServer();
    mode = way.name === 'notfound' ? 'notfound' : way.name === 'parking' ? 'parking' : 'normal';
    const from = reqs.length;
    await coldStart({ unresolvable: way.name === 'unresolvable' });
    assert.equal(page.__fromSW, true, `${way.name}: the page came from the verified copy`);
    await unlock();
    await syncedHere(`${way.name}: existing wallet`);
    await shot(page, `offline-04-${way.name}-home`);

    if (way.name === 'notfound' || way.name === 'parking') {
      // The browser re-fetches the loader by itself about daily; force that now. It must fail
      // and leave the installed loader and its verified copy in place.
      const before = await swState();
      const r = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((reg) => reg.update().then(() => 'resolved', (e) => `rejected ${e.name}`)));
      await sleep(1000);
      const afterUpdate = await swState();
      console.log(`# ${way.name}: loader update -> ${r}; registration ${JSON.stringify(afterUpdate)}`);
      assert.ok(loaderProbes(from) >= 1, 'the browser did ask the address for the loader');
      assert.equal(afterUpdate.active, before.active, 'the installed loader stays');
      assert.equal(afterUpdate.controller, loader);
      assert.equal(afterUpdate.installing, false);
      assert.equal(await page.evaluate(() => window.__campfire.intrusion()), null, 'a failed update is not mistaken for a takeover');
    }

    const before = await page.evaluate(() => window.__campfire.receive());
    const exported = await exportBackup(`backup-${way.name}`, { screenshot: way.name === 'notfound' });
    await deleteWallet();
    await restoreFromFile(exported, PASSWORD);
    await syncedHere(`${way.name}: restored from its own backup file`);
    assert.equal((await page.evaluate(() => window.__campfire.receive())).spark, before.spark, 'the backup file brings back the same wallet');
    await wordsReminder(way.name === 'stopped' ? 'written' : 'later');
    await deleteWallet();
    await createNew();
    await syncedHere(`${way.name}: new wallet`);

    if (way.name === 'parking' || way.name === 'stopped') {
      await checkForUpdates();
      await page.waitForSelector(tid('no-update-source'), { timeout: 60000 });
      assert.match(await page.textContent(tid('no-update-source')), /No update source reachable\. Your app keeps working\./);
      if (way.name === 'parking') await shot(page, 'offline-07-no-update-source');
      await page.click(tid('no-update-ok'));
      assert.match(await page.textContent(tid('check-updates')), /no update source was reachable; your app keeps working/);
    }

    // The tapped update check is the one request the app makes on purpose: the address, then each
    // public copy once for release.json (none resolves here). Without a tap, no copy is asked.
    assertOnlyBrowserRequests(from, 1, way.name, (r) => (way.name === 'parking' || way.name === 'stopped') && /^\/(release\.json|release\.sig|manifest\.json)$/.test(r.path));
    const tapped = way.name === 'parking' || way.name === 'stopped';
    assert.deepEqual(rec.requests.filter(isCopyProbe).sort(), tapped ? BUILTIN_SOURCES.map((b) => `${b}release.json`).sort() : [], 'the public copies: asked once each, only on the tapped check');
    assert.deepEqual(foreignHosts({ ...rec, requests: rec.requests.filter((u) => !isCopyProbe(u)) }, ORIGIN, []), [], 'no other host contacted');
    assert.deepEqual(rec.errors, [], 'no page errors');
    console.log(`# ${way.name}: requests at the address after the cold start: ${reqs.length - from} (loader probes ${loaderProbes(from)}, Chrome auto-preload ${autoPreloads(from)}, the rest: the update check the test tapped)`);
  });
}

test('5xx at the address: the loader update fails and the app still starts from its copy', { timeout: 5 * 60000 }, async () => {
  if (!server) await startServer();
  mode = 'error500';
  const from = reqs.length;
  await coldStart();
  assert.equal(page.__fromSW, true);
  await waitScreen(page, 'unlock', 60000);
  const r = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((reg) => reg.update().then(() => 'resolved', (e) => `rejected ${e.name}`)));
  const st = await swState();
  console.log(`# 5xx: loader update -> ${r}; ${JSON.stringify(st)}`);
  assert.equal(st.active, loader);
  assert.equal(st.installing, false);
  await coldStart();
  assert.equal(page.__fromSW, true);
  await unlock();
  await syncedHere('5xx: existing wallet');
  assertOnlyBrowserRequests(from, 2, '5xx');
});

// ---------------------------------------------------------------- 4. takeover
test('hostile takeover: different loader code at the address -> the running app locks the wallet and warns', { timeout: 5 * 60000 }, async () => {
  if (!server) await startServer();
  mode = 'normal';
  await coldStart();
  await unlock();
  await waitSynced(page, 180000);
  mode = 'hostile';
  // The browser's daily loader check, made now: it gets valid JavaScript that is not Campfire's.
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((reg) => reg.update()).catch(() => {}));
  await waitScreen(page, 'problem', 30000);
  await page.waitForSelector(tid('tripwire'));
  assert.match(await page.textContent(tid('tripwire')), /This app's web address is serving code Campfire did not sign\. Don't enter your password here\./);
  assert.ok(await page.evaluate(() => window.__campfire.intrusion()), 'the tripwire fired');
  await page.waitForFunction(() => window.__campfire.running() === false, null, { timeout: 30000 });
  await page.evaluate(() => window.__campfire.go('home'));
  assert.equal(await screenNow(), 'problem', 'nothing else opens in this page afterwards');
  await shot(page, 'offline-08-tripwire');
  const text = await page.textContent('main');
  assert.match(text, /recovery words/);
  assert.match(text, /backup file/);
});
