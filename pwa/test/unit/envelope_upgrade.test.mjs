// A wallet whose password envelope is of the old kind (PBKDF2, as 0.1.7 and before made it) is
// sealed again under scrypt the first time its password is typed in this version (public audit,
// P9), on the device, with nothing else changing; a wrong password changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIndexedDB, IDBKeyRangeStub } from './helpers/fake_idb.mjs';

globalThis.indexedDB = fakeIndexedDB();
globalThis.IDBKeyRange = IDBKeyRangeStub;

const { openWithPasswordFor } = await import('../../src/lib/session.js');
const { saveRecord, listWallets } = await import('../../src/lib/wallets.js');
const { sealWithPassword, newDbPassword } = await import('../../src/lib/envelope.js');

test('an old (PBKDF2) envelope becomes scrypt once the password is typed; a wrong one changes nothing', async () => {
  const secret = newDbPassword();
  const id = '0123456789abcdef';
  const old = await sealWithPassword(secret, 'the right password', id, { kdf: 'pbkdf2' });
  const app = { record: { id, name: 'Old', envelopes: { password: old, passkey: null } } };
  await saveRecord(app.record);
  await assert.rejects(openWithPasswordFor(app, 'a wrong password'), (e) => e.code === 'wrong_secret');
  assert.equal(app.record.envelopes.password, old, 'nothing changed');
  assert.equal(await openWithPasswordFor(app, 'the right password'), secret);
  const now = app.record.envelopes.password;
  assert.deepEqual([now.v, now.kdf, now.N], [2, 'scrypt', 2 ** 16]);
  const saved = (await listWallets()).find((w) => w.id === id);
  assert.equal(saved.envelopes.password.kdf, 'scrypt', 'kept on the device');
  // It opens with the same password, and is not sealed again.
  assert.equal(await openWithPasswordFor(app, 'the right password'), secret);
  assert.equal(app.record.envelopes.password, now);
});
