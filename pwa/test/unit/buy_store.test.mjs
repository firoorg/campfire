// Where buys are kept (sealed as the Ethereum wallet's data is): a buy comes
// back as it was saved, saving again replaces it, a wrong key reads and
// writes nothing, a record this version cannot read is kept untouched, and
// nothing in the clear names an address.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealedBuyStore, makeOrder, orderFromJson, orderToJson, withStatus, sameAs, forgetBuyKeys, hasBuys, BUY_RECORD_KEY, BuyStoreError } from '../../src/lib/buy/store.js';
import { FIRO_ADDRESS, BTC_REFUND, DEPOSIT, BTC } from './buy_fakes.mjs';

function memKv() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), set: async (k, v) => void m.set(k, structuredClone(v)) };
}

const DB = 'ab'.repeat(32);
const app = (over = {}) => ({ record: { id: 'w1', imported: false }, dbPass: DB, ...over });

function buy(n = 1, over = {}) {
  return makeOrder({
    depositAddress: `${DEPOSIT}${n}`,
    assetId: BTC,
    symbol: 'BTC',
    chain: 'btc',
    decimals: 8,
    sendAmount: '0.0123',
    sendAmountRaw: 1230000n,
    walletAddress: FIRO_ADDRESS,
    walletId: 'w1',
    refundAddress: BTC_REFUND,
    createdAt: 1791576000000 + n,
    estimate: 1924.60197756,
    deadline: 1791579600000,
    etaSeconds: 810,
    lastState: 'awaiting_deposit',
    ...over,
  });
}

test('a buy comes back as it was saved, newest first; nothing readable in storage', async () => {
  forgetBuyKeys();
  const kv = memKv();
  const s = sealedBuyStore(app(), { kv });
  assert.equal(await hasBuys(kv), false);
  assert.deepEqual(await s.all(), []);
  await s.save(buy(1));
  await s.save(buy(2));
  assert.equal(await hasBuys(kv), true);
  const all = await sealedBuyStore(app(), { kv }).all();
  assert.deepEqual(all.map((o) => o.depositAddress), [`${DEPOSIT}2`, `${DEPOSIT}1`]);
  assert.deepEqual(orderToJson(all[1]), orderToJson(buy(1)));
  assert.equal(all[1].chainName, 'Bitcoin');
  assert.equal(all[1].isOpen, true);
  const raw = JSON.stringify(kv.m.get(BUY_RECORD_KEY));
  for (const secret of [DEPOSIT, BTC_REFUND, FIRO_ADDRESS, '0.0123']) assert.equal(raw.includes(secret), false, secret);
  // A short word can turn up inside random ciphertext by chance: look for it
  // outside the long base64 runs only.
  assert.equal(raw.replace(/[A-Za-z0-9+/=_-]{16,}/g, '').includes('BTC'), false, 'BTC');
});

test('saving again replaces the buy, never adds a second; saves keep their order', async () => {
  const kv = memKv();
  const s = sealedBuyStore(app(), { kv });
  await Promise.all([s.save(buy(1)), s.save(withStatus(buy(1), { state: 'deposit_detected', terminal: false, txid: null, estimate: null, deadline: null }, 5))]);
  const all = await s.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].lastState, 'deposit_detected');
  assert.equal(all[0].updatedAt, 5);
});

test('another password or another wallet: refused, nothing written over', async () => {
  const kv = memKv();
  await sealedBuyStore(app(), { kv }).save(buy(1));
  const before = JSON.stringify(kv.m.get(BUY_RECORD_KEY));
  forgetBuyKeys();
  const wrong = sealedBuyStore(app({ dbPass: 'cd'.repeat(32) }), { kv });
  await assert.rejects(wrong.all(), (e) => e instanceof BuyStoreError && e.code === 'wrong_secret');
  await assert.rejects(wrong.save(buy(2)), (e) => e.code === 'wrong_secret');
  assert.equal(JSON.stringify(kv.m.get(BUY_RECORD_KEY)), before);
  await assert.rejects(sealedBuyStore(app({ record: { id: 'w2' } }), { kv }).all(), (e) => e.code === 'mismatch');
  await assert.rejects(sealedBuyStore(app({ dbPass: null }), { kv }).all(), (e) => e.code === 'locked');
  // An imported wallet's key must be PBKDF2: an HKDF record is refused, not read.
  await assert.rejects(sealedBuyStore(app({ record: { id: 'w1', imported: true }, dbPass: 'a chosen password' }), { kv }).all(), (e) => e.code === 'weak');
});

