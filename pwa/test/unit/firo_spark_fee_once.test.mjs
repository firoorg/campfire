// "Fee from the amount" (and Max) on a private payment: the fee is taken once. The engine takes it
// off the amounts itself (_planSparkSpend) and hands the library what each recipient receives with
// subtractFeeFromAmount false (_buildSparkSpend). With the real Spark library and the golden spend
// vectors (throwaway keys): the receiver gets exactly amount - fee, the library's fee is the one
// the plan showed, and the proof verifies, to a public and to a private recipient. Asking the
// library to subtract again (the old call) leaves the receiver one fee short.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import createSparkModule from '../../src/vendor/spark/spark.js';
import { loadSparkCore } from '../../src/lib/firo/spark/core.js';
import { hexToBytes } from '../../src/lib/firo/spark/codec.js';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const V = JSON.parse(await readFile(at('../fixtures/firo_spark_vectors.json'), 'utf8'));
const core = await loadSparkCore({ createModule: createSparkModule, wasmBinary: await readFile(at('../../src/vendor/spark/spark.wasm')) });

function spendBase(label) {
  const s = V.spends.find((x) => x.rngLabel === label);
  const k = V.keys.find((x) => x.name === s.key);
  const sets = s.anonymitySets.map((a) => ({ setId: a.setId, setHash: hexToBytes(a.setHash), coins: a.coins.map(hexToBytes) }));
  return {
    s,
    k,
    sets,
    base: {
      privateKey: k.privateKey,
      index: k.index,
      recipients: [],
      privateRecipients: [],
      coins: s.coins.map((c) => ({ serializedCoin: hexToBytes(c.coin), serializedCoinContext: hexToBytes(c.context), groupId: c.groupId, height: c.height })),
      anonymitySets: sets,
      idAndBlockHashes: s.blockHashes.map((b) => ({ setId: b.setId, blockHash: hexToBytes(b.blockHash) })),
      txHash: hexToBytes(s.txHashSig),
      additionalTxSize: 0,
      spendVersion: s.spendVersion,
      extensionCommitment: hexToBytes(s.extensionCommitment),
    },
  };
}
const verifies = ({ s, sets }, r, transparentOut) =>
  core.verifySparkSpend({ spendVersion: s.spendVersion, serializedSpendPayload: r.serializedSpendPayload, outputScripts: r.outputScripts, transparentOut, anonymitySets: sets, txHash: hexToBytes(s.txHashSig) }).valid;

test('to a public address: the fee shown is the fee charged, the output is amount - fee, the proof verifies', () => {
  const v = spendBase('spend-v2-one-input');
  const AMOUNT = 20000000n;
  // The plan's fee: what the library charges for this amount with the fee taken from it.
  const fee = BigInt(core.createSparkSendTransaction({ ...v.base, recipients: [{ amount: AMOUNT, subtractFeeFromAmount: true }] }).fee);
  // The engine's call: the reduced amount, the library not asked to subtract.
  const r = core.createSparkSendTransaction({ ...v.base, recipients: [{ amount: AMOUNT - fee, subtractFeeFromAmount: false }] });
  assert.equal(BigInt(r.fee), fee, 'the fee Review showed');
  assert.equal(verifies(v, r, AMOUNT - fee), true, 'balances with the output the engine writes');
  // The old call: subtracted again, so the engine's output no longer matches the proof.
  const twice = core.createSparkSendTransaction({ ...v.base, recipients: [{ amount: AMOUNT - fee, subtractFeeFromAmount: true }] });
  assert.equal(verifies(v, twice, AMOUNT - fee), false);
});

test('to a private address: the receiver gets exactly amount - fee, at the fee shown', () => {
  const v = spendBase('spend-v2-two-inputs');
  const k2 = V.keys.find((x) => x.name === 'k2');
  const to = v.s.privateRecipients[0].address;
  const PRIV = 100000000n;
  const contextOf = (r) => {
    const own = core.identifyCoins({ fullViewKey: v.k.fullViewKey, coins: r.usedCoins.map((u) => ({ coin: u.serializedCoin, context: u.serializedCoinContext })) }).found;
    const out = new Uint8Array(1 + 34 * own.length);
    out[0] = own.length;
    own.forEach((c, i) => out.set(c.tag, 1 + 34 * i));
    return out;
  };
  const receiverGets = (r) => {
    const ctx = contextOf(r);
    const found = core.identifyCoins({ fullViewKey: k2.fullViewKey, coins: r.outputScripts.map((sc) => ({ coin: sc.subarray(1), context: ctx })) }).found;
    return found.reduce((s, c) => s + BigInt(c.value), 0n);
  };
  const fee = BigInt(core.createSparkSendTransaction({ ...v.base, privateRecipients: [{ address: to, amount: PRIV, memo: '', subtractFeeFromAmount: true }] }).fee);
  const r = core.createSparkSendTransaction({ ...v.base, privateRecipients: [{ address: to, amount: PRIV - fee, memo: '', subtractFeeFromAmount: false }] });
  assert.equal(BigInt(r.fee), fee, 'the fee Review showed');
  assert.equal(receiverGets(r), PRIV - fee, 'what Review said they get');
  assert.equal(verifies(v, r, 0n), true);
  const twice = core.createSparkSendTransaction({ ...v.base, privateRecipients: [{ address: to, amount: PRIV - fee, memo: '', subtractFeeFromAmount: true }] });
  assert.equal(receiverGets(twice), PRIV - 2n * fee, 'the old call: one fee short');
});
