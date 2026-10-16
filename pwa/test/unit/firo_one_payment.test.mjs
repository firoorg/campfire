// One Firo payment from one intent (release verification 0.1.8, findings 1 and the Names / Privatize
// should-fixes): Review, Send, Privatize and Get a Spark name on a stand-in DOM, with the wallet
// and the password sheet replaced by scripted ones (helpers/stand_ins/). Before: a Review left
// during its fee check still opened the password over the next screen and sent; Back during
// "Sending…" offered Review again and a second payment went; a second Privatize or registration
// went the same way; a finished run took the person to its status screen wherever they were.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

const SCREENS = ['/src/screens/review.js', '/src/screens/send.js', '/src/screens/privatize.js', '/src/screens/name_register.js'];
redirect([
  { parents: SCREENS, spec: '../lib/wallet.js', to: standIn('wallet') },
  { parents: SCREENS, spec: '../lib/auth_ui.js', to: standIn('auth_ui') },
  { parents: ['/src/screens/review.js'], spec: '../lib/contacts.js', to: standIn('contacts') },
  { parents: ['/src/screens/send.js'], spec: './send_extras.js', to: standIn('send_extras') },
]);

const { wallet, reset } = await import('./helpers/stand_ins/wallet.mjs');
const auth = await import('./helpers/stand_ins/auth_ui.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { default: review } = await import('../../src/screens/review.js');
const { SHEET_SETTLE_MS } = await import('../../src/lib/ui.js');
const { default: send } = await import('../../src/screens/send.js');
const { default: privatize } = await import('../../src/screens/privatize.js');
const { default: nameRegister } = await import('../../src/screens/name_register.js');
const { paymentInFlight, IN_FLIGHT_TEXT } = await import('../../src/lib/payment_flight.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}
const TO = 'sm1receiver';
const QUOTE = { fee: 1000n, total: 100001000n, change: 0n, warnings: [] };
const P = { address: TO, amount: 100000000n, from: 'private', kind: 'spark', subtractFee: false, memo: '', quote: QUOTE };
const toasts = () => document.querySelectorAll('.toast').map((t) => t.textContent);

/** A wallet whose quote and send take as long as told, every send recorded; and an app over the four screens. */
function rig({ quoteMs = 0, sendMs = 0, sendFails = null } = {}) {
  auth.sheets.length = 0;
  for (const t of document.querySelectorAll('.toast')) t.remove();
  const sends = [];
  reset({
    quote: async () => {
      await sleep(quoteMs);
      return { ...QUOTE };
    },
    send: async (req) => {
      sends.push(req);
      await sleep(sendMs);
      if (sendFails) throw sendFails;
      return { txid: 'ab'.repeat(32) };
    },
    privatize: async () => {
      sends.push('privatize');
      await sleep(sendMs);
      return { txid: 'cd'.repeat(32) };
    },
    registerName: async (r) => {
      sends.push(r);
      await sleep(sendMs);
      return { txid: 'ef'.repeat(32) };
    },
  });
  const app = makeApp({ review, send, privatize, nameRegister });
  return { app, sends };
}
const cta = (app) => one('confirm-send', app.current.el);
const settled = () => sleep(SHEET_SETTLE_MS + 30);

test('Review: a double tap on Send asks once and sends once', async () => {
  const { app, sends } = rig({ quoteMs: 20, sendMs: 20 });
  app.go('review', { ...P });
  await settled();
  cta(app).tap();
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  await sleep(30);
  assert.equal(auth.sheets.length, 1);
  auth.answer(0);
  await until(() => app.currentName === 'txStatus', 'the status screen');
  assert.equal(sends.length, 1);
});

test('Review: the first moments after it opens, a tap on Send starts nothing (the second half of a double tap on "Review payment" lands on it)', async () => {
  const { app } = rig();
  app.go('review', { ...P });
  assert.equal(app.current.el.getAttribute('aria-busy'), 'true');
  await sleep(0);
  assert.equal(cta(app).getAttribute('aria-disabled'), 'true');
  await cta(app).tap();
  await sleep(20);
  assert.equal(auth.sheets.length, 0);
  await settled();
  assert.equal(app.current.el.getAttribute('aria-busy'), null);
  assert.equal(cta(app).getAttribute('aria-disabled'), null);
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
});

test('Review left during the fee check: no password sheet over the next screen, nothing sent', async () => {
  const { app, sends } = rig({ quoteMs: 150 });
  app.go('review', { ...P });
  await settled();
  cta(app).tap();
  await sleep(20);
  app.go('send');
  app.go('home');
  await sleep(250);
  assert.equal(auth.sheets.length, 0, 'no password sheet opened over Home');
  assert.equal(sends.length, 0);
});

test('Review: Change during the fee check, Review again, Send: one password sheet, one payment', async () => {
  const { app, sends } = rig({ quoteMs: 150, sendMs: 10 });
  app.go('review', { ...P });
  await settled();
  cta(app).tap();
  await sleep(20);
  app.back('send');
  app.go('review', { ...P });
  await settled();
  cta(app).tap();
  await sleep(300);
  assert.equal(auth.sheets.length, 1, `sheets: ${auth.sheets.map((s) => s.over)}`);
  auth.answer(0);
  await until(() => app.currentName === 'txStatus', 'the status screen');
  assert.equal(sends.length, 1);
});

test('Back during "Sending…": Send and Review offer nothing until it has left; then no screen is forced on the person and the form is cleared', async () => {
  const { app, sends } = rig({ sendMs: 1500 });
  app.sendDraft = { address: TO, amount: '1', memo: '', from: 'private', subtractFee: false };
  app.go('review', { ...P });
  await settled();
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  assert.equal(cta(app).textContent, 'Sending…');
  // Back to Send: the same form, its button off and saying why.
  app.back('send');
  await sleep(300); // the form's fee is asked for
  assert.ok(paymentInFlight());
  assert.equal(one('review', app.current.el).disabled, true);
  assert.ok(one('send-in-flight', app.current.el), 'Send says a payment is still being sent');
  // Review opened again anyway (a test hook, a link): its Send is off and says why.
  app.go('review', { ...P });
  await settled();
  assert.equal(cta(app).disabled, true);
  assert.equal(cta(app).textContent, IN_FLIGHT_TEXT);
  await cta(app).tap();
  assert.equal(auth.sheets.length, 1, 'no second password sheet');
  // Back on Send when the first payment leaves.
  app.back('send');
  const draftShown = app.sendDraft;
  await until(() => !paymentInFlight(), 'the first payment to end');
  await sleep(10);
  assert.equal(sends.length, 1, 'one payment');
  assert.ok(!app.moves.includes('txStatus'), `moves: ${app.moves}`);
  assert.equal(app.currentName, 'send', 'the person stays where they are');
  assert.notEqual(app.sendDraft, draftShown, 'the paid form is not offered again');
  assert.equal(app.sendDraft.address, '');
  assert.match(toasts().join(' '), /^Sent \S+ FIRO to .*It is in Activity\.$/);
});

test('Review left after the password while it sends, payment refused: said where the person is; the form stays', async () => {
  const refused = Object.assign(new Error('The server refused: bad-txns.'), { code: 'server' });
  const { app, sends } = rig({ sendMs: 100, sendFails: refused });
  const draft = (app.sendDraft = { address: TO, amount: '1', memo: '', from: 'private', subtractFee: false });
  app.go('review', { ...P });
  await settled();
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  app.go('home');
  await until(() => !paymentInFlight(), 'the payment to end');
  assert.equal(app.currentName, 'home');
  assert.match(toasts().join(' '), /The payment was not sent: The server refused: bad-txns\. Nothing left your wallet\./);
  assert.equal(app.sendDraft, draft, 'nothing left: the form is kept');
});

test('Privatize: a second one, opened while the first is being sent, offers nothing; the first never pulls the person to its status screen', async () => {
  const { app, sends } = rig({ sendMs: 300 });
  app.go('privatize');
  await sleep(10);
  await one('privatize-confirm', app.current.el).tap();
  assert.equal(auth.sheets.length, 0, 'the second tap of a double tap on Home is held');
  await settled();
  one('privatize-confirm', app.current.el).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'privatizing');
  app.go('home');
  app.go('privatize');
  await sleep(10);
  const again = one('privatize-confirm', app.current.el);
  assert.equal(again.disabled, true);
  assert.equal(again.textContent, IN_FLIGHT_TEXT);
  assert.ok(one('privatize-in-flight', app.current.el));
  await again.click();
  assert.equal(auth.sheets.length, 1);
  await until(() => !paymentInFlight(), 'privatizing to end');
  assert.equal(sends.length, 1);
  assert.equal(app.currentName, 'privatize', 'not moved to the status screen');
  assert.match(toasts().join(' '), /Privatizing .* FIRO: it shows in Activity\./);
});

test('Privatize left during the password: nothing is moved', async () => {
  const { app, sends } = rig();
  app.go('privatize');
  await sleep(10);
  one('privatize-confirm', app.current.el).click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  app.go('home'); // dismisses the sheet: it answers no
  await sleep(20);
  assert.equal(sends.length, 0);
});

test('Get a Spark name: Back during "Registering…", the same name again: offered nothing while it is sent, nor while it is on its way', async () => {
  const { app, sends } = rig({ sendMs: 1200 });
  const type = async (n) => {
    const input = one('name-input', app.current.el);
    one('name-info', app.current.el).value ??= ''; // a textarea's value, as a browser has it
    one('name-years', app.current.el).value ??= '1';
    input.value = n;
    for (const fn of input.listeners.get('input') || []) fn({});
    await sleep(350);
  };
  app.go('nameRegister');
  await type('alice');
  const btn = one('name-confirm', app.current.el);
  assert.equal(btn.disabled, false, btn.textContent);
  btn.click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the registration');
  app.go('names');
  app.go('nameRegister');
  await type('alice');
  assert.equal(one('name-confirm', app.current.el).disabled, true);
  assert.equal(one('name-confirm', app.current.el).textContent, IN_FLIGHT_TEXT);
  await until(() => !paymentInFlight(), 'the registration to end');
  assert.equal(app.currentName, 'nameRegister', 'not moved to the status screen');
  // Sent, not in a block yet: the full list of names does not have it, so it would read as free.
  wallet.state.txs = [{ txid: 'ef'.repeat(32), kind: 'spark-name', direction: 'out', confirmations: 0, counterparty: '@alice' }];
  wallet.emit();
  assert.equal(one('name-confirm', app.current.el).disabled, true);
  assert.ok(one('name-on-its-way', app.current.el));
  await one('name-confirm', app.current.el).click();
  assert.equal(sends.length, 1, 'paid once');
  // Another name is not held up by it.
  await type('bob');
  assert.equal(one('name-confirm', app.current.el).disabled, false);
});

test('a payment place left held (a payment that never settled) is given back on lock: no wallet is kept from paying until a reload', async () => {
  const { startPayment, paymentInFlight, releasePayments } = await import('../../src/lib/payment_flight.js');
  const give = startPayment('send');
  assert.ok(give && paymentInFlight());
  assert.equal(startPayment('send'), null, 'held: nothing new');
  releasePayments();
  assert.equal(paymentInFlight(), null);
  const again = startPayment('send');
  assert.ok(again, 'free again after the lock');
  give(); // the old holder giving back late changes nothing
  assert.ok(paymentInFlight(), 'the new holder keeps its place');
  again();
});

test('X1: the very Review a payment was sent from, reopened by Back after it went, never offers it again', async () => {
  const { app, sends } = rig({ sendMs: 200 });
  const params = { ...P, rid: 'x1-test' };
  app.go('review', params);
  await settled();
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  // A sidebar link while it is sent (About), then the payment ends there.
  app.go('home');
  await until(() => !paymentInFlight(), 'the payment to end');
  // Back to that Review (its own params, as the history keeps them).
  app.go('review', params);
  await sleep(20);
  assert.notEqual(app.currentName, 'review', 'not offered again');
  assert.equal(app.currentName, 'activity');
  assert.match(toasts().join(' '), /already sent from here/);
  assert.equal(sends.length, 1, 'one payment');
  assert.equal(auth.sheets.length, 1, 'no second password sheet');
  // The same id from a copy of the params (another way back) is refused too.
  app.go('review', { ...params });
  await sleep(20);
  assert.equal(app.currentName, 'activity');
});

test('X1: a Review whose payment was certainly not sent can be used again', async () => {
  const refused = Object.assign(new Error('The server refused: bad-txns.'), { code: 'server' });
  const { app, sends } = rig({ sendMs: 20, sendFails: refused });
  const params = { ...P, rid: 'x1-refused' };
  app.go('review', params);
  await settled();
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the attempt');
  await sleep(50);
  app.go('home');
  app.go('review', params);
  await settled();
  assert.equal(app.currentName, 'review', 'offered again: nothing left');
});


test('X2: a payment to this address still unconfirmed (or that may have left): Review says so, and paying again takes a tap', async () => {
  const { app, sends } = rig({ sendMs: 10 });
  // The first payment ended "may have left" (no answer after a node had it); the person scanned the same QR again.
  wallet.state.txs = [{ txid: 'aa'.repeat(32), direction: 'out', counterparty: TO, amount: 100000000n, confirmations: 0, unsure: true, dropped: false }];
  app.go('review', { ...P });
  await settled();
  assert.ok(one('review-paid-before', app.current.el), 'said');
  assert.match(one('review-paid-before', app.current.el).textContent, /may have left already/);
  assert.equal(cta(app).disabled, true, 'Send waits for the choice');
  await cta(app).tap();
  assert.equal(auth.sheets.length, 0, 'no password sheet');
  await one('review-pay-again', app.current.el).tap();
  assert.equal(cta(app).disabled, false);
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'paid again, on purpose');
  wallet.state.txs = [];
});

