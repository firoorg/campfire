// Updates without the app's own address: the installed Google Chrome
// (headless), ONE persistent profile restarted cold between steps, the stand-in
// engine (lib/backend_fake.js: no Firo server needed), and four test servers.
// Spends nothing (a throwaway wallet).
//
//   npm run e2e:mirrors
//
// A  http://campfire.test:8811/  the app's own address (Chrome treats it as a
//    secure origin); sends the production headers (tools/headers.mjs
//    headersFor: the page policy, the loader's own, CORS).
// M  https://mirror.test:8812/   built-in copy #1   } other origins, self-signed
// M2 https://mirror2.test:8813/  built-in copy #2   } (Chrome ignores certificate
// C  https://copy.test:8814/     an added address   } errors here); same headers.
// The ports are CAMPFIRE_MIRRORS_PORT (default 8811) and the next three.
// Every release here is built with --mirrors M,M2 (the list the loader asks
// after A). Each server counts what it receives.
//
// 1. Install from A at N, make a wallet; then A stops completely.
// 2. M serves a signed N+1: Check for updates finds it there, Update applies
//    it, a cold start runs N+1 with A still dead.
// 3. M serves a tampered N+2: refused, nothing of it cached; the app stays on
//    N+1 and works.
// 4. M serves N+1 or N: "up to date".
// 5. M sends no CORS: unreachable, M2 is asked next and its release is used.
// 6. A is alive: every source is asked (release.json/.sig/manifest.json only) and the newest
//    signed release wins. A on the installed release, M and M2 too: up to date. A still on it
//    (frozen) while M has N+4: N+4 comes from M.
// 7. Nothing reachable -> "Update from another address": an http address is
//    refused in words, the https one is saved and used.
// 8. A release that brings a new loader while A is dead: one that serves pages
//    like the running loader applies and runs under it, no loop, no takeover
//    alarm, no request to A and no "finish the update" banner; one that cannot is refused from M with the reason. A back
//    with the installed release while M still has the newer one: it needs A, which "still serves"
//    the installed version, and the tapped check moves the page to its loader; the incompatible
//    release then installs from A and the loader moves as before. Update of such a staged
//    release while A is down says it needs A.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { PWA, CHROME, recordedPage, waitScreen, sleep, SHOTS } from './harness.mjs';
import { createWallet, waitSynced, unlockWithPassword } from './flows.mjs';
import { headersFor, mimeFor } from '../../tools/headers.mjs';

const tid = (id) => `[data-testid="${id}"]`;
const PASSWORD = `mir-${randomBytes(6).toString('hex')}`;
const pkg = JSON.parse(readFileSync(join(PWA, 'package.json'), 'utf8'));
const V = (n) => pkg.version.replace(/\d+$/, (p) => String(Number(p) + n));
const A_PORT = Number(process.env.CAMPFIRE_MIRRORS_PORT || 8811);
const ORIGIN = `http://campfire.test:${A_PORT}/`;
// The three other origins listen on the next three ports.
const M_HOST = `mirror.test:${A_PORT + 1}`;
const M2_HOST = `mirror2.test:${A_PORT + 2}`;
const C_HOST = `copy.test:${A_PORT + 3}`;
const M_URL = `https://${M_HOST}/`;
const M2_URL = `https://${M2_HOST}/`;
const C_URL = `https://${C_HOST}/`;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MIRRORS = `${M_URL},${M2_URL}`;

let tmp, ctx = null, page = null, rec = null;
const R = {}; // release dirs
const L = {}; // loader names

