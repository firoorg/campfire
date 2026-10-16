// Buy FIRO, end to end, through the screens: the installed Google Chrome
// (headless), the dev server with the production headers, a throwaway wallet on
// the stand-in engine (lib/backend_fake.js: no network, no funds), and
// buyfiro.app's buy API v1 answered by Playwright with test/unit/buy_fakes.mjs
// (its documented shape, sandbox answers included). No request ever reaches the
// real one, and the app runs in buyfiro.app's test mode (the localhost-only
// switch of lib/buy/wiring.js): every order carries sandbox=true in its URL and
// body, and the stand-in refuses (and the last test fails on) any that does not.
//
//   npm run e2e:buy   (node tools/build.mjs --engine fake: builds dist-fake/, then this file)
//
// 1. Home's Buy opens Buy FIRO directly (one thing to buy); nothing of it, and
//    nothing to buyfiro.app, before it is opened.
// 2. The coin (BTC first), the smallest buy and its one-tap fix, the price, the
//    order to a new transparent address of this wallet (buyfiro.app pays
//    transparent addresses only), its deposit address and QR, its states as
//    buyfiro.app reports them, the FIRO arriving in the public balance with one
//    tap to Privatize, the buys list, and the buy still there after locking
//    (sealed on this device).
// 3. buyfiro.app unreachable: said, blaming nobody; nothing was sent.
// 4. Only this origin and buyfiro.app were contacted; no CSP violation.
//
// Screenshots at 390x844 and 1280x800, light and dark, into $CAMPFIRE_SHOTS.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { startServer, launch, recordedPage, shot, waitScreen, foreignHosts, sleep, SHOTS } from './harness.mjs';
import { createWallet, waitHome, unlockWithPassword } from './flows.mjs';
import { ETH_RPC_HOSTS, BSC_RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import { FakeBuyFiro, ASSETS, BTC, assetJson } from '../unit/buy_fakes.mjs';
import { SANDBOX_KEY } from '../../src/lib/buy/wiring.js';

const PORT = Number(process.env.CAMPFIRE_BUY_PORT || 8860);
const PASSWORD = `buy-${Math.random().toString(36).slice(2, 10)}`;
const DEPOSIT = 'sbx_1791800000_e2e0buy0test';
const REFUND = 'bc1qfake0refund0address0for0the0e2e0test0000';
const TXID = 'f1'.repeat(32);
const tid = (id) => `[data-testid="${id}"]`;

let srv, browser, ctx, page, rec;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

// ------------------------------------------------------------------ buyfiro.app, answered by the unit fake
const bf = new FakeBuyFiro();
// Orders are taken at today's time here: their addresses take payments for a few hours more.
bf.deadline = Math.floor(Date.now() / 1000) + 6 * 3600;
bf.depositAddress = DEPOSIT;
bf.sandboxOnly = true;
// Tether's USDT on Ethereum, and a token that only calls itself USDT (another contract): the
// wallet pays the first from its own Ethereum balance and never the second.
bf.assets = [...ASSETS, assetJson('coin:eth-usdt', 'USDT', 'eth', 6, { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', price: 0.9998 }), assetJson('coin:eth-usdt-x', 'USDT', 'eth', 6, { contract: '0x1111111111111111111111111111111111111111', price: 1 })];

async function buyfiroRoute(route) {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const r = await bf.fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
  const headers = { ...cors };
  r.headers.forEach((v, k) => (headers[k] = v));
  return route.fulfill({ status: r.status, headers, body: await r.text() });
}
const orders = () => bf.requests.filter((r) => r.method === 'POST' && r.path === '/order');

/** One screen, four ways: phone and desktop, light and dark. */
async function shots4(name) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  for (const scheme of ['light', 'dark']) {
    for (const [w, hh] of [[390, 844], [1280, 800]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: w, height: hh });
      await sleep(150);
      await shot(page, `buy-${name}-${w}-${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(100);
}

/** The primary button is on screen without scrolling (the 375 x 667 phone). */
async function ctaVisibleOnSmallPhone(selector) {
  await page.setViewportSize({ width: 375, height: 667 });
  await sleep(150);
  const box = await page.locator(selector).boundingBox();
  await page.setViewportSize({ width: 390, height: 844 });
  return Boolean(box && box.y >= 0 && box.y + box.height <= 667);
}

before(async () => {
  srv = await startServer({ root: 'dist-fake', port: PORT, extra: ['--fake-backend'] });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(srv.url).origin });
  await ctx.route((u) => u.hostname === 'buyfiro.app', buyfiroRoute);
  // Nothing may reach a real Ethereum server or CoinGecko.
  await ctx.route((u) => [...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS].some((x) => x.host === u.hostname) || u.hostname === 'api.coingecko.com', (r) => r.abort());
  // buyfiro.app's test mode for this page: honoured on localhost only.
  await ctx.addInitScript((k) => localStorage.setItem(k, '1'), SANDBOX_KEY);
  ({ page, rec } = await recordedPage(ctx, { label: 'buy' }));
  console.log(`# screenshots: ${SHOTS}`);
});

after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
});

test('a new wallet; Home has Buy; no Buy code and no request to buyfiro.app before it is opened', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await page.waitForSelector(tid('buy'));
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/lib\/buy\/|\/screens\/buy_(?!screens)|\/lib\/eth\/(?!record\.js|hosts\.js)/.test(e.name)).map((e) => e.name));
  assert.deepEqual(loaded, [], 'first paint carries no Buy screen and no Ethereum code');
  assert.equal(bf.requests.length, 0, 'nothing asked of buyfiro.app before Buy FIRO is opened');
  await shots4('00-home');
});