test('X2: confirmed or dropped earlier payments to the address, or payments elsewhere, say nothing', async () => {
  const { openPaymentsTo } = await import('../../src/lib/open_payments.js');
  const t = (o) => ({ txid: '11'.repeat(32), direction: 'out', counterparty: TO, amount: 1n, confirmations: 0, ...o });
  assert.equal(openPaymentsTo([t({})], TO).length, 1, 'on its way');
  assert.equal(openPaymentsTo([t({ unsure: true, confirmations: 0 })], TO).length, 1, 'may have left');
  assert.equal(openPaymentsTo([t({ confirmations: 2 })], TO).length, 0, 'confirmed');
  assert.equal(openPaymentsTo([t({ dropped: true })], TO).length, 0, 'did not go through');
  assert.equal(openPaymentsTo([t({ direction: 'in' })], TO).length, 0, 'received');
  assert.equal(openPaymentsTo([t({ counterparty: 'sm1other' })], TO).length, 0, 'another address');
  assert.equal(openPaymentsTo([t({})], '').length, 0);
});

test('X8: a name that was free when typed but is taken by the time of paying (its own registration mined since): asked again before the password, nothing paid', async () => {
  const { app, sends } = rig({ sendMs: 10 });
  let free = true;
  wallet.nameIsFree = async () => free;
  app.go('nameRegister');
  const input = one('name-input', app.current.el);
  one('name-info', app.current.el).value ??= '';
  one('name-years', app.current.el).value ??= '1';
  input.value = 'carol';
  for (const fn of input.listeners.get('input') || []) fn({});
  await sleep(350);
  assert.equal(one('name-confirm', app.current.el).disabled, false);
  free = false; // mined meanwhile (this wallet's own, or someone else's)
  one('name-confirm', app.current.el).click();
  await sleep(50);
  assert.equal(auth.sheets.length, 0, 'no password asked');
  assert.equal(sends.length, 0, 'nothing paid');
  assert.match(one('name-error', app.current.el).textContent, /taken now, so nothing was paid/);
});

