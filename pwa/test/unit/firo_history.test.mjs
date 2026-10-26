// Coin selection and the activity list, as pure functions: which coins are
// chosen and what the fee and change come to; how transactions are labelled
// (incoming, outgoing, self, coinbase vs masternode, privatize, Spark) and how
// one transaction seen from both sides becomes one entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectCoins, planExplicit } from '../../src/lib/firo/transparent.js';
import { transparentEntries, sparkEntries, mergeEntries } from '../../src/lib/firo/history.js';
import { decodeTx, estimateSize, feeForSize, buildSignedTransaction } from '../../src/lib/firo/tx.js';
import { addressToScript, scriptHash } from '../../src/lib/firo/address.js';
import { p2pkhScript, opReturnScript } from '../../src/lib/firo/script.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { hexToBytes } from '../../src/lib/firo/bytes.js';

const MAIN = NETWORKS.main;
const F = JSON.parse(readFileSync(new URL('../fixtures/firo_txs.json', import.meta.url), 'utf8'));
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const A = KEYS.vectors[0].addresses;
const S = (i) => addressToScript(A[i].address, MAIN);
const coin = (value, i = 0) => ({ txid: String(i).padStart(64, '0'), vout: 0, value, script: S(0) });
const CHANGE = S(3);
const DEST = [{ script: S(2), value: 100000n }];

test('selection: the smallest single coin that covers the payment, with change', () => {
  const r = selectCoins({ utxos: [coin(5000000n, 1), coin(300000n, 2), coin(150000n, 3)], outputs: DEST, feePerKb: 1000n, changeScript: CHANGE });
  assert.deepEqual(r.inputs.map((u) => u.value), [150000n]);
  assert.equal(r.fee, feeForSize(estimateSize(1, [S(2), CHANGE]), 1000n));
  assert.equal(r.change, 150000n - 100000n - r.fee);
  assert.equal(r.outputs.at(-1).change, true);
});

test('selection: largest first when no single coin is enough; change under dust goes to the fee', () => {
  const r = selectCoins({ utxos: [coin(60000n, 1), coin(40500n, 2), coin(30000n, 3)], outputs: DEST, feePerKb: 1000n, changeScript: CHANGE });
  assert.deepEqual(r.inputs.map((u) => u.value), [60000n, 40500n]);
  assert.equal(r.change, 0n); // 100,500 − 100,000 − 374 would be 126 sat of change: dust
  assert.equal(r.fee, 500n);
  assert.equal(r.outputs.length, 1);
  const r2 = selectCoins({ utxos: [coin(60000n, 1), coin(50000n, 2), coin(40000n, 3)], outputs: DEST, feePerKb: 1000n, changeScript: CHANGE });
  assert.deepEqual(r2.inputs.map((u) => u.value), [60000n, 50000n]);
  assert.equal(r2.change, 110000n - 100000n - r2.fee);
});

test('selection: not enough, dust amounts, subtract-fee and send-all', () => {
  assert.throws(() => selectCoins({ utxos: [coin(50000n)], outputs: DEST, feePerKb: 1000n, changeScript: CHANGE }), (e) => e.code === 'insufficient' && e.available === 50000n);
  assert.throws(() => selectCoins({ utxos: [coin(50000n)], outputs: [{ script: S(2), value: 999n }], feePerKb: 1000n, changeScript: CHANGE }), (e) => e.code === 'dust');
  const sub = selectCoins({ utxos: [coin(100000n)], outputs: DEST, feePerKb: 1000n, changeScript: CHANGE, subtractFee: true });
  assert.equal(sub.outputs[0].value + sub.fee, 100000n);
  assert.equal(sub.change, 0n);
  const all = selectCoins({ utxos: [coin(70000n, 1), coin(80000n, 2)], outputs: [{ script: S(2), value: 1000n }, { script: opReturnScript(Uint8Array.of(1, 2)), value: 0n }], feePerKb: 2000n, changeScript: CHANGE, sendAll: true });
  assert.equal(all.inputs.length, 2);
  assert.equal(all.outputs[0].value + all.fee, 150000n);
  assert.equal(all.fee, feeForSize(estimateSize(2, [S(2), opReturnScript(Uint8Array.of(1, 2))]), 2000n));
});