test('Buy FIRO: the coin, the smallest buy, the price, the order to a transparent address, its states, Privatize', { timeout: 5 * 60000 }, async () => {
  // Buy asks first: FIRO (private, here) or rsFIRO (public, in two steps).
  await page.click(tid('buy'));
  await page.waitForSelector(tid('buy-chooser-title'));
  await page.click(tid('buy-choose-private'));
  await waitScreen(page, 'buyFiro');
  await page.waitForFunction(() => /BTC/.test(document.querySelector('[data-testid="buy-coin"]')?.textContent || ''));
  assert.match(await page.textContent(tid('buy-cta')), /^Get a BTC deposit address$/);
  await page.waitForFunction(() => /Smallest buy right now: about \$1,000/.test(document.querySelector('[data-testid="buy-minimum-hint"]')?.textContent || ''));
  assert.match(await page.textContent(tid('buy-arrives-in')), /public balance/);
  assert.match(await page.textContent(tid('buy-footer')), /^buyfiro\.app buys the FIRO and sends it to your wallet\.$/);
  assert.ok(await ctaVisibleOnSmallPhone(tid('buy-cta')), 'the button is on a 375 x 667 screen without scrolling');
  await shots4('01-buy-firo-empty');

  // The coin picker: the coins people bring most first.
  await page.click(tid('buy-coin'));
  await page.waitForSelector(tid('buy-coin-search'));
  const first = await page.$$eval(tid('buy-coin-row'), (els) => els.slice(0, 3).map((e) => e.dataset.assetId));
  assert.deepEqual(first, ['coin:btc', 'coin:eth', 'coin:tron-usdt']);
  await shots4('02-coin-picker');
  await page.fill(tid('buy-coin-search'), 'tron');
  assert.deepEqual(await page.$$eval(tid('buy-coin-row'), (els) => els.map((e) => e.dataset.assetId)), ['coin:tron-usdt']);
  await page.click(`${tid('buy-coin-row')}[data-asset-id="coin:tron-usdt"]`);
  await page.waitForFunction(() => /USDT/.test(document.querySelector('[data-testid="buy-coin"]')?.textContent || ''));
  await page.click(tid('buy-coin'));
  await page.click(`${tid('buy-coin-row')}[data-asset-id="coin:btc"]`);
  await page.waitForFunction(() => /BTC/.test(document.querySelector('[data-testid="buy-coin"]')?.textContent || ''));

  // Under the smallest buy: said in BTC, fixed in one tap.
  await page.fill(tid('buy-refund'), REFUND);
  await page.fill(tid('buy-amount'), '0.001');
  await page.waitForSelector(`${tid('buy-problem')}[data-code="amount_below_upstream_minimum"]`);
  assert.match(await page.textContent(tid('buy-problem')), /This route starts at about \$1,000.*That is about 0\.0123 BTC\. Nothing was sent/, "buyfiro.app's own floor, said plainly");
  if (await page.evaluate(() => window.__campfire.go && document.querySelector('[data-testid="buy-smaller"]') !== null)) assert.match(await page.textContent(tid('buy-smaller-note')), /rsFIRO/);
  assert.doesNotMatch(await page.textContent('main'), /fee|%/i, 'no fee anywhere on Buy');
  assert.equal(await page.isDisabled(tid('buy-cta')), true);
  await shots4('03-below-minimum');
  await page.click(tid('buy-fix'));
  assert.equal(await page.inputValue(tid('buy-amount')), '0.0123');
  await page.waitForSelector(tid('buy-estimate'));
  const usd = 0.0123 * ASSETS.find((a) => a.asset_id === BTC).price_usd;
  assert.equal(await page.getAttribute(tid('buy-estimate'), 'data-sats'), String(BigInt(Math.round(usd * 0.95 * 1e8))), "what buyfiro.app said arrives, as it is");
  assert.match(await page.textContent(tid('buy-eta')), /about 14 minutes/);
  assert.match(await page.textContent(tid('buy-worth')), /≈\s\$1,012/);
  await page.waitForFunction(() => document.querySelector('[data-testid="buy-cta"]')?.disabled === false);
  await shots4('04-buy-firo-priced');
  const quote = bf.requests.filter((r) => r.path === '/quote').at(-1);
  assert.deepEqual(Object.fromEntries(quote.url.searchParams), { asset_id: BTC, amount: '0.0123', refund_address: REFUND, sandbox: 'true' });
  assert.match(await page.textContent('main'), /You receive/);
  assert.doesNotMatch(await page.textContent('main'), /fee|%/i, 'no fee anywhere on Buy');

  // The order: a new transparent address of this wallet, kept on this device before it is shown.
  await page.click(tid('buy-cta'));
  await waitScreen(page, 'buyOrder');
  await page.waitForSelector(tid('buy-deposit-address'));
  assert.equal(orders().length, 1);
  const order = orders()[0].body;
  assert.deepEqual(Object.keys(order).sort(), ['amount', 'asset_id', 'firo_wallet', 'refund_address', 'sandbox'], 'a JSON body; the address never in the URL');
  assert.equal(orders()[0].url.search, '?sandbox=true', 'test mode in the URL, which is what counts');
  assert.equal(order.sandbox, true);
  assert.equal(order.amount, 0.0123);
  assert.equal(order.refund_address, REFUND);
  assert.match(order.firo_wallet, /^a/, 'a transparent address: buyfiro.app pays those only');
  assert.equal((await page.evaluate((a) => window.__campfire.classify(a), order.firo_wallet)).kind, 'transparent');
  assert.equal(await page.evaluate(() => window.__campfire.receive().transparent), order.firo_wallet, "the wallet's newest transparent address");
  assert.equal(await page.textContent(tid('buy-deposit-address')), DEPOSIT);
  assert.equal(await page.textContent(tid('buy-exact-amount')), '0.0123 BTC');
  assert.match(await page.textContent(tid('buy-network-warning')), /Send only BTC on the Bitcoin network/);
  assert.match(await page.textContent(tid('buy-order-arrives')), /Your public balance/);
  assert.match(await page.textContent(tid('buy-deadline')), /This address works until \d\d:\d\d (today|on \d+ \w+)\./);
  assert.match(await page.textContent('.topbar h1'), /^Send 0\.0123 BTC$/);
  assert.match(await page.textContent('main'), /test mode: nothing to pay/);
  const img = await page.evaluate(async () => {
    const svgEl = document.querySelector('[data-testid="buy-qr"] svg');
    const blob = new Blob([new XMLSerializer().serializeToString(svgEl)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const im = new Image();
    await new Promise((r, j) => ((im.onload = r), (im.onerror = j), (im.src = url)));
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 400;
    c.getContext('2d').drawImage(im, 0, 0, 400, 400);
    return Array.from(c.getContext('2d').getImageData(0, 0, 400, 400).data);
  });
  assert.equal(jsQR(Uint8ClampedArray.from(img), 400, 400).data, DEPOSIT, 'the QR code is the deposit address');
  assert.equal(await page.getAttribute(tid('buy-step-0'), 'data-mark'), 'active');
  assert.ok(await ctaVisibleOnSmallPhone(tid('buy-order-cta')));
  await page.click(tid('buy-order-cta'));
  await page.waitForFunction(() => /Address copied/.test(document.querySelector('[data-testid="buy-order-cta"]')?.textContent || ''));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), DEPOSIT);
  await shots4('05-order-awaiting');

  // buyfiro.app moves it on; the screen follows by itself (every poll_after_seconds).
  bf.state = 'deposit_detected';
  await page.waitForSelector(`${tid('buy-step-0')}[data-mark="done"]`, { timeout: 60000 });
  assert.match(await page.textContent(tid('buy-step-0')), /Payment received.*being confirmed/);
  assert.equal(await page.isVisible(tid('buy-deposit-address')), false);
  await shots4('06-order-received');
  bf.state = 'swapping';
  await page.waitForSelector(`${tid('buy-step-1')}[data-mark="active"]`, { timeout: 60000 });
  bf.state = 'sending';
  await page.waitForSelector(`${tid('buy-step-2')}[data-mark="active"]`, { timeout: 60000 });
  bf.state = 'delivered';
  bf.txId = TXID;
  await page.waitForSelector(tid('buy-delivered'), { timeout: 60000 });
  assert.equal(await page.getAttribute(tid('buy-step-3'), 'data-mark'), 'active');
  assert.match(await page.textContent(tid('buy-step-3')), /Arriving in your public balance/);
  assert.match(await page.textContent(tid('buy-firo-tx')), /f1f1f1…f1f1/);
  assert.doesNotMatch(await page.textContent('main'), /fee|%/i, 'no fee anywhere on Buy');
  await shots4('07-order-delivered');
  const polls = bf.requests.filter((r) => r.path === `/order/${DEPOSIT}`).length;
  // The wallet has the FIRO, confirmed: it arrived in the public balance, and Privatize is one tap.
  await page.evaluate(async (txid) => {
    const { wallet } = await import('./lib/wallet.js');
    wallet.state.txs = [{ txid, height: 1, time: Math.floor(Date.now() / 1000), confirmations: 1, direction: 'in', kind: 'transparent', amount: 1n, fee: 0n, memo: null, counterparty: null }, ...wallet.state.txs];
    wallet.emit();
  }, TXID);
  await page.waitForSelector(tid('buy-arrived'));
  assert.match(await page.textContent(tid('buy-arrived')), /arrived in your public balance/);
  assert.equal(await page.getAttribute(tid('buy-step-3'), 'data-mark'), 'done');
  assert.equal(await page.textContent(tid('buy-order-cta')), 'Make it private');
  assert.ok(await page.isVisible(tid('buy-order-see')));
  await shots4('08-order-arrived');
  await sleep(3000);
  assert.equal(bf.requests.filter((r) => r.path === `/order/${DEPOSIT}`).length, polls, 'an ended buy is never asked about again');
  await page.click(tid('buy-order-cta'));
  await waitScreen(page, 'privatize');

  // The buys list, and the buy still there after locking: sealed on this device, nothing in the clear.
  await page.evaluate(() => window.__campfire.go('buyFiro'));
  await page.waitForSelector(tid('buy-your-buys'));
  await page.click(tid('buy-your-buys'));
  await waitScreen(page, 'buyOrders');
  await page.waitForSelector(`${tid('buy-order-row')}[data-deposit="${DEPOSIT}"][data-state="delivered"]`);
  await shots4('09-buys');
  const stored = await page.evaluate(async () => JSON.stringify(await (await import('./lib/store.js')).store.get('buy')));
  for (const s of [DEPOSIT, REFUND, order.firo_wallet]) assert.equal(stored.includes(s), false, 'sealed');
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('lock'));
  await waitScreen(page, 'unlock');
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await page.evaluate(() => window.__campfire.go('buyOrders'));
  await page.waitForSelector(`${tid('buy-order-row')}[data-deposit="${DEPOSIT}"]`);
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
});

