// The address book (lib/contacts.js): one sealed record per wallet under
// w:<wallet id>:payments; names and Firo addresses checked; a contact never
// changes unless the person changes it (a tampered record does not open and is
// never written over); look-alike addresses are told apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newDbPassword } from '../../src/lib/envelope.js';
import * as C from '../../src/lib/contacts.js';
import { SPARK, TRANSPARENT, EXCHANGE } from './helpers/firo_samples.mjs';

const A1 = TRANSPARENT;
const A2 = 'aKmNpQrStUvWxYz123456789ABCDEFGHJK';
const LOOK = `${A1.slice(0, 6)}${'z'.repeat(22)}${A1.slice(-6)}`; // starts and ends like A1

function memKv() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), set: async (k, v) => void m.set(k, structuredClone(v)) };
}

test('names and addresses as they are kept', () => {
  assert.equal(C.cleanName('  Alice \n Smith '), 'Alice Smith');
  assert.equal([...C.cleanName('x'.repeat(99))].length, C.NAME_MAX);
  assert.equal(C.cleanAddress(` ${A1.slice(0, 20)}\n${A1.slice(20)} `), A1);
  assert.equal(C.looksLikeAddress(A1), true);
  assert.equal(C.looksLikeAddress(SPARK), true);
  assert.equal(C.looksLikeAddress(EXCHANGE), true);
  assert.equal(C.looksLikeAddress('@alice'), true, 'a Spark name');
  assert.equal(C.cleanAddress(SPARK.toUpperCase()), SPARK, 'a Spark address is kept in lower case');
  assert.equal(C.looksLikeAddress('short'), false);
  assert.equal(C.looksLikeAddress('alice'), false, 'a name needs its @');
  assert.equal(C.looksLikeAddress(`${A1}<`), false);
  assert.equal(C.looksLikeAddress('3f25d94eac4a95f4ff2b764f844aa588254982c6bcc83e02f157218d698c9df9477'), false, 'not a Firo address');
  assert.equal(C.paymentsKey('a1a1a1a1a1a1a1a1'), 'w:a1a1a1a1a1a1a1a1:payments', 'one record per wallet');
});

