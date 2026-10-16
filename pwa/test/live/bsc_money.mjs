// SPDX-License-Identifier: MIT
// Live money tests on BNB Chain MAINNET through the Firo web wallet's own screens: the installed Google
// Chrome (headless), the build with the stand-in Firo engine (dist-fake: the Firo side touches no
// network), and the BNB Chain side exactly as it ships - its own servers (BNB Chain's official server,
// the default since PublicNode refuses receipts, and PublicNode as the second one that checks every swap
// price), nothing routed or faked.
//
// The test wallet's recovery words: ETHTEST_SEED in ~/.config/campfire-beam/test_wallets.env ($CAMPFIRE_TEST_WALLETS to point elsewhere) (0600),
// never printed or photographed (the same address on Ethereum and BNB Chain). Tiny amounts:
//   1. Send 0.0005 BNB to the same words' next account (the wallet refuses its own address).
//   2. Buy rsFIRO with 0.002 BNB on PancakeSwap (the price checked with a second server).
//   3. Send a quarter of that rsFIRO to the next account (a token send).
//   4. Sell the rest back for BNB (an allowance first when needed).
// Each step is checked on the chain. A second server that prices a swap differently stops the test
// (it never ticks "swap anyway" for real money).
//
//   npm run e2e:eth (builds dist-fake/), then: node test/live/bsc_money.mjs
//   BSC_LIVE_FROM=2|3|4 / BSC_LIVE_TO=1|2|3 node test/live/bsc_money.mjs   only those steps
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer, launch, recordedPage, waitScreen, sleep } from '../e2e/harness.mjs';
import { createWallet, waitHome } from '../e2e/flows.mjs';
import { ethKeyFromMnemonic } from '../../src/lib/eth/crypto.js';

