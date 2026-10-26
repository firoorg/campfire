// Spark sync data layer against a fake chain: sectors, order, resume, reorgs,
// used tags with overlap, mempool, and the stores (memory and IndexedDB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ElectrumClient } from '../../src/lib/firo/electrum.js';
import { SparkSync, packCoins, unpackCoins, decodeSetEntry, packTags, unpackTags } from '../../src/lib/firo/spark_sync.js';
import { createMemoryStore, createIdbStore, prefixStore } from '../../src/lib/firo/store.js';
import { lTagHash } from '../../src/lib/firo/tx.js';
import { bytesToHex, bytesToBase64, hashToHex, equalBytes } from '../../src/lib/firo/bytes.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, fakeCoin, fakeTag } from '../fixtures/firo_fake_chain.mjs';

const URL1 = 'wss://fake.example:50004';

function setup(chain = new FakeChain(), store = createMemoryStore(), opts = {}) {
  const net = new FakeNet();
  const server = net.addServer(URL1, chain.handler());
  const client = new ElectrumClient({ servers: [URL1], WebSocket: net.WebSocket, pingIntervalMs: 0, timeoutMs: 2000 });
  const sync = new SparkSync({ client, store, sectorSize: 100, ...opts });
  return { chain, store, client, sync, server };
}

const blockOf = (n) => Array.from({ length: n }, () => fakeCoin());
const sameCoins = (got, want) => got.length === want.length && got.every((c, i) => equalBytes(c.coin, want[i].coin) && equalBytes(c.txHash, want[i].txHash) && equalBytes(c.context, want[i].context));
const sectorCalls = (chain) => chain.calls.filter((m) => m === 'spark.getsparkanonymitysetsector').length;

test('packing keeps every byte of every entry, storing the repeated tx hash and context once', () => {
  const entries = [fakeCoin(1), fakeCoin(2)];
  // A coin whose first element does not end with its hash+context is kept whole.
  const odd = { ...fakeCoin(3), coin: new Uint8Array([9, 9, 9]) };
  const packed = packCoins([...entries, odd]);
  const back = unpackCoins(packed);
  assert.ok(sameCoins(back, [...entries, odd]));
  const raw = entries.reduce((s, e) => s + e.coin.length + 32 + e.context.length, 0) + 3 + 32 + odd.context.length;
  assert.ok(packed.length < raw, `${packed.length} < ${raw}`);
  const e = decodeSetEntry([bytesToBase64(entries[0].coin), bytesToBase64(entries[0].txHash), bytesToBase64(entries[0].context)]);
  assert.ok(equalBytes(e.coin, entries[0].coin));
  const tags = [{ lTagHash: 'aa'.repeat(32), txid: 'bb'.repeat(32) }];
  assert.deepEqual(unpackTags(packTags(tags)), tags);
});

test('a group downloads in sectors and is stored oldest first (the reverse of the server list)', async () => {
  const { chain, sync, client } = setup();
  chain.addBlock(3, blockOf(120));
  chain.addBlock(3, blockOf(90));
  chain.addBlock(3, blockOf(40));
  const progress = [];
  const r = await sync.syncGroup(3, { onProgress: (p) => progress.push(p.done) });
  assert.equal(r.size, 250);
  assert.equal(r.added, 250);
  assert.equal(sectorCalls(chain), 3); // 100 + 100 + 50
  assert.deepEqual(progress, [0, 100, 200, 250]);
  const coins = await sync.coins(3);
  assert.ok(sameCoins(coins, chain.campfireOrder(3)));
  assert.deepEqual(coins.map((c) => c.index), [...Array(250).keys()]);
  assert.equal(coins[0].txid, hashToHex(coins[0].txHash));
  const set = await sync.anonymitySet(3);
  assert.equal(set.size, 250);
  assert.equal(set.blockHash, (await client.sparkSetMeta(3)).blockHash);
  // Up to date: only the meta is asked.
  const before = chain.calls.length;
  const again = await sync.syncGroup(3);
  assert.equal(again.added, 0);
  assert.deepEqual(chain.calls.slice(before), ['spark.getsparkanonymitysetmeta']);
  client.close();
});

test('an update fetches only the new coins (and one coin to check nothing changed underneath)', async () => {
  const { chain, sync, client } = setup();
  chain.addBlock(5, blockOf(150));
  await sync.syncGroup(5);
  chain.addBlock(5, blockOf(7));
  chain.addBlock(5, blockOf(5));
  const before = sectorCalls(chain);
  const r = await sync.syncGroup(5);
  assert.equal(r.added, 12);
  assert.equal(sectorCalls(chain) - before, 2); // the check + one sector of 12
  assert.ok(sameCoins(await sync.coins(5), chain.campfireOrder(5)));
  assert.ok(sameCoins(await sync.coins(5, { from: 150 }), chain.campfireOrder(5).slice(150)));
  client.close();
});

