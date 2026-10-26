// One Ethereum / BNB Chain payment from one intent (release verification 0.1.8, findings 3 and 8,
// and the NIT on eth_review.js): Send on Ethereum (screens/eth_send.js) and its review sheet
// (screens/eth_review.js) on a stand-in DOM, the wallet, the server and the signing scripted
// (helpers/stand_ins/). Before: a slow preparation's review opened later, over whatever screen the
// person was on, and confirming it signed the same payment again with the next nonce (both mined);
// the Send button was live under its own review sheet (Enter opened a second one); a review sheet
// closed while it checked the fee still asked for the password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

const SEND = ['/src/screens/eth_send.js'];
const REVIEW = ['/src/screens/eth_review.js'];
redirect([
  { parents: SEND, spec: '../lib/eth/wallet.js', to: standIn('eth_wallet') },
  { parents: SEND, spec: '../lib/eth/rpc.js', to: standIn('eth_rpc') },
  { parents: [...SEND, ...REVIEW], spec: '../lib/eth/send.js', to: standIn('eth_send_lib') },
  { parents: SEND, spec: './eth_review.js', to: standIn('eth_review_sheet') },
  { parents: REVIEW, spec: '../lib/auth_ui.js', to: standIn('auth_ui') },
  { parents: REVIEW, spec: '../lib/eth/short_now.js', to: standIn('short_now') },
]);

