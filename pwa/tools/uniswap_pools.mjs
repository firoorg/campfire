// Writes src/lib/eth/uniswap/known_pools.json from the desktop app's
// lib/wallets/ethereum/uniswap/uniswap_known_pools.dart, so both apps start
// from the same list of Uniswap pools.
//
//   node tools/uniswap_pools.mjs          write the JSON
//   node tools/uniswap_pools.mjs --check  fail if the JSON is not what the Dart file gives
//
// The JSON is compact (1,275 pools would be ~250 KB as the Dart maps): the
// currencies and the hook addresses are listed once and pools refer to them
// by index. Pools keep the Dart file's order.
//   [2, pair, c0, c1]                    a v2 pair
//   [3, pool, c0, c1, fee, tickSpacing]  a v3 pool
//   [4, c0, c1, fee, tickSpacing, hook]  a v4 pool (its id is computed)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DART_FILE = join(here, '..', '..', 'lib', 'wallets', 'ethereum', 'uniswap', 'uniswap_known_pools.dart');
export const JSON_FILE = join(here, '..', 'src', 'lib', 'eth', 'uniswap', 'known_pools.json');
const SOURCE = 'lib/wallets/ethereum/uniswap/uniswap_known_pools.dart';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const FIELDS = { v2: ['v', 'pair', 'c0', 'c1'], v3: ['v', 'pool', 'c0', 'c1', 'fee', 'ts'], v4: ['v', 'c0', 'c1', 'fee', 'ts', 'hooks'] };

/**
 * The Dart list → {block, pools: [{v, pair|pool, c0, c1, fee, ts, hooks}]},
 * exactly the maps UniPool.fromJson reads. Strict: anything unexpected throws.
 */
export function parseDartKnownPools(text) {
  const block = /const int kUniKnownPoolsBlock = (\d+);/.exec(text);
  if (!block) throw new Error('kUniKnownPoolsBlock not found');
  const start = text.indexOf('const List<Map<String, Object>> kUniKnownPools = [');
  if (start < 0) throw new Error('kUniKnownPools not found');
  const body = text.slice(start, text.indexOf('\n];', start));
  const pools = [];
  for (const m of body.matchAll(/\{([^{}]*)\}/g)) {
    const entry = {};
    for (const line of m[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
      const f = /^'(\w+)': (?:'([^']*)'|(\d+)),$/.exec(line);
      if (!f) throw new Error(`unexpected line in the Dart list: ${line}`);
      if (f[1] in entry) throw new Error(`duplicate ${f[1]}`);
      entry[f[1]] = f[2] !== undefined ? f[2] : Number(f[3]);
    }
    const want = FIELDS[entry.v];
    if (!want || Object.keys(entry).join() !== want.join()) throw new Error(`unexpected pool fields: ${Object.keys(entry).join()}`);
    for (const k of ['pair', 'pool', 'c0', 'c1', 'hooks']) if (k in entry && !ADDRESS.test(entry[k])) throw new Error(`bad address ${entry[k]}`);
    if (!(entry.c0 < entry.c1)) throw new Error('currencies out of order');
    pools.push(entry);
  }
  if (!pools.length) throw new Error('no pools in the Dart list');
  return { block: Number(block[1]), pools };
}

/** {block, pools} → the compact JSON object. */
export function compactKnownPools({ block, pools }) {
  const currencies = [...new Set(pools.flatMap((p) => [p.c0, p.c1]))].sort();
  const hooks = [ZERO, ...[...new Set(pools.filter((p) => p.v === 'v4').map((p) => p.hooks))].filter((h) => h !== ZERO).sort()];
  const ci = new Map(currencies.map((c, i) => [c, i]));
  const hi = new Map(hooks.map((h, i) => [h, i]));
  const rows = pools.map((p) => {
    if (p.v === 'v2') return [2, p.pair, ci.get(p.c0), ci.get(p.c1)];
    if (p.v === 'v3') return [3, p.pool, ci.get(p.c0), ci.get(p.c1), p.fee, p.ts];
    return [4, ci.get(p.c0), ci.get(p.c1), p.fee, p.ts, hi.get(p.hooks)];
  });
  return { format: 1, source: SOURCE, block, currencies, hooks, pools: rows };
}

/** The compact JSON object → the Dart maps again (for the parity test). */
export function expandKnownPools(json) {
  return {
    block: json.block,
    pools: json.pools.map((r) => {
      const c = (i) => json.currencies[i];
      if (r[0] === 2) return { v: 'v2', pair: r[1], c0: c(r[2]), c1: c(r[3]) };
      if (r[0] === 3) return { v: 'v3', pool: r[1], c0: c(r[2]), c1: c(r[3]), fee: r[4], ts: r[5] };
      return { v: 'v4', c0: c(r[1]), c1: c(r[2]), fee: r[3], ts: r[4], hooks: json.hooks[r[5]] };
    }),
  };
}

/** The file's text: one pool per line, so a regenerated list diffs line by line. */
export function serializeKnownPools(json) {
  const head = Object.entries(json)
    .filter(([k]) => k !== 'pools')
    .map(([k, v]) => `"${k}":${JSON.stringify(v)}`)
    .join(',\n');
  return `{\n${head},\n"pools":[\n${json.pools.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
}

export function knownPoolsText(dartText = readFileSync(DART_FILE, 'utf8')) {
  return serializeKnownPools(compactKnownPools(parseDartKnownPools(dartText)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = knownPoolsText();
  if (process.argv.includes('--check')) {
    if (readFileSync(JSON_FILE, 'utf8') !== text) {
      console.error('known_pools.json is out of date: run node tools/uniswap_pools.mjs');
      process.exit(1);
    }
    console.log('known_pools.json matches the Dart list');
  } else {
    writeFileSync(JSON_FILE, text);
    const n = JSON.parse(text).pools.length;
    console.log(`wrote ${JSON_FILE.slice(join(here, '..').length + 1)}: ${n} pools, ${text.length} bytes`);
  }
}
