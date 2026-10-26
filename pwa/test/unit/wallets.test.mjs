// Several wallets on one device (lib/wallets.js, lib/wallet_scope.js): the records list, names,
// per-wallet keys and preferences, a delete that removes only that wallet's keys and engine
// database, rename, selection and the last known balance. A Map stands in for the app's store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listWallets, saveRecord, placeFor, nameOf, nextName, nameProblem, sortWallets, initialWallet, recordKey, balanceKey,
  loadPrefs, savePrefs, removalOps, removeWallet, renameWallet, forgetStoredBalances, selectWallet, runningWallet, MAX_NAME, FIRST_NAME,
} from '../../src/lib/wallets.js';
import { mapWalletKey, walletKey, walletStore, keyFor, isWalletKey, inSlot0, WALLET_KEYS, WALLET_KEY_PREFIXES, WALLET_PREF_KEYS, APP_KEYS, APP_KEY_PREFIXES, onWalletRemoved } from '../../src/lib/wallet_scope.js';
import { ETH_RECORD_KEY, ETH_OUTBOX_KEY } from '../../src/lib/eth/record.js';
import { BUY_RECORD_KEY } from '../../src/lib/buy/store.js';
import { walletDbName } from '../../src/lib/wallet_store.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'src');

/** The store's shape (lib/store.js rawStore) over a Map; values are copied in and out like IndexedDB does. */
function memKv(init = {}) {
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const m = new Map(Object.entries(init).map(([k, v]) => [k, clone(v)]));
  return {
    m,
    get: async (k) => clone(m.get(k)),
    set: async (k, v) => void m.set(k, clone(v)),
    del: async (k) => void m.delete(k),
    clear: async () => m.clear(),
    keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)).sort(),
    batch: async (ops) => {
      for (const [op, k, v] of ops) if (op === 'del') m.delete(k);
      else m.set(k, clone(v));
    },
    update: async (k, fn) => {
      const v = fn(clone(m.get(k)));
      m.set(k, clone(v));
      return v;
    },
  };
}

