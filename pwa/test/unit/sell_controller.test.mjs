// The Sell FIRO controller over a fake buyfiro.app and a fake clock: prices
// asked once typing pauses, the latest question only; a deposit address kept on
// this device before it is shown, Spark asked for when paying privately and a
// transparent address taken (said) when Spark deposits are off, a request with
// no answer sent again as it was, a second tap waiting for the first; "this
// wallet paid it" written before and after the payment; and each open sell
// followed as often as buyfiro.app says, less often while it cannot be reached,
// never once it has ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SellController, samePayout } from '../../src/lib/sell/controller.js';
import { SellClient, DEFAULT_PAYOUT } from '../../src/lib/sell/sellfiro.js';
import { memorySellStore, makeOrder } from '../../src/lib/sell/store.js';
import { FakeSellFiro, FakeClock, answer, envelope, sellErrorJson, classify, PAYOUT, PAYOUT_2, SPARK_DEPOSIT, T_DEPOSIT, TXID, drain } from './sell_fakes.mjs';

const S = 1000;
const COIN = 100000000n;
const payout = (over = {}) => ({ ...DEFAULT_PAYOUT, address: PAYOUT, own: true, ...over });

function rig({ autoPoll = true, store = memorySellStore(), sandbox = false } = {}) {
  const server = new FakeSellFiro();
  const clock = new FakeClock();
  const controller = new SellController({ client: new SellClient({ fetch: server.fetch, classifyAddress: classify, sandbox }), store, clock, autoPoll });
  const r = {
    server,
    clock,
    store,
    controller,
    place: (over = {}) => controller.placeOrder({ amount: 500n * COIN, payout: payout(), payFrom: 'private', walletId: 'w1', ...over }),
  };
  return r;
}

function stored(id, { state = null, at = Date.UTC(2026, 9, 12, 11), ...over } = {}) {
  return makeOrder({ orderId: id, walletId: 'w1', amount: 500n * COIN, depositKind: 'spark', depositAddress: T_DEPOSIT, sparkDepositAddress: SPARK_DEPOSIT, payFrom: 'private', payout: payout(), createdAt: at, lastState: state, terminal: ['delivered', 'expired', 'refused'].includes(state), ...over });
}

test('quotes: asked once typing pauses for 400 ms, the last amount only; a slow older answer is dropped', async () => {
  const r = rig();
  r.controller.requestQuote({ amount: 500n * COIN, payout: payout() });
  assert.equal(r.controller.quoting, true);
  await r.clock.advance(399);
  assert.equal(r.server.count('/quote'), 0);
  await r.clock.advance(1);
  assert.equal(r.server.count('/quote'), 1);
  assert.equal(r.controller.quote.receiveUsd, 480);
  r.controller.requestQuote({ amount: 600n * COIN, payout: payout() });
  await r.clock.advance(200);
  r.controller.requestQuote({ amount: 700n * COIN, payout: payout() });
  await r.clock.advance(400);
  assert.equal(r.server.count('/quote'), 2);
  assert.equal(r.server.requests.at(-1).url.searchParams.get('amount_firo'), '700');
  let release;
  r.server.holdQuotes = new Promise((res) => (release = res));
  r.controller.requestQuote({ amount: 800n * COIN, payout: payout() });
  await r.clock.advance(400);
  r.server.holdQuotes = null;
  r.controller.requestQuote({ amount: 900n * COIN, payout: payout() });
  await r.clock.advance(400);
  const latest = r.controller.quote;
  release();
  await drain();
  assert.equal(r.controller.quote, latest);
  assert.equal(r.controller.quote.amount, 900n * COIN);
  r.controller.requestQuote(null);
  assert.equal(r.controller.quoting, false);
  assert.equal(r.controller.quote, null);
});

