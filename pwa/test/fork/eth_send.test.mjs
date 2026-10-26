// The Ethereum wallet's send path against the local anvil mainnet fork, with
// the modules the screens use: prepare (fees, estimate, the token call
// simulated), sign with the sealed key, save to the outbox before
// broadcasting, follow to the receipt; ETH and rsFIRO (taken from the Rosen
// bridge's lock address by impersonating it: rsFIRO is pre-minted). Also the
// wallet object's balances, and "replaced" when another transaction takes
// the nonce: only once the fork shows that transaction (found in its block,
// signed by this wallet, with a receipt). Takes the shared fork lock; puts
// the fork back afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EthRpc } from '../../src/lib/eth/rpc.js';
import { ethKeyFromMnemonic, wipe } from '../../src/lib/eth/crypto.js';
import { signTransaction } from '../../src/lib/eth/tx.js';
import { saveEthKey } from '../../src/lib/eth/vault.js';
import { prepareSend, signAndSend, followOnce, entryFee } from '../../src/lib/eth/send.js';
import { loadOutbox } from '../../src/lib/eth/outbox.js';
import { ethWallet, forgetEthWallet } from '../../src/lib/eth/wallet.js';
import { encodeCall } from '../../src/lib/eth/abi.js';
import { ETH, RSFIRO } from '../../src/lib/eth/tokens.js';
import { newDbPassword } from '../../src/lib/envelope.js';
import { ANVIL, JUNK, ACCOUNT0, raw, anvilProblem, withFork, setBalance, sendAs, erc20Balance, freshAddress, walletOnFork } from './fork_support.mjs';

const skip = await anvilProblem();
/** The Rosen bridge's lock address on Ethereum: it holds the rsFIRO not yet bridged out. */
const ROSEN_LOCK = '0x451698faa07fc68301af622a3ad42205f13c6e4b';
const ETHER = 10n ** 18n;

const memoryKv = () => {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)), del: async (k) => void m.delete(k) };
};
const forkRpc = () => new EthRpc('stackwallet', { fetch: (url, init) => fetch(ANVIL, init) });

async function setup() {
  const kv = memoryKv();
  const app = { record: { id: 'w-fork', imported: false }, dbPass: newDbPassword(), prefs: {} };
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const record = await saveEthKey(app, { sk, address, words: 12 }, { kv });
  wipe(sk);
  return { app, kv, ethId: record.id };
}

async function untilDone(app, rpc, entry, opts) {
  let e = entry;
  for (let i = 0; i < 80 && (e.state === 'signed' || e.state === 'pending'); i++) {
    e = await followOnce(app, rpc, e, opts);
    if (e.state === 'signed' || e.state === 'pending') await new Promise((r) => setTimeout(r, 250));
  }
  return e;
}

test('fork: 0.01 ETH and 12.5 rsFIRO sent through prepare -> sign -> outbox -> broadcast -> receipt, balances exact', { skip: skip || false, timeout: 120000 }, () =>
  withFork(async () => {
    const { app, kv, ethId } = await setup();
    const rpc = forkRpc();
    const ACCOUNT1 = freshAddress();
    await setBalance(ACCOUNT0, 5n * ETHER);
    // rsFIRO: from the Rosen lock address, which holds it.
    await sendAs(ROSEN_LOCK, RSFIRO.address, encodeCall('transfer(address,uint256)', [ACCOUNT0, 100n * 10n ** 8n]));

    const w = await ethWallet(app, { kv });
    // The wallet object asks the server it is given; point it at the fork.
    walletOnFork(w, rpc);
    await w.refresh();
    assert.equal(w.state.error, null);
    assert.equal(w.state.eth, 5n * ETHER);
    assert.equal(w.state.tokens.get('rsFIRO'), 100n * 10n ** 8n);

    // ETH
    const before1 = BigInt(await raw('eth_getBalance', [ACCOUNT1, 'latest']));
    const p = await prepareSend(rpc, { from: ACCOUNT0, asset: ETH, recipient: ACCOUNT1, amount: 10n ** 16n, balances: w.balances() });
    assert.equal(p.tx.gasLimit, 21000n);
    const r = await signAndSend(app, rpc, p, { ethId, kv });
    assert.equal(r.sent, true);
    const done = await untilDone(app, rpc, r.entry, { ethId, kv });
    assert.equal(done.state, 'confirmed');
    const fee = entryFee(done);
    assert.ok(fee.final && fee.wei > 0n && fee.wei <= p.fees.upTo, 'paid no more than "at most"');
    assert.equal(BigInt(await raw('eth_getBalance', [ACCOUNT1, 'latest'])) - before1, 10n ** 16n);
    assert.equal(BigInt(await raw('eth_getBalance', [ACCOUNT0, 'latest'])), 5n * ETHER - 10n ** 16n - fee.wei);

    // rsFIRO
    await w.refresh();
    const q = await prepareSend(rpc, { from: ACCOUNT0, asset: RSFIRO, recipient: ACCOUNT1, amount: 1250000000n, balances: w.balances() });
    const t = await untilDone(app, rpc, (await signAndSend(app, rpc, q, { ethId, kv })).entry, { ethId, kv });
    assert.equal(t.state, 'confirmed');
    assert.equal(await erc20Balance(RSFIRO.address, ACCOUNT0), 100n * 10n ** 8n - 1250000000n);
    assert.equal(await erc20Balance(RSFIRO.address, ACCOUNT1), 1250000000n);
    const list = await loadOutbox(app, { ethId, kv });
    assert.deepEqual(list.map((e) => [e.asset, e.state]), [['rsFIRO', 'confirmed'], ['ETH', 'confirmed']]);
    forgetEthWallet();
  }));

test('fork: a transaction whose nonce another one took is "replaced"', { skip: skip || false, timeout: 120000 }, () =>
  withFork(async () => {
    const { app, kv, ethId } = await setup();
    const rpc = forkRpc();
    const ACCOUNT1 = freshAddress();
    await setBalance(ACCOUNT0, 5n * ETHER);
    // Hold blocks so ours stays in the pool, then mine a different transaction with the same nonce.
    await raw('evm_setAutomine', [false]);
    try {
      const p = await prepareSend(rpc, { from: ACCOUNT0, asset: ETH, recipient: ACCOUNT1, amount: 1n, balances: { eth: 5n * ETHER } });
      const r = await signAndSend(app, rpc, p, { ethId, kv });
      assert.equal(r.sent, true);
      assert.equal((await followOnce(app, rpc, r.entry, { ethId, kv })).state, 'pending');
      await raw('anvil_dropTransaction', [r.entry.hash]);
      const { sk } = await ethKeyFromMnemonic(JUNK);
      const other = signTransaction({ nonce: BigInt(r.entry.nonce), to: ACCOUNT0, value: 0n, gasLimit: 21000n, maxFeePerGas: p.tx.maxFeePerGas * 2n, maxPriorityFeePerGas: p.tx.maxPriorityFeePerGas * 2n }, sk);
      wipe(sk);
      await raw('eth_sendRawTransaction', [other.raw]);
      await raw('evm_mine');
      const e = await followOnce(app, rpc, r.entry, { ethId, kv });
      assert.equal(e.state, 'replaced');
      assert.equal(e.replacedBy, other.hash, 'the transaction that took the nonce, found and checked');
      assert.equal(e.replacedIn, Number(BigInt(await raw('eth_blockNumber'))));
    } finally {
      await raw('evm_setAutomine', [true]);
    }
  }));
