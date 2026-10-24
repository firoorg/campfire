// Firo transactions: real mainnet transactions (fetched once by
// tools/firo_fetch_fixtures.mjs) decode, re-encode byte for byte and are
// labelled right; their P2PKH signatures verify against our legacy sighash;
// and transactions built here sign so that they verify the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '../../src/vendor/noble/noble-curves/secp256k1.js';
import {
  decodeTx,
  serializeTx,
  legacySighash,
  verifyP2PKHInput,
  buildSignedTransaction,
  estimateSize,
  feeForSize,
  lTagHash,
  findSparkNameData,
  parseSparkSpendHeader,
  SIGHASH_ALL,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SIGHASH_ANYONECANPAY,
  TxError,
} from '../../src/lib/firo/tx.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { addressToScript, exchangeAddress, decodeTransparent } from '../../src/lib/firo/address.js';
import { opReturnScript, p2pkhScript, pushData, parseScript, sparkNameFeeScript } from '../../src/lib/firo/script.js';
import { bytesToHex, hexToBytes, base64ToBytes, hashToHex, utf8ToBytes, hash160, concatBytes } from '../../src/lib/firo/bytes.js';

const MAIN = NETWORKS.main;
const F = JSON.parse(readFileSync(new URL('../fixtures/firo_txs.json', import.meta.url), 'utf8'));
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const fx = (label) => {
  const t = F.txs.find((x) => x.label === label);
  assert.ok(t, `fixture ${label}`);
  return t;
};

test('every fixture: txid is SHA256d of the bytes, and re-encoding gives the same bytes', () => {
  assert.equal(F.txs.length, 8);
  for (const t of F.txs) {
    const d = decodeTx(t.hex, MAIN);
    assert.equal(d.txid, t.txid, t.label);
    assert.equal(bytesToHex(serializeTx(d)), t.hex, t.label);
    assert.equal(d.size, t.hex.length / 2);
  }
});

test('coinbase (block 1,393,000): v3 type 5, dev fund, community fund, masternode and miner outputs', () => {
  const d = decodeTx(fx('coinbase').hex, MAIN);
  assert.equal(d.kind, 'coinbase');
  assert.equal(d.isCoinbase, true);
  assert.equal(d.version, 3);
  assert.equal(d.type, 5);
  assert.ok(d.extraPayload.length > 0); // CCbTx
  assert.equal(d.vin[0].kind, 'coinbase');
  assert.equal(d.vin[0].txid, null);
  const addrs = d.vout.map((o) => o.address);
  assert.ok(addrs.includes('a7GJ9bYfbZqvXmEmxzxZyZYtUTQmzckpjG')); // development fund since block 1,205,100
  assert.ok(addrs.includes(MAIN.sparkNameFeeAddress)); // community fund
  const total = d.vout.reduce((s, o) => s + o.value, 0n);
  const largest = d.vout.reduce((a, o) => (o.value > a.value ? o : a));
  assert.equal(largest.value * 100n, total * 70n); // stage 4: 70 % to the masternode
});

test('Spark mint: OP_SPARKMINT outputs with public values, 15 P2PKH inputs whose signatures all verify', () => {
  const t = fx('spark-mint');
  const d = decodeTx(t.hex, MAIN);
  assert.equal(d.kind, 'spark-mint');
  assert.equal(d.version, 1);
  assert.equal(d.type, 0);
  assert.ok(d.vout.some((o) => o.type === 'spark-mint' && o.value > 0n && o.script[0] === 0xd1 && o.address === null));
  assert.equal(d.vin.length, 15);
  d.vin.forEach((_, n) => assert.equal(verifyP2PKHInput(d, n), true, `input ${n}`));
  // With the previous output script given explicitly (from the server's address) it also verifies.
  d.vin.forEach((_, n) => assert.equal(verifyP2PKHInput(d, n, addressToScript(t.inputs[n].address, MAIN)), true));
  // Change one output value: every signature breaks.
  const tampered = { ...d, vout: d.vout.map((o, i) => (i === 0 ? { ...o, value: o.value - 1n } : o)) };
  assert.equal(verifyP2PKHInput(tampered, 0), false);
  // The server's input values account for outputs + fee.
  const inSum = t.inputs.reduce((s, i) => s + BigInt(i.valueSat), 0n);
  const outSum = d.vout.reduce((s, o) => s + o.value, 0n);
  assert.ok(inSum > outSum && inSum - outSum < 100000n);
});

