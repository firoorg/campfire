// SPDX-License-Identifier: MIT
// The Spark benchmark inside a browser page (driven by bench_chrome.mjs): the real client,
// its module workers and spark.wasm under the app's CSP, on mainnet groups served from /data/.
import { createSparkClient } from '../../src/lib/firo/spark/client.js';
import { packIdentify, parseGroup, prepareSpend, randomBytes } from './sets.mjs';

const params = new URLSearchParams(location.search);
const idGroup = params.get('identify') || '11';
const spGroup = params.get('spend') || '10';
const workers = Number(params.get('workers') || '4');
const MB = 1024 * 1024;
const out = document.getElementById('out');
const log = (s) => { out.textContent += `\n${s}`; };

async function group(g) {
  const meta = await (await fetch(`/data/group-${g}.json`)).json();
  const buf = new Uint8Array(await (await fetch(`/data/group-${g}.bin`)).arrayBuffer());
  return { meta, entries: parseGroup(buf) };
}

async function memory() {
  if (!self.crossOriginIsolated || !performance.measureUserAgentSpecificMemory) return null;
  const m = await Promise.race([performance.measureUserAgentSpecificMemory(), new Promise((r) => setTimeout(() => r(null), 60000))]);
  return m ? Math.round(m.bytes / MB) : null;
}

async function run() {
  const result = { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency };

  // 1. identification of the current group with a random view key
  const { meta, entries } = await group(idGroup);
  const packed = packIdentify(entries);
  const single = createSparkClient({ identifyWorkers: 0 });
  await single.ready;
  const fullViewKey = await single.getFullViewKey({ privateKey: randomBytes(32), index: 1 });
  const oneThread = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = await single.identifyCoins({ fullViewKey, coins: packed, chunkSize: 1000 });
    oneThread.push(Math.round(performance.now() - t));
    if (r.found.length || r.unreadable) throw new Error('unexpected identification result');
  }
  log(`identify ${entries.length} coins, one worker: ${oneThread.join(', ')} ms`);
  single.close();

  const pool = createSparkClient({ identifyWorkers: workers });
  await pool.ready;
  await pool.identifyCoins({ fullViewKey, coins: packIdentify(entries.slice(0, 4000)), chunkSize: 1000 }); // start + warm the pool
  const poolRuns = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = await pool.identifyCoins({ fullViewKey, coins: packed, chunkSize: 1000 });
    poolRuns.push(Math.round(performance.now() - t));
    if (r.found.length || r.unreadable) throw new Error('unexpected identification result (pool)');
  }
  log(`identify ${entries.length} coins, ${workers} workers: ${poolRuns.join(', ')} ms`);
  const poolStats = await pool.stats();
  result.identify = {
    group: meta.group, coins: entries.length, oneWorkerRunsMs: oneThread, poolWorkers: workers, poolRunsMs: poolRuns,
    bestPerCoinUsOneWorker: +(Math.min(...oneThread.slice(1)) * 1000 / entries.length).toFixed(1),
    wasmMemoryMBPerWorker: poolStats.identify.map((b) => b / MB),
  };
  result.identify.pageMemoryMB = await memory();
  pool.close();

  // 2. a spend over a full-size group, in the prover worker
  const g = await group(spGroup);
  const spark = createSparkClient({ identifyWorkers: 0, proverMemoryLimitMB: 0 }); // recycled by hand below, after measuring
  await spark.ready;
  const { args, setSize } = await prepareSpend(spark, g.entries, g.meta, { setId: g.meta.group });
  const proofs = [];
  let spend;
  let afterProve = null;
  for (let i = 0; i < 2; i++) {
    const t = performance.now();
    spend = await spark.createSparkSendTransaction(args);
    proofs.push(Math.round(performance.now() - t));
    if (i === 0) afterProve = { proverWasmMemoryMB: (await spark.stats()).prover / MB, pageMemoryMB: await memory() };
  }
  log(`prove over ${setSize} coins: ${proofs.join(', ')} ms`);
  const t2 = performance.now();
  const v = await spark.verifySparkSpend({
    spendVersion: 2, serializedSpendPayload: spend.serializedSpendPayload, outputScripts: spend.outputScripts,
    transparentOut: 0, anonymitySets: args.anonymitySets, txHash: args.txHash,
  });
  const verifyMs = Math.round(performance.now() - t2);
  log(`verify: ${verifyMs} ms, ${v.valid ? 'valid' : `INVALID: ${v.reason}`}`);
  spark.recycleProver();
  await spark.ready;
  await new Promise((r) => setTimeout(r, 1000)); // let the old prover go
  result.spend = {
    group: g.meta.group, setSize, setEntries: '244-byte coins', proveRunsMs: proofs, verifyMs, valid: v.valid,
    payloadBytes: spend.serializedSpendPayload.length, afterFirstProve: afterProve,
    afterRecycle: { proverWasmMemoryMB: (await spark.stats()).prover / MB, pageMemoryMB: await memory() },
  };
  spark.close();
  return result;
}

run().then(
  (r) => { window.__bench = { ok: true, result: r }; log('done'); },
  (e) => { window.__bench = { ok: false, error: String((e && e.stack) || e) }; log(`FAILED: ${e}`); },
);
