// Sell FIRO, end to end, through the screens: the installed Google Chrome
// (headless), the dev server with the production headers, a throwaway wallet on
// the stand-in engine (lib/backend_fake.js: no network, no funds), and
// buyfiro.app's sell API v1 answered by Playwright with test/unit/sell_fakes.mjs
// (its documented shape). No request ever reaches the real one, and the app runs
// in buyfiro.app's test mode (the localhost-only switch of lib/sell/wiring.js):
// every request carries sandbox=true in its URL, every order in its body too,
// and the stand-in refuses (and the last tests fail on) any that does not. The
// stand-in answers test-mode orders with deposit addresses the stand-in engine
// can pay, so the payment itself is exercised; the real sandbox's are never
// payable, and the app pays a test-mode order only with the stand-in engine.
//
//   npm run e2e:sell
//
// 1. Home: Buy FIRO · Sell FIRO · Bridge · Spark name; no Sell code and nothing to buyfiro.app first.
// 2. Sell asks which FIRO; FIRO opens the form: the smallest sell and its one-tap fix, no Ethereum &
//    BNB wallet (set one up from the form and come back to it), a pasted payout address checked by its
//    checksum, the payout picker, Max, the price, the order (Spark deposit, USDT on BNB Chain to this
//    wallet's address), the payment reviewed and paid from the private balance to the Spark deposit
//    address with the exact amount, its states up to the payout and its explorer link, the sells
//    list, and the sell still there after locking (sealed on this device).
// 3. The endings: expired, refused, attention; Spark deposits off (a transparent deposit address,
//    said); refusals in plain words (too many new sells, unreachable, an answer that is not the order).
// 4. Only test-mode requests; only this origin and buyfiro.app were contacted; no CSP violation.
// 5. rsFIRO: the chooser opens the Ethereum swap and the BNB Chain swap.
//
// Screenshots at 390x844, light and dark, into $CAMPFIRE_SHOTS.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, recordedPage, shot, waitScreen, foreignHosts, sleep, fake, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced, unlockWithPassword } from './flows.mjs';
import { ETH_RPC_HOSTS, BSC_RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import { FakeSellFiro, answer, envelope, sellErrorJson, SPARK_DEPOSIT, T_DEPOSIT, USDT_BSC, TXID } from '../unit/sell_fakes.mjs';
import { SANDBOX_KEY } from '../../src/lib/sell/wiring.js';

const PORT = Number(process.env.CAMPFIRE_SELL_PORT || 8872);
const PASSWORD = `sell-${Math.random().toString(36).slice(2, 10)}`;
// Hardhat's first test key and its address (hold nothing that matters).
const ETH_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ETH_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const NO_COST = /\bfees?\b|%/i;
const tid = (id) => `[data-testid="${id}"]`;

let srv, browser, ctx, page, rec;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

// ------------------------------------------------------------------ buyfiro.app, answered by the unit fake
const sf = new FakeSellFiro();
sf.sandboxOnly = true;
sf.payableSandbox = true;
// As buyfiro.app's sandbox: the limits are named, never enforced (the app enforces them itself).
sf.refuseOutOfLimits = false;

async function sellfiroRoute(route) {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const r = await sf.fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postData() || undefined });
  const headers = { ...cors };
  r.headers.forEach((v, k) => (headers[k] = v));
  return route.fulfill({ status: r.status, headers, body: await r.text() });
}

/** One screen, light and dark, at 390 x 844. */
async function shots2(name) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(150);
    await shot(page, `sell-${name}-390-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The primary button is on screen without scrolling (the 375 x 667 phone). */
async function ctaVisibleOnSmallPhone(selector) {
  await page.setViewportSize({ width: 375, height: 667 });
  await sleep(150);
  const box = await page.locator(selector).boundingBox();
  await page.setViewportSize({ width: 390, height: 844 });
  return Boolean(box && box.y >= 0 && box.y + box.height <= 667);
}

const mainText = () => page.textContent('main');
const lastOrder = () => sf.posts().at(-1);

async function openForm() {
  await page.evaluate(() => window.__campfire.go('sellFiro'));
  await waitScreen(page, 'sellFiro');
}

/** The id of the newest sell buyfiro.app (the stand-in) made. */
const newestId = () => [...sf.orders.keys()].at(-1);

/** Through the form: an amount, the button, the order's screen; its id. */
async function newSell(amount, { from = null } = {}) {
  await openForm();
  await page.fill(tid('sell-amount'), String(amount));
  if (from) await page.click(tid(`sell-from-${from}`));
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-cta"]')?.disabled === false, null, { timeout: 30000 });
  await page.click(tid('sell-cta'));
  await waitScreen(page, 'sellOrder', 30000);
  await page.waitForSelector(tid('sell-steps'));
  return newestId();
}

before(async () => {
  srv = await startServer({ root: 'dist-fake', port: PORT, extra: ['--fake-backend'] });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(srv.url).origin });
  await ctx.route((u) => u.hostname === 'buyfiro.app', sellfiroRoute);
  // Nothing may reach a real Ethereum server or CoinGecko.
  await ctx.route((u) => [...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS].some((x) => x.host === u.hostname) || u.hostname === 'api.coingecko.com', (r) => r.abort());
  // buyfiro.app's test mode for this page: honoured on localhost only.
  await ctx.addInitScript((k) => localStorage.setItem(k, '1'), SANDBOX_KEY);
  ({ page, rec } = await recordedPage(ctx, { label: 'sell' }));
  console.log(`# screenshots: ${SHOTS}`);
});

