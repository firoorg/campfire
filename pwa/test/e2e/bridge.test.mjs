// The Bridge screen (FIRO -> rsFIRO on BNB Chain) with the real Rosen module and the stand-in
// engine: the dollar price asked once, the fee lines ("$10 or 0.5%", from where 0.5% applies),
// what arrives, the warning and the refusal for small amounts, the "no refunds" confirmation. The
// stand-in engine cannot sign, so the last step must end with "Nothing was sent"; the real
// signing path is covered by test/unit/rosen_sim.test.mjs and test/fork/rosen_exit.test.mjs.
//
//   npm run e2e:bridge   (own build folder and port 8835)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, fake, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced } from './flows.mjs';
import { ETH_RPC_HOSTS, BSC_RPC_HOSTS } from '../../src/lib/eth/hosts.js';

const PORT = 8835;
const tid = (id) => `[data-testid="${id}"]`;
const PASSWORD = `bridge-${Math.random().toString(36).slice(2, 10)}`;
const EVM = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
let tmp, srv, browser, ctx, page, rec;
let priceAsks = 0;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-bridge-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route((u) => [...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS].some((x) => x.host === u.hostname), (r) => r.abort());
  await ctx.route((u) => u.hostname === 'api.coingecko.com', (r) => {
    priceAsks++;
    return r.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ zcoin: { usd: 0.9486 } }) });
  });
  ({ page, rec } = await recordedPage(ctx, { label: 'bridge' }));
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

async function amount(v) {
  await page.fill(tid('bridge-amount'), v);
}

test('a wallet with 3,000 public FIRO and an Ethereum / BNB side opens the Bridge to its own BNB Chain address', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await waitSynced(page);
  await fake.credit(page, { to: 'public', amount: String(3000 * 1e8) });
  await fake.mine(page);
  await page.evaluate(() => window.__campfire.go('ethImport'));
  await waitScreen(page, 'ethImport');
  await page.fill(tid('eth-words-input'), '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  await page.waitForFunction(() => !document.querySelector('[data-testid="eth-import-submit"]').disabled);
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.click(tid('eth-connect'));
  await waitScreen(page, 'ethHome', 30000);
  await page.evaluate(() => window.__campfire.go('bridge', { back: 'home' }));
  await waitScreen(page, 'bridge');
  await page.waitForSelector(tid('bridge-to-address'));
  await page.waitForFunction(() => /Available: 3,000 FIRO/.test(document.querySelector('main')?.innerText || ''), null, { timeout: 30000 });
  assert.equal((await page.getAttribute(tid('bridge-to-address'), 'data-address')).toLowerCase(), EVM.toLowerCase());
  // Shown in groups of four, so it never wraps one character alone (V3).
  assert.equal((await page.textContent(tid('bridge-to-address'))).replace(/ /g, '').toLowerCase(), EVM.toLowerCase());
  assert.match(await page.textContent(tid('bridge-to-address')), /^0x( [0-9a-fA-F]{4}){10}$/);
});

test("the dollar price is asked only after a tap, then Rosen's fee lines: $10 or 0.5%, 0.5% from 2,109 FIRO", { timeout: 2 * 60000 }, async () => {
  await amount('2500');
  await page.waitForSelector(tid('bridge-need-price'));
  assert.equal(priceAsks, 0, 'no request before the tap');
  assert.equal(await page.isDisabled(tid('bridge-go')), true);
  await both('bridge-01-need-price');
  await page.click(tid('bridge-get-price'));
  await page.waitForSelector(tid('bridge-costs'));
  assert.equal(priceAsks, 1);
  assert.match(await page.textContent(tid('bridge-fee-rule')), /^\$10 or 0\.5%, whichever is more \(10\.5\d? FIRO today\)\. From 2,109 FIRO you pay just 0\.5%\.$/);
  assert.equal(await page.textContent(tid('bridge-fee')), '12.5 FIRO');
  assert.equal(await page.textContent(tid('bridge-network-fee')), '0.01669737 FIRO');
  assert.equal(await page.textContent(tid('bridge-receive')), '2,487.48330263 rsFIRO');
  assert.equal(await page.textContent(tid('bridge-eta')), 'About 40 minutes');
  assert.equal(await page.isDisabled(tid('bridge-go')), false);
  // The button is on a 375 x 667 phone's screen without scrolling.
  await page.setViewportSize({ width: 375, height: 667 });
  await sleep(200);
  const box = await page.locator(tid('bridge-go')).boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 667, 'Bridge button visible on a small phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await both('bridge-02-quote');
});

