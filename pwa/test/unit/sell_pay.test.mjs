// Paying a sell (lib/sell/pay.js) and what a failed Firo payment means (lib/send_outcome.js),
// over the real SellController and a stand-in wallet whose send() fails as the engine does:
// a refusal before anything was broadcast, bytes that never reached a node ('offline') or a
// node's error answer ('server'): not sent, the sell may be paid again; no answer after it
// reached a node ('unsure', with its txid): it may have left, kept with the sell and never
// offered again until the engine says the network does not have it (Tx.dropped); anything else
// (an error with no code): "a payment started", look in Activity first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SellController } from '../../src/lib/sell/controller.js';
import { SellClient, DEFAULT_PAYOUT } from '../../src/lib/sell/sellfiro.js';
import { memorySellStore } from '../../src/lib/sell/store.js';
import { sendSellPayment, unsureState, settleUnsure } from '../../src/lib/sell/pay.js';
import { paymentInWallet } from '../../src/lib/sell/wiring.js';
import { sendOutcome, followVerdict, UNSURE_TITLE } from '../../src/lib/send_outcome.js';
import { FakeSellFiro, FakeClock, classify, PAYOUT, SPARK_DEPOSIT } from './sell_fakes.mjs';

const COIN = 100000000n;
const TXID = 'ab'.repeat(32);
const err = (code, extra = {}) => Object.assign(new Error(`words for ${code}.`), { code }, extra);

function rig() {
  const server = new FakeSellFiro();
  const clock = new FakeClock();
  const store = memorySellStore();
  const c = new SellController({ client: new SellClient({ fetch: server.fetch, classifyAddress: classify }), store, clock, autoPoll: false });
  return { server, clock, store, c, place: () => c.placeOrder({ amount: 500n * COIN, payout: { ...DEFAULT_PAYOUT, address: PAYOUT, own: true }, payFrom: 'private', walletId: 'w1' }) };
}

/** A stand-in wallet: its state as lib/wallet.js keeps it, and a send that answers or fails as told. */
function wallet({ fail = null, tip = 1000 } = {}) {
  const w = {
    sent: [],
    state: { tip: { height: tip }, txs: [], txsLoaded: true, sync: { canSend: true } },
    async send(req) {
      w.sent.push(req);
      if (fail) throw fail;
      return { txid: TXID };
    },
  };
  return w;
}

const pay = (r, w) => sendSellPayment({ c: r.c, w, orderId: r.id, from: 'private', to: [{ address: SPARK_DEPOSIT, amount: 500n * COIN }] });

async function placed() {
  const r = rig();
  r.id = (await r.place()).orderId;
  return r;
}

test('outcome: refusals before anything is broadcast, bytes that reached no node, and a node\'s answer, are "not sent"; no answer is "unsure" with its txid; the rest cannot be told', () => {
  for (const code of ['offline', 'server', 'insufficient', 'invalid-address', 'dust', 'not-synced', 'not-open', 'view-only', 'invalid', 'invalid-memo']) assert.equal(sendOutcome(err(code)).kind, 'not-sent', code);
  assert.deepEqual(sendOutcome(err('unsure', { txid: TXID.toUpperCase() })), { kind: 'unsure', txid: TXID, otherServer: false });
  assert.equal(sendOutcome(err('unsure')).kind, 'unknown', 'an unsure payment without a txid cannot be followed');
  assert.equal(sendOutcome(new Error('a library failed')).kind, 'unknown');
  assert.equal(sendOutcome(null).kind, 'unknown');
  assert.equal(UNSURE_TITLE, "Your payment may have left. Don't send it again yet: Campfire is checking.");
});

test('FM-1: an error the engine does not name is not "nothing left your wallet": the sell keeps "a payment started" and is not offered again', async () => {
  const r = await placed();
  const out = await pay(r, wallet({ fail: new TypeError('something broke after the bytes were built') }));
  assert.equal(out.kind, 'unknown');
  const o = r.c.order(r.id);
  assert.ok(o.sendStartedAt, 'still marked: the screen says to look in Activity first');
  assert.equal(r.store.writes.at(-1).sendStartedAt, o.sendStartedAt);
});

