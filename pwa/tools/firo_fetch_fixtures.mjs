#!/usr/bin/env node
// Fetches the real Firo mainnet transactions the unit tests decode, once, and
// writes test/fixtures/firo_txs.json. Read-only and small: about thirty
// requests to one of Firo's ElectrumX servers.
//
//   node tools/firo_fetch_fixtures.mjs [--out test/fixtures/firo_txs.json]
//   node tools/firo_fetch_fixtures.mjs --add <label> <txid> "<note>"   (append one known transaction)
//
// What it looks for, and how it finds each without an explorer:
//   coinbase          blockchain.transaction.id_from_pos(1393000, 0)
//   spark mint        the newest coin of the newest Spark group that is a mint (coin type 0)
//   spark spend v2    the txid of the newest used linking tag
//   spark spend v1    the newest spend-output coin (type 1) of group 10, mined before chaum v2
//   spark name        a name from spark.getsparknames whose fee output script (P2PKH +
//                     OP_SPARKNAMEID name OP_DROP address OP_DROP) has a history
//   transparent       a plain P2PKH transfer among the first transactions of recent blocks
//   lelantus          a Lelantus transaction from a 2022-2023 block

import { writeFileSync, readFileSync } from 'node:fs';
import { ElectrumClient } from '../src/lib/firo/electrum.js';
import { NETWORKS } from '../src/lib/firo/params.js';
import { decodeTx } from '../src/lib/firo/tx.js';
import { base64ToBytes, hashToHex, utf8ToBytes, concatBytes } from '../src/lib/firo/bytes.js';
import { addressToScript, scriptHash } from '../src/lib/firo/address.js';
import { OP, pushData, parseScript } from '../src/lib/firo/script.js';

const net = NETWORKS.main;
const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : new URL('../test/fixtures/firo_txs.json', import.meta.url).pathname;

const c = new ElectrumClient({ servers: net.servers, reconnect: false, pingIntervalMs: 0, timeoutMs: 60000 });
await c.connect();
console.error('connected to', c.server);
const found = [];

// --add <label> <txid> "<note>": append one known transaction to the existing file and stop.
if (process.argv.includes('--add')) {
  const i = process.argv.indexOf('--add');
  const [label, txid, note = ''] = process.argv.slice(i + 1, i + 4);
  const doc = JSON.parse(readFileSync(outPath, 'utf8'));
  await add(label, txid, note);
  doc.txs = doc.txs.filter((t) => t.label !== label).concat(found);
  writeFileSync(outPath, JSON.stringify(doc, null, 1) + '\n');
  c.close();
  console.error('added', label);
  process.exit(0);
}

async function add(label, txid, note) {
  const v = await c.getTransaction(txid, true);
  const d = decodeTx(v.hex, net);
  if (d.txid !== txid) throw new Error(`hash mismatch for ${txid}`);
  found.push({
    label,
    txid,
    height: v.height ?? null,
    time: v.time ?? null,
    note,
    // Input values and addresses as the server reports them (for history tests).
    inputs: (v.vin ?? []).map((i) => (i.coinbase ? { coinbase: true } : { txid: i.txid ?? null, vout: i.vout ?? null, valueSat: i.valueSat ?? null, address: i.address ?? null })),
    hex: v.hex,
  });
  console.error(label, txid, d.kind, `v${d.version} type ${d.type}`, v.height);
  return d;
}

// coinbase
await add('coinbase', await c.txidFromPos(1393000, 0), 'block 1,393,000 coinbase (v3 type 5)');

// spark mint + spend v2
const latest = await c.sparkLatestCoinId();
const meta = await c.sparkSetMeta(latest);
const newest = await c.sparkSetSector(latest, meta.blockHash, 0, 40);
const mintEntry = newest.find((e) => base64ToBytes(e[0])[0] === 0);
const mint = await add('spark-mint', hashToHex(base64ToBytes(mintEntry[1])), 'transparent → Spark (OP_SPARKMINT outputs)');

// transparent: a plain P2PKH transfer among the first transactions of recent blocks
async function findInBlocks(heights, maxPos, want) {
  for (const height of heights) {
    for (let pos = 1; pos <= maxPos; pos++) {
      let txid;
      try {
        txid = await c.txidFromPos(height, pos);
      } catch {
        break; // past the block's last transaction
      }
      const d = decodeTx(await c.getTransaction(txid), net);
      if (want(d)) return txid;
    }
  }
  return null;
}
const isP2PKHSpend = (i) => {
  const ops = parseScript(i.scriptSig);
  return i.kind === 'regular' && ops.length === 2 && ops[1].data?.length === 33;
};
const plain = await findInBlocks([1393000, 1392990, 1392980, 1392970], 15, (d) => d.kind === 'transparent' && d.vin.every(isP2PKHSpend) && d.vout.every((o) => o.type === 'p2pkh'));
if (plain) await add('transparent', plain, 'plain P2PKH transfer');

// spend v2: the newest used tag's tx
let tagsStart = 240000;
let tags = await c.sparkUsedTags(tagsStart);
while (tags.length === 0 && tagsStart > 0) {
  tagsStart -= 2000;
  tags = await c.sparkUsedTags(tagsStart);
}
const v2 = hashToHex(base64ToBytes(tags[tags.length - 1][1]));
await add('spark-spend-v2', v2, 'Spark spend, chaum v2 (type 11)');
// The server's used-tag entries for that spend, to check the payload parser against.
const usedTags = tags.filter((t) => hashToHex(base64ToBytes(t[1])) === v2).map(([tag, txid]) => ({ tag, txid }));

// spend v1: a spend-output coin of the previous group, mined before block 1,371,000
if (latest > 1) {
  const meta10 = await c.sparkSetMeta(latest - 1);
  const coins10 = await c.sparkSetSector(latest - 1, meta10.blockHash, 0, 60);
  for (const e of coins10) {
    if (base64ToBytes(e[0])[0] !== 1) continue;
    const txid = hashToHex(base64ToBytes(e[1]));
    const d = decodeTx(await c.getTransaction(txid), net);
    if (d.type === 9) {
      await add('spark-spend-v1', txid, 'Spark spend, chaum v1 (type 9)');
      break;
    }
  }
}

// spark name registration: a name's fee script is unique, so its history is the registration
const names = await c.sparkNames();
console.error('names registered:', names.length);
for (const { name, address } of names.slice(-40).reverse()) {
  const base = addressToScript(net.sparkNameFeeAddress, net);
  const script = concatBytes(base, Uint8Array.of(OP.OP_SPARKNAMEID), pushData(utf8ToBytes(name)), Uint8Array.of(OP.OP_DROP), pushData(utf8ToBytes(address)), Uint8Array.of(OP.OP_DROP));
  const h = await c.getHistory(scriptHash(script));
  if (h.length) {
    await add('spark-name', h[0].tx_hash, `Spark name "${name}" registration (fee to ${net.sparkNameFeeAddress})`);
    break;
  }
}

// lelantus (legacy, for labelling): look through the first transactions of a few 2022-2023 blocks
const lel = await findInBlocks([700000, 600000, 500000, 450000], 10, (d) => d.kind === 'lelantus');
if (lel) await add('lelantus', lel, 'Lelantus (legacy)');

c.close();
writeFileSync(outPath, JSON.stringify({ comment: 'Real Firo mainnet transactions, fetched once by tools/firo_fetch_fixtures.mjs from ' + NETWORKS.main.servers[0].replace(/:\d+$/, '') + ' (and siblings).', fetched: new Date().toISOString().slice(0, 10), txs: found, usedTags }, null, 1) + '\n');
console.error('wrote', outPath, found.length, 'transactions');
