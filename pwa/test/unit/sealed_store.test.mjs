// The engine's per-wallet store is sealed (audit A-1): what is written to the database reveals no
// amount, memo, address or txid — in values or in key names — without the wallet's secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sealedStore } from '../../src/lib/sealed_store.js';
import { createBackend } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { addressToScript } from '../../src/lib/firo/address.js';
import { buildSignedTransaction } from '../../src/lib/firo/tx.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { hexToBytes, bytesToHex, sha256d } from '../../src/lib/firo/bytes.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, fakeCoin, headerHex } from '../fixtures/firo_fake_chain.mjs';
import { FakeSpark } from '../fixtures/firo_fake_spark.mjs';

const SECRET = 'ab'.repeat(32);
const OTHER_SECRET = 'cd'.repeat(32);
const MAIN = NETWORKS.main;
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const W = KEYS.vectors[0];
const OTHER = KEYS.vectors[2].addresses[0];
const COIN = 100000000n;

/** Every key and value of a raw store, as one string (what someone who copied the profile reads). */
async function dump(raw) {
  const parts = [];
  for (const k of await raw.keys('')) parts.push(k, JSON.stringify(await raw.get(k), (key, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? bytesToHex(v) : v)));
  return parts.join('\n');
}

test('values keep their types; keys() answers real names; del removes', async () => {
  const raw = createMemoryStore();
  const s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  const v = { n: 5n * COIN, bytes: Uint8Array.of(1, 2, 3), list: [1, 'two', null, { deep: 7n }], memo: 'rent' };
  await s.put('s/coins', v);
  await s.put(`w/t/tx/${'aa'.repeat(32)}`, { hex: '00', height: 5 });
  assert.deepEqual(await s.get('s/coins'), v);
  assert.deepEqual(await s.get(`w/t/tx/${'aa'.repeat(32)}`), { hex: '00', height: 5 });
  assert.deepEqual((await s.keys('w/t/tx/')).sort(), [`w/t/tx/${'aa'.repeat(32)}`]);
  assert.ok(!(await raw.keys('')).some((k) => k.includes('aa'.repeat(32))), 'the txid is not in a key name');
  await s.del(`w/t/tx/${'aa'.repeat(32)}`);
  assert.deepEqual(await s.keys('w/t/tx/'), []);
  assert.equal(await s.get('nothing'), undefined);
});

test('another secret opens nothing; a sealed value moved to another name does not open', async () => {
  const raw = createMemoryStore();
  const s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  await s.put('s/sends', { amount: '123' });
  // Another secret, or another wallet: its header's tag does not match, so the store does not open at all.
  await assert.rejects(sealedStore(raw, { walletId: 'w1', dbPass: OTHER_SECRET }));
  await raw.put('s/coins', await raw.get('s/sends'));
  await assert.rejects(s.get('s/coins'));
  await assert.rejects(sealedStore(raw, { walletId: 'w2', dbPass: SECRET }));
});

test('PN-keys: the header is authenticated: rewritten to "not migrated", planted values are not believed; a header from before tags is tagged once', async () => {
  const raw = createMemoryStore();
  const s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  await s.put('s/sends', { amount: '123' });
  const header = await raw.get('__seal');
  assert.equal(typeof header.tag, 'string');
  // Someone who can write to the profile says "not migrated" and plants a value in the clear.
  await raw.put('__seal', { ...header, migrated: false });
  await raw.put('s/coins', [{ value: '99900000000' }]);
  await assert.rejects(sealedStore(raw, { walletId: 'w1', dbPass: SECRET }), /changed by something other than Firo PWA/);
  // Without its tag too: sealed values are there, so "not migrated" is not believed either. It opens
  // (a 0.1.7 migration cut short looks the same: audit K4, it was refused and the person told to
  // restore), as migrated: the planted value is dropped, the sealed ones kept.
  const { tag, ...untagged } = header;
  void tag;
  await raw.put('__seal', { ...untagged, migrated: false });
  const cut = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  assert.equal((await raw.get('__seal')).migrated, true);
  assert.equal(await cut.get('s/coins'), undefined, 'a value in the clear is not the wallet\'s');
  assert.deepEqual(await cut.get('s/sends'), { amount: '123' });
  // A header from a version before tags that says migrated: taken, tagged, and a planted value dropped.
  await raw.put('s/coins', [{ value: '99900000000' }]);
  await raw.put('__seal', untagged);
  const again = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  assert.equal(typeof (await raw.get('__seal')).tag, 'string');
  assert.equal(await again.get('s/coins'), undefined, 'a value in the clear is not the wallet\'s');
  assert.deepEqual(await again.get('s/sends'), { amount: '123' });
});

