// A Spark set's hash recomputed from its coins, as firod makes it (src/lib/firo/spark_sethash.js),
// and SparkSync.verifyGroup comparing it with the hash the server reports (audit D-09).
//
//   Mainnet: one live step (block 1,393,180 added 4 coins to group 11), from
//   test/fixtures/firo_sethash_vectors.json; the whole-group recomputations of groups 1 and 11 that
//   matched mainnet are recorded there too.
//   Fake chain (test/fixtures/firo_fake_chain.mjs, which follows firod's rules): a group's first
//   check, a set that only grew, a check spread over several calls, a new group that carries over
//   the newest coins of the one before, and servers that serve other coins than the hash says.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setHashStep, blocksOf, extendSetHash, SetHashError } from '../../src/lib/firo/spark_sethash.js';
import { SparkSync } from '../../src/lib/firo/spark_sync.js';
import { ElectrumClient } from '../../src/lib/firo/electrum.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { hexToBytes, bytesToHex, bytesToBase64 } from '../../src/lib/firo/bytes.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, fakeCoin } from '../fixtures/firo_fake_chain.mjs';

const V = JSON.parse(readFileSync(new URL('../fixtures/firo_sethash_vectors.json', import.meta.url), 'utf8'));

test('mainnet: one block of group 11 carries the set hash on exactly as Firo\'s servers reported it', async () => {
  const s = V.step;
  const bodies = s.coins.map((c) => hexToBytes(c.body));
  assert.equal(bytesToHex(setHashStep(hexToBytes(s.prevSetHash), bodies)), s.setHash);
  // The same through what the wallet runs: the coins in Campfire's stored order (the server's list
  // reversed whole), placed in their block by the block's transaction list.
  const stored = s.coins.map((c) => ({ txid: c.txid, body: hexToBytes(c.body) })).reverse();
  const asked = [];
  const blockTxids = async (hs) => {
    asked.push(...hs);
    return new Map(hs.map((h) => [h, h === s.height ? ['00'.repeat(32), ...new Set(s.coins.map((c) => c.txid))] : ['11'.repeat(32)]]));
  };
  const r = await extendSetHash({ hash: hexToBytes(s.prevSetHash), height: s.height - 3, coins: stored, tipHeight: s.height + 100000, blockTxids });
  assert.equal(r.placed, 4);
  assert.equal(bytesToHex(r.hash), s.setHash);
  assert.equal(r.height, s.height);
  assert.deepEqual(r.checkpoints.map((c) => [c.placed, bytesToHex(c.hash), c.height]), [[4, s.setHash, s.height]]);
  assert.ok(asked.length <= 2000, `stops reading blocks once every coin is placed (read ${asked.length} of 100,003)`);
  // One coin left out, or two swapped: another hash.
  assert.notEqual(bytesToHex(setHashStep(hexToBytes(s.prevSetHash), bodies.slice(1))), s.setHash);
  assert.notEqual(bytesToHex(setHashStep(hexToBytes(s.prevSetHash), [bodies[1], bodies[0], ...bodies.slice(2)])), s.setHash);
  // Recorded: whole groups recomputed from full downloads matched mainnet too.
  for (const g of V.groups) assert.equal(g.computed, g.setHash, `group ${g.group}`);
});

test('blocks come from heights, not from changes of txid; coins out of their blocks\' order are no set', () => {
  // One block whose transactions' coins interleave (A, B, A), as firod lists some blocks.
  const c = (txid, b) => ({ txid, body: Uint8Array.of(b) });
  const stored = [c('a', 1), c('b', 2), c('a', 3), c('c', 4), c('d', 5)]; // oldest first, as stored
  const heights = new Map([['a', 10], ['b', 10], ['c', 11]]);
  const { blocks, placed } = blocksOf(stored, heights);
  assert.equal(placed, 4);
  assert.deepEqual(blocks.map((b) => [b.height, [...b.coins].map((x) => x[0])]), [[10, [3, 2, 1]], [11, [4]]]); // each block back in firod's order
  assert.throws(() => blocksOf([c('a', 1), c('c', 2), c('b', 3)], heights), SetHashError); // 10, 11, then 10 again
  assert.throws(() => blocksOf([c('a', 1), c('x', 2), c('c', 3)], heights), SetHashError); // a placed coin after an unplaced one
});

