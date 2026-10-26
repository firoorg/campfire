// Live money tests on Firo MAINNET with the PWA's own engine and Spark library (Node).
// The test wallet's recovery words come from ~/.config/campfire-firo/test_wallets.env
// (FIROTEST_SEED="…", mode 0600) and are never printed.
//
//   node test/live/firo_money.mjs status
//   node test/live/firo_money.mjs privatize <FIRO|all>
//   node test/live/firo_money.mjs send <private|public> <to address> <FIRO> [memo]
//   node test/live/firo_money.mjs wait <txid> [confirmations=1]
//   node test/live/firo_money.mjs name <name> [years=1]     (a Spark Name: 1 FIRO a year from 6 characters)
//   node test/live/firo_money.mjs names
//
// Amounts are FIRO in decimal ("0.05"). Each run syncs from the wallet's birthday (memory store).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { createSparkClient } from '../../src/lib/firo/spark/client.js';
import { adaptSparkClient } from '../../src/lib/firo/spark_adapter.js';
import { createBackend } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';

const BIRTHDAY = 1392990; // the test wallet was made at block ~1,393,050 (2026-10-12)
const env = await readFile(`${homedir()}/.config/campfire-firo/test_wallets.env`, 'utf8');
const seed = /^FIROTEST_SEED="([a-z ]+)"$/m.exec(env)?.[1];
if (!seed) throw new Error('FIROTEST_SEED missing');

const toSat = (s) => {
  const [i, f = ''] = String(s).split('.');
  return (BigInt(i) * 100000000n + BigInt((f + '00000000').slice(0, 8))).toString();
};
const fmt = (sat) => {
  const v = BigInt(sat);
  return `${v / 100000000n}.${String(v % 100000000n).padStart(8, '0')}`;
};

const wasmBinary = await readFile(new URL('../../src/vendor/spark/spark.wasm', import.meta.url));
const workerUrl = new URL('../../src/lib/firo/spark/spark_worker.js', import.meta.url);
const BOOT = `const { parentPort } = require('node:worker_threads'); const queue = [];
globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), onmessage: null };
parentPort.on('message', (data) => (self.onmessage ? self.onmessage({ data }) : queue.push(data)));
import(${JSON.stringify(workerUrl.href)}).then(() => { for (const d of queue.splice(0)) self.onmessage({ data: d }); });`;
function nodeWorker(name) {
  const w = new Worker(BOOT, { eval: true, name });
  const h = { onmessage: null, onerror: null, postMessage: (m, t) => w.postMessage(m, t), terminate: () => w.terminate() };
  w.on('message', (data) => h.onmessage && h.onmessage({ data }));
  w.on('error', (e) => h.onerror && h.onerror({ message: e.message }));
  return h;
}
const spark = adaptSparkClient(createSparkClient({ wasmBinary, createWorker: nodeWorker, identifyWorkers: 3 }));
// FIRO_EXACT=1: Settings -> Exact dates (each own transaction asked for among 7 others).
const backend = createBackend({ network: 'main', store: createMemoryStore(), spark, WebSocket: globalThis.WebSocket, sparkTxDetails: process.env.FIRO_EXACT === '1' ? 'decoy' : 'none' });

