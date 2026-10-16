// Where sells are kept (sealed as the buys are, under the wallet's own
// 'w:<id>:sell' key): a sell comes back as it was saved, saving again replaces
// it, a wrong key reads and writes nothing, a record this version cannot read
// is kept untouched, nothing in the clear names an address or an amount, and
// "this wallet paid it" survives a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealedSellStore, sellRecordKey, makeOrder, orderFromJson, orderToJson, withStatus, withSending, withSent, sameAs, forgetSellKeys, hasSells, SellStoreError, SELL_DATA_INFO } from '../../src/lib/sell/store.js';
import { DEFAULT_PAYOUT } from '../../src/lib/sell/sellfiro.js';
import { PAYOUT, SPARK_DEPOSIT, T_DEPOSIT, TXID } from './sell_fakes.mjs';

function memKv() {
  const m = new Map();
  return { m, get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), set: async (k, v) => void m.set(k, structuredClone(v)) };
}

const W1 = '0123456789abcdef';
const W2 = 'fedcba9876543210';
const DB = 'ab'.repeat(32);
const app = (over = {}) => ({ record: { id: W1, imported: false }, dbPass: DB, ...over });
const KEY = `w:${W1}:sell`;

function sell(n = 1, over = {}) {
  return makeOrder({
    orderId: `sell_1791813677_X5n${n}`,
    walletId: W1,
    amount: 50000000000n,
    depositKind: 'spark',
    depositAddress: T_DEPOSIT,
    sparkDepositAddress: SPARK_DEPOSIT,
    payFrom: 'private',
    payout: { ...DEFAULT_PAYOUT, address: PAYOUT, own: true },
    createdAt: 1791813677000 + n,
    receiveUsd: 495.84,
    expiresAt: 1791900077000,
    lastState: 'awaiting_deposit',
    ...over,
  });
}

test("the record lives under the wallet's own key, so deleting the wallet deletes it", () => {
  assert.equal(sellRecordKey(app()), KEY);
  assert.equal(sellRecordKey(app({ record: { id: W2 } })), `w:${W2}:sell`);
  assert.throws(() => sellRecordKey({ record: { id: 'not-an-id' } }));
});

test('a sell comes back as it was saved, newest first; nothing readable in storage', async () => {
  forgetSellKeys();
  const kv = memKv();
  const s = sealedSellStore(app(), { kv });
  assert.equal(await hasSells(kv, KEY), false);
  assert.deepEqual(await s.all(), []);
  await s.save(sell(1));
  await s.save(sell(2));
  assert.equal(await hasSells(kv, KEY), true);
  assert.deepEqual([...kv.m.keys()], [KEY]);
  const all = await sealedSellStore(app(), { kv }).all();
  assert.deepEqual(all.map((o) => o.orderId), ['sell_1791813677_X5n2', 'sell_1791813677_X5n1']);
  assert.deepEqual(orderToJson(all[1]), orderToJson(sell(1)));
  assert.equal(all[1].payout.chainName, 'BNB Chain');
  assert.equal(all[1].isOpen, true);
  assert.equal(all[1].amount, 50000000000n);
  const raw = JSON.stringify(kv.m.get(KEY));
  for (const secret of [SPARK_DEPOSIT, T_DEPOSIT, PAYOUT, PAYOUT.toLowerCase(), 'sell_1791813677', '50000000000']) assert.equal(raw.includes(secret), false, secret);
  // A short word can turn up inside random ciphertext by chance: look for it outside the long base64 runs only.
  assert.equal(raw.replace(/[A-Za-z0-9+/=_-]{16,}/g, '').includes('USDT'), false, 'USDT');
});

test('saving again replaces the sell, never adds a second; saves keep their order', async () => {
  const kv = memKv();
  const s = sealedSellStore(app(), { kv });
  await Promise.all([s.save(sell(1)), s.save(withStatus(sell(1), { state: 'deposit_detected', terminal: false }, 5))]);
  const all = await s.all();
  assert.equal(all.length, 1);
  assert.equal(all[0].lastState, 'deposit_detected');
  assert.equal(all[0].updatedAt, 5);
});

test('another password or another wallet: refused, nothing written over', async () => {
  const kv = memKv();
  await sealedSellStore(app(), { kv }).save(sell(1));
  const before = JSON.stringify(kv.m.get(KEY));
  forgetSellKeys();
  const wrong = sealedSellStore(app({ dbPass: 'cd'.repeat(32) }), { kv });
  await assert.rejects(wrong.all(), (e) => e instanceof SellStoreError && e.code === 'wrong_secret');
  await assert.rejects(wrong.save(sell(2)), (e) => e.code === 'wrong_secret');
  assert.equal(JSON.stringify(kv.m.get(KEY)), before);
  // Another wallet's record put under this key: refused, not read.
  const other = memKv();
  other.m.set(`w:${W2}:sell`, kv.m.get(KEY));
  await assert.rejects(sealedSellStore(app({ record: { id: W2 } }), { kv: other }).all(), (e) => e.code === 'mismatch');
  await assert.rejects(sealedSellStore(app({ dbPass: null }), { kv }).all(), (e) => e.code === 'locked');
  // The wallet switched after the store was made: its writes are refused, never put in the other wallet.
  const a = app();
  const bound = sealedSellStore(a, { kv });
  a.record = { id: W2 };
  await assert.rejects(bound.save(sell(3)), (e) => e.code === 'mismatch');
  // An imported wallet's key must be PBKDF2: an HKDF record is refused, not read.
  await assert.rejects(sealedSellStore(app({ record: { id: W1, imported: true }, dbPass: 'a chosen password' }), { kv }).all(), (e) => e.code === 'weak');
});