const env = (id) => ({ v: 1, kind: 'password', walletId: id, salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=', iterations: 600000 });
const A = '0123456789abcdef';
const B = 'fedcba9876543210';
const C = 'aaaaaaaaaaaaaaaa';
const rec = (id, extra = {}) => ({ id, createdAt: 1000, restored: false, words: 24, birthday: null, seed: { v: 1, kind: 'firo-seed', walletId: id }, envelopes: { password: env(id), passkey: null }, setupDone: true, ...extra });
const keysOf = (kv, id) => [...kv.m.keys()].filter((k) => k.startsWith(`w:${id}:`));

async function threeWallets() {
  const kv = memKv({ prefs: { autoLockMin: 15, backupPromptSnoozedUntil: 3, fiatPrices: true } });
  await saveRecord({ ...rec(A), slot0: true, name: 'Main' }, kv);
  await saveRecord({ ...rec(B), slot0: false, name: 'Two' }, kv);
  await saveRecord({ ...rec(C), slot0: false, name: 'Three' }, kv);
  await kv.set('eth', { v: 1, walletId: A });
  await kv.set(`w:${B}:eth`, { v: 1, walletId: B });
  await kv.set(`w:${B}:payments`, { v: 1 });
  await kv.set(`w:${B}:prefs`, { backupPromptSnoozedUntil: 9 });
  await kv.set(`w:${C}:payments`, { v: 1 });
  return kv;
}

function fakeApp(kv, record, { dbPass = 'x', running = record ? record.id : null } = {}) {
  const calls = [];
  const app = {
    record,
    dbPass,
    setup: { mode: 'create' },
    afterUnlock: { name: 'buyOrders' },
    nav: { clear: () => calls.push('nav') },
    runLockHooks: () => calls.push('hooks'),
    wallet: {
      run: running ? { walletId: running } : null,
      stop: async () => {
        calls.push('stop');
        app.wallet.run = null;
      },
    },
    prefs: null,
  };
  return { app, calls };
}

test('a record without a place is the first slot', () => {
  assert.equal(inSlot0({ id: A }), true);
  assert.equal(inSlot0({ id: A, slot0: false }), false);
  assert.equal(recordKey({ id: A }), 'wallet');
  assert.equal(recordKey({ id: B, slot0: false }), `w:${B}:wallet`);
});

test('records list: the first slot and every other record, by name with numbers in order; broken records skipped', async () => {
  const kv = await threeWallets();
  await kv.set(`w:${'b'.repeat(16)}:wallet`, { id: 'x' }); // id does not match its key
  await kv.set('w:nothex:wallet', rec(C));
  const list = await listWallets(kv);
  assert.deepEqual(list.map(nameOf), ['Main', 'Three', 'Two']);
  assert.deepEqual(list.map((r) => r.slot0), [true, false, false]);
  assert.deepEqual(sortWallets([{ id: B, name: 'Wallet 10' }, { id: A, name: 'Wallet 2' }]).map(nameOf), ['Wallet 2', 'Wallet 10']);
  assert.equal(placeFor(list).slot0, false);
  assert.equal(placeFor([]).slot0, true);
});

test('saveRecord writes where the wallet lives and never over another wallet in the first slot', async () => {
  const kv = await threeWallets();
  await assert.rejects(saveRecord({ ...rec(B), slot0: true }, kv), (e) => e.code === 'slot_taken');
  assert.equal((await kv.get('wallet')).id, A, 'the first slot keeps its wallet');
  await assert.rejects(saveRecord({ id: B }, kv), (e) => e.code === 'missing');
});

test('names: "Wallet N" for the next one; empty, too long and taken names refused (any case), a wallet keeps its own', async () => {
  const list = await listWallets(await threeWallets());
  assert.equal(nextName(list), 'Wallet 4');
  assert.equal(nameOf({ id: A }), FIRST_NAME);
  assert.match(nameProblem('  ', list), /Give the wallet a name/);
  assert.match(nameProblem('x'.repeat(MAX_NAME + 1), list), /characters or fewer/);
  assert.match(nameProblem('main', list), /already have a wallet named/);
  assert.equal(nameProblem('Main', list, A), null);
});

test('per-wallet keys: plain names for the first slot, w:<id>: for the others; other keys as they are', () => {
  const first = { id: A, slot0: true };
  const other = { id: B, slot0: false };
  assert.deepEqual([...WALLET_KEYS].sort(), [ETH_RECORD_KEY, ETH_OUTBOX_KEY, BUY_RECORD_KEY].sort());
  assert.deepEqual([...WALLET_KEY_PREFIXES], []);
  assert.deepEqual([...WALLET_PREF_KEYS], ['backupPromptSnoozedUntil']);
  assert.equal(keyFor(first, 'eth'), 'eth');
  assert.equal(keyFor(other, 'eth'), `w:${B}:eth`);
  assert.equal(isWalletKey('prefs'), false);
  assert.equal(mapWalletKey('prefs', true, { record: null, open: false }), 'prefs');
  assert.throws(() => mapWalletKey('eth', false, { record: null, open: false }), (e) => e.code === 'none');
  assert.throws(() => mapWalletKey('eth', true, { record: other, open: false }), (e) => e.code === 'locked');
  assert.equal(mapWalletKey('eth', false, { record: other, open: false }), `w:${B}:eth`);
  assert.equal(walletKey({ record: other }, 'payments'), `w:${B}:payments`);
});

test('a store bound to a wallet keeps naming that wallet, and passes other keys through', async () => {
  const kv = memKv();
  const s = walletStore({ id: B, slot0: false }, kv);
  await s.set('buy', { v: 1 });
  await s.set('prefs', { a: 1 });
  assert.deepEqual(await kv.get(`w:${B}:buy`), { v: 1 });
  assert.deepEqual(await kv.get('prefs'), { a: 1 });
});

test('every literal store key in the source is the app\'s or a wallet\'s (lib/wallet_scope.js)', () => {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (n === 'vendor') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) files.push(p);
    }
  };
  walk(SRC);
  const literal = /\b(?:store|kv|rawStore)\.(?:get|set|del)\('([^']+)'/g;
  const known = (k) => WALLET_KEYS.includes(k) || APP_KEYS.includes(k) || WALLET_KEY_PREFIXES.some((p) => k.startsWith(p)) || APP_KEY_PREFIXES.some((p) => k.startsWith(p)) || k.startsWith('fake:');
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(literal)) assert.ok(known(m[1]), `${f}: store key '${m[1]}' is neither the app's nor a wallet's`);
});

test('preferences: the first slot keeps its own in "prefs"; another wallet has its own, and the app-wide ones are shared', async () => {
  const kv = await threeWallets();
  const list = await listWallets(kv);
  const b = list.find((r) => r.id === B);
  const c = list.find((r) => r.id === C);
  const pb = await loadPrefs(b, kv);
  assert.equal(pb.backupPromptSnoozedUntil, 9);
  assert.equal(pb.autoLockMin, 15, "auto-lock is the app's");
  assert.equal(pb.server, 'firo', "Firo's servers by default");
  const pc = await loadPrefs(c, kv);
  assert.equal(pc.backupPromptSnoozedUntil, undefined, "the first wallet's own preference is not another's");
  await savePrefs(c, { backupPromptSnoozedUntil: 5, autoLockMin: 1 }, kv);
  assert.deepEqual(await kv.get(`w:${C}:prefs`), { backupPromptSnoozedUntil: 5 });
  assert.equal((await kv.get('prefs')).autoLockMin, 1);
  assert.equal((await kv.get('prefs')).backupPromptSnoozedUntil, 3, 'the first slot keeps its own');
});

