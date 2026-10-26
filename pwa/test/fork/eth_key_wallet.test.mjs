// A wallet imported from a private key, on the local anvil mainnet fork,
// signing through the app's own paths: the key typed as a person would,
// sealed with kind 'key', then a payment (lib/eth/send.js) and Uniswap swaps
// both ways with the approval and the Permit2 signature
// (lib/eth/uniswap_app.js), every signature made inside withEthKey. A fresh
// random key funded with anvil_setBalance: anvil's key 0 carries EIP-7702
// code on mainnet. Takes the shared fork lock; puts the fork back afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyFromText, privateKeyToAddress, wipe } from '../../src/lib/eth/crypto.js';
import { bytesToHex } from '../../src/lib/eth/hex.js';
import { saveEthKey, getEthRecord, ethRecordKind } from '../../src/lib/eth/vault.js';
import { prepareSend, signAndSend, followOnce, entryFee } from '../../src/lib/eth/send.js';
import { loadOutbox } from '../../src/lib/eth/outbox.js';
import { ethWallet, forgetEthWallet } from '../../src/lib/eth/wallet.js';
import { signAndBroadcast, permitSigner, walletAsset, RSFIRO_TOKEN } from '../../src/lib/eth/uniswap_app.js';
import { ETH_TOKEN } from '../../src/lib/eth/uniswap/models.js';
import { ADDRESSES } from '../../src/lib/eth/uniswap/constants.js';
import { ETH } from '../../src/lib/eth/tokens.js';
import { newDbPassword } from '../../src/lib/envelope.js';
import { anvilProblem, withFork, forkRpc, service, raw } from './uniswap_support.mjs';
import { freshAddress, walletOnFork } from './fork_support.mjs';

const skip = await anvilProblem();
const ETHER = 10n ** 18n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const memoryKv = () => {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)), del: async (k) => void m.delete(k) };
};

/** A random valid key as a person would paste it: 0x, uppercase, spaces around. Never printed. */
function typedRandomKey() {
  for (;;) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    const k = BigInt(bytesToHex(b));
    wipe(b);
    if (k > 0n && k < N) return `  0x${k.toString(16).padStart(64, '0').toUpperCase()}\n`;
  }
}

/** A Firo wallet and, beside it, an Ethereum wallet imported from a fresh private key, funded on the fork. */
async function keyWallet(eth) {
  const kv = memoryKv();
  const app = { record: { id: 'w-fork-key', imported: false }, dbPass: newDbPassword(), prefs: {} };
  const sk = privateKeyFromText(typedRandomKey());
  const address = privateKeyToAddress(sk);
  const record = await saveEthKey(app, { sk, address, kind: 'key' }, { kv });
  wipe(sk);
  assert.equal(ethRecordKind(await getEthRecord(kv)), 'key');
  assert.equal(await raw('eth_getCode', [address, 'latest']), '0x', 'a fresh address has no code');
  await raw('anvil_setBalance', [address, `0x${eth.toString(16)}`]);
  const rpc = forkRpc();
  const w = await ethWallet(app, { kv });
  walletOnFork(w, rpc);
  assert.equal(w.state.address, address);
  return { app, kv, w, rpc, address, ethId: record.id };
}

async function untilDone(app, rpc, entry, opts) {
  let e = entry;
  for (let i = 0; i < 200 && (e.state === 'signed' || e.state === 'pending'); i++) {
    e = await followOnce(app, rpc, e, opts);
    if (e.state === 'signed' || e.state === 'pending') await new Promise((r) => setTimeout(r, 250));
  }
  return e;
}

test('fork: a private-key wallet sends 0.01 ETH: sealed key -> withEthKey -> outbox -> broadcast -> receipt', { skip: skip || false, timeout: 5 * 60000 }, () =>
  withFork(async () => {
    const { app, kv, w, rpc, address, ethId } = await keyWallet(ETHER);
    await w.refresh();
    assert.equal(w.state.error, null);
    assert.equal(w.state.eth, ETHER);
    const to = freshAddress();
    const p = await prepareSend(rpc, { from: address, asset: ETH, recipient: to, amount: 10n ** 16n, balances: w.balances() });
    const r = await signAndSend(app, rpc, p, { ethId, kv });
    assert.equal(r.sent, true);
    assert.equal(r.entry.from.toLowerCase(), address.toLowerCase(), 'signed by the imported key');
    const done = await untilDone(app, rpc, r.entry, { ethId, kv });
    assert.equal(done.state, 'confirmed');
    const fee = entryFee(done);
    assert.equal(BigInt(await raw('eth_getBalance', [to, 'latest'])), 10n ** 16n);
    assert.equal(BigInt(await raw('eth_getBalance', [address, 'latest'])), ETHER - 10n ** 16n - fee.wei);
    assert.deepEqual((await loadOutbox(app, { ethId, kv })).map((e) => [e.asset, e.state]), [['ETH', 'confirmed']]);
    forgetEthWallet();
  }));

test('fork: a private-key wallet swaps ETH -> rsFIRO and back: approval, Permit2 signature and swaps all signed in withEthKey', { skip: skip || false, timeout: 15 * 60000 }, (t) =>
  withFork(async () => {
    const { app, kv, w, rpc, address, ethId } = await keyWallet(2n * ETHER);
    const svc = service(rpc);
    const follow = async (r) => {
      assert.equal(r.sent, true, r.error && r.error.message);
      assert.equal(r.entry.from.toLowerCase(), address.toLowerCase());
      const e = await untilDone(app, rpc, r.entry, { ethId, kv });
      assert.equal(e.state, 'confirmed', e.kind);
      return e;
    };
    const swapOnce = async (q) => {
      const review = await svc.reviewSwap({ quote: q, slippageBips: 100, owner: address });
      const done = await svc.finalizeSwap({ review, signPermit: permitSigner(app, w) });
      assert.equal(done.permitSigned, !q.tokenIn.isEth);
      return follow(await signAndBroadcast(app, w, done.tx, { kind: 'swap', asset: walletAsset(q.tokenIn), amount: q.amountIn, extra: { tokenOutSymbol: q.tokenOut.symbol, minimumOut: String(done.minimumOut) } }));
    };

    const buy = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: RSFIRO_TOKEN, amountIn: ETHER / 100n, owner: address });
    await swapOnce(buy);
    const have = await svc.balanceOf(RSFIRO_TOKEN, address);
    assert.ok(have > 0n, 'rsFIRO arrived');

    const sell = await svc.quote({ tokenIn: RSFIRO_TOKEN, tokenOut: ETH_TOKEN, amountIn: have, owner: address });
    const approval = await svc.approvalFor(sell, address);
    assert.equal(approval.kind, 'approve');
    for (const tx of await svc.approvalTxs(approval, address)) {
      await follow(await signAndBroadcast(app, w, tx, { kind: tx.kind, asset: walletAsset(RSFIRO_TOKEN), amount: approval.amount, extra: { spender: ADDRESSES.permit2 } }));
    }
    const ethBefore = await rpc.getBalance(address);
    const sold = await swapOnce(sell);
    assert.equal(await svc.balanceOf(RSFIRO_TOKEN, address), 0n, 'all of it was sold');
    assert.ok((await rpc.getBalance(address)) + entryFee(sold).wei > ethBefore, 'ETH came back');
    const kinds = (await loadOutbox(app, { ethId, kv })).map((e) => [e.kind, e.state]);
    t.diagnostic(`outbox: ${JSON.stringify(kinds)}`);
    assert.deepEqual(kinds, [['swap', 'confirmed'], ['approve', 'confirmed'], ['swap', 'confirmed']]);
    forgetEthWallet();
  }));