function syncer(handler) {
  const net = new FakeNet();
  net.addServer('wss://one.example:1', handler);
  const client = new ElectrumClient({ servers: ['wss://one.example:1'], WebSocket: net.WebSocket, pingIntervalMs: 0, timeoutMs: 2000 });
  return { client, sync: new SparkSync({ client, store: createMemoryStore() }) };
}

test('a group\'s hash: recomputed from its coins; then only the blocks since are read; spread over calls', async () => {
  const chain = new FakeChain();
  for (let b = 0; b < 6; b++) chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()].slice(0, 1 + (b % 3)));
  const { client, sync } = syncer(chain.handler());
  await client.connect();
  await sync.syncGroup(1);
  let r = await sync.verifyGroup(1, { tipHeight: chain.height });
  assert.equal(r.state, 'match');
  assert.ok(r.read >= 6);
  // Group 1's first block is in no hash (firod before Chaum V2): its hash ends exactly on the reported one.
  const v = await sync.verifiedState(1);
  assert.equal(v.hash, (await client.sparkSetMeta(1)).setHash);
  assert.equal(v.skipFirst, false);
  // The set grows by two blocks: only those are read, and nothing is asked about any transaction.
  chain.addBlock(1, [fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  await sync.syncGroup(1);
  const gets = chain.txGets.length;
  r = await sync.verifyGroup(1, { tipHeight: chain.height });
  assert.deepEqual([r.state, r.read], ['match', 2]);
  assert.equal(chain.txGets.length, gets);
  // Far apart blocks, read 1,000 at a time: 'partial' until every coin is placed, then 'match'.
  chain.height += 2500;
  chain.addBlock(1, [fakeCoin()]);
  await sync.syncGroup(1);
  const steps = [];
  do steps.push((r = await sync.verifyGroup(1, { tipHeight: chain.height, maxHeights: 1000 })).state);
  while (r.state === 'partial' && steps.length < 10);
  assert.deepEqual(steps, ['partial', 'partial', 'match']);
  client.close();
});