test('explicit coins: all of them are spent, never more', () => {
  const utxos = [coin(70000n, 1), coin(80000n, 2)];
  const r = planExplicit({ utxos, outputs: DEST, feePerKb: 1000n, changeScript: CHANGE });
  assert.equal(r.inputs.length, 2);
  assert.equal(r.change, 150000n - 100000n - r.fee);
  assert.throws(() => planExplicit({ utxos: [coin(70000n, 1)], outputs: DEST, feePerKb: 1000n, changeScript: CHANGE }), (e) => e.code === 'insufficient');
  assert.throws(() => planExplicit({ utxos: [utxos[0], utxos[0]], outputs: DEST, feePerKb: 1000n, changeScript: CHANGE }), /twice/);
});

// ---------------------------------------------------------------- the activity list

// As the engine holds them once their Merkle proof passed (audit FE-1: before that, never confirmed).
const rec = (hex, height, extra = {}) => {
  const decoded = decodeTx(hex, MAIN);
  return [decoded.txid, { decoded, height, time: 1791790000, firstSeen: 1791790000, inputs: null, proof: 'two-servers', ...extra }];
};
const fx = (label) => F.txs.find((t) => t.label === label);

test('the real coinbase: paid to us as the largest output is a masternode payout, otherwise a block reward', () => {
  const t = fx('coinbase');
  const d = decodeTx(t.hex, MAIN);
  const largest = d.vout.reduce((a, o) => (o.value > a.value ? o : a));
  const smallest = d.vout.reduce((a, o) => (o.value < a.value ? o : a));
  const records = new Map([rec(t.hex, t.height)]);
  const asMn = transparentEntries({ net: MAIN, records, isOwnScript: (s) => scriptHash(s) === scriptHash(largest.script), tipHeight: t.height + 99 }).get(t.txid);
  assert.equal(asMn.kind, 'masternode');
  assert.equal(asMn.amount, largest.value);
  assert.equal(asMn.confirmations, 100);
  const asMiner = transparentEntries({ net: MAIN, records, isOwnScript: (s) => scriptHash(s) === scriptHash(smallest.script), tipHeight: t.height }).get(t.txid);
  assert.equal(asMiner.kind, 'coinbase');
  assert.equal(asMiner.direction, 'in');
});

test('a real Spark spend paying a transparent address: incoming "spark" to that address', () => {
  const t = fx('spark-spend-v1');
  const d = decodeTx(t.hex, MAIN);
  const out = d.vout.find((o) => o.type === 'p2pkh');
  const e = transparentEntries({ net: MAIN, records: new Map([rec(t.hex, t.height)]), isOwnScript: (s) => scriptHash(s) === scriptHash(out.script), tipHeight: t.height }).get(t.txid);
  assert.equal(e.kind, 'spark');
  assert.equal(e.direction, 'in');
  assert.equal(e.amount, out.value);
  assert.equal(e.sparkFee, 3083n);
});

// Synthetic: our coin (vector key 0) pays others, ourselves, mints.
const K0 = { sk: hexToBytes(A[0].privkey) };
const parentHex = buildSignedTransaction({ inputs: [{ txid: 'aa'.repeat(32), vout: 0, value: 10n ** 8n, script: addressToScript(KEYS.vectors[2].addresses[0].address, MAIN), sk: hexToBytes(KEYS.vectors[2].addresses[0].privkey) }], outputs: [{ script: S(0), value: 99990000n }] }).hex;
const parentId = decodeTx(parentHex).txid;
const own = (s) => [S(0), S(1), S(3)].some((x) => scriptHash(x) === scriptHash(s));
const spendOwn = (outputs) => buildSignedTransaction({ inputs: [{ txid: parentId, vout: 0, value: 99990000n, script: S(0), sk: K0.sk }], outputs }).hex;

test('outgoing, to ourselves, and the fee from our own parent transaction', () => {
  const payHex = spendOwn([{ script: S(2), value: 50000000n }, { script: S(3), value: 49980000n }]);
  const selfHex = spendOwn([{ script: S(1), value: 99980000n }]);
  const records = new Map([rec(parentHex, 100), rec(payHex, 0), rec(selfHex, 0)]);
  const m = transparentEntries({ net: MAIN, records, isOwnScript: own, tipHeight: 200 });
  const pay = m.get(decodeTx(payHex).txid);
  assert.deepEqual([pay.direction, pay.kind, pay.amount, pay.fee, pay.counterparty, pay.height], ['out', 'transparent', 50000000n, 10000n, A[2].address, null]);
  const self = m.get(decodeTx(selfHex).txid);
  assert.deepEqual([self.direction, self.amount, self.fee], ['self', 99980000n, 10000n]);
  const parent = m.get(parentId);
  assert.deepEqual([parent.direction, parent.amount, parent.confirmations], ['in', 99990000n, 101]);
});