after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
});

test('a new wallet; Home has Buy FIRO, Sell FIRO, Bridge, Spark name; no Sell code and no request to buyfiro.app first', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await waitSynced(page);
  await page.waitForSelector(tid('sc-sell'));
  const labels = await page.$$eval(`${tid('home-shortcuts')} .shortcut-label`, (els) => els.map((e) => e.textContent));
  assert.deepEqual(labels, ['Buy FIRO', 'Sell FIRO', 'Bridge', 'Spark name']);
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/lib\/sell\/|\/screens\/sell_(?!screens)/.test(e.name)).map((e) => e.name));
  assert.deepEqual(loaded, [], 'first paint carries no Sell screen');
  assert.equal(sf.requests.length, 0, 'nothing asked of buyfiro.app before Sell is opened');
  // Funds to sell: 1,000 FIRO private, 400 public (the stand-in engine's test controls), confirmed.
  await fake.credit(page, { to: 'private', amount: '100000000000' });
  await fake.credit(page, { to: 'public', amount: '40000000000' });
  await page.waitForFunction(() => window.__campfire.balance().private.available === '100000000000' && window.__campfire.balance().public.available === '40000000000', null, { timeout: 30000 });
});

test('Sell asks which FIRO: FIRO through buyfiro.app, or rsFIRO (an Ethereum & BNB wallet first); Not now closes it', { timeout: 2 * 60000 }, async () => {
  await page.click(tid('sc-sell'));
  await page.waitForSelector(tid('sell-chooser-title'));
  assert.equal(await page.textContent(tid('sell-chooser-title')), 'Which FIRO do you want to sell?');
  assert.match(await page.textContent(tid('sell-choose-firo')), /FIRO\s*Private or public.*From your Firo wallet\. Get USDT on BNB Chain.*Sell FIRO/);
  await page.waitForSelector(tid('sell-rsfiro-setup'));
  assert.match(await page.textContent(tid('sell-choose-rsfiro')), /rsFIRO on Ethereum or BNB\s*Public.*Add an Ethereum & BNB wallet first/);
  await shots2('00-chooser-no-eth');
  await page.click(tid('sell-chooser-close'));
  await page.waitForSelector(tid('sell-chooser-title'), { state: 'detached' });
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'home');
  await page.click(tid('sc-sell'));
  await page.click(tid('sell-choose-firo'));
  await waitScreen(page, 'sellFiro', 20000);
});