async function synced() {
  await backend.open({ mnemonic: seed, birthdayHeight: BIRTHDAY });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sync timeout')), 600000);
    const check = (s) => {
      if (s.sync.phase === 'done') { clearTimeout(t); resolve(s); }
      else if (s.sync.phase === 'error') { clearTimeout(t); reject(new Error(s.sync.error)); }
    };
    backend.subscribe(check);
    // FIRO_TRACE=1: each sync phase as it starts, with the time since the start (N9: how long the
    // first proof of private coins takes on mainnet).
    if (process.env.FIRO_TRACE === '1') {
      const t0 = Date.now();
      let last = '';
      backend.subscribe((st) => {
        const p = `${st.sync.phase}${st.privateCheck ? ` privateCheck=${st.privateCheck.code}` : ''}`;
        if (p !== last) console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${p} ${st.sync.done ?? ''}/${st.sync.total ?? ''}`);
        last = p;
      });
    }
    check(backend.getState());
  });
}

function show(s) {
  console.log(`height ${s.tip?.height}`);
  console.log(`private ${fmt(s.balance.private.available)} (+${fmt(s.balance.private.pending)} pending)`);
  console.log(`public  ${fmt(s.balance.public.available)} (+${fmt(s.balance.public.pending)} pending)`);
  console.log(`receive transparent ${s.receive.transparent}`);
  console.log(`receive spark       ${s.receive.spark}`);
  // FIRO_PROOFS=1: how each public payment was proven (audit D-01).
  if (process.env.FIRO_PROOFS === '1') console.log(`  tip check: ${JSON.stringify(s.serverCheck)}`);
  if (process.env.FIRO_PROOFS === '1' && backend.transparent) for (const [id, r] of backend.transparent.txs) console.log(`  proof ${id.slice(0, 16)}… ${r.proof ?? '(not yet)'} height ${r.height}`);
  // And each private coin (public audit P4, N9): proven, made here, or waiting.
  if (process.env.FIRO_PROOFS === '1') {
    for (const c of backend.ownCoins?.values?.() ?? []) {
      if (c.spentTxid) continue;
      console.log(`  spark coin ${fmt(c.value)} group ${c.groupId} tx ${String(c.txid).slice(0, 16)}… ${c.isChange ? 'change' : backend._sparkMadeHere(c) ? 'made here' : c.proof ?? 'WAITING FOR PROOF'}`);
    }
    console.log(`  private check: ${JSON.stringify(s.privateCheck ?? null)}`);
  }
  for (const t of s.txs.slice(0, 12)) console.log(`  ${t.txid.slice(0, 16)}… ${t.kind.padEnd(11)} ${t.direction.padEnd(4)} ${fmt(t.amount)} fee ${fmt(t.fee ?? 0)} ${t.height ? `block ${t.height}` : t.heightApprox ? `about block ${t.heightApprox}` : 'unconfirmed'}${t.memo ? ` memo "${t.memo}"` : ''}${t.counterparty ? ` to ${t.counterparty.slice(0, 18)}` : ''}`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  const s = await synced();
  if (cmd === 'status' || !cmd) {
    const t = Date.now();
    await backend.waitForSync(); // the checks that follow a sync (proofs, the tip) included
    if (process.env.FIRO_TRACE === '1') console.log(`[after sync] the checks that follow took ${((Date.now() - t) / 1000).toFixed(0)}s`);
    show(backend.getState());
  }
  else if (cmd === 'privatize') {
    const amount = args[0] === 'all' ? 'all' : toSat(args[0]);
    const r = await backend.privatize({ amount });
    console.log('privatize txid', r.txid);
  } else if (cmd === 'send') {
    const [from, to, amt, memo] = args;
    const req = { from, to: [{ address: to, amount: toSat(amt), ...(memo ? { memo } : {}) }] };
    const q = await backend.quote(req);
    console.log(`quote fee ${fmt(q.fee)} total ${fmt(q.total)} change ${fmt(q.change)} ${q.warnings.join('; ')}`);
    const before = backend.getState().balance;
    const r = await backend.send(req);
    console.log('send txid', r.txid);
    if (from === 'private') {
      // Re-audit R1-1: the payment's coins are found by linking tag and marked spending before the
      // broadcast, with the real Spark library (the log's coins and the marks, then the balance).
      const log = backend.sends && backend.sends.get(r.txid);
      const marked = [...(backend.ownCoins?.values?.() ?? [])].filter((c) => c.pendingSpentTxid === r.txid).length;
      const after = backend.getState().balance;
      console.log(`recorded coins ${log && log.coins ? log.coins.length : 'none'} | coins marked spending ${marked} | private available ${fmt(before.private.available)} -> ${fmt(after.private.available)}`);
    }
  } else if (cmd === 'name') {
    const [name, years = '1'] = args;
    if (!(await backend.sparkNames.isFree(name))) throw new Error(`the name ${name} is taken`);
    console.log(`registering @${name} for ${years} year(s): ${backend.sparkNameFeeFiro?.(name, Number(years)) ?? '?'} FIRO to the Spark Names fee address`);
    const r = await backend.sparkNames.register({ name, years: Number(years) });
    console.log('name txid', r.txid);
  } else if (cmd === 'names') {
    for (const n of await backend.sparkNames.listDetailed()) console.log(`@${n.name} -> ${n.address.slice(0, 16)}… valid until block ${n.validUntil}`);
  } else if (cmd === 'wait') {
    const [txid, need = '1'] = args;
    for (;;) {
      await backend.refresh?.();
      const t = backend.getState().txs.find((x) => x.txid.startsWith(txid));
      console.log(new Date().toISOString(), t ? `conf ${t.confirmations}` : 'not seen yet');
      if (t && t.confirmations >= Number(need)) break;
      await new Promise((r) => setTimeout(r, 30000));
    }
    show(backend.getState());
  }
} catch (e) {
  console.log('ERROR', e.code ?? '', e.message);
  process.exitCode = 1;
} finally {
  await backend.close();
  spark.close();
}