test('FM-1: no answer to the broadcast: the txid and the block are kept with the sell, on disk; nothing is offered again', async () => {
  const r = await placed();
  const out = await pay(r, wallet({ fail: err('unsure', { txid: TXID }), tip: 1234 }));
  assert.deepEqual(out.kind, 'unsure');
  assert.equal(out.txid, TXID);
  const o = r.c.order(r.id);
  assert.equal(o.unsureTxid, TXID);
  assert.equal(o.unsureHeight, 1234);
  assert.equal(o.sentFrom, 'private');
  assert.ok(o.sendStartedAt);
  assert.equal(o.sentTxid, null, 'not "paid" either: it may not have left');
  assert.equal(r.store.writes.at(-1).unsureTxid, TXID, 'sealed with the sell');
  // A refusal of a later attempt never clears a payment that may have left.
  await r.c.markNotSent(r.id);
  assert.equal(r.c.order(r.id).unsureTxid, TXID);
});

test('FM-1: refused before it left, never reached a node, or refused by the node: nothing left, the sell may be paid again', async () => {
  for (const code of ['insufficient', 'offline', 'server']) {
    const r = await placed();
    const out = await pay(r, wallet({ fail: err(code) }));
    assert.equal(out.kind, 'not-sent', code);
    assert.equal(r.c.order(r.id).sendStartedAt, null, code);
  }
});

test('paid: the txid is kept; the mark could not be written: nothing is sent', async () => {
  const r = await placed();
  const w = wallet();
  assert.deepEqual(await pay(r, w), { kind: 'sent', txid: TXID });
  assert.equal(r.c.order(r.id).sentTxid, TXID);
  const r2 = await placed();
  const w2 = wallet();
  r2.store.failNext = 1;
  assert.equal((await pay(r2, w2)).kind, 'not-noted');
  assert.equal(w2.sent.length, 0, 'never sent without the mark');
});

test('following a payment that may have left: in a block is paid; on its way, unsure or not listed is checking; only the engine\'s "dropped" lets it go', () => {
  const w = wallet();
  const u = { txid: TXID };
  assert.equal(followVerdict(u, w), 'checking', 'not in the payments: never decided from an absence');
  w.state.txs = [{ txid: TXID, confirmations: 0, unsure: true }];
  assert.equal(followVerdict(u, w), 'checking');
  w.state.txs = [{ txid: TXID, confirmations: 0 }];
  assert.equal(followVerdict(u, w), 'checking', 'on its way');
  w.state.txs = [{ txid: TXID, confirmations: 1 }];
  assert.equal(followVerdict(u, w), 'left');
  w.state.txs = [{ txid: TXID, confirmations: 0, dropped: true }];
  assert.equal(followVerdict(u, w), 'gone', 'the network does not have it');
  assert.equal(followVerdict({ txid: null }, w), 'checking');
});

