// The Ethereum key at rest: sealed under the Firo wallet's secret
// with HKDF (random dbPass) or PBKDF2 >= 600k (a chosen secret), every
// envelope field bound, the address checked again after opening.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealEthKey, openEthKey, saveEthKey, getEthRecord, openEthKeyFor, withEthKey, removeEthKey, kdfFor, VaultError, KDF_HKDF, KDF_PBKDF2, ETH_KEY_INFO, ETH_RECORD_KEY } from '../../src/lib/eth/vault.js';
import { ethKeyFromMnemonic, privateKeyToAddress, ETH_PATH } from '../../src/lib/eth/crypto.js';
import { newDbPassword, PBKDF2_MIN_ITERATIONS } from '../../src/lib/envelope.js';

const JUNK = 'test test test test test test test test test test test junk';
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const dbPass = newDbPassword();
const filePass = 'a password a person chose';
const created = { walletId: 'w-created', imported: false, dbPass };
const imported = { walletId: 'w-imported', imported: true, dbPass: filePass };
const flip = (b64) => {
  const b = Buffer.from(b64, 'base64');
  b[b.length - 1] ^= 1;
  return b.toString('base64');
};
const memoryKv = () => {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => void m.set(k, structuredClone(v)), del: async (k) => void m.delete(k) };
};

