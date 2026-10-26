// The Buy FIRO controller over a fake buyfiro.app and a fake clock: prices
// asked once typing pauses, the latest question only; a deposit address kept
// on this device before it is shown, a request with no answer sent again as it
// was; and each open buy followed as often as buyfiro.app says, less often
// while it cannot be reached, never once it has ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BuyController } from '../../src/lib/buy/controller.js';
import { BuyClient, BuyAmount, assetFromJson } from '../../src/lib/buy/buyfiro.js';
import { memoryBuyStore, makeOrder } from '../../src/lib/buy/store.js';
import { FakeBuyFiro, FakeClock, ASSETS, BTC, FIRO_ADDRESS, FIRO_ADDRESS_2, BTC_REFUND, answer, envelope, errorJson, statusJson, drain } from './buy_fakes.mjs';

const S = 1000;

function rig({ autoPoll = true, store = memoryBuyStore() } = {}) {
  const server = new FakeBuyFiro();
  const clock = new FakeClock();
  const controller = new BuyController({ client: new BuyClient({ fetch: server.fetch }), store, clock, autoPoll });
  const r = {
    server,
    clock,
    store,
    controller,
    made: 0,
    btc: assetFromJson(ASSETS.find((a) => a.asset_id === BTC)),
    newAddress: async () => {
      r.made++;
      return r.made === 1 ? FIRO_ADDRESS : FIRO_ADDRESS_2;
    },
    request: (text) => ({ asset: r.btc, amount: BuyAmount.parse(text, 8).amount, refundAddress: BTC_REFUND }),
    place: (text = '0.0123') => controller.placeOrder({ asset: r.btc, amount: BuyAmount.parse(text, 8).amount, refundAddress: BTC_REFUND, walletId: 'w1', newWalletAddress: r.newAddress }),
  };
  return r;
}

function stored(deposit, { state = null, at = Date.UTC(2026, 9, 9, 11) } = {}) {
  return makeOrder({ depositAddress: deposit, assetId: BTC, symbol: 'BTC', chain: 'btc', decimals: 8, sendAmount: '0.0123', sendAmountRaw: 1230000n, walletAddress: FIRO_ADDRESS, walletId: 'w1', refundAddress: BTC_REFUND, createdAt: at, lastState: state, terminal: ['delivered', 'refunded', 'expired', 'failed'].includes(state) });
}

test('quotes: asked once typing pauses for 400 ms', async () => {
  const r = rig();
  r.controller.requestQuote(r.request('0.0123'));
  assert.equal(r.controller.quoting, true);
  await r.clock.advance(399);
  assert.equal(r.server.count('/quote'), 0);
  await r.clock.advance(1);
  assert.equal(r.server.count('/quote'), 1);
  assert.equal(r.controller.quoting, false);
  assert.ok(r.controller.quote.estimate > 0);
  // Typing again before the pause ends asks once, for the last amount.
  r.controller.requestQuote(r.request('0.02'));
  await r.clock.advance(200);
  r.controller.requestQuote(r.request('0.03'));
  await r.clock.advance(400);
  assert.equal(r.server.count('/quote'), 2);
  assert.equal(r.server.requests.at(-1).url.searchParams.get('amount'), '0.03');
});

test('quotes: a slow answer to an older question is dropped', async () => {
  const r = rig();
  let release;
  r.server.holdQuotes = new Promise((res) => (release = res));
  r.controller.requestQuote(r.request('0.0123'));
  await r.clock.advance(400);
  r.server.holdQuotes = null;
  r.controller.requestQuote(r.request('0.05'));
  await r.clock.advance(400);
  const latest = r.controller.quote;
  release();
  await drain();
  assert.equal(r.controller.quote, latest);
  assert.equal(r.controller.quoteRequest.amount.text, '0.05');
});

test('quotes: clearing drops a price on its way', async () => {
  const r = rig();
  r.controller.requestQuote(r.request('0.0123'));
  r.controller.requestQuote(null);
  await r.clock.advance(1000);
  assert.equal(r.server.count('/quote'), 0);
  assert.equal(r.controller.quoting, false);
  assert.equal(r.controller.quote, null);
});