test('plain transparent transfer: P2PKH in and out, signatures verify', () => {
  const d = decodeTx(fx('transparent').hex, MAIN);
  assert.equal(d.kind, 'transparent');
  assert.ok(d.vout.every((o) => o.type === 'p2pkh' && (o.address.startsWith('a') || o.address.startsWith('Z'))));
  d.vin.forEach((_, n) => assert.equal(verifyP2PKHInput(d, n), true));
  // Firo Core's wallet signs with a locktime and nSequence 0xfffffffe, or final; either way it is read.
  assert.ok(d.locktime >= 0);
});

test('Spark spend v2 (type 11): fee, cover sets and the linking tags the server lists for it', () => {
  const t = fx('spark-spend-v2');
  const d = decodeTx(t.hex, MAIN);
  assert.equal(d.kind, 'spark-spend');
  assert.equal(d.version, 3);
  assert.equal(d.type, 11);
  assert.equal(d.versionRaw, 3 | (11 << 16));
  assert.equal(d.vin.length, 1);
  assert.equal(d.vin[0].kind, 'spark-spend');
  assert.equal(d.spark.version, 2);
  assert.equal(d.spark.inputs, 7);
  assert.equal(d.spark.outputs, d.vout.filter((o) => o.type === 'spark-smint').length);
  assert.equal(d.spark.fee, 14927n);
  assert.deepEqual(d.spark.coverSetIds, Array(7).fill(11));
  const serverTags = F.usedTags.filter((u) => hashToHex(base64ToBytes(u.txid)) === t.txid).map((u) => bytesToHex(base64ToBytes(u.tag)));
  assert.equal(serverTags.length, 7);
  assert.deepEqual(d.spark.tags.map(bytesToHex).sort(), serverTags.sort());
  assert.equal(d.sparkName, undefined);
});

test('Spark spend v1 (type 9), still mined after the chaum v2 height: one input, fee, a transparent output', () => {
  const d = decodeTx(fx('spark-spend-v1').hex, MAIN);
  assert.equal(d.kind, 'spark-spend');
  assert.equal(d.type, 9);
  assert.equal(d.spark.version, 1);
  assert.equal(d.spark.inputs, 1);
  assert.equal(d.spark.fee, 3083n);
  assert.deepEqual(d.spark.coverSetIds, [10]);
  assert.equal(d.spark.lTagHashes.length, 1);
  assert.ok(d.vout.some((o) => o.type === 'p2pkh' && o.value > 0n));
  assert.ok(fx('spark-spend-v1').height >= MAIN.sparkChaumV2StartBlock);
});

test('Spark name registration: the name record in the payload and the fee output agree', () => {
  const d = decodeTx(fx('spark-name').hex, MAIN);
  assert.equal(d.kind, 'spark-spend');
  assert.equal(d.type, 11);
  const fee = d.vout.find((o) => o.type === 'spark-name-fee');
  assert.ok(fee);
  assert.equal(fee.address, MAIN.sparkNameFeeAddress);
  assert.equal(fee.value, 10n * 100000000n); // 6 letters: 1 FIRO a year, 10 years
  assert.equal(d.sparkName.name, 'xico88');
  assert.equal(d.sparkName.name, fee.sparkName.name);
  assert.equal(d.sparkName.address, fee.sparkName.address);
  assert.ok(d.sparkName.address.startsWith('sm1'));
  assert.equal(d.sparkName.validityBlocks, 10 * 365 * 24 * 24);
  assert.equal(d.sparkName.operation, 'register');
  assert.equal(d.sparkName.additionalInfo, '');
  // A plain spend has no name record.
  assert.equal(findSparkNameData(decodeTx(fx('spark-spend-v2').hex).extraPayload), null);
});

test('Lelantus (legacy): labelled by type 8 and its joinsplit input', () => {
  const d = decodeTx(fx('lelantus').hex, MAIN);
  assert.equal(d.kind, 'lelantus');
  assert.equal(d.type, 8);
  assert.equal(d.vin[0].kind, 'lelantus-joinsplit');
  assert.ok(d.vout.some((o) => o.type === 'lelantus-jmint'));
});

test('a real Rosen Bridge lock (51,000 FIRO → Ethereum): our OP_RETURN builder writes the same output byte for byte', () => {
  const t = fx('rosen-lock');
  const d = decodeTx(t.hex, MAIN);
  assert.equal(d.kind, 'transparent');
  const lock = d.vout.find((o) => o.address === 'aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y');
  assert.equal(lock.value, 51000n * 100000000n);
  const op = d.vout.find((o) => o.type === 'nulldata');
  assert.equal(op.value, 0n);
  const payload = '03' + '0000000031aba856' + '000000000014f730' + '14' + 'e824fbb56014b08a279857a342efa113cded323d';
  assert.equal(bytesToHex(op.data), payload);
  assert.equal(bytesToHex(op.script), '6a26' + payload);
  assert.equal(bytesToHex(opReturnScript(hexToBytes(payload))), bytesToHex(op.script));
  d.vin.forEach((i, n) => {
    if (parseScript(i.scriptSig).length === 2) assert.equal(verifyP2PKHInput(d, n), true);
  });
});

