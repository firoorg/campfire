// Buying rsFIRO with any coin (NEAR Intents), end to end through the screens:
// the installed Google Chrome (headless), the dev server with the production
// headers, its own build and port, a throwaway Firo wallet on the stand-in
// engine (no network, spends nothing) and an Ethereum wallet imported from
// fresh words.
//
//   npm run e2e:near-intents      (own build in a temp folder, port 8980)
//   NI_LIVE=0 to skip the live part.
//
// Ethereum: Stack Wallet's server is routed to the local anvil fork when one
// answers on 8545 (read only: no state is changed, no lock taken), else to a
// small stand-in that answers balances with 0. Every other Ethereum host and
// CoinGecko are refused.
//
// 1. Nothing is asked of NEAR Intents before its screen is opened: not at
//    first paint, not on Ethereum Home, not on Buy rsFIRO (the Uniswap swap).
// 2. NEAR Intents stubbed in the page (Playwright answers 1click.chaindefuser.com):
//    the coin list (BTC first), a price, every refusal the form has words for,
//    an unreachable service, and a deposit address that is not signed for
//    this swap, which must never be shown.
// 3. Live: the real 1Click, from the page and under the page's real CSP:
//    its coins, a real price for 0.00012 BTC (ZEC if BTC has no taker), and a
//    real, signed deposit address for this wallet with a made-up refund
//    address. NOTHING is sent to it. Its status is read live (waiting).
// 4. That swap's later states stubbed (status answers are not signed): seen,
//    swapping, done with the ETH that arrived, then "Swap … ETH to rsFIRO"
//    opens the swap with that amount; Ethereum Home lists it while it is open.
// 5. IP privacy: only this origin, the Ethereum server and
//    1click.chaindefuser.com; no CSP violation, no page error.
//
// Screenshots at 390x844 in light and dark into $CAMPFIRE_SHOTS/near_intents
// (never words, never a key); the primary action is checked on a 375x667 phone.
import { BSC_RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jsQR from 'jsqr';
import { startServer, launch, recordedPage, waitScreen, foreignHosts, sleep, SHOTS, PWA } from './harness.mjs';
import { createWallet, waitHome } from './flows.mjs';
import { ANVIL, anvilProblem } from '../fork/fork_support.mjs';
import { ethKeyFromMnemonic, newMnemonic, wipe } from '../../src/lib/eth/crypto.js';
import { ETH_RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import { bech32, createBase58check } from '../../src/vendor/noble/scure-base/index.js';
import { sha256 } from '../../src/vendor/noble/noble-hashes/sha2.js';

const PORT = Number(process.env.CAMPFIRE_NI_PORT || 8980);
const PASSWORD = `ni-${Math.random().toString(36).slice(2, 10)}`;
const STACK = 'eth2.stackwallet.com';
const ONECLICK = '1click.chaindefuser.com';
const LIVE = process.env.NI_LIVE !== '0';
const OUT = join(SHOTS, 'near_intents');
const tid = (id) => `[data-testid="${id}"]`;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const anvil = (await anvilProblem()) === null;
/** A made-up Bitcoin address (P2WPKH of random bytes): valid, held by nobody. Refunds only; nothing is ever sent. */
const madeUpBtc = () => bech32.encode('bc', [0, ...bech32.toWords(globalThis.crypto.getRandomValues(new Uint8Array(20)))]);
/** A made-up transparent Zcash address (t1, random hash, valid checksum). */
const madeUpZec = () => createBase58check(sha256).encode(new Uint8Array([0x1c, 0xb8, ...globalThis.crypto.getRandomValues(new Uint8Array(20))]));

let tmp, srv, browser, ctx, page, rec;
let ethAddress = null;
const ni = { mode: 'stub', requests: [], quote: 'ok', status: 'PENDING_DEPOSIT', statusOut: null, live: null };

// ------------------------------------------------------------------ NEAR Intents, stubbed
const TOKENS = [
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 2500 },
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 5.23, contractAddress: 'wrap.near' },
  { assetId: 'nep141:ltc.omft.near', decimals: 8, blockchain: 'ltc', symbol: 'LTC', price: 63.7 },
  { assetId: 'nep141:zec.omft.near', decimals: 8, blockchain: 'zec', symbol: 'ZEC', price: 1224.93 },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 82967 },
  { assetId: 'nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near', decimals: 6, blockchain: 'tron', symbol: 'USDT', price: 1, contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' },
  { assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDT', price: 1, contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7' },
];

