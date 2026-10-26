// Languages, end to end: the installed Google Chrome (headless), its own build and port, a throwaway
// wallet on the stand-in engine. The device says German; the person picks Spanish on the first screen,
// then goes back to "like this device" in Settings.
//
//   node --test --test-concurrency=1 test/e2e/languages.test.mjs   (own build folder and port 8829)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome } from './flows.mjs';

const PORT = 8829;
const tid = (id) => `[data-testid="${id}"]`;
const catalog = (lang) => JSON.parse(readFileSync(join(PWA, 'src', 'i18n', `${lang}.json`), 'utf8'));
const DE = catalog('de');
const ES = catalog('es');

let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-lang-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'de-DE' });
  ({ page, rec } = await recordedPage(ctx, { label: 'languages' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const text = (sel) => page.textContent(sel).then((s) => s.trim());
const htmlLang = () => page.evaluate(() => document.documentElement.lang);

test("first screen: the device's language, never asked; the language control at the top changes it at once and keeps it", { timeout: 10 * 60000 }, async () => {
  await page.goto(srv.url);
  await waitScreen(page, 'welcome', 120000);
  assert.equal(await htmlLang(), 'de');
  assert.equal(await text(tid('create')), DE['Create a new wallet'], 'German, from the device');
  assert.equal(await page.inputValue(tid('welcome-lang')), 'de', 'the control names what is shown');
  assert.equal(await page.evaluate(() => localStorage.getItem('campfire-lang')), null, 'nothing saved: like this device');
  await shot(page, 'lang-01-welcome-device-german');
  // Each language is named in its own script.
  const names = await page.$$eval(`${tid('welcome-lang')} option`, (os) => os.map((o) => [o.value, o.textContent, o.lang]));
  assert.ok(names.some(([v, n, l]) => v === 'ja' && n === '日本語' && l === 'ja'));
  assert.ok(names.some(([v, n]) => v === 'ru' && n === 'Русский'));
  await page.selectOption(tid('welcome-lang'), 'es');
  await page.waitForFunction((want) => document.querySelector('[data-testid="create"]').textContent.trim() === want, ES['Create a new wallet']);
  assert.equal(await htmlLang(), 'es');
  assert.equal(await page.inputValue(tid('welcome-lang')), 'es');
  assert.equal(await page.evaluate(() => localStorage.getItem('campfire-lang')), 'es', 'kept, as Settings would');
  await shot(page, 'lang-02-welcome-spanish');
  await page.reload();
  await waitScreen(page, 'welcome', 120000);
  assert.equal(await htmlLang(), 'es', 'from the first paint (lang-boot.js)');
  assert.equal(await text(tid('create')), ES['Create a new wallet']);
});

test('Settings -> Language: the choice is shown; "like this device" goes back to the device\'s language at once', { timeout: 10 * 60000 }, async () => {
  await createWallet(page, { password: 'lang-test-pass-1', words: 12 });
  await waitHome(page);
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  assert.equal(await page.inputValue(tid('lang-select')), 'es');
  assert.equal(await page.$(tid('lang-device')), null, 'a chosen language: no device note');
  await page.selectOption(tid('lang-select'), 'system');
  await page.waitForFunction(() => document.documentElement.lang === 'de');
  await sleep(300);
  assert.equal(await page.inputValue(tid('lang-select')), 'system', 'redrawn with the choice kept');
  assert.equal(await text(tid('lang-device')), 'Deutsch', "the device's language, named in it");
  assert.equal(await page.evaluate(() => localStorage.getItem('campfire-lang')), null, 'forgotten: like this device');
  assert.equal(await text(`${tid('lang-row')} .t`), DE.Language);
  await shot(page, 'lang-03-settings-like-device');
});

test('privacy: the catalogs come from this app\'s own address only', () => {
  assert.deepEqual(foreignHosts(rec, srv.url).filter((h) => !/coingecko/.test(h)), []);
  assert.ok(rec.requests.some((u) => /\/i18n\/es\.json$/.test(u)) && rec.requests.some((u) => /\/i18n\/de\.json$/.test(u)));
  assert.deepEqual(rec.errors, []);
});