test('Sell FIRO without an Ethereum & BNB wallet: the smallest sell, a pasted address checked, then a wallet set up from the form', { timeout: 4 * 60000 }, async () => {
  await page.waitForSelector(tid('sell-no-eth'));
  await page.waitForFunction(() => /Smallest sell right now: 300 FIRO/.test(document.querySelector('[data-testid="sell-minimum-hint"]')?.textContent || ''));
  assert.equal(await page.textContent('.topbar h1'), 'Sell FIRO');
  assert.equal(await page.getAttribute(tid('sell-from-private'), 'aria-checked'), 'true', 'private by default');
  assert.match(await page.textContent(tid('sell-footer')), /Nothing leaves your wallet until you confirm the payment on the next screen\./);
  assert.ok(await ctaVisibleOnSmallPhone(tid('sell-cta')), 'the button is on a 375 x 667 screen without scrolling');
  await shots2('01-form-no-eth');

  // Under the smallest sell: said in FIRO, fixed in one tap.
  await page.fill(tid('sell-amount'), '100');
  await page.waitForSelector(`${tid('sell-problem')}[data-code="amount_below_minimum"]`);
  assert.match(await page.textContent(tid('sell-problem')), /Sell at least 300 FIRO.*Nothing was sent/);
  assert.doesNotMatch(await mainText(), NO_COST, 'no cost of buyfiro.app on Sell');
  await shots2('02-below-minimum');
  await page.click(tid('sell-fix'));
  assert.equal(await page.inputValue(tid('sell-amount')), '300');
  await page.waitForSelector(tid('sell-estimate'));
  assert.match(await page.textContent(tid('sell-reason')), /Choose where buyfiro\.app pays you/);
  assert.equal(await page.isDisabled(tid('sell-cta')), true);

  // A pasted address: its checksum is checked.
  await page.click(tid('sell-address-paste-mode'));
  await page.fill(tid('sell-address'), ETH_ADDRESS.replace('f39Fd6', 'f39fD6'));
  await page.waitForFunction(() => /typo/.test(document.querySelector('[data-testid="sell-address-hint"]')?.textContent || ''));
  await shots2('03-pasted-typo');
  await page.fill(tid('sell-address'), ETH_ADDRESS.toLowerCase());
  await page.waitForFunction(() => /buyfiro\.app pays USDT to this address on BNB Chain/.test(document.querySelector('[data-testid="sell-address-hint"]')?.textContent || ''));
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-cta"]')?.disabled === false);
  assert.equal(await page.textContent(tid('sell-cta')), 'Sell 300 FIRO');

  // Or an Ethereum & BNB wallet next to the FIRO, set up from here, and back to the same form.
  await page.click(tid('sell-eth-setup-instead'));
  await waitScreen(page, 'ethStart', 20000);
  assert.equal(await page.textContent(tid('eth-start-why')), 'First, a wallet for your USDT');
  await shots2('04-eth-start-for-payout');
  await page.click(tid('eth-import'));
  await waitScreen(page, 'ethImport');
  await page.fill(tid('eth-words-input'), ETH_KEY);
  await page.waitForFunction(() => !document.querySelector('[data-testid="eth-import-submit"]').disabled);
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.click(tid('eth-connect'));
  await waitScreen(page, 'sellFiro', 30000);
  assert.equal(await page.inputValue(tid('sell-amount')), '300', 'the amount is still there');
  await page.waitForSelector(tid('sell-paid-to'));
  assert.match(await page.textContent(tid('sell-paid-to')), /To your Ethereum & BNB wallet \(0xf39F…2266\)/);
});

test('Sell FIRO: the payout picker, Max, the price, the order (Spark deposit, USDT on BNB Chain to this wallet)', { timeout: 4 * 60000 }, async () => {
  // The payout picker: USDT on BNB Chain first, then every network buyfiro.app pays on.
  await page.click(tid('sell-payout'));
  await page.waitForSelector(tid('sell-payout-default'));
  await page.waitForSelector(tid('sell-chain-row'));
  assert.match(await page.textContent(tid('sell-payout-default')), /USDT on BNB Chain.*Recommended/);
  await shots2('05-payout-networks');
  await page.click(`${tid('sell-chain-row')}[data-chain-id="1"]`);
  await page.waitForSelector(tid('sell-token-row'));
  assert.deepEqual(await page.$$eval(tid('sell-token-row'), (els) => els.map((e) => e.querySelector('.t').textContent)), ['ETH', 'USDT']);
  await shots2('06-payout-tokens');
  await page.click(`${tid('sell-token-row')}[data-token="0x0000000000000000000000000000000000000000"]`);
  await page.waitForFunction(() => /ETH\s*Ethereum/.test(document.querySelector('[data-testid="sell-payout"]')?.textContent || ''));
  await page.waitForSelector(tid('sell-estimate'));
  assert.match(await page.textContent(tid('sell-receive-line')), /In ETH on Ethereum, through a cross-chain swap/);
  const q = sf.requests.filter((r) => r.path === '/quote').at(-1);
  assert.equal(q.url.searchParams.get('payout_chain_id'), '1');
  // Back to the default.
  await page.click(tid('sell-payout'));
  await page.click(tid('sell-payout-default'));
  await page.waitForFunction(() => /USDT\s*BNB Chain/.test(document.querySelector('[data-testid="sell-payout"]')?.textContent || ''));

  // Max: everything private, the network's part taken out (the stand-in takes 0.0002 FIRO).
  await page.click(tid('sell-max'));
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-amount"]').value === '999.9998');
  // The real amount.
  await page.fill(tid('sell-amount'), '500');
  await page.waitForSelector(tid('sell-estimate'));
  assert.equal(await page.getAttribute(tid('sell-estimate'), 'data-usd'), '480', "what buyfiro.app said arrives, as it is");
  assert.match(await page.textContent(tid('sell-estimate')), /≈\s\$480/);
  assert.match(await page.textContent(tid('sell-receive-line')), /^In USDT on BNB Chain$/);
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-cta"]')?.disabled === false);
  assert.equal(await page.textContent(tid('sell-cta')), 'Sell 500 FIRO');
  assert.doesNotMatch(await mainText(), NO_COST, 'no cost of buyfiro.app on Sell');
  const quote = sf.requests.filter((r) => r.path === '/quote').at(-1);
  assert.deepEqual(Object.fromEntries(quote.url.searchParams), { amount_firo: '500', payout_chain_id: '56', payout_token: USDT_BSC, sandbox: 'true' });
  await shots2('07-form-priced');

  await page.click(tid('sell-cta'));
  await waitScreen(page, 'sellOrder', 30000);
  await page.waitForSelector(tid('sell-pay-card'));
  const post = lastOrder();
  assert.equal(post.url.search, '?sandbox=true', 'test mode in the URL; the payout address never in it');
  assert.deepEqual(post.body, { amount_firo: 500, payout_chain_id: 56, payout_token: USDT_BSC, payout_address: ETH_ADDRESS, deposit_kind: 'spark', order_type: 'market', sandbox: true });
});