test("the smallest-buy hint: buyfiro.app's observed figure, else a refused price's; never its own $5 floor", async () => {
  const live = rig();
  live.server.queue('/limits', envelope({ our_minimum_usd: 5, maximum_usd: null, upstream_observed_minimum_usd: null }));
  await live.controller.refreshLimits();
  assert.equal(live.controller.minimumHintUsd, null, 'as buyfiro.app answers today: nothing to say up front');
  const r = rig();
  assert.equal(r.controller.minimumHintUsd, null);
  r.controller.requestQuote(r.request('0.001'));
  await r.clock.advance(400);
  assert.equal(r.controller.quoteError.code, 'amount_below_upstream_minimum');
  assert.equal(r.controller.quoteError.minimumUsd, 1000);
  assert.equal(r.controller.minimumHintUsd, 1000);
  r.server.queue('/limits', envelope({ our_minimum_usd: 5, upstream_observed_minimum_usd: 1100 }));
  await r.controller.refreshLimits();
  assert.equal(r.controller.minimumHintUsd, 1100);
  r.server.offline = true;
  await r.controller.refreshLimits();
  assert.equal(r.controller.minimumHintUsd, 1100, 'the last hint is kept');
});

test('orders: the buy is in the store before placeOrder returns', async () => {
  const r = rig();
  const o = await r.place();
  assert.equal(r.store.writes.length, 1);
  assert.equal(r.store.writes[0].depositAddress, o.depositAddress);
  assert.equal(o.walletAddress, FIRO_ADDRESS);
  assert.equal(r.server.requests.find((q) => q.method === 'POST').body.firo_wallet, FIRO_ADDRESS);
  assert.equal(o.lastState, 'awaiting_deposit');
  assert.equal(o.sendAmount, '0.0123');
  assert.equal(o.deadline, 1791579600000);
  assert.deepEqual(r.controller.orders('w1').map((x) => x.depositAddress), [o.depositAddress]);
  assert.deepEqual(r.controller.orders('other'), []);
});

test('D-16: an order whose deposit address is another chain\'s is refused and never kept', async () => {
  const r = rig();
  r.server.depositAddress = '0x1111111111111111111111111111111111111111';
  await assert.rejects(r.place(), (e) => e.code === 'wrong_deposit_address');
  assert.equal(r.store.writes.length, 0, 'nothing to pay was saved');
  assert.deepEqual(r.controller.orders('w1'), []);
  assert.equal(r.server.requests.filter((q) => q.method === 'POST').length, 1, 'not asked again: buyfiro.app answered');
});

test('orders: a POST that got no answer is sent again as it was: the same order comes back', async () => {
  const r = rig();
  r.server.queue('/order', new TypeError('Failed to fetch'));
  r.server.queue('/order', answer(403, '<html>Blocked</html>', { 'content-type': 'text/html' }));
  const o = await r.place();
  const posts = r.server.requests.filter((q) => q.method === 'POST');
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((p) => JSON.stringify(p.body))).size, 1);
  assert.equal(r.made, 1);
  assert.equal(o.depositAddress, r.server.depositAddress);
});

test('orders: still no answer: the error, and "Try again" reuses the FIRO address', async () => {
  const r = rig();
  r.server.offline = true;
  await assert.rejects(r.place(), (e) => e.code === 'network');
  assert.equal(r.server.count('/order'), 3);
  r.server.offline = false;
  const o = await r.place();
  assert.equal(r.made, 1);
  assert.equal(o.walletAddress, FIRO_ADDRESS);
  assert.equal(new Set(r.server.requests.filter((q) => q.method === 'POST').map((q) => JSON.stringify(q.body))).size, 1);
});

test('orders: an answer for another order is neither kept nor shown, and not asked again', async () => {
  const r = rig();
  r.server.queue('/order', envelope({ deposit_address: 'd', asset_id: BTC, send_amount_raw: '1230000', firo_wallet: FIRO_ADDRESS_2, payable: true }));
  await assert.rejects(r.place(), (e) => e.code === 'unexpected_answer');
  assert.equal(r.store.writes.length, 0);
  assert.deepEqual(r.controller.orders(), []);
  assert.equal(r.server.count('/order'), 1);
});

