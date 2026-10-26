// A sell is paid once (release verification 0.1.8, finding 2): the sell screen (screens/sell_order.js)
// on a stand-in DOM, its wallet, password sheet and sells controller scripted (helpers/stand_ins/);
// lib/sell/pay.js and lib/payment_flight.js are the real ones. Before: a sell opened again while its
// payment was still being built offered "It isn't there: send 500 FIRO" and its retry paid it a second
// time; a sell left during buyfiro.app's look still asked for the password over the next screen.
// And the real SellController: two "payment started" marks at once both went through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';
import { SellController } from '../../src/lib/sell/controller.js';
import { SellClient, DEFAULT_PAYOUT } from '../../src/lib/sell/sellfiro.js';
import { memorySellStore } from '../../src/lib/sell/store.js';
import { FakeSellFiro, FakeClock, classify, PAYOUT, SPARK_DEPOSIT } from './sell_fakes.mjs';

const SCREEN = ['/src/screens/sell_order.js'];
redirect([
  { parents: SCREEN, spec: '../lib/wallet.js', to: standIn('wallet') },
  { parents: SCREEN, spec: '../lib/auth_ui.js', to: standIn('auth_ui') },
  { parents: SCREEN, spec: './review.js', to: standIn('review_words') },
  { parents: SCREEN, spec: '../lib/sell/wiring.js', to: standIn('sell_wiring') },
  { parents: SCREEN, spec: './let_go.js', to: standIn('let_go') },
]);