// ---------------------------------------------------------------- servers
function host({ port, tls = null }) {
  const st = { root: null, nocors: false, delayMs: 0, reqs: [], server: null, sockets: new Set() };
  const handler = async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    st.reqs.push({ path, sw: String(req.headers['service-worker'] || ''), dest: String(req.headers['sec-fetch-dest'] || ''), origin: String(req.headers.origin || ''), referer: String(req.headers.referer || ''), cookie: String(req.headers.cookie || '') });
    let rel = decodeURIComponent(path.slice(1));
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const full = normalize(join(st.root, rel));
    const h = { ...headersFor(rel), 'Cache-Control': 'no-cache' };
    if (st.nocors) delete h['Access-Control-Allow-Origin'];
    try {
      if (!full.startsWith(st.root + sep)) throw new Error('outside');
      const s = await stat(full);
      if (!s.isFile()) throw new Error('dir');
      const body = await readFile(full);
      if (st.delayMs && !/^(release\.json|release\.sig|manifest\.json)$/.test(rel)) await sleep(st.delayMs);
      res.writeHead(200, { ...h, 'Content-Type': mimeFor(full), 'Content-Length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404, { ...h, 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  };
  st.start = () =>
    new Promise((resolve) => {
      st.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
      st.server.on('connection', (s) => {
        st.sockets.add(s);
        s.on('close', () => st.sockets.delete(s));
      });
      st.server.listen(port, '127.0.0.1', resolve);
    });
  st.stop = async () => {
    if (!st.server) return;
    const s = st.server;
    st.server = null;
    for (const so of st.sockets) so.destroy();
    await new Promise((r) => s.close(() => r()));
  };
  st.serve = (dir) => (st.root = dir);
  st.count = () => st.reqs.length;
  st.since = (n) => st.reqs.slice(n);
  return st;
}

let A, M, M2, C;

// ---------------------------------------------------------------- browser
async function coldStart({ goto = true } = {}) {
  if (ctx) await ctx.close().catch(() => {});
  ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    executablePath: CHROME,
    headless: !process.env.HEADED,
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    args: [
      '--host-resolver-rules=MAP campfire.test 127.0.0.1, MAP mirror.test 127.0.0.1, MAP mirror2.test 127.0.0.1, MAP copy.test 127.0.0.1',
      `--unsafely-treat-insecure-origin-as-secure=http://campfire.test:${A_PORT}`,
      '--ignore-certificate-errors', // the three https servers use a certificate made by this test
      '--disable-features=AutofillServerCommunication',
    ],
  });
  for (const p of ctx.pages()) await p.close().catch(() => {});
  // Every serviceWorker.register() the app makes, across reloads and restarts.
  await ctx.addInitScript(() => {
    const orig = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = function (url, opts) {
      try {
        const l = JSON.parse(localStorage.getItem('__test_registers') || '[]');
        l.push(String(url));
        localStorage.setItem('__test_registers', JSON.stringify(l));
      } catch {
        /* fine */
      }
      return orig.call(this, url, opts);
    };
  });
  ({ page, rec } = await recordedPage(ctx, { label: 'mirrors' }));
  if (goto) {
    const resp = await page.goto(ORIGIN);
    page.__fromSW = resp ? resp.fromServiceWorker() : null;
  }
  return page;
}

const registers = () => page.evaluate(() => JSON.parse(localStorage.getItem('__test_registers') || '[]'));
const servedVersion = async () => ((await page.evaluate(() => fetch('lib/version.js', { cache: 'no-store' }).then((r) => r.text()))).match(/APP_VERSION = "([^"]+)"/) || [])[1];
const controller = () => page.evaluate(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.split('/').pop());
const intrusion = () => page.evaluate(() => window.__campfire.intrusion());

/**
 * Waits until the page runs under `loader` and is no longer behind it. A locked
 * page reloads as soon as a new loader takes over (lib/loader.js onMoved): this
 * waits across that reload.
 */
async function settledUnder(loader, timeoutMs = 60000) {
  for (const t0 = Date.now(); ; ) {
    const ok = await page
      .evaluate((l) => Boolean(navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.endsWith(`/${l}`) && window.__campfire && window.__campfire.loaderBehind() === false && document.getElementById('app')?.dataset.screen), loader)
      .catch(() => false);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`the page did not settle under ${loader}`);
    await sleep(250);
  }
}