test('a new group: its chain begins at the last hash of the one before, after the coins it carries over', async () => {
  const chain = new FakeChain({ startGroupSize: 3 });
  for (let b = 0; b < 5; b++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(2, [fakeCoin()]);
  chain.addBlock(2, [fakeCoin(), fakeCoin()]);
  assert.equal(chain.serverList(2).length, 3 + 4, 'group 2 starts with group 1\'s newest blocks (2 blocks, 4 coins: at least 3)');
  // Holding group 1 (a restore): the carried coins are compared with group 1's newest one by one.
  const a = syncer(chain.handler());
  await a.client.connect();
  await a.sync.syncGroup(1);
  await a.sync.syncGroup(2);
  const r = await a.sync.verifyGroup(2, { tipHeight: chain.height });
  assert.equal(r.state, 'match');
  const v = await a.sync.verifiedState(2);
  assert.deepEqual([v.carry, v.startHash], [4, (await a.client.sparkSetMeta(1)).setHash]);
  a.client.close();
  // Not holding group 1 (a new wallet): group 1's last hash and newest coin are asked for.
  const b = syncer(chain.handler());
  await b.client.connect();
  await b.sync.syncGroup(2);
  assert.equal((await b.sync.verifyGroup(2, { tipHeight: chain.height })).state, 'match');
  b.client.close();
});

test('audit D-09: other coins under the real hash, carried-over coins that are not the group before\'s, coins out of order: mismatch', async () => {
  const honest = new FakeChain({ startGroupSize: 2 });
  const blocks = [];
  for (let b = 0; b < 4; b++) blocks.push([fakeCoin(), fakeCoin(), fakeCoin()]);
  for (const coins of blocks) honest.addBlock(1, coins);
  const realMeta = await metaOf(honest, 1);

  // 1. A server serves the set with one coin left out, under the real hash (and its true size).
  const pruned = new FakeChain();
  blocks.forEach((coins, i) => pruned.addBlock(1, i === 2 ? coins.slice(1) : coins, { hash: honest.groups.get(1)[i].hash }));
  const lying = (chain) => {
    const real = chain.handler();
    return (method, params, socket) => (method === 'spark.getsparkanonymitysetmeta' ? { ...real(method, params, socket), setHash: realMeta.setHash } : real(method, params, socket));
  };
  const p = syncer(lying(pruned));
  await p.client.connect();
  await p.sync.syncGroup(1);
  assert.equal((await p.sync.anonymitySet(1)).setHash, realMeta.setHash, 'the server\'s own words would pass');
  assert.equal((await p.sync.verifyGroup(1, { tipHeight: pruned.height })).state, 'mismatch');
  // Asked again with nothing changed: the same answer, nothing read again.
  const r2 = await p.sync.verifyGroup(1, { tipHeight: pruned.height });
  assert.deepEqual([r2.state, r2.read], ['mismatch', 0]);
  p.client.close();

  // 2. The same number of coins, one swapped for another (a substituted decoy).
  const swapped = new FakeChain();
  blocks.forEach((coins, i) => swapped.addBlock(1, i === 1 ? [coins[0], fakeCoin(), coins[2]] : coins, { hash: honest.groups.get(1)[i].hash }));
  const q = syncer(lying(swapped));
  await q.client.connect();
  await q.sync.syncGroup(1);
  assert.equal((await q.sync.anonymitySet(1)).size, realMeta.size);
  assert.equal((await q.sync.verifyGroup(1, { tipHeight: swapped.height })).state, 'mismatch');
  q.client.close();

  // 3. Group 2's carried-over coins are not group 1's newest (group 1 held): mismatch.
  honest.addBlock(2, [fakeCoin(), fakeCoin()]);
  const other = new FakeChain({ startGroupSize: 2 });
  blocks.forEach((coins, i) => other.addBlock(1, coins, { hash: honest.groups.get(1)[i].hash }));
  other.addBlock(2, honest.groups.get(2)[0].coins, { hash: honest.groups.get(2)[0].hash });
  other.carried.set(2, [{ ...other.carried.get(2)[0], coins: [fakeCoin(), fakeCoin(), fakeCoin()] }]);
  const c = syncer(other.handler());
  await c.client.connect();
  await c.sync.syncGroup(1);
  await c.sync.syncGroup(2);
  assert.equal((await c.sync.verifyGroup(1, { tipHeight: other.height })).state, 'match');
  assert.equal((await c.sync.verifyGroup(2, { tipHeight: other.height })).state, 'mismatch');
  c.client.close();
});

async function metaOf(chain, g) {
  const m = chain.handler()('spark.getsparkanonymitysetmeta', [String(g)]);
  return m;
}

test('a stored check that no longer fits (the newest block replaced) is redone from the start once', async () => {
  const chain = new FakeChain();
  for (let b = 0; b < 4; b++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const { client, sync } = syncer(chain.handler());
  await client.connect();
  await sync.syncGroup(1);
  assert.equal((await sync.verifyGroup(1, { tipHeight: chain.height })).state, 'match');
  // A stale record of the check (as if made against a block since replaced): redone, still a match.
  const v = await sync.verifiedState(1);
  await sync.store.put('set/1/verified', { ...v, hash: bytesToBase64(new Uint8Array(32).fill(1)), size: v.size - 2, height: v.height - 1, checkpoints: [] });
  assert.equal((await sync.verifyGroup(1, { tipHeight: chain.height })).state, 'match');
  client.close();
});
