// What Campfire tells the person about, worked out on the device (lib/notify_rules.js), and
// where a tap on a notification may open the app (lib/notify.js parseOpen).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { txWatcher, wordsFor, settingsOf, remindersFor, dueReminders, awaySummary, snapshotOf, awayLine, howWords, KINDS, KIND_WORDS, NEAR_NOTICE_MS } from '../../src/lib/notify_rules.js';

// The shape lib/wallet.js gives the screens: amounts as BigInt sats.
const tx = (txid, extra = {}) => ({ txid, direction: 'in', kind: 'spark', amount: 50000000n, fee: 0n, confirmations: 1, height: 100, time: 1000, memo: null, counterparty: null, ...extra });
const types = (evs) => evs.map((e) => `${e.type}:${e.tx ? e.tx.txid : ''}`);

test('the watcher: first read is history; then money on its way, received, sent and privatized, each once', () => {
  const w = txWatcher();
  assert.deepEqual(w.update([tx('old')], false), [], 'not read yet');
  assert.equal(w.started, false);
  const sending = tx('s1', { direction: 'out', confirmations: 0, height: null });
  const priv = tx('p1', { direction: 'self', kind: 'privatize', confirmations: 0, height: null });
  assert.deepEqual(w.update([tx('old'), sending, priv]), [], 'the first read is history');
  assert.equal(w.started, true);
  const next = w.update([tx('new', { confirmations: 0, height: null }), tx('pub', { kind: 'transparent' }), tx('old'), { ...sending, confirmations: 1 }, { ...priv, confirmations: 2 }, tx('mine', { direction: 'out', confirmations: 3 })]);
  assert.deepEqual(types(next), ['incoming:new', 'received:pub', 'sent:s1', 'privatized:p1'], 'a send never seen waiting is not news');
  assert.deepEqual(next.map((e) => e.kind), ['in', 'in', 'out', 'out']);
  assert.deepEqual(types(w.update([tx('new', { confirmations: 1 }), tx('pub', { kind: 'transparent', confirmations: 2 })])), ['received:new'], 'on its way, then received; more confirmations say nothing');
  assert.deepEqual(w.update([tx('new', { confirmations: 1 })]), [], 'once');
  // Caught up later: payments found while catching up are history, then never news.
  const c = txWatcher();
  c.update([]);
  assert.deepEqual(c.update([tx('found')], true, false), []);
  assert.deepEqual(c.update([tx('found'), tx('live')], true, true).map((e) => e.tx.txid), ['live']);
  // Own moves: a payment to yourself counts as sent; Lelantus moving over is not news.
  const d = txWatcher();
  d.update([tx('self1', { direction: 'self', kind: 'spark', confirmations: 0 })]);
  assert.deepEqual(types(d.update([tx('self1', { direction: 'self', kind: 'spark', confirmations: 1 }), tx('lel', { kind: 'lelantus' })])), ['sent:self1']);
  w.reset();
  assert.deepEqual(w.update([tx('x'), tx('y')]), [], 'after a stop the first read is history again');
});