test('created wallets: HKDF over the 32 dbPass bytes; round trip; nothing secret in the clear', async () => {
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const env = await sealEthKey({ sk, address, ...created });
  assert.equal(env.kdf, KDF_HKDF);
  assert.equal(env.iterations, undefined);
  assert.equal(env.kind, 'eth-key');
  assert.equal(env.walletId, 'w-created');
  assert.match(env.ethId, /^[0-9a-f]{16}$/);
  assert.equal(ETH_KEY_INFO, 'campfire-firo-eth-key-v1');
  const json = JSON.stringify(env).toLowerCase();
  assert.ok(!json.includes(address.slice(2).toLowerCase()), 'the address is only inside');
  assert.ok(!json.includes(Buffer.from(sk).toString('hex')));
  const opened = await openEthKey(env, created);
  assert.deepEqual(opened.sk, sk);
  assert.equal(opened.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  const again = await sealEthKey({ sk, address, ...created });
  assert.notEqual(again.salt, env.salt);
  assert.notEqual(again.iv, env.iv);
  assert.notEqual(again.ct, env.ct);
});

test('imported wallets: PBKDF2-SHA256 with at least 600,000 rounds over the file password', async () => {
  const { sk, address } = await ethKeyFromMnemonic(ABANDON);
  const env = await sealEthKey({ sk, address, ...imported });
  assert.equal(env.kdf, KDF_PBKDF2);
  assert.equal(env.iterations, PBKDF2_MIN_ITERATIONS);
  assert.ok(env.iterations >= 600000);
  assert.equal((await openEthKey(env, imported)).address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  await assert.rejects(openEthKey(env, { ...imported, dbPass: 'a password a person chosE' }), (e) => e instanceof VaultError && e.code === 'wrong_secret');
  assert.equal(kdfFor(true), KDF_PBKDF2);
  assert.equal(kdfFor(false), KDF_HKDF);
});

test('wrong database password, and a dbPass that is not 32 random bytes for HKDF', async () => {
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const env = await sealEthKey({ sk, address, ...created });
  await assert.rejects(openEthKey(env, { ...created, dbPass: newDbPassword() }), (e) => e.code === 'wrong_secret');
  await assert.rejects(openEthKey(env, { ...created, dbPass: '' }), (e) => e.code === 'locked');
  await assert.rejects(sealEthKey({ sk, address, ...created, dbPass: 'a person’s password' }), (e) => e.code === 'malformed');
});

test('tampering with any envelope field is caught', async () => {
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const env = await sealEthKey({ sk, address, ...created });
  const bad = async (patch, code) => assert.rejects(openEthKey({ ...env, ...patch }, created), (e) => e instanceof VaultError && e.code === code, JSON.stringify(patch));
  await bad({ ct: flip(env.ct) }, 'wrong_secret');
  await bad({ iv: flip(env.iv) }, 'wrong_secret');
  await bad({ salt: flip(env.salt) }, 'wrong_secret');
  await bad({ ethId: '0000000000000000' }, 'wrong_secret');
  await bad({ v: 2 }, 'malformed');
  await bad({ kind: 'password' }, 'malformed');
  await bad({ iterations: 600000 }, 'malformed');
  // Another wallet's id: refused outright, and binding means a rewrite cannot help.
  await bad({ walletId: 'w-other' }, 'mismatch');
  await assert.rejects(openEthKey({ ...env, walletId: 'w-other' }, { ...created, walletId: 'w-other' }), (e) => e.code === 'wrong_secret');
});

test('KDF downgrades are refused: HKDF for an imported wallet, fewer than 600,000 rounds', async () => {
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const hkdfEnv = await sealEthKey({ sk, address, ...created });
  // An HKDF envelope presented for an imported (password) wallet would be one guess away.
  await assert.rejects(openEthKey({ ...hkdfEnv, walletId: imported.walletId }, imported), (e) => e.code === 'weak');
  await assert.rejects(sealEthKey({ sk, address, ...imported, iterations: 100000 }), (e) => e.code === 'weak');
  const pbkdf = await sealEthKey({ sk, address, ...imported });
  await assert.rejects(openEthKey({ ...pbkdf, iterations: 1000 }, imported), (e) => e.code === 'weak');
  await assert.rejects(openEthKey({ ...pbkdf, iterations: 1e12 }, imported), (e) => e.code === 'malformed');
  await assert.rejects(openEthKey({ ...pbkdf, kdf: KDF_HKDF }, imported), (e) => e.code === 'weak');
  await assert.rejects(openEthKey(pbkdf, { ...created, walletId: imported.walletId }), (e) => e.code === 'malformed', 'and the reverse');
});

test('the address is checked: at sealing, and again after opening', async () => {
  const junk = await ethKeyFromMnemonic(JUNK);
  const abandon = await ethKeyFromMnemonic(ABANDON);
  await assert.rejects(sealEthKey({ sk: junk.sk, address: abandon.address, ...created }), (e) => e.code === 'mismatch');
  await assert.rejects(sealEthKey({ sk: new Uint8Array(32), address: junk.address, ...created }), (e) => e.code === 'mismatch');
  // An envelope whose plaintext pairs a key with another address (as if written by
  // a buggy or hostile build) does not open as either.
  const subtle = globalThis.crypto.subtle;
  const env = await sealEthKey({ sk: junk.sk, address: junk.address, ...created });
  const base = await subtle.importKey('raw', Buffer.from(dbPass, 'hex'), 'HKDF', false, ['deriveKey']);
  const kek = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: Buffer.from(env.salt, 'base64'), info: new TextEncoder().encode(ETH_KEY_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const aad = new TextEncoder().encode(JSON.stringify([env.v, env.kind, env.walletId, env.ethId, env.kdf, 0, env.salt]));
  const pt = Buffer.concat([Buffer.from(junk.sk), Buffer.from(abandon.address.slice(2), 'hex')]);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv: Buffer.from(env.iv, 'base64'), additionalData: aad }, kek, pt);
  await assert.rejects(openEthKey({ ...env, ct: Buffer.from(ct).toString('base64') }, created), (e) => e.code === 'mismatch');
});

test('adapter: stored next to the wallet record, opened only while unlocked, key zeroed after use', async () => {
  const kv = memoryKv();
  const app = { record: { id: 'w1', imported: false }, dbPass: newDbPassword() };
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const record = await saveEthKey(app, { sk, address, words: 12, passphrase: false }, { kv });
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'envelope', 'id', 'kind', 'passphrase', 'path', 'v', 'words']);
  assert.equal(record.kind, 'words');
  assert.equal(record.path, ETH_PATH);
  assert.equal(record.id, record.envelope.ethId);
  assert.deepEqual([...kv.m.keys()], [ETH_RECORD_KEY]);
  assert.ok(!JSON.stringify(kv.m.get('eth')).toLowerCase().includes(address.slice(2).toLowerCase()), 'no address in the clear');
  assert.deepEqual(await getEthRecord(kv), record);
  await assert.rejects(saveEthKey(app, { sk, address, words: 12 }, { kv }), (e) => e.code === 'exists', 'never replaced silently');
  await assert.rejects(saveEthKey(app, { sk, address, words: 13 }, { kv, replace: true }), (e) => e.code === 'malformed');

  let seen;
  const out = await withEthKey(app, async (k) => {
    seen = k.sk;
    assert.equal(privateKeyToAddress(k.sk), address);
    return k.address;
  }, kv);
  assert.equal(out, address);
  assert.ok(seen.every((b) => b === 0), 'the key is zeroed after use');
  await assert.rejects(withEthKey(app, async () => { throw new Error('signing failed'); }, kv), /signing failed/);

  const opened = await openEthKeyFor(app, kv);
  assert.equal(opened.address, address);
  await assert.rejects(openEthKeyFor({ ...app, dbPass: null }, kv), (e) => e.code === 'locked');
  await assert.rejects(openEthKeyFor({ record: null, dbPass: app.dbPass }, kv), (e) => e.code === 'missing');
  await assert.rejects(openEthKeyFor({ ...app, record: { id: 'w2' } }, kv), (e) => e.code === 'mismatch');
  await assert.rejects(openEthKeyFor({ ...app, record: { id: 'w1', imported: true } }, kv), (e) => e.code === 'weak');
  kv.m.set('eth', { ...record, id: 'swapped' });
  await assert.rejects(openEthKeyFor(app, kv), (e) => e.code === 'malformed');
  await removeEthKey(kv);
  assert.equal(await getEthRecord(kv), null);
  await assert.rejects(openEthKeyFor(app, kv), (e) => e.code === 'missing');
});
