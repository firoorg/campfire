// Home's shortcuts (owner, 2026-10-12): Buy FIRO, Sell FIRO, Bridge and Spark name, one tap each, in
// one row; on a small phone the dock (Send / Receive) is still on screen. Buy asks first, as BEAM's
// Buy does (private BEAM or public WBEAM): FIRO (private, buyfiro.app) or rsFIRO (public, two steps:
// NEAR Intents to ETH or BNB, then a swap). Without an Ethereum & BNB wallet the rsFIRO card sets one
// up first and carries on into NEAR Intents. Sell asks the same way: FIRO (buyfiro.app) or rsFIRO
// (swapped in the Ethereum & BNB wallet).
//
//   npm run e2e:home   (stand-in engine, own build folder and port 8837)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced } from './flows.mjs';
import { ETH_RPC_HOSTS, BSC_RPC_HOSTS } from '../../src/lib/eth/hosts.js';

const PORT = 8837;
const tid = (id) => `[data-testid="${id}"]`;
let tmp, srv, browser, ctx, page;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-home-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  // Nothing real is asked: EVM servers, NEAR Intents and buyfiro.app are refused.
  await ctx.route((u) => [...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS].some((x) => x.host === u.hostname) || ['1click.chaindefuser.com', 'buyfiro.app', 'api.coingecko.com'].includes(u.hostname), (r) => r.abort());
  ({ page } = await recordedPage(ctx, { label: 'home' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function home() {
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.waitForSelector(tid('home-shortcuts'));
}

async function both(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function chooser(from = 'sc-buy') {
  await home();
  await page.click(tid(from));
  await page.waitForSelector(tid('buy-chooser-title'));
}

test('Home shows Buy FIRO, Sell FIRO, Bridge and Spark name in one row, and the dock stays on a small phone', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: `home-${Math.random().toString(36).slice(2, 10)}` });
  await waitHome(page);
  await waitSynced(page);
  await page.waitForSelector(tid('home-shortcuts'));
  const labels = await page.$$eval(`${tid('home-shortcuts')} .shortcut-label`, (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels, ['Buy FIRO', 'Sell FIRO', 'Bridge', 'Spark name']);
  await both('home-shortcuts');
  await page.setViewportSize({ width: 375, height: 667 });
  await sleep(250);
  for (const id of ['receive', 'sc-buy', 'sc-sell', 'sc-bridge', 'sc-names']) {
    const b = await page.locator(tid(id)).boundingBox();
    assert.ok(b && b.y >= 0 && b.y + b.height <= 667, `${id} on screen at 375 x 667`);
  }
  const tops = await page.$$eval(`${tid('home-shortcuts')} .shortcut`, (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  assert.equal(new Set(tops).size, 1, 'one row');
  await shot(page, 'home-shortcuts-375');
  await page.setViewportSize({ width: 390, height: 844 });
});

test('Buy asks first: FIRO (private) or rsFIRO (public, two steps); Not now closes it', { timeout: 2 * 60000 }, async () => {
  await chooser();
  assert.equal(await page.textContent(tid('buy-chooser-title')), 'Both are FIRO. They live in different wallets.');
  assert.match(await page.textContent(tid('buy-choose-private')), /FIRO\s*Private.*The private coin, in your Firo wallet.*Buy FIRO/);
  assert.match(await page.textContent(tid('buy-choose-rsfiro')), /rsFIRO on Ethereum or BNB\s*Public/);
  assert.deepEqual(await page.$$eval(`${tid('buy-rsfiro-steps')} li`, (els) => els.map((e) => e.textContent)), ['NEAR Intents turns your coin into ETH or BNB.', 'You swap it to rsFIRO.']);
  // No Ethereum & BNB wallet yet: the card says so.
  await page.waitForFunction(() => /Create an Ethereum & BNB wallet first/.test(document.querySelector('[data-testid="buy-choose-rsfiro"]')?.textContent || ''));
  await both('buy-chooser');
  await page.click(tid('buy-chooser-close'));
  await page.waitForSelector(tid('buy-chooser-title'), { state: 'detached' });
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'home');
  // The dock's Buy asks the same.
  await chooser('buy');
  await page.click(tid('buy-choose-private'));
  await waitScreen(page, 'buyFiro', 20000);
  assert.equal(await page.textContent('.topbar h1'), 'Buy private FIRO');
  await page.click('button[aria-label="Back"]');
  await waitScreen(page, 'home', 20000);
});

test('Sell asks first: FIRO (buyfiro.app) or rsFIRO (an Ethereum & BNB wallet first); FIRO opens Sell FIRO; Not now closes it', { timeout: 2 * 60000 }, async () => {
  await home();
  await page.click(tid('sc-sell'));
  await page.waitForSelector(tid('sell-chooser-title'));
  assert.equal(await page.textContent(tid('sell-chooser-title')), 'Which FIRO do you want to sell?');
  await page.waitForSelector(tid('sell-rsfiro-setup'));
  await both('sell-chooser');
  await page.click(tid('sell-chooser-close'));
  await page.waitForSelector(tid('sell-chooser-title'), { state: 'detached' });
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'home');
  await page.click(tid('sc-sell'));
  await page.click(tid('sell-choose-firo'));
  await waitScreen(page, 'sellFiro', 20000);
  assert.equal(await page.textContent('.topbar h1'), 'Sell FIRO');
  await page.click('button[aria-label="Back"]');
  await waitScreen(page, 'home', 20000);
});

test('Bridge and Spark name open in one tap', async () => {
  for (const [id, screenName] of [['sc-bridge', 'bridge'], ['sc-names', 'names']]) {
    await home();
    await page.click(tid(id));
    await waitScreen(page, screenName, 20000);
  }
});

test('private FIRO received that this node cannot confirm: Home says it is waiting, and Try another node clears it (P4)', { timeout: 2 * 60000 }, async () => {
  await home();
  await page.evaluate(() => globalThis.__firoFake.privateCheck('set-mismatch'));
  await page.waitForSelector(tid('private-check'));
  assert.match(await page.textContent(tid('private-check')), /^Private FIRO received is waiting\. This Firo node's list of private coins does not add up, so Campfire cannot confirm it yet\./);
  await both('home-private-check');
  await page.evaluate(() => globalThis.__firoFake.privateCheck('set-disagree'));
  await page.waitForFunction(() => /Another Firo node disagrees with this one/.test(document.querySelector('[data-testid="private-check"]')?.textContent || ''));
  await page.click(tid('private-check-other'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="private-check"]'), null, { timeout: 30000 });
});

test('Restore takes 18 words pasted from another wallet: 18 boxes, checked (PN)', async () => {
  await page.evaluate(() => window.__campfire.go('restore'));
  await waitScreen(page, 'restore');
  await page.fill(tid('word-1'), `${'abandon '.repeat(17)}agent`);
  await page.waitForSelector(tid('word-18'));
  assert.equal(await page.locator('[data-testid^="word-"]').count(), 18);
  assert.equal(await page.getAttribute(tid('count-18'), 'aria-checked'), 'true');
  await page.waitForFunction(() => !document.querySelector('[data-testid="restore-submit"]').disabled);
  // No picture: never one of recovery words, not even BIP39's public test phrase.
  // Nothing restored: back home with the phrase dropped.
  await page.evaluate(() => {
    for (const i of document.querySelectorAll('[data-testid^="word-"]')) i.value = '';
  });
  await home();
});

test('IP privacy: for any device, names the nodes that see the IP, and what stays unencrypted on the device (PN)', async () => {
  await page.evaluate(() => window.__campfire.go('ipNotice'));
  await waitScreen(page, 'ipNotice');
  assert.match(await page.textContent(tid('ip-text')), /^The Firo nodes your wallet reads the blockchain from \(the one in use, and others it asks to check its answers\) can see your IP address\. To hide it, use a VPN you trust, or run your own Firo node\.$/);
  await page.click(tid('ip-how'));
  assert.match(await page.textContent(tid('ip-on-device')), /each wallet's name, its number of words, whether it has a passphrase, the block it was made at, and a fingerprint that tells when the same words are added again \(it cannot be turned back into them\) are kept unencrypted/);
  await both('ip-privacy');
  await home();
});

test('Change password says a copy made before still opens with the old password (PN-keys)', async () => {
  await page.evaluate(() => window.__campfire.go('changePassword'));
  await waitScreen(page, 'changePassword');
  assert.match(await page.textContent(tid('cp-old-copies')), /^A copy of this browser's data made before the change \(a backup, another computer\) still opens with the old password\./);
  await both('change-password');
  await home();
});

test('rsFIRO without an Ethereum & BNB wallet: set one up (it says why), then step 1 of 2 in NEAR Intents', { timeout: 3 * 60000 }, async () => {
  await chooser();
  await page.waitForFunction(() => /Create an Ethereum & BNB wallet first/.test(document.querySelector('[data-testid="buy-choose-rsfiro"]')?.textContent || ''));
  await page.click(tid('buy-choose-rsfiro'));
  await waitScreen(page, 'ethStart', 20000);
  assert.equal(await page.textContent(tid('eth-start-why')), 'First, a wallet for rsFIRO');
  await shot(page, 'home-rsfiro-setup');
  await page.click(tid('eth-import'));
  await waitScreen(page, 'ethImport');
  await page.fill(tid('eth-words-input'), '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  await page.waitForFunction(() => !document.querySelector('[data-testid="eth-import-submit"]').disabled);
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.click(tid('eth-connect'));
  await waitScreen(page, 'nearIntents', 30000);
  assert.equal(await page.textContent(tid('ni-step')), 'Step 1 of 2 · your coin becomes ETH or BNB in this wallet');
  assert.equal(await page.textContent('.topbar h1'), 'Buy rsFIRO');
  await shot(page, 'buy-rsfiro-step1');
  // Next time the card goes straight there.
  await chooser();
  await page.waitForFunction(() => /Buy rsFIRO/.test(document.querySelector('[data-testid="buy-choose-rsfiro"] .choice-action')?.textContent || ''));
  await page.click(tid('buy-choose-rsfiro'));
  await waitScreen(page, 'nearIntents', 20000);
});
