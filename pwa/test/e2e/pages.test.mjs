// GitHub Pages, emulated: the app under a sub-path (/campfire-firo-pwa/) on a static host that
// sends NO security headers, like https://vsnation.github.io/campfire-firo-pwa/. The engine is the
// stand-in (the host answers __dev/flags with fakeBackend, lib/chain.js), so nothing here needs
// the network.
//
//   npm run e2e:pages
//
// 1. First open: the setup screen (never "this browser can't run it"), the verified copy installs
//    under the sub-path scope, one reload, and the page is cross-origin isolated (COOP/COEP come
//    from the service worker).
// 2. Create a wallet through the screens -> Home, Synced; after install nothing but the browser's
//    own requests reach the host.
// 3. Restore the same words in a fresh profile -> the same wallet (same receive addresses), Synced.
// 4. Check for updates works under the sub-path (up to date).
// 5. An older release (installed, with a wallet) takes this one through Check for updates; the
//    loader moves once, no false alarm. The publicly served release when there is one that
//    verifies with this app's key; until then an older build of this tree with another loader.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PWA, launch, recordedPage, shot, waitScreen, sleep, SHOTS } from './harness.mjs';
import { createWallet, waitSynced } from './flows.mjs';
import { startStaticHost } from './static_host.mjs';
import { verifyReleaseSignature, verifyManifest, verifyFile, compareVersions } from '../../src/lib/release.js';

const PORT = Number(process.env.CAMPFIRE_PAGES_PORT || 8797); // and PORT + 1
// TODO(owner): the public copy (github.com/vsnation/campfire-firo-pwa with Pages on) does not exist yet.
const PUBLIC = 'https://vsnation.github.io/campfire-firo-pwa/';
const BASE = '/campfire-firo-pwa/';
const PASSWORD = `pages-${Math.random().toString(36).slice(2, 10)}`;
const tid = (id) => `[data-testid="${id}"]`;
const pkg = JSON.parse(readFileSync(join(PWA, 'package.json'), 'utf8'));
const pub = JSON.parse(readFileSync(join(PWA, 'keys', 'release_public.jwk'), 'utf8'));
const screenOf = (page) => page.evaluate(() => document.getElementById('app')?.dataset.screen || null);

let tmp, rel, host, browser;
let words = null;
let receiveBefore = null;

async function freshPage(label) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
  const { page, rec } = await recordedPage(ctx, { label });
  return { ctx, page, rec };
}

/** Restore with words through the screens: Welcome -> words -> password -> (no Face ID) -> Home. */
async function restoreThroughScreens(page, w) {
  await waitScreen(page, 'welcome', 120000);
  await page.click(tid('restore'));
  await waitScreen(page, 'restore');
  await page.fill(tid('word-1'), w.join(' '));
  await page.waitForFunction(() => !document.querySelector('[data-testid="restore-submit"]').disabled, null, { timeout: 30000 });
  await page.click(tid('restore-submit'));
  await waitScreen(page, 'setPassword');
  await page.fill(tid('pw1'), PASSWORD);
  await page.fill(tid('pw2'), PASSWORD);
  await page.click(tid('save-password'));
  for (let t0 = Date.now(); Date.now() - t0 < 60000; ) {
    const s = await screenOf(page);
    if (s === 'home') return;
    if (s === 'passkeySetup') await page.click(tid('passkey-skip')).catch(() => {});
    await sleep(300);
  }
  throw new Error('Home did not open after restoring');
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-pages-'));
  rel = join(tmp, 'rel');
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', rel, '--version', pkg.version, '--quiet', '--engine', 'fake'], { cwd: PWA });
  host = await startStaticHost({ root: rel, port: PORT, base: BASE });
  browser = await launch();
  console.log(`# Pages emulation at ${host.url}, release ${pkg.version}; screenshots: ${SHOTS}`);
});

after(async () => {
  if (browser) await browser.close();
  if (host) await host.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('first open on a header-less static host: setup screen, install under the sub-path, then cross-origin isolated', { timeout: 180000 }, async () => {
  const { ctx, page } = await freshPage('pages-1');
  const screens = [];
  host.setDelay(120); // a slower line, so the first run can be seen and photographed
  await page.goto(host.url);
  const t0 = Date.now();
  // Record every screen until Welcome; "problem" must never appear.
  while (Date.now() - t0 < 120000) {
    const s = await screenOf(page).catch(() => null);
    if (s && screens[screens.length - 1] !== s) screens.push(s);
    if (s === 'install' && !screens.includes('install-shot')) {
      const iso = await page.evaluate(() => self.crossOriginIsolated);
      assert.equal(iso, false, 'the first, unverified load has no isolation (no server headers)');
      await page.waitForFunction(() => Number(document.querySelector('main.install')?.dataset.done || 0) >= 5, null, { timeout: 60000, polling: 100 }).catch(() => {});
      await shot(page, 'pages-01-first-run').catch(() => console.log('# (the page reloaded before the screenshot)'));
      screens.push('install-shot');
    }
    if (s === 'welcome') break;
    await sleep(100);
  }
  console.log(`# screens on first open: ${screens.filter((x) => x !== 'install-shot').join(' -> ')}`);
  assert.ok(screens.includes('install'), 'the setup screen came first');
  assert.ok(!screens.includes('problem'), 'never "this browser can\'t run Firo PWA"');
  const env = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { iso: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, controller: navigator.serviceWorker.controller && new URL(navigator.serviceWorker.controller.scriptURL).pathname, scope: reg && new URL(reg.scope).pathname };
  });
  console.log(`# after the reload: ${JSON.stringify(env)}`);
  assert.equal(env.iso, true, 'cross-origin isolated: the service worker added COOP/COEP');
  assert.equal(env.sab, 'function');
  assert.match(env.controller, new RegExp(`^${BASE}sw-[0-9a-f]{16}\\.js$`));
  assert.equal(env.scope, BASE);
  await shot(page, 'pages-02-welcome');
  host.setDelay(0);
  await ctx.close();
});