test('settling a sell\'s payment: unsure and in a block is paid; dropped (unsure, or taken by the node) is payable again; on its way changes nothing', async () => {
  const r = await placed();
  const w = wallet({ fail: err('unsure', { txid: TXID }) });
  await pay(r, w);
  assert.equal(await settleUnsure(r.c, r.id, w), 'checking');
  assert.equal(r.c.order(r.id).unsureTxid, TXID);
  w.state.txs = [{ txid: TXID, confirmations: 2 }];
  assert.equal(unsureState(r.c.order(r.id), w), 'left');
  assert.equal(await settleUnsure(r.c, r.id, w), 'left');
  assert.equal(r.c.order(r.id).sentTxid, TXID, 'paid');
  assert.equal(r.c.order(r.id).unsureTxid, null);
  assert.equal(unsureState(r.c.order(r.id), w), null);

  const r2 = await placed();
  const w2 = wallet({ fail: err('unsure', { txid: TXID }) });
  await pay(r2, w2);
  w2.state.txs = [{ txid: TXID, confirmations: 0, dropped: true, direction: 'out', counterparty: SPARK_DEPOSIT }];
  assert.equal(await settleUnsure(r2.c, r2.id, w2), 'gone');
  const o = r2.c.order(r2.id);
  assert.equal(o.unsureTxid, null);
  assert.equal(o.sendStartedAt, null, 'the sell may be paid again');
  assert.equal(o.sentTxid, null);

  // Taken by the node, then the network does not have it after all: not paid, payable again.
  const r3 = await placed();
  const w3 = wallet();
  await pay(r3, w3);
  assert.equal(r3.c.order(r3.id).sentTxid, TXID);
  w3.state.txs = [{ txid: TXID, confirmations: 0, direction: 'out', counterparty: SPARK_DEPOSIT }];
  assert.equal(unsureState(r3.c.order(r3.id), w3), null, 'on its way: nothing to settle');
  assert.equal(paymentInWallet(r3.c.order(r3.id), w3).txid, TXID);
  w3.state.txs = [{ txid: TXID, confirmations: 0, dropped: true, direction: 'out', counterparty: SPARK_DEPOSIT }];
  assert.equal(paymentInWallet(r3.c.order(r3.id), w3), null, 'a dropped payment is not paid, by txid or by address');
  assert.equal(paymentInWallet({ ...r3.c.order(r3.id), sentTxid: null }, w3), null);
  assert.equal(await settleUnsure(r3.c, r3.id, w3), 'gone');
  assert.equal(r3.c.order(r3.id).sentTxid, null);
  assert.equal(r3.c.order(r3.id).sendStartedAt, null);
  // markDropped names the payment: another txid changes nothing.
  const r4 = await placed();
  await pay(r4, wallet({ fail: err('unsure', { txid: TXID }) }));
  await r4.c.markDropped(r4.id, { txid: 'cd'.repeat(32) });
  assert.equal(r4.c.order(r4.id).unsureTxid, TXID);
});

// ------------------------------------------- FM-3: a last look at the sell right before paying

import { paySell, payGate, expiryReason, PAY_MARGIN_MS, LOOK_TIMEOUT_MS, LOOK_FRESH_MS } from '../../src/lib/sell/pay.js';
import { drain } from './sell_fakes.mjs';

const FEE = 20000n;
/** The stand-in wallet with quote(): what leaves (amount + fee). */
function quoting(w, { fee = FEE } = {}) {
  w.quotes = 0;
  w.quote = async ({ to }) => {
    w.quotes++;
    return { fee, total: to[0].amount + fee, change: 0n, warnings: [] };
  };
  return w;
}
const REVIEWED = 500n * COIN + FEE;
const go = (r, w, over = {}) => paySell({ c: r.c, w, orderId: r.id, from: 'private', to: [{ address: SPARK_DEPOSIT, amount: 500n * COIN }], reviewedTotal: REVIEWED, confirm: async () => true, clock: r.clock, ...over });

test('FM-3: buyfiro.app is asked right before paying; a sell it expired or refused meanwhile is never paid', async () => {
  for (const state of ['expired', 'refused', 'deposit_detected']) {
    const r = await placed();
    const w = quoting(wallet());
    r.server.states.set(r.id, state);
    const out = await go(r, w);
    assert.equal(out.kind, 'refused', state);
    assert.equal(out.code, 'moved', state);
    assert.equal(w.sent.length, 0, `${state}: nothing sent`);
    assert.equal(r.c.order(r.id).sendStartedAt, null, `${state}: nothing marked`);
  }
});