test('the words: FIRO amounts only when allowed; privately or publicly; a tap opens the payment', () => {
  const r = wordsFor({ type: 'received', tx: tx('ab12') });
  assert.equal(r.title, 'Received 0.5 FIRO');
  assert.equal(r.body, 'It arrived privately. Tap to see it in Activity.');
  assert.equal(r.url, '#open=activity&tx=ab12');
  assert.equal(wordsFor({ type: 'received', tx: tx('1', { kind: 'transparent' }) }).body, 'It arrived publicly. Tap to see it in Activity.');
  assert.equal(wordsFor({ type: 'received', tx: tx('1') }, { amounts: false }).title, 'Payment received', 'no amount on a lock screen');
  const on = wordsFor({ type: 'incoming', tx: tx('ab12', { confirmations: 0 }) });
  assert.equal(on.title, '0.5 FIRO is on its way to you');
  assert.equal(on.tag, r.tag, 'received replaces "on its way" in the notification list');
  assert.equal(wordsFor({ type: 'sent', tx: tx('1', { direction: 'out', amount: 125000000n }) }).title, 'Sent 1.25 FIRO');
  assert.equal(wordsFor({ type: 'privatized', tx: tx('1', { kind: 'privatize', direction: 'self' }) }).title, '0.5 FIRO is now private');
  assert.equal(wordsFor({ type: 'privatized', tx: tx('1', { kind: 'privatize' }) }, { amounts: false }).title, 'Your funds are now private');
  assert.equal(wordsFor({ type: 'received', tx: tx('1') }, { walletName: 'Savings' }).body, 'It arrived privately. Tap to see it in Activity. In Savings.');
  assert.equal(howWords(tx('1', { kind: 'masternode' })), 'publicly');
  for (const t of ['incoming', 'received', 'sent', 'privatized']) assert.match(JSON.stringify(wordsFor({ type: t, tx: tx('1') })), /FIRO/);
});

test('settings: off until turned on; every kind on by default', () => {
  assert.equal(settingsOf(null).on, false);
  assert.equal(settingsOf({ notify: { on: true } }).on, true);
  const s = settingsOf({ notify: { on: true, kinds: { out: false } } });
  assert.deepEqual(KINDS.filter((k) => s.kinds[k]), ['in', 'moves']);
  // A lock screen is read by whoever holds the phone: amounts only when the person asks (audit A-8).
  assert.equal(s.amounts, false, 'no amounts by default');
  assert.equal(settingsOf({ notify: { on: true } }).amounts, false);
  assert.equal(settingsOf({ notify: { on: true, amounts: true } }).amounts, true);
  assert.equal(settingsOf({ notify: { on: true, amounts: false } }).amounts, false);
  for (const k of KINDS) assert.ok(KIND_WORDS[k].title && KIND_WORDS[k].sub);
});

test('reminders for later: a NEAR Intents deposit about to stop taking coins; nothing for Firo payments', () => {
  const now = 1_700_000_000_000;
  const list = remindersFor({ now, walletName: 'Savings', nearSwaps: [{ id: 'bc1qdepositaddress', symbol: 'BTC', sendBefore: now + 3600_000 }, { id: 'late', symbol: 'LTC', sendBefore: now + 60_000 }] });
  assert.equal(list.length, 1);
  assert.equal(list[0].at, now + 3600_000 - NEAR_NOTICE_MS);
  assert.equal(list[0].kind, 'moves');
  assert.ok(list.every((r) => /^rem-near-/.test(r.id) && /^#open=/.test(r.url)));
  // Kept in the clear for the service worker (audit A-1): when, and words that name nothing. The
  // coin, the deposit address and the wallet are read after the unlock.
  assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'body', 'id', 'kind', 'title', 'url']);
  const text = JSON.stringify(list);
  for (const secret of ['BTC', 'bc1qdepositaddress', 'Savings']) assert.ok(!text.includes(secret), secret);
  assert.equal(list[0].title, 'A deposit address closes soon');
  assert.deepEqual(remindersFor({ now }), []);
  const { due, keep } = dueReminders(list, list[0].at);
  assert.deepEqual(due.map((r) => r.id), [list[0].id]);
  assert.equal(keep.length, 0);
});