/** Light and dark, 375 px wide. */
async function shots(name) {
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function openUnlocked() {
  await coldStart();
  assert.equal(page.__fromSW, true, 'the page came from the verified copy');
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
}

async function tapCheck() {
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.click(tid('check-updates'));
}

/** Taps Check for updates and waits for the answer sheet (or the "latest version" toast). */
async function checkAndWait() {
  await tapCheck();
  await page.waitForFunction(() => {
    const sheet = document.querySelector('.sheet');
    const toast = document.querySelector('.toast');
    if (toast && /latest version/.test(toast.textContent)) return true;
    return sheet && !sheet.querySelector('[data-testid="update-progress"]');
  }, null, { timeout: 180000, polling: 100 });
  const toast = await page.$('.toast');
  return {
    toast: toast ? await toast.textContent() : null,
    sheet: (await page.$('.sheet')) ? await page.textContent('.sheet') : null,
  };
}

async function applyAndReload() {
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.click(tid('update-apply-sheet'))]);
  await waitScreen(page, 'unlock', 60000);
}

const releaseFiles = (reqs) => reqs.filter((r) => /^\/(release\.json|release\.sig|manifest\.json)$/.test(r.path));

function build(name, version, extra = []) {
  const out = join(tmp, name);
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', out, '--version', version, '--mirrors', MIRRORS, '--quiet', '--engine', 'fake', ...extra], { cwd: PWA });
  R[name] = out;
  L[name] = readFileSync(join(out, 'lib', 'version.js'), 'utf8').match(/LOADER = "(sw-[0-9a-f]+\.js)"/)[1];
  return out;
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-mirrors-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(tmp, 'key.pem'), '-out', join(tmp, 'cert.pem'), '-days', '2', '-subj', '/CN=mirror.test', '-addext', 'subjectAltName=DNS:mirror.test,DNS:mirror2.test,DNS:copy.test'], { stdio: 'ignore' });
  const tls = { key: readFileSync(join(tmp, 'key.pem')), cert: readFileSync(join(tmp, 'cert.pem')) };
  A = host({ port: A_PORT });
  M = host({ port: A_PORT + 1, tls });
  M2 = host({ port: A_PORT + 2, tls });
  C = host({ port: A_PORT + 3, tls });
  build('n0', V(0));
  build('n1', V(1));
  build('n2', V(2));
  // The same release with one file changed after signing.
  cpSync(R.n2, join(tmp, 'tampered-2'), { recursive: true });
  writeFileSync(join(tmp, 'tampered-2', 'app.js'), readFileSync(join(tmp, 'tampered-2', 'app.js'), 'utf8') + '\n/* tampered by the mirror */\n');
  R.n2t = join(tmp, 'tampered-2');
  build('n3', V(3));
  build('n4', V(4));
  build('n5', V(5));
  build('n6c', V(6), ['--loader-note', 'a loader that differs only in its bytes']);
  // Releases whose pages need a newer loader: one and two above this source's own LOADER_API.
  const api = Number(readFileSync(join(PWA, 'src', 'sw.js'), 'utf8').match(/const LOADER_API = \/\*__LOADER_API__\*\/ (\d+);/)[1]);
  build('n7x', V(7), ['--loader-api', String(api + 1)]);
  build('n8y', V(8), ['--loader-api', String(api + 2)]);
  assert.equal(L.n1, L.n0, 'ordinary releases keep the loader');
  assert.notEqual(L.n6c, L.n0);
  assert.notEqual(L.n7x, L.n6c);
  console.log(`# releases ${V(0)}..${V(8)}; loaders: ${L.n0} (n0..n5), ${L.n6c} (n6c), ${L.n7x} (n7x), ${L.n8y} (n8y); screenshots: ${SHOTS}`);
});

