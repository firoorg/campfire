// Which payments are news (lib/payment_notice.js), when a run's news starts, and the browser's
// notification states. What is told: notify_rules.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNews, catchUp, settled, CATCH_UP_GRACE_MS, notificationPermission, isIos, isStandalone } from '../../src/lib/payment_notice.js';

const tx = (txid, extra = {}) => ({ txid, direction: 'in', kind: 'spark', amount: 50000000n, fee: 0n, confirmations: 1, time: 1000, ...extra });

test('news: an incoming payment from someone else; never a send, a payment to yourself, privatizing or Lelantus moving over', () => {
  assert.equal(isNews(tx('1')), true, 'received privately');
  assert.equal(isNews(tx('2', { kind: 'transparent' })), true, 'received publicly');
  assert.equal(isNews(tx('2b', { confirmations: 0 })), true, 'still waiting for its confirmation: news too (the watcher tells both)');
  assert.equal(isNews(tx('3', { kind: 'masternode' })), true);
  assert.equal(isNews(tx('3b', { kind: 'coinbase' })), true);
  assert.equal(isNews(tx('4', { direction: 'out' })), false, 'a send');
  assert.equal(isNews(tx('5', { direction: 'self' })), false, 'to yourself');
  assert.equal(isNews(tx('6', { direction: 'self', kind: 'privatize' })), false, 'privatizing');
  assert.equal(isNews(tx('7', { kind: 'lelantus' })), false, 'own Lelantus coins moving to Spark');
  assert.equal(isNews(tx('8', { amount: 0n })), false);
  assert.equal(isNews(tx('9', { amount: '25000000' })), true, 'an engine satoshi string too');
  assert.equal(isNews(null), false);
});

test('news starts once the run has caught up (Synced) for 10 s, then stays on', () => {
  const synced = { running: true, sync: { state: 'synced' } };
  assert.equal(settled(synced), true);
  assert.equal(settled({ ...synced, sync: { state: 'syncing' } }), false);
  assert.equal(settled({ ...synced, running: false }), false);
  assert.equal(settled(null), false);
  assert.equal(CATCH_UP_GRACE_MS, 10000);
  const run = catchUp();
  assert.equal(run.live({ ...synced, sync: { state: 'syncing' } }, 0), false);
  assert.equal(run.live(synced, 1000), false, 'just caught up');
  assert.equal(run.live(synced, 10999), false);
  assert.equal(run.live(synced, 11000), true);
  assert.equal(run.live({ ...synced, sync: { state: 'connecting' } }, 12000), true, 'a reconnect does not turn it off');
  run.reset();
  assert.equal(run.live(synced, 30000), false, 'a new run catches up again');
});

test("the browser's notifications: unsupported, asked, allowed, blocked", () => {
  const N = (permission) => Object.assign(function Notification() {}, { permission, requestPermission: () => Promise.resolve(permission) });
  assert.equal(notificationPermission({}), 'unsupported');
  assert.equal(notificationPermission({ Notification: N('default') }), 'default');
  assert.equal(notificationPermission({ Notification: N('granted') }), 'granted');
  assert.equal(notificationPermission({ Notification: N('denied') }), 'denied');
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), true);
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), true, 'iPadOS');
  assert.equal(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), false);
  assert.equal(isStandalone({ navigator: { standalone: true } }), true);
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) }), false);
});
