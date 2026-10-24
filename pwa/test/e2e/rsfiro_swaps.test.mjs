// Buying and selling rsFIRO through the screens, on forks of both chains: Uniswap on Ethereum (the
// shared anvil on 8545, pinned at FORK_BLOCK) and PancakeSwap on BNB Chain (its own anvil on 8549,
// started here at the latest block). The app's own servers (Stack Wallet; BNB Chain's official one)
// are routed to the forks by Playwright with CORS added, so the shipped code and CSP are what run;
// every other EVM host is refused, except the first other server of each list (PublicNode on
// Ethereum, NodeReal on BNB Chain), also routed to the forks: before each review the app asks it the
// same price (lib/eth/second_opinion.js). A fresh random key (never printed) is imported and funded
// on the forks. Each side: buy with 0.1 ETH / BNB, then sell every rsFIRO back, through amount ->
// (allow) -> review -> password -> the transaction screen, balances checked on the chain. On BNB
// Chain the second server first answers 10% more than the person's (D-06): the review says so and
// waits for the tick.
//
//   npm run e2e:rsfiro   (needs ~/.foundry/bin/anvil and the pinned Ethereum fork on 8545)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome } from './flows.mjs';
import { ETH_RPC_HOSTS, BSC_RPC_HOSTS, ethRpcHost, DEFAULT_ETH_RPC, DEFAULT_BSC_RPC } from '../../src/lib/eth/hosts.js';
import { otherServers } from '../../src/lib/eth/second_opinion.js';
import { privateKeyToAddress } from '../../src/lib/eth/crypto.js';
import { RSFIRO, RSFIRO_BSC } from '../../src/lib/eth/tokens.js';
import { PANCAKE, quoteSwap, routerAllowance } from '../../src/lib/eth/pancake.js';
import { EthRpc } from '../../src/lib/eth/rpc.js';
import { ANVIL, anvilProblem, withFork, raw } from '../fork/fork_support.mjs';

const PORT = 8838;
const BSC_PORT = 8549;
const BSC_ANVIL = `http://127.0.0.1:${BSC_PORT}`;
const STACK = ethRpcHost(DEFAULT_ETH_RPC).host; // eth2.stackwallet.com
const BSC_HOST = ethRpcHost(DEFAULT_BSC_RPC).host; // bsc-dataseed.bnbchain.org: the default since PublicNode refuses receipts (2026-10)
/** The first other server of each list: asked a swap's price before its review (lib/eth/second_opinion.js). */
const ETH_SECOND = otherServers('ethereum', DEFAULT_ETH_RPC)[0].host; // ethereum-rpc.publicnode.com
const BSC_SECOND = otherServers('bsc', DEFAULT_BSC_RPC)[0].host; // bsc.nodereal.io
/** What BNB Chain's second server multiplies PancakeSwap's quote by (1: honest). */
let bscSecondFactor = 1;
const tid = (id) => `[data-testid="${id}"]`;
const PASSWORD = `swaps-${randomBytes(6).toString('hex')}`;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const ETHER = 10n ** 18n;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

const skip = await anvilProblem();
let tmp, srv, browser, page, bscChild;
const sk = randomBytes(32);
const ME = privateKeyToAddress(sk);

