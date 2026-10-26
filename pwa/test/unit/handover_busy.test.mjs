// A hand-over to another tab waits for a step whose parts must not be split (release re-audit RE1-5,
// RE1-6, as in BEAM): a deleted wallet's engine database and its record and keys; a new wallet's
// record and its selection. Before, "Use it here instead" landing between the two let go of the
// wallet in the middle: the second part was then refused, leaving a wallet listed whose database was
// gone (the other tab showed it), or a new wallet opened after the lock had run, its secret kept in a
// page that no longer holds the wallet.
//
// The real lib/session.js and lib/wallets.js over an in-memory IndexedDB; the hand-over is this
// page's own OneTab letting go (lib/one_tab.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIndexedDB, IDBKeyRangeStub } from './helpers/fake_idb.mjs';

const idb = fakeIndexedDB();
globalThis.indexedDB = idb;
globalThis.IDBKeyRange = IDBKeyRangeStub;

const { oneTab } = await import('../../src/lib/one_tab.js');
const { createWallet } = await import('../../src/lib/session.js');
const { removeWallet, listWallets, saveRecord, savePrefs } = await import('../../src/lib/wallets.js');
const { rawStore, getPrefs } = await import('../../src/lib/store.js');

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const env = (id) => ({ v: 1, kind: 'password', walletId: id, salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=', iterations: 600000 });
const rec = (id, extra = {}) => ({ id, name: id.slice(0, 4), createdAt: 1000, restored: false, words: 24, birthday: null, seed: { v: 1, kind: 'firo-seed', walletId: id }, envelopes: { password: env(id), passkey: null }, setupDone: true, ...extra });

const tab = oneTab();
const order = [];
let app = null;
// What the app does when it lets the wallet go (app.letGoToOtherTab): the secret is forgotten.
tab.onLetGo(async () => {
  order.push('locked for the other tab');
  if (app) app.dbPass = null;
});
/** This page holds the wallet again (each test hands it over once). */
function holdAgain() {
  Object.assign(tab, { state: 'held', spent: false, how: null });
  order.length = 0;
}
function fakeApp(extra = {}) {
  app = {
    setup: { mode: 'create', words: WORDS.slice() },
    record: null,
    dbPass: null,
    prefs: null,
    wallet: { session: null, run: null, stop: async () => {} },
    nav: { clear() {} },
    runLockHooks() {},
    async setPrefs(patch) {
      order.push(['selected', tab.holds()]);
      this.prefs = await savePrefs(this.record, patch);
      return this.prefs;
    },
    ...extra,
  };
  return app;
}

test('create: "Use it here instead" while the record is written waits for the wallet to be saved and selected; then it is locked and handed over', async () => {
  holdAgain();
  const a = fakeApp();
  // The other tab asks just as the new wallet's record is being written.
  let handOver = null;
  const update = rawStore.update;
  rawStore.update = (...x) => {
    rawStore.update = update;
    handOver = tab.letGo();
    return update(...x);
  };
  const record = await createWallet(a, 'a long password for the test 1');
  await handOver;
  assert.equal(tab.how, 'handed');
  assert.deepEqual(order, [['selected', true], 'locked for the other tab'], 'saved and selected while this tab still held the wallet, then locked');
  assert.equal(a.dbPass, null, 'the new wallet was opened before the lock ran, so its secret is gone with it');
  assert.deepEqual((await listWallets()).map((r) => r.id), [record.id]);
  assert.equal((await getPrefs(rawStore)).lastWalletId, record.id, 'the other tab opens the new wallet');
});

test('delete: "Use it here instead" while the engine database goes waits for the record and keys to go too', async () => {
  holdAgain();
  const A = '0123456789abcdef';
  const B = 'fedcba9876543210';
  await saveRecord(rec(A, { slot0: false }));
  await saveRecord(rec(B, { slot0: false }));
  await rawStore.set(`w:${B}:payments`, { v: 1 });
  const list = await listWallets();
  const a = fakeApp({ record: list.find((r) => r.id === A), dbPass: 'x' });
  let handOver = null;
  const deleteDb = async (id) => {
    handOver = tab.letGo(); // the other tab asks while the database is being deleted
    await new Promise((r) => setTimeout(r, 20));
    order.push(['database gone', id, tab.holds()]);
  };
  await removeWallet(a, list.find((r) => r.id === B), { deleteDb, deleteSharedCache: async () => {}, storage: null, signalPasskeyGone: async () => {}, closeNotifications: async () => {} });
  await handOver;
  assert.equal(tab.how, 'handed');
  assert.deepEqual(order, [['database gone', B, true], 'locked for the other tab']);
  const left = (await listWallets()).map((r) => r.id);
  assert.equal(left.includes(B), false, 'not listed in the other tab');
  assert.equal(left.includes(A), true);
  assert.equal(await rawStore.get(`w:${B}:wallet`), undefined, 'its record went with its database');
  assert.equal(await rawStore.get(`w:${B}:payments`), undefined, 'and its keys');
});

test('release re-audit RE1-7: a step that outlasts the cap: the hand-over goes anyway, said as "capped" (it may not have saved its last seconds)', async () => {
  holdAgain();
  const cap = tab.capMs;
  tab.capMs = 50;
  let finish;
  const step = tab.whileBusy(() => new Promise((r) => (finish = r)));
  const t0 = Date.now();
  await tab.letGo();
  tab.capMs = cap;
  assert.ok(Date.now() - t0 >= 45, 'it waited for the cap');
  assert.equal(tab.how, 'capped');
  assert.deepEqual(order, [], 'the wallet was not locked by the hand-over after the cap (the app stops it when told "capped")');
  finish();
  await step;
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, [], 'nor later');
});
