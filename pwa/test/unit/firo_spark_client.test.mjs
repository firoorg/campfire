// The Spark client (pwa/src/lib/firo/spark/client.js) with real workers: spark_worker.js
// runs in Node worker_threads through a tiny Web Worker adapter, each worker with its own
// wasm instance, exactly as in the browser (no shared memory).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

import { createSparkClient, packCoins } from '../../src/lib/firo/spark/client.js';
import createSparkModule from '../../src/vendor/spark/spark.js';
import { loadSparkCore } from '../../src/lib/firo/spark/core.js';
import { bytesToHex, hexToBytes } from '../../src/lib/firo/spark/codec.js';

const V = JSON.parse(await readFile(new URL('../fixtures/firo_spark_vectors.json', import.meta.url), 'utf8'));
const wasmBinary = await readFile(new URL('../../src/vendor/spark/spark.wasm', import.meta.url));
const workerUrl = new URL('../../src/lib/firo/spark/spark_worker.js', import.meta.url);
const direct = await loadSparkCore({ createModule: createSparkModule, wasmBinary });

// A Web Worker look-alike over worker_threads: `self` with postMessage/onmessage.
const BOOT = `
const { parentPort } = require('node:worker_threads');
const queue = [];
globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), onmessage: null };
parentPort.on('message', (data) => (self.onmessage ? self.onmessage({ data }) : queue.push(data)));
import(${JSON.stringify(workerUrl.href)}).then(() => { for (const d of queue.splice(0)) self.onmessage({ data: d }); });
`;
const started = [];
const handles = new Map();
function nodeWorker(name) {
  const w = new Worker(BOOT, { eval: true, name });
  started.push(name);
  const h = { onmessage: null, onerror: null, postMessage: (m, t) => w.postMessage(m, t), terminate: () => w.terminate() };
  handles.set(name, h);
  w.on('message', (data) => h.onmessage && h.onmessage({ data }));
  w.on('error', (e) => h.onerror && h.onerror({ message: e.message }));
  return h;
}

const client = createSparkClient({ wasmBinary, createWorker: nodeWorker, identifyWorkers: 3 });
after(() => client.close());

const k1 = V.keys.find((k) => k.name === 'k1');
const k2 = V.keys.find((k) => k.name === 'k2');

test('the prover worker starts and answers like the module', async () => {
  const info = await client.ready;
  assert.match(info.buildInfo, /^sparkmobile a9d078955312b3467f5bb14cbd64ab2ed8852256$/);
  assert.ok(info.memoryBytes >= 16 * 1024 * 1024);
  assert.equal(await client.getFullViewKey({ privateKey: k1.privateKey, index: 1 }), k1.fullViewKey);
  assert.equal(await client.getFullViewKeyHexFromPrivateKeyData({ privateKeyHex: k1.privateKey, index: 1 }), k1.fullViewKey);
  assert.equal(await client.getAddress({ privateKey: hexToBytes(k1.privateKey), index: 1, diversifier: 1 }), k1.addresses[1].main);
  assert.equal(await client.getAddressFromFullViewKey({ fullViewKey: k1.fullViewKey, diversifier: 9999, isTestNet: true }), k1.addresses[3].test);
  assert.equal(await client.validateAddress({ address: k1.addresses[0].main }), true);
  assert.equal(await client.validateAddress({ address: k1.addresses[0].main, isTestNet: true }), false);
  assert.equal(await client.hashTag(V.hashTags[0].x, V.hashTags[0].y), V.hashTags[0].hash);
  assert.deepEqual(await client.hashTags([V.hashTags[1].tag]), [V.hashTags[1].hash]);
  assert.equal(bytesToHex(await client.serializeMintContext(V.serializeMintContext[0].inputs)), V.serializeMintContext[0].context);
  assert.equal(client.getSpendVersionForBlockHeight({ nextBlockHeight: 1400000 }), 2);
});

