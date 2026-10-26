// What the Sell FIRO screens say: FIRO as typed, the smallest and largest
// sell, the payout in words, every refusal in plain words with its one fix
// (never the person's fault, never a cost of buyfiro.app's), a sell's three
// steps and each state in one line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firoText, firoFigure, minimumAmountText, maximumAmountText, payoutText, receiveText, otherChainNote, problemText, stateLine, sellSteps, fromText, KEEP_ORDER_TEXT } from '../../src/lib/sell/words.js';
import { SellError, ERROR_CODES, DEFAULT_PAYOUT, STATES } from '../../src/lib/sell/sellfiro.js';
import { makeOrder } from '../../src/lib/sell/store.js';
import { PAYOUT, T_DEPOSIT } from './sell_fakes.mjs';

const payout = { ...DEFAULT_PAYOUT, address: PAYOUT, own: true };
const NO_COST = /\bfees?\b|%|commission|spread/i;

test('FIRO and dollars as people read them', () => {
  assert.equal(firoText(50000000000n), '500 FIRO');
  assert.equal(firoText(123456789012n), '1,234.56789012 FIRO');
  assert.equal(firoFigure(300), '300');
  assert.equal(firoFigure(9691.8), '9,691.8');
  assert.equal(firoFigure(9680.546), '9,680.55');
  assert.equal(minimumAmountText(300.2), '301');
  assert.equal(maximumAmountText(9691.8), '9691');
  assert.equal(payoutText(payout), 'USDT on BNB Chain');
  assert.equal(receiveText(495.84, payout), '≈ $495.84 in USDT on BNB Chain');
  assert.equal(receiveText(1497.27, payout), '≈ $1,497 in USDT on BNB Chain');
  assert.equal(fromText('public'), 'Your public balance');
  assert.equal(fromText('private'), 'Your private balance');
});

test("a payout to this wallet's address on a chain its Ethereum & BNB side does not show is said", () => {
  assert.equal(otherChainNote(payout), null);
  assert.equal(otherChainNote({ ...payout, chainId: 1, chainName: 'Ethereum' }), null);
  assert.match(otherChainNote({ ...payout, chainId: 8453, chainName: 'Base' }), /shows Ethereum and BNB Chain only\. Base pays to the same address/);
  assert.equal(otherChainNote({ ...payout, own: false, chainId: 8453, chainName: 'Base' }), null);
});

test('every refusal has a title and one fix, never blames the person, never names a cost', () => {
  for (const code of [...ERROR_CODES, 'blocked', 'network', 'unexpected_answer', 'unknown', 'order_exists', 'sandbox_required']) {
    const p = problemText(new SellError(code), { payout });
    assert.ok(p.title, code);
    assert.ok(p.fix && p.fixLabel, code);
    assert.doesNotMatch(`${p.title} ${p.detail}`, /your fault|you did wrong|invalid input/i, code);
    assert.doesNotMatch(`${p.title} ${p.detail} ${p.fixLabel}`, NO_COST, code);
  }
  const low = problemText(new SellError('amount_below_minimum', { minimumFiro: 312.4 }), { payout });
  assert.equal(low.title, 'Sell at least 313 FIRO');
  assert.equal(low.fix, 'useMinimum');
  assert.equal(low.fixLabel, 'Use 313 FIRO');
  assert.equal(problemText(new SellError('amount_below_minimum'), { payout, minimum: 300 }).fixLabel, 'Use 300 FIRO', 'the hint, when the refusal has no figure');
  assert.equal(problemText(new SellError('amount_below_minimum'), { payout }).fix, 'editAmount');
  const high = problemText(new SellError('amount_above_maximum', { maximumFiro: 9691.8 }), { payout });
  assert.equal(high.title, 'Sell at most 9,691 FIRO at a time');
  assert.equal(high.fixLabel, 'Use 9,691 FIRO');
  assert.equal(problemText(new SellError('payout_token_invalid'), { payout }).title, "buyfiro.app can't pay USDT on BNB Chain right now");
  assert.equal(problemText(new SellError('payout_chain_unsupported'), { payout }).fix, 'editPayout');
  assert.equal(problemText(new SellError('payout_address_invalid'), { payout }).fix, 'editAddress');
  assert.equal(problemText(new SellError('spark_unavailable'), { payout }).fix, 'payPublic');
  assert.match(problemText(new SellError('rate_limited', { retryAfterMs: 300000 }), { payout }).detail, /Try again in 5 minutes\./);
  assert.match(problemText(new SellError('unavailable', { retryAfterMs: 30000 }), { payout }).detail, /Try again in 30 seconds\./);
  assert.match(problemText(new SellError('order_exists', { amountFiro: 750 }), { payout }).title, /open sell to this address \(750 FIRO\)/);
  assert.equal(problemText(new SellError('order_not_found'), { payout }).serious, true);
  assert.equal(problemText(new SellError('unexpected_answer'), { payout }).serious, true);
  for (const code of ['blocked', 'network']) assert.match(problemText(new SellError(code), { payout }).detail, /Nothing was sent/);
});

