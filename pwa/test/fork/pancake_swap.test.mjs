// Buying and selling rsFIRO on BNB Chain (PancakeSwap v3, rsFIRO/WBNB 1%) on a fork of BNB Chain
// at the latest block: the wallet's own quote, swap builder, approval and type-2 signing for chain
// 56, sent to the fork (its own anvil on port 8548; the shared Ethereum fork is not touched).
//
//   node --test test/fork/pancake_swap.test.mjs   (needs ~/.foundry/bin/anvil and the network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { secp256k1 } from '../../src/vendor/noble/noble-curves/secp256k1.js';
import { quoteSwap, buildSwap, minOut, approveTx, receivedFromReceipt, PANCAKE } from '../../src/lib/eth/pancake.js';
import { signTransaction } from '../../src/lib/eth/tx.js';
import { privateKeyToAddress } from '../../src/lib/eth/crypto.js';
import { RSFIRO_BSC } from '../../src/lib/eth/tokens.js';

const PORT = 8548;
const URL_ = 'https://bsc-dataseed.bnbchain.org';
const GWEI = 1000000000n;
const BNB = 10n ** 18n;
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const bytesHex = (b) => (typeof b === 'string' ? b : `0x${Buffer.from(b).toString('hex')}`);

async function rpc(method, params = []) {
  const r = await fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
// The small interface lib/eth/pancake.js asks of a server.
const chain = {
  ethCall: async ({ to, data }) => Buffer.from((await rpc('eth_call', [{ to, data: bytesHex(data) }, 'latest'])).slice(2), 'hex'),
  blockNumber: async () => Number(await rpc('eth_blockNumber')),
};

let child;
test.before(async () => {
  child = spawn(`${homedir()}/.foundry/bin/anvil`, ['--fork-url', URL_, '--port', String(PORT), '--silent', '--no-storage-caching'], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await rpc('eth_chainId')) === '0x38') return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the BNB Chain fork did not start');
});
test.after(() => child && child.kill());

const sk = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : secp256k1.utils.randomPrivateKey();
const me = privateKeyToAddress(sk);

async function send({ to, data, value = 0n }) {
  const nonce = BigInt(await rpc('eth_getTransactionCount', [me, 'latest']));
  const gas = BigInt(await rpc('eth_estimateGas', [{ from: me, to, data: bytesHex(data), value: hex(value) }]));
  const signed = signTransaction({ chainId: 56, nonce, maxPriorityFeePerGas: 1n * GWEI, maxFeePerGas: 10n * GWEI, gasLimit: (gas * 12n) / 10n, to, value, data }, sk);
  assert.equal(signed.from.toLowerCase(), me.toLowerCase());
  const hash = await rpc('eth_sendRawTransaction', [signed.raw]);
  assert.equal(hash, signed.hash);
  for (let i = 0; i < 120; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`not mined: ${hash}`);
}
const rsBalance = async (who) => BigInt(await rpc('eth_call', [{ to: RSFIRO_BSC.address, data: `0x70a08231${who.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));
const deadline = async () => BigInt(Number((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp)) + 1200n;

test('buy rsFIRO with 0.1 BNB: quote, build, sign for chain 56, mined; what arrived matches the quote', { timeout: 3 * 60000 }, async () => {
  await rpc('anvil_setBalance', [me, hex(BNB)]);
  const amountIn = BNB / 10n;
  const q = await quoteSwap(chain, { side: 'buy', amountIn });
  console.log(`# 0.1 BNB -> ${Number(q.amountOut) / 1e8} rsFIRO (impact ${(q.priceImpact * 100).toFixed(2)}%)`);
  assert.ok(q.amountOut > 0n);
  const tx = buildSwap({ side: 'buy', amountIn, minAmountOut: minOut(q.amountOut), recipient: me, deadline: await deadline() });
  assert.equal(tx.to, PANCAKE.smartRouter);
  const r = await send(tx);
  assert.equal(r.status, '0x1');
  const got = receivedFromReceipt(r, me, 'buy');
  assert.ok(got >= minOut(q.amountOut) && got <= q.amountOut + q.amountOut / 100n, `received ${got} for a quote of ${q.amountOut}`);
  assert.equal(await rsBalance(me), got);
  console.log(`# buy gas ${Number(r.gasUsed)}`);
});

test('sell it back: an exact approval, then rsFIRO -> BNB, unwrapped to this address', { timeout: 3 * 60000 }, async () => {
  const amountIn = await rsBalance(me);
  assert.ok(amountIn > 0n);
  const a = await send(approveTx(amountIn));
  assert.equal(a.status, '0x1');
  const q = await quoteSwap(chain, { side: 'sell', amountIn });
  const before = BigInt(await rpc('eth_getBalance', [me, 'latest']));
  const r = await send(buildSwap({ side: 'sell', amountIn, minAmountOut: minOut(q.amountOut), recipient: me, deadline: await deadline() }));
  assert.equal(r.status, '0x1');
  assert.equal(await rsBalance(me), 0n);
  const got = receivedFromReceipt(r, me, 'sell');
  assert.ok(got >= minOut(q.amountOut), `received ${got}`);
  const after = BigInt(await rpc('eth_getBalance', [me, 'latest']));
  assert.ok(after > before - 2n * 10n ** 15n, 'BNB came back (less gas)');
  console.log(`# sell ${Number(amountIn) / 1e8} rsFIRO -> ${Number(got) / 1e18} BNB, gas ${Number(r.gasUsed)}`);
});
