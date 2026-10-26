// Settings -> Theme, end to end: the installed Google Chrome (headless), its own build and port, a
// throwaway wallet on the stand-in engine. The device's own light / dark is emulated.
//
//   npm run e2e:theme   (own build folder and port 8828)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome } from './flows.mjs';

const PORT = 8828;
const tid = (id) => `[data-testid="${id}"]`;
const LIGHT_BG = 'rgb(255, 241, 241)';
const DARK_BG = 'rgb(22, 26, 41)';

let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-theme-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' });
  ({ page, rec } = await recordedPage(ctx, { label: 'theme' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const bars = () => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content')));

test('first screen: like the device until Dark is saved; then dark from the first paint, whatever the device says', { timeout: 10 * 60000 }, async () => {
  await page.goto(srv.url);
  await waitScreen(page, 'welcome', 120000);
  assert.equal(await bg(), LIGHT_BG, 'a light device: light');
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await bg(), DARK_BG, 'a dark device: dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => localStorage.setItem('campfire-theme', 'dark'));
  // Before app.js runs: the attribute theme-boot.js set while the page head was read.
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive' && !window.__atInteractive) window.__atInteractive = { theme: document.documentElement.dataset.theme || null, bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() };
    });
  });
  await page.reload();
  await waitScreen(page, 'welcome', 120000);
  assert.deepEqual(await page.evaluate(() => window.__atInteractive), { theme: 'dark', bg: '#161a29' }, 'dark as soon as the page is read');
  assert.equal(await bg(), DARK_BG);
  assert.deepEqual(await bars(), ['#161a29', '#161a29'], 'the browser bar too');
  await shot(page, 'theme-01-welcome-forced-dark');
});

test('Settings -> Theme: Light, Dark and Like this device, at once, and kept after a reload', { timeout: 15 * 60000 }, async () => {
  await page.evaluate(() => localStorage.removeItem('campfire-theme'));
  await page.reload();
  await waitScreen(page, 'welcome', 120000);
  await createWallet(page, { password: `theme-${Math.random().toString(36).slice(2, 10)}` });
  await waitHome(page);
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.locator(tid('theme-row')).scrollIntoViewIfNeeded();
  assert.equal(await page.inputValue(tid('theme-select')), 'system');
  assert.deepEqual(await page.$$eval(`${tid('theme-select')} option`, (o) => o.map((x) => x.textContent)), ['Like this device', 'Light', 'Dark']);

  await page.selectOption(tid('theme-select'), 'dark');
  assert.equal(await bg(), DARK_BG, 'at once, on a light device');
  assert.equal(await page.evaluate(() => localStorage.getItem('campfire-theme')), 'dark');
  await shot(page, 'theme-02-settings-dark');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.selectOption(tid('theme-select'), 'light');
  assert.equal(await bg(), LIGHT_BG, 'Light on a dark device');
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light', 'native controls light too');
  await shot(page, 'theme-03-settings-light-on-dark-device');

  // Kept: after a reload (the wallet locks), the unlock screen is already light.
  await page.reload();
  await waitScreen(page, 'unlock', 120000);
  assert.equal(await bg(), LIGHT_BG);
  assert.deepEqual(await bars(), ['#fff1f1', '#fff1f1']);

  // Like this device: follows the (dark) device again and forgets the choice.
  await page.evaluate(async () => (await import('./lib/theme.js')).setTheme('system'));
  assert.equal(await bg(), DARK_BG);
  assert.equal(await page.evaluate(() => localStorage.getItem('campfire-theme')), null);
  assert.deepEqual(await bars(), ['#fff1f1', '#161a29'], 'each bar colour for its own device mode');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await bg(), LIGHT_BG);
});

test('privacy: no host but the origin; no CSP violation; no page error', async () => {
  await sleep(200);
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