test('FM-3: no answer from buyfiro.app within the wait: not paid on an old look', async () => {
  const r = await placed();
  const w = quoting(wallet());
  r.server.offline = true;
  const out = await go(r, w);
  assert.equal(out.kind, 'refused');
  assert.equal(out.code, 'unreachable');
  assert.match(out.text, /couldn't reach buyfiro\.app .* so nothing was sent/);
  assert.equal(w.sent.length, 0);
  // A look that never answers: the wait ends, and nothing is sent.
  const r2 = await placed();
  const w2 = quoting(wallet());
  r2.server.queue(`/order/${r2.id}`, { __never: true });
  const pending = go(r2, w2);
  await drain();
  await r2.clock.advance(LOOK_TIMEOUT_MS);
  const out2 = await pending;
  assert.equal(out2.code, 'unreachable');
  assert.equal(w2.sent.length, 0);
});

test('FM-3: a deadline passed or less than 10 minutes away: not paid', async () => {
  const r = await placed();
  const w = quoting(wallet());
  const o = r.c.order(r.id);
  assert.ok(o.expiresAt > r.clock.now() + PAY_MARGIN_MS, 'a new sell has a day');
  await r.clock.advance(o.expiresAt - r.clock.now() - PAY_MARGIN_MS);
  const out = await go(r, w);
  assert.equal(out.code, 'expiring');
  assert.match(out.text, /^buyfiro\.app takes FIRO for this sell only until \d\d:\d\d( today| on \d+ \w+), too soon for a payment to reach it in time\. Nothing was sent\./);
  assert.equal(w.sent.length, 0);
  assert.match(expiryReason(o, o.expiresAt + 1), /^buyfiro\.app took FIRO for this sell until/);
  assert.equal(expiryReason(o, o.expiresAt - PAY_MARGIN_MS - 1), null);
  assert.equal(payGate(o, { answered: true, now: o.expiresAt - PAY_MARGIN_MS - 1 }), null);
});

test('FM-3: the sell is read again after the confirmation: moved meanwhile, not paid; a long wait looks again', async () => {
  const r = await placed();
  const w = quoting(wallet());
  // While the password prompt is open, a look learns buyfiro.app expired it.
  const out = await go(r, w, {
    confirm: async () => {
      r.server.states.set(r.id, 'expired');
      await r.c.poll(r.id);
      return true;
    },
  });
  assert.equal(out.code, 'moved');
  assert.equal(w.sent.length, 0);

  const r2 = await placed();
  const w2 = quoting(wallet());
  const looks = () => r2.server.count(`/order/${r2.id}`);
  const out2 = await go(r2, w2, {
    confirm: async () => {
      await r2.clock.advance(LOOK_FRESH_MS + 1); // a slow password
      r2.server.states.set(r2.id, 'refused');
      return true;
    },
  });
  assert.equal(looks(), 2, 'looked again after the long wait');
  assert.equal(out2.code, 'moved');
  assert.equal(w2.sent.length, 0);
});

test('FM-3: what leaves is quoted again; a change is shown, never sent; the reviewed figures go to the engine', async () => {
  const r = await placed();
  const w = quoting(wallet(), { fee: FEE + 1n });
  const out = await go(r, w);
  assert.equal(out.kind, 'changed');
  assert.equal(out.quote.total, REVIEWED + 1n);
  assert.equal(r.server.count(`/order/${r.id}`), 0, 'nothing asked before the figures hold');

  const r2 = await placed();
  const w2 = quoting(wallet());
  const ok = await go(r2, w2);
  assert.equal(ok.kind, 'sent');
  assert.deepEqual(w2.sent[0].expect, { fee: FEE, total: REVIEWED }, 'the engine refuses any other figures');
  // The engine's "the figures changed": nothing was signed, the sell may be paid again.
  const r3 = await placed();
  const w3 = quoting(wallet({ fail: err('fee-changed') }));
  const out3 = await go(r3, w3);
  assert.equal(out3.kind, 'not-sent');
  assert.equal(out3.error.code, 'fee-changed');
  assert.equal(r3.c.order(r3.id).sendStartedAt, null);
});

test('FM-3: cancelled at the password: nothing marked; a sell started elsewhere meanwhile is not paid twice', async () => {
  const r = await placed();
  const w = quoting(wallet());
  assert.equal((await go(r, w, { confirm: async () => false })).kind, 'cancelled');
  assert.equal(r.c.order(r.id).sendStartedAt, null);
  const out = await go(r, w, {
    confirm: async () => {
      await r.c.markSending(r.id); // another way in started paying it meanwhile
      return true;
    },
  });
  assert.equal(out.code, 'paid');
  assert.equal(w.sent.length, 0);
  // The person looked in Activity after an interrupted start and found nothing: paid once.
  const again = await go(r, w, { retry: true });
  assert.equal(again.kind, 'sent');
  assert.equal(w.sent.length, 1);
});

// ------------------------------------------- FM-7: refusals before anything is built are "not sent"

test('FM-7: the private coin list check, a bad amount, a feature not there, the own node: not sent, payable again, "Try another node" when it helps', async () => {
  for (const [code, other] of [['set-mismatch', true], ['set-disagree', true], ['set-unchecked', false], ['invalid-amount', false], ['NotYet', false], ['own-node', false]]) {
    assert.equal(sendOutcome(err(code, { otherServer: other })).kind, 'not-sent', code);
    const r = await placed();
    const out = await pay(r, wallet({ fail: err(code, { otherServer: other }) }));
    assert.equal(out.kind, 'not-sent', code);
    assert.equal(out.otherServer, other, `${code}: another node can help`);
    assert.equal(r.c.order(r.id).sendStartedAt, null, `${code}: not "a payment started"`);
  }
});

// ------------------------------------------- FM-10: "I paid it from another wallet"

test('FM-10: a sell the person paid from another wallet is never paid from this one; the mark can be undone until this wallet pays', async () => {
  const r = await placed();
  const w = quoting(wallet());
  const marked = await r.c.markPaidElsewhere(r.id);
  assert.ok(marked.paidElsewhereAt);
  assert.ok(marked.sendStartedAt, 'the started mark: every guard against a second payment holds');
  assert.equal(r.store.writes.at(-1).paidElsewhereAt, marked.paidElsewhereAt, 'kept on disk');
  const out = await go(r, w);
  assert.equal(out.code, 'paid');
  assert.equal(w.sent.length, 0, 'the in-app button cannot pay it again');
  // A mistap: undone, payable again.
  const undone = await r.c.unmarkPaidElsewhere(r.id);
  assert.equal(undone.paidElsewhereAt, null);
  assert.equal(undone.sendStartedAt, null);
  assert.equal((await go(r, w)).kind, 'sent');
  // Never undone once this wallet's own payment is on record.
  await r.c.markPaidElsewhere(r.id);
  assert.equal((await r.c.unmarkPaidElsewhere(r.id)).sentTxid, TXID);
  assert.ok(r.c.order(r.id).sendStartedAt);
});

// ------------------------------------------- R-9: the undo is reachable from the Sell form too

test('R-9: a new sell to that payout refused because of a mistaken "I paid it from another wallet": the form says why and offers the undo, which makes that sell payable here again', async () => {
  const { problemText } = await import('../../src/lib/sell/words.js');
  const r = await placed();
  const w = quoting(wallet());
  await r.c.markPaidElsewhere(r.id);
  // Another amount to the same payout: buyfiro.app keeps one unpaid sell per payout address.
  const e = await r.c.placeOrder({ amount: 600n * COIN, payout: { ...DEFAULT_PAYOUT, address: PAYOUT, own: true }, payFrom: 'private', walletId: 'w1' }).catch((x) => x);
  assert.equal(e.code, 'order_exists');
  assert.equal(e.orderId, r.id, 'the sell marked as paid elsewhere');
  const known = r.c.order(e.orderId);
  assert.equal(r.c.canUnmarkPaidElsewhere(known), true);
  const p = problemText(e, { payout: DEFAULT_PAYOUT, markedElsewhere: true });
  assert.equal(p.fix, 'undoPaidElsewhere');
  assert.equal(p.fixLabel, "I haven't paid it: undo");
  assert.match(p.title, /^You marked your open sell to this address \(500 FIRO\) as paid from another wallet$/);
  assert.match(p.detail, /Nothing was sent\.$/);
  assert.equal(problemText(e, { payout: DEFAULT_PAYOUT }).fix, 'openExisting', 'without the mark: the plain words');
  // What the form's button does: undo, then that sell is paid from this wallet once.
  await r.c.unmarkPaidElsewhere(e.orderId);
  assert.equal(r.c.order(r.id).paidElsewhereAt, null);
  assert.equal((await go(r, w)).kind, 'sent');
  assert.equal(w.sent.length, 1);
  // Never offered over this wallet's own payment, started, sent or in doubt.
  assert.equal(r.c.canUnmarkPaidElsewhere(r.c.order(r.id)), false, 'paid from this wallet');
  const r2 = await placed();
  await r2.c.markPaidElsewhere(r2.id);
  for (const over of [{ sentTxid: TXID }, { unsureTxid: TXID }, { sendStartedAt: 1 }]) assert.equal(r2.c.canUnmarkPaidElsewhere({ ...r2.c.order(r2.id), ...over }), false, JSON.stringify(over));
  assert.equal(r2.c.canUnmarkPaidElsewhere(null), false);
});