test("the payment: reviewed on the sell's screen, paid from the private balance to the Spark deposit address, exactly 500 FIRO", { timeout: 3 * 60000 }, async () => {
  assert.equal(await page.textContent('.topbar h1'), 'Send 500 FIRO');
  assert.equal(await page.textContent(tid('sell-pay-amount')), '500 FIRO');
  assert.equal(await page.getAttribute(tid('sell-pay-to'), 'data-address'), SPARK_DEPOSIT, "buyfiro.app's Spark deposit address");
  assert.equal(await page.getAttribute(tid('sell-pay-from-private'), 'aria-checked'), 'true');
  await page.waitForSelector(tid('sell-pay-total'));
  assert.equal(await page.textContent(tid('sell-pay-total')), '500.0002 FIRO', 'what leaves the wallet, before anything is signed');
  assert.equal(await page.textContent(tid('sell-pay-receive')), '≈\u00a0$480 in USDT on BNB Chain');
  assert.match(await page.textContent(tid('sell-pay-payout')), /Your Ethereum & BNB wallet\s*0xf39F…2266/);
  assert.match(await page.textContent(tid('sell-pay-privacy')), /^Private: the amount, you and the receiver stay hidden/);
  assert.match(await page.textContent(tid('sell-expires')), /buyfiro\.app takes it until \d\d:\d\d (today|on \d+ \w+)\. A payment cannot be taken back/);
  assert.match(await page.textContent(tid('sell-test-mode')), /test mode: nothing is sold/);
  assert.equal(await page.textContent(tid('sell-order-cta')), 'Send 500 FIRO to buyfiro.app');
  assert.equal(await page.getAttribute(tid('sell-step-0'), 'data-mark'), 'active');
  assert.ok(await ctaVisibleOnSmallPhone(tid('sell-order-cta')));
  assert.doesNotMatch(await mainText(), NO_COST);
  await shots2('08-order-review');

  // Paid from the public balance it would go to the transparent address: said before anything moves.
  await page.click(tid('sell-pay-from-public'));
  await page.waitForFunction((a) => document.querySelector('[data-testid="sell-pay-to"]')?.dataset.address === a, T_DEPOSIT);
  await page.waitForFunction(() => /not enough/.test(document.querySelector('[data-testid="sell-pay-reason"]')?.textContent || ''), null, { timeout: 15000 });
  assert.match(await page.textContent(tid('sell-pay-reason')), /Your public balance has 400 FIRO: not enough to send 500 FIRO\./);
  assert.ok(await page.isVisible(tid('sell-pay-other')));
  await page.click(tid('sell-pay-other'));
  await page.waitForFunction((a) => document.querySelector('[data-testid="sell-pay-to"]')?.dataset.address === a, SPARK_DEPOSIT);
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-order-cta"]')?.disabled === false, null, { timeout: 15000 });

  const before = await page.evaluate(() => globalThis.__firoFake.state().txs.length);
  await page.click(tid('sell-order-cta'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(tid('sell-sent'), { timeout: 30000 });
  const sent = await page.evaluate(() => globalThis.__firoFake.state().txs);
  assert.equal(sent.length, before + 1, 'one payment');
  const tx = sent.find((t) => t.direction === 'out');
  assert.equal(tx.counterparty, SPARK_DEPOSIT, "to buyfiro.app's Spark deposit address");
  assert.equal(tx.amount, '50000000000', 'exactly 500 FIRO');
  assert.equal(tx.kind, 'spark', 'from the private balance');
  assert.equal(await page.getAttribute('main', 'data-paid'), 'true');
  assert.equal(await page.isVisible(tid('sell-pay-card')), false, 'never offered for payment again');
  assert.equal(await page.textContent(tid('sell-step-0')), 'Your FIRO is on its way to buyfiro.app');
  assert.equal(await page.textContent(tid('sell-order-cta')), 'Back to your wallet');
  assert.ok(await page.isVisible(tid('sell-your-payment')));
  assert.match(await page.textContent(tid('sell-keep-order')), /on this device only, not in your backup file/, 'FM-6: the order number is kept here only');
  await shots2('09-order-sent');
  // Opened again: still paid, never offered for payment again.
  await page.evaluate(() => window.__campfire.go('home'));
  await page.evaluate((id) => window.__campfire.go('sellOrder', { id }), newestId());
  await page.waitForSelector(tid('sell-sent'));
  assert.equal(await page.isVisible(tid('sell-pay-card')), false);
});

test("its states as buyfiro.app reports them, the payout's explorer link, the sells list, still there after locking", { timeout: 5 * 60000 }, async () => {
  const id = newestId();
  sf.states.set(id, 'deposit_detected');
  await page.waitForSelector(`${tid('sell-step-0')}[data-mark="done"]`, { timeout: 60000 });
  assert.match(await page.textContent(tid('sell-step-0')), /buyfiro\.app has your FIRO.*being confirmed/);
  await shots2('10-order-received');
  sf.states.set(id, 'selling');
  await page.waitForSelector(`${tid('sell-step-1')}[data-mark="active"]`, { timeout: 60000 });
  await shots2('11-order-selling');
  sf.states.set(id, 'paying_out');
  await page.waitForSelector(`${tid('sell-step-2')}[data-mark="active"]`, { timeout: 60000 });
  assert.equal(await page.textContent(tid('sell-step-2')), 'Sending USDT to you');
  sf.payoutTxid = TXID;
  sf.payoutExplorer = `https://bscscan.com/tx/${TXID}`;
  sf.proceedsUsd = 479.51;
  sf.receivedFiro = 500;
  sf.states.set(id, 'delivered');
  await page.waitForSelector(tid('sell-delivered'), { timeout: 60000 });
  assert.match(await page.textContent(tid('sell-delivered')), /Paid: \$479\.51 in USDT\..*sent it to your Ethereum & BNB wallet on BNB Chain/);
  assert.equal(await page.getAttribute(tid('sell-step-2'), 'data-mark'), 'done');
  assert.equal(await page.getAttribute(tid('sell-payout-link'), 'href'), `https://bscscan.com/tx/${TXID}`);
  assert.equal(await page.textContent(tid('sell-payout-link')), 'See the USDT payout on bscscan.com');
  assert.equal(await page.textContent(tid('sell-payout-txid')), '0xc8c8…c8c8');
  assert.equal(await page.textContent(tid('sell-proceeds')), '$479.51 in USDT');
  assert.equal(await page.textContent(tid('sell-order-cta')), 'Open your Ethereum & BNB wallet');
  assert.doesNotMatch(await mainText(), NO_COST);
  await shots2('12-order-delivered');
  // What buyfiro.app reports for this sell only.
  sf.payoutTxid = null;
  sf.payoutExplorer = null;
  sf.proceedsUsd = null;
  sf.receivedFiro = null;
  const polls = sf.requests.filter((r) => r.path === `/order/${id}`).length;
  await sleep(7000);
  assert.equal(sf.requests.filter((r) => r.path === `/order/${id}`).length, polls, 'an ended sell is never asked about again');

  // A link to an explorer this version does not know: the transaction id instead, never the link.
  await page.evaluate(() => window.__campfire.go('sellOrders'));
  await waitScreen(page, 'sellOrders');
  await page.waitForSelector(`${tid('sell-order-row')}[data-order="${id}"][data-state="delivered"]`);
  assert.match(await page.textContent(`${tid('sell-order-row')}[data-order="${id}"]`), /500 FIRO → \$479\.51 USDT.*USDT sent to you/);
  await shots2('13-sells');
  // Sealed on this device, under the wallet's own key; nothing in the clear.
  const stored = await page.evaluate(async () => {
    const { rawStore } = await import('./lib/store.js');
    const keys = await rawStore.keys('w:');
    const k = keys.find((x) => x.endsWith(':sell'));
    return k ? JSON.stringify(await rawStore.get(k)) : null;
  });
  assert.ok(stored && stored.length > 100);
  for (const s of [id, SPARK_DEPOSIT, T_DEPOSIT, ETH_ADDRESS, ETH_ADDRESS.toLowerCase()]) assert.equal(stored.includes(s), false, 'sealed');
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('lock'));
  await waitScreen(page, 'unlock');
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await page.evaluate(() => window.__campfire.go('sellOrders'));
  await page.waitForSelector(`${tid('sell-order-row')}[data-order="${id}"][data-state="delivered"]`);
});

test('the endings: no FIRO in time, could not be started, held for review', { timeout: 5 * 60000 }, async () => {
  for (const [state, key, cta] of [
    ['expired', 'sell-expired', /^Start a new sell$/],
    ['refused', 'sell-refused', /^Start a new sell$/],
    ['attention', 'sell-attention', /^Contact buyfiro\.app support$/],
  ]) {
    const id = await newSell(300, { from: 'public' });
    assert.equal(lastOrder().body.deposit_kind, 'firo', 'paying from public asks for a transparent deposit');
    assert.equal(await page.getAttribute(tid('sell-pay-to'), 'data-address'), T_DEPOSIT);
    sf.states.set(id, state);
    await page.waitForSelector(tid(key), { timeout: 60000 });
    assert.match(await page.textContent(tid('sell-order-cta')), cta);
    if (state === 'attention') assert.equal(await page.getAttribute(tid('sell-order-cta'), 'href'), 'https://buyfiro.app');
    else assert.match(await page.textContent(tid(key)), /Nothing was taken/);
    await shots2(`14-order-${state}`);
  }
});

test('Spark deposits off at buyfiro.app: the sell takes a transparent deposit address, and says so', { timeout: 3 * 60000 }, async () => {
  sf.sparkOff = true;
  try {
    await newSell(350);
    assert.deepEqual(sf.posts().slice(-2).map((p) => p.body.deposit_kind), ['spark', 'firo']);
    await page.waitForSelector(tid('sell-fell-back'));
    assert.match(await page.textContent(tid('sell-fell-back')), /takes public FIRO only right now/);
    assert.equal(await page.getAttribute(tid('sell-pay-to'), 'data-address'), T_DEPOSIT);
    assert.match(await page.textContent(tid('sell-pay-privacy')), /what arrives at the receiver's public address can be seen/);
    await shots2('15-spark-off');
  } finally {
    sf.sparkOff = false;
  }
});

test('an interrupted payment: the sell says to look in Activity first, and offers the payment again only when told it is not there', { timeout: 2 * 60000 }, async () => {
  const id = newestId(); // the sell above: open, unpaid
  // As if the page had died between "payment started" and "payment sent".
  await page.evaluate(async (orderId) => {
    const { app } = await import('./app.js');
    const { sellFiro } = await import('./lib/sell/wiring.js');
    await sellFiro(app).markSending(orderId);
  }, id);
  await page.evaluate(() => window.__campfire.go('home'));
  await page.evaluate((orderId) => window.__campfire.go('sellOrder', { id: orderId }), id);
  await page.waitForSelector(tid('sell-interrupted'));
  assert.match(await page.textContent(tid('sell-interrupted')), /started at \d\d:\d\d, and Firo PWA can't tell whether it left\. Look in Activity first/);
  assert.equal(await page.textContent(tid('sell-order-cta')), 'Open Activity');
  assert.equal(await page.isVisible(tid('sell-pay-card')), false, 'no payment offered');
  await shots2('15b-interrupted');
  await page.click(tid('sell-pay-anyway'));
  await page.waitForSelector(tid('sell-pay-card'));
  assert.equal(await page.textContent(tid('sell-order-cta')), 'Send 350 FIRO to buyfiro.app');
});

test('no answer from the node (FM-1): "may have left", followed, never offered again; one the network does not have is payable again; one that arrives is paid', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(() => globalThis.__firoFake.hold(true));
  try {
    // From the public balance to the transparent deposit address (nothing was paid there before).
    await newSell(320, { from: 'public' });
    const payOnce = async () => {
      await page.waitForFunction(() => document.querySelector('[data-testid="sell-order-cta"]')?.disabled === false, null, { timeout: 30000 });
      await page.click(tid('sell-order-cta'));
      await page.waitForSelector(tid('auth-pw'));
      await page.fill(tid('auth-pw'), PASSWORD);
      await page.click(tid('auth-submit'));
      await page.waitForSelector(tid('sell-unsure'), { timeout: 30000 });
    };
    // 1. It never reached the network.
    await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: false }));
    await payOnce();
    assert.match(await page.textContent(tid('sell-unsure')), /^Your payment may have left\. Don't send it again yet: Firo PWA is checking\. /);
    assert.equal(await page.textContent(tid('sell-order-cta')), 'Follow it in Activity');
    assert.equal(await page.isVisible(tid('sell-pay-card')), false, 'never offered again while in doubt');
    assert.equal(await page.textContent(tid('sell-step-0')), 'Your FIRO may be on its way to buyfiro.app');
    await shots2('15c-unsure');
    await fake.mine(page);
    await fake.mine(page);
    await page.waitForSelector(tid('sell-unsure-gone'), { timeout: 30000 });
    assert.match(await page.textContent(tid('sell-unsure-gone')), /didn't go through: the Firo network doesn't have it/);
    await page.waitForSelector(tid('sell-pay-card'));
    assert.equal(await page.textContent(tid('sell-order-cta')), 'Send 320 FIRO to buyfiro.app');
    await shots2('15d-unsure-gone');
    // 2. It did reach the network: paid once it is in a block, never offered again.
    await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: true }));
    await payOnce();
    await fake.mine(page);
    await fake.mine(page);
    await page.waitForSelector(tid('sell-sent'), { timeout: 30000 });
    assert.equal(await page.getAttribute('main', 'data-paid'), 'true');
    assert.equal(await page.isVisible(tid('sell-pay-card')), false);
  } finally {
    await page.evaluate(() => globalThis.__firoFake.hold(false));
  }
});

