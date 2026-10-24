// SPDX-License-Identifier: MIT
// Spark wasm benchmark in Node, on real mainnet data downloaded by fetch_group.mjs:
//  1. identify every coin of the current group with a random full view key (nothing matches:
//     this is the cost every wallet pays to scan), in one thread and with the worker pool;
//  2. prove a spend over a full-size group (group 10's 31,998 coins + our own freshly minted
//     coin), then verify it as a node would.
// Usage: node pwa/spark/bench/bench_node.mjs [--identify-group 11] [--spend-group 10] [--workers 4] [--dir DIR]
import { readFile } from 'node:fs/promises';
import { homedir, cpus } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import createSparkModule from '../../src/vendor/spark/spark.js';
import { loadSparkCore } from '../../src/lib/firo/spark/core.js';
import { createSparkClient } from '../../src/lib/firo/spark/client.js';
import { packIdentify, parseGroup, prepareSpend, randomBytes } from './sets.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const dir = arg('dir', join(process.env.FIRO_DEPS || join(homedir(), 'Desktop', 'Firo', 'deps'), 'spark-bench'));
const idGroup = arg('identify-group', '11');
const spGroup = arg('spend-group', '10');
const workers = Number(arg('workers', '4'));
const MB = 1024 * 1024;
const wasmBinary = await readFile(new URL('../../src/vendor/spark/spark.wasm', import.meta.url));
const result = { node: process.version, cpu: cpus()[0].model, cores: cpus().length };

const load = async (g) => ({ meta: JSON.parse(await readFile(join(dir, `group-${g}.json`), 'utf8')), entries: parseGroup(new Uint8Array(await readFile(join(dir, `group-${g}.bin`)))) });

// ---- 1. identification ---------------------------------------------------------------------
{
  const { meta, entries } = await load(idGroup);
  const packed = packIdentify(entries);
  const core = await loadSparkCore({ createModule: createSparkModule, wasmBinary });
  const fullViewKey = core.getFullViewKey({ privateKey: randomBytes(32), index: 1 });
  // The first run starts in V8's baseline wasm code (Liftoff) and tiers up while it runs:
  // that is what a wallet's first scan sees. Then three warm runs.
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const cpu0 = process.cpuUsage();
    const t = performance.now();
    const r = core.identifyCoins({ fullViewKey, coins: packed });
    const ms = performance.now() - t;
    const cpu = process.cpuUsage(cpu0);
    if (r.found.length || r.unreadable) throw new Error(`unexpected: found ${r.found.length}, unreadable ${r.unreadable}`);
    runs.push({ ms: Math.round(ms), cpuMs: Math.round((cpu.user + cpu.system) / 1000) });
  }
  const warm = runs.slice(1).sort((a, b) => a.ms - b.ms);
  result.identify = {
    group: meta.group, coins: entries.length, blockHash: meta.blockHash, requestBytes: packed.data.length,
    coldRun: runs[0], warmRuns: runs.slice(1),
    bestWarmPerCoinUs: +(warm[0].ms * 1000 / entries.length).toFixed(1),
    wasmMemoryMB: core.memoryBytes() / MB,
  };
  const ms = warm[0].ms;

  // The same through the client: identification workers, chunks of 1,000 (one message each).
  const BOOT = `
    const { parentPort } = require('node:worker_threads');
    const queue = [];
    globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), onmessage: null };
    parentPort.on('message', (data) => (self.onmessage ? self.onmessage({ data }) : queue.push(data)));
    import(${JSON.stringify(new URL('../../src/lib/firo/spark/spark_worker.js', import.meta.url).href)})
      .then(() => { for (const d of queue.splice(0)) self.onmessage({ data: d }); });`;
  const createWorker = (name) => {
    const w = new Worker(BOOT, { eval: true, name });
    const h = { onmessage: null, onerror: null, postMessage: (m, tr) => w.postMessage(m, tr), terminate: () => w.terminate() };
    w.on('message', (data) => h.onmessage && h.onmessage({ data }));
    w.on('error', (e) => h.onerror && h.onerror({ message: e.message }));
    return h;
  };
  const client = createSparkClient({ wasmBinary, createWorker, identifyWorkers: workers });
  await client.ready;
  // Start the pool (each worker instantiates and warms its own module) before timing.
  await client.identifyCoins({ fullViewKey, coins: packIdentify(entries.slice(0, 4000)), chunkSize: 1000 });
  const poolRuns = [];
  for (let i = 0; i < 3; i++) {
    const t2 = performance.now();
    const r2 = await client.identifyCoins({ fullViewKey, coins: packed, chunkSize: 1000 });
    poolRuns.push(Math.round(performance.now() - t2));
    if (r2.found.length || r2.unreadable) throw new Error('pool: unexpected result');
  }
  const stats = await client.stats();
  const bestPool = Math.min(...poolRuns);
  result.identify.pool = { workers, chunkSize: 1000, runsMs: poolRuns, speedupVsOneThread: +(ms / bestPool).toFixed(2), wasmMemoryMBPerWorker: stats.identify.map((b) => b / MB) };
  client.close();
}