test('an interrupted download resumes where it stopped, pinned to its block, then catches up', async () => {
  const store = createMemoryStore();
  const { chain, sync, client } = setup(new FakeChain(), store);
  chain.addBlock(2, blockOf(330));
  let fail = true;
  chain.failSector = (g, start) => fail && start === 200;
  await assert.rejects(sync.syncGroup(2), /sector failed/);
  const st = await sync.groupState(2);
  assert.equal(st.pending.next, 2);
  assert.equal(st.size, 0);
  // Meanwhile a new block arrives; the app restarts (a new SparkSync on the same store).
  chain.addBlock(2, blockOf(20));
  fail = false;
  client.close();
  const again = setup(chain, store);
  const before = sectorCalls(chain);
  const r = await again.sync.syncGroup(2);
  assert.equal(r.size, 350);
  // Two sectors left of the pinned download, then the check and the 20 new coins.
  assert.equal(sectorCalls(chain) - before, 4);
  assert.ok(sameCoins(await again.sync.coins(2), chain.campfireOrder(2)));
  again.client.close();
});

test('a reorg that replaces the newest block re-fetches the group; a shrinking set too', async () => {
  const { chain, sync, client } = setup();
  chain.addBlock(4, blockOf(60));
  chain.addBlock(4, blockOf(10));
  await sync.syncGroup(4);
  chain.reorgLast(4, blockOf(10)); // same size, different coins
  const r = await sync.syncGroup(4);
  assert.equal(r.refetched, true);
  assert.ok(sameCoins(await sync.coins(4), chain.campfireOrder(4)));
  chain.groups.get(4).pop(); // the set shrinks
  const r2 = await sync.syncGroup(4);
  assert.equal(r2.refetched, true);
  assert.equal(r2.size, 60);
  assert.ok(sameCoins(await sync.coins(4), chain.campfireOrder(4)));
  client.close();
});

test('a pinned block that left the chain restarts the update from the new tip', async () => {
  const store = createMemoryStore();
  const { chain, sync, client } = setup(new FakeChain(), store);
  chain.addBlock(6, blockOf(50));
  await sync.syncGroup(6);
  chain.addBlock(6, blockOf(250));
  chain.failSector = (g, start) => start === 100;
  await assert.rejects(sync.syncGroup(6), /sector failed/);
  chain.failSector = null;
  chain.reorgLast(6, blockOf(240)); // the pinned block is gone
  const r = await sync.syncGroup(6);
  assert.equal(r.size, 290);
  assert.ok(sameCoins(await sync.coins(6), chain.campfireOrder(6)));
  client.close();
});

test('used tags: hashed as libspark does, fetched with an overlap, de-duplicated, searchable', async () => {
  const { chain, sync, client } = setup(new FakeChain(), createMemoryStore(), { tagOverlap: 5 });
  for (let i = 0; i < 30; i++) chain.tags.push({ tag: fakeTag(i), txid: bytesToHex(new Uint8Array(32).fill(i)) });
  const r = await sync.syncTags();
  assert.deepEqual(r, { added: 30, count: 30, cursor: 30 });
  for (let i = 30; i < 34; i++) chain.tags.push({ tag: fakeTag(i), txid: bytesToHex(new Uint8Array(32).fill(i)) });
  const r2 = await sync.syncTags();
  assert.deepEqual(r2, { added: 4, count: 34, cursor: 34 });
  const all = await sync.tags();
  assert.equal(all.length, 34);
  assert.equal(new Set(all.map((t) => t.lTagHash)).size, 34);
  assert.equal(all[33].lTagHash, lTagHash(fakeTag(33)));
  const want = [lTagHash(fakeTag(3)), lTagHash(fakeTag(31)), 'cc'.repeat(32)];
  const used = await sync.findUsed(want);
  assert.equal(used.size, 2);
  assert.equal(used.get(lTagHash(fakeTag(31))), bytesToHex(new Uint8Array(32).fill(31)));
  // A short reorg swaps the last tag: the overlap still catches the new one.
  chain.tags.pop();
  chain.tags.push({ tag: fakeTag(99), txid: 'dd'.repeat(32) });
  await sync.syncTags();
  assert.equal((await sync.findUsed([lTagHash(fakeTag(99))])).size, 1);
  client.close();
});

test('a new wallet starts its tags at a checkpoint; a restore later starts the cache over from 0', async () => {
  const { chain, sync, client } = setup();
  for (let i = 0; i < 50; i++) chain.tags.push({ tag: fakeTag(i), txid: '00'.repeat(32) });
  const r = await sync.syncTags({ startAt: 40 });
  assert.equal(r.count, 10);
  assert.equal((await sync.findUsed([lTagHash(fakeTag(2))])).size, 0);
  const r2 = await sync.syncTags({ startAt: 0 });
  assert.equal(r2.count, 50);
  assert.equal((await sync.findUsed([lTagHash(fakeTag(2))])).size, 1);
  client.close();
});