test("the smallest-sell hint: buyfiro.app's /limits for the payout, else a refused price's; the last one kept", async () => {
  const r = rig();
  assert.equal(r.controller.minimumHintFiro, null);
  await r.controller.refreshLimits(payout());
  assert.equal(r.controller.minimumHintFiro, 300);
  assert.equal(r.controller.limits.maximumFiro, 9691.8);
  r.server.offline = true;
  await r.controller.refreshLimits(payout());
  assert.equal(r.controller.minimumHintFiro, 300, 'kept');
  const q = rig();
  q.controller.requestQuote({ amount: 100n * COIN, payout: payout() });
  await q.clock.advance(400);
  assert.equal(q.controller.quoteError.code, 'amount_below_minimum');
  assert.equal(q.controller.minimumHintFiro, 300);
});

test('payout lists are kept ten minutes', async () => {
  const r = rig();
  await r.controller.payoutChains();
  await r.controller.payoutChains();
  await r.controller.payoutTokens(56);
  await r.controller.payoutTokens(56);
  await r.controller.payoutTokens(56, { symbol: 'usdt' });
  await r.controller.payoutTokens(56, { symbol: 'USDT' });
  assert.equal(r.server.count('/payout-chains'), 1);
  assert.equal(r.server.count('/payout-tokens'), 2);
  await r.clock.advance(10 * 60 * S);
  await r.controller.payoutChains();
  assert.equal(r.server.count('/payout-chains'), 2);
});

test('orders: paying privately asks for Spark; the sell is in the store before placeOrder returns', async () => {
  const r = rig();
  const o = await r.place();
  assert.equal(r.store.writes.length, 1);
  assert.equal(r.store.writes[0].orderId, o.orderId);
  const post = r.server.posts()[0].body;
  assert.equal(post.deposit_kind, 'spark');
  assert.equal(post.payout_address, PAYOUT);
  assert.equal(o.depositKind, 'spark');
  assert.equal(o.sparkDepositAddress, SPARK_DEPOSIT);
  assert.equal(o.fellBack, false);
  assert.equal(o.payFrom, 'private');
  assert.equal(o.lastState, 'awaiting_deposit');
  assert.equal(o.receiveUsd, 480);
  assert.equal(o.expiresAt, r.clock.now() + 24 * 3600 * S);
  assert.equal(o.payout.own, true);
  assert.deepEqual(r.controller.orders('w1').map((x) => x.orderId), [o.orderId]);
  assert.deepEqual(r.controller.orders('other'), []);
  const pub = rig();
  const t = await pub.place({ payFrom: 'public' });
  assert.equal(pub.server.posts()[0].body.deposit_kind, 'firo');
  assert.equal(t.sparkDepositAddress, null);
});

test('orders: Spark deposits off at buyfiro.app: the same sell to a transparent address, marked so the screen says it', async () => {
  const r = rig();
  r.server.sparkOff = true;
  const o = await r.place();
  const kinds = r.server.posts().map((p) => p.body.deposit_kind);
  assert.deepEqual(kinds, ['spark', 'firo']);
  assert.equal(o.depositKind, 'firo');
  assert.equal(o.fellBack, true);
  assert.equal(o.payFrom, 'private', 'still paid from the private balance, to a public address');
  assert.equal(o.sparkDepositAddress, null);
  assert.equal(o.depositAddress, T_DEPOSIT);
});

test('orders: a POST that got no answer is sent again as it was; still none: the error, and Try again sends it once more', async () => {
  const r = rig();
  r.server.queue('/order', new TypeError('Failed to fetch'));
  r.server.queue('/order', answer(403, '<html>Blocked</html>', { 'content-type': 'text/html' }));
  const o = await r.place();
  const posts = r.server.posts();
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((p) => JSON.stringify(p.body))).size, 1);
  assert.equal(o.orderId, [...r.server.orders.keys()][0]);
  const d = rig();
  d.server.offline = true;
  await assert.rejects(d.place(), (e) => e.code === 'network');
  assert.equal(d.server.count('/order'), 3);
  assert.equal(d.store.writes.length, 0);
  d.server.offline = false;
  await d.place();
  assert.equal(d.store.writes.length, 1);
});