test("Buy FIRO with ETH: the order offers to pay from this wallet's Ethereum balance, which opens Send filled in", { timeout: 3 * 60000 }, async () => {
  // An Ethereum wallet from a throwaway key (Hardhat's first test key; holds nothing here).
  await page.evaluate(() => window.__campfire.go('ethImport'));
  await waitScreen(page, 'ethImport');
  await page.fill(tid('eth-words-input'), '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  await page.waitForFunction(() => !document.querySelector('[data-testid="eth-import-submit"]').disabled);
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.click(tid('eth-connect'));
  await waitScreen(page, 'ethHome', 30000);
  // A new buy (the earlier one, at the fake's first address, has been delivered).
  bf.depositAddress = 'sbx_1791800000_e2e0eth0test';
  bf.state = 'awaiting_deposit';
  bf.txId = null;
  await page.evaluate(() => window.__campfire.go('buyFiro'));
  await waitScreen(page, 'buyFiro');
  await page.click(tid('buy-coin'));
  await page.click(`${tid('buy-coin-row')}[data-asset-id="coin:eth"]`);
  await page.waitForFunction(() => /ETH/.test(document.querySelector('[data-testid="buy-coin"]')?.textContent || ''));
  // One character of a checksummed address mistyped: refused, never a refund to nobody (PN).
  await page.fill(tid('buy-refund'), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92267');
  await page.fill(tid('buy-amount'), '0.5');
  await page.waitForFunction(() => /looks mistyped/.test(document.querySelector('main')?.innerText || ''));
  assert.equal(await page.isDisabled(tid('buy-cta')), true);
  await page.fill(tid('buy-refund'), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  await page.fill(tid('buy-amount'), '0.5');
  await page.waitForSelector(tid('buy-estimate'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="buy-cta"]').disabled, null, { timeout: 30000 });
  await page.click(tid('buy-cta'));
  await waitScreen(page, 'buyOrder', 30000);
  await page.waitForSelector(tid('buy-pay-from-wallet'), { timeout: 30000 });
  const deposit = (await page.textContent(tid('buy-deposit-address'))).trim();
  await shots4('10-pay-from-wallet');
  await page.click(tid('buy-pay-from-wallet'));
  await waitScreen(page, 'ethSend', 30000);
  // The coin list is filled once the wallet is open: wait for it, then read.
  await page.waitForFunction(() => document.querySelector('[data-testid="eth-send-asset"]')?.options.length > 0, null, { timeout: 30000 });
  assert.equal(await page.inputValue(tid('eth-send-to')), deposit);
  assert.equal(await page.inputValue(tid('eth-send-amount')), '0.5');
  assert.equal(await page.inputValue(tid('eth-send-asset')), 'ETH');
});

test('second audit N11: a buy\'s deposit address pasted into Ethereum Send by hand is held to its deadline too', { timeout: 3 * 60000 }, async () => {
  const keep = bf.deadline;
  bf.deadline = Math.floor(Date.now() / 1000) + 5 * 60; // five minutes left: too soon to pay from here
  try {
    bf.depositAddress = 'sbx_1791800003_e2e0eth0late';
    bf.state = 'awaiting_deposit';
    bf.txId = null;
    await page.evaluate(() => window.__campfire.go('buyFiro'));
    await waitScreen(page, 'buyFiro');
    await page.click(tid('buy-coin'));
    await page.click(`${tid('buy-coin-row')}[data-asset-id="coin:eth"]`);
    await page.waitForFunction(() => /ETH/.test(document.querySelector('[data-testid="buy-coin"]')?.textContent || ''));
    await page.fill(tid('buy-refund'), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    await page.fill(tid('buy-amount'), '0.5');
    await page.waitForSelector(tid('buy-estimate'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="buy-cta"]').disabled, null, { timeout: 30000 });
    await page.click(tid('buy-cta'));
    await waitScreen(page, 'buyOrder', 30000);
    await page.waitForSelector(tid('buy-pay-too-late'), { timeout: 30000 });
    const deposit = (await page.textContent(tid('buy-deposit-address'))).trim();
    // By hand: Ethereum, Send, the address pasted.
    await page.evaluate(() => window.__campfire.go('ethSend', { chain: 'ethereum' }));
    await waitScreen(page, 'ethSend');
    await page.fill(tid('eth-send-to'), deposit);
    await page.fill(tid('eth-send-amount'), '0.5');
    await page.waitForFunction(() => /takes payments for only a few more minutes/.test(document.querySelector('[data-testid="eth-send-pay-by"]')?.textContent || ''), null, { timeout: 10000 });
    assert.equal(await page.isDisabled(tid('eth-send-review')), true);
    await shots4('12-pasted-late');
  } finally {
    bf.deadline = keep;
  }
});

test('USDT on Ethereum: paid from this wallet it stays USDT in Send (balances not read); a same-named token is never paid', { timeout: 3 * 60000 }, async () => {
  async function order(assetId, deposit) {
    bf.depositAddress = deposit;
    bf.state = 'awaiting_deposit';
    bf.txId = null;
    await page.evaluate(() => window.__campfire.go('home'));
    await page.evaluate(() => window.__campfire.go('buyFiro'));
    await waitScreen(page, 'buyFiro');
    await page.click(tid('buy-coin'));
    const search = await page.$(tid('buy-coin-search'));
    if (search) await search.fill('USDT');
    await page.click(`${tid('buy-coin-row')}[data-asset-id="${assetId}"]`);
    await page.waitForFunction(() => /USDT/.test(document.querySelector('[data-testid="buy-coin"]')?.textContent || ''));
    await page.fill(tid('buy-refund'), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    await page.fill(tid('buy-amount'), '1200');
    // No price: say what the screen shows and what buyfiro.app was asked last (a sweep saw this once, 2026-10-14).
    await page.waitForSelector(tid('buy-estimate')).catch(async (e) => {
      console.log(`# Buy screen (${await page.evaluate(() => window.__campfire.screen())}): ${(await page.evaluate(() => document.querySelector('main')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 900)}`);
      console.log(`# buyfiro.app was last asked: ${JSON.stringify(bf.requests.slice(-6).map((r) => [r.method, r.path]))}`);
      throw e;
    });
    await page.waitForFunction(() => !document.querySelector('[data-testid="buy-cta"]').disabled, null, { timeout: 30000 });
    await page.click(tid('buy-cta'));
    await waitScreen(page, 'buyOrder', 30000);
  }
  await order('coin:eth-usdt', 'sbx_1791800001_e2e0usdt0real');
  await page.waitForSelector(tid('buy-pay-from-wallet'), { timeout: 30000 });
  await page.click(tid('buy-pay-from-wallet'));
  await waitScreen(page, 'ethSend', 30000);
  await page.waitForFunction(() => document.querySelector('[data-testid="eth-send-asset"]')?.options.length > 0, null, { timeout: 30000 });
  // The Ethereum servers are refused here, so no balance is ever read: before the fix this was ETH.
  assert.equal(await page.inputValue(tid('eth-send-asset')), 'USDT');
  assert.equal(await page.inputValue(tid('eth-send-amount')), '1200');
  await shots4('11-pay-usdt-from-wallet');
  await order('coin:eth-usdt-x', 'sbx_1791800002_e2e0usdt0look');
  await sleep(3000);
  assert.equal(await page.isVisible(tid('buy-pay-from-wallet')), false, 'a same-named token is not paid from this wallet');
  await page.evaluate(() => window.__campfire.go('home'));
});

test('Buy FIRO: buyfiro.app unreachable says so and blames nobody; nothing was sent', { timeout: 2 * 60000 }, async () => {
  const quotes = (u) => u.hostname === 'buyfiro.app' && u.pathname.endsWith('/quote');
  await page.route(quotes, (r) => r.fulfill({ status: 403, headers: { ...cors, 'content-type': 'text/html' }, body: '<html>Blocked</html>' }));
  await page.evaluate(() => window.__campfire.go('buyFiro'));
  await page.waitForFunction(() => /BTC/.test(document.querySelector('[data-testid="buy-coin"]')?.textContent || ''));
  await page.fill(tid('buy-refund'), REFUND);
  await page.fill(tid('buy-amount'), '0.02');
  await page.waitForSelector(`${tid('buy-problem')}[data-code="blocked"]`);
  assert.match(await page.textContent(tid('buy-problem')), /Couldn't reach buyfiro\.app.*Nothing was sent/);
  await shots4('10-unreachable');
  await page.unroute(quotes);
  await page.click(tid('buy-fix'));
  await page.waitForSelector(tid('buy-estimate'));
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
});

test('only sandbox orders: every POST carried sandbox=true in its URL and its body; none was refused', async () => {
  const posts = bf.requests.filter((r) => r.method !== 'GET');
  assert.ok(posts.length >= 1);
  for (const r of posts) {
    assert.equal(r.url.searchParams.get('sandbox'), 'true', String(r.url));
    assert.equal(r.body && r.body.sandbox, true);
  }
  assert.deepEqual(bf.violations, []);
  for (const r of bf.requests) assert.equal(r.url.searchParams.get('sandbox'), 'true', `every call in test mode: ${r.url}`);
});

test('IP privacy: only this origin and buyfiro.app (answered here); no CSP violation, no page error', async () => {
  const hosts = foreignHosts(rec, srv.url).sort();
  // Once an Ethereum / BNB wallet is open (the pay-from-wallet test), it asks its own chains'
  // servers; this test refuses them all (never answered). Nothing else may be asked.
  const evm = [...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS].map((x) => `https://${x.host}`);
  for (const x of hosts) assert.ok(['https://buyfiro.app', ...evm].includes(x), `unexpected host ${x}`);
  assert.deepEqual(rec.csp, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