test('an imported wallet: PBKDF2, 600,000 rounds, the salt kept between writes', async () => {
  forgetSellKeys();
  const kv = memKv();
  const a = app({ record: { id: W2, imported: true }, dbPass: 'a chosen password' });
  const s = sealedSellStore(a, { kv });
  await s.save(sell(1, { walletId: W2 }));
  const first = kv.m.get(`w:${W2}:sell`);
  assert.equal(first.kdf, 'pbkdf2-sha256');
  assert.equal(first.iterations, 600000);
  await s.save(sell(2, { walletId: W2 }));
  assert.equal(kv.m.get(`w:${W2}:sell`).salt, first.salt);
  forgetSellKeys();
  assert.equal((await sealedSellStore(a, { kv }).all()).length, 2);
  kv.m.set(`w:${W2}:sell`, { ...kv.m.get(`w:${W2}:sell`), iterations: 1000 });
  await assert.rejects(sealedSellStore(a, { kv }).all(), (e) => e.code === 'weak');
});

/** The documented sealing, done by hand: HKDF-SHA256(dbPass, salt, info) and the envelope fields as additional data. */
async function crack(env, dbPass) {
  const ikm = Uint8Array.from(dbPass.match(/../g), (x) => parseInt(x, 16));
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: Buffer.from(env.salt, 'base64'), info: new TextEncoder().encode(SELL_DATA_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ad = new TextEncoder().encode(JSON.stringify([env.v, env.kind, env.walletId, env.kdf, env.iterations || 0, env.salt, SELL_DATA_INFO]));
  return {
    open: async () => JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(env.iv, 'base64'), additionalData: ad }, key, Buffer.from(env.ct, 'base64')))),
    seal: async (body) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, new TextEncoder().encode(JSON.stringify(body)));
      return { ...env, iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(new Uint8Array(ct)).toString('base64') };
    },
  };
}

test('a record this version cannot read is kept, untouched, and written back; a damaged envelope is not overwritten', async () => {
  assert.equal(SELL_DATA_INFO, 'campfire-firo-sell-data-v1');
  const kv = memKv();
  await sealedSellStore(app(), { kv }).save(sell(1));
  const c = await crack(kv.m.get(KEY), DB);
  const body = await c.open();
  assert.equal(body.orders.length, 1);
  const odd = { orderId: 'x', future: { shape: true } };
  kv.m.set(KEY, await c.seal({ orders: [...body.orders, odd], unreadable: [] }));
  const s = sealedSellStore(app(), { kv });
  assert.deepEqual((await s.all()).map((o) => o.orderId), ['sell_1791813677_X5n1']);
  await s.save(sell(2));
  const after = await (await crack(kv.m.get(KEY), DB)).open();
  assert.deepEqual(after.unreadable, [odd]);
  assert.equal(after.orders.length, 2);
  const broken = memKv();
  broken.m.set(KEY, { hello: 'world' });
  await assert.rejects(sealedSellStore(app(), { kv: broken }).save(sell(1)), (e) => e.code === 'malformed');
  assert.deepEqual(broken.m.get(KEY), { hello: 'world' });
});

test('"this wallet paid it" is kept: started, then broadcast; it survives a round trip', async () => {
  const a = sell(1);
  const started = withSending(a, 100);
  assert.equal(started.sendStartedAt, 100);
  assert.equal(withSending(started, 200).sendStartedAt, 100, 'the first start counts');
  assert.equal(sameAs(a, started), false);
  const sent = withSent(started, { txid: 'ab'.repeat(32), from: 'private', at: 150 });
  assert.equal(sent.sentTxid, 'ab'.repeat(32));
  assert.equal(sent.sentFrom, 'private');
  assert.equal(sent.sendStartedAt, 100);
  const back = orderFromJson(orderToJson(sent));
  assert.deepEqual(orderToJson(back), orderToJson(sent));
  const kv = memKv();
  await sealedSellStore(app(), { kv }).save(sent);
  forgetSellKeys();
  assert.equal((await sealedSellStore(app(), { kv }).all())[0].sentTxid, 'ab'.repeat(32));
});

test('withStatus and sameAs: only what the person can see counts as a change; an ending closes it', () => {
  const a = sell(1);
  const same = withStatus(a, { state: 'awaiting_deposit', terminal: false }, 99);
  assert.equal(sameAs(a, same), true);
  const done = withStatus(a, { state: 'delivered', terminal: true, payoutTxid: TXID, payoutExplorer: `https://bscscan.com/tx/${TXID}`, receivedFiro: 499.9, proceedsUsd: 479.5 }, 99);
  assert.equal(sameAs(a, done), false);
  assert.equal(done.isOpen, false);
  assert.equal(done.payoutTxid, TXID);
  assert.equal(orderFromJson(orderToJson(done)).proceedsUsd, 479.5);
  assert.equal(orderFromJson(orderToJson(done)).lastState, 'delivered');
});

test('a stored sell with a field out of shape is not read', () => {
  const j = orderToJson(sell(1));
  for (const [k, v] of [['orderId', ''], ['depositKind', 'lelantus'], ['payFrom', 'both'], ['amount', '-5'], ['amount', 5], ['createdAt', 'x'], ['payout', null], ['payout', { chainId: 'x' }], ['sentFrom', 'elsewhere'], ['receiveUsd', 'many']]) assert.throws(() => orderFromJson({ ...j, [k]: v }), TypeError, k);
});
