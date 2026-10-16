// The tripwire at the earliest moment: the app's web address swaps the loader (other bytes under
// the same sw-<hash>.js name: the only way code Campfire did not sign gets in) while a page is
// still starting. The new worker takes over at once (skipWaiting + clients.claim), so every
// module the page has not fetched yet comes from it. The app's own watch (lib/loader.js
// watchLoader) runs only after all of its modules have loaded; the first watch must come from
// index.html's classic loader-watch.js, before any module.
//
//   npm run e2e:tripwire   (own build, port 8834; the stand-in engine; nothing spent)
//
// 1. First open: the verified copy installs; Welcome.
// 2. Cold start with the takeover landing after index.html's classic scripts ran but before any
//    module of the app loaded (the page's main thread busy for 3 s as the module script is parsed:
//    a slow phone): the page stops and says the address serves code Campfire did not sign. No
//    screen of the app (no password field) ever shows.
// 3. An Update that brings a new loader, from an address that serves the signed loader to the
//    page's check but other bytes under the same name to the browser's install fetch
//    (Service-Worker: script): the page moves, then checks the loader it now runs under and stops
//    with the warning instead of reloading into it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { PWA, launch, recordedPage, waitScreen, shot, sleep, SHOTS } from './harness.mjs';
import { headersFor, mimeFor } from '../../tools/headers.mjs';

const PORT = Number(process.env.CAMPFIRE_TRIPWIRE_PORT || 8834);
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const TRIPWIRE = "This app's web address is serving code Firo PWA did not sign. Don't enter your password here.";
const HOSTILE_SW = `// not Campfire
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => e.respondWith(new Response('<h1>Not Campfire</h1>', { headers: { 'Content-Type': 'text/html' } })));
`;

let tmp, rel, loader, server, browser, ctx;
let mode = 'normal';
let root = null;
let variant = null; // {name, bytes}: other bytes under that loader name, for the browser's install fetch only
const reqs = [];

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-tripwire-'));
  rel = join(tmp, 'rel');
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', rel, '--quiet', '--engine', 'fake', '--mirrors', 'none'], { cwd: PWA });
  loader = loaderOf(rel);
  root = rel;
  server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    reqs.push({ path, sw: String(req.headers['service-worker'] || ''), mode });
    const send = (code, body, type) => {
      res.writeHead(code, { ...headersFor(path), 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(body);
    };
    if (mode === 'hostile' && path === `/${loader}`) return send(200, HOSTILE_SW, 'application/javascript');
    if (variant && path === `/${variant.name}` && req.headers['service-worker'] === 'script') return send(200, variant.bytes, 'text/javascript; charset=utf-8');
    let rp = decodeURIComponent(path);
    if (rp.endsWith('/')) rp += 'index.html';
    const full = normalize(join(root, rp));
    if (!full.startsWith(root + sep)) return send(403, 'no', 'text/plain');
    try {
      if (!(await stat(full)).isFile()) throw new Error('dir');
      send(200, await readFile(full), mimeFor(full));
    } catch {
      send(404, 'not found', 'text/plain');
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
  console.log(`# loader ${loader} at ${ORIGIN}; screenshots: ${SHOTS}`);
});

function loaderOf(dir) {
  return readFileSync(join(dir, 'lib', 'version.js'), 'utf8').match(/LOADER = "(sw-[0-9a-f]+\.js)"/)[1];
}

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('1. first open: the verified copy installs', { timeout: 5 * 60000 }, async () => {
  const { page } = await recordedPage(ctx, { label: 'install' });
  await page.goto(ORIGIN);
  await waitScreen(page, 'welcome', 180000);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.split('/').pop()), loader);
  await page.close();
});