test('linking tag hashes match Firo\'s Spark library', () => {
  for (const it of KEYS.tagHashes.items) assert.equal(lTagHash(base64ToBytes(it.tag)), it.lTagHash);
  assert.throws(() => lTagHash(new Uint8Array(33)), /34 bytes/);
});

test('garbage and truncated transactions are refused', () => {
  const hex = fx('transparent').hex;
  assert.throws(() => decodeTx(hex.slice(0, -2)), TxError);
  assert.throws(() => decodeTx(hex + '00'), /left over/);
  assert.throws(() => decodeTx('zz'), Error);
  assert.throws(() => parseSparkSpendHeader(Uint8Array.of(3, 1, 1), 2), TxError);
});

// ---------------------------------------------------------------- building and signing

const V = KEYS.vectors[0].addresses;
const KEY0 = { sk: hexToBytes(V[0].privkey), address: V[0].address };
const KEY1 = { sk: hexToBytes(V[1].privkey), address: V[1].address };
const PREV = 'aa'.repeat(32);

function sampleBuild(extra = {}) {
  return buildSignedTransaction({
    inputs: [
      { txid: PREV, vout: 0, value: 150000000n, script: addressToScript(KEY0.address, MAIN), sk: KEY0.sk },
      { txid: 'bb'.repeat(32), vout: 3, value: 2000n, script: addressToScript(KEY1.address, MAIN), sk: KEY1.sk },
    ],
    outputs: [
      { script: addressToScript(V[2].address, MAIN), value: 100000000n },
      { script: decodeTransparent(exchangeAddress(hash160(hexToBytes(V[2].pubkey)), MAIN), MAIN).script, value: 30000000n },
      { script: opReturnScript(utf8ToBytes('rosen:example')), value: 0n },
      { script: addressToScript(V[3].address, MAIN), value: 19997000n },
    ],
    locktime: 1393100,
    ...extra,
  });
}

test('a built transaction: every signature verifies, it decodes to what was asked, and it is deterministic', () => {
  const s = sampleBuild();
  const d = decodeTx(s.hex, MAIN);
  assert.equal(d.txid, s.txid);
  assert.equal(d.version, 1);
  assert.equal(d.type, 0);
  assert.equal(d.locktime, 1393100);
  assert.equal(d.vin[0].sequence, 0xfffffffe);
  assert.equal(s.fee, 150002000n - 149997000n);
  assert.deepEqual(d.vout.map((o) => o.type), ['p2pkh', 'exchange', 'nulldata', 'p2pkh']);
  assert.equal(new TextDecoder().decode(d.vout[2].data), 'rosen:example');
  assert.ok(d.vout[1].address.startsWith('EX'));
  d.vin.forEach((_, n) => assert.equal(verifyP2PKHInput(d, n, addressToScript(n === 0 ? KEY0.address : KEY1.address, MAIN)), true));
  // Each input's signature is over its own sighash: swapping scriptSigs breaks both.
  const swapped = { ...d, vin: [{ ...d.vin[0], scriptSig: d.vin[1].scriptSig }, { ...d.vin[1], scriptSig: d.vin[0].scriptSig }] };
  assert.equal(verifyP2PKHInput(swapped, 0), false);
  // RFC 6979: the same transaction twice is the same bytes.
  assert.equal(sampleBuild().hex, s.hex);
  // Low-S signatures only.
  for (const i of d.vin) {
    const der = parseScript(i.scriptSig)[0].data.slice(0, -1);
    const sig = secp256k1.Signature.fromBytes(der, 'der');
    assert.ok(sig.s <= secp256k1.Point.Fn.ORDER / 2n);
  }
  // The size estimate is an upper bound, and tight.
  const est = estimateSize(2, d.vout.map((o) => o.script));
  assert.ok(est >= s.size && est - s.size <= 4, `estimate ${est}, real ${s.size}`);
});

