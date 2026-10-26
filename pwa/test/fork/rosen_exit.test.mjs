// Rosen exits (rsFIRO -> FIRO), simulated on forks of Ethereum and BNB Chain at the latest block
// (owner: no live crossing). Each run starts its own anvil (ports 8546 and 8547, so the shared
// Ethereum fork on 8545 is not touched), gives a throwaway address 3,000 rsFIRO from Rosen's own
// lock, sends the exact call lib/rosen builds, and checks: it succeeds, rsFIRO moves to Rosen's
// lock, the transaction's input on chain still ends with the planned payload, and the gas.
//
//   node --test test/fork/rosen_exit.test.mjs     (needs ~/.foundry/bin/anvil and the network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { evmExitCall, verifyEvmExitCall, decodePayload, quote, LOCK, RSFIRO } from '../../src/lib/rosen/rosen.js';
import { NETWORKS } from '../../src/lib/firo/params.js';

const MAIN = NETWORKS.main;
const ANVIL = `${homedir()}/.foundry/bin/anvil`;
const FORKS = {
  ethereum: { port: 8546, url: 'https://ethereum-rpc.publicnode.com', chainId: '0x1', gasMax: 45000 },
  bsc: { port: 8547, url: 'https://bsc-dataseed.bnbchain.org', chainId: '0x38', gasMax: 45000 },
};
const USER = '0x00000000000000000000000000000000c0ffee01';
// A Firo address for the payload: BIP39's public test phrase's first, never a real wallet's (H1).
const FIRO_DEST = 'a1bW3sVVUsLqgKuTMXtSaAHGvpxKwugxPH';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SAT = 100000000n;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

async function rpc(port, method, params = []) {
  const r = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function startFork({ port, url }) {
  const child = spawn(ANVIL, ['--fork-url', url, '--port', String(port), '--silent', '--no-storage-caching'], { stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try {
      await rpc(port, 'eth_chainId');
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  child.kill();
  throw new Error(`anvil on ${port} did not start`);
}

async function sendAs(port, from, to, data) {
  await rpc(port, 'anvil_impersonateAccount', [from]);
  await rpc(port, 'anvil_setBalance', [from, hex(10n ** 19n)]);
  const hash = await rpc(port, 'eth_sendTransaction', [{ from, to, data, gas: hex(200000) }]);
  for (let i = 0; i < 120; i++) {
    const r = await rpc(port, 'eth_getTransactionReceipt', [hash]);
    if (r) return { hash, receipt: r };
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`not mined: ${hash}`);
}
const balanceOf = async (port, token, who) => BigInt(await rpc(port, 'eth_call', [{ to: token, data: `0x70a08231${who.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));

for (const chain of ['ethereum', 'bsc']) {
  test(`${chain} -> FIRO: the exit lib/rosen builds runs on a fork of ${chain}`, { timeout: 5 * 60000 }, async () => {
    const f = FORKS[chain];
    const child = await startFork(f);
    try {
      assert.equal(await rpc(f.port, 'eth_chainId'), f.chainId);
      const lockBal = await balanceOf(f.port, RSFIRO[chain], LOCK[chain]);
      assert.ok(lockBal >= 3000n * SAT, `Rosen's ${chain} lock holds ${lockBal} rsFIRO units`);
      // 3,000 rsFIRO from Rosen's lock to our throwaway address (rsFIRO has 8 decimals).
      const fund = `0xa9059cbb${USER.slice(2).padStart(64, '0')}${(3000n * SAT).toString(16).padStart(64, '0')}`;
      await sendAs(f.port, LOCK[chain], RSFIRO[chain], fund);
      assert.equal(await balanceOf(f.port, RSFIRO[chain], USER), 3000n * SAT);

      const q = quote({ from: chain, to: 'firo', amount: 3000n * SAT, firoUsd: 0.9486 });
      const plan = { from: chain, destination: FIRO_DEST, amount: 3000n * SAT, bridgeFee: q.bridgeFee, networkFee: q.networkFee };
      const call = evmExitCall(plan, MAIN);
      assert.deepEqual(verifyEvmExitCall(call, plan, MAIN), []);
      const lockBefore = await balanceOf(f.port, RSFIRO[chain], LOCK[chain]);
      const { hash, receipt } = await sendAs(f.port, USER, call.to, call.data);
      assert.equal(receipt.status, '0x1', 'the token accepts the appended payload');
      // rsFIRO moved from our address to Rosen's lock: the Transfer event and the balances.
      const tr = receipt.logs.find((l) => l.topics[0] === TRANSFER_TOPIC && l.address.toLowerCase() === RSFIRO[chain]);
      assert.ok(tr, 'a Transfer event');
      assert.equal(`0x${tr.topics[1].slice(26)}`, USER.toLowerCase());
      assert.equal(`0x${tr.topics[2].slice(26)}`, LOCK[chain]);
      assert.equal(BigInt(tr.data), 3000n * SAT);
      assert.equal(await balanceOf(f.port, RSFIRO[chain], USER), 0n);
      assert.equal(await balanceOf(f.port, RSFIRO[chain], LOCK[chain]), lockBefore + 3000n * SAT);
      // What Rosen's watchers read: the input on chain still carries the payload, intact.
      const tx = await rpc(f.port, 'eth_getTransactionByHash', [hash]);
      const p = decodePayload(tx.input.slice(2 + 8 + 128), MAIN);
      assert.deepEqual({ to: p.to, destination: p.destination, bridgeFee: p.bridgeFee, networkFee: p.networkFee }, { to: 'firo', destination: FIRO_DEST, bridgeFee: q.bridgeFee, networkFee: q.networkFee });
      const gas = Number(receipt.gasUsed);
      console.log(`# ${chain}: exit gas ${gas}`);
      assert.ok(gas > 20000 && gas < f.gasMax, `gas ${gas}`);
    } finally {
      child.kill();
    }
  });
}