test('orders: a second tap while the first is on its way gets the same sell, one request', async () => {
  const r = rig();
  const [a, b] = await Promise.all([r.place(), r.place()]);
  assert.equal(a, b);
  assert.equal(r.server.count('/order'), 1);
  // Asked again later for the same payout: buyfiro.app gives back the same order; what this device knows of it stays.
  await r.controller.markSending(a.orderId);
  const again = await r.place();
  assert.equal(again.orderId, a.orderId);
  assert.ok(again.sendStartedAt, 'never forgets that a payment started');
});

test('orders: refusals are not retried and nothing is kept; rate_limited carries its wait', async () => {
  const r = rig();
  r.server.queue('/order', answer(429, sellErrorJson('rate_limited', { retryAfter: 300 })));
  await assert.rejects(r.place(), (e) => e.code === 'rate_limited' && e.retryAfterMs === 300000);
  assert.equal(r.server.count('/order'), 1);
  await assert.rejects(r.place({ amount: 100n * COIN }), (e) => e.code === 'amount_below_minimum' && e.minimumFiro === 300);
  r.server.queue('/order', envelope({ order_id: 'sell_x', payable: true, deposit_address: 'bc1qnotfiro', spark_deposit_address: SPARK_DEPOSIT, deposit_kind: 'spark', amount_firo: 500, payout: { chain_id: 56, token: DEFAULT_PAYOUT.token, address: PAYOUT } }));
  await assert.rejects(r.place(), (e) => e.code === 'unexpected_answer');
  assert.equal(r.store.writes.length, 0);
  assert.deepEqual(r.controller.orders(), []);
});

test('orders: the store refusing the write: nothing is shown', async () => {
  const r = rig();
  r.store.failNext = 1;
  await assert.rejects(r.place(), /storage is full/);
  assert.deepEqual(r.controller.orders(), []);
});

test('paying: written down before the payment and after it; a failed first write stops the payment', async () => {
  const r = rig({ autoPoll: false });
  const o = await r.place();
  r.store.failNext = 1;
  await assert.rejects(r.controller.markSending(o.orderId), /storage is full/);
  assert.equal(r.controller.order(o.orderId).sendStartedAt, null);
  const started = await r.controller.markSending(o.orderId);
  assert.equal(started.sendStartedAt, r.clock.now());
  assert.equal(r.store.writes.at(-1).sendStartedAt, r.clock.now());
  // The second write fails: kept in memory (never offered again), written with the next change.
  r.store.failNext = 1;
  const sent = await r.controller.markSent(o.orderId, { txid: 'ab'.repeat(32), from: 'private' });
  assert.equal(sent.sentTxid, 'ab'.repeat(32));
  assert.equal(r.controller.order(o.orderId).sentTxid, 'ab'.repeat(32));
  assert.equal(r.store.writes.at(-1).sentTxid, null);
  await r.controller.poll(o.orderId);
  assert.equal(r.store.writes.at(-1).sentTxid, 'ab'.repeat(32), 'written with the next look, though nothing else changed');
});

test('samePayout: one destination whatever the letter case', () => {
  assert.equal(samePayout(payout(), payout({ address: PAYOUT.toLowerCase() })), true);
  assert.equal(samePayout(payout(), payout({ address: PAYOUT_2 })), false);
  assert.equal(samePayout(payout(), payout({ chainId: 1 })), false);
  assert.equal(samePayout(payout(), payout({ token: DEFAULT_PAYOUT.token.toLowerCase() })), true);
});