test('the node in use says the payment never left, no second node for an hour (re-audit 3 RE3-3): the sell offers to let it go; then it is payable again, said as the person\'s choice', { timeout: 3 * 60000 }, async () => {
  await fake.credit(page, { to: 'public', amount: '40000000000' });
  await page.waitForFunction(() => BigInt(window.__campfire.balance().public.available) >= 40000000000n, null, { timeout: 30000 });
  await page.evaluate(() => globalThis.__firoFake.hold(true));
  // Its own deposit address, as buyfiro.app gives every order: the stand-in's shared one already
  // has the previous test's payment, which would (rightly) show this order as paid.
  const sharedDeposit = sf.transparentDeposit;
  sf.transparentDeposit = 'aLetGoTestDeposit23456789ABCDEFGHJ';
  try {
    await newSell(320, { from: 'public' });
    await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: false, oneNode: true }));
    await page.waitForFunction(() => document.querySelector('[data-testid="sell-order-cta"]')?.disabled === false, null, { timeout: 30000 });
    await page.click(tid('sell-order-cta'));
    await page.waitForSelector(tid('auth-pw'));
    await page.fill(tid('auth-pw'), PASSWORD);
    await page.click(tid('auth-submit'));
    await page.waitForSelector(tid('sell-unsure'), { timeout: 30000 });
    assert.equal(await page.$(tid('let-go')), null, 'nothing to let go before the hour');
    await fake.mine(page);
    await fake.mine(page);
    await page.waitForSelector(tid('let-go'), { timeout: 30000 });
    assert.match(await page.textContent(tid('let-go')), /^The Firo node in use says it never left: you can let it go\. That is one node's word: .*If it did leave, sending again pays twice\./);
    assert.equal(await page.textContent(tid('sell-order-cta')), 'Follow it in Activity');
    assert.equal(await page.isVisible(tid('sell-pay-card')), false, 'not offered again before the tap');
    await shots2('15e-one-node');
    await page.click(tid('let-go-button'));
    await page.waitForSelector(`${tid('sell-unsure-gone')}[data-let-go="true"]`, { timeout: 30000 });
    assert.match(await page.textContent(tid('sell-unsure-gone')), /^You let your earlier payment go on the word of the Firo node in use: its FIRO is back in your balance\. If it did leave, buyfiro\.app shows it here once it arrives, and sending it again would pay twice\./);
    await page.waitForSelector(tid('sell-pay-card'));
    assert.equal(await page.textContent(tid('sell-order-cta')), 'Send 320 FIRO to buyfiro.app');
    await shots2('15f-let-go');
  } finally {
    sf.transparentDeposit = sharedDeposit;
    await page.evaluate(() => globalThis.__firoFake.hold(false));
  }
});