test('XY: the years behind the password sheet can not change what is paid', async () => {
  const { app, sends } = rig({ sendMs: 10 });
  wallet.nameIsFree = async () => true;
  app.go('nameRegister');
  const input = one('name-input', app.current.el);
  one('name-info', app.current.el).value ??= '';
  const years = one('name-years', app.current.el);
  years.value = '1';
  input.value = 'dave1';
  for (const fn of input.listeners.get('input') || []) fn({});
  await sleep(350);
  one('name-confirm', app.current.el).click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  assert.equal(years.disabled, true, 'the years are off while it is confirmed');
  years.value = '5'; // changed anyway (a script, a stale event)
  auth.answer(0);
  await sleep(50);
  assert.equal(sends.length, 0, 'nothing paid for years not confirmed');
  assert.match(one('name-error', app.current.el).textContent, /changed after you confirmed/);
  // Confirmed as it is now: paid for those years.
  years.value = '1';
  one('name-confirm', app.current.el).click();
  await until(() => auth.sheets.length === 2, 'asked again');
  auth.answer(1);
  await until(() => sends.length === 1, 'paid');
  assert.equal(sends[0].years, 1);
});

test('A8c: a Send form changed while its earlier payment was being sent is kept when that payment lands (a new payment being typed)', async () => {
  const { app, sends } = rig({ sendMs: 400 });
  const draft = (app.sendDraft = { address: TO, amount: '1', memo: '', from: 'private', subtractFee: false });
  app.go('review', { ...P });
  await settled();
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  // The person goes back and starts typing another payment on the same form.
  draft.address = 'sm1another';
  draft.amount = '2';
  await until(() => !paymentInFlight(), 'the first payment to end');
  await sleep(20);
  assert.equal(app.sendDraft, draft, 'the new typing is kept');
  assert.equal(app.sendDraft.address, 'sm1another');
});

