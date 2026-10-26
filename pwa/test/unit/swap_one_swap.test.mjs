// One swap from one intent (release verification 0.1.8, findings 4, 6 and 7): the Uniswap screen
// (screens/eth_swap.js), its review sheet (screens/eth_swap_parts.js) and the PancakeSwap screen
// (screens/eth_swap_bsc.js) on a stand-in DOM, the wallet, servers and signing scripted
// (helpers/stand_ins/). Before: the main Swap button came back on behind its own Allow / review
// sheet, so Enter or Space opened a second sheet (a second permission, a second swap); a review
// sheet's own Swap took the run only after the password, so two taps opened two password sheets and
// signed two swaps; PancakeSwap's review could be closed by a tap beside it while "Swapping…", and a
// buy had no "still on its way" guard, so the same buy was offered and sent again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one, body } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };

const UNI = ['/src/screens/eth_swap.js'];
const PARTS = ['/src/screens/eth_swap_parts.js'];
const BSC = ['/src/screens/eth_swap_bsc.js'];
redirect([
  { parents: UNI, spec: '../lib/eth/wallet.js', to: standIn('eth_wallet') },
  { parents: [...UNI, ...PARTS], spec: '../lib/eth/uniswap_app.js', to: standIn('uniswap_app') },
  { parents: UNI, spec: './eth_swap_parts.js', to: standIn('swap_parts') },
  { parents: UNI, spec: './near_intents_entry.js', to: standIn('near_intents_entry') },
  { parents: PARTS, spec: '../lib/eth/uniswap_words.js', to: standIn('uniswap_words') },
  { parents: [...UNI, ...PARTS, ...BSC], spec: '../lib/eth/permission.js', to: standIn('permission') },
  { parents: [...PARTS, ...BSC], spec: '../lib/auth_ui.js', to: standIn('auth_ui') },
  { parents: BSC, spec: '../lib/eth/rpc.js', to: standIn('eth_rpc') },
  { parents: BSC, spec: '../lib/eth/send.js', to: standIn('eth_send_lib') },
  { parents: BSC, spec: '../lib/eth/second_opinion.js', to: standIn('second_opinion') },
  { parents: BSC, spec: '../lib/eth/short_now.js', to: standIn('short_now') },
]);

