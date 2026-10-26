// An Update that brings a new loader, from an older release to this tree, on a Pages-like host,
// then Buy FIRO in the same session. A page keeps the headers (CSP) of the loader that served it,
// so until the page is loaded again under the new loader, what that loader would allow and the
// old one does not is refused.
//
// 1. The usual move: after Update the page reloads into the new loader by itself while still
//    locked; unlock, Buy FIRO opens with nothing left to finish (and no CSP refusal).
// 2. Update's check that the new loader can be fetched passes, then the address hiccups when the
//    browser fetches it to install it (or the phone closed the app at that moment): the page
//    reloads under the old loader, Home says one step is left and Buy says to finish the update;
//    once the loader can be fetched, "Finish now" moves the page and Buy works. (A loader that
//    cannot be fetched at all when Update is tapped is refused before anything changes: the
//    "needs this app's address" sheet, covered by e2e:mirrors.)
//
// The older release is built from this tree (version 0.0.9) with another page <-> loader contract
// (--loader-api), so the newer one cannot run under its loader and the page has to move. Until
// Campfire for Firo has a published release, there is nothing older to download. The engine is
// the stand-in (lib/backend_fake.js); Buy FIRO asks buyfiro.app, which may or may not answer: the
// test checks the move, and reports whether buyfiro.app answered.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { PWA, launch, waitScreen, sleep, shot } from './harness.mjs';
import { createWallet, unlockWithPassword } from './flows.mjs';
import { mimeFor } from '../../tools/headers.mjs';

const PORT = Number(process.env.CAMPFIRE_LOADER_MOVE_PORT || 8789);
const BASE = '/campfire-firo-pwa/';
const URL_ = `http://127.0.0.1:${PORT}${BASE}`;
const OLD_VERSION = '0.0.9';
const tid = (id) => `[data-testid="${id}"]`;
const pkg = JSON.parse(readFileSync(join(PWA, 'package.json'), 'utf8'));

let tmp, old, next, live, newLoader, oldLoader, server, browser;
let blockNewLoader = false;
const loaderFetches = [];

function point(dir) {
  try {
    unlinkSync(live);
  } catch {
    /* first */
  }
  symlinkSync(dir, live);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-loader-move-'));
  old = join(tmp, 'old');
  next = join(tmp, 'next');
  // The newer release speaks another page <-> loader contract than the older one: it needs its own loader.
  const api = Number(readFileSync(join(PWA, 'src', 'sw.js'), 'utf8').match(/const LOADER_API = \/\*__LOADER_API__\*\/ (\d+);/)[1]);
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', old, '--version', OLD_VERSION, '--loader-note', 'older release', '--quiet', '--engine', 'fake'], { cwd: PWA });
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', next, '--version', pkg.version, '--loader-api', String(api + 1), '--quiet', '--engine', 'fake'], { cwd: PWA });
  const loaderOf = (dir) => readFileSync(join(dir, 'lib', 'version.js'), 'utf8').match(/LOADER = "(sw-[0-9a-f]+\.js)"/)[1];
  oldLoader = loaderOf(old);
  newLoader = loaderOf(next);
  assert.notEqual(oldLoader, newLoader, 'this tree brings a new loader');
  live = join(tmp, 'live');
  server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path.endsWith(`/${newLoader}`)) {
      // Refused only when the browser fetches it to install it (Service-Worker: script): Update's
      // own check that the loader can be fetched, a plain page request, still passes.
      const refuse = blockNewLoader && req.headers['service-worker'] === 'script';
      loaderFetches.push(refuse ? 'refused' : 'served');
      if (refuse) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        return res.end('busy');
      }
    }
    if (!path.startsWith(BASE)) {
      res.writeHead(404);
      return res.end();
    }
    let rp = decodeURIComponent(path.slice(BASE.length));
    if (rp === '' || rp.endsWith('/')) rp += 'index.html';
    const root = live;
    const full = normalize(join(root, rp));
    if (!full.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    try {
      if (!(await stat(full)).isFile()) throw new Error('dir');
      res.writeHead(200, { 'Content-Type': mimeFor(full), 'Cache-Control': 'max-age=600' });
      res.end(await readFile(full));
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  browser = await launch();
  console.log(`# ${OLD_VERSION} (${oldLoader}) -> ${pkg.version} (${newLoader}) on ${URL_}`);
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** The older release installed with a wallet, then Check for updates -> Update to this tree. Returns {page, password}. */
async function installOldThenUpdate(label, { refuseLoaderAfterCheck = false } = {}) {
  point(old);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  await page.goto(URL_);
  for (let i = 0; i < 120; i++) {
    if ((await page.evaluate(() => window.__campfire && window.__campfire.screen()).catch(() => null)) === 'welcome') break;
    await sleep(1000);
  }
  const password = `move-${randomBytes(6).toString('hex')}`;
  await createWallet(page, { password });
  await waitScreen(page, 'home', 5 * 60000);
  point(next);
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('check-updates'));
  try {
    await page.waitForSelector(tid('update-apply-sheet'), { timeout: 120000 });
  } catch (e) {
    console.log(`# no Update offered; screen: ${(await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\n/g, ' / ')}; loader fetches ${JSON.stringify(loaderFetches)}`);
    throw e;
  }
  // The update is downloaded and verified; from here the new loader cannot be fetched.
  if (refuseLoaderAfterCheck) blockNewLoader = true;
  try {
    await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.click(tid('update-apply-sheet'))]);
  } catch (e) {
    console.log(`# no reload after Update; screen: ${(await page.evaluate(() => document.body.innerText)).slice(0, 500).replace(/\n/g, ' / ')}; loader fetches ${JSON.stringify(loaderFetches)}`);
    throw e;
  }
  await shot(page, `${label}-after-update`);
  return { page, password };
}