test('audit FE-1: a payment to us in a block on the node\'s word only is not confirmed until proven', () => {
  // 'one-server': no second node answered (release re-audit R1-3: one node's word is not a proof).
  for (const proof of [undefined, 'unproven', 'failed', 'one-server']) {
    const [id, r] = rec(parentHex, 100, { proof });
    const e = transparentEntries({ net: MAIN, records: new Map([[id, r]]), isOwnScript: own, tipHeight: 105 }).get(id);
    assert.deepEqual([e.confirmations, e.unproven, e.height], [0, true, 100], String(proof));
    const api = mergeEntries(new Map([[id, e]]), new Map())[0];
    assert.deepEqual([api.confirmations, api.unproven], [0, true]);
  }
  for (const proof of ['two-servers', 'own-node']) {
    const [id, r] = rec(parentHex, 100, { proof });
    const e = transparentEntries({ net: MAIN, records: new Map([[id, r]]), isOwnScript: own, tipHeight: 105 }).get(id);
    assert.deepEqual([e.confirmations, e.unproven], [6, undefined], proof);
  }
});

test('privatize: counted as sent until the Spark side recognises the mint as ours, then "self"', () => {
  const mintScript = new Uint8Array(250).fill(0xd1);
  const hex = spendOwn([{ script: mintScript, value: 60000000n }, { script: S(3), value: 39980000n }]);
  const txid = decodeTx(hex).txid;
  const t = transparentEntries({ net: MAIN, records: new Map([rec(parentHex, 100), rec(hex, 101)]), isOwnScript: own, tipHeight: 101 });
  assert.deepEqual([t.get(txid).kind, t.get(txid).direction, t.get(txid).amount, t.get(txid).fee], ['privatize', 'out', 60000000n, 10000n]);
  const s = sparkEntries({ coins: [{ txid, value: 60000000n, memo: '', isChange: false, height: 101 }], tipHeight: 101 });
  const list = mergeEntries(t, s);
  const e = list.find((x) => x.txid === txid);
  assert.deepEqual([e.kind, e.direction, e.amount, e.fee], ['privatize', 'self', '60000000', '10000']);
  assert.equal(list.length, 2);
});

test('Spark: received, change not counted as income, a logged payment with its fee, newest first', () => {
  const coins = [
    { txid: '11'.repeat(32), value: 500n, memo: 'a', isChange: false, height: 10, heightApprox: true, spentTxid: '22'.repeat(32), spentHeight: 20 },
    { txid: '22'.repeat(32), value: 120n, memo: '', isChange: true, height: 20, heightApprox: true },
    { txid: '33'.repeat(32), value: 40n, memo: 'b', isChange: false, height: null, time: 99 },
  ];
  const sends = new Map([['22'.repeat(32), { amount: '370', fee: '10', to: 'sm1someone', memo: 'rent', time: 50 }]]);
  const list = mergeEntries(new Map(), sparkEntries({ coins, sends, tipHeight: 30 }));
  assert.deepEqual(
    list.map((x) => [x.txid.slice(0, 2), x.direction, x.amount, x.fee, x.height, x.memo ?? null]),
    [
      ['33', 'in', '40', '0', null, 'b'],
      ['22', 'out', '370', '10', 20, 'rent'],
      ['11', 'in', '500', '0', null, 'a'],
    ],
  );
  assert.equal(list[1].counterparty, 'sm1someone');
  // Found while restoring (no time): no exact block, the rough one in heightApprox (WALLET_API).
  assert.equal(list[2].heightApprox, 10);
  assert.equal(list[2].confirmations, 21);
});