const { plainEthWallet } = await import('./helpers/stand_ins/eth_wallet.mjs');
const auth = await import('./helpers/stand_ins/auth_ui.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { RSFIRO_TOKEN } = await import('./helpers/stand_ins/uniswap_app.mjs');
const { default: ethSwap } = await import('../../src/screens/eth_swap.js');
const { default: ethSwapBsc } = await import('../../src/screens/eth_swap_bsc.js');
const { openReviewSheet } = await import('../../src/screens/eth_swap_parts.js');
const { ETH_TOKEN } = await import('../../src/lib/eth/uniswap/models.js');

const E = 10n ** 18n;
// A second server priced the swap the same (lib/eth/second_opinion.js).
const AGREED = Object.freeze({ status: 'agree', host: { name: 'Second' }, mine: 1000n, theirs: 1000n, gap: 0 });
const GWEI = 10n ** 9n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
const overlays = () => body.findAll((el) => el.className.split(/\s+/).includes('overlay'));
const typeInto = (input, v) => {
  input.value = v;
  for (const fn of input.listeners.get('input') || []) fn({});
};
function reset() {
  globalThis.__eth = { prepares: 0, signed: [], prepareMs: 0, signMs: 0 };
  globalThis.__swapSheets = [];
  globalThis.__approval = null;
  globalThis.__allowance = undefined;
  auth.sheets.length = 0;
  for (const o of overlays()) o.remove();
}

// ------------------------------------------------------------------ Uniswap

async function uniswapScreen() {
  reset();
  globalThis.__ethWallet = plainEthWallet({ state: { eth: E, tokens: new Map([['rsFIRO', 0n]]), address: `0x${'22'.repeat(20)}`, outbox: [] }, refreshChain: () => sleep(1) });
  globalThis.__svc = {
    fees: async () => ({ baseFee: GWEI, maxPriorityFeePerGas: GWEI / 10n, maxFeePerGas: 2n * GWEI }),
    quote: async ({ tokenIn, tokenOut, amountIn }) => ({ tokenIn, tokenOut, amountIn, amountOut: 1000n, gasEstimate: 180000n, priceImpact: 0, minimumOut: () => 1n }),
    reviewSwap: async ({ quote }) => ({ quote }),
  };
  const app = makeApp({ ethSwap: (a, p) => ethSwap(a, p) });
  app.go('ethSwap');
  await sleep(30);
  typeInto(one('uni-pay-amount', app.current.el), '0.1');
  await sleep(700);
  const cta = one('uni-swap-cta', app.current.el);
  assert.equal(cta.disabled, false, one('uni-reason', app.current.el).textContent);
  return { app, cta };
}

for (const [label, approval, kind] of [
  ['the review sheet', null, 'review'],
  ['the Allow sheet', { kind: 'approve', token: RSFIRO_TOKEN, amount: 1n }, 'allow'],
]) {
  test(`Uniswap: the Swap button stays off while ${label} is open; Enter on it opens no second one`, async () => {
    const { cta } = await uniswapScreen();
    globalThis.__approval = approval;
    cta.click();
    await until(() => globalThis.__swapSheets.length === 1, 'the sheet');
    assert.equal(globalThis.__swapSheets[0].kind, kind);
    assert.equal(cta.disabled, true, 'off behind its sheet');
    await cta.click(); // Enter / Space on the focused button behind the overlay
    await sleep(50);
    assert.equal(globalThis.__swapSheets.length, 1);
    globalThis.__swapSheets[0].resolve(kind === 'allow' ? false : null);
    await sleep(20);
    assert.equal(cta.disabled, false, 'back once the sheet is answered');
  });
}

test('Uniswap review sheet: two taps on Swap before the password answers: one password sheet, one swap', async () => {
  reset();
  const q = { tokenIn: ETH_TOKEN, tokenOut: RSFIRO_TOKEN, amountIn: E / 10n, amountOut: 1000n, priceImpact: 0, pools: [], minimumOut: () => 1n, route: [] };
  const review = { quote: q, impact: 'none', minimumOut: 1n, slippageBips: 100, expectedGasCost: 1n, maxGasCost: 2n, needsPermit: false, owner: '0x' };
  let built = 0;
  const svc = {
    finalizeSwap: async () => {
      built++;
      await sleep(10);
      return { tx: {}, minimumOut: 1n };
    },
  };
  const w = { rpc: { host: { name: 'Test server' } }, state: { outbox: [], address: `0x${'22'.repeat(20)}` }, kv: null };
  const done = openReviewSheet({ currentName: 'ethSwap' }, { w, svc, review, acceptImpact: false, check: AGREED });
  one('uni-review-cta').click();
  one('uni-review-cta').click();
  await sleep(20);
  assert.equal(auth.sheets.length, 1, 'one password sheet');
  assert.equal(one('uni-review-cta').disabled, true, 'off while the password is asked');
  auth.answer(0);
  const hash = await done;
  assert.match(hash, /^0x1{64}$/);
  assert.equal(built, 1);
  assert.equal(globalThis.__eth.signed.length, 1, 'one swap signed');
});

test('Uniswap review sheet: closed while the password is asked: nothing is built or signed', async () => {
  reset();
  const q = { tokenIn: ETH_TOKEN, tokenOut: RSFIRO_TOKEN, amountIn: E / 10n, amountOut: 1000n, priceImpact: 0, pools: [], minimumOut: () => 1n, route: [] };
  const review = { quote: q, impact: 'none', minimumOut: 1n, slippageBips: 100, expectedGasCost: 1n, maxGasCost: 2n, needsPermit: false, owner: '0x' };
  let built = 0;
  const svc = { finalizeSwap: async () => (built++, { tx: {}, minimumOut: 1n }) };
  const w = { rpc: { host: { name: 'Test server' } }, state: { outbox: [] }, kv: null };
  const done = openReviewSheet({ currentName: 'ethSwap' }, { w, svc, review, acceptImpact: false, check: AGREED });
  one('uni-review-cta').click();
  await sleep(5);
  const [overlay] = overlays();
  for (const fn of overlay.listeners.get('campfire:dismiss') || []) fn({}); // the app moved on
  auth.answer(0);
  assert.equal(await done, null);
  await sleep(20);
  assert.equal(built, 0);
  assert.equal(globalThis.__eth.signed.length, 0);
});

test('Uniswap review sheet: closed while the swap is being built: nothing is signed (audit X5)', async () => {
  reset();
  const q = { tokenIn: ETH_TOKEN, tokenOut: RSFIRO_TOKEN, amountIn: E / 10n, amountOut: 1000n, priceImpact: 0, pools: [], minimumOut: () => 1n, route: [] };
  const review = { quote: q, impact: 'none', minimumOut: 1n, slippageBips: 100, expectedGasCost: 1n, maxGasCost: 2n, needsPermit: false, owner: '0x' };
  let built = 0;
  // A slow build: several server round trips and, for a token, the Permit2 signature.
  const svc = { finalizeSwap: async () => (built++, await sleep(60), { tx: {}, minimumOut: 1n }) };
  const w = { rpc: { host: { name: 'Test server' } }, state: { outbox: [] }, kv: null };
  const done = openReviewSheet({ currentName: 'ethSwap' }, { w, svc, review, acceptImpact: false, check: AGREED });
  one('uni-review-cta').click();
  await sleep(5);
  auth.answer(0);
  await until(() => built === 1, 'the build');
  const [overlay] = overlays();
  for (const fn of overlay.listeners.get('campfire:dismiss') || []) fn({}); // the app moved on mid-build
  assert.equal(await done, null);
  await sleep(120);
  assert.equal(globalThis.__eth.signed.length, 0, 'a closed review signs nothing');
});

test('Uniswap review sheet (P13): no second server answered: Swap waits for the tick that names it', async () => {
  reset();
  const q = { tokenIn: ETH_TOKEN, tokenOut: RSFIRO_TOKEN, amountIn: E / 10n, amountOut: 1000n, priceImpact: 0, pools: [], minimumOut: () => 1n, route: [] };
  const review = { quote: q, impact: 'none', minimumOut: 1n, slippageBips: 100, expectedGasCost: 1n, maxGasCost: 2n, needsPermit: false, owner: '0x' };
  const svc = { finalizeSwap: async () => ({ tx: {}, minimumOut: 1n }) };
  const w = { rpc: { host: { name: 'Test server' } }, state: { outbox: [] }, kv: null };
  const unchecked = { status: 'unchecked', host: null, mine: 1000n, theirs: null, gap: null };
  const done = openReviewSheet({ currentName: 'ethSwap' }, { w, svc, review, acceptImpact: false, check: unchecked });
  assert.match(one('uni-review-second').textContent, /no second server answered to compare it with\. Your minimum comes from its price alone/);
  assert.equal(one('uni-review-cta').disabled, true, 'off until ticked');
  one('uni-review-cta').click();
  await sleep(10);
  assert.equal(auth.sheets.length, 0, 'no password asked');
  const box = one('uni-review-second-ack');
  box.checked = true;
  for (const fn of box.listeners.get('change') || []) fn({});
  await sleep(5);
  assert.equal(one('uni-review-cta').disabled, false);
  one('uni-review-cta').click();
  await sleep(5);
  auth.answer(0);
  assert.match(await done, /^0x/);
  assert.equal(globalThis.__eth.signed.length, 1);
});

// ------------------------------------------------------------------ PancakeSwap

async function bscScreen({ side = 'buy', allowance, openSwap = () => null } = {}) {
  reset();
  globalThis.__allowance = allowance;
  const w = plainEthWallet({ chain: () => ({ checkedAt: 1, native: E, tokens: new Map([['rsFIRO', 10n ** 12n]]), block: 100, minedNonce: 0 }), openSwap });
  const app = makeApp({ ethSwapBsc: (a, p) => ethSwapBsc(a, p, { wallet: async () => w, quote: async (_rpc, { amountIn }) => ({ amountIn, amountOut: side === 'buy' ? 7000000000n : 10n ** 16n, priceImpact: 0.001 }) }) });
  app.bscSwapDraft = { side, amount: '' };
  app.go('ethSwapBsc');
  await sleep(30);
  typeInto(one('pcs-pay-amount', app.current.el), side === 'buy' ? '0.1' : '10');
  await sleep(600);
  return { app, w, cta: one('pcs-swap-cta', app.current.el) };
}

test('PancakeSwap: the Swap button stays off behind its own review sheet; Enter on it opens no second one', async () => {
  const { app, cta } = await bscScreen();
  assert.equal(cta.disabled, false, one('pcs-reason', app.current.el).textContent);
  cta.click();
  await until(() => overlays().length === 1, 'the review sheet');
  assert.equal(cta.disabled, true);
  await cta.click();
  await sleep(50);
  assert.equal(overlays().length, 1, 'one review sheet');
  assert.equal(globalThis.__eth.prepares, 1);
});

test('PancakeSwap selling: the button stays off while the Allow password is asked; Enter on it asks no second time', async () => {
  const { app, cta } = await bscScreen({ side: 'sell', allowance: 0n });
  assert.equal(cta.disabled, false, one('pcs-reason', app.current.el).textContent);
  assert.match(cta.textContent, /^Allow /);
  cta.click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  assert.equal(cta.disabled, true);
  await cta.click();
  await sleep(50);
  assert.equal(auth.sheets.length, 1, 'one password sheet, one permission');
});

test('PancakeSwap review: cannot be closed by a tap beside it; two taps on Swap ask once and swap once; closed during the password, nothing is signed', async () => {
  const { app, cta } = await bscScreen();
  cta.click();
  await until(() => overlays().length === 1, 'the review sheet');
  const [overlay] = overlays();
  assert.equal(overlay.getAttribute('data-dismissable'), '0', 'not closed by a tap beside it');
  one('pcs-review-swap').click();
  one('pcs-review-swap').click();
  await sleep(20);
  assert.equal(auth.sheets.length, 1, 'one password sheet');
  assert.equal(one('pcs-review-swap').disabled, true);
  auth.answer(0);
  await until(() => app.currentName === 'ethTx', 'the status screen');
  assert.equal(globalThis.__eth.signed.length, 1, 'one swap');
  // A second review, closed by the app moving on while the password is asked: nothing is signed.
  const second = await bscScreen();
  second.cta.click();
  await until(() => overlays().length === 1, 'the review sheet');
  one('pcs-review-swap').click();
  await sleep(5);
  for (const fn of overlays()[0].listeners.get('campfire:dismiss') || []) fn({});
  auth.answer(0);
  await sleep(30);
  assert.equal(globalThis.__eth.signed.length, 0);
});

test('PancakeSwap review (XS): checked again after the password: past its deadline, reverting now, or needing more gas: nothing is signed', async () => {
  // Reverts now (the price moved past the minimum while the review waited).
  let s = await bscScreen();
  s.cta.click();
  await until(() => overlays().length === 1, 'the review sheet');
  globalThis.__eth.revertFrom = globalThis.__eth.prepares + 1;
  one('pcs-review-swap').click();
  await sleep(5);
  auth.answer(auth.sheets.length - 1);
  await until(() => /Nothing was sent\. BNB Chain would refuse this swap now/.test(overlays()[0].textContent), 'the refusal');
  assert.equal(globalThis.__eth.signed.length, 0, 'not signed');
  assert.equal(one('pcs-review-swap').disabled, false, 'Swap is offered again, Change too');
  // Needs more gas than the review carries.
  s = await bscScreen();
  s.cta.click();
  await until(() => overlays().length === 1, 'the review sheet');
  globalThis.__eth.gasNow = 250000n;
  one('pcs-review-swap').click();
  await sleep(5);
  auth.answer(auth.sheets.length - 1);
  await until(() => /needs more network fee than this review showed/.test(overlays()[0].textContent), 'the refusal');
  assert.equal(globalThis.__eth.signed.length, 0);
  // Left open until less than two minutes of its deadline (20 minutes) remain.
  s = await bscScreen();
  s.cta.click();
  await until(() => overlays().length === 1, 'the review sheet');
  const realNow = Date.now;
  const later = realNow() + 19 * 60000;
  Date.now = () => later;
  try {
    one('pcs-review-swap').click();
    await sleep(5);
    auth.answer(auth.sheets.length - 1);
    await until(() => /This review waited too long/.test(overlays()[0].textContent), 'the refusal');
  } finally {
    Date.now = realNow;
  }
  assert.equal(globalThis.__eth.signed.length, 0);
});

test('PancakeSwap selling (XP): a permission sent while the password was asked is followed, never a second one', async () => {
  const { app, cta, w } = await bscScreen({ side: 'sell', allowance: 0n });
  cta.click();
  await until(() => auth.sheets.length === 1, 'the Allow password');
  // Meanwhile another permission of this wallet is on its way (sent from elsewhere in this page).
  const sent = { hash: `0x${'cd'.repeat(32)}`, kind: 'approve', chain: 'bsc', token: '0x13cdb5f7f398f6af2cc3b34eb04476af3488853f', asset: 'rsFIRO', amount: String(10n * 10n ** 8n), state: 'pending', nonce: '0', extra: { spender: '0x' } };
  w.state.outbox = [sent];
  globalThis.__onItsWay = true;
  auth.answer(0);
  await sleep(60);
  assert.equal(globalThis.__eth.signed.length, 0, 'no second permission');
  globalThis.__onItsWay = false;
  app.go('home'); // the screen stops following it
});

test('PancakeSwap buying: a buy still on its way holds the next one, with what to do', async () => {
  const onItsWay = { hash: `0x${'ab'.repeat(32)}`, kind: 'swap', chain: 'bsc', token: null, asset: 'BNB', amount: '100000000000000000', state: 'pending', nonce: '3' };
  const { app, cta } = await bscScreen({ openSwap: (chain, token) => (chain === 'bsc' && token === null ? onItsWay : null) });
  assert.equal(cta.disabled, true);
  assert.equal(one('pcs-reason', app.current.el).textContent, 'Your last swap of BNB is still on its way.');
  const n = one('pcs-swap-on-its-way', app.current.el);
  assert.ok(n);
  assert.match(n.textContent, /a second swap could be the same one made twice/);
});
