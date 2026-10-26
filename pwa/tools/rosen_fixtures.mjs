#!/usr/bin/env node
// Fetches real Rosen crossings (from the owner's measured reference) into
// test/fixtures/rosen_real.json, so lib/rosen is tested on bytes the chains carry:
//   - FIRO -> BNB Chain: the 2,500 FIRO lock 6cbf1d48… (2026-10-07) and Rosen's rsFIRO delivery on
//     BNB Chain, found by its appended event id;
//   - Ethereum -> FIRO: the 3,000 rsFIRO exit at Ethereum block 26,126,703 and Rosen's FIRO payout
//     262be424…;
//   - BNB Chain -> FIRO: the 3,000 rsFIRO exit at BNB Chain block 124,502,467.
//
//   node tools/rosen_fixtures.mjs
import { writeFileSync } from 'node:fs';
import { ElectrumClient } from '../src/lib/firo/electrum.js';
import { network } from '../src/lib/firo/params.js';
import { LOCK, RSFIRO, eventIdOfFiroLock } from '../src/lib/rosen/rosen.js';

// Old blocks: publicnode wants a token for them; these answer historical logs (BNB Chain: 5,000 blocks a call).
const RPC_LOGS = { ethereum: 'https://eth.drpc.org', bsc: 'https://bsc.rpc.blxrbdn.com' };
// …and transactions by hash (blxrbdn has no transaction index for old ones).
const RPC_TX = { ethereum: 'https://eth.drpc.org', bsc: 'https://bsc-rpc.publicnode.com' };
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
let id = 0;
async function rpc(chain, method, params) {
  const r = await fetch((method === 'eth_getLogs' ? RPC_LOGS : RPC_TX)[chain], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${chain} ${method}: ${j.error.message}`);
  return j.result;
}
const hexn = (n) => `0x${n.toString(16)}`;

/** The rsFIRO transfers to Rosen's lock in one block: [{hash, from, to, input, blockNumber}]. */
async function exitsAt(chain, block) {
  const logs = await rpc(chain, 'eth_getLogs', [{ address: RSFIRO[chain], fromBlock: hexn(block), toBlock: hexn(block), topics: [TRANSFER, null, pad(LOCK[chain])] }]);
  const out = [];
  for (const l of logs) {
    const tx = await rpc(chain, 'eth_getTransactionByHash', [l.transactionHash]);
    out.push({ hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, blockNumber: Number(tx.blockNumber) });
  }
  return out;
}

/** Rosen's rsFIRO deliveries from its lock on `chain` between blocks, whose input ends with `eventId`. */
async function deliveryWith(chain, fromBlock, toBlock, eventId, step = 5000) {
  for (let b = fromBlock; b <= toBlock; b += step) {
    const logs = await rpc(chain, 'eth_getLogs', [{ address: RSFIRO[chain], fromBlock: hexn(b), toBlock: hexn(Math.min(toBlock, b + step - 1)), topics: [TRANSFER, pad(LOCK[chain])] }]);
    for (const l of logs) {
      const tx = await rpc(chain, 'eth_getTransactionByHash', [l.transactionHash]);
      if (tx.input.toLowerCase().endsWith(eventId)) return { hash: tx.hash, from: tx.from, to: tx.to, input: tx.input, blockNumber: Number(tx.blockNumber) };
    }
  }
  return null;
}

const net = network('main');
const c = new ElectrumClient({ servers: [...net.servers], WebSocket: globalThis.WebSocket });
await c.connect();
const FIRO_LOCK = '6cbf1d4808d8321dd66156ce0dc73fa6a4e092ff8e87c5a91543534fda91d2cf';
const FIRO_PAYOUT = '262be424e1650b9db65a6f2112aee6920f5eed4a98c5e42dcf1edf4958630aec';
const lockHex = await c.getTransaction(FIRO_LOCK);
const payoutHex = await c.getTransaction(FIRO_PAYOUT);
const lockTime = (await c.getTransaction(FIRO_LOCK, true)).time;
c.close();

const ethExit = (await exitsAt('ethereum', 26126703))[0] ?? null;
const bscExit = (await exitsAt('bsc', 124502467))[0] ?? null;

// The BNB Chain delivery came ~42 minutes after the lock: find the block near that time.
const eventId = eventIdOfFiroLock(FIRO_LOCK);
const latest = await rpc('bsc', 'eth_getBlockByNumber', ['latest', false]);
const ref = await rpc('bsc', 'eth_getBlockByNumber', [hexn(124502467), false]);
const secsPerBlock = (Number(latest.timestamp) - Number(ref.timestamp)) / (Number(latest.number) - 124502467);
const guess = 124502467 + Math.round((lockTime + 42 * 60 - Number(ref.timestamp)) / secsPerBlock);
const bscDelivery = await deliveryWith('bsc', guess - 20000, guess + 20000, eventId);

const out = {
  comment: 'Real Rosen crossings fetched by tools/rosen_fixtures.mjs from Firo ElectrumX and publicnode RPCs.',
  firoLockToBsc: { txid: FIRO_LOCK, hex: lockHex, time: lockTime, eventId, bscDelivery },
  ethExitToFiro: { exit: ethExit, firoPayout: { txid: FIRO_PAYOUT, hex: payoutHex } },
  bscExitToFiro: { exit: bscExit },
};
writeFileSync(new URL('../test/fixtures/rosen_real.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log('lock', FIRO_LOCK.slice(0, 12), 'eventId', eventId.slice(0, 16), 'bsc delivery', bscDelivery ? bscDelivery.hash : 'NOT FOUND');
console.log('eth exit', ethExit ? ethExit.hash : 'NOT FOUND', 'bsc exit', bscExit ? bscExit.hash : 'NOT FOUND');