test('our Spark payment that came back to our own public address is one "self" entry', () => {
  const t = fx('spark-spend-v1');
  const d = decodeTx(t.hex, MAIN);
  const out = d.vout.find((o) => o.type === 'p2pkh');
  const tm = transparentEntries({ net: MAIN, records: new Map([rec(t.hex, t.height)]), isOwnScript: (s) => scriptHash(s) === scriptHash(out.script), tipHeight: t.height });
  // We spent a coin worth exactly that output plus the fee.
  const sm = sparkEntries({ coins: [{ txid: '44'.repeat(32), value: out.value + 3083n, isChange: false, height: 5, spentTxid: t.txid, spentHeight: t.height }], tipHeight: t.height });
  const e = mergeEntries(tm, sm).find((x) => x.txid === t.txid);
  assert.deepEqual([e.direction, e.amount, e.fee, e.kind], ['self', String(out.value), '3083', 'spark']);
});

test('p2pkhScript is what addresses decode to', () => {
  assert.equal(scriptHash(p2pkhScript(addressToScript(A[0].address, MAIN).slice(3, 23))), scriptHash(S(0)));
});

test('restored Spark payments (not sent from here, not asked about): a payment to itself is "self", with its fee', () => {
  const A = 'a1'.repeat(32);
  const S = 'b2'.repeat(32);
  const T = 'c3'.repeat(32);
  const coins = [
    // 2.5 FIRO spent by S: 0.5 back to our own address, 1.99996597 change. Measured on mainnet (fd70c337).
    { txid: A, value: 250000000n, isChange: false, height: 100, heightApprox: true, spentTxid: S, spentHeight: 140 },
    { txid: S, value: 50000000n, memo: 'to myself', isChange: false, height: 120, heightApprox: true },
    { txid: S, value: 199996597n, isChange: true, height: 120, heightApprox: true },
    // 1.99996597 spent by T: 1.5 to someone else, the rest change. Fee unknown: not split out.
    { txid: S, value: 0n, isChange: true, height: 120, heightApprox: true }, // a zero coin changes nothing
  ];
  coins.push({ txid: T, value: 49993000n, isChange: true, height: 130, heightApprox: true });
  coins[2].spentTxid = T;
  coins[2].spentHeight = 140;
  const list = mergeEntries(new Map(), sparkEntries({ coins, tipHeight: 150 }));
  const self = list.find((x) => x.txid === S);
  assert.deepEqual([self.direction, self.amount, self.fee, self.memo], ['self', '50000000', '3403', 'to myself']);
  const out = list.find((x) => x.txid === T);
  assert.deepEqual([out.direction, out.amount, out.fee], ['out', String(199996597n - 49993000n), '0']);
  // Placed at their outputs' blocks (not where the spend was noticed), roughly: no exact height.
  assert.deepEqual([self.height, self.heightApprox, out.heightApprox], [null, 120, 130]);
  assert.deepEqual(list.map((x) => x.txid), [T, S, A]);
});

test('a remainder too large to be a fee is not taken for one', () => {
  const S = 'd4'.repeat(32);
  const coins = [
    { txid: 'e5'.repeat(32), value: 300000000n, isChange: false, height: 10, heightApprox: true, spentTxid: S, spentHeight: 20 },
    { txid: S, value: 100000000n, isChange: false, height: 20, heightApprox: true },
    { txid: S, value: 150000000n, isChange: true, height: 20, heightApprox: true },
  ];
  const e = mergeEntries(new Map(), sparkEntries({ coins, tipHeight: 30 })).find((x) => x.txid === S);
  assert.deepEqual([e.direction, e.amount, e.fee], ['out', '50000000', '0']);
});

test('exact details of our own spends (Settings -> Exact dates): block, date, fee, a Spark name registration', () => {
  const N = 'f6'.repeat(32);
  const coins = [
    { txid: 'a7'.repeat(32), value: 199993482n, isChange: true, height: 90, heightApprox: true, spentTxid: N, spentHeight: 140 },
    { txid: N, value: 99989852n, isChange: true, height: 140, heightApprox: true },
  ];
  // Measured on mainnet (44a9f868): 1 FIRO to the Spark Names fee address, fee 0.0000363.
  const spendInfo = new Map([[N, { height: 117, time: 1791809076, fee: 3630, name: true }]]);
  const e = mergeEntries(new Map(), sparkEntries({ coins, tipHeight: 150, spendInfo })).find((x) => x.txid === N);
  assert.deepEqual([e.kind, e.direction, e.amount, e.fee, e.height, e.time, e.heightApprox], ['spark-name', 'out', '100000000', '3630', 117, 1791809076, undefined]);
  assert.equal(e.confirmations, 34);
});