test('following: looked at every poll_after_seconds until it ends, never again after; delivered keeps the payout', async () => {
  const r = rig();
  const o = await r.place();
  const path = `/order/${o.orderId}`;
  await r.clock.advance(14 * S);
  assert.equal(r.server.count(path), 0);
  await r.clock.advance(1 * S);
  assert.equal(r.server.count(path), 1);
  r.server.state = 'selling';
  await r.clock.advance(15 * S);
  assert.equal(r.controller.order(o.orderId).lastState, 'selling');
  r.server.state = 'paying_out';
  await r.clock.advance(15 * S);
  r.server.state = 'delivered';
  r.server.payoutTxid = TXID;
  r.server.payoutExplorer = `https://bscscan.com/tx/${TXID}`;
  r.server.proceedsUsd = 479.51;
  await r.clock.advance(15 * S);
  const done = r.controller.order(o.orderId);
  assert.equal(done.lastState, 'delivered');
  assert.equal(done.terminal, true);
  assert.equal(done.payoutTxid, TXID);
  assert.equal(done.proceedsUsd, 479.51);
  assert.equal(r.controller.dueAt(o.orderId), null);
  const n = r.server.count(path);
  await r.clock.advance(3600 * S);
  assert.equal(r.server.count(path), n);
  assert.equal(r.clock.pending, 0);
});

test('following: attention and unknown states keep it followed; expired and refused end it', async () => {
  for (const [st, open] of [['attention', true], ['settling_in_v2', true], ['limit_open', true], ['expired', false], ['refused', false]]) {
    const r = rig();
    const o = await r.place();
    r.server.state = st;
    await r.clock.advance(15 * S);
    assert.equal(r.controller.order(o.orderId).isOpen, open, st);
  }
});

test('following: an answer about another payout is not this sell\'s, and is not kept', async () => {
  const r = rig({ autoPoll: false });
  const o = await r.place();
  r.server.queue(`/order/${o.orderId}`, envelope({ order_id: o.orderId, state: 'delivered', terminal: true, payout: { chain_id: 56, token: DEFAULT_PAYOUT.token, address: PAYOUT_2 } }));
  await r.controller.poll(o.orderId);
  assert.equal(r.controller.pollError(o.orderId).code, 'unexpected_answer');
  assert.equal(r.controller.order(o.orderId).lastState, 'awaiting_deposit');
});

test('following: no answer, looked at less often; retry_after honoured; back to normal once answered', async () => {
  const r = rig();
  const o = await r.place();
  const path = `/order/${o.orderId}`;
  r.server.offline = true;
  await r.clock.advance(15 * S);
  assert.equal(r.controller.pollError(o.orderId).code, 'network');
  assert.equal(r.controller.dueAt(o.orderId), r.clock.now() + 30 * S);
  await r.clock.advance(30 * S);
  assert.equal(r.controller.dueAt(o.orderId), r.clock.now() + 60 * S);
  r.server.offline = false;
  r.server.queue(path, answer(503, sellErrorJson('unavailable', { retryAfter: 600 })));
  await r.clock.advance(60 * S);
  assert.equal(r.controller.dueAt(o.orderId), r.clock.now() + 600 * S);
  await r.clock.advance(600 * S);
  assert.equal(r.controller.pollError(o.orderId), null);
  assert.equal(r.controller.dueAt(o.orderId), r.clock.now() + 15 * S);
});

test('following: the open sells kept on this device are followed on start; ended ones are not; pause and dispose stop it', async () => {
  const store = memorySellStore();
  await store.save(stored('sell_open1', { state: 'selling' }));
  await store.save(stored('sell_done1', { state: 'delivered' }));
  const r = rig({ store });
  r.server.orders.set('sell_open1', { id: 'sell_open1', body: { payout_chain_id: 56, payout_token: DEFAULT_PAYOUT.token, payout_address: PAYOUT, amount_firo: 500 }, sandbox: false });
  r.server.states.set('sell_open1', 'paying_out');
  await r.controller.resumeAll();
  await r.clock.advance(0);
  assert.equal(r.server.count('/order/sell_open1'), 1);
  assert.equal(r.server.count('/order/sell_done1'), 0);
  assert.equal(r.controller.order('sell_open1').lastState, 'paying_out');
  assert.equal(store.writes.at(-1).lastState, 'paying_out');
  await r.controller.resumeAll();
  await r.clock.advance(0);
  assert.equal(r.server.count('/order/sell_open1'), 1, 'starting twice follows them once');
  r.controller.pause();
  await r.clock.advance(300 * S);
  assert.equal(r.server.count('/order/sell_open1'), 1);
  r.controller.resume();
  await r.clock.advance(0);
  assert.equal(r.server.count('/order/sell_open1'), 2);
  let told = 0;
  r.controller.onChange(() => told++);
  r.controller.dispose();
  await r.clock.advance(3600 * S);
  assert.equal(r.server.count('/order/sell_open1'), 2);
  assert.equal(told, 0);
});