after(async () => {
  if (ctx) await ctx.close().catch(() => {});
  for (const s of [A, M, M2, C]) if (s) await s.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 1
test('1. install from the own address at N, make a wallet; then the address stops', { timeout: 10 * 60000 }, async () => {
  A.serve(R.n0);
  await A.start();
  await coldStart();
  await waitScreen(page, 'welcome', 180000);
  assert.equal(await controller(), L.n0);
  await createWallet(page, { password: PASSWORD });
  await waitScreen(page, 'home', 5 * 60000);
  await waitSynced(page, 5 * 60000);
  assert.equal(M.count() + M2.count() + C.count(), 0, 'no copy is contacted by an install');
  await A.stop();
  console.log(`# installed ${V(0)} from ${ORIGIN}; the address is now stopped`);
});

// ---------------------------------------------------------------- 2
test('2. own address dead, M serves N+1: found there, verified, applied; a cold start runs N+1', { timeout: 10 * 60000 }, async () => {
  M.serve(R.n1);
  M.delayMs = 40; // slow enough to photograph the download
  await M.start();
  await openUnlocked();
  await tapCheck();
  await page.waitForFunction(() => /Downloading/.test(document.querySelector('[data-testid="update-progress"]')?.textContent || ''), null, { timeout: 120000, polling: 50 });
  assert.match(await page.textContent(tid('update-progress')), new RegExp(`^Downloading ${V(1).replace(/\./g, '\\.')} from a copy at ${esc(M_HOST)}: \\d+ of \\d+ files checked$`));
  await shots('mirrors-01-downloading-from-copy');
  await page.waitForSelector(tid('update-apply-sheet'), { timeout: 180000 });
  M.delayMs = 0;
  assert.match(await page.textContent(tid('update-ready-text')), new RegExp(`Downloaded from a copy at ${esc(M_HOST)} and checked against Campfire's signature`));
  await shots('mirrors-02-ready-from-copy');
  // "Later": Home says where it came from.
  await page.click('.sheet .btn-text');
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.waitForSelector(tid('update-banner'));
  assert.match(await page.textContent(tid('update-banner')), new RegExp(`came from a copy at ${esc(M_HOST)}`));
  await shots('mirrors-03-home-banner-from-copy');
  // Every file the mirror served went into the app's own cache, under the app's own URLs.
  const caches = await page.evaluate(async () => {
    const st = await (await (await caches.open('campfire-meta')).match(new URL('__campfire_state', location.href).href)).json();
    const keys = (await (await caches.open(st.pending.cache)).keys()).map((r) => r.url);
    return { pending: st.pending.version, from: st.pending.from, n: keys.length, foreign: keys.filter((u) => !u.startsWith(location.origin + '/')).length };
  });
  assert.equal(caches.pending, V(1));
  assert.deepEqual(caches.from, { host: M_HOST, own: false });
  assert.equal(caches.foreign, 0, 'cached under the scope URLs only');
  const mreqs = M.since(0);
  assert.ok(mreqs.every((r) => r.cookie === '' && r.referer === ''), 'no cookies, no referrer to the copy');
  assert.ok(mreqs.every((r) => r.origin === ORIGIN.slice(0, -1)), 'CORS requests from the app origin');
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.click(tid('update-apply'))]);
  await waitScreen(page, 'unlock', 60000);
  await page.waitForSelector(tid('updated-notice'), { timeout: 10000 });
  assert.equal(await page.textContent(tid('updated-notice')), `Updated to ${V(1)} from a copy at ${M_HOST} — checked against Campfire's signature.`);
  await shots('mirrors-04-updated-from-copy');
  assert.equal(await servedVersion(), V(1));
  // Cold start, own address still dead.
  await openUnlocked();
  assert.equal(await servedVersion(), V(1));
  await waitSynced(page, 180000);
  assert.equal(await page.evaluate(() => window.__campfire.sync().state), 'synced');
  assert.equal(await intrusion(), null);
  console.log(`# ${V(0)} -> ${V(1)} from ${M_URL} with ${ORIGIN} dead; ${caches.n} files cached under the app's URLs; cold start runs ${V(1)}, Synced`);
});