test('100 FIRO: the cost is said and buyfiro.app suggested; 5 FIRO: refused, nothing would arrive', { timeout: 2 * 60000 }, async () => {
  await amount('100');
  await page.waitForSelector(tid('bridge-warn'));
  assert.match(await page.textContent(tid('bridge-warn')), /This costs 10\.\d% of what you send/);
  assert.ok(await page.isVisible(tid('bridge-small')));
  await both('bridge-03-small');
  await amount('5');
  await page.waitForSelector(tid('bridge-refused'));
  assert.equal(await page.isDisabled(tid('bridge-go')), true);
  // Max: the public balance less the lock's 0.01 FIRO fee budget (all of it always failed: second audit, XX).
  await page.click(tid('bridge-max'));
  await page.waitForFunction(() => document.querySelector('[data-testid="bridge-amount"]').value === '2999.99');
  await page.waitForFunction(() => !document.querySelector('[data-testid="bridge-go"]').disabled);
  // Another Firo payment under way (Send, Privatize, a name, Sell): one at a time, said (second audit, XX).
  await page.evaluate(() => import('./lib/payment_flight.js').then((m) => (window.__giveBack = m.startPayment('send'))));
  await page.waitForSelector(tid('bridge-in-flight'));
  assert.match(await page.textContent(tid('bridge-in-flight')), /Your last payment is still being sent/);
  assert.equal(await page.isDisabled(tid('bridge-go')), true);
  await page.evaluate(() => window.__giveBack());
  await page.waitForFunction(() => !document.querySelector('[data-testid="bridge-go"]').disabled);
  assert.equal(await page.$(tid('bridge-in-flight')), null);
});

test('Bridge it: the "no refunds" sheet names the address; with the stand-in engine it ends "Nothing was sent"', { timeout: 2 * 60000 }, async () => {
  await amount('2500');
  await page.waitForSelector(tid('bridge-costs'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="bridge-go"]').disabled);
  // A double tap starts one run: one "no refunds" sheet, never two stacked (release audit 0.1.7, verification 4).
  await page.locator(tid('bridge-go')).dblclick();
  await page.waitForSelector(tid('bridge-confirm-text'));
  await page.waitForTimeout(1000);
  assert.equal(await page.locator(tid('bridge-confirm-text')).count(), 1, 'one sheet');
  assert.match(await page.textContent(tid('bridge-confirm-text')), /2,500 FIRO leave now; about 2,487\.48330263 rsFIRO arrive on BNB Chain/);
  assert.equal((await page.getAttribute(tid('bridge-confirm-dest'), 'data-address')).toLowerCase(), EVM.toLowerCase());
  assert.equal((await page.textContent(tid('bridge-confirm-dest'))).replace(/ /g, '').toLowerCase(), EVM.toLowerCase());
  // The FIRO network fee of the lock, said before approval (audit B-2), with its ceiling.
  assert.match(await page.textContent(tid('bridge-confirm-network-fee')), /^FIRO network fee: about [0-9.]+ FIRO, from your public balance \(never more than 0\.01 FIRO\)\.$/);
  await both('bridge-04-confirm');
  await page.click(tid('bridge-confirm'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(tid('bridge-result'), { timeout: 30000 });
  assert.match(await page.textContent(tid('bridge-result')), /Nothing was sent/);
});

test('privacy: only the origin, CoinGecko (asked once, after the tap) and the EVM servers this test refuses', async () => {
  const evm = [...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS].map((x) => `https://${x.host}`);
  for (const x of foreignHosts(rec, srv.url)) assert.ok(['https://api.coingecko.com', ...evm].includes(x), `unexpected host ${x}`);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