const TO = '0x1f8311cB35b167f73b2B5611CE851DEB76dB0015'; // m/44'/60'/0'/0/1 of the same words
const RSFIRO = '0x13cDb5F7f398F6AF2CC3B34EB04476af3488853f'; // rsFIRO on BNB Chain, 8 decimals
const RPC = 'https://bsc-dataseed.bnbchain.org';
const SHOTS = process.env.BSC_LIVE_SHOTS || join(tmpdir(), 'campfire-firo-bsc-live');
const PASSWORD = `live-${randomBytes(6).toString('hex')}`;
const FROM = Number(process.env.BSC_LIVE_FROM || 1);
const UPTO = Number(process.env.BSC_LIVE_TO || 4);
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
const bnbOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const tokenOf = async (a) => BigInt(await rpc('eth_call', [{ to: RSFIRO, data: `0x70a08231${a.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));
async function receipt(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await sleep(3000);
  }
  throw new Error(`no receipt for ${hash}`);
}
const units8 = (v) => (Number(v) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');

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
async function confirmed() {
  await waitScreen(page, 'ethTx', 60000);
  await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 300000 });
  const hash = await page.getAttribute(tid('eth-tx-hash'), 'data-hash');
  const r = await receipt(hash);
  assert.equal(r.status, '0x1', `${hash} succeeded`);
  return { hash, r };
}
/** The swap review: the second server must agree; a price it disputes stops the test. */
async function reviewSwap(what) {
  await page.waitForSelector(tid('pcs-review-swap'), { timeout: 120000 });
  const status = await page.getAttribute(tid('pcs-review-second'), 'data-status');
  log(`${what} review, second server: ${status} - ${await page.textContent(tid('pcs-review-second'))}`);
  if (status !== 'agree') throw new Error(`the second server did not agree (${status}): stopped, nothing sent`);
}

mkdirSync(SHOTS, { recursive: true });
const srv = await startServer({ root: 'dist-fake', port: 8792, fakeBackend: true });
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
({ page } = await recordedPage(ctx, { label: 'bsc-live' }));
const start = { bnb: await bnbOf(ME), rsfiro: await tokenOf(ME) };
log(`start: ${Number(start.bnb) / 1e18} BNB, ${units8(start.rsfiro)} rsFIRO on BNB Chain`);
try {
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

  if (FROM <= 1) {
    // --- 1. 0.0005 BNB to the next account ---
    const to0 = await bnbOf(TO);
    await page.evaluate(() => window.__campfire.go('ethSend', { chain: 'bsc' }));
    await waitScreen(page, 'ethSend');
    await page.waitForFunction(() => /BNB Chain/.test(document.querySelector('.topbar h1')?.textContent || ''), null, { timeout: 30000 });
    await page.waitForFunction(() => /[0-9]/.test(document.querySelector('[data-testid="eth-send-fee"]')?.textContent || '') && !/Checking/.test(document.querySelector('[data-testid="eth-send-fee"]')?.textContent || ''), null, { timeout: 60000 });
    await page.fill(tid('eth-send-to'), TO);
    await page.fill(tid('eth-send-amount'), '0.0005');
    await page.waitForFunction(() => document.querySelector('[data-testid="eth-send-review"]')?.textContent === 'Send 0.0005 BNB', null, { timeout: 30000 });
    await page.click(tid('eth-send-review'));
    await page.waitForSelector(tid('eth-review-send'));
    assert.equal(await page.textContent(tid('eth-review-amount')), '0.0005 BNB');
    assert.equal(await page.getAttribute(tid('eth-review-to'), 'data-address'), TO);
    await snap('01-send-review');
    await page.click(tid('eth-review-send'));
    await password();
    const { hash, r } = await confirmed();
    const fee = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
    assert.equal(await page.getAttribute(tid('eth-tx-fee'), 'data-wei'), String(fee), 'the fee shown is the fee paid');
    assert.equal((await bnbOf(TO)) - to0, 500000000000000n, 'the next account got exactly 0.0005 BNB');
    log(`[evidence] BNB send: https://bscscan.com/tx/${hash} block ${Number(r.blockNumber)}, fee ${Number(fee) / 1e18} BNB`);
    await snap('02-send-confirmed');
  }

  if (FROM <= 2 && UPTO >= 2) {
    // --- 2. buy rsFIRO with 0.002 BNB on PancakeSwap ---
    const before = await tokenOf(ME);
    await page.evaluate(() => window.__campfire.go('ethSwapBsc', { side: 'buy' }));
    await waitScreen(page, 'ethSwapBsc', 30000);
    await page.fill(tid('pcs-pay-amount'), '0.002');
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="pcs-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 120000 });
    await snap('03-buy');
    await page.click(tid('pcs-swap-cta'));
    await reviewSwap('buy');
    await snap('04-buy-review');
    await page.click(tid('pcs-review-swap'));
    await password();
    const { hash } = await confirmed();
    const bought = (await tokenOf(ME)) - before;
    assert.ok(bought > 0n, 'rsFIRO arrived on BNB Chain');
    log(`[evidence] PancakeSwap buy: 0.002 BNB -> ${units8(bought)} rsFIRO, https://bscscan.com/tx/${hash}`);
    await snap('05-bought');
  }

  if (FROM <= 3 && UPTO >= 3) {
    // --- 3. a quarter of the rsFIRO held to the next account ---
    const held = await tokenOf(ME);
    assert.ok(held > 0n, 'rsFIRO to send');
    const part = held / 4n;
    const toR0 = await tokenOf(TO);
    await page.evaluate(() => window.__campfire.go('ethSend', { chain: 'bsc' }));
    await waitScreen(page, 'ethSend');
    await page.waitForSelector(`${tid('eth-send-asset')} option[value="rsFIRO"]`, { state: 'attached', timeout: 90000 });
    await page.selectOption(tid('eth-send-asset'), 'rsFIRO');
    await page.fill(tid('eth-send-to'), TO);
    await page.fill(tid('eth-send-amount'), units8(part));
    await page.waitForFunction((a) => document.querySelector('[data-testid="eth-send-review"]')?.textContent === `Send ${a} rsFIRO`, units8(part), { timeout: 60000 });
    await page.click(tid('eth-send-review'));
    await page.waitForSelector(tid('eth-review-send'));
    assert.equal(await page.textContent(tid('eth-review-amount')), `${units8(part)} rsFIRO`);
    await page.click(tid('eth-review-send'));
    await password();
    const { hash, r } = await confirmed();
    assert.equal(r.to.toLowerCase(), RSFIRO.toLowerCase(), 'a call to the rsFIRO token');
    assert.equal((await tokenOf(TO)) - toR0, part, 'the next account got exactly that rsFIRO');
    log(`[evidence] rsFIRO send on BNB Chain: ${units8(part)} rsFIRO, https://bscscan.com/tx/${hash}`);
    await snap('06-token-sent');
  }

  if (UPTO < 4) throw Object.assign(new Error('stopped after the steps asked for'), { done: true });
  // --- 4. sell the rest back for BNB ---
  const rest = await tokenOf(ME);
  assert.ok(rest > 0n, 'rsFIRO to sell');
  const bnbBefore = await bnbOf(ME);
  await page.evaluate(() => window.__campfire.go('ethSwapBsc', { side: 'sell' }));
  await waitScreen(page, 'ethSwapBsc', 30000);
  await page.fill(tid('pcs-pay-amount'), units8(rest));
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="pcs-swap-cta"]'); return b && !b.disabled; }, null, { timeout: 120000 });
  if (/allow|approve/i.test(await page.textContent(tid('pcs-swap-cta')))) {
    await snap('07-sell-allow');
    await page.click(tid('pcs-swap-cta'));
    await password();
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid="pcs-swap-cta"]'); return b && !b.disabled && !/allow|approve|waiting/i.test(b.textContent); }, null, { timeout: 300000 });
    log('allowance confirmed');
  }
  await page.click(tid('pcs-swap-cta'));
  await reviewSwap('sell');
  await snap('08-sell-review');
  await page.click(tid('pcs-review-swap'));
  await password();
  const { hash } = await confirmed();
  assert.equal(await tokenOf(ME), 0n, 'every rsFIRO left here sold back');
  const bnbAfter = await bnbOf(ME);
  log(`[evidence] PancakeSwap sell: ${units8(rest)} rsFIRO -> ${Number(bnbAfter - bnbBefore) / 1e18} BNB net of fees, https://bscscan.com/tx/${hash}`);
  await snap('09-sold');
  log(`end: ${Number(bnbAfter) / 1e18} BNB (start ${Number(start.bnb) / 1e18})`);
  log('LIVE OK');
} catch (e) {
  if (e.done) {
    log(`LIVE OK (steps ${FROM}-${UPTO})`);
    await browser.close();
    srv.stop();
    process.exit(0);
  }
  log('FAILED:', e.message.split('\n')[0]);
  await snap('99-failed').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  srv.stop();
}