test('following: looked at every poll_after_seconds until it ends, never again after', async () => {
  const r = rig();
  const o = await r.place();
  const path = `/order/${o.depositAddress}`;
  assert.equal(r.server.count(path), 0);
  await r.clock.advance(14 * S);
  assert.equal(r.server.count(path), 0);
  await r.clock.advance(1 * S);
  assert.equal(r.server.count(path), 1);
  r.server.queue(path, statusJson('buying', { deposit: o.depositAddress, pollAfter: 5 }));
  await r.clock.advance(15 * S);
  assert.equal(r.server.count(path), 2);
  assert.equal(r.controller.order(o.depositAddress).lastState, 'buying');
  await r.clock.advance(5 * S);
  assert.equal(r.server.count(path), 3);
  r.server.state = 'delivered';
  r.server.txId = 'firotx1';
  await r.clock.advance(15 * S);
  assert.equal(r.server.count(path), 4);
  const done = r.controller.order(o.depositAddress);
  assert.equal(done.lastState, 'delivered');
  assert.equal(done.terminal, true);
  assert.equal(done.txid, 'firotx1');
  assert.equal(r.controller.dueAt(o.depositAddress), null);
  await r.clock.advance(3600 * S);
  assert.equal(r.server.count(path), 4);
  assert.equal(r.clock.pending, 0);
});

test('following: an unknown state keeps it followed', async () => {
  const r = rig();
  const o = await r.place();
  r.server.state = 'settling_in_v2';
  await r.clock.advance(15 * S);
  assert.equal(r.controller.order(o.depositAddress).lastState, 'in_progress');
  assert.equal(r.controller.order(o.depositAddress).isOpen, true);
  await r.clock.advance(15 * S);
  assert.equal(r.server.count(`/order/${o.depositAddress}`), 2);
});

test('following: no answer, looked at less often; retry_after honoured; back to normal once answered', async () => {
  const r = rig();
  const o = await r.place();
  const path = `/order/${o.depositAddress}`;
  r.server.offline = true;
  await r.clock.advance(15 * S);
  assert.equal(r.controller.pollError(o.depositAddress).code, 'network');
  assert.equal(r.controller.dueAt(o.depositAddress), r.clock.now() + 30 * S);
  await r.clock.advance(30 * S);
  assert.equal(r.controller.dueAt(o.depositAddress), r.clock.now() + 60 * S);
  r.server.offline = false;
  r.server.queue(path, answer(503, errorJson('upstream_unavailable', { retryAfter: 600 })));
  await r.clock.advance(60 * S);
  assert.equal(r.controller.dueAt(o.depositAddress), r.clock.now() + 600 * S);
  const before = r.server.requests.length;
  await r.clock.advance(599 * S);
  assert.equal(r.server.requests.length, before);
  await r.clock.advance(1 * S);
  assert.equal(r.server.requests.length, before + 1);
  assert.equal(r.controller.pollError(o.depositAddress), null);
  assert.equal(r.controller.dueAt(o.depositAddress), r.clock.now() + 15 * S);
});

test('following: the open buys kept on this device are followed on start; ended ones are not', async () => {
  const store = memoryBuyStore();
  await store.save(stored('open1', { state: 'buying' }));
  await store.save(stored('done1', { state: 'delivered' }));
  const r = rig({ store });
  r.server.depositAddress = 'open1';
  r.server.state = 'sending';
  await r.controller.resumeAll();
  await r.clock.advance(0);
  assert.equal(r.server.count('/order/open1'), 1);
  assert.equal(r.server.count('/order/done1'), 0);
  assert.equal(r.controller.order('open1').lastState, 'sending');
  assert.equal(store.writes.at(-1).lastState, 'sending');
  assert.equal(r.controller.orders().length, 2);
  await r.controller.resumeAll();
  await r.clock.advance(0);
  assert.equal(r.server.count('/order/open1'), 1, 'starting twice follows them once');
});

