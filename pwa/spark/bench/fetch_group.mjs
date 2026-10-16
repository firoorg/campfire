// SPDX-License-Identifier: MIT
// Downloads one Spark anonymity-set group from Firo's ElectrumX over wss, the way Campfire
// does (spark.getsparkanonymitysetmeta, then spark.getsparkanonymitysetsector in sectors of
// 1,500 coins, server order kept), and stores it as bytes for the benchmarks:
//   <dir>/group-<id>.bin   count * (bytes serialized, bytes txHash, bytes context), u32-length prefixed
//   <dir>/group-<id>.json  meta + download measurements
// Usage: node pwa/spark/bench/fetch_group.mjs [--group latest|N] [--server wss://…] [--dir DIR]
// Default dir: $FIRO_DEPS/spark-bench (~/Desktop/Firo/deps/spark-bench). Read-only for the server.
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ElectrumWs, b64 } from './electrum.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const server = arg('server', 'wss://electrumx.firo.org:50004');
const dir = arg('dir', join(process.env.FIRO_DEPS || join(homedir(), 'Desktop', 'Firo', 'deps'), 'spark-bench'));
const SECTOR = 1500;

const t0 = performance.now();
const ex = await ElectrumWs.connect(server);
const latest = await ex.request('spark.getsparklatestcoinid', []);
const want = arg('group', 'latest');
const group = want === 'latest' ? latest : Number(want);
const meta = await ex.request('spark.getsparkanonymitysetmeta', [String(group)]);
console.log(`${server}: ${JSON.stringify(ex.version)}, latest group ${latest}; group ${group}: ${meta.size} coins, block ${meta.blockHash}`);

const tDl = performance.now();
const parts = [];
let total = 0;
let jsonChars = 0;
let coins = 0;
let serializedBytes = 0;
for (let start = 0; start < meta.size; start += SECTOR) {
  const end = Math.min(meta.size, start + SECTOR);
  const before = ex.bytesIn;
  const r = await ex.request('spark.getsparkanonymitysetsector', [String(group), meta.blockHash, String(start), String(end)]);
  jsonChars += ex.bytesIn - before;
  for (const [ser, txh, ctx] of r.coins) {
    for (const field of [b64(ser), b64(txh), b64(ctx)]) {
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, field.length, true);
      parts.push(len, field);
      total += 4 + field.length;
    }
    serializedBytes += b64(ser).length;
    coins++;
  }
  process.stdout.write(`\r  ${coins}/${meta.size} coins`);
}
const downloadMs = performance.now() - tDl;
ex.close();
process.stdout.write('\n');
if (coins !== meta.size) throw new Error(`got ${coins} coins, meta says ${meta.size}`);

const data = new Uint8Array(total);
let off = 0;
for (const p of parts) {
  data.set(p, off);
  off += p.length;
}
await mkdir(dir, { recursive: true });
await writeFile(join(dir, `group-${group}.bin`), data);
const info = {
  server, serverVersion: ex.version, latestGroup: latest, group, blockHash: meta.blockHash, setHash: meta.setHash, size: meta.size,
  fetchedAt: new Date().toISOString(), sectorSize: SECTOR, sectors: Math.ceil(meta.size / SECTOR),
  downloadMs: Math.round(downloadMs), totalMs: Math.round(performance.now() - t0), jsonChars, binaryBytes: total,
  meanSerializedBytes: Math.round(serializedBytes / coins),
};
await writeFile(join(dir, `group-${group}.json`), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify(info, null, 2));