test('identification is spread over the pool and equals one direct call', async () => {
  // 1,000 coins: the vector coins repeated, a few unreadable ones in between.
  const base = V.identify.filter((v) => !v.isTestNet).map((v) => ({ coin: hexToBytes(v.coin), context: hexToBytes(v.context) }));
  const coins = [];
  while (coins.length < 1000) {
    coins.push(...base);
    coins.push({ coin: new Uint8Array(7), context: new Uint8Array(0) });
  }
  coins.length = 1000;
  const want = direct.identifyCoins({ fullViewKey: k1.fullViewKey, coins });
  const progress = [];
  const got = await client.identifyCoins({ fullViewKey: k1.fullViewKey, coins, chunkSize: 64, onProgress: (p) => progress.push(p) });
  assert.equal(got.unreadable, want.unreadable);
  assert.deepEqual(got.found.map((f) => [f.index, f.lTagHash, f.value]), want.found.map((f) => [f.index, f.lTagHash, f.value]));
  assert.equal(progress.length, Math.ceil(1000 / 64));
  assert.deepEqual(progress.at(-1), { done: 1000, total: 1000 });
  assert.ok(progress.every((p, i) => i === 0 || p.done > progress[i - 1].done));
  const stats = await client.stats();
  assert.equal(stats.identify.length, 3, 'three identification workers, each with its own memory');
  // Packed input, as a wallet would keep sets, gives the same.
  const packed = await client.identifyCoins({ fullViewKey: k1.fullViewKey, coins: packCoins(coins, true), chunkSize: 100 });
  assert.deepEqual(packed.found.map((f) => f.index), want.found.map((f) => f.index));
  assert.equal(packed.unreadable, want.unreadable);
});

test('identification can be cancelled', async () => {
  const coins = Array.from({ length: 300 }, () => ({ coin: hexToBytes(V.identify[0].coin), context: hexToBytes(V.identify[0].context) }));
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(client.identifyCoins({ fullViewKey: k2.fullViewKey, coins, chunkSize: 10, signal: ac.signal }), (e) => e.code === 'aborted');
});

test('a spend made in the prover worker verifies there and pays the recipient', async () => {
  const s = V.spends.find((x) => x.rngLabel === 'spend-v2-one-input');
  const sets = s.anonymitySets.map((a) => ({ setId: a.setId, setHash: hexToBytes(a.setHash), coins: packCoins(a.coins.map(hexToBytes)) }));
  const r = await client.createSparkSendTransaction({
    privateKey: k1.privateKey, index: 1, recipients: s.recipients, privateRecipients: s.privateRecipients,
    coins: s.coins.map((c) => ({ serializedCoin: hexToBytes(c.coin), serializedCoinContext: hexToBytes(c.context), groupId: c.groupId, height: c.height })),
    anonymitySets: sets, idAndBlockHashes: s.blockHashes.map((b) => ({ setId: b.setId, blockHash: hexToBytes(b.blockHash) })),
    txHash: hexToBytes(s.txHashSig), spendVersion: 2,
  });
  assert.equal(r.fee, s.result.fee);
  assert.ok(r.serializedSpendPayload instanceof Uint8Array && r.serializedSpendPayload.length === hexToBytes(s.result.serializedSpendPayload).length);
  const v = await client.verifySparkSpend({
    spendVersion: 2, serializedSpendPayload: r.serializedSpendPayload, outputScripts: r.outputScripts,
    transparentOut: s.transparentOut, anonymitySets: sets, txHash: hexToBytes(s.txHashSig),
  });
  assert.deepEqual(v, { valid: true, reason: '' });
  const outs = r.outputScripts.map((sc) => ({ coin: sc.subarray(1), context: hexToBytes(s.outputContext) }));
  const theirs = await client.identifyCoins({ fullViewKey: k2.fullViewKey, coins: outs });
  assert.equal(theirs.found.length, 1);
  assert.equal(theirs.found[0].memo, 'vector memo');
});