test('refusals in plain words: too many new sells, buyfiro.app unreachable, an answer that is not the order; nothing was sent', { timeout: 3 * 60000 }, async () => {
  await openForm();
  await page.fill(tid('sell-amount'), '400');
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-cta"]')?.disabled === false, null, { timeout: 30000 });
  sf.queue('/order', answer(429, sellErrorJson('rate_limited', { retryAfter: 300 })));
  await page.click(tid('sell-cta'));
  await page.waitForSelector(`${tid('sell-problem')}[data-code="rate_limited"]`);
  assert.match(await page.textContent(tid('sell-problem')), /a few new sells an hour.*nothing was sent\. Try again in 5 minutes\./);
  await shots2('16-rate-limited');
  // An answer for another amount, or with an address the wallet does not read: not used, not kept.
  const before = sf.orders.size;
  sf.queue('/order', envelope({ sandbox: true, order_id: 'sbx_s1_bad', payable: true, deposit_address: T_DEPOSIT, spark_deposit_address: 'not-a-firo-address', deposit_kind: 'spark', amount_firo: 400 }));
  await page.click(tid('sell-fix'));
  await page.waitForSelector(`${tid('sell-problem')}[data-code="unexpected_answer"]`);
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'sellFiro');
  await page.evaluate(() => window.__campfire.go('sellOrders'));
  await waitScreen(page, 'sellOrders');
  await page.waitForSelector(tid('sell-order-row'));
  assert.equal(await page.$(`${tid('sell-order-row')}[data-order="sbx_s1_bad"]`), null, 'nothing kept');
  assert.equal(sf.orders.size, before);
  await openForm();
  await page.fill(tid('sell-amount'), '400');
  // Unreachable: a proxy's HTML page instead of buyfiro.app's answer.
  const quotes = (u) => u.hostname === 'buyfiro.app' && u.pathname.endsWith('/quote');
  await page.route(quotes, (r) => r.fulfill({ status: 403, headers: { ...cors, 'content-type': 'text/html' }, body: '<html>Blocked</html>' }));
  await page.fill(tid('sell-amount'), '450');
  await page.waitForSelector(`${tid('sell-problem')}[data-code="blocked"]`);
  assert.match(await page.textContent(tid('sell-problem')), /Couldn't reach buyfiro\.app.*Nothing was sent/);
  await shots2('17-unreachable');
  await page.unroute(quotes);
  await page.click(tid('sell-fix'));
  await page.waitForSelector(tid('sell-estimate'));
  // Over the largest sell (buyfiro.app's own figure): the amount that works, in one tap.
  await page.fill(tid('sell-amount'), '20000');
  await page.waitForSelector(`${tid('sell-problem')}[data-code="amount_above_maximum"]`);
  assert.match(await page.textContent(tid('sell-problem')), /Sell at most 9,691 FIRO at a time/);
  await page.evaluate(() => window.__campfire.go('home'));
});