test('create a wallet on the Pages host: Home, Synced, and only the browser\'s own requests reach the host', { timeout: 5 * 60000 }, async () => {
  const { ctx, page, rec } = await freshPage('pages-2');
  await page.goto(host.url);
  await waitScreen(page, 'welcome', 120000);
  const from = host.requests.length;
  const r = await createWallet(page, { password: PASSWORD });
  words = r && Array.isArray(r.words) ? r.words : null;
  await waitScreen(page, 'home', 60000);
  await waitSynced(page, 120000);
  receiveBefore = await page.evaluate(() => window.__campfire.receive());
  assert.match(receiveBefore.spark || '', /^sm1/, 'a Spark receive address');
  assert.equal(await page.evaluate(() => window.__campfire.engine()), 'fake', 'the stand-in engine (no network in this suite)');
  await shot(page, 'pages-03-home-synced');
  const app = host.requests.slice(from).filter((x) => !(x.sw === 'script') && !(x.dest === 'document' && x.path === BASE) && x.path !== `${BASE}__dev/flags`);
  assert.deepEqual(app, [], 'after install, nothing but the browser\'s own requests (and the dev flag) reached the host');
  assert.deepEqual(rec.websockets, [], 'the stand-in opens no socket');
  assert.deepEqual(rec.errors, []);
  await ctx.close();
});

test('restore the same words on the Pages host: the same wallet, Synced', { timeout: 5 * 60000 }, async (t) => {
  if (!words) return t.skip('the create flow did not hand back the words');
  const { ctx, page, rec } = await freshPage('pages-3');
  await page.goto(host.url);
  await restoreThroughScreens(page, words);
  await waitSynced(page, 120000);
  const after = await page.evaluate(() => window.__campfire.receive());
  assert.equal(after.spark, receiveBefore.spark, 'the same words open the same wallet');
  assert.equal(after.transparent, receiveBefore.transparent);
  await shot(page, 'pages-04-restored');
  assert.deepEqual(rec.errors, [], 'no crash');
  await ctx.close();
});

test('check for updates works under the sub-path', { timeout: 120000 }, async () => {
  const { ctx, page } = await freshPage('pages-4');
  await page.goto(host.url);
  await waitScreen(page, 'welcome', 120000);
  // The update check itself is the worker's: ask it directly.
  const r = await page.evaluate(() => new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => resolve(e.data);
    navigator.serviceWorker.controller.postMessage({ type: 'check-update' }, [ch.port2]);
  }));
  console.log(`# update check on the Pages host: ${JSON.stringify(r)}`);
  assert.equal(r.result, 'none', 'the signed release under the sub-path verifies and is this one');
  await ctx.close();
});

/** The publicly served release, downloaded and checked file by file; null when there is none that verifies with this app's key. */
async function publicRelease(dir) {
  try {
    const get = async (p) => {
      const r = await fetch(new URL(p, PUBLIC), { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const relBytes = await get('release.json');
    const sig = await get('release.sig');
    const release = await verifyReleaseSignature(relBytes, new TextDecoder().decode(sig), pub);
    const manifestBytes = await get('manifest.json');
    const manifest = await verifyManifest(release, manifestBytes);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'release.json'), relBytes);
    writeFileSync(join(dir, 'release.sig'), sig);
    writeFileSync(join(dir, 'manifest.json'), manifestBytes);
    for (const f of manifest.files) {
      const b = await get(f.path);
      await verifyFile(f, b);
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), b);
    }
    return { version: release.version, files: manifest.files.length };
  } catch (e) {
    console.log(`# no public release to start from (${e.message}); an older build of this tree stands in`);
    return null;
  }
}