test('a server preference that is not Firo\'s pool or a valid own server reads as Firo\'s pool', async () => {
  const kv = memKv({ prefs: { server: 'ws://bad:1' } });
  assert.equal((await loadPrefs(null, kv)).server, 'firo');
  const kv2 = memKv({ prefs: { server: 'electrum.example.com:50004' } });
  assert.equal((await loadPrefs(null, kv2)).server, 'electrum.example.com:50004');
});

test('deleting a wallet: only its keys; deleting the first slot also its plain keys; app-wide keys stay', async () => {
  const kv = await threeWallets();
  const list = await listWallets(kv);
  const ops = await removalOps(list.find((r) => r.id === B), kv);
  const dels = ops.filter(([op]) => op === 'del').map(([, k]) => k).sort();
  assert.deepEqual(dels, keysOf(kv, B).sort());
  const ops0 = await removalOps(list.find((r) => r.id === A), kv);
  const dels0 = ops0.filter(([op]) => op === 'del').map(([, k]) => k);
  for (const k of ['wallet', 'eth', 'eth-outbox', 'buy']) assert.ok(dels0.includes(k), k);
  const prefs = ops0.find(([op, k]) => op === 'set' && k === 'prefs')[2];
  assert.equal(prefs.backupPromptSnoozedUntil, undefined, "the first slot's own preference goes");
  assert.equal(prefs.autoLockMin, 15, "the app's stay");
});

test('removeWallet: the open wallet stops, its engine database goes, another is selected (locked); the last one clears the store', async () => {
  const kv = await threeWallets();
  const list = await listWallets(kv);
  const b = list.find((r) => r.id === B);
  const { app, calls } = fakeApp(kv, b);
  const deleted = [];
  const removedIds = [];
  const off = onWalletRemoved((id) => removedIds.push(id));
  const { others } = await removeWallet(app, b, { kv, deleteDb: async (id) => deleted.push(walletDbName(id)) });
  off();
  assert.deepEqual(deleted, [`campfire-firo-w-${B}`], 'its own engine database only');
  assert.deepEqual(calls, ['nav', 'hooks', 'stop']);
  assert.equal(app.dbPass, null);
  assert.equal(app.setup, null);
  assert.equal(app.afterUnlock, null);
  assert.equal(app.record.id, A, 'the first slot comes up next, locked');
  assert.deepEqual(others.map((r) => r.id).sort(), [A, C].sort());
  assert.deepEqual(removedIds, [B]);
  assert.deepEqual(keysOf(kv, B), []);

  // Another wallet, not the open one: nothing stops.
  const a = (await listWallets(kv)).find((r) => r.id === A);
  const open = fakeApp(kv, a);
  await removeWallet(open.app, (await listWallets(kv)).find((r) => r.id === C), { kv, deleteDb: async (id) => deleted.push(walletDbName(id)) });
  assert.deepEqual(open.calls, [], 'the open wallet keeps running');
  assert.equal(open.app.record.id, A);

  // The last one: everything.
  const one = fakeApp(kv, a);
  await removeWallet(one.app, a, { kv, deleteDb: async (id) => deleted.push(walletDbName(id)) });
  assert.equal(kv.m.size, 0);
  assert.equal(one.app.record, null);
  assert.deepEqual(deleted, [`campfire-firo-w-${B}`, `campfire-firo-w-${C}`, `campfire-firo-w-${A}`]);
  await assert.rejects(removeWallet(one.app, a, { kv, deleteDb: async () => {} }), (e) => e.code === 'missing');
});