// ---- 2. spend proof over a full-size set ----------------------------------------------------
{
  const { meta, entries } = await load(spGroup);
  const core = await loadSparkCore({ createModule: createSparkModule, wasmBinary }); // a fresh instance: its memory is this spend's
  const memBefore = core.memoryBytes();
  const rssBefore = process.memoryUsage().rss;
  const spark = new Proxy(core, { get: (c, k) => (typeof c[k] === 'function' ? (...a) => Promise.resolve(c[k](...a)) : c[k]) });
  const coinOnly = arg('set-entries', 'coin') === 'coin'; // 'full' passes whole set entries, as Campfire does
  const { args, setSize } = await prepareSpend(spark, entries, meta, { setId: meta.group, coinOnly });
  const proofs = [];
  let spend;
  let memAfterProve = 0;
  for (let i = 0; i < 2; i++) {
    const cpu0 = process.cpuUsage();
    const t = performance.now();
    spend = core.createSparkSendTransaction(args);
    const cpu = process.cpuUsage(cpu0);
    proofs.push({ ms: Math.round(performance.now() - t), cpuMs: Math.round((cpu.user + cpu.system) / 1000) });
    if (i === 0) memAfterProve = core.memoryBytes();
  }
  const verifies = [];
  let v;
  for (let i = 0; i < 2; i++) {
    const cpu0 = process.cpuUsage();
    const t2 = performance.now();
    v = core.verifySparkSpend({
      spendVersion: 2, serializedSpendPayload: spend.serializedSpendPayload, outputScripts: spend.outputScripts,
      transparentOut: 0, anonymitySets: args.anonymitySets, txHash: args.txHash,
    });
    const cpu = process.cpuUsage(cpu0);
    verifies.push({ ms: Math.round(performance.now() - t2), cpuMs: Math.round((cpu.user + cpu.system) / 1000) });
    if (!v.valid) throw new Error(`the spend does not verify: ${v.reason}`);
  }
  result.spend = {
    group: meta.group, setSize, setEntries: coinOnly ? '244-byte coins' : 'whole ElectrumX entries', inputs: 1, outputs: spend.outputScripts.length, version: 2,
    requestBytes: args.anonymitySets[0].coins.data.length, payloadBytes: spend.serializedSpendPayload.length, fee: spend.fee,
    prove: proofs, verify: verifies, valid: v.valid,
    wasmMemoryMB: { start: memBefore / MB, afterFirstProve: memAfterProve / MB, end: core.memoryBytes() / MB },
    processRssMB: { before: Math.round(rssBefore / MB), after: Math.round(process.memoryUsage().rss / MB) },
  };
}

result.loadAverage = (await import('node:os')).loadavg().map((x) => +x.toFixed(1));
console.log(JSON.stringify(result, null, 2));