test('2. the loader is swapped while a page starts: the page stops before any screen of the app and warns', { timeout: 5 * 60000 }, async () => {
  mode = 'hostile';
  const { page, rec } = await recordedPage(ctx, { label: 'takeover' });
  // The browser's loader check, made just as the app's module script is parsed, while the page's
  // main thread is busy for 3 s (a slow phone): the swapped loader takes over before any module
  // of the app has loaded, so they would all come from it.
  await page.addInitScript(() => {
    if (!navigator.serviceWorker) return;
    let reg = null;
    navigator.serviceWorker.getRegistration().then((r) => (reg = r));
    new MutationObserver((list, obs) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (n.tagName !== 'SCRIPT' || n.type !== 'module') continue;
          obs.disconnect();
          window.__takeoverAsked = Boolean(reg);
          if (reg) reg.update().catch(() => {});
          for (const t = Date.now(); Date.now() - t < 3000; );
          return;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const screens = new Set();
  const watch = setInterval(() => {
    page.evaluate(() => document.getElementById('app') && document.getElementById('app').dataset.screen).then((s) => s && screens.add(s), () => {});
  }, 100);
  try {
    const resp = await page.goto(ORIGIN, { waitUntil: 'commit' });
    assert.equal(resp && resp.fromServiceWorker(), true, 'the page itself came from the verified copy');
    await page.waitForFunction((t) => Boolean(document.body && document.body.innerText.includes(t)), TRIPWIRE, { timeout: 60000, polling: 200 }).catch(async (e) => {
      console.log(`# no warning; the page shows: ${(await page.evaluate(() => document.body && document.body.innerText).catch(() => '?')).slice(0, 200).replace(/\n/g, ' / ')}; screens: ${[...screens].join(', ')}`);
      throw e;
    });
    assert.equal(await page.evaluate(() => window.__takeoverAsked), true, 'the takeover started while the page was starting');
    await sleep(3000);
    const now = await page.evaluate(() => ({ text: document.body.innerText, pw: Boolean(document.querySelector('input[type="password"]')), controller: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.split('/').pop() }));
    console.log(`# screens seen: ${[...screens].join(', ') || 'none'}; controller now ${now.controller}`);
    assert.ok(now.text.includes(TRIPWIRE), 'still warning');
    assert.equal(now.pw, false, 'no password field');
    assert.ok(![...screens].some((s) => s !== 'problem'), `no screen of the app opened: ${[...screens].join(', ')}`);
    assert.ok(reqs.some((r) => r.mode === 'hostile' && r.path === `/${loader}`), 'the swapped loader was fetched');
    await shot(page, 'tripwire-early');
    console.log(`# page errors: ${rec.errors.length}`);
  } finally {
    clearInterval(watch);
  }
});

test('3. a new loader whose install fetch gets other bytes than the page checked: after the move the page warns instead of reloading', { timeout: 8 * 60000 }, async () => {
  mode = 'normal';
  const pkg = JSON.parse(readFileSync(join(PWA, 'package.json'), 'utf8'));
  const api = Number(readFileSync(join(PWA, 'src', 'sw.js'), 'utf8').match(/const LOADER_API = \/\*__LOADER_API__\*\/ (\d+);/)[1]);
  const old = join(tmp, 'old');
  const next = join(tmp, 'next');
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', old, '--version', '0.0.8', '--loader-note', 'older release', '--quiet', '--engine', 'fake', '--mirrors', 'none'], { cwd: PWA });
  // Pages of the newer release need its own loader (another page <-> loader contract): the page has to move.
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', next, '--version', pkg.version, '--loader-api', String(api + 1), '--quiet', '--engine', 'fake', '--mirrors', 'none'], { cwd: PWA });
  const newLoader = loaderOf(next);
  root = old;
  const c2 = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
  try {
    const { page } = await recordedPage(c2, { label: 'move' });
    await page.goto(ORIGIN);
    await waitScreen(page, 'welcome', 180000);
    // The address now serves the newer release, and other bytes under its loader's name to the browser's own install fetch.
    root = next;
    variant = { name: newLoader, bytes: readFileSync(join(next, newLoader), 'utf8') + '\n// not the signed bytes\n' };
    const found = await page.evaluate(async () => (await import('./lib/update.js')).updates.check().then((r) => r.result));
    assert.equal(found, 'ready');
    await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.evaluate(async () => (await import('./lib/update.js')).updates.apply())]);
    // The page that came back runs the new release under the old loader and moves to the new one.
    await page.waitForFunction((l) => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.endsWith(`/${l}`), newLoader, { timeout: 60000 });
    assert.ok(reqs.some((r) => r.path === `/${newLoader}` && r.sw === 'script'), 'the browser fetched the loader to install it');
    await page.waitForFunction(() => window.__campfire && window.__campfire.intrusion(), null, { timeout: 30000 });
    await waitScreen(page, 'problem', 10000);
    assert.match(await page.textContent('[data-testid="tripwire"]'), /serving code Firo PWA did not sign/);
    console.log(`# after the move: ${await page.evaluate(() => window.__campfire.intrusion())}`);
    await shot(page, 'tripwire-after-move');
  } finally {
    variant = null;
    await c2.close().catch(() => {});
  }
});

test('a browser without service workers: the published copy does not run unchecked, and says where to open it (P14)', { timeout: 2 * 60000 }, async () => {
  const prevMode = mode;
  mode = 'normal';
  const c2 = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
  try {
    // As in some private windows and apps' built-in browsers: no navigator.serviceWorker at all.
    await c2.addInitScript(() => {
      delete Navigator.prototype.serviceWorker;
    });
    const { page } = await recordedPage(c2, { label: 'no-sw' });
    await page.goto(ORIGIN);
    await waitScreen(page, 'problem', 30000);
    assert.equal(await page.evaluate(() => 'serviceWorker' in navigator), false);
    assert.match(await page.textContent('[data-testid="no-loader"]'), /^This browser cannot keep a checked copy of Firo PWA\. Without one, the wallet would run whatever the web address sends, unchecked, so it does not open\./);
    assert.equal(await page.$('input[type="password"]'), null, 'no password asked');
    assert.match(await page.textContent('[data-testid="no-loader-wallets"]'), /choose Restore and enter its recovery words, or open its backup file with its password/);
    await shot(page, 'tripwire-no-loader');
  } finally {
    await c2.close();
    mode = prevMode;
  }
});