test('following: nothing while paused; resume catches up; autoPoll off waits for pollDue', async () => {
  const r = rig();
  const o = await r.place();
  r.controller.pause();
  await r.clock.advance(300 * S);
  assert.equal(r.server.count(`/order/${o.depositAddress}`), 0);
  r.controller.resume();
  await r.clock.advance(0);
  assert.equal(r.server.count(`/order/${o.depositAddress}`), 1);

  const m = rig({ autoPoll: false });
  const o2 = await m.place();
  await m.clock.advance(300 * S);
  assert.equal(m.server.count(`/order/${o2.depositAddress}`), 0);
  assert.equal(m.clock.pending, 0);
  await m.controller.pollDue();
  assert.equal(m.server.count(`/order/${o2.depositAddress}`), 1);
});

test('following: the state is written only when it changes; dispose stops everything', async () => {
  const r = rig({ autoPoll: false });
  const o = await r.place();
  await r.controller.poll(o.depositAddress);
  await r.controller.poll(o.depositAddress);
  assert.equal(r.store.writes.length, 1);
  r.server.state = 'deposit_detected';
  await r.controller.poll(o.depositAddress);
  assert.equal(r.store.writes.length, 2);
  assert.equal(r.store.writes.at(-1).lastState, 'deposit_detected');

  const d = rig();
  await d.place();
  let told = 0;
  d.controller.onChange(() => told++);
  d.controller.dispose();
  await d.clock.advance(3600 * S);
  assert.equal(d.server.count('/order/'), 0);
  assert.equal(told, 0);
});

test('FM-2: a state whose write failed is written with the next look, though nothing changed since', async () => {
  const r = rig({ autoPoll: false });
  const o = await r.place();
  r.server.state = 'deposit_detected';
  r.store.failNext = 1;
  await r.controller.poll(o.depositAddress);
  assert.equal(r.controller.order(o.depositAddress).lastState, 'deposit_detected', 'kept in memory');
  assert.equal(r.store.writes.at(-1).lastState, 'awaiting_deposit', 'the write failed');
  await r.controller.poll(o.depositAddress);
  assert.equal(r.store.writes.at(-1).lastState, 'deposit_detected', 'written with the next look');
  const n = r.store.writes.length;
  await r.controller.poll(o.depositAddress);
  assert.equal(r.store.writes.length, n, 'and not again once written');
});

test('FM-2: a look builds on the record as it is when buyfiro.app answers, not as it was when asked', async () => {
  const r = rig({ autoPoll: false });
  const o = await r.place();
  let release;
  const gate = new Promise((res) => (release = res));
  const fetch = r.server.fetch;
  r.controller.client = new BuyClient({
    fetch: async (url, init = {}) => {
      if (/\/order\//.test(new URL(url).pathname)) await gate;
      return fetch(url, init);
    },
  });
  r.server.state = 'deposit_detected';
  const polling = r.controller.poll(o.depositAddress);
  await drain();
  // Something on this device changed the record meanwhile (a later version's field, say).
  const changed = makeOrder({ ...r.controller.order(o.depositAddress), etaSeconds: 4242 });
  r.controller._orders.set(o.depositAddress, changed);
  release();
  await polling;
  assert.equal(r.controller.order(o.depositAddress).etaSeconds, 4242);
  assert.equal(r.controller.order(o.depositAddress).lastState, 'deposit_detected');
});

test('orders: a second tap while the first is on its way gets the same buy: one FIRO address, one request (release verification 0.1.8)', async () => {
  const r = rig({ autoPoll: false });
  const [a, b] = await Promise.all([r.place(), r.place()]);
  assert.equal(a, b);
  assert.equal(r.made, 1, 'one FIRO address made');
  assert.equal(r.server.count('/order'), 1);
  // Later, the same buy asked again is a new request (nothing on its way any more).
  await r.place();
  assert.equal(r.server.count('/order'), 2);
});