/** A price-only answer for what was asked (1Click does not need to sign it for the app to show a price). */
function dryAnswer(body) {
  const t = TOKENS.find((x) => x.assetId === body.originAsset);
  const usdIn = (Number(body.amount) / 10 ** t.decimals) * t.price;
  const out = BigInt(Math.floor((usdIn * 0.989 * 1e18) / 2500));
  return {
    quote: { amountIn: body.amount, amountInFormatted: String(Number(body.amount) / 10 ** t.decimals), amountInUsd: usdIn.toFixed(4), minAmountIn: body.amount, amountOut: String(out), amountOutFormatted: '', amountOutUsd: (usdIn * 0.989).toFixed(4), minAmountOut: String((out * 99n) / 100n), timeEstimate: 812, refundFee: '1900', withdrawFee: '35000000000000' },
    quoteRequest: { ...body, depositMode: 'SIMPLE', confidentiality: 'public', insured: false },
    signature: 'ed25519:5N8L7mVZ3dZhHjL6VQ5u4bkV8c7r1f1i6WfZ8y5Y6u9QyQ6b8n9pX4b5e2YJbW7aG1h3c6s9f2a8d4e7k5m3n1p',
    timestamp: new Date().toISOString(),
    correlationId: 'stub',
  };
}

function statusAnswer(depositAddress) {
  const details = { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [], refundedAmount: '0' };
  if (ni.status === 'SUCCESS') Object.assign(details, { amountOut: String(ni.statusOut), destinationChainTxHashes: [{ hash: `0x${'5e'.repeat(32)}`, explorerUrl: 'x' }] });
  if (ni.status === 'REFUNDED') Object.assign(details, { refundedAmount: '11500', refundReason: 'Deposit arrived after the deadline' });
  return { status: ni.status, updatedAt: new Date().toISOString(), correlationId: 'stub', swapDetails: details, quoteResponse: { depositAddress } };
}

async function oneClickRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  ni.requests.push({ method: req.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), body: req.postData() ? JSON.parse(req.postData()) : null, headers: req.headers() });
  const json = (status, j) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(j) });
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const statusStub = ni.mode === 'stub' || ni.mode === 'status';
  if (ni.mode === 'live' || (ni.mode === 'status' && url.pathname !== '/v0/status')) return route.continue();
  if (ni.mode === 'down') return route.abort('connectionrefused');
  if (url.pathname === '/v0/tokens') return json(200, TOKENS);
  if (url.pathname === '/v0/status' && statusStub) return json(200, statusAnswer(url.searchParams.get('depositAddress')));
  if (url.pathname === '/v0/quote') {
    const body = JSON.parse(req.postData());
    if (ni.quote === 'noLiquidity') return json(400, { message: 'No liquidity available', correlationId: 'x', path: '/v0/quote' });
    if (ni.quote === 'badRefund') return json(400, { message: 'refundTo is not valid', correlationId: 'x', path: '/v0/quote' });
    if (ni.quote === 'tooSmall') return json(400, { message: 'Amount is too low for bridge, try at least 8516', correlationId: 'x', path: '/v0/quote' });
    if (ni.quote === 'html') return route.fulfill({ status: 502, headers: { ...cors, 'content-type': 'text/html' }, body: '<html>Bad gateway</html>' });
    const a = dryAnswer(body);
    // A "real" quote from this stand-in: an address 1Click never signed for this swap.
    if (!body.dry) a.quote.depositAddress = 'bc1qnotsignedbyneari0ntents0000000000000000';
    return json(201, a);
  }
  return json(404, { message: 'not found' });
}