test('deleting leaves less behind (audit A-9): the passkey is reported gone, shown notifications close; the last wallet also takes the Spark cache and the app settings in localStorage', async () => {
  const kv = await threeWallets();
  const withKey = { ...(await listWallets(kv)).find((r) => r.id === B), envelopes: { password: env(B), passkey: { v: 1, kind: 'passkey', credId: 'Y3JlZC1C', prfSalt: 'c2FsdA==' } } };
  await saveRecord(withKey, kv);
  const storage = new Map([['campfire-theme', 'dark'], ['campfire-update-source', '"https://mirror.example/"'], ['campfire-last-update-check', '{}'], ['other-site-thing', 'x']]);
  const ls = { get length() { return storage.size; }, key: (i) => [...storage.keys()][i] ?? null, removeItem: (k) => storage.delete(k) };
  const seen = { signalled: [], closed: 0, sharedCache: 0 };
  const deps = {
    kv,
    deleteDb: async () => {},
    deleteSharedCache: async () => void seen.sharedCache++,
    storage: ls,
    signalPasskeyGone: async (credId) => void seen.signalled.push(credId),
    closeNotifications: async () => void seen.closed++,
  };
  const a = (await listWallets(kv)).find((r) => r.id === A);
  const { app } = fakeApp(kv, a);
  await removeWallet(app, (await listWallets(kv)).find((r) => r.id === B), deps);
  assert.deepEqual(seen.signalled, ['Y3JlZC1C'], "its passkey: the password manager is told it is gone");
  assert.equal(seen.closed, 1, 'notifications already shown are closed');
  assert.equal(seen.sharedCache, 0, 'other wallets still use the Spark cache');
  assert.equal(storage.size, 4, "the app's settings stay while other wallets do");
  await removeWallet(app, (await listWallets(kv)).find((r) => r.id === C), deps);
  assert.deepEqual(seen.signalled, ['Y3JlZC1C'], 'no passkey, nothing to tell');
  await removeWallet(app, (await listWallets(kv)).find((r) => r.id === A), deps);
  assert.equal(seen.sharedCache, 1, 'the last wallet: the Spark cache goes too');
  assert.deepEqual([...storage.keys()], ['other-site-thing'], "the last wallet: Campfire's own localStorage goes (theme, update address)");
  assert.equal(kv.m.size, 0);
});

test('rename: the open wallet in memory and in storage; another wallet in storage; names checked', async () => {
  const kv = await threeWallets();
  const list = await listWallets(kv);
  const a = list.find((r) => r.id === A);
  const { app } = fakeApp(kv, a);
  await renameWallet(app, a, '  Main   wallet ', kv);
  assert.equal(app.record.name, 'Main wallet');
  assert.equal((await kv.get('wallet')).name, 'Main wallet');
  await renameWallet(app, list.find((r) => r.id === B), 'Spending', kv);
  assert.equal((await kv.get(`w:${B}:wallet`)).name, 'Spending');
  assert.deepEqual((await kv.get(`w:${B}:wallet`)).envelopes, rec(B).envelopes, 'envelopes untouched');
  assert.deepEqual((await kv.get(`w:${B}:wallet`)).seed, rec(B).seed, 'sealed words untouched');
  await assert.rejects(renameWallet(app, list.find((r) => r.id === C), 'main WALLET', kv), (e) => e.code === 'name');
});

test("selectWallet refuses while a wallet is open, and loads the chosen one's preferences", async () => {
  const kv = await threeWallets();
  const list = await listWallets(kv);
  const { app } = fakeApp(kv, list[0]);
  await assert.rejects(selectWallet(app, list[1], kv), (e) => e.code === 'open');
  app.dbPass = null;
  const b = list.find((r) => r.id === B);
  await selectWallet(app, b, kv);
  assert.equal(app.record.id, B);
  assert.equal(app.afterUnlock, null);
  assert.equal(app.prefs.backupPromptSnoozedUntil, 9);
});

test('initial and running wallet', () => {
  const list = [{ id: B, slot0: false }, { id: A, slot0: true }, { id: C, slot0: false }];
  assert.equal(initialWallet(list, { lastWalletId: C }).id, C);
  assert.equal(initialWallet(list, { lastWalletId: 'gone' }).id, A);
  assert.equal(initialWallet([{ id: B, slot0: false }], {}).id, B);
  assert.equal(initialWallet([], {}), null);
  assert.equal(runningWallet({ wallet: { run: { walletId: C } } }, list).id, C);
  assert.equal(runningWallet({ wallet: { run: null } }, list), null);
});

test('no balance is kept in storage (audit A-1): an old plaintext one is removed at start, others are not touched', async () => {
  const kv = memKv({ [balanceKey(A)]: { available: '150000000', at: 1 }, [balanceKey(B)]: { available: '7', at: 2 }, [`w:${B}:payments`]: { v: 1 }, prefs: { autoLockMin: 5 } });
  await forgetStoredBalances(kv);
  assert.deepEqual([...kv.m.keys()].sort(), [`w:${B}:payments`, 'prefs'].sort());
  assert.equal(await forgetStoredBalances(memKv()), 0, 'nothing to remove');
  // Nothing in the module writes one any more.
  const src = readFileSync(join(SRC, 'lib', 'wallets.js'), 'utf8');
  assert.ok(!/kv\.set\(balanceKey/.test(src));
});
