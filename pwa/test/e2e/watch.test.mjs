// Watch a wallet with its Spark view key, end to end on the stand-in engine: Welcome -> Watch a
// wallet -> key (bad, then good) -> password -> Home says watch-only and Send is off -> Backup has
// nothing to back up.
//
//   npm run e2e:watch   (own build folder and port 8834)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, PWA, SHOTS } from './harness.mjs';
import { waitHome, finishProtect } from './flows.mjs';

const PORT = 8834;
const tid = (id) => `[data-testid="${id}"]`;
const PASSWORD = `watch-${Math.random().toString(36).slice(2, 10)}`;
// A Spark full view key's shape (hex): this one is from test/fixtures/firo_keys.json's first wallet.
const VIEW_KEY = 'd61512b93a47b7c99472dadf5f5d6ace2bde1f993bd96291ea14c7bbd1fb7a1cae0600ddc698666595cb724e70d13baea14c93e279e033e4f54c49a3789dd2578dbaa4b23689486570cd8cbcee316021aa0f41d677ca8612f25c9eb304c3641c0100dd65394b4f1d51a0ab52547675b91f3a60b77f7ded659e28f21ef4ec9c3739990100';
let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-watch-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  ({ page, rec } = await recordedPage(ctx, { label: 'watch' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function both(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('Welcome -> Watch a wallet: a wrong key is named, a view key is taken, then a password', { timeout: 3 * 60000 }, async () => {
  await page.goto(srv.url);
  await waitScreen(page, 'welcome', 60000);
  await page.click(tid('watch'));
  await waitScreen(page, 'watch');
  assert.equal(await page.isDisabled(tid('watch-submit')), true);
  await page.fill(tid('watch-key'), 'not a key');
  assert.match(await page.textContent('[aria-live="polite"]'), /not a Spark view key/);
  assert.equal(await page.isDisabled(tid('watch-submit')), true);
  await page.fill(tid('watch-key'), VIEW_KEY);
  await page.fill(tid('watch-height'), '1300000');
  assert.equal(await page.isDisabled(tid('watch-submit')), false);
  await both('watch-01-key');
  await page.click(tid('watch-submit'));
  await waitScreen(page, 'setPassword');
  await finishProtect(page, { password: PASSWORD });
});

test('Home says watch-only; Send is off; Backup has nothing to back up', { timeout: 3 * 60000 }, async () => {
  await waitHome(page);
  await page.waitForSelector(tid('watch-only-note'));
  assert.equal(await page.isDisabled(tid('send')), true, 'Send is off');
  assert.equal(await page.evaluate(async () => (await import('./lib/wallet.js')).wallet.state.viewOnly), true);
  await both('watch-02-home');
  await page.evaluate(() => window.__campfire.go('backup'));
  await page.waitForSelector(tid('watch-backup'));
  await both('watch-03-backup');
});

test('privacy: no host but the origin; no CSP violation; no page error', async () => {
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