test('audit K4: an untagged header is tagged only under a secret that opens what is sealed: a wrong one is refused and tags nothing', async () => {
  const raw = createMemoryStore();
  const s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  await s.put('s/sends', { amount: '1' });
  const { tag, ...untagged } = await raw.get('__seal');
  void tag;
  await raw.put('__seal', untagged);
  await assert.rejects(sealedStore(raw, { walletId: 'w1', dbPass: 'cd'.repeat(32) }), /changed by something other than Firo PWA/);
  assert.equal((await raw.get('__seal')).tag, undefined, 'nothing tagged under the wrong secret');
  const right = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  assert.deepEqual(await right.get('s/sends'), { amount: '1' });
});

test('an older plaintext store is sealed in place the first time it is opened; nothing is lost', async () => {
  const raw = createMemoryStore();
  const txid = 'bb'.repeat(32);
  // Probes with a space: never in base64, hex or the store's JSON.
  const memo = 'secret memo';
  const bytes = 'beef cafe';
  await raw.put('s/coins', [{ value: '500000000', memo, txid }]);
  await raw.put(`w/t/tx/${txid}`, { hex: bytes, height: 9 });
  // Release re-audit 3 RE3-7: the store's random salt is base64, and a random one can contain a
  // short probe made of base64 letters (it did: "A7v/MaPbeefPR/2hAAX6qg=="). Here the salt is made
  // to, every time: a probe must be one no salt, IV, sealed value or hashed key name can contain.
  const real = globalThis.crypto.getRandomValues;
  globalThis.crypto.getRandomValues = (b) => {
    real.call(globalThis.crypto, b);
    if (b.length === 16) b.set([0x6d, 0xe7, 0x9f]); // base64 "beef…"
    return b;
  };
  let s;
  try {
    s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  } finally {
    globalThis.crypto.getRandomValues = real;
  }
  assert.match((await raw.get('__seal')).salt, /^beef/, 'the salt this test makes');
  assert.deepEqual(await s.get('s/coins'), [{ value: '500000000', memo, txid }]);
  assert.deepEqual(await s.keys('w/t/tx/'), [`w/t/tx/${txid}`]);
  assert.deepEqual(await s.get(`w/t/tx/${txid}`), { hex: bytes, height: 9 });
  const d = await dump(raw);
  for (const probe of [memo, bytes]) assert.match(probe, /[^A-Za-z0-9+/=]/, `${probe}: a probe no random salt can contain`);
  assert.ok(!d.includes(memo) && !d.includes(txid) && !d.includes(bytes), d);
});

test('after a real sync of a wallet with private coins, a memo, sends and public transactions, the database reveals none of it', async () => {
  const raw = createMemoryStore();
  const store = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  const chain = new FakeChain();
  const net = new FakeNet();
  const server = net.addServer('wss://fake.example:50004', chain.handler());
  // A second node over the same chain: a public receipt counts once two nodes agree (release re-audit R1-3).
  net.addServer('wss://fake2.example:50004', chain.handler());
  const servers = [{ url: 'wss://fake.example:50004' }, { url: 'wss://fake2.example:50004' }];
  const spark = new FakeSpark();
  const backend = createBackend({ network: 'main', servers, store, spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  // A public payment in, and private coins with a memo.
  const tx = buildSignedTransaction({
    inputs: [{ txid: bytesToHex(sha256d(Uint8Array.of(1, 7))), vout: 0, value: 7n * COIN + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(W.addresses[0].address, MAIN), value: 7n * COIN }],
    locktime: chain.height - 11,
  });
  const publicTxid = chain.addTx(tx.hex, chain.height - 10);
  const mine = fakeCoin();
  spark.own(mine, { value: 3n * COIN, memo: 'for the cabin' });
  chain.addBlock(1, [fakeCoin(), mine]);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.balance.private.available, String(3n * COIN));
  assert.equal(s.balance.public.available, String(7n * COIN));
  const { txid: sentTxid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN), memo: '' }] });
  server.notify('blockchain.headers.subscribe', [{ height: ++chain.height, hex: headerHex(chain.height) }]);
  await backend.waitForSync();
  await backend.close();

  const d = await dump(raw);
  for (const secret of ['for the cabin', W.addresses[0].address, OTHER.address, publicTxid, sentTxid, String(3n * COIN), String(7n * COIN), tx.hex.slice(0, 40)]) {
    assert.ok(!d.includes(secret), `the database reveals ${secret}`);
  }
  // And it all comes back with the secret.
  const again = createBackend({ network: 'main', servers, store: await sealedStore(raw, { walletId: 'w1', dbPass: SECRET }), spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  await again.open({ mnemonic: W.mnemonic });
  await again.waitForSync();
  assert.equal(again.getState().balance.public.available, String(7n * COIN));
  assert.ok(again.getState().txs.some((t) => t.txid === publicTxid));
  await again.close();
});

