// What notifications leave on the device (audit A-1): the payment list's states saved when the
// person leaves ('w:<id>:notify-snapshot', for "While you were away" after the next unlock) are
// sealed under the wallet's secret: txids and their states say which payments are this wallet's.
// Only the reminders the service worker shows while the wallet is locked stay readable, and they
// name nothing (test/unit/notify_rules.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealSnapshot, openSnapshot, NOTIFY_INFO } from '../../src/lib/notify.js';

const dbPass = 'ab'.repeat(32);
const other = 'cd'.repeat(32);
const W = '0123456789abcdef';
const snap = { at: 1_800_000_000_000, txs: { ['f'.repeat(64)]: 'c', ['e'.repeat(64)]: 'p' } };

test('the snapshot is sealed: no txid, no state, no time in what is stored', async () => {
  const env = await sealSnapshot(dbPass, W, snap);
  const stored = JSON.stringify(env);
  assert.ok(!stored.includes('f'.repeat(16)) && !stored.includes('e'.repeat(16)), 'no txid');
  assert.ok(!stored.includes(String(snap.at)), 'no time');
  assert.equal(env.walletId, W);
  assert.equal(NOTIFY_INFO, 'campfire-firo-notify-v1');
  assert.deepEqual(await openSnapshot(dbPass, W, env), snap);
});

test('another wallet, another secret, or an edited copy does not open; an old plaintext one is read once', async () => {
  const env = await sealSnapshot(dbPass, W, snap);
  assert.equal(await openSnapshot(other, W, env), null);
  assert.equal(await openSnapshot(dbPass, 'fedcba9876543210', env), null);
  assert.equal(await openSnapshot(dbPass, W, { ...env, ct: env.ct.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }), null);
  assert.equal(await openSnapshot(null, W, env), null, 'locked: nothing');
  assert.deepEqual(await openSnapshot(dbPass, W, snap), snap, 'written by an earlier version: read, then sealed over');
  assert.equal(await openSnapshot(dbPass, W, null), null);
});

test('at start, what an earlier version left in the clear goes: a txid snapshot, a reminder naming the coin and wallet', async () => {
  const m = new Map();
  const kv = { keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)), get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), del: async (k) => void m.delete(k) };
  const sealed = await sealSnapshot(dbPass, W, snap);
  m.set(`w:${W}:notify-snapshot`, snap);
  m.set(`w:fedcba9876543210:notify-snapshot`, sealed);
  m.set(`w:${W}:notify-reminders`, [{ id: 'rem-near-bc1qdeposit', wallet: W, kind: 'moves', at: 5_000_000, title: 'Send your BTC in the next 30 minutes', body: 'The deposit address for your swap stops taking coins then. In Savings.', url: '#open=nearIntents' }]);
  const { forgetPlainNotes } = await import('../../src/lib/notify.js');
  assert.equal(await forgetPlainNotes(kv), 2);
  assert.equal(m.has(`w:${W}:notify-snapshot`), false, 'the plaintext snapshot goes');
  assert.deepEqual(m.get(`w:fedcba9876543210:notify-snapshot`), sealed, 'a sealed one stays');
  const rem = m.get(`w:${W}:notify-reminders`);
  assert.equal(rem.length, 1);
  assert.equal(rem[0].at, 5_000_000, 'still due at the same time');
  assert.ok(!/BTC|Savings|bc1q/.test(JSON.stringify(rem)));
  assert.equal(await forgetPlainNotes(kv), 0, 'once');
});