test('mempool: new Spark transactions are fetched once, departed ones forgotten', async () => {
  const { chain, sync, client } = setup();
  const t1 = 'a1'.repeat(32);
  const t2 = 'b2'.repeat(32);
  chain.mempool.set(t1, { coins: [fakeCoin()], lTags: null });
  chain.mempool.set(t2, { coins: [fakeCoin(), fakeCoin()], lTags: [fakeTag(500)], isLocked: true });
  const r = await sync.syncMempool();
  assert.deepEqual(r.added.sort(), [t1, t2].sort());
  assert.equal(r.txs.get(t1).isMint, true);
  assert.deepEqual(r.txs.get(t2).lTagHashes, [lTagHash(fakeTag(500))]);
  assert.equal(r.txs.get(t2).coins.length, 2);
  assert.equal(r.txs.get(t2).isLocked, true);
  chain.mempool.delete(t1);
  const before = chain.calls.filter((m) => m === 'spark.getmempoolsparktxs').length;
  const r2 = await sync.syncMempool();
  assert.deepEqual(r2.removed, [t1]);
  assert.deepEqual(r2.added, []);
  assert.equal(chain.calls.filter((m) => m === 'spark.getmempoolsparktxs').length, before); // nothing new to fetch
  client.close();
});

test('the cache works the same in IndexedDB (fake-indexeddb), behind a prefix', async () => {
  await import('../support/fake-indexeddb/fake-indexeddb.js');
  const idb = createIdbStore('firo-sync-test');
  const store = prefixStore(idb, 'spark/main/');
  const { chain, sync, client } = setup(new FakeChain(), store);
  chain.addBlock(1, blockOf(130));
  for (let i = 0; i < 5; i++) chain.tags.push({ tag: fakeTag(i), txid: '11'.repeat(32) });
  await sync.syncGroup(1);
  await sync.syncTags();
  client.close();
  const again = setup(chain, store);
  assert.ok(sameCoins(await again.sync.coins(1), chain.campfireOrder(1)));
  assert.equal((await again.sync.tags()).length, 5);
  assert.ok((await again.sync.cacheBytes()) > 130 * 60);
  assert.ok((await idb.keys('spark/main/set/1/c/')).length === 2);
  await again.sync.clear();
  assert.deepEqual(await idb.keys('spark/main/'), []);
  again.client.close();
  await idb.close();
});

test('a set entry whose serial context is over 64 KB packs and unpacks byte for byte (real ones are 65,641 bytes)', () => {
  const context = new Uint8Array(65641).map((_, i) => (i * 7) & 0xff);
  const txHash = new Uint8Array(32).fill(9);
  const body = new Uint8Array(244).fill(3);
  const lenPrefix = Uint8Array.of(0xfe, 0x69, 0x00, 0x01, 0x00); // CompactSize 65,641
  const coin = new Uint8Array([...body, ...txHash, ...lenPrefix, ...context]);
  const back = unpackCoins(packCoins([{ coin, txHash, context }]));
  assert.equal(back.length, 1);
  assert.deepEqual(back[0].coin, coin);
  assert.deepEqual(back[0].context, context);
});

test('limits on what a server sends (audit D-13): an impossible coin, a billion-coin set, a 70 MB answer', async () => {
  const { decodeSetEntry, MAX_COIN_BYTES } = await import('../../src/lib/firo/spark_sync.js');
  const b64 = (n) => Buffer.alloc(n, 1).toString('base64');
  assert.ok(decodeSetEntry([b64(300), b64(32), b64(40)]).coin.length === 300);
  assert.throws(() => decodeSetEntry([b64(MAX_COIN_BYTES + 1), b64(32), b64(40)]), /impossible size/);
  assert.throws(() => decodeSetEntry([b64(0), b64(32), b64(40)]), /impossible size/);
  // A real coin carrying its tx hash and a 65 kB serial context at its end (seen on mainnet): fine.
  const body = Buffer.alloc(318, 3);
  const txHash = Buffer.alloc(32, 4);
  const ctx = Buffer.alloc(65641, 5);
  const withSuffix = Buffer.concat([body, txHash, Buffer.from([0xfe, 65641 & 255, (65641 >> 8) & 255, (65641 >> 16) & 255, 0]), ctx]);
  assert.equal(decodeSetEntry([withSuffix.toString('base64'), txHash.toString('base64'), ctx.toString('base64')]).context.length, 65641);
  const { ElectrumClient } = await import('../../src/lib/firo/electrum.js');
  const c = new ElectrumClient({ servers: ['wss://x.example:50004'], WebSocket: function () {}, reconnect: false });
  const errors = [];
  c.on('error', (e) => errors.push(e.message));
  const ws = { close() {} };
  c._ws = ws;
  c._onMessage(ws, 'x'.repeat(70 * 1024 * 1024));
  assert.match(errors[0], /far too large/);
});

test('a server describing a billion-coin set is not followed into a billion requests', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, blockOf(3));
  const { sync, client, server } = setup(chain);
  const realMeta = chain.handler();
  server.handler = (method, params, socket) => (method === 'spark.getsparkanonymitysetmeta' ? { blockHash: bytesToBase64(new Uint8Array(32).fill(7)), setHash: bytesToBase64(new Uint8Array(32)), size: 1e9 } : realMeta(method, params, socket));
  await client.connect();
  await assert.rejects(sync.syncGroup(1), /impossible size/);
  assert.equal(sectorCalls(chain), 0, 'no sector was asked for');
  client.close();
});