test('A8d: the name pin throwing after a payment left never makes it "not sent"', async () => {
  const { app, sends } = rig({ sendMs: 10 });
  wallet.pinSparkName = () => {
    throw new Error('The wallet is not open.');
  };
  app.go('review', { ...P, name: 'alice', checked: 'two-servers' });
  await settled();
  cta(app).tap();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'the payment');
  await until(() => app.currentName === 'txStatus', 'its status screen, not "not sent"');
});

test('audit L1: Privatize after one failed fee estimate: says so, and the next tap asks again (never a dead end)', async () => {
  const { app, sends } = rig({});
  let quotes = 0;
  const quote = wallet.quote;
  wallet.quote = async (r) => {
    quotes++;
    if (quotes === 1) throw Object.assign(new Error('server busy'), { code: 'server' });
    return quote(r);
  };
  try {
    app.go('privatize');
    await sleep(20);
    assert.equal(quotes, 1);
    assert.ok(one('privatize-fee-failed', app.current.el), 'the failure is said');
    await sleep(50);
    assert.equal(quotes, 1, 'not asked again in a loop');
    await settled();
    await one('privatize-confirm', app.current.el).tap();
    await until(() => quotes === 2, 'the fee asked again');
    await sleep(10);
    assert.equal(one('privatize-fee-failed', app.current.el), null);
    one('privatize-confirm', app.current.el).tap();
    await until(() => auth.sheets.length === 1, 'the password sheet');
    auth.answer(0);
    await until(() => sends.length === 1, 'privatizing');
  } finally {
    wallet.quote = quote;
  }
});

