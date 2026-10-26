// Is the Spark spend key still in memory after Lock? (audit A-2 / B-4; the auditor's probe.)
// lib/firo/spark_adapter.js:38-43 keeps `fvkCache = new Map()` keyed by bytesToHex(keyData); the adapter
// is a page-lifetime singleton (lib/chain.js:52-62 `sparkClient`). backend.close() (backend.js:343-353)
// wipes the Uint8Array, but a JS string cannot be wiped and the Map is never cleared.
// bytesToHex (lib/firo/bytes.js:33) builds the string with `s +=`, so V8 keeps it as a rope
// ("concatenated string" nodes); this walker reconstructs ropes from the heap snapshot graph.
// Usage: OUT=<dir> node --expose-gc test/support/heap_key_probe.mjs [test|control|sanity]
// (test/unit/spark_key_memory.test.mjs runs it). Prints the number of copies found.
import v8 from 'node:v8';
import fs from 'node:fs';
import path from 'node:path';
const mode = process.argv[2] || 'test';
const { adaptSparkClient } = await import(new URL('../../src/lib/firo/spark_adapter.js', import.meta.url).href);

const key = new Uint8Array(32);
crypto.getRandomValues(key);
const keyCopy = Buffer.from(key); // raw bytes only; the hex string is built AFTER the snapshot
let sanityHold = null;

const client = {
  ready: Promise.resolve(),
  async getFullViewKey() { return 'ab'.repeat(32); },
  async identifyCoins() { return { found: [] }; },
};
const spark = adaptSparkClient(client); // what lib/chain.js keeps for the life of the page
const coins = [{ coin: new Uint8Array(8), context: new Uint8Array(8) }];
// backend.js:571 via _keyArgs() (backend.js:537): {keyData: this._sparkKey}. control: a view-only
// wallet passes fullViewKey instead, so fvkCache is never touched.
if (mode === 'control') await spark.identifyCoins({ fullViewKey: 'cd'.repeat(32), index: 1, isTestNet: false, coins });
else await spark.identifyCoins({ keyData: key, index: 1, isTestNet: false, coins });
if (mode === 'sanity') { let s = ''; for (const b of keyCopy) s += b.toString(16).padStart(2, '0'); sanityHold = s; }
key.fill(0); // backend.close(): wipe(this._sparkKey)
globalThis.gc(); globalThis.gc();
const file = v8.writeHeapSnapshot(path.join(process.env.OUT, `heap-${mode}.heapsnapshot`));
const hex = keyCopy.toString('hex');

// --- walk the snapshot: reconstruct every string, ropes included
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const { node_fields, node_types, edge_fields, edge_types } = snap.snapshot.meta;
const NF = node_fields.length, EF = edge_fields.length;
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
const fType = node_fields.indexOf('type'), fName = node_fields.indexOf('name'), fEdges = node_fields.indexOf('edge_count');
const eType = edge_fields.indexOf('type'), eName = edge_fields.indexOf('name_or_index'), eTo = edge_fields.indexOf('to_node');
const nodeTypes = node_types[0], edgeTypes = edge_types[0];
const T_STRING = nodeTypes.indexOf('string'), T_CONS = nodeTypes.indexOf('concatenated string'), T_SLICED = nodeTypes.indexOf('sliced string');
const firstEdge = new Uint32Array(nodes.length / NF + 1);
for (let i = 0, e = 0; i < nodes.length / NF; i++) { firstEdge[i] = e; e += nodes[i * NF + fEdges] * EF; }
const memo = new Map();
function str(i, depth = 0) {
  if (memo.has(i)) return memo.get(i);
  const t = nodes[i * NF + fType];
  let out = null;
  if (t === T_STRING) out = strings[nodes[i * NF + fName]];
  else if ((t === T_CONS || t === T_SLICED) && depth < 200) {
    let first = null, second = null, parent = null;
    for (let e = firstEdge[i]; e < firstEdge[i] + nodes[i * NF + fEdges] * EF; e += EF) {
      const en = edgeTypes[edges[e + eType]] === 'element' || edgeTypes[edges[e + eType]] === 'hidden' ? null : strings[edges[e + eName]];
      const to = edges[e + eTo] / NF;
      if (en === 'first') first = to; else if (en === 'second') second = to; else if (en === 'parent') parent = to;
    }
    if (t === T_CONS && first != null) out = (str(first, depth + 1) || '') + (second != null ? str(second, depth + 1) || '' : '');
    if (t === T_SLICED && parent != null) out = str(parent, depth + 1); // superset of the slice
  }
  memo.set(i, out);
  return out;
}
let flat = 0, rope = 0;
for (let i = 0; i < nodes.length / NF; i++) {
  const t = nodes[i * NF + fType];
  if (t !== T_STRING && t !== T_CONS) continue;
  const s = str(i);
  if (s && s.includes(hex)) { if (t === T_STRING) flat++; else rope++; }
}
console.log(`${mode.toUpperCase().padEnd(7)} after wipe + GC: key hex present as ${flat} flat string(s) and ${rope} rope(s) in the heap${sanityHold ? ' (sanity: our own copy is held)' : ''}`);
fs.unlinkSync(file);