// ---------------------------------------------------------------- 3
test('3. M serves a tampered N+2: refused, nothing of it cached, still N+1 and working', { timeout: 5 * 60000 }, async () => {
  M.serve(R.n2t);
  const r = await checkAndWait();
  assert.match(r.sheet, /Update refused/);
  assert.match(await page.textContent('.sheet .notice'), new RegExp(`From the copy at ${esc(M_HOST)}: A file in this update \\(app\\.js\\) is not the one that was signed\\. You are still on the version you had`));
  assert.match(await page.textContent(tid('update-tried')), new RegExp(`Asked: this app's address, ${esc(M_HOST)} and ${esc(M2_HOST)}\\.`));
  await shots('mirrors-05-refused-tampered-copy');
  await page.click('.sheet .btn-primary');
  assert.equal(await servedVersion(), V(1));
  const tamperedCached = await page.evaluate(async () => {
    let found = 0;
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) if (req.url.endsWith('/app.js') && (await (await c.match(req)).text()).includes('tampered')) found++;
    }
    return found;
  });
  assert.equal(tamperedCached, 0, 'the tampered file is in no cache');
  await page.evaluate(() => window.__campfire.go('home'));
  await waitSynced(page, 120000);
});

// ---------------------------------------------------------------- 4
test('4. M serves N+1 (installed) or N (older): up to date', { timeout: 5 * 60000 }, async () => {
  M.serve(R.n1);
  let r = await checkAndWait();
  assert.equal(r.toast, `You have the latest version (checked at a copy at ${M_HOST}).`);
  await shots('mirrors-06-up-to-date-at-copy');
  M.serve(R.n0);
  r = await checkAndWait();
  assert.equal(r.toast, 'You have the latest version.');
  assert.equal(await servedVersion(), V(1));
  assert.match(await page.textContent(tid('check-updates')), /you have the latest version/);
});

// ---------------------------------------------------------------- 5
test('5. M sends no CORS headers: unreachable, M2 is asked next and used', { timeout: 6 * 60000 }, async () => {
  M.serve(R.n3);
  M.nocors = true;
  M2.serve(R.n3);
  await M2.start();
  const m0 = M.count();
  const r = await checkAndWait();
  assert.match(r.sheet, new RegExp(`Update to ${V(3).replace(/\./g, '\\.')}`));
  assert.match(await page.textContent(tid('update-ready-text')), new RegExp(`a copy at ${esc(M2_HOST)}`));
  assert.deepEqual(M.since(m0).map((x) => x.path), ['/release.json'], 'M was asked, its answer could not be read, nothing more was asked of it');
  await applyAndReload();
  assert.equal(await servedVersion(), V(3));
  M.nocors = false;
});

// ---------------------------------------------------------------- 6
test('6. the own address is alive: every source is asked and the newest signed release wins, wherever it is', { timeout: 6 * 60000 }, async () => {
  A.serve(R.n3);
  await A.start();
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  const [a0, m0, m20] = [A.count(), M.count(), M2.count()];
  let r = await checkAndWait();
  assert.equal(r.toast, 'You have the latest version.', 'everyone has the installed release; the own address confirms it');
  assert.deepEqual(A.since(a0).filter((x) => !x.sw).map((x) => x.path), ['/release.json', '/release.sig', '/manifest.json']);
  for (const s of [M.since(m0), M2.since(m20)]) assert.deepEqual(s.map((x) => x.path), ['/release.json', '/release.sig', '/manifest.json'], 'a copy is asked for the release, nothing else');
  // The own address keeps serving the installed release (frozen); M has a newer one: that one.
  M.serve(R.n4);
  const m1 = M.count();
  r = await checkAndWait();
  assert.match(await page.textContent(tid('update-ready-text')), new RegExp(`Downloaded from a copy at ${esc(M_HOST)}`));
  assert.match(await page.textContent(tid('update-released')), /^Released \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);
  await shots('mirrors-06b-newer-at-copy-than-own');
  assert.ok(M.since(m1).length > 3, 'its files came from M');
  await applyAndReload();
  assert.equal(await servedVersion(), V(4));
  await A.stop();
  console.log(`# own address alive: ${A.count() - a0} requests there; ${V(4)} came from ${M_HOST}, where it was newer`);
});

