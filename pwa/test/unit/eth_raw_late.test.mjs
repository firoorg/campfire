// A request that holds only until a time: the Bridge's rsFIRO -> FIRO exit is signed only while the
// FIRO price its Rosen fee was worked out on is under ten minutes old (second audit of 0.1.8, N2:
// cross() checked the price once, and the review could be confirmed any time later; FIRO fallen
// meanwhile put the fee under Rosen's $10 minimum, and the rsFIRO is lost). The review screen
// (screens/eth_raw_review.js) on a stand-in DOM, the wallet, server and signing scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

const RAW = ['/src/screens/eth_raw_review.js'];
const SEND_RAW_STUB = new URL('./helpers/stand_ins/send_raw_capture.mjs', import.meta.url).href;
redirect([
  { parents: RAW, spec: '../lib/eth/wallet.js', to: standIn('eth_wallet') },
  { parents: RAW, spec: '../lib/eth/send.js', to: standIn('eth_send_lib') },
  { parents: RAW, spec: '../lib/auth_ui.js', to: standIn('auth_ui') },
  { parents: RAW, spec: '../lib/eth/short_now.js', to: standIn('short_now') },
  { parents: ['/src/lib/rosen/index.js'], spec: '../eth/send_raw.js', to: SEND_RAW_STUB },
]);

const { plainEthWallet } = await import('./helpers/stand_ins/eth_wallet.mjs');
const auth = await import('./helpers/stand_ins/auth_ui.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { default: ethRawReview } = await import('../../src/screens/eth_raw_review.js');
const { openRawRequest } = await import('../../src/lib/eth/send_raw.js');
const { RSFIRO_BSC } = await import('../../src/lib/eth/tokens.js');
const { CHAINS } = await import('../../src/lib/eth/chains.js');
const { cross, quote, PRICE_FRESH_MS } = await import('../../src/lib/rosen/index.js');
const { captured } = await import(SEND_RAW_STUB);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

function open(notAfter) {
  globalThis.__eth = { prepares: 0, signed: [], prepareMs: 0, signMs: 0 };
  globalThis.__ethWallet = plainEthWallet({ spendable: () => ({ eth: 10n ** 18n, rsFIRO: 10n ** 12n, held: {} }) });
  auth.sheets.length = 0;
  const app = makeApp({ ethRawReview: (a, p) => ethRawReview(a, p) });
  const call = { chain: CHAINS.bsc, token: RSFIRO_BSC, to: RSFIRO_BSC.address, recipient: `0x${'55'.repeat(20)}`, amount: 2500n * 10n ** 8n, data: '0x', extraBytes: 0 };
  const words = { title: 'Bridge rsFIRO to FIRO', amountText: '2,500 rsFIRO', rows: [], warning: null, notAfter, lateText: 'The FIRO price these fees were worked out on is now more than ten minutes old.' };
  const outcome = openRawRequest(app, call, words);
  return { app, outcome };
}

test('N2: the review signs nothing past the time its request holds until, after the password too', async () => {
  const { app } = open(Date.now() + 150);
  await until(() => !one('raw-confirm', app.current.el).disabled, 'the review to be ready');
  await sleep(200); // the price is now too old
  one('raw-confirm', app.current.el).click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await sleep(50);
  assert.equal(globalThis.__eth.signed.length, 0, 'nothing signed');
  assert.match(app.current.el.textContent, /Nothing was sent\. The FIRO price these fees were worked out on is now more than ten minutes old\./);
});

test('N2: in time, it is signed as before', async () => {
  const { app } = open(Date.now() + 60000);
  await until(() => !one('raw-confirm', app.current.el).disabled, 'the review to be ready');
  one('raw-confirm', app.current.el).click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => globalThis.__eth.signed.length === 1, 'the signature');
});

test('N2: the Bridge\'s exit asks for exactly that: signed only until ten minutes after its price', async () => {
  const SAT = 100000000n;
  const priceAt = Date.now() - 60000;
  const q = { ...quote({ from: 'bsc', to: 'firo', amount: 2500n * SAT, firoUsd: 1.0 }), priceAt };
  await cross({ app: {}, from: 'bsc', to: 'firo', amount: 2500n * SAT, destination: 'a8ULhhDgfdSiXJhSZVdhb8EuDc6R3ogsaM', quote: q });
  assert.equal(captured.at(-1).notAfter, priceAt + PRICE_FRESH_MS);
  assert.match(captured.at(-1).lateText, /more than ten minutes old/);
});
