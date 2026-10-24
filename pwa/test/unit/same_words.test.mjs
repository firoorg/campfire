// The same recovery words (and passphrase) added twice made two wallets, each with its own payment
// records: neither knew what the other had spent (public audit, PN). A fingerprint of the words is
// kept with each record; a second wallet from them is refused, and Restore says so first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIndexedDB, IDBKeyRangeStub } from './helpers/fake_idb.mjs';

globalThis.indexedDB = fakeIndexedDB();
globalThis.IDBKeyRange = IDBKeyRangeStub;

const { wordsFingerprint, walletWithWords } = await import('../../src/lib/session.js');
const { saveRecord } = await import('../../src/lib/wallets.js');

const WORDS = `${'abandon '.repeat(11)}about`;

test('the fingerprint: same words and passphrase, same print; another passphrase, another wallet', async () => {
  const a = await wordsFingerprint(WORDS, '');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(await wordsFingerprint(`  ${WORDS.toUpperCase()} `, ''), a, 'as typed or pasted');
  assert.notEqual(await wordsFingerprint(WORDS, 'extra'), a);
  assert.ok(!a.includes('abandon'));
});

test('audit K2: taken from the BIP39 seed (2,048 rounds), never a fast hash of the words: the BIP39 test vector', async () => {
  const { createHash } = await import('node:crypto');
  // BIP39's own vector: these words with passphrase TREZOR give this seed.
  const seed = Buffer.from('c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04', 'hex');
  const want = createHash('sha256').update(Buffer.concat([Buffer.from('campfire-firo-words-v2\n'), seed])).digest('hex').slice(0, 32);
  assert.equal(await wordsFingerprint(WORDS, 'TREZOR'), want);
});

test('a wallet already here from these words is found; one from other words or another passphrase is not', async () => {
  const fp = await wordsFingerprint(WORDS, '');
  await saveRecord({ id: 'aaaaaaaaaaaaaaaa', name: 'Main', createdAt: 1, words: 12, wordsFp: fp, envelopes: { password: { v: 2 }, passkey: null } });
  assert.equal((await walletWithWords(WORDS.split(' '), ''))?.name, 'Main');
  assert.equal(await walletWithWords(WORDS.split(' '), 'extra'), null);
  assert.equal(await walletWithWords(`${'zoo '.repeat(11)}wrong`.split(' '), ''), null);
});