async function bscRaw(method, params = []) {
  const r = await fetch(BSC_ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const balanceOf = async (call, token, who) => BigInt(await call('eth_call', [{ to: token, data: `0x70a08231${who.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));

/** One EVM host routed to a fork (a JSON-RPC proxy with CORS); `factor()`: PancakeSwap quotes scaled by it. */
const toFork = (url, factor = () => 1) => async (route) => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (req.method() !== 'POST') return route.fulfill({ status: 404, headers: cors, body: '' });
  let r;
  let text;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.postData() });
    text = await r.text();
  } catch {
    // The fork is not up (BNB Chain's starts with its own test): the app sees a server that is down.
    return route.abort().catch(() => {});
  }
  const f = factor();
  if (f !== 1) {
    const asked = [].concat(JSON.parse(req.postData()));
    const scale = (a) => {
      const c = asked.find((x) => x.id === a.id);
      if (!c || c.method !== 'eth_call' || String(c.params[0].to).toLowerCase() !== PANCAKE.quoterV2 || typeof a.result !== 'string') return a;
      const out = (BigInt(`0x${a.result.slice(2, 66)}`) * BigInt(Math.round(f * 1000))) / 1000n;
      return { ...a, result: `0x${out.toString(16).padStart(64, '0')}${a.result.slice(66)}` };
    };
    const answer = JSON.parse(text);
    text = JSON.stringify(Array.isArray(answer) ? answer.map(scale) : scale(answer));
  }
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: text });
};

/**
 * BNB Chain's fork, started right before its test: it forks the newest block of a public BNB Chain
 * server, which keeps the state of only its last ~200 blocks (about two minutes): anvil fetches an
 * account the first time a test touches it, and one started at the top of the file (minutes before
 * the BNB Chain test, behind the Uniswap one) got "missing trie node" for everything new (e2e
 * 2026-10-14). Started here it is fresh for the test that uses it.
 */
async function startBscFork() {
  if (bscChild) bscChild.kill();
  bscChild = spawn(`${homedir()}/.foundry/bin/anvil`, ['--fork-url', 'https://bsc-dataseed.bnbchain.org', '--port', String(BSC_PORT), '--silent', '--no-storage-caching'], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await bscRaw('eth_chainId')) === '0x38') return;
    } catch {
      /* starting */
    }
    await sleep(500);
  }
  throw new Error('the BNB Chain fork did not start');
}

/**
 * Touches, right after the fork starts, the state both directions of the swap will read (the pool,
 * the quoter, the router's rsFIRO permission and this wallet's balances), so anvil holds it before
 * the public server prunes the fork block's state (about a minute on BNB Chain now).
 */
async function warmBscFork() {
  const rpc = new EthRpc('bsc-bnbchain', { fetch: (_url, init) => fetch(BSC_ANVIL, init), timeoutMs: 60000 });
  await Promise.all([
    quoteSwap(rpc, { side: 'buy', amountIn: ETHER / 10n }),
    quoteSwap(rpc, { side: 'sell', amountIn: 70n * 10n ** 8n }),
    routerAllowance(rpc, ME),
    balanceOf(bscRaw, RSFIRO_BSC.address, ME),
    rpc.getBalance(ME),
  ]);
}

test.before(async () => {
  if (skip) return;
  tmp = mkdtempSync(join(tmpdir(), 'campfire-rsfiro-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route((u) => u.hostname === STACK, toFork(ANVIL));
  await ctx.route((u) => u.hostname === BSC_HOST, toFork(BSC_ANVIL));
  await ctx.route((u) => u.hostname === ETH_SECOND, toFork(ANVIL));
  await ctx.route((u) => u.hostname === BSC_SECOND, toFork(BSC_ANVIL, () => bscSecondFactor));
  const routed = [STACK, BSC_HOST, ETH_SECOND, BSC_SECOND];
  await ctx.route((u) => [...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS].some((x) => x.host === u.hostname && !routed.includes(x.host)) || ['api.coingecko.com', '1click.chaindefuser.com', 'buyfiro.app'].includes(u.hostname), (r) => r.abort());
  ({ page } = await recordedPage(ctx, { label: 'rsfiro' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (bscChild) bscChild.kill();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Answers the password sheet when it shows up. */
async function password() {
  await page.waitForSelector(tid('auth-pw'), { timeout: 30000 });
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
}

test('a Firo wallet with an Ethereum & BNB side from a fresh key', { skip: skip || false, timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await page.evaluate(() => window.__campfire.go('ethImport'));
  await waitScreen(page, 'ethImport');
  await page.fill(tid('eth-words-input'), `0x${sk.toString('hex')}`);
  await page.waitForFunction(() => !document.querySelector('[data-testid="eth-import-submit"]').disabled);
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.click(tid('eth-connect'));
  await waitScreen(page, 'ethHome', 30000);
});

test('Uniswap on Ethereum: buy rsFIRO with 0.1 ETH, then sell all of it back', { skip: skip || false, timeout: 10 * 60000 }, () =>
  withFork(async () => {
    await raw('anvil_setBalance', [ME, hex(2n * ETHER)]);
    await page.evaluate(() => window.__campfire.go('ethSwap', { pay: 'ETH', receive: 'rsFIRO' }));
    await waitScreen(page, 'ethSwap', 30000);
    await page.fill(tid('uni-pay-amount'), '0.1');
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="uni-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 90000 }).catch(async (e) => {
      console.log(`# Uniswap screen: ${(await page.evaluate(() => document.querySelector('main')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 700)}`);
      console.log(`# Uniswap problems: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-testid="eth-server-problem"]')].map((e) => e.title)))}`);
      throw e;
    });
    await shot(page, 'rsfiro-uni-buy');
    await page.click(tid('uni-swap-cta'));
    await page.waitForSelector(tid('uni-review-cta'), { timeout: 60000 });
    assert.equal(await page.getAttribute(tid('uni-review-second'), 'data-status'), 'agree', 'PublicNode priced the same route the same');
    assert.equal(await page.textContent(tid('uni-review-second')), 'Price checked with a second server (PublicNode).');
    await shot(page, 'rsfiro-uni-buy-review');
    await page.click(tid('uni-review-cta'));
    await password();
    await waitScreen(page, 'ethSwapTx', 60000);
    await page.waitForSelector(`${tid('uni-tx-title')}[data-state="confirmed"]`, { timeout: 90000 });
    const bought = await balanceOf(raw, RSFIRO.address, ME);
    assert.ok(bought > 0n, 'rsFIRO arrived');
    await page.waitForFunction((u) => document.querySelector('[data-testid="uni-tx-received"]')?.dataset.units === u, String(bought), { timeout: 30000 });
    console.log(`# Uniswap: 0.1 ETH -> ${Number(bought) / 1e8} rsFIRO`);
    await shot(page, 'rsfiro-uni-bought');

    // Sell it all back: rsFIRO -> ETH (an exact allowance for Permit2 first, then a signed permit).
    const ethBefore = BigInt(await raw('eth_getBalance', [ME, 'latest']));
    await page.evaluate(() => window.__campfire.go('ethSwap', { pay: 'rsFIRO', receive: 'ETH' }));
    await waitScreen(page, 'ethSwap', 30000);
    await page.waitForFunction(() => /rsFIRO/.test(document.querySelector('[data-testid="uni-pay-token"]')?.textContent || ''), null, { timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="uni-max"]') && !document.querySelector('[data-testid="uni-max"]').disabled, null, { timeout: 60000 });
    await page.click(tid('uni-max'));
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="uni-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 90000 });
    await page.click(tid('uni-swap-cta'));
    // First sale of rsFIRO: allow exactly this amount.
    await page.waitForSelector(`${tid('uni-approve-cta')}, ${tid('uni-review-cta')}`, { timeout: 60000 });
    if (await page.$(tid('uni-approve-cta'))) {
      await shot(page, 'rsfiro-uni-sell-allow');
      // Release audit 0.1.5, S1: the permission goes out while Ethereum makes no block (it stays on
      // its way); the sheet is closed and Swap tapped again: the permission on its way is followed,
      // and a second one is never offered (it would cost a second fee).
      await raw('evm_setAutomine', [false]);
      try {
        await page.click(tid('uni-approve-cta'));
        await password();
        await page.waitForFunction(() => /Waiting for Ethereum/.test(document.querySelector('[data-testid="uni-approve-cta"]')?.textContent || ''), null, { timeout: 60000 });
        await page.click(tid('uni-approve-cancel'));
        await page.waitForSelector(tid('uni-approve-cta'), { state: 'detached', timeout: 30000 });
        await page.click(tid('uni-swap-cta'));
        await page.waitForSelector(tid('uni-approve-following'), { timeout: 60000 });
        assert.equal(await page.isDisabled(tid('uni-approve-cta')), true, 'no second "Allow"');
        await shot(page, 'rsfiro-uni-sell-allow-following');
      } finally {
        await raw('evm_setAutomine', [true]);
      }
      await raw('evm_mine');
      await page.waitForSelector(tid('uni-review-cta'), { timeout: 120000 });
    }
    await shot(page, 'rsfiro-uni-sell-review');
    // Release audit 0.1.6: the sale goes out while Ethereum makes no block (it stays on its way). A
    // second swap of rsFIRO now would read the same permission and Permit2 number and fail on chain,
    // its fee lost: the swap screen holds it, says why, and lets it go once the first is mined.
    let saleHash;
    await raw('evm_setAutomine', [false]);
    try {
      await page.click(tid('uni-review-cta'));
      if (await page.waitForSelector(tid('auth-pw'), { timeout: 8000 }).catch(() => null)) await password();
      await waitScreen(page, 'ethSwapTx', 60000);
      await page.evaluate(() => window.__campfire.go('ethSwap', { pay: 'rsFIRO', receive: 'ETH' }));
      await waitScreen(page, 'ethSwap', 30000);
      await page.waitForSelector(tid('uni-swap-on-its-way'), { timeout: 60000 });
      saleHash = await page.getAttribute(tid('uni-swap-on-its-way'), 'data-hash');
      assert.match(await page.textContent(tid('uni-swap-on-its-way')), /^Your last swap of rsFIRO is still on its way\. Swap rsFIRO again once Ethereum confirms it/);
      assert.equal(await page.isDisabled(tid('uni-swap-cta')), true, 'no second swap of rsFIRO while the first is on its way');
      await shot(page, 'rsfiro-uni-sell-held');
    } finally {
      await raw('evm_setAutomine', [true]);
    }
    await raw('evm_mine');
    await page.click(tid('uni-swap-on-its-way-check'));
    await page.waitForSelector(tid('uni-swap-on-its-way'), { state: 'detached', timeout: 60000 });
    await page.evaluate((hash) => window.__campfire.go('ethSwapTx', { hash }), saleHash);
    await waitScreen(page, 'ethSwapTx', 60000);
    await page.waitForSelector(`${tid('uni-tx-title')}[data-state="confirmed"]`, { timeout: 90000 });
    assert.equal(await balanceOf(raw, RSFIRO.address, ME), 0n, 'every rsFIRO sold');
    const ethAfter = BigInt(await raw('eth_getBalance', [ME, 'latest']));
    assert.ok(ethAfter > ethBefore, 'ETH came back (more than the fees)');
    console.log(`# Uniswap: sold back for ${Number(ethAfter - ethBefore) / 1e18} ETH (after fees)`);
    await shot(page, 'rsfiro-uni-sold');
  }),
);

test('PancakeSwap on BNB Chain: buy rsFIRO with 0.1 BNB, then sell all of it back', { skip: skip || false, timeout: 10 * 60000 }, async () => {
  await startBscFork();
  await bscRaw('anvil_setBalance', [ME, hex(ETHER)]);
  await warmBscFork();
  await page.evaluate(() => window.__campfire.go('ethSwapBsc', { side: 'buy' }));
  await waitScreen(page, 'ethSwapBsc', 30000);
  await page.fill(tid('pcs-pay-amount'), '0.1');
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="pcs-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 90000 }).catch(async (e) => {
    console.log(`# PancakeSwap screen: ${(await page.evaluate(() => document.querySelector('main')?.innerText || '')).replace(/\s+/g, ' ').slice(0, 700)}`);
    console.log(`# PancakeSwap problems (the server's own words): ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('[data-testid="eth-server-problem"]')].map((e) => e.title)))}`);
    throw e;
  });
  await shot(page, 'rsfiro-pcs-buy');
  // D-06: the second server prices it 10% higher than the person's server (as if theirs quoted low).
  bscSecondFactor = 1.1;
  await page.click(tid('pcs-swap-cta'));
  await page.waitForSelector(tid('pcs-review-swap'), { timeout: 60000 });
  bscSecondFactor = 1;
  assert.equal(await page.getAttribute(tid('pcs-review-second'), 'data-status'), 'differ');
  assert.match(await page.textContent(tid('pcs-review-second')), new RegExp(`^Your server \\(BNB Chain \\(official\\)\\) prices this swap 9\\.\\d% lower than ${otherServers('bsc', DEFAULT_BSC_RPC)[0].name} does: `));
  assert.equal(await page.isDisabled(tid('pcs-review-swap')), true, 'no swap at a disputed price without the tick');
  await shot(page, 'rsfiro-pcs-buy-review-differ');
  await page.check(tid('pcs-review-second-ack'));
  assert.equal(await page.isDisabled(tid('pcs-review-swap')), false);
  await shot(page, 'rsfiro-pcs-buy-review');
  await page.click(tid('pcs-review-swap'));
  await password();
  await waitScreen(page, 'ethTx', 60000);
  await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 90000 });
  const bought = await balanceOf(bscRaw, RSFIRO_BSC.address, ME);
  assert.ok(bought > 0n, 'rsFIRO arrived on BNB Chain');
  console.log(`# PancakeSwap: 0.1 BNB -> ${Number(bought) / 1e8} rsFIRO`);
  await shot(page, 'rsfiro-pcs-bought');

  // Sell it all back: an exact approval first, then the swap.
  const bnbBefore = BigInt(await bscRaw('eth_getBalance', [ME, 'latest']));
  const units = (Number(bought) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  await page.evaluate(() => window.__campfire.go('ethSwapBsc', { side: 'sell' }));
  await waitScreen(page, 'ethSwapBsc', 30000);
  assert.equal(await page.textContent('.topbar h1'), 'Sell rsFIRO');
  await page.fill(tid('pcs-pay-amount'), units);
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="pcs-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 90000 });
  if (/allow|approve/i.test(await page.textContent(tid('pcs-swap-cta')))) {
    await shot(page, 'rsfiro-pcs-sell-allow');
    // Release audit 0.1.5, S1: the permission goes out while BNB Chain makes no block; leaving the
    // screen and coming back follows it ("Waiting for BNB Chain…"), never offers "Allow" again.
    await bscRaw('evm_setAutomine', [false]);
    try {
      await page.click(tid('pcs-swap-cta'));
      await password();
      await page.waitForFunction(() => /Waiting for BNB Chain to confirm the rsFIRO permission/.test(document.querySelector('[data-testid="pcs-reason"]')?.textContent || ''), null, { timeout: 60000 });
      await page.evaluate(() => window.__campfire.go('ethHome'));
      await waitScreen(page, 'ethHome', 30000);
      await page.evaluate(() => window.__campfire.go('ethSwapBsc', { side: 'sell' }));
      await waitScreen(page, 'ethSwapBsc', 30000);
      await page.fill(tid('pcs-pay-amount'), units);
      await page.waitForFunction(() => /Waiting for BNB Chain to confirm the rsFIRO permission/.test(document.querySelector('[data-testid="pcs-reason"]')?.textContent || ''), null, { timeout: 60000 });
      assert.equal(await page.isDisabled(tid('pcs-swap-cta')), true, 'no second "Allow"');
      await shot(page, 'rsfiro-pcs-sell-allow-following');
    } finally {
      await bscRaw('evm_setAutomine', [true]);
    }
    await bscRaw('evm_mine');
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="pcs-swap-cta"]'); return b && !b.disabled && !/allow|approve|waiting/i.test(b.textContent); }, null, { timeout: 120000 });
  }
  await page.click(tid('pcs-swap-cta'));
  await page.waitForSelector(tid('pcs-review-swap'), { timeout: 60000 });
  assert.equal(await page.getAttribute(tid('pcs-review-second'), 'data-status'), 'agree');
  await shot(page, 'rsfiro-pcs-sell-review');
  await page.click(tid('pcs-review-swap'));
  await password();
  await waitScreen(page, 'ethTx', 60000);
  await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 90000 });
  assert.equal(await balanceOf(bscRaw, RSFIRO_BSC.address, ME), 0n, 'every rsFIRO sold');
  const bnbAfter = BigInt(await bscRaw('eth_getBalance', [ME, 'latest']));
  assert.ok(bnbAfter > bnbBefore, 'BNB came back (more than the fees)');
  console.log(`# PancakeSwap: sold back for ${Number(bnbAfter - bnbBefore) / 1e18} BNB (after fees)`);
  await shot(page, 'rsfiro-pcs-sold');
});