const { plainEthWallet } = await import('./helpers/stand_ins/eth_wallet.mjs');
const { reviewSheets } = await import('./helpers/stand_ins/eth_review_sheet.mjs');
const auth = await import('./helpers/stand_ins/auth_ui.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { default: ethSend } = await import('../../src/screens/eth_send.js');
const { openEthReview } = await import('../../src/screens/eth_review.js');
const { ETH } = await import('../../src/lib/eth/tokens.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
const TO = `0x${'33'.repeat(20)}`;

function rig({ prepareMs = 0, signMs = 0 } = {}) {
  globalThis.__eth = { prepares: 0, signed: [], prepareMs, signMs };
  globalThis.__ethWallet = plainEthWallet();
  reviewSheets.length = 0;
  auth.sheets.length = 0;
  return makeApp({ ethSend: (a, p) => ethSend(a, p) });
}

/** Opens Send on Ethereum and fills in an address and 0.1 ETH; resolves its button. */
async function filled(app) {
  app.go('ethSend', { chain: 'ethereum' });
  await sleep(20);
  const el = app.current.el;
  const to = one('eth-send-to', el);
  to.value = TO;
  for (const fn of to.listeners.get('input') || []) fn({});
  const amount = one('eth-send-amount', el);
  amount.value = '0.1';
  for (const fn of amount.listeners.get('input') || []) fn({});
  await sleep(230);
  const cta = one('eth-send-review', el);
  assert.equal(cta.disabled, false, cta.textContent);
  return cta;
}

test('Send: a double tap prepares once and opens one review', async () => {
  const app = rig({ prepareMs: 100 });
  const cta = await filled(app);
  cta.click();
  cta.click();
  await sleep(150);
  assert.equal(globalThis.__eth.prepares, 1);
  assert.equal(reviewSheets.length, 1);
});

test('Send: the button stays off under its own review sheet (Enter on it opens no second one), and comes back once the sheet closes', async () => {
  const app = rig({ prepareMs: 10 });
  const cta = await filled(app);
  await cta.click();
  assert.equal(reviewSheets.length, 1);
  assert.equal(cta.disabled, true, 'off while the review is open');
  await cta.click();
  await sleep(30);
  assert.equal(reviewSheets.length, 1);
  reviewSheets[0].close(false);
  assert.equal(cta.disabled, false, 'back once the review closed');
});

test('Send: left while a slow server prepares, Send again: the first review never opens; one review, over the screen it belongs to', async () => {
  const app = rig({ prepareMs: 300 });
  const first = await filled(app);
  first.click();
  await sleep(20);
  app.back('ethHome');
  const second = await filled(app);
  second.click();
  await sleep(400);
  assert.equal(reviewSheets.length, 1, `reviews over: ${reviewSheets.map((s) => s.over)}`);
  assert.equal(reviewSheets[0].over, 'ethSend');
});

test('Send: moved on to the payment\'s status screen before a stale preparation answers: no review over it', async () => {
  const app = rig({ prepareMs: 200 });
  const cta = await filled(app);
  cta.click();
  await sleep(20);
  app.go('ethTx', { hash: `0x${'aa'.repeat(32)}` });
  await sleep(300);
  assert.equal(reviewSheets.length, 0);
});

// ------------------------------------------------------------------ the review sheet

function prepared({ old = false } = {}) {
  return { asset: { ...ETH, chain: 'ethereum' }, recipient: TO, amount: 10n ** 17n, fees: { likely: 1n, upTo: 2n }, tx: { gasLimit: 21000n }, preparedAt: old ? Date.now() - 120000 : Date.now() };
}

test('Review sheet: closed while an old review is checked again, it never asks for the password', async () => {
  const app = rig({ prepareMs: 100 });
  app.currentName = 'ethSend';
  const w = plainEthWallet();
  const sheet = openEthReview(app, w, prepared({ old: true }));
  const send = one('eth-review-send');
  send.click();
  await sleep(20);
  sheet.close(); // the app moved on (a lock, a link)
  await sleep(150);
  assert.equal(auth.sheets.length, 0, 'no password sheet over the next screen');
  assert.equal(globalThis.__eth.signed.length, 0);
});

test('Review sheet: closed while the password was asked: nothing is signed; closed while it signed: the person is not taken to its status screen', async () => {
  const app = rig({ signMs: 100 });
  app.currentName = 'ethSend';
  const w = plainEthWallet();
  let sheet = openEthReview(app, w, prepared());
  one('eth-review-send').click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  sheet.close();
  auth.answer(0);
  await sleep(50);
  assert.equal(globalThis.__eth.signed.length, 0);
  sheet = openEthReview(app, w, prepared());
  one('eth-review-send').click();
  await until(() => auth.sheets.length === 2, 'the second password sheet');
  auth.answer(1);
  await until(() => globalThis.__eth.signed.length === 1, 'the signature');
  sheet.close();
  app.currentName = 'ethHome';
  await sleep(150);
  assert.ok(!app.moves.includes('ethTx'), `moves: ${app.moves}`);
});

test('XB: a Buy\'s address past its deadline is never paid from Review: looked at again after the password, nothing signed', async () => {
  const app = rig({});
  app.currentName = 'ethSend';
  const w = plainEthWallet();
  // Opened in time; the deadline passed while the review sat open.
  const payBy = { address: TO, deadline: Date.now() + 11 * 60 * 1000 };
  openEthReview(app, w, prepared(), { payBy });
  payBy.deadline = Date.now() + 60 * 1000;
  one('eth-review-send').click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => one('eth-pay-by'), 'the refusal');
  assert.match(one('eth-pay-by').textContent, /too soon for a payment from here to be sure to reach it in time, so nothing was sent/);
  assert.equal(globalThis.__eth.signed.length, 0);
});

test('XB: Send says so too, and its button stays off, while the address is the Buy\'s; another address is not held up', async () => {
  const app = rig({});
  app.ethSendDraft = { to: TO, amount: '0.1', symbol: 'ETH', chain: 'ethereum', payBy: { address: TO, deadline: Date.now() - 1 } };
  app.go('ethSend', { chain: 'ethereum' });
  await sleep(20);
  const el = app.current.el;
  const amount = one('eth-send-amount', el);
  for (const fn of amount.listeners.get('input') || []) fn({});
  await sleep(230);
  assert.match(one('eth-send-pay-by', el).textContent, /no longer takes payments\. Start the buy again/);
  assert.equal(one('eth-send-review', el).disabled, true);
  const to = one('eth-send-to', el);
  to.value = `0x${'44'.repeat(20)}`;
  for (const fn of to.listeners.get('input') || []) fn({});
  await sleep(230);
  assert.equal(one('eth-send-pay-by', el).textContent, '');
  assert.equal(one('eth-send-review', el).disabled, false);
});