test("a sell's three steps, as it goes", () => {
  const marks = (s, o) => sellSteps(s, o).map((x) => x.mark).join(' ');
  assert.equal(marks('awaiting_deposit'), 'active waiting waiting');
  assert.equal(sellSteps('awaiting_deposit')[0].label, 'Send your FIRO');
  assert.equal(sellSteps('awaiting_deposit', { sent: true })[0].label, 'Your FIRO is on its way to buyfiro.app');
  assert.equal(marks('deposit_detected'), 'done waiting waiting');
  assert.equal(sellSteps('deposit_detected')[0].note, 'being confirmed');
  assert.equal(marks('selling'), 'done active waiting');
  assert.equal(sellSteps('limit_open')[1].label, 'Waiting for your price');
  assert.equal(marks('paying_out'), 'done done active');
  assert.equal(sellSteps('paying_out', { symbol: 'BNB' })[2].label, 'Sending BNB to you');
  assert.equal(marks('delivered'), 'done done done');
  assert.equal(sellSteps('delivered')[2].label, 'USDT sent to you');
  assert.equal(marks('expired'), 'failed waiting waiting');
  assert.equal(marks('refused'), 'failed waiting waiting');
  assert.equal(marks('attention', { sent: true }), 'done active waiting');
  assert.equal(marks('attention'), 'active waiting waiting', 'held before this wallet paid: nothing says buyfiro.app has FIRO');
  assert.equal(sellSteps('attention')[0].label, 'Waiting for your FIRO');
  assert.equal(marks('in_progress'), 'done active waiting');
  for (const s of [...STATES, 'in_progress', null]) assert.equal(sellSteps(s).length, 3);
});

test('a sell in one line, for every state', () => {
  const o = (state, over = {}) => makeOrder({ orderId: 'sell_1', walletId: 'w', amount: 1n, depositKind: 'firo', depositAddress: T_DEPOSIT, payFrom: 'public', payout, createdAt: 1, lastState: state, ...over });
  assert.equal(stateLine(o(null)), 'Waiting for your FIRO');
  assert.equal(stateLine(o('awaiting_deposit', { sentTxid: 'ab' })), 'Your FIRO is on its way to buyfiro.app');
  assert.equal(stateLine(o('deposit_detected')), 'buyfiro.app has your FIRO');
  assert.equal(stateLine(o('selling')), 'Selling your FIRO');
  assert.equal(stateLine(o('paying_out')), 'Sending USDT to you');
  assert.equal(stateLine(o('delivered')), 'USDT sent to you');
  assert.equal(stateLine(o('expired')), 'No FIRO arrived in time');
  assert.equal(stateLine(o('refused')), "buyfiro.app couldn't start it");
  assert.equal(stateLine(o('attention')), 'buyfiro.app is checking it');
  assert.equal(stateLine(o('in_progress')), 'Selling your FIRO');
  for (const s of STATES) assert.doesNotMatch(stateLine(o(s)), NO_COST);
});

test('FM-1: a payment that may have left is "may be on its way", never "Send your FIRO" nor "on its way"', () => {
  assert.equal(sellSteps('awaiting_deposit', { unsure: true })[0].label, 'Your FIRO may be on its way to buyfiro.app');
  assert.equal(sellSteps('awaiting_deposit', { sent: true, unsure: true })[0].label, 'Your FIRO is on its way to buyfiro.app');
});

test('FM-6: an open sell or buy is not in the backup file, and the person is told to keep its order', async () => {
  const { KEEP_BUY_ORDER_TEXT } = await import('../../src/lib/buy/words.js');
  const { makeBackup, openBackup } = await import('../../src/lib/backup_file.js');
  const opened = await openBackup(await makeBackup({ mnemonic: 'abandon '.repeat(11) + 'about', name: 'w' }, 'a long enough password', { iterations: 600000 }), 'a long enough password');
  assert.deepEqual(Object.keys(opened).sort(), ['birthday', 'mnemonic', 'name', 'network', 'passphrase'], 'the backup carries the wallet, not its orders (the owner decides)');
  for (const t of [KEEP_ORDER_TEXT, KEEP_BUY_ORDER_TEXT]) {
    assert.match(t, /^Keep this order/);
    assert.match(t, /on this device only, not in your backup file, and buyfiro\.app support asks for it\.$/);
  }
});