test('sandbox: a forced-state lifecycle through the controller, every request in test mode', async () => {
  const r = rig({ sandbox: true, autoPoll: false });
  r.server.sandboxOnly = true;
  r.server.refuseOutOfLimits = false;
  await r.controller.refreshLimits(payout());
  const o = await r.place();
  assert.match(o.orderId, /^sbx_/);
  assert.equal(o.sandbox, true);
  assert.equal(o.payable, false);
  for (const st of ['deposit_detected', 'selling', 'paying_out', 'delivered']) {
    r.server.states.set(o.orderId, st);
    await r.controller.poll(o.orderId);
    assert.equal(r.controller.order(o.orderId).lastState, st);
  }
  assert.equal(r.controller.order(o.orderId).payoutTxid, '0xsbx_payout_txid');
  assert.deepEqual(r.server.violations, []);
});

// ------------------------------------------------- FM-2: a look in flight never erases a payment

/** A rig whose GET /order/{id} answers wait until release() (buyfiro.app slow, as it can be). */
function heldRig() {
  const r = rig({ autoPoll: false });
  let release = null;
  let gate = null;
  const original = r.server.fetch;
  const fetch = async (url, init = {}) => {
    if (gate && (init.method || 'GET') === 'GET' && /\/order\//.test(new URL(url).pathname)) await gate;
    return original(url, init);
  };
  r.controller.client = new SellClient({ fetch: fetch, classifyAddress: classify });
  r.hold = () => (gate = new Promise((res) => (release = res)));
  r.release = () => release();
  return r;
}

test('FM-2: a look in flight while the payment starts keeps "a payment started", in memory and on disk', async () => {
  const r = heldRig();
  const o = await r.place();
  r.hold();
  const polling = r.controller.poll(o.orderId); // the screen's "where is it now" on open
  await drain();
  const started = await r.controller.markSending(o.orderId);
  assert.ok(started.sendStartedAt);
  r.release();
  await polling;
  assert.equal(r.controller.order(o.orderId).sendStartedAt, started.sendStartedAt, 'kept in memory: never offered again without a warning');
  assert.equal(r.store.writes.at(-1).sendStartedAt, started.sendStartedAt, 'and on disk');
});

test('FM-2: a look whose state changed keeps this wallet\'s payment (sentTxid) and takes the new state', async () => {
  const r = heldRig();
  const o = await r.place();
  r.server.states.set(o.orderId, 'deposit_detected');
  r.hold();
  const polling = r.controller.poll(o.orderId);
  await drain();
  await r.controller.markSending(o.orderId);
  await r.controller.markSent(o.orderId, { txid: 'ab'.repeat(32), from: 'private' });
  r.release();
  await polling;
  const last = r.store.writes.at(-1);
  assert.equal(last.lastState, 'deposit_detected', "buyfiro.app's answer is taken");
  assert.equal(last.sentTxid, 'ab'.repeat(32), "this wallet's payment stays on disk");
  assert.ok(last.sendStartedAt);
  assert.equal(r.controller.order(o.orderId).sentTxid, 'ab'.repeat(32), 'and in memory');
  assert.equal(r.controller.order(o.orderId).lastState, 'deposit_detected');
});

test('FM-2: a payment whose write failed during a look is written by that look, and stays to write until it is', async () => {
  const r = heldRig();
  const o = await r.place();
  r.hold();
  const polling = r.controller.poll(o.orderId);
  await drain();
  await r.controller.markSending(o.orderId);
  r.store.failNext = 1;
  await r.controller.markSent(o.orderId, { txid: 'cd'.repeat(32), from: 'private' });
  assert.equal(r.controller.order(o.orderId).sentTxid, 'cd'.repeat(32), 'kept in memory for the next write');
  r.release();
  await polling;
  const last = r.store.writes.at(-1);
  assert.equal(last.sentTxid, 'cd'.repeat(32), 'the next write is the current record');
  assert.equal(r.controller.order(o.orderId).sentTxid, 'cd'.repeat(32));
  assert.equal(r.controller._unsaved.has(o.orderId), false, 'written');
});

test('FM-2: a write that lands after a newer change does not count the newer one as written', async () => {
  const r = rig({ autoPoll: false });
  const o = await r.place();
  await r.controller.markSending(o.orderId);
  // The store is slow: the look's write is still on its way when the payment is recorded, and that write fails.
  let finish;
  const slow = new Promise((res) => (finish = res));
  const save = r.store.save.bind(r.store);
  let first = true;
  r.store.save = async (x) => {
    if (first) {
      first = false;
      await slow;
    }
    return save(x);
  };
  r.server.states.set(o.orderId, 'deposit_detected');
  const polling = r.controller.poll(o.orderId);
  await drain();
  r.store.failNext = 1;
  await r.controller.markSent(o.orderId, { txid: 'ef'.repeat(32), from: 'private' });
  assert.equal(r.controller._unsaved.has(o.orderId), true);
  finish();
  await polling;
  assert.equal(r.controller._unsaved.has(o.orderId), true, 'the payment is still to be written');
  await r.controller.poll(o.orderId);
  assert.equal(r.store.writes.at(-1).sentTxid, 'ef'.repeat(32));
  assert.equal(r.controller._unsaved.has(o.orderId), false);
});

test('X4: buyfiro.app gives back an open sell that another wallet (or device) made for this payout: refused, never paid from here', async () => {
  const r = rig();
  const a = await r.place({ walletId: 'w1' });
  // A second wallet on this device asks for the same payout: buyfiro.app answers the same order, reused.
  await assert.rejects(r.place({ walletId: 'w2' }), (e) => e.code === 'order_exists' && e.elsewhere === true && e.orderId === a.orderId);
  // The wallet that made it gets it back as before.
  const again = await r.place({ walletId: 'w1' });
  assert.equal(again.orderId, a.orderId);
});

test('X4: every way in is refused at the mark: paid elsewhere by the person\'s word, or a payment already started (unless the person retries)', async () => {
  const r = rig();
  const a = await r.place();
  await r.controller.markSending(a.orderId);
  await assert.rejects(r.controller.markSending(a.orderId), (e) => e.code === 'paid');
  // The person looked in Activity and found nothing: their retry may mark it again.
  await r.controller.markSending(a.orderId, { retry: true });
  const b = await r.place({ payout: { ...payout(), address: `0x${'44'.repeat(20)}` } });
  await r.controller.markPaidElsewhere(b.orderId);
  await assert.rejects(r.controller.markSending(b.orderId, { retry: true }), (e) => e.code === 'paid' && /another wallet/.test(e.message));
});

test('X4: "I paid it from another wallet" after this wallet\'s own payment started is kept, not ignored', async () => {
  const r = rig();
  const a = await r.place();
  await r.controller.markSending(a.orderId);
  const o = await r.controller.markPaidElsewhere(a.orderId);
  assert.ok(o.paidElsewhereAt, 'recorded');
  assert.ok(o.sendStartedAt, 'the own payment is not forgotten');
});