// ---------------------------------------------------------------- 7
test('7. nothing reachable, then "Update from another address": http refused in words, https saved and used', { timeout: 8 * 60000 }, async () => {
  await M.stop();
  await M2.stop();
  await openUnlocked();
  let r = await checkAndWait();
  assert.match(await page.textContent(tid('no-update-source')), /No update source reachable\. Your app keeps working\./);
  assert.match(await page.textContent(tid('update-tried')), new RegExp(`Asked: this app's address, ${esc(M_HOST)} and ${esc(M2_HOST)}\\.`));
  await shots('mirrors-07-no-source-reachable');
  await page.click(tid('update-other'));
  await page.waitForSelector(tid('other-address'));
  await shots('mirrors-08-other-address');
  await page.fill(tid('other-address'), `http://${C_HOST}/`);
  await page.click(tid('other-address-check'));
  await page.waitForSelector(tid('other-address-error'));
  assert.equal(await page.textContent(tid('other-address-error')), 'Use an address that starts with https://.');
  await shots('mirrors-09-other-address-http-refused');
  C.serve(R.n5);
  await C.start();
  await page.fill(tid('other-address'), `${C_HOST}/index.html`);
  await page.click(tid('other-address-check'));
  await page.waitForSelector(tid('update-apply-sheet'), { timeout: 180000 });
  assert.match(await page.textContent(tid('update-ready-text')), new RegExp(`a copy at ${esc(C_HOST)}`));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('campfire-update-source')).url), C_URL, 'saved, normalised');
  await shots('mirrors-10-ready-from-added');
  await page.click('.sheet .btn-text'); // Later
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  assert.match(await page.textContent(tid('update-other-row')), new RegExp(`Also asks ${esc(C_HOST)}`));
  await page.evaluate(() => document.querySelector('[data-testid="update-other-row"]').scrollIntoView({ block: 'center' }));
  await shots('mirrors-11-settings');
  await page.click(tid('about'));
  await waitScreen(page, 'about');
  await page.waitForSelector(tid('about-sources'));
  assert.deepEqual(await page.$$eval('[data-testid="about-sources"] > span', (els) => els.map((e) => e.textContent)), ["This app's address", M_HOST, M2_HOST, C_HOST]);
  await page.evaluate(() => document.querySelector('[data-testid="about-sources"]').scrollIntoView({ block: 'center' }));
  await shots('mirrors-12-about-sources');
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('check-updates'));
  await page.waitForSelector(tid('update-apply-sheet'), { timeout: 60000 });
  await applyAndReload();
  assert.equal(await servedVersion(), V(5));
  await C.stop();
});

