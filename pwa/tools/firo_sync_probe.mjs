#!/usr/bin/env node
// Measures what a browser wallet downloads to sync Spark: one coin group (the
// newest by default) and the used linking tags, through the real sync code
// (src/lib/firo/spark_sync.js) against one of Firo's ElectrumX servers over
// wss. Read-only; one group, not all of them — the servers are shared.
//
//   node tools/firo_sync_probe.mjs [--group N] [--tags full|none|FROM] [--sector 1500] [--server wss://…]
//
// Prints JSON: bytes received (the JSON text of every message), an estimate
// of the compressed size on the wire (each message deflated alone; the
// servers negotiate permessage-deflate), seconds, and the packed size the
// cache keeps.

import { deflateRawSync } from 'node:zlib';
import { ElectrumClient } from '../src/lib/firo/electrum.js';
import { SparkSync } from '../src/lib/firo/spark_sync.js';
import { createMemoryStore } from '../src/lib/firo/store.js';
import { NETWORKS } from '../src/lib/firo/params.js';

const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def);
const server = arg('--server', NETWORKS.main.servers[0]);
const sector = Number(arg('--sector', '1500'));
const tagsMode = arg('--tags', 'full');

const meter = { bytes: 0, deflated: 0, messages: 0 };
class CountingWebSocket extends globalThis.WebSocket {
  constructor(url) {
    super(url);
    this.addEventListener('message', (e) => {
      const text = typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString();
      const b = Buffer.byteLength(text);
      meter.bytes += b;
      meter.messages++;
      meter.deflated += deflateRawSync(text, { level: 6 }).length;
    });
  }
}

const client = new ElectrumClient({ servers: [server], WebSocket: CountingWebSocket, reconnect: false, pingIntervalMs: 0, timeoutMs: 180000 });
const store = createMemoryStore();
const sync = new SparkSync({ client, store, sectorSize: sector });
const take = () => {
  const m = { ...meter };
  meter.bytes = meter.deflated = meter.messages = 0;
  return m;
};
const mb = (n) => Math.round((n / 1e6) * 100) / 100;

await client.connect();
take();
const out = { server, date: new Date().toISOString(), sectorSize: sector };

const latest = await sync.latestGroupId();
const group = Number(arg('--group', String(latest)));
out.latestGroup = latest;
let t0 = performance.now();
const r = await sync.syncGroup(group, {
  onProgress: (p) => process.stderr.write(`\rgroup ${group}: ${p.done}/${p.total} coins   `),
});
process.stderr.write('\n');
let m = take();
const packed = (await sync.cacheBytes()) | 0;
out.group = {
  id: group,
  coins: r.size,
  seconds: Math.round((performance.now() - t0) / 100) / 10,
  messages: m.messages,
  jsonMB: mb(m.bytes),
  deflatedMB: mb(m.deflated),
  bytesPerCoinJson: Math.round(m.bytes / Math.max(1, r.size)),
  storedMB: mb(packed),
  storedBytesPerCoin: Math.round(packed / Math.max(1, r.size)),
};

// A second sync right away: what "up to date" costs.
t0 = performance.now();
await sync.syncGroup(group);
m = take();
out.groupUpToDate = { seconds: Math.round((performance.now() - t0) / 100) / 10, bytes: m.bytes };

if (tagsMode !== 'none') {
  const startAt = tagsMode === 'full' ? 0 : Number(tagsMode);
  t0 = performance.now();
  const tr = await sync.syncTags({ startAt });
  m = take();
  const tagBytes = (await sync.cacheBytes()) - packed;
  out.tags = {
    from: startAt,
    count: tr.count,
    serverCount: tr.cursor,
    seconds: Math.round((performance.now() - t0) / 100) / 10,
    jsonMB: mb(m.bytes),
    deflatedMB: mb(m.deflated),
    bytesPerTagJson: Math.round(m.bytes / Math.max(1, tr.count)),
    storedMB: mb(tagBytes),
  };
  t0 = performance.now();
  const again = await sync.syncTags();
  m = take();
  out.tagsUpToDate = { seconds: Math.round((performance.now() - t0) / 100) / 10, bytes: m.bytes, added: again.added };
}

t0 = performance.now();
const mp = await sync.syncMempool();
m = take();
out.mempool = { txs: mp.txs.size, seconds: Math.round((performance.now() - t0) / 100) / 10, bytes: m.bytes };

client.close();
console.log(JSON.stringify(out, null, 1));