test('audit L7: Get a Spark name shows its network fee, and pays only the figures shown', async () => {
  const { app, sends } = rig({ sendMs: 10 });
  wallet.nameIsFree = async () => true;
  app.go('nameRegister');
  const input = one('name-input', app.current.el);
  one('name-info', app.current.el).value ??= '';
  one('name-years', app.current.el).value = '2';
  input.value = 'erin';
  for (const fn of input.listeners.get('input') || []) fn({});
  await sleep(350);
  assert.equal(one('name-fee', app.current.el).textContent, '0.0001 FIRO');
  assert.equal(one('name-total', app.current.el).textContent, '2.0001 FIRO');
  one('name-confirm', app.current.el).click();
  await until(() => auth.sheets.length === 1, 'the password sheet');
  auth.answer(0);
  await until(() => sends.length === 1, 'paid');
  assert.deepEqual(sends[0].expect, { fee: 10000n, total: 200010000n });
});

test('audit N9: Get a Spark name when the price fits the private balance but not with its network fee: said so, button off', async () => {
  const { app } = rig({});
  wallet.nameIsFree = async () => true;
  const quoteName = wallet.quoteName;
  wallet.quoteName = async () => {
    throw Object.assign(new Error('Not enough private FIRO for this amount and fee.'), { code: 'insufficient' });
  };
  try {
    app.go('nameRegister');
    const input = one('name-input', app.current.el);
    one('name-info', app.current.el).value ??= '';
    one('name-years', app.current.el).value = '1';
    input.value = 'fay';
    for (const fn of input.listeners.get('input') || []) fn({});
    await sleep(350);
    assert.match(one('name-short', app.current.el).textContent, /plus the network fee/);
    assert.equal(one('name-confirm', app.current.el).disabled, true);
  } finally {
    wallet.quoteName = quoteName;
  }
});
