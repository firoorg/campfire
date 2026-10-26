// SPDX-License-Identifier: MIT
// Live money tests on Ethereum MAINNET through the Firo web wallet's own screens: the installed Google
// Chrome (headless), the build with the stand-in Firo engine (dist-fake: the Firo side touches no
// network), and the Ethereum side exactly as it ships - its own servers (Stack Wallet, and PublicNode
// as the second server that checks every swap price), nothing routed or faked.
//
// The Ethereum test wallet's recovery words come from ~/.config/campfire-beam/test_wallets.env ($CAMPFIRE_TEST_WALLETS to point elsewhere)
// (ETHTEST_SEED, mode 0600) and are never printed or photographed. Tiny amounts, to itself:
//   1. Send 0.0001 ETH to the same words' next account (the wallet refuses its own address).
//   2. Buy rsFIRO with 0.0005 ETH on Uniswap (the price checked with a second server).
//   3. Send a quarter of that rsFIRO to the next account (a token send).
//   4. Sell every rsFIRO back for ETH (an exact allowance first, then a signed permit).
// Each step is checked on the chain (receipt status, value, balances), and the screen's figures with it.
//
//   npm run e2e:eth (builds dist-fake/), then: node test/live/evm_money.mjs
//   EVM_LIVE_FROM=3|4 node test/live/evm_money.mjs   resume at step 3 or 4 (the rsFIRO held is what is sent and sold)
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, launch, recordedPage, waitScreen, sleep } from '../e2e/harness.mjs';
import { createWallet, waitHome } from '../e2e/flows.mjs';
import { ethKeyFromMnemonic } from '../../src/lib/eth/crypto.js';

// The wallet refuses to send to its own address: sends go to the same words' next account (m/44'/60'/0'/0/1).
const TO = '0x1f8311cB35b167f73b2B5611CE851DEB76dB0015';
const RSFIRO = '0x2744eA5Ac9b11CB5E3CD63D3a88E858336aEddC2';
const RPC = 'https://ethereum-rpc.publicnode.com';
const SHOTS = process.env.EVM_LIVE_SHOTS || join(tmpdir(), 'campfire-firo-evm-live');
const PASSWORD = `live-${randomBytes(6).toString('hex')}`;
const FROM = Number(process.env.EVM_LIVE_FROM || 1);
const tid = (id) => `[data-testid="${id}"]`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function seed() {
  for (const line of readFileSync(process.env.CAMPFIRE_TEST_WALLETS || `${homedir()}/.config/campfire-beam/test_wallets.env`, 'utf8').split('\n')) {
    const m = /^ETHTEST_SEED=(.*)$/.exec(line.trim());
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('ETHTEST_SEED is not in test_wallets.env');
}
// The test wallet's address, from its words: never written in the source (public audit, H1).
const ME = await (async () => {
  const k = await ethKeyFromMnemonic(seed());
  k.sk.fill(0);
  return k.address;
})();

async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'campfire-live-test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const ethOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const tokenOf = async (t, a) => BigInt(await rpc('eth_call', [{ to: t, data: `0x70a08231${a.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));
async function receipt(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await sleep(5000);
  }
  throw new Error(`no receipt for ${hash}`);
}