const controller = (page) => page.evaluate(() => (navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL.split('/').pop() : null));

/** Buy FIRO opens with nothing left to finish and no request refused by the page's policy. */
async function buyOpens(page, label) {
  await page.evaluate(() => window.__campfire.go('buyFiro'));
  await waitScreen(page, 'buyFiro', 30000);
  // Either buyfiro.app answered with its coins, or it said it could not be reached: both are an answer.
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="buy-coin"]');
    return document.querySelector('[data-testid="buy-assets-why"]') || (b && b.textContent.trim() && !/…|Choose/.test(b.textContent));
  }, null, { timeout: 60000 });
  assert.equal(await page.isVisible(tid('buy-update-finish')), false, 'nothing left to finish');
  const answered = !(await page.isVisible(tid('buy-assets-why')));
  console.log(`# ${label}: buyfiro.app ${answered ? 'answered' : `did not answer (${(await page.textContent(tid('buy-assets-why'))).slice(0, 120)})`}`);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations.filter((v) => /buyfiro/.test(v))), [], 'the page policy allows the buy API');
  await shot(page, `${label}-buy`);
}

test('after Update the page reloads into the new loader while locked; Buy FIRO opens in the same session', { timeout: 15 * 60000 }, async () => {
  blockNewLoader = false;
  const { page, password } = await installOldThenUpdate('loader-move');
  // The page that came back from Update runs under the older release's loader; once the new
  // one takes over, the still-locked page loads again under it by itself.
  await page.waitForFunction(() => window.__campfire && window.__campfire.loaderBehind() === false, null, { timeout: 60000 });
  assert.equal(await controller(page), newLoader);
  assert.equal(await page.evaluate(() => window.__campfire.intrusion()), null, 'the move is not a takeover');
  await unlockWithPassword(page, password);
  await waitScreen(page, 'home', 60000);
  await sleep(11000);
  assert.equal(await page.isVisible(tid('update-finishing')), false, 'nothing left to finish');
  await buyOpens(page, 'loader-move');
  await page.context().close();
});

test('the new loader unreachable when the browser installs it: Home says one step is left, Buy still works, "Finish now" moves the page', { timeout: 15 * 60000 }, async () => {
  blockNewLoader = false;
  const { page, password } = await installOldThenUpdate('loader-stuck', { refuseLoaderAfterCheck: true });
  await waitScreen(page, 'unlock', 60000);
  await sleep(5000);
  assert.equal(await controller(page), oldLoader, 'the older loader still serves');
  assert.ok(loaderFetches.includes('refused'), 'the install fetch was refused');
  await unlockWithPassword(page, password);
  await waitScreen(page, 'home', 60000);
  await page.waitForSelector(tid('update-finishing'), { timeout: 30000 });
  assert.match(await page.textContent(tid('update-finishing')), /One step left to finish the update/);
  await shot(page, 'loader-stuck-home');
  // Both loaders allow buyfiro.app, so Buy works before the move: no "finish the update" prompt
  // unless buyfiro.app itself could not be reached.
  await page.evaluate(() => window.__campfire.go('buyFiro'));
  await waitScreen(page, 'buyFiro', 30000);
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-testid="buy-coin"]');
    return document.querySelector('[data-testid="buy-assets-why"]') || (b && b.textContent.trim() && !/…|Choose/.test(b.textContent));
  }, null, { timeout: 60000 });
  const reached = !(await page.isVisible(tid('buy-assets-why')));
  if (reached) assert.equal(await page.isVisible(tid('buy-update-finish')), false, 'no false "finish the update" while Buy works');
  else assert.ok(await page.isVisible(tid('buy-update-finish')), 'Buy failed while behind: it offers to finish');
  console.log(`# before the move buyfiro.app ${reached ? 'answered' : 'did not answer'}`);
  await shot(page, 'loader-stuck-buy');
  // The address answers again; the person taps Finish now on Home.
  await page.evaluate(() => window.__campfire.go('home'));
  await page.waitForSelector(tid('update-finish'), { timeout: 30000 });
  blockNewLoader = false;
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.click(tid('update-finish'))]);
  await page.waitForFunction(() => window.__campfire && window.__campfire.loaderBehind() === false, null, { timeout: 90000 });
  assert.equal(await controller(page), newLoader);
  assert.equal(await page.evaluate(() => window.__campfire.intrusion()), null);
  await unlockWithPassword(page, password);
  await waitScreen(page, 'home', 60000);
  assert.equal(await page.isVisible(tid('update-finishing')), false, 'nothing left to finish');
  await buyOpens(page, 'loader-stuck');
  await page.context().close();
});