// ------------------------------------------------------------------ Ethereum
async function stackRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (req.method() === 'GET' && url.pathname === '/export') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: url.searchParams.get('emitter') ? '' : JSON.stringify({ data: [] }) });
  if (req.method() !== 'POST') return route.fulfill({ status: 404, headers: cors, body: '' });
  const body = req.postData();
  if (anvil) {
    // Read-only use of the shared fork: no snapshot, no state change.
    const calls = [].concat(JSON.parse(body));
    if (calls.some((c) => !/^(eth_(chainId|blockNumber|getBalance|call|getBlockByNumber|feeHistory|maxPriorityFeePerGas|gasPrice|getLogs|getCode|estimateGas|getTransactionCount)|net_version)$/.test(c.method))) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'not in this test' } }))) });
    const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
  }
  const answer = (c) => {
    const result = { eth_chainId: '0x1', net_version: '1', eth_blockNumber: '0x18e1a00', eth_getBalance: '0x0', eth_gasPrice: '0x3b9aca00', eth_maxPriorityFeePerGas: '0x3b9aca00', eth_getTransactionCount: '0x0', eth_getCode: '0x' }[c.method];
    if (result !== undefined) return { jsonrpc: '2.0', id: c.id, result };
    if (c.method === 'eth_call') return { jsonrpc: '2.0', id: c.id, result: `0x${'0'.repeat(64)}` };
    if (c.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: c.id, result: { number: '0x18e1a00', timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`, baseFeePerGas: '0x3b9aca00', hash: `0x${'11'.repeat(32)}` } };
    return { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: 'not in this stand-in' } };
  };
  const j = JSON.parse(body);
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(Array.isArray(j) ? j.map(answer) : answer(j)) });
}

// ------------------------------------------------------------------ helpers
async function shots(name) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(150);
    await page.screenshot({ path: join(OUT, `ni-${name}-390-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The primary button is on screen without scrolling on a 375 x 667 phone. */
async function ctaVisibleOnSmallPhone(selector) {
  await page.setViewportSize({ width: 375, height: 667 });
  await sleep(200);
  const box = await page.locator(selector).boundingBox();
  await page.setViewportSize({ width: 390, height: 844 });
  return Boolean(box && box.y >= 0 && box.y + box.height <= 667);
}

const text = (id) => page.textContent(tid(id));
const oneClickCalls = () => rec.requests.filter((u) => new URL(u).hostname === ONECLICK);

async function qrText(selector) {
  const img = await page.evaluate(async (sel) => {
    const svgEl = document.querySelector(`${sel} svg`);
    const blob = new Blob([new XMLSerializer().serializeToString(svgEl)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const im = new Image();
    await new Promise((r, j) => ((im.onload = r), (im.onerror = j), (im.src = url)));
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 400;
    c.getContext('2d').drawImage(im, 0, 0, 400, 400);
    return Array.from(c.getContext('2d').getImageData(0, 0, 400, 400).data);
  }, selector);
  return jsQR(Uint8ClampedArray.from(img), 400, 400).data;
}

/** The deposit screen asks for the swap's status now (as when the page comes back into view). */
async function pollNow() {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

async function fillForm({ amount, refund }) {
  await page.fill(tid('ni-amount'), amount);
  await page.fill(tid('ni-refund'), refund);
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  tmp = mkdtempSync(join(tmpdir(), 'campfire-ni-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(srv.url).origin });
  await ctx.route((u) => u.hostname === ONECLICK, oneClickRoute);
  await ctx.route((u) => u.hostname === STACK, stackRoute);
  await ctx.route((u) => ETH_RPC_HOSTS.some((x) => x.host === u.hostname && x.host !== STACK) || u.hostname === 'api.coingecko.com' || u.hostname === 'buyfiro.app', (r) => r.abort());
  await ctx.route((u) => BSC_RPC_HOSTS.some((x) => x.host === u.hostname), (r) => r.abort());
  ({ page, rec } = await recordedPage(ctx, { label: 'ni' }));
  console.log(`# screenshots: ${OUT}; Ethereum: ${anvil ? 'the anvil fork (read only)' : 'a stand-in'}`);
});

after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('a Firo wallet and an Ethereum wallet; nothing asked of NEAR Intents and none of its code loaded until its screen opens', { timeout: 15 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/lib\/intents\/|\/screens\/near_intents/.test(e.name)).map((e) => e.name));
  assert.deepEqual(loaded, [], 'first paint carries no NEAR Intents code');
  await page.click(tid('chain-eth'));
  await waitScreen(page, 'ethStart');
  await page.click(tid('eth-import'));
  await waitScreen(page, 'ethImport');
  const words = newMnemonic();
  const key = await ethKeyFromMnemonic(words);
  ethAddress = key.address;
  wipe(key.sk);
  await page.fill(tid('eth-words-input'), words);
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.click(tid('eth-connect'));
  await waitScreen(page, 'ethHome');
  await page.waitForSelector(tid('eth-pay-other-coin'));
  assert.match(await text('eth-pay-other-coin'), /Buy rsFIRO with any coin.*BTC, ZEC, LTC, USDT and more, through NEAR Intents/);
  await page.waitForSelector(`${tid('eth-status')}[data-state="ok"]`, { timeout: 60000 });
  await shots('01-eth-home');
  // Buy rsFIRO (the Uniswap swap, ETH -> rsFIRO) offers to pay with BTC, ZEC or LTC too.
  await page.click(tid('eth-buy-rsfiro'));
  await waitScreen(page, 'ethSwap');
  await page.waitForSelector(tid('uni-pay-other-coin'));
  assert.match(await page.textContent('.topbar h1'), /Buy rsFIRO/);
  await shots('03-buy-rsfiro-entry');
  assert.deepEqual(oneClickCalls(), [], 'nothing asked of NEAR Intents before its screen is opened');
});

test('stubbed: the coins (BTC first, no ETH on Ethereum), a price, what arrives, who sees what', { timeout: 5 * 60000 }, async () => {
  ni.mode = 'stub';
  ni.quote = 'ok';
  await page.click(tid('uni-pay-other-coin'));
  await waitScreen(page, 'nearIntents');
  await page.waitForFunction(() => /BTC/.test(document.querySelector('[data-testid="ni-coin"]')?.textContent || ''));
  assert.match(await text('ni-coin'), /BTC\s*Bitcoin/);
  assert.match(await page.textContent('[data-testid="ni-cta"]'), /^Get a BTC deposit address$/);
  assert.match(await text('ni-reason'), /Enter how much BTC you send/);
  assert.match(await text('ni-who-sees'), /NEAR Intents \(1click\.chaindefuser\.com\) sees your IP address, the coin and amount, your refund address and this wallet's address on Ethereum and BNB Chain/);
  assert.ok(await ctaVisibleOnSmallPhone(tid('ni-cta')));
  await shots('04-form-empty');
  // The picker: most used first, ETH on Ethereum left out (it is what arrives).
  await page.click(tid('ni-coin'));
  await page.waitForSelector(tid('ni-coin-row'));
  const rows = await page.$$eval(tid('ni-coin-row'), (els) => els.map((e) => `${e.dataset.symbol}/${e.dataset.chain}`));
  assert.deepEqual(rows.slice(0, 4), ['BTC/btc', 'ZEC/zec', 'LTC/ltc', 'USDT/tron']);
  assert.ok(!rows.includes('ETH/eth'));
  await shots('05-coin-picker');
  await page.fill(tid('ni-coin-search'), 'zcash');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="ni-coin-row"]').length === 1);
  await page.click(tid('ni-coin-row'));
  await page.waitForFunction(() => /ZEC/.test(document.querySelector('[data-testid="ni-coin"]')?.textContent || ''));
  // USDT on Ethereum: this wallet's own address is filled in for a refund.
  await page.click(tid('ni-coin'));
  await page.click(`${tid('ni-coin-row')}[data-chain="eth"]`);
  await page.waitForFunction((a) => document.querySelector('[data-testid="ni-refund"]').value === a, ethAddress);
  assert.match(await text('ni-refund-hint'), /This wallet’s address, filled in for you/);
  // Back to BTC, whose refund address must be typed.
  await page.click(tid('ni-coin'));
  await page.click(`${tid('ni-coin-row')}[data-chain="btc"]`);
  await page.waitForFunction(() => document.querySelector('[data-testid="ni-refund"]').value === '');
  const before = ni.requests.filter((r) => r.path === '/v0/quote').length;
  await fillForm({ amount: '0.00012', refund: madeUpBtc() });
  await page.waitForSelector(tid('ni-eth'), { timeout: 30000 });
  const asked = ni.requests.filter((r) => r.path === '/v0/quote').slice(before);
  assert.ok(asked.length >= 1);
  const q = asked[asked.length - 1];
  assert.equal(q.body.dry, true, 'a price first, no address');
  assert.equal(q.body.recipient, ethAddress, 'the ETH goes to this wallet');
  assert.equal(q.body.amount, '12000');
  assert.equal(q.body.destinationAsset, 'nep141:eth.omft.near');
  assert.equal(q.headers.cookie, undefined);
  assert.equal(q.headers.referer, undefined);
  assert.equal(q.headers['x-api-key'], undefined);
  assert.match(await text('ni-worth'), /≈\s\$9\.96/);
  assert.match(await text('ni-eth'), /^≈\s0\.003/);
  assert.match(await text('ni-min'), /0\.003\d* ETH.*1% price protection/);
  assert.match(await text('ni-time'), /14 minutes.*after your deposit is confirmed/);
  assert.match(await text('ni-fees'), /Included above.*about \$0\.1\d \(1\.1%\).*NEAR Intents' fee and network fees/);
  assert.match(await text('ni-eth-worth'), new RegExp(`delivered to ${ethAddress.slice(0, 6)}`, 'i'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="ni-cta"]').disabled);
  if (anvil) await page.waitForSelector(tid('ni-rsfiro-estimate'), { timeout: 120000 }).catch(() => console.log('# no rsFIRO estimate from the fork within 2 minutes (optional)'));
  assert.ok(await ctaVisibleOnSmallPhone(tid('ni-cta')));
  await shots('06-form-priced');
  await page.locator(tid('ni-who-sees')).scrollIntoViewIfNeeded();
  await shots('06b-form-priced-bottom');
});

test('stubbed: every refusal says what happened and that nothing was sent; an address not signed for this swap is never shown', { timeout: 5 * 60000 }, async () => {
  const problem = async (quote, code, title, fix) => {
    ni.quote = quote;
    await page.fill(tid('ni-amount'), '0.000121');
    await page.fill(tid('ni-amount'), '0.00012');
    await page.waitForSelector(`${tid('ni-problem')}[data-code="${code}"]`, { timeout: 30000 });
    const t = await text('ni-problem');
    assert.match(t, title);
    assert.match(t, /[Nn]othing was sent/);
    assert.match(await text('ni-fix'), fix);
    assert.ok(await page.isDisabled(tid('ni-cta')));
    // Said right above the button too: the notice itself may be under the keyboard.
    assert.match(await text('ni-reason'), title);
  };
  await problem('noLiquidity', 'refused', /NEAR Intents can't swap BTC into ETH right now/, /Try again/);
  await shots('07-no-liquidity');
  await problem('badRefund', 'refused', /That isn't a Bitcoin address/, /Check the address/);
  assert.match(await text('ni-refund-hint'), /NEAR Intents says this isn't a Bitcoin address/);
  await shots('08-bad-refund');
  await problem('tooSmall', 'refused', /Send at least 0\.00008516 BTC/, /Use 0\.00008516 BTC/);
  ni.quote = 'ok';
  await page.click(tid('ni-fix'));
  await page.waitForFunction(() => document.querySelector('[data-testid="ni-amount"]').value === '0.00008516');
  await page.waitForSelector(tid('ni-eth'), { timeout: 30000 });
  await problem('html', 'blocked', /Couldn't reach NEAR Intents/, /Try again/);
  ni.mode = 'down';
  await problem('ok', 'network', /Couldn't reach NEAR Intents/, /Try again/);
  await shots('09-unreachable');
  ni.mode = 'stub';
  await page.click(tid('ni-fix'));
  await page.waitForSelector(tid('ni-eth'), { timeout: 30000 });
  // The stand-in hands out an address 1Click did not sign: refused, nothing kept, the screen stays.
  await page.waitForFunction(() => !document.querySelector('[data-testid="ni-cta"]').disabled);
  await page.click(tid('ni-cta'));
  await page.waitForSelector(`${tid('ni-problem')}[data-code="unsigned"]`, { timeout: 30000 });
  assert.match(await text('ni-problem'), /NEAR Intents' answer didn't check out, so no address is shown/);
  assert.match(await text('ni-reason'), /didn't check out/);
  await sleep(800);
  const box = await page.locator(tid('ni-problem')).boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 844 - 100, 'the refusal is scrolled into view');
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'nearIntents');
  assert.equal(await page.$(tid('ni-deposit-address')), null);
  assert.equal(await page.$(tid('ni-open-swap')), null, 'nothing kept');
  await shots('10-unsigned-refused');
});

test('live: the real NEAR Intents from the page, under its CSP: coins, a price, a signed deposit address for this wallet (nothing sent)', { skip: !LIVE && 'NI_LIVE=0', timeout: 6 * 60000 }, async () => {
  ni.mode = 'live';
  await page.evaluate(() => window.__campfire.go('ethHome'));
  await waitScreen(page, 'ethHome');
  await page.click(tid('eth-pay-other-coin'));
  await waitScreen(page, 'nearIntents');
  await page.waitForFunction(() => /BTC/.test(document.querySelector('[data-testid="ni-coin"]')?.textContent || ''), null, { timeout: 60000 });
  const refund = madeUpBtc();
  let priced = null;
  for (const [sym, chain, amount] of [['BTC', 'btc', '0.00012'], ['ZEC', 'zec', '0.003'], ['BTC', 'btc', '0.0002']]) {
    await page.click(tid('ni-coin'));
    await page.click(`${tid('ni-coin-row')}[data-symbol="${sym}"][data-chain="${chain}"]`);
    await page.waitForFunction((s) => (document.querySelector('[data-testid="ni-coin"]')?.textContent || '').startsWith(s), sym);
    await fillForm({ amount, refund: sym === 'BTC' ? refund : madeUpZec() });
    const got = await Promise.race([page.waitForSelector(tid('ni-eth'), { timeout: 90000 }).then(() => 'priced'), page.waitForSelector(tid('ni-problem'), { timeout: 90000 }).then(() => 'refused')]);
    if (got === 'priced') {
      priced = { sym, amount };
      break;
    }
    console.log(`# live: ${amount} ${sym} -> ETH refused: ${(await text('ni-problem')).slice(0, 160)}`);
  }
  assert.ok(priced, 'NEAR Intents priced none of BTC, ZEC (see the lines above)');
  const eth = await page.getAttribute(tid('ni-eth'), 'data-wei');
  console.log(`# live price: ${priced.amount} ${priced.sym} -> ${eth} wei (${await text('ni-eth')} ETH), ${await text('ni-fees')}, ${await text('ni-time')}`);
  await page.waitForFunction(() => !document.querySelector('[data-testid="ni-cta"]').disabled, null, { timeout: 60000 });
  await shots('11-live-priced');
  await page.click(tid('ni-cta'));
  await waitScreen(page, 'nearIntentsDeposit', 90000);
  await page.waitForSelector(tid('ni-deposit-address'), { timeout: 60000 });
  const deposit = await text('ni-deposit-address');
  ni.live = { deposit, ...priced };
  assert.match(deposit, priced.sym === 'BTC' ? /^bc1/ : /^t1/);
  assert.equal(await text('ni-signed'), ' Signed by NEAR Intents');
  assert.equal(await qrText(tid('ni-qr')), deposit, 'the QR code is the deposit address');
  assert.match(await text('ni-exact-amount'), new RegExp(`^${priced.amount.replace('.', '\\.')} ${priced.sym}$`));
  assert.match(await text('ni-network-warning'), new RegExp(`Send only ${priced.sym} on the`));
  assert.match(await text('ni-deadline'), /Send it before \d\d:\d\d (today|on \d+ \w+)\./);
  assert.match(await page.textContent('.topbar h1'), new RegExp(`^Send ${priced.amount.replace('.', '\\.')} ${priced.sym}$`));
  // Its status, read live: waiting for the deposit nobody will send.
  await page.waitForFunction(() => document.querySelector('main.screen')?.dataset.state === 'PENDING_DEPOSIT');
  await page.waitForSelector(tid('ni-status-waiting'));
  assert.ok(await ctaVisibleOnSmallPhone(tid('ni-deposit-cta')));
  await page.click(tid('ni-deposit-cta'));
  await page.waitForFunction(() => /Address copied/.test(document.querySelector('[data-testid="ni-deposit-cta"]')?.textContent || ''));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), deposit);
  const statusCalls = rec.requests.filter((u) => u.includes(`${ONECLICK}/v0/status`));
  assert.ok(statusCalls.length >= 1);
  console.log(`# live deposit address ${deposit.slice(0, 8)}…${deposit.slice(-4)} (${priced.amount} ${priced.sym}), status PENDING_DEPOSIT; nothing sent`);
  await shots('12-live-deposit');
});

test('the swap\'s later states (statuses stubbed): seen, swapping, the ETH here and "Swap … ETH to rsFIRO"; Ethereum Home shows it while open', { skip: !LIVE && 'NI_LIVE=0', timeout: 5 * 60000 }, async () => {
  assert.ok(ni.live, 'needs the live swap');
  ni.mode = 'status';
  // Ethereum Home and the form show the swap under way.
  await page.evaluate(() => window.__campfire.go('ethHome'));
  await page.waitForFunction(() => /A swap is on its way/.test(document.querySelector('[data-testid="eth-pay-other-coin"]')?.textContent || ''), null, { timeout: 30000 });
  await shots('13-eth-home-open-swap');
  await page.click(tid('eth-pay-other-coin'));
  await waitScreen(page, 'nearIntents');
  await page.waitForSelector(`${tid('ni-open-swap')}[data-deposit="${ni.live.deposit}"]`);
  assert.match(await text('ni-open-swap'), new RegExp(`Waiting for your ${ni.live.amount.replace('.', '\\.')} ${ni.live.sym}`));
  await page.click(tid('ni-open-swap'));
  await waitScreen(page, 'nearIntentsDeposit');
  const state = async (s, key) => {
    ni.status = s;
    await pollNow();
    await page.waitForSelector(tid(`ni-status-${key}`), { timeout: 30000 });
  };
  await state('KNOWN_DEPOSIT_TX', 'seen');
  assert.equal(await page.$(tid('ni-deposit-address')), null, 'the address is not shown once paid');
  assert.deepEqual(await page.$$eval('[data-testid^="ni-step-"]', (els) => els.map((e) => e.dataset.mark)), ['done', 'active', 'waiting']);
  assert.match(await text('ni-deposit-cta'), /Back to your Ethereum wallet/);
  await state('PROCESSING', 'processing');
  await shots('14-swapping');
  ni.statusOut = 3939712647623936n;
  await state('SUCCESS', 'success');
  assert.deepEqual(await page.$$eval('[data-testid^="ni-step-"]', (els) => els.map((e) => e.dataset.mark)), ['done', 'done', 'done']);
  assert.match(await text('ni-status-success'), /0\.003939 ETH arrived in this wallet/);
  assert.match(await text('ni-got'), /0\.003939 ETH/);
  assert.match(await text('ni-eth-tx'), /View on Etherscan/);
  assert.equal(await page.getAttribute(`${tid('ni-eth-tx')} a`, 'href'), `https://etherscan.io/tx/0x${'5e'.repeat(32)}`);
  assert.equal(await text('ni-deposit-cta'), 'Swap 0.003439 ETH to rsFIRO');
  assert.ok(await page.isVisible(tid('ni-keep-eth')));
  assert.ok(await ctaVisibleOnSmallPhone(tid('ni-deposit-cta')));
  await shots('15-done');
  await page.click(tid('ni-deposit-cta'));
  await waitScreen(page, 'ethSwap');
  await page.waitForFunction(() => document.querySelector('[data-testid="uni-pay-amount"]')?.value === '0.003439712647623936');
  assert.match(await page.textContent('[data-testid="uni-receive-token"]'), /rsFIRO/);
  // Kept as done: Ethereum Home no longer shows it under way.
  await page.evaluate(() => window.__campfire.go('ethHome'));
  await page.waitForSelector(tid('eth-pay-other-coin-sub'));
  await sleep(1500);
  assert.equal(await text('eth-pay-other-coin-sub'), 'BTC, ZEC, LTC, USDT and more, through NEAR Intents');
});

test('IP privacy: only this origin, the Ethereum server and NEAR Intents\' API; no CSP violation, no page error', async () => {
  const hosts = foreignHosts(rec, srv.url).sort();
  // The EVM wallet shows both chains, so it asks the chosen BNB Chain server too (refused in this test).
  for (const x of hosts) assert.ok([`https://${ONECLICK}`, `https://${STACK}`].includes(x) || BSC_RPC_HOSTS.some((b) => `https://${b.host}` === x), `unexpected host ${x}`);
  assert.ok(oneClickCalls().every((u) => new URL(u).pathname.startsWith('/v0/')), 'only its API path');
  assert.deepEqual(rec.csp, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