test('building refuses dust, two OP_RETURNs, overspending, foreign keys and non-P2PKH coins', () => {
  const script = addressToScript(KEY0.address, MAIN);
  const base = { inputs: [{ txid: PREV, vout: 0, value: 10000n, script, sk: KEY0.sk }] };
  assert.throws(() => buildSignedTransaction({ ...base, outputs: [{ script, value: 999n }] }), (e) => e.code === 'dust');
  assert.throws(() => buildSignedTransaction({ ...base, outputs: [{ script, value: 20000n }] }), (e) => e.code === 'insufficient');
  const op = opReturnScript(Uint8Array.of(1));
  assert.throws(() => buildSignedTransaction({ ...base, outputs: [{ script: op, value: 0n }, { script: op, value: 0n }] }), /one OP_RETURN/);
  assert.throws(() => buildSignedTransaction({ ...base, outputs: [{ script: op, value: 5n }] }), /no coins/);
  assert.throws(() => buildSignedTransaction({ inputs: [{ ...base.inputs[0], sk: KEY1.sk }], outputs: [{ script, value: 5000n }] }), (e) => e.code === 'sign');
  assert.throws(() => buildSignedTransaction({ inputs: [{ ...base.inputs[0], script: opReturnScript(Uint8Array.of(1)) }], outputs: [{ script, value: 5000n }] }), /P2PKH/);
  assert.throws(() => opReturnScript(new Uint8Array(20000)), /too large/);
});

test('sighash flags: NONE, SINGLE and ANYONECANPAY commit to what they should', () => {
  const s = sampleBuild();
  const d = decodeTx(s.hex, MAIN);
  const code = addressToScript(KEY0.address, MAIN);
  const all = legacySighash(d, 0, code, SIGHASH_ALL);
  const none = legacySighash(d, 0, code, SIGHASH_NONE);
  const single = legacySighash(d, 0, code, SIGHASH_SINGLE);
  const acp = legacySighash(d, 0, code, SIGHASH_ALL | SIGHASH_ANYONECANPAY);
  assert.equal(new Set([all, none, single, acp].map(bytesToHex)).size, 4);
  // NONE ignores outputs; ANYONECANPAY ignores the other inputs; SINGLE ignores later outputs.
  const otherOutputs = { ...d, vout: [{ value: 1n, script: code }] };
  assert.equal(bytesToHex(legacySighash(otherOutputs, 0, code, SIGHASH_NONE)), bytesToHex(none));
  const otherInputs = { ...d, vin: [d.vin[0], { ...d.vin[1], vout: 99 }] };
  assert.equal(bytesToHex(legacySighash(otherInputs, 0, code, SIGHASH_ALL | SIGHASH_ANYONECANPAY)), bytesToHex(acp));
  const laterOutputs = { ...d, vout: [d.vout[0], { value: 5n, script: code }] };
  assert.equal(bytesToHex(legacySighash(laterOutputs, 0, code, SIGHASH_SINGLE)), bytesToHex(single));
  // SINGLE with no matching output: Bitcoin's "1".
  const one = legacySighash({ ...d, vout: [] }, 1, code, SIGHASH_SINGLE);
  assert.equal(bytesToHex(one), '01' + '00'.repeat(31));
  // A signature made with ANYONECANPAY verifies through verifyP2PKHInput (hash type read from the signature).
  const der = secp256k1.sign(acp, KEY0.sk, { prehash: false, lowS: true, format: 'der' });
  const vin0 = { ...d.vin[0], scriptSig: concatBytes(pushData(concatBytes(der, Uint8Array.of(0x81))), pushData(secp256k1.getPublicKey(KEY0.sk, true))) };
  assert.equal(verifyP2PKHInput({ ...d, vin: [vin0, d.vin[1]] }, 0, code), true);
});

test('fees: rounding up per started byte, never under the relay minimum', () => {
  assert.equal(feeForSize(226, 1000n), 226n);
  assert.equal(feeForSize(226, 1008n), 228n); // 227.808 → 228
  assert.equal(feeForSize(226, 10n), 226n); // floor at 1000 sat/kB
  assert.equal(estimateSize(1, [p2pkhScript(new Uint8Array(20)), p2pkhScript(new Uint8Array(20))]), 10 + 148 + 34 + 34);
});

test('the name fee script this wallet writes is byte for byte the one in a real registration', () => {
  const d = decodeTx(fx('spark-name').hex, MAIN);
  const fee = d.vout.find((o) => o.type === 'spark-name-fee');
  const base = addressToScript(MAIN.sparkNameFeeAddress, MAIN);
  const built = sparkNameFeeScript(base, fee.sparkName.name, fee.sparkName.address);
  assert.equal(bytesToHex(built), bytesToHex(fee.script instanceof Uint8Array ? fee.script : hexToBytes(fee.script)));
});