test('only test-mode requests: every call carried sandbox=true in its URL, every order in its body; none was refused', async () => {
  const posts = sf.requests.filter((r) => r.method !== 'GET');
  assert.ok(posts.length >= 5);
  for (const r of posts) assert.equal(r.body && r.body.sandbox, true);
  for (const r of sf.requests) assert.equal(r.url.searchParams.get('sandbox'), 'true', `every call in test mode: ${r.url}`);
  assert.deepEqual(sf.violations, []);
});

test('IP privacy: only this origin and buyfiro.app (answered here); no CSP violation, no page error', async () => {
  const hosts = foreignHosts(rec, srv.url).sort();
  assert.deepEqual(hosts, ['https://buyfiro.app']);
  assert.deepEqual(rec.csp, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});

test('rsFIRO: Sell opens the Ethereum swap (rsFIRO for ETH) and the BNB Chain swap (rsFIRO for BNB)', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('sc-sell'));
  await page.waitForSelector(tid('sell-rsfiro-eth'));
  await shots2('18-chooser');
  await page.click(tid('sell-rsfiro-eth'));
  await waitScreen(page, 'ethSwap', 30000);
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('sc-sell'));
  await page.click(tid('sell-rsfiro-bnb'));
  await waitScreen(page, 'ethSwapBsc', 30000);
  await page.evaluate(() => window.__campfire.go('home'));
});