test('an older release (installed, with a wallet) takes this one through Check for updates; the page settles under a loader that serves it, no false alarm', { timeout: 10 * 60000 }, async () => {
  const old = join(tmp, 'old');
  let oldVersion;
  const found = await publicRelease(old);
  if (found) oldVersion = found.version;
  else {
    // A lower version with other loader bytes: the update must move the page to this release's loader.
    const v = pkg.version.split('.').map(Number);
    oldVersion = v[2] > 0 ? `${v[0]}.${v[1]}.${v[2] - 1}` : `${v[0]}.${Math.max(0, v[1] - 1)}.99`;
    if (compareVersions(oldVersion, pkg.version) >= 0) oldVersion = '0.0.1';
    execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', old, '--version', oldVersion, '--loader-note', 'older release', '--quiet', '--engine', 'fake'], { cwd: PWA });
  }
  const oldLoader = readFileSync(join(old, 'lib', 'version.js'), 'utf8').match(/LOADER = "(sw-[0-9a-f]+\.js)"/)[1];
  // Update to this tree, or to the next patch after the public one when it is already this version or later.
  let next = rel;
  let nextVersion = pkg.version;
  if (compareVersions(oldVersion, pkg.version) >= 0) {
    const v = oldVersion.split('.').map(Number);
    nextVersion = `${v[0]}.${v[1]}.${v[2] + 1}`;
    next = join(tmp, 'rel-next');
    execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', next, '--version', nextVersion, '--quiet', '--engine', 'fake'], { cwd: PWA });
  }

  // Serve the older one like Pages does, install it, and make a wallet with it.
  const live = join(tmp, 'live');
  const point = (dir) => {
    try {
      unlinkSync(live);
    } catch {
      /* first */
    }
    symlinkSync(dir, live);
  };
  point(old);
  const host2 = await startStaticHost({ root: live, port: PORT + 1, base: BASE });
  try {
    const { ctx, page, rec } = await freshPage('pages-upd');
    const served = async () => (await page.evaluate(() => fetch('lib/version.js', { cache: 'no-store' }).then((r) => r.text()))).match(/APP_VERSION = "([^"]+)"/)[1];
    await page.goto(host2.url);
    await waitScreen(page, 'welcome', 120000);
    assert.equal(await served(), oldVersion);
    assert.equal(await page.evaluate(() => self.crossOriginIsolated), true, `${oldVersion} runs isolated on the static host`);
    await createWallet(page, { password: PASSWORD });
    await waitScreen(page, 'home', 60000);
    await waitSynced(page, 120000);
    const before = await page.evaluate(() => window.__campfire.receive());

    // The host now serves the newer release. The person taps Check for updates, then Update.
    point(next);
    await page.evaluate(() => window.__campfire.go('settings'));
    await waitScreen(page, 'settings');
    await page.click(tid('check-updates'));
    await page.waitForSelector(tid('update-apply-sheet'), { timeout: 120000 });
    await shot(page, 'pages-06-update-ready');
    await Promise.all([page.waitForEvent('load', { timeout: 60000 }), page.click(tid('update-apply-sheet'))]);
    await waitScreen(page, 'unlock', 120000);
    // The newer release's loader has another name. One that serves pages the same way (the same
    // loader_compat, as here: only a note differs) may keep serving the new release - the page is
    // then not "behind" and needs no move; an incompatible one moves the page once. Neither is a
    // takeover. A locked page reloads as soon as a new loader takes over (lib/loader.js onMoved), so
    // wait until it settles - across that reload - before reading anything.
    const loader = readFileSync(join(next, 'lib', 'version.js'), 'utf8').match(/LOADER = "(sw-[0-9a-f]+\.js)"/)[1];
    if (loader !== oldLoader) {
      for (let t0 = Date.now(); ; ) {
        const settled = await page
          .evaluate(() => Boolean(navigator.serviceWorker.controller && window.__campfire && window.__campfire.loaderBehind() === false && document.getElementById('app')?.dataset.screen === 'unlock'))
          .catch(() => false);
        if (settled) break;
        if (Date.now() - t0 > 60000) {
          const why = await page.evaluate(() => ({ controller: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL, behind: window.__campfire && window.__campfire.loaderBehind(), screen: document.getElementById('app')?.dataset.screen })).catch((e) => String(e));
          throw new Error(`the page did not settle under ${loader}: ${JSON.stringify(why)}`);
        }
        await sleep(250);
      }
    }
    assert.equal(await served(), nextVersion, `the installed ${oldVersion} now runs ${nextVersion}`);
    assert.equal(await page.evaluate(() => window.__campfire.intrusion()), null, 'the approved move to the new loader is not mistaken for a takeover');
    assert.equal(await page.evaluate(() => self.crossOriginIsolated), true);
    await page.fill(tid('unlock-pw'), PASSWORD);
    await page.click(tid('unlock-submit'));
    await waitScreen(page, 'home', 60000);
    await waitSynced(page, 120000);
    assert.deepEqual(await page.evaluate(() => window.__campfire.receive()), before, 'the same wallet, after the update');
    console.log(`# ${oldVersion} (${oldLoader}) -> ${nextVersion} (${loader}) through Check for updates on the static host: wallet kept, Synced, no tripwire`);
    await shot(page, 'pages-07-after-update');
    // A cold start after the move: still this release, still no alarm.
    await page.reload();
    await waitScreen(page, 'unlock', 60000);
    assert.equal(await served(), nextVersion);
    assert.equal(await page.evaluate(() => window.__campfire.intrusion()), null);
    assert.deepEqual(rec.errors, []);
    await ctx.close();
  } finally {
    await host2.stop();
  }
});