test('checkContact: a name, a real-looking address, no duplicate address', () => {
  const list = [{ id: '0'.repeat(16), name: 'Alice', address: A1 }];
  assert.equal(C.checkContact({ name: '', address: A2 }, list).field, 'name');
  assert.equal(C.checkContact({ name: 'Bob', address: '' }, list).field, 'address');
  assert.match(C.checkContact({ name: 'Bob', address: 'hello' }, list).problem, /isn't a Firo address/);
  const dup = C.checkContact({ name: 'Bob', address: A1 }, list);
  assert.equal(dup.code, 'duplicate');
  assert.match(dup.problem, /already saved as Alice/);
  assert.equal(C.checkContact({ name: 'Alice 2', address: A1 }, list, { editingId: '0'.repeat(16) }).ok, true, 'editing keeps its own address');
  assert.deepEqual(C.checkContact({ name: ' Bob ', address: ` ${A2} ` }, list), { ok: true, name: 'Bob', address: A2 });
});

test('find, look-alike, sort and search', () => {
  const list = [{ id: 'a', name: 'bob', address: A2 }, { id: 'b', name: 'Alice', address: A1 }];
  assert.equal(C.findByAddress(list, ` ${A1}`).name, 'Alice');
  assert.equal(C.findByAddress(list, LOOK), null);
  assert.equal(C.lookalikeOf(list, LOOK).name, 'Alice', 'same start and end, different middle');
  assert.equal(C.lookalikeOf(list, A1), null, 'the saved address itself is no look-alike');
  assert.equal(C.lookalikeOf(list, 'f'.repeat(70)), null);
  assert.deepEqual(C.sortContacts(list).map((c) => c.name), ['Alice', 'bob']);
  assert.deepEqual(C.searchContacts(list, 'BO').map((c) => c.name), ['bob']);
  assert.deepEqual(C.searchContacts(list, A1.slice(-8)).map((c) => c.name), ['Alice']);
});

for (const imported of [false, true]) {
  test(`the sealed record round-trips (${imported ? 'a chosen-password secret: PBKDF2' : 'a random secret: HKDF'}), per wallet, and keeps Receive's address`, async () => {
    const kv = memKv();
    const dbPass = imported ? 'a chosen password' : newDbPassword();
    const v = new C.PaymentsVault({ kv, walletId: 'a1a1a1a1a1a1a1a1', imported, dbPass });
    assert.deepEqual(await v.contacts(), []);
    const a = await v.add({ name: 'Alice', address: A1 }, 1000);
    await v.add({ name: 'Bob', address: A2 }, 2000);
    await assert.rejects(v.add({ name: 'Eve', address: A1 }), (e) => e.code === 'duplicate');
    await v.setReceiveAddress(A2);
    assert.deepEqual([...kv.m.keys()], ['w:a1a1a1a1a1a1a1a1:payments']);
    const env = kv.m.get('w:a1a1a1a1a1a1a1a1:payments');
    assert.equal(env.kdf, imported ? C.KDF_PBKDF2 : C.KDF_HKDF);
    if (imported) assert.equal(env.iterations, 600000);
    assert.ok(!JSON.stringify(env).includes('Alice') && !JSON.stringify(env).includes(A1.slice(10, 30)), 'nothing in the clear');
    const again = new C.PaymentsVault({ kv, walletId: 'a1a1a1a1a1a1a1a1', imported, dbPass });
    const list = await again.contacts();
    assert.deepEqual(list.map((c) => [c.name, c.address]), [['Alice', A1], ['Bob', A2]]);
    assert.equal(await again.receiveAddress(), A2);
    const b = await again.update(a.id, { name: 'Alice S', address: A1 }, 3000);
    assert.equal(b.updatedAt, 3000);
    assert.equal(b.createdAt, 1000);
    assert.equal(await again.remove(a.id), true);
    assert.deepEqual((await again.contacts()).map((c) => c.name), ['Bob']);
    await assert.rejects(again.update(a.id, { name: 'x', address: A1 }), (e) => e.code === 'gone');
  });
}

test('another key, another wallet or an edited record: refused, and nothing is written over', async () => {
  const kv = memKv();
  const dbPass = newDbPassword();
  const v = new C.PaymentsVault({ kv, walletId: 'a1a1a1a1a1a1a1a1', imported: false, dbPass });
  await v.add({ name: 'Alice', address: A1 });
  const before = JSON.stringify(kv.m.get('w:a1a1a1a1a1a1a1a1:payments'));
  const wrong = new C.PaymentsVault({ kv, walletId: 'a1a1a1a1a1a1a1a1', imported: false, dbPass: newDbPassword() });
  await assert.rejects(wrong.contacts(), (e) => e.code === 'wrong_secret');
  await assert.rejects(wrong.add({ name: 'Mallory', address: A2 }), (e) => e.code === 'wrong_secret');
  assert.equal(JSON.stringify(kv.m.get('w:a1a1a1a1a1a1a1a1:payments')), before, 'not written over');
  // The same record placed under another wallet's key.
  kv.m.set('w:b2b2b2b2b2b2b2b2:payments', kv.m.get('w:a1a1a1a1a1a1a1a1:payments'));
  await assert.rejects(new C.PaymentsVault({ kv, walletId: 'b2b2b2b2b2b2b2b2', imported: false, dbPass }).contacts(), (e) => e.code === 'wrong_secret');
  // Someone swaps a byte of the sealed contacts: it does not open (no silent change).
  const env = structuredClone(kv.m.get('w:a1a1a1a1a1a1a1a1:payments'));
  const ct = Buffer.from(env.ct, 'base64');
  ct[5] ^= 1;
  env.ct = ct.toString('base64');
  kv.m.set('w:a1a1a1a1a1a1a1a1:payments', env);
  await assert.rejects(new C.PaymentsVault({ kv, walletId: 'a1a1a1a1a1a1a1a1', imported: false, dbPass }).contacts(), (e) => e.code === 'wrong_secret');
  // A lowered round count or a swapped key derivation is refused before any key is made.
  const kv2 = memKv();
  const v2 = new C.PaymentsVault({ kv: kv2, walletId: 'c3c3c3c3c3c3c3c3', imported: true, dbPass: 'pw' });
  await v2.add({ name: 'A', address: A1 });
  const e2 = structuredClone(kv2.m.get('w:c3c3c3c3c3c3c3c3:payments'));
  kv2.m.set('w:c3c3c3c3c3c3c3c3:payments', { ...e2, iterations: 1000 });
  await assert.rejects(new C.PaymentsVault({ kv: kv2, walletId: 'c3c3c3c3c3c3c3c3', imported: true, dbPass: 'pw' }).contacts(), (e) => e.code === 'weak');
  kv2.m.set('w:c3c3c3c3c3c3c3c3:payments', { ...e2, kdf: C.KDF_HKDF });
  await assert.rejects(new C.PaymentsVault({ kv: kv2, walletId: 'c3c3c3c3c3c3c3c3', imported: true, dbPass: 'pw' }).contacts(), (e) => e.code === 'weak');
  kv2.m.set('w:c3c3c3c3c3c3c3c3:payments', { ...e2, salt: Buffer.alloc(16, 7).toString('base64') });
  await assert.rejects(new C.PaymentsVault({ kv: kv2, walletId: 'c3c3c3c3c3c3c3c3', imported: true, dbPass: 'pw' }).contacts(), (e) => e.code === 'wrong_secret');
});

test('vaultFor: one vault per unlocked wallet; a lock forgets it; locked or no wallet refused', async () => {
  const kv = memKv();
  const app = { record: { id: 'd9d9d9d9d9d9d9d9', imported: false }, dbPass: newDbPassword(), lockHooks: new Set() };
  const v1 = await C.vaultFor(app, kv);
  assert.equal(await C.vaultFor(app, kv), v1);
  await v1.add({ name: 'Alice', address: A1 });
  await C.loadContacts(app);
  assert.equal(C.contactNameFor(A1), 'Alice');
  assert.equal(app.lockHooks.size, 1);
  for (const f of app.lockHooks) f();
  assert.equal(C.cachedContacts(), null);
  assert.equal(C.contactNameFor(A1), null);
  assert.notEqual(await C.vaultFor(app, kv), v1);
  await assert.rejects(C.vaultFor({ record: { id: 'd9d9d9d9d9d9d9d9' }, dbPass: null }, kv), (e) => e.code === 'locked');
  await assert.rejects(C.vaultFor({ record: null, dbPass: 'x' }, kv), (e) => e.code === 'missing');
});
