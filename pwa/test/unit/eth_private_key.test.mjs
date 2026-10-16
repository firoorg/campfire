// An Ethereum wallet from a private key: telling a key from words in the one
// import box, checking it is a secp256k1 scalar (0 < k < n), the address it
// opens, sealing it exactly like a words wallet's key, and records written
// before private keys existed still opening as words wallets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secretKind, normalizePrivateKey, privateKeyProblem, privateKeyFromText, privateKeyToAddress, signDigest, recoverAddress, keccak256, ethKeyFromMnemonic, EthKeyError } from '../../src/lib/eth/crypto.js';
import { saveEthKey, getEthRecord, openEthKeyFor, withEthKey, ethRecordKind, VaultError, KDF_HKDF, KDF_PBKDF2, ETH_RECORD_KEY } from '../../src/lib/eth/vault.js';
import { ethWalletKind, hasEthWallet } from '../../src/lib/eth/record.js';
import { ethWallet, forgetEthWallet } from '../../src/lib/eth/wallet.js';
import { bytesToHex } from '../../src/lib/eth/hex.js';
import { newDbPassword, PBKDF2_MIN_ITERATIONS } from '../../src/lib/envelope.js';

// The web3.js documentation key: public, never fund it.
const DOC_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const DOC_ADDRESS = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const JUNK = 'test test test test test test test test test test test junk';
const hex64 = (n) => n.toString(16).padStart(64, '0');
const memoryKv = () => {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)), del: async (k) => void m.delete(k) };
};

test('one box: a private key is told from words without asking', () => {
  for (const t of [DOC_KEY, DOC_KEY.slice(2), DOC_KEY.toUpperCase(), `0X${DOC_KEY.slice(2)}`, `  ${DOC_KEY}\n`, '0x', '0x12', 'abc1', DOC_KEY.slice(0, 40), `${DOC_KEY}ab`, `${DOC_KEY.slice(0, 30)}g${DOC_KEY.slice(31)}`, 'deadbeefcafe']) {
    assert.equal(secretKind(t), 'key', JSON.stringify(t));
  }
  // BIP39 words have no digits and at most 8 letters: a first word made of a-f
  // ("add", "face", "decade") is still words, and so is anything with a space.
  for (const t of [JUNK, 'add', 'face', 'decade', 'abandon', 'add face', `${DOC_KEY.slice(2, 34)} ${DOC_KEY.slice(34)}`]) {
    assert.equal(secretKind(t), 'words', JSON.stringify(t));
  }
  assert.equal(secretKind(''), 'empty');
  assert.equal(secretKind(' \n\t'), 'empty');
});