let page;
async function snap(name) {
  await sleep(700);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function password() {
  await page.waitForSelector(tid('auth-pw'), { timeout: 60000 });
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
}

mkdirSync(SHOTS, { recursive: true });
const srv = await startServer({ root: 'dist-fake', port: 8791, fakeBackend: true });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
({ page } = await recordedPage(ctx, { label: 'evm-live' }));
const start = { eth: await ethOf(ME), rsfiro: await tokenOf(RSFIRO, ME) };
log(`start: ${Number(start.eth) / 1e18} ETH, ${Number(start.rsfiro) / 1e8} rsFIRO`);
try {
  // --- the wallet: a throwaway Firo wallet, the Ethereum test wallet imported by its words ---
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await page.evaluate(() => window.__campfire.go('ethImport'));
  await waitScreen(page, 'ethImport');
  await page.fill(tid('eth-words-input'), seed());
  await page.waitForFunction(() => document.querySelector('[data-testid="eth-import-submit"]') && !document.querySelector('[data-testid="eth-import-submit"]').disabled);
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy', 60000);
  await page.click(tid('eth-connect'));
  await waitScreen(page, 'ethHome', 60000);
  await page.waitForSelector(tid('eth-address'));
  assert.equal(await page.getAttribute(tid('eth-address'), 'data-address'), ME, 'the words open the test wallet');
  await snap('01-eth-home');

  if (FROM <= 1) {
  // --- 1. 0.0001 ETH to the next account ---
  const to0 = await ethOf(TO);
  await page.click(tid('eth-send'));
  await waitScreen(page, 'ethSend');
  await page.waitForFunction(() => /[0-9]/.test(document.querySelector('[data-testid="eth-send-fee"]')?.textContent || '') && !/Checking/.test(document.querySelector('[data-testid="eth-send-fee"]')?.textContent || ''), null, { timeout: 60000 });
  await page.fill(tid('eth-send-to'), TO);
  await page.fill(tid('eth-send-amount'), '0.0001');
  await page.waitForFunction(() => document.querySelector('[data-testid="eth-send-review"]')?.textContent === 'Send 0.0001 ETH', null, { timeout: 30000 });
  await page.click(tid('eth-send-review'));
  await page.waitForSelector(tid('eth-review-send'));
  assert.equal(await page.textContent(tid('eth-review-amount')), '0.0001 ETH');
  assert.equal(await page.getAttribute(tid('eth-review-to'), 'data-address'), TO);
  await snap('02-send-review');
  await page.click(tid('eth-review-send'));
  await password();
  await waitScreen(page, 'ethTx', 60000);
  await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 300000 });
  const h1 = await page.getAttribute(tid('eth-tx-hash'), 'data-hash');
  const r1 = await receipt(h1);
  assert.equal(r1.status, '0x1');
  const fee1 = BigInt(r1.gasUsed) * BigInt(r1.effectiveGasPrice);
  assert.equal(await page.getAttribute(tid('eth-tx-fee'), 'data-wei'), String(fee1), 'the fee shown is the fee paid');
  const tx1 = await rpc('eth_getTransactionByHash', [h1]);
  assert.equal(BigInt(tx1.value), 100000000000000n);
  assert.equal(tx1.to.toLowerCase(), TO.toLowerCase());
  assert.equal((await ethOf(TO)) - to0, 100000000000000n, 'the next account got exactly 0.0001 ETH');
  log(`[evidence] ETH send: https://etherscan.io/tx/${h1} block ${Number(r1.blockNumber)}, fee ${Number(fee1) / 1e18} ETH`);
  await snap('03-send-confirmed');
  await page.click(tid('eth-tx-done'));
  }

  if (FROM <= 2) {
  // --- 2. buy rsFIRO with 0.0005 ETH on Uniswap ---
  await page.evaluate(() => window.__campfire.go('ethSwap', { pay: 'ETH', receive: 'rsFIRO' }));
  await waitScreen(page, 'ethSwap', 30000);
  await page.fill(tid('uni-pay-amount'), '0.0005');
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="uni-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 120000 });
  await snap('04-buy-rsfiro');
  await page.click(tid('uni-swap-cta'));
  await page.waitForSelector(tid('uni-review-cta'), { timeout: 120000 });
  log('buy review, second server:', await page.getAttribute(tid('uni-review-second'), 'data-status'), '-', await page.textContent(tid('uni-review-second')));
  await snap('05-buy-review');
  const beforeBuy = await tokenOf(RSFIRO, ME);
  await page.click(tid('uni-review-cta'));
  await password();
  await waitScreen(page, 'ethSwapTx', 60000);
  await page.waitForSelector(`${tid('uni-tx-title')}[data-state="confirmed"]`, { timeout: 300000 });
  const bought = (await tokenOf(RSFIRO, ME)) - beforeBuy;
  assert.ok(bought > 0n, 'rsFIRO arrived');
  await page.waitForFunction((u) => document.querySelector('[data-testid="uni-tx-received"]')?.dataset.units === u, String(bought), { timeout: 60000 });
  log(`[evidence] Uniswap buy: 0.0005 ETH -> ${Number(bought) / 1e8} rsFIRO (the screen shows exactly what arrived)`);
  await snap('06-bought');
  }

  if (FROM <= 3) {
  // --- 3. a token send: a quarter of it to the next account ---
  const toR0 = await tokenOf(RSFIRO, TO);
  const held = await tokenOf(RSFIRO, ME);
  assert.ok(held > 0n, 'rsFIRO to send');
  const part = held / 4n;
  const partText = (Number(part) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  await page.evaluate(() => window.__campfire.go('ethHome'));
  await waitScreen(page, 'ethHome', 30000);
  await page.click(tid('eth-send'));
  await waitScreen(page, 'ethSend');
  await page.waitForSelector(`${tid('eth-send-asset')} option[value="rsFIRO"]`, { state: 'attached', timeout: 60000 });
  await page.selectOption(tid('eth-send-asset'), 'rsFIRO');
  await page.fill(tid('eth-send-to'), TO);
  await page.fill(tid('eth-send-amount'), partText);
  await page.waitForFunction((a) => document.querySelector('[data-testid="eth-send-review"]')?.textContent === `Send ${a} rsFIRO`, partText, { timeout: 60000 });
  await page.click(tid('eth-send-review'));
  await page.waitForSelector(tid('eth-review-send'));
  assert.equal(await page.textContent(tid('eth-review-amount')), `${partText} rsFIRO`);
  await page.click(tid('eth-review-send'));
  await password();
  await waitScreen(page, 'ethTx', 60000);
  await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 300000 });
  const h3 = await page.getAttribute(tid('eth-tx-hash'), 'data-hash');
  const r3 = await receipt(h3);
  assert.equal(r3.status, '0x1');
  assert.equal(r3.to.toLowerCase(), RSFIRO.toLowerCase(), 'a call to the rsFIRO token');
  assert.equal((await tokenOf(RSFIRO, TO)) - toR0, part, 'the next account got exactly that rsFIRO');
  log(`[evidence] rsFIRO send: ${partText} rsFIRO to the next account, https://etherscan.io/tx/${h3}`);
  await snap('07-token-sent');
  await page.click(tid('eth-tx-done'));
  }

  // --- 4. sell every rsFIRO back for ETH ---
  const ethBefore = await ethOf(ME);
  await page.evaluate(() => window.__campfire.go('ethSwap', { pay: 'rsFIRO', receive: 'ETH' }));
  await waitScreen(page, 'ethSwap', 30000);
  await page.waitForFunction(() => /rsFIRO/.test(document.querySelector('[data-testid="uni-pay-token"]')?.textContent || ''), null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="uni-max"]') && !document.querySelector('[data-testid="uni-max"]').disabled, null, { timeout: 120000 });
  await page.click(tid('uni-max'));
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="uni-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 120000 });
  await page.click(tid('uni-swap-cta'));
  await page.waitForSelector(`${tid('uni-approve-cta')}, ${tid('uni-review-cta')}`, { timeout: 120000 });
  if (await page.$(tid('uni-approve-cta'))) {
    await snap('08-sell-allow');
    await page.click(tid('uni-approve-cta'));
    await password();
    await page.waitForSelector(tid('uni-review-cta'), { timeout: 300000 });
    log('allowance confirmed');
  }
  log('sell review, second server:', await page.getAttribute(tid('uni-review-second'), 'data-status'));
  await snap('09-sell-review');
  await page.click(tid('uni-review-cta'));
  if (await page.waitForSelector(tid('auth-pw'), { timeout: 10000 }).catch(() => null)) await password();
  await waitScreen(page, 'ethSwapTx', 60000);
  await page.waitForSelector(`${tid('uni-tx-title')}[data-state="confirmed"]`, { timeout: 300000 });
  assert.equal(await tokenOf(RSFIRO, ME), FROM >= 3 ? 0n : start.rsfiro, 'every rsFIRO left here sold back');
  const ethAfter = await ethOf(ME);
  log(`[evidence] Uniswap sell: all rsFIRO back for ${Number(ethAfter - ethBefore) / 1e18} ETH net of its fees`);
  await snap('10-sold');
  log(`end: ${Number(ethAfter) / 1e18} ETH (start ${Number(start.eth) / 1e18}): the four steps cost ${Number(start.eth - ethAfter) / 1e18} ETH`);
  log('LIVE OK');
} catch (e) {
  log('FAILED:', e.message.split('\n')[0]);
  await snap('99-failed').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.stop();
}
