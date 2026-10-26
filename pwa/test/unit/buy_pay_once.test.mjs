// A buy is paid from this wallet once (release verification 0.1.8, finding 5): Your buy
// (screens/buy_order.js) on a stand-in DOM, the buys controller and the Ethereum & BNB wallet
// scripted (helpers/stand_ins/). Before: back from paying it, "Pay from this wallet's Ethereum
// balance" was still offered while that very transfer to the deposit address was on its way, and
// paying again paid the buy twice. Now that payment is linked instead; one that never left
// (refused, failed, replaced) does not count, and an outbox that cannot be read offers nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

const SCREEN = ['/src/screens/buy_order.js'];
redirect([
  { parents: SCREEN, spec: '../lib/wallet.js', to: standIn('wallet') },
  { parents: SCREEN, spec: '../lib/buy/wiring.js', to: standIn('buy_wiring') },
  { parents: SCREEN, spec: '../lib/eth/record.js', to: standIn('eth_record') },
  { parents: SCREEN, spec: '../lib/eth/wallet.js', to: standIn('eth_wallet') },
]);

const { plainEthWallet } = await import('./helpers/stand_ins/eth_wallet.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { default: buyOrder } = await import('../../src/screens/buy_order.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEPOSIT = `0x${'dD'.repeat(20)}`;

function rig(outbox, { readFails = false, order = {}, pollError = null, onPoll = null } = {}) {
  const o = { depositAddress: DEPOSIT, symbol: 'ETH', chain: 'eth', chainName: 'Ethereum', assetId: 'coin:eth', sendAmount: '0.5', contract: null, lastState: 'awaiting_deposit', isOpen: true, refundAddress: `0x${'ee'.repeat(20)}`, estimate: 100, deadline: null };
  Object.assign(o, order);
  globalThis.__buyController = { order: (d) => (d === DEPOSIT ? o : null), pollError: () => (typeof pollError === 'function' ? pollError() : pollError), onChange: () => () => {}, resumeAll: async () => {}, poll: async () => (onPoll && onPoll(o), o), loadError: null };
  globalThis.__ethWallet = plainEthWallet({
    reloadOutbox: async () => {
      if (readFails) throw new Error('The outbox could not be opened.');
      return outbox;
    },
  });
  const app = makeApp({ buyOrder: (a, p) => buyOrder(a, p) });
  return app;
}
// Opened, and its look at the Ethereum & BNB outbox settled (a fixed 40 ms was too short on a busy machine).
const open = async (app) => {
  app.go('buyOrder', { deposit: DEPOSIT });
  const end = Date.now() + 2000;
  await sleep(40);
  while (Date.now() < end && !['buy-pay-from-wallet', 'buy-paid-from-wallet', 'buy-pay-too-late', 'buy-deadline-past'].some((t) => one(t, app.current.el))) await sleep(10);
  return app.current.el;
};
const sentTo = (to, state, extra = {}) => ({ hash: `0x${'ab'.repeat(32)}`, to, state, chain: 'ethereum', asset: 'ETH', token: null, amount: '500000000000000000', nonce: '1', ...extra });

test('nothing sent to the deposit address yet: "Pay from this wallet\'s Ethereum balance" is offered', async () => {
  const el = await open(rig([]));
  assert.ok(one('buy-pay-from-wallet', el));
  assert.equal(one('buy-paid-from-wallet', el), null);
});

test('this wallet\'s transfer to the deposit address on its way, or mined: never offered again; the payment is linked', async () => {
  for (const state of ['signed', 'pending', 'confirmed']) {
    const app = rig([sentTo(DEPOSIT.toLowerCase(), state)]);
    const el = await open(app);
    assert.equal(one('buy-pay-from-wallet', el), null, state);
    const paid = one('buy-paid-from-wallet', el);
    assert.ok(paid, state);
    assert.match(paid.textContent, /You sent this from this wallet\..*Sending it again would pay twice\./);
    await one('buy-paid-from-wallet-see', el).click();
    assert.equal(app.currentName, 'ethTx');
    assert.equal(app.params.hash, `0x${'ab'.repeat(32)}`);
  }
});

test('a transfer that paid nothing (never left, failed, replaced), or one to another address or chain: offered as before', async () => {
  for (const e of [sentTo(DEPOSIT, 'rejected'), sentTo(DEPOSIT, 'failed'), sentTo(DEPOSIT, 'replaced'), sentTo(`0x${'11'.repeat(20)}`, 'pending'), sentTo(DEPOSIT, 'pending', { chain: 'bsc' })]) {
    const el = await open(rig([e]));
    assert.ok(one('buy-pay-from-wallet', el), `${e.state} ${e.chain} ${e.to}`);
  }
});

test('the outbox cannot be read: nothing is offered (it may hold a payment)', async () => {
  const el = await open(rig([], { readFails: true }));
  assert.equal(one('buy-pay-from-wallet', el), null);
});

test('XB: past its deadline (buyfiro.app not reached since): the address is not shown to pay, and nothing is offered but a new buy', async () => {
  const el = await open(rig([], { order: { deadline: Date.now() - 2 * 3600000 } }));
  assert.ok(one('buy-deadline-past', el), 'said');
  assert.equal(one('buy-pay-from-wallet', el), null, 'not offered');
  assert.equal(one('buy-deposit-address', el), null, 'the address is not shown');
  assert.match(one('buy-order-cta', el).textContent, /Start a new buy/);
});

test('XB: too close to its deadline: "Pay from this wallet" is not offered, and says why', async () => {
  const el = await open(rig([], { order: { deadline: Date.now() + 5 * 60000 } }));
  assert.equal(one('buy-pay-from-wallet', el), null);
  assert.ok(one('buy-pay-too-late', el));
});

test('XB: "Pay from this wallet" looks again first: buyfiro.app unreachable, or the buy moved on, starts nothing', async () => {
  let unreachable = false;
  const app = rig([], { order: { deadline: Date.now() + 3600000 }, pollError: () => (unreachable ? { unreachable: true } : null) });
  const el = await open(app);
  unreachable = true;
  await one('buy-pay-from-wallet', el).click();
  await sleep(20);
  assert.notEqual(app.currentName, 'ethSend', 'nothing started');
  assert.ok(one('buy-pay-not-now', app.current.el));
  // Reachable, still waiting: on to Send, the deposit address filled in.
  unreachable = false;
  await one('buy-pay-from-wallet', app.current.el).click();
  await sleep(20);
  assert.equal(app.currentName, 'ethSend');
});

test('XB: the deadline rule', async () => {
  const { buyDeadline, BUY_PAY_MARGIN_MS } = await import('../../src/screens/buy_order.js');
  const now = 1000000000;
  assert.equal(buyDeadline({ deadline: now - 1 }, now), 'past');
  assert.equal(buyDeadline({ deadline: now + BUY_PAY_MARGIN_MS }, now), 'soon');
  assert.equal(buyDeadline({ deadline: now + BUY_PAY_MARGIN_MS + 1 }, now), null);
  assert.equal(buyDeadline({ deadline: null }, now), null);
});