test('close() reaches the database underneath (else Lock leaves it open and Delete cannot remove it)', async () => {
  let closed = 0;
  const raw = { ...createMemoryStore(), name: 'campfire-firo-w-test', close: async () => void closed++ };
  const s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  assert.equal(typeof s.close, 'function');
  await s.close();
  assert.equal(closed, 1);
  assert.equal(s.name, 'campfire-firo-w-test');
});

// Audit FE-5: once the store is sealed, a value in the clear under a real name is not the wallet's.
test('audit FE-5: after migration, plaintext under real names is not believed (and is removed); keys() does not list it', async () => {
  const raw = createMemoryStore();
  await raw.put(`w/t/tx/${'aa'.repeat(32)}`, { hex: '00', height: 100 });
  await raw.put('s/name-pins', { ALICE: 'sm1real' });
  let s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  assert.deepEqual(await s.get('s/name-pins'), { ALICE: 'sm1real' });
  assert.equal((await raw.get('__seal')).migrated, true);
  // Someone with write access to the profile writes in the clear under the real names.
  await raw.put('s/name-pins', { ALICE: 'sm1attacker' });
  await raw.put(`w/t/tx/${'bb'.repeat(32)}`, { hex: '00', height: 200, proof: 'two-servers' });
  await raw.put('s/progress', { groups: { 1: 999 } });
  s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  assert.equal(await s.get('s/name-pins'), undefined, 'the planted pin is not believed (it overwrote the sealed one: missing, as if deleted)');
  assert.equal(await s.get(`w/t/tx/${'bb'.repeat(32)}`), undefined);
  assert.equal(await s.get('s/progress'), undefined);
  assert.deepEqual(await s.keys('w/t/tx/'), [`w/t/tx/${'aa'.repeat(32)}`]);
  assert.equal(await raw.get('s/progress'), undefined, 'the planted value is removed');
  assert.equal(await raw.get(`w/t/tx/${'bb'.repeat(32)}`), undefined);
});

test('audit FE-5: a header of another version, or a missing one over sealed data, is never silently replaced', async () => {
  const raw = createMemoryStore();
  const s = await sealedStore(raw, { walletId: 'w1', dbPass: SECRET });
  await s.put('s/sends', { amount: '123' });
  const header = await raw.get('__seal');
  await raw.put('__seal', { ...header, v: 2 });
  await assert.rejects(sealedStore(raw, { walletId: 'w1', dbPass: SECRET }), (e) => e.code === 'store-header');
  assert.equal((await raw.get('__seal')).v, 2, 'left as it was');
  await raw.del('__seal');
  await assert.rejects(sealedStore(raw, { walletId: 'w1', dbPass: SECRET }), (e) => e.code === 'store-header');
  assert.equal(await raw.get('__seal'), undefined, 'no new header (and salt) over the sealed data');
  // The original header back: everything opens again.
  await raw.put('__seal', header);
  assert.deepEqual(await (await sealedStore(raw, { walletId: 'w1', dbPass: SECRET })).get('s/sends'), { amount: '123' });
});