test('while you were away: from the states saved on leaving, never older history', () => {
  const left = { at: 2_000_000, txs: snapshotOf([tx('s1', { direction: 'out', confirmations: 0 }), tx('p1', { kind: 'privatize', direction: 'self', confirmations: 0 }), tx('old')]) };
  assert.deepEqual(left.txs, { s1: 'p', p1: 'p', old: 'c' });
  const now = [
    tx('new1', { time: 2100 }),
    tx('new2', { time: 2200, amount: 25000000n, kind: 'transparent' }),
    tx('coming', { time: 2300, confirmations: 0 }),
    tx('s1', { direction: 'out', confirmations: 1 }),
    tx('p1', { kind: 'privatize', direction: 'self', confirmations: 1 }),
    tx('ancient', { time: 100 }),
    tx('old'),
  ];
  const sum = awaySummary(left, now);
  assert.deepEqual(sum.received.map((t) => t.txid), ['new1', 'new2'], 'a payment older than the 200 saved is not news');
  assert.deepEqual(sum.arriving.map((t) => t.txid), ['coming']);
  assert.deepEqual(sum.sent.map((t) => t.txid), ['s1']);
  assert.deepEqual(sum.privatized.map((t) => t.txid), ['p1']);
  assert.equal(awayLine(sum), 'While you were away: received 2 payments (0.75 FIRO) · a payment is on its way to you · a payment you sent was confirmed · your privatized funds are now private.');
  assert.equal(awayLine(sum, { amounts: false }), 'While you were away: received 2 payments · a payment is on its way to you · a payment you sent was confirmed · your privatized funds are now private.');
  assert.equal(awayLine(awaySummary(left, [tx('old')])), null, 'nothing happened: no line');
  assert.equal(Object.keys(snapshotOf(Array.from({ length: 300 }, (_, i) => tx(`t${i}`)))).length, 200);
});

test('a tap opens only the app own screens (lib/notify.js parseOpen; sw.js accepts the same links)', () => {
  // notify.js imports the wallet; its parseOpen is checked through its source, the rule sw.js shares.
  const src = readFileSync(new URL('../../src/lib/notify.js', import.meta.url), 'utf8');
  const sw = readFileSync(new URL('../../src/sw.js', import.meta.url), 'utf8');
  const pageRule = /\/\^#open=\(\[a-zA-Z\]\+\)\(\?:&tx=\(\[0-9a-f\]\{1,128\}\)\)\?\$\//;
  assert.match(src, pageRule);
  assert.match(sw, /const OPEN_LINK = \/\^#open=\[a-zA-Z\]\+\(&tx=\[0-9a-f\]\{1,128\}\)\?\$\/;/);
  const OPEN_LINK = /^#open=[a-zA-Z]+(&tx=[0-9a-f]{1,128})?$/;
  assert.equal(OPEN_LINK.test(`#open=activity&tx=${'ab'.repeat(32)}`), true, 'a Firo txid (64 hex)');
  for (const bad of ['https://evil.example/#open=home', '#open=home&x=1', 'javascript:alert(1)', '#open=activity&tx=AB', '#open=../x']) assert.equal(OPEN_LINK.test(bad), false, bad);
  // No server is asked for anything: no push subscription, no fetch.
  for (const s of [src, readFileSync(new URL('../../src/lib/notify_rules.js', import.meta.url), 'utf8')]) {
    assert.doesNotMatch(s, /pushManager|subscribe\(|fetch\(|XMLHttpRequest|WebSocket/);
  }
  assert.doesNotMatch(sw.slice(sw.indexOf('// ---------------------------------------------------------------- notifications')), /pushManager|addEventListener\('push'|fetch\(/);
});

test('other parts of the app: their own words, without amounts when the person said so', () => {
  const ev = { type: 'free', title: 'Your swap is done', body: '0.01 ETH arrived in your Ethereum wallet.', plainBody: 'It arrived in your Ethereum wallet.', tag: 'near-1', url: '#open=nearIntents' };
  assert.equal(wordsFor(ev).body, '0.01 ETH arrived in your Ethereum wallet.');
  assert.equal(wordsFor(ev, { amounts: false }).body, 'It arrived in your Ethereum wallet.');
  assert.equal(wordsFor({ type: 'free', title: 'x', body: 'Done.' }, { walletName: 'Savings' }).body, 'Done. In Savings.');
});