test('an imported wallet: PBKDF2, 600,000 rounds, the salt kept between writes', async () => {
  forgetBuyKeys();
  const kv = memKv();
  const a = app({ record: { id: 'w9', imported: true }, dbPass: 'a chosen password' });
  const s = sealedBuyStore(a, { kv });
  await s.save(buy(1, { walletId: 'w9' }));
  const first = kv.m.get(BUY_RECORD_KEY);
  assert.equal(first.kdf, 'pbkdf2-sha256');
  assert.equal(first.iterations, 600000);
  await s.save(buy(2, { walletId: 'w9' }));
  assert.equal(kv.m.get(BUY_RECORD_KEY).salt, first.salt);
  forgetBuyKeys();
  assert.equal((await sealedBuyStore(a, { kv }).all()).length, 2);
  // Rounds lowered by someone with the storage: refused.
  kv.m.set(BUY_RECORD_KEY, { ...kv.m.get(BUY_RECORD_KEY), iterations: 1000 });
  await assert.rejects(sealedBuyStore(a, { kv }).all(), (e) => e.code === 'weak');
});

/** The documented sealing, done by hand: HKDF-SHA256(dbPass, salt, info) and the envelope fields as additional data. */
async function crack(env, dbPass) {
  const ikm = Uint8Array.from(dbPass.match(/../g), (x) => parseInt(x, 16));
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: Buffer.from(env.salt, 'base64'), info: new TextEncoder().encode('campfire-firo-buy-data-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ad = new TextEncoder().encode(JSON.stringify([env.v, env.kind, env.walletId, env.kdf, env.iterations || 0, env.salt, 'campfire-firo-buy-data-v1']));
  return {
    open: async () => JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(env.iv, 'base64'), additionalData: ad }, key, Buffer.from(env.ct, 'base64')))),
    seal: async (body) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, new TextEncoder().encode(JSON.stringify(body)));
      return { ...env, iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(new Uint8Array(ct)).toString('base64') };
    },
  };
}

test('a record this version cannot read is kept, untouched, and written back', async () => {
  const kv = memKv();
  await sealedBuyStore(app(), { kv }).save(buy(1));
  const c = await crack(kv.m.get(BUY_RECORD_KEY), DB);
  const body = await c.open();
  assert.equal(body.orders.length, 1);
  const odd = { depositAddress: 'x', future: { shape: true } };
  kv.m.set(BUY_RECORD_KEY, await c.seal({ orders: [...body.orders, odd], unreadable: [] }));
  const s = sealedBuyStore(app(), { kv });
  assert.deepEqual((await s.all()).map((o) => o.depositAddress), [`${DEPOSIT}1`]);
  await s.save(buy(2));
  const after = await (await crack(kv.m.get(BUY_RECORD_KEY), DB)).open();
  assert.deepEqual(after.unreadable, [odd]);
  assert.equal(after.orders.length, 2);
  // A damaged envelope is not ours to overwrite.
  const broken = memKv();
  broken.m.set(BUY_RECORD_KEY, { hello: 'world' });
  await assert.rejects(sealedBuyStore(app(), { kv: broken }).save(buy(1)), (e) => e.code === 'malformed');
  assert.deepEqual(broken.m.get(BUY_RECORD_KEY), { hello: 'world' });
});

test('withStatus and sameAs: only what the person can see counts as a change', () => {
  const a = buy(1);
  const same = withStatus(a, { state: 'awaiting_deposit', terminal: false, txid: null, estimate: null, deadline: null }, 99);
  assert.equal(sameAs(a, same), true);
  const done = withStatus(a, { state: 'delivered', terminal: true, txid: 'tx1', estimate: 1.5, deadline: null }, 99);
  assert.equal(sameAs(a, done), false);
  assert.equal(done.isOpen, false);
  assert.equal(done.estimate, 1.5);
  assert.equal(done.deadline, a.deadline, 'kept when the status has none');
  assert.equal(orderFromJson(orderToJson(done)).txid, 'tx1');
});