test('a private key is 64 hex characters (0x optional, any case, spaces trimmed) and 0 < k < n', () => {
  for (const t of [DOC_KEY, DOC_KEY.slice(2), DOC_KEY.toUpperCase(), `0X${DOC_KEY.slice(2).toUpperCase()}`, `\t ${DOC_KEY} \n`]) {
    assert.equal(privateKeyProblem(t), null, JSON.stringify(t));
    assert.equal(normalizePrivateKey(t), DOC_KEY.slice(2));
  }
  assert.deepEqual(privateKeyProblem(DOC_KEY.slice(0, -1)), { code: 'format', length: 63, hex: true });
  assert.deepEqual(privateKeyProblem(`${DOC_KEY}0`), { code: 'format', length: 65, hex: true });
  assert.deepEqual(privateKeyProblem(`${DOC_KEY.slice(0, -1)}g`), { code: 'format', length: 64, hex: false });
  assert.deepEqual(privateKeyProblem('0x'), { code: 'format', length: 0, hex: true });
  assert.deepEqual(privateKeyProblem(`0x 12`), { code: 'format', length: 3, hex: false });
  // The scalar range: zero, the group order n and above are not keys; 1 and n - 1 are.
  assert.deepEqual(privateKeyProblem(hex64(0n)), { code: 'range' });
  assert.deepEqual(privateKeyProblem(hex64(N)), { code: 'range' });
  assert.deepEqual(privateKeyProblem(hex64(N + 1n)), { code: 'range' });
  assert.deepEqual(privateKeyProblem('f'.repeat(64)), { code: 'range' });
  assert.equal(privateKeyProblem(hex64(1n)), null);
  assert.equal(privateKeyProblem(hex64(N - 1n)), null);
  assert.equal(privateKeyToAddress(privateKeyFromText(hex64(1n))), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', 'k = 1: the generator point');
  assert.throws(() => privateKeyFromText(hex64(N)), (e) => e instanceof EthKeyError && e.code === 'key' && /not valid/.test(e.message));
  assert.throws(() => privateKeyFromText('0x1234'), (e) => e instanceof EthKeyError && e.code === 'key');
});

test('the web3.js documentation key opens its documented address, and signs as it', () => {
  const sk = privateKeyFromText(`  ${DOC_KEY.toUpperCase().replace('0X', '0x')} `);
  assert.equal(sk.length, 32);
  assert.equal(bytesToHex(sk), DOC_KEY);
  assert.equal(privateKeyToAddress(sk), DOC_ADDRESS);
  const digest = keccak256('a key wallet signs like any other');
  assert.equal(recoverAddress(digest, signDigest(digest, sk)), DOC_ADDRESS);
});

for (const imported of [false, true]) {
  test(`vault: a key wallet round trip (${imported ? 'a chosen secret, PBKDF2' : 'created wallet, HKDF'}); the same envelope as words`, async () => {
    const kv = memoryKv();
    const app = { record: { id: 'w-key', imported }, dbPass: imported ? 'a password a person chose' : newDbPassword(), prefs: {} };
    const sk = privateKeyFromText(DOC_KEY);
    const record = await saveEthKey(app, { sk, address: DOC_ADDRESS, kind: 'key' }, { kv });
    assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'envelope', 'id', 'kind', 'v']);
    assert.equal(record.kind, 'key');
    assert.equal(ethRecordKind(record), 'key');
    assert.equal(await ethWalletKind(kv), 'key');
    assert.equal(record.envelope.kind, 'eth-key');
    assert.equal(record.envelope.kdf, imported ? KDF_PBKDF2 : KDF_HKDF);
    if (imported) assert.equal(record.envelope.iterations, PBKDF2_MIN_ITERATIONS);
    const stored = JSON.stringify(kv.m.get(ETH_RECORD_KEY)).toLowerCase();
    assert.ok(!stored.includes(DOC_KEY.slice(2)), 'no key in the clear');
    assert.ok(!stored.includes(DOC_ADDRESS.slice(2).toLowerCase()), 'no address in the clear');

    // The same envelope as a words wallet's, field for field.
    const wordsKv = memoryKv();
    const junk = await ethKeyFromMnemonic(JUNK);
    const words = await saveEthKey(app, { sk: junk.sk, address: junk.address, words: 12 }, { kv: wordsKv });
    assert.deepEqual(Object.keys(record.envelope).sort(), Object.keys(words.envelope).sort());

    let seen;
    const signed = await withEthKey(app, async (k) => {
      seen = k.sk;
      assert.equal(k.address, DOC_ADDRESS);
      const d = keccak256('send');
      return recoverAddress(d, signDigest(d, k.sk));
    }, kv);
    assert.equal(signed, DOC_ADDRESS);
    assert.ok(seen.every((b) => b === 0), 'zeroed after use');
    await assert.rejects(openEthKeyFor({ ...app, dbPass: null }, kv), (e) => e.code === 'locked');
    const w = await ethWallet(app, { kv });
    assert.equal(w.state.address, DOC_ADDRESS, 'the wallet object opens it like any other');
    forgetEthWallet();
  });
}

test('vault: kinds are checked when saving and when opening', async () => {
  const kv = memoryKv();
  const app = { record: { id: 'w-k', imported: false }, dbPass: newDbPassword() };
  const sk = privateKeyFromText(DOC_KEY);
  await assert.rejects(saveEthKey(app, { sk, address: DOC_ADDRESS, kind: 'key', words: 12 }, { kv }), (e) => e instanceof VaultError && e.code === 'malformed');
  await assert.rejects(saveEthKey(app, { sk, address: DOC_ADDRESS, kind: 'key', passphrase: true }, { kv }), (e) => e.code === 'malformed');
  await assert.rejects(saveEthKey(app, { sk, address: DOC_ADDRESS, kind: 'seed' }, { kv }), (e) => e.code === 'malformed');
  await assert.rejects(saveEthKey(app, { sk, address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', kind: 'key' }, { kv }), (e) => e.code === 'mismatch');
  assert.equal(await hasEthWallet(kv), false, 'nothing saved by a refusal');
  // Imported words: any BIP39 length; still not 13.
  await saveEthKey(app, { sk, address: DOC_ADDRESS, words: 18 }, { kv });
  assert.equal((await getEthRecord(kv)).words, 18);
  await assert.rejects(saveEthKey(app, { sk, address: DOC_ADDRESS, words: 13 }, { kv, replace: true }), (e) => e.code === 'malformed');
  const record = await saveEthKey(app, { sk, address: DOC_ADDRESS, kind: 'key' }, { kv, replace: true });
  kv.m.set(ETH_RECORD_KEY, { ...record, kind: 'seed' });
  assert.equal(await ethWalletKind(kv), null);
  await assert.rejects(openEthKeyFor(app, kv), (e) => e.code === 'malformed', 'an unknown kind does not open');
  assert.equal(ethRecordKind(null), null);
});

