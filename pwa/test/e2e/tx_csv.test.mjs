// Activity -> Save as CSV, end to end: the installed Google Chrome (headless), its own build and
// port, the stand-in engine (lib/backend_fake.js: no network, no real funds).
//
//   npm run e2e:tx-csv   (own build folder and port 8829)
//
// The empty wallet's plain answer first; then a history made with the stand-in's test controls
// (money in privately with a memo that holds a comma, money in publicly, a payment sent, the public
// balance privatized), and the downloaded file is read back. One tap from Activity: the file goes to
// the share sheet, or (here: a computer without one) to the downloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced } from './flows.mjs';

const PORT = 8829;
const tid = (id) => `[data-testid="${id}"]`;

let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-csv-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  // A computer without a share sheet for files: the file is downloaded.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
  });
  ({ page, rec } = await recordedPage(ctx, { label: 'csv' }));
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

const toastText = () => page.evaluate(() => document.querySelector('.toast')?.textContent || '');

test('an empty wallet: one tap from Activity, and a plain answer, never a dead end', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: `csv-${Math.random().toString(36).slice(2, 10)}` });
  await waitHome(page);
  await waitSynced(page);
  await page.evaluate(() => window.__campfire.go('activity'));
  await waitScreen(page, 'activity');
  // The way in is on screen on a 375 x 667 phone.
  await page.setViewportSize({ width: 375, height: 667 });
  const box = await page.locator(tid('activity-csv')).boundingBox();
  assert.ok(box && box.y + box.height <= 667, 'Save as CSV fits a small phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await both('csv-01-activity');
  await page.click(tid('activity-csv'));
  await page.waitForFunction(() => /No payments to save yet/.test(document.querySelector('.toast')?.textContent || ''));
});

test('a history: every payment, newest first, memos quoted, the file read back', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(async () => {
    window.__firoFake.credit({ to: 'private', amount: '50000000', memo: 'rent, October' });
    window.__firoFake.credit({ to: 'public', amount: '30000000' });
    window.__firoFake.mine();
  });
  await page.waitForFunction(() => window.__campfire.txs().length === 2 && window.__campfire.txs().every((t) => t.confirmations >= 1));
  await page.evaluate(async () => {
    const { wallet } = await import('./lib/wallet.js');
    await wallet.send({ from: 'private', to: [{ address: '@satoshi', amount: 20000000n }] });
    await wallet.privatize('all');
    window.__firoFake.mine();
  });
  await page.waitForFunction(() => window.__campfire.txs().length === 4 && window.__campfire.txs().every((t) => t.confirmations >= 1));
  await page.evaluate(() => window.__campfire.go('activity'));
  await waitScreen(page, 'activity');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(tid('activity-csv'))]);
  assert.match(dl.suggestedFilename(), /^campfire-firo-payments-\d{4}-\d\d-\d\d\.csv$/);
  const file = join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith('﻿'));
  const lines = text.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines.length, 5, 'header + 4 payments');
  assert.equal(lines[0], 'Date | Time,Type,Balance,"Amount, FIRO","Fee, FIRO","Net change, FIRO",Memo,Address,Status,Block,Transaction ID');
  const body = lines.slice(1).join('\n');
  assert.match(body, /,Privatized,Public → Private,0\.2999,0\.0001,-0\.0001,,,Confirmed \(\d+\),\d+,[0-9a-f]{64}/);
  assert.match(body, /,Sent,Private,0\.2,0\.0002,-0\.2002,,sm1[a-z0-9]+,Confirmed/);
  assert.match(body, /,Received,Public,0\.3,0,0\.3,,a[1-9A-HJ-NP-Za-km-z]{33},Confirmed/);
  assert.match(body, /,Received,Private,0\.5,0,0\.5,"rent, October",,Confirmed/);
  assert.match(await toastText(), /downloads/i);
  await both('csv-02-saved');
});

test('privacy: nothing leaves the device; no host but the origin (the stand-in reaches no server); no CSP violation; no page error', async () => {
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