// ---------------------------------------------------------------- 8
test('8. a release that brings a new loader while the address is dead: safe, no loop, no alarm; the loader moves once the address is back', { timeout: 15 * 60000 }, async () => {
  await M.start();
  // (a) A new loader that serves pages exactly like the running one.
  M.serve(R.n6c);
  await openUnlocked();
  const reg0 = (await registers()).length;
  const loaderAsks = () => rec.requests.filter((u) => u === `${ORIGIN}${L.n6c}`).length;
  await checkAndWait();
  await page.waitForSelector(tid('update-apply-sheet'));
  await applyAndReload();
  assert.equal(await servedVersion(), V(6));
  assert.equal(await controller(), L.n0, 'still the loader the device has: a service worker comes only from its own address');
  await sleep(3000);
  assert.equal(await intrusion(), null, 'no takeover alarm');
  // The running loader serves this release's pages exactly like its own (same loader_compat):
  // nothing is left to finish, so no request to the (dead) address, not even right after the Update.
  assert.equal(loaderAsks(), 0, 'no try to reach the new loader: the running one is compatible');
  assert.equal(await page.evaluate(() => window.__campfire.loaderBehind()), false, 'not behind: no "finish the update" banner');
  assert.deepEqual((await registers()).slice(reg0), [], 'nothing registered while the address is dead');
  for (let i = 0; i < 2; i++) {
    let navs = 0;
    await openUnlocked();
    page.on('framenavigated', (f) => f === page.mainFrame() && navs++);
    assert.equal(await servedVersion(), V(6));
    assert.equal(await controller(), L.n0);
    await sleep(4000);
    assert.equal(navs, 0, 'no reload loop');
    assert.equal(await intrusion(), null);
    assert.equal(loaderAsks(), 0, 'later starts do not try either');
    assert.equal(await page.evaluate(() => window.__campfire.loaderBehind()), false);
  }
  assert.deepEqual((await registers()).slice(reg0), []);
  await waitSynced(page, 180000);

  // (b) A release whose page needs a newer loader: refused from the copy, with the reason.
  M.serve(R.n7x);
  const m0 = M.count();
  const r = await checkAndWait();
  assert.match(r.sheet, new RegExp(`Version ${V(7).replace(/\./g, '\\.')} needs this app's address`));
  assert.match(await page.textContent(tid('update-needs-address')), /can only come from the address you installed it from/);
  await shots('mirrors-13-needs-own-address');
  assert.deepEqual(M.since(m0).map((x) => x.path), ['/release.json', '/release.sig', '/manifest.json'], 'not downloaded');
  await page.click('.sheet .btn-primary');
  assert.equal(await servedVersion(), V(6));
  assert.match(await page.textContent(tid('check-updates')), /needs this app's address to install; your app keeps working/);

  // (c) The address is back with the installed release, M still has the newer one: it needs the
  // address, which "still serves" the installed version; the tapped check moves the page to its loader.
  A.serve(R.n6c);
  await A.start();
  const a0 = A.count();
  const r2 = await checkAndWait();
  assert.match(r2.sheet, new RegExp(`Version ${V(7).replace(/\./g, '\\.')} needs this app's address`));
  assert.match(await page.textContent(tid('update-needs-address')), new RegExp(`which still serves version ${V(6).replace(/\./g, '\\.')}\\.`));
  await page.click('.sheet .btn-primary');
  await page.waitForFunction((l) => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.endsWith(`/${l}`), L.n6c, { timeout: 30000 });
  // The page then looks at what was installed (lib/loader.js checkMovedLoader).
  await page.waitForFunction(() => !localStorage.getItem('campfire-loader-check'), null, { timeout: 30000 });
  await sleep(2000);
  assert.equal(await intrusion(), null, 'the move is not a takeover');
  const atA = A.since(a0).map((x) => `${x.path}${x.dest === 'serviceworker' ? ' (loader install)' : x.sw ? ' (loader check after the move)' : ''}`);
  assert.deepEqual(atA.filter((p) => p.startsWith(`/${L.n6c}`)), [`/${L.n6c}`, `/${L.n6c} (loader install)`, `/${L.n6c} (loader check after the move)`], 'the bytes are checked first, then installed, then checked again');
  console.log(`# loader moved ${L.n0} -> ${L.n6c} on a tapped check with the address back; requests there: ${atA.join(', ')}`);

  // (d) The incompatible release from the address itself: staged there, applied, the loader moves as before.
  A.serve(R.n7x);
  await checkAndWait();
  await page.waitForSelector(tid('update-apply-sheet'));
  await applyAndReload();
  await settledUnder(L.n7x);
  await waitScreen(page, 'unlock', 60000);
  assert.equal(await servedVersion(), V(7));
  assert.equal(await intrusion(), null);
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await waitSynced(page, 180000);

  // (e) Staged from the address, but the address is gone when Update is tapped: it says so, nothing switches.
  A.serve(R.n8y);
  await checkAndWait();
  await page.waitForSelector(tid('update-apply-sheet'));
  await A.stop();
  await page.click(tid('update-apply-sheet'));
  await page.waitForSelector(tid('update-needs-address'), { timeout: 30000 });
  assert.equal(await servedVersion(), V(7));
  assert.equal(await controller(), L.n7x);
  await openUnlocked();
  assert.equal(await servedVersion(), V(7), 'a cold start still runs the release it had');
  await waitSynced(page, 180000);
  assert.equal(await intrusion(), null);
  assert.deepEqual(rec.errors, []);
});