test('errors keep their codes across the worker boundary', async () => {
  await assert.rejects(client.getAddress({ privateKey: new Uint8Array(3), diversifier: 0 }), (e) => e.name === 'SparkError' && e.code === 'invalid-argument');
  await assert.rejects(client.estimateSparkFee({
    privateKey: k1.privateKey, sendAmount: '200000000', subtractFeeFromAmount: false, privateRecipientsCount: 1, utxoNum: 0, spendVersion: 2,
    coins: V.estimateFee.coins.map((c) => ({ serializedCoin: c.coin, serializedCoinContext: c.context, groupId: c.groupId, height: c.height })),
  }), (e) => e.code === 'spark' && e.message === 'Insufficient funds !');
  // and the worker keeps working afterwards
  assert.equal(await client.validateAddress({ address: k2.addresses[0].main }), true);
});

test('after a big spend the prover is replaced, so its memory goes back', async () => {
  const c = createSparkClient({ wasmBinary, createWorker: nodeWorker, identifyWorkers: 0, proverMemoryLimitMB: 1 });
  await c.ready;
  const s = V.spends.find((x) => x.rngLabel === 'spend-v2-extension');
  const sets = s.anonymitySets.map((a) => ({ setId: a.setId, setHash: hexToBytes(a.setHash), coins: a.coins.map(hexToBytes) }));
  const before = started.filter((n) => n.startsWith('spark-prover')).length;
  const v = await c.verifySparkSpend({
    spendVersion: 2, serializedSpendPayload: s.result.serializedSpendPayload, outputScripts: s.result.outputScripts,
    transparentOut: s.transparentOut, anonymitySets: sets, txHash: s.txHashSig,
  });
  assert.equal(v.valid, true);
  assert.equal(started.filter((n) => n.startsWith('spark-prover')).length, before + 1, 'a fresh prover was started');
  assert.equal(await c.validateAddress({ address: k1.addresses[0].main }), true, 'and answers');
  assert.ok((await c.stats()).prover <= 16 * 1024 * 1024);
  c.close();
});

test('a worker that dies is replaced: its calls fail, the next ones work', async () => {
  const c = createSparkClient({ wasmBinary, createWorker: nodeWorker, identifyWorkers: 1 });
  await c.ready;
  const coins = [{ coin: hexToBytes(V.identify[0].coin), context: hexToBytes(V.identify[0].context) }];
  await c.identifyCoins({ fullViewKey: k1.fullViewKey, coins });
  const proverName = started.filter((n) => n.startsWith('spark-prover')).at(-1);
  const identifyName = started.filter((n) => n.startsWith('spark-identify')).at(-1);
  const pending = c.getAddress({ privateKey: k1.privateKey, diversifier: 0 });
  handles.get(proverName).onerror({ message: 'simulated crash' });
  handles.get(identifyName).onerror({ message: 'simulated crash' });
  await assert.rejects(pending, (e) => e.code === 'worker');
  assert.equal(await c.getAddress({ privateKey: k1.privateKey, diversifier: 0 }), k1.addresses[0].main, 'a new prover answers');
  const again = await c.identifyCoins({ fullViewKey: k1.fullViewKey, coins });
  assert.equal(again.found.length, 1, 'a new identification worker answers');
  assert.notEqual(started.filter((n) => n.startsWith('spark-identify')).at(-1), identifyName);
  c.close();
});

test('close() stops every worker and refuses further calls', async () => {
  const c = createSparkClient({ wasmBinary, createWorker: nodeWorker, identifyWorkers: 0 });
  await c.ready;
  const pending = c.getAddress({ privateKey: k1.privateKey, diversifier: 0 });
  c.close();
  await assert.rejects(pending, (e) => e.code === 'closed');
  await assert.rejects(c.validateAddress({ address: 'x' }), (e) => e.code === 'closed');
  await assert.rejects(c.identifyCoins({ fullViewKey: k1.fullViewKey, coins: [] }), (e) => e.code === 'closed');
});