const { reset } = await import('./helpers/stand_ins/wallet.mjs');
const auth = await import('./helpers/stand_ins/auth_ui.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { default: sellOrder } = await import('../../src/screens/sell_order.js');
const { sellPaymentUnderWay, sendSellPayment, paySell } = await import('../../src/lib/sell/pay.js');
const { startPayment, IN_FLIGHT_NOTE } = await import('../../src/lib/payment_flight.js');

const COIN = 100000000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 4000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

/**
 * A sells controller with one open sell, as the screen uses it: its "payment started" mark lands in
 * memory once written (5 ms later), as the real one's does.
 */
function sells({ lookMs = 10 } = {}) {
  const subs = new Set();
  const changed = () => {
    for (const f of [...subs]) f();
  };
  const orders = new Map([['o1', { orderId: 'o1', amount: 500n * COIN, depositAddress: `a${'1'.repeat(33)}`, payout: { address: `0x${'2'.repeat(40)}`, own: false, symbol: 'USDT', chainName: 'BNB Chain', chainId: 56 }, isOpen: true, lastState: 'awaiting_deposit', payable: true, payFrom: 'private', expiresAt: Date.now() + 3600000, receiveUsd: 480 }]]);
  const set = (id, patch) => {
    orders.set(id, { ...orders.get(id), ...patch });
    changed();
    return orders.get(id);
  };
  return {
    order: (id) => orders.get(id) || null,
    lookNow: async (id) => {
      await sleep(lookMs);
      return { answered: true, order: orders.get(id) };
    },
    markSending: async (id) => {
      await sleep(5);
      const o = orders.get(id);
      return set(id, { sendStartedAt: o.sendStartedAt ?? Date.now() });
    },
    markSent: async (id, { txid, from }) => set(id, { sentTxid: txid, sentFrom: from }),
    markNotSent: async (id) => (orders.get(id).sentTxid ? orders.get(id) : set(id, { sendStartedAt: null })),
    markUnsure: async (id, { txid }) => set(id, { unsureTxid: txid }),
    markPaidElsewhere: async () => {},
    unmarkPaidElsewhere: async () => {},
    onChange(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
    resumeAll: async () => {},
    poll: async () => {},
    pollError: () => null,
    loadError: null,
  };
}

function rig({ lookMs = 10, sendMs = 0 } = {}) {
  auth.sheets.length = 0;
  const sends = [];
  globalThis.__sellController = sells({ lookMs });
  reset({
    quote: async () => ({ fee: 1000n, total: 500n * COIN + 1000n, change: 0n, warnings: [] }),
    send: async (req) => {
      sends.push(req);
      await sleep(sendMs);
      return { txid: String(sends.length).repeat(64).slice(0, 64) };
    },
  });
  const app = makeApp({ sellOrder: (a, p) => sellOrder(a, p) });
  return { app, sends };
}
const open = async (app) => {
  app.go('sellOrder', { id: 'o1' });
  await sleep(30); // the deposit address checked, the payment's figures read
  return app.current.el;
};

test('a sell opened again while its payment is still being sent shows it as being sent, never "It isn\'t there: send": paid once', async () => {
  const { app, sends } = rig({ sendMs: 600 });
  const a = await open(app);
  one('sell-order-cta', a).click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  app.go('home');
  const b = await open(app);
  assert.ok(sellPaymentUnderWay('o1'));
  assert.equal(one('sell-interrupted', b), null, 'not an interrupted payment');
  assert.equal(one('sell-pay-anyway', b), null, '"It isn\'t there: send" not offered');
  const cta = one('sell-order-cta', b);
  assert.equal(cta.textContent, 'Sending…');
  assert.equal(cta.disabled, true);
  await cta.click();
  await until(() => !sellPaymentUnderWay('o1'), 'the payment to end');
  await sleep(10);
  assert.equal(sends.length, 1, 'paid once');
  assert.equal(auth.sheets.length, 1);
  assert.ok(one('sell-sent', app.current.el), 'the sell says it was sent');
});

test('a sell left while buyfiro.app is looked at, before the password: no password sheet over the next screen; paid once from the one opened again', async () => {
  const { app, sends } = rig({ lookMs: 200, sendMs: 10 });
  const a = await open(app);
  one('sell-order-cta', a).click();
  await sleep(30);
  app.go('home');
  const b = await open(app);
  assert.equal(one('sell-order-cta', b).disabled, true, 'the first run is still under way');
  await until(() => !sellPaymentUnderWay('o1'), 'the first run to end');
  await sleep(10);
  assert.equal(auth.sheets.length, 0, 'the left sell never asked for the password');
  const cta = one('sell-order-cta', app.current.el);
  assert.equal(cta.disabled, false, cta.textContent);
  cta.click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  await sleep(30);
  assert.equal(sends.length, 1);
});

test('a double tap pays once; another Firo payment still being sent holds the sell, with the reason next to the button', async () => {
  const { app, sends } = rig({ sendMs: 10 });
  const release = startPayment('send');
  try {
    const el = await open(app);
    assert.equal(one('sell-order-cta', el).disabled, true);
    assert.equal(one('sell-pay-reason', el).textContent, IN_FLIGHT_NOTE);
  } finally {
    release();
  }
  await sleep(10);
  const cta = one('sell-order-cta', app.current.el);
  assert.equal(cta.disabled, false);
  cta.click();
  cta.click();
  await until(() => auth.sheets.length >= 1, 'the password sheet');
  await sleep(20);
  assert.equal(auth.sheets.length, 1);
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  await sleep(30);
  assert.equal(sends.length, 1);
});

// ------------------------------------------------ lib/sell/pay.js and the real SellController

function realRig() {
  const server = new FakeSellFiro();
  const clock = new FakeClock();
  const c = new SellController({ client: new SellClient({ fetch: server.fetch, classifyAddress: classify }), store: memorySellStore(), clock, autoPoll: false });
  return { c, clock, place: () => c.placeOrder({ amount: 500n * COIN, payout: { ...DEFAULT_PAYOUT, address: PAYOUT, own: true }, payFrom: 'private', walletId: 'w1' }) };
}
const stubWallet = () => {
  const w = {
    sent: [],
    state: { tip: { height: 1000 }, txs: [], txsLoaded: true, sync: { canSend: true } },
    async quote() {
      return { fee: 1000n, total: 500n * COIN + 1000n, change: 0n, warnings: [] };
    },
    async send(req) {
      w.sent.push(req);
      await sleep(5);
      return { txid: 'ab'.repeat(32) };
    },
  };
  return w;
};

test('the controller: two "payment started" marks at once: the second is refused (paid); a sell carrying a payment is never marked again', async () => {
  const r = realRig();
  const { orderId } = await r.place();
  const [first, second] = await Promise.allSettled([r.c.markSending(orderId), r.c.markSending(orderId)]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'paid');
  await r.c.markSent(orderId, { txid: 'ab'.repeat(32), from: 'private' });
  await assert.rejects(r.c.markSending(orderId), (e) => e.code === 'paid');
});

test('lib/sell/pay.js: two payments of one sell at once (two screens, two ways in): one is sent, the other refused before anything is marked', async () => {
  const r = realRig();
  const { orderId } = await r.place();
  const w = stubWallet();
  const to = [{ address: SPARK_DEPOSIT, amount: 500n * COIN }];
  const [a, b] = await Promise.all([sendSellPayment({ c: r.c, w, orderId, from: 'private', to }), sendSellPayment({ c: r.c, w, orderId, from: 'private', to })]);
  assert.deepEqual([a.kind, b.kind].sort(), ['refused', 'sent']);
  assert.equal(w.sent.length, 1);
  // paySell too, the second while the first waits on the password.
  const r2 = realRig();
  const o2 = await r2.place();
  const w2 = stubWallet();
  let yes;
  const gate = new Promise((res) => (yes = res));
  const args = { c: r2.c, w: w2, orderId: o2.orderId, from: 'private', to, reviewedTotal: 500n * COIN + 1000n, clock: r2.clock };
  const firstRun = paySell({ ...args, confirm: () => gate });
  await sleep(5);
  const again = await paySell({ ...args, confirm: async () => true });
  assert.equal(again.kind, 'refused');
  assert.equal(again.code, 'paid');
  yes(true);
  assert.equal((await firstRun).kind, 'sent');
  assert.equal(w2.sent.length, 1);
});
