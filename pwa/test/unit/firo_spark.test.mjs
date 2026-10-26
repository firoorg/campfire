// Firo Spark wasm module against golden vectors made by Campfire's own C ABI
// (flutter_libsparkmobile 3fdcb21 over sparkmobile a9d0789, native, real OpenSSL):
// pwa/test/fixtures/firo_spark_vectors.json, from pwa/spark/native/vectors.cpp.
// Randomised operations replay the vector generator's RNG stream through
// crypto.getRandomValues, so mints, spends and proofs must match byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import createSparkModule from '../../src/vendor/spark/spark.js';
import { loadSparkCore, getSpendVersionForBlockHeight, sparkTransactionVersion } from '../../src/lib/firo/spark/core.js';
import { bytesToHex, hexToBytes, packCoins } from '../../src/lib/firo/spark/codec.js';

const vendor = new URL('../../src/vendor/spark/', import.meta.url);
const lock = JSON.parse(await readFile(new URL('../../spark/spark.lock.json', import.meta.url), 'utf8'));
const V = JSON.parse(await readFile(new URL('../fixtures/firo_spark_vectors.json', import.meta.url), 'utf8'));
const wasmBytes = await readFile(new URL('spark.wasm', vendor));
const core = await loadSparkCore({ createModule: createSparkModule, wasmBinary: wasmBytes });

const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());
const key = (name) => {
  const k = V.keys.find((x) => x.name === name);
  assert.ok(k, `key ${name} in vectors`);
  return k;
};
const hex = (b) => bytesToHex(b);
const reverseHex = (h) => bytesToHex(hexToBytes(h).reverse());

/** Runs fn with crypto.getRandomValues replaced by vectors.cpp's stream for `label`. */
function withVectorRng(label, fn) {
  const seed = sha256(new TextEncoder().encode(label));
  let counter = 0n;
  let block = null;
  let pos = 32;
  let used = 0;
  const fake = {
    getRandomValues(view) {
      for (let i = 0; i < view.length; i++) {
        if (pos === 32) {
          const input = new Uint8Array(40);
          input.set(seed);
          let c = counter++;
          for (let b = 0; b < 8; b++) { input[32 + b] = Number(c & 0xffn); c >>= 8n; }
          block = sha256(input);
          pos = 0;
        }
        view[i] = block[pos++];
      }
      used += view.length;
      return view;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true, writable: true });
  try {
    return { result: fn(), used };
  } finally {
    Object.defineProperty(globalThis, 'crypto', original);
  }
}

const coinList = (coins) => coins.map((c) => ({
  serializedCoin: hexToBytes(c.coin), serializedCoinContext: hexToBytes(c.context), groupId: c.groupId, height: c.height,
}));

test('the vendored module is the pinned build', async () => {
  assert.deepEqual(Object.keys(lock.files).sort(), ['spark.js', 'spark.wasm']);
  for (const [name, want] of Object.entries(lock.files)) {
    const buf = await readFile(new URL(name, vendor));
    assert.equal(createHash('sha256').update(buf).digest('hex'), want, name);
  }
  const glue = await readFile(new URL('spark.js', vendor), 'utf8');
  assert.doesNotMatch(glue, /(^|[^A-Za-z0-9_$.])eval\(|new Function\(/, 'no eval in the glue (CSP has no unsafe-eval)');
});

test('build info names the pinned sparkmobile commit', () => {
  assert.equal(core.buildInfo(), `sparkmobile ${lock.sources.sparkmobile.commit}`);
});

test('full view keys and addresses match Campfire', () => {
  let n = 0;
  for (const k of V.keys) {
    assert.equal(core.getFullViewKey({ privateKey: k.privateKey, index: k.index }), k.fullViewKey, `fvk ${k.name}`);
    for (const a of k.addresses) {
      for (const [net, isTestNet] of [['main', false], ['test', true]]) {
        assert.equal(core.getAddress({ privateKey: hexToBytes(k.privateKey), index: k.index, diversifier: a.diversifier, isTestNet }), a[net]);
        assert.equal(core.getAddressFromFullViewKey({ fullViewKey: k.fullViewKey, diversifier: a.diversifier, isTestNet }), a[net]);
        n += 2;
      }
    }
  }
  assert.equal(n, V.keys.length * 5 * 4);
});

test('address validation matches Campfire', () => {
  for (const v of V.validateAddress) {
    assert.equal(core.validateAddress({ address: v.address, isTestNet: v.isTestNet }), v.valid, `${v.address} on ${v.isTestNet ? 'test' : 'main'}`);
  }
  assert.equal(core.checkAddress({ address: 'sm1\u0000x' }).valid, false);
  assert.equal(core.validateAddress({ address: 42 }), false);
});

test('serializeMintContext matches Campfire (txids in display order)', () => {
  for (const v of V.serializeMintContext) {
    assert.equal(hex(core.serializeMintContext(v.inputs)), v.context);
    assert.equal(hex(core.serializeMintContext(v.inputs.map((i) => [i.txid, i.vout]))), v.context);
  }
});

test('mint recipients match Campfire byte for byte (same RNG stream)', () => {
  for (const m of V.mints) {
    const { result, used } = withVectorRng(m.rngLabel, () => core.createSparkMintRecipients({
      outputs: m.outputs.map((o) => ({ sparkAddress: o.address, value: o.value, memo: o.memo })),
      serialContext: m.serialContext,
      generate: m.generate,
    }));
    assert.equal(String(used), m.rngBytes, `${m.rngLabel}: same amount of randomness`);
    assert.deepEqual(result.map((r) => ({ scriptPubKey: hex(r.scriptPubKey), amount: r.amount, subtractFeeFromAmount: r.subtractFeeFromAmount })),
      m.recipients, m.rngLabel);
  }
});

function expectedCoin(r) {
  return {
    type: r.type === 0 ? 'mint' : 'spend',
    diversifier: r.diversifier, value: r.value, address: r.address, memo: r.memo, lTagHash: r.lTagHash,
    encryptedDiversifier: r.encryptedDiversifier, nonceHex: r.nonceHex, serialHex: r.serialHex, tag: r.tag,
  };
}
const asHexCoin = (c) => c && { ...c, encryptedDiversifier: hex(c.encryptedDiversifier), tag: hex(c.tag) };

test('coin identification and recovery match Campfire', () => {
  let mine = 0;
  for (const v of V.identify) {
    const got = core.identifyAndRecoverCoinByFullViewKey({ serializedCoin: v.coin, fullViewKey: v.fullViewKey, context: v.context, isTestNet: v.isTestNet });
    if (v.result === null) {
      assert.equal(got, null, `not ${v.key}'s`);
    } else {
      assert.deepEqual(asHexCoin(got), expectedCoin(v.result));
      mine++;
    }
  }
  assert.ok(mine >= 8 && mine < V.identify.length, 'both outcomes covered');
  // From the private key, as Campfire's identifyAndRecoverCoin.
  const v = V.identify.find((x) => x.result && x.key === 'k1');
  const k1 = key('k1');
  assert.deepEqual(asHexCoin(core.identifyAndRecoverCoin({ serializedCoin: v.coin, privateKey: k1.privateKey, index: k1.index, context: v.context, isTestNet: v.isTestNet })),
    expectedCoin(v.result));
});

test('batch identification: one call per key, indices and trailing bytes', () => {
  // Every distinct (coin, context) of the vectors once; each was identified natively with k1 and k2.
  const items = [];
  const seen = new Map();
  for (const v of V.identify.filter((x) => x.isTestNet === false)) {
    const id = `${v.coin}/${v.context}`;
    if (!seen.has(id)) { seen.set(id, items.length); items.push({ coin: v.coin, context: v.context, results: {} }); }
    items[seen.get(id)].results[v.key] = v.result;
  }
  assert.ok(items.length >= 10);
  for (const name of ['k1', 'k2']) {
    const k = key(name);
    // Set entries carry the tx hash and context after the coin: they must not matter.
    const coins = items.map((it) => ({ coin: hexToBytes(it.coin + 'ab'.repeat(40)), context: hexToBytes(it.context) }));
    coins.push({ coin: new Uint8Array([1, 2, 3]), context: new Uint8Array(0) }); // unreadable
    const want = items.map((it, i) => (it.results[name] ? i : -1)).filter((i) => i >= 0);
    assert.ok(want.length >= 3, `${name} owns some of them`);
    for (const form of [coins, packCoins(coins, true)]) {
      const { found, unreadable } = core.identifyCoins({ fullViewKey: k.fullViewKey, coins: form });
      assert.equal(unreadable, 1);
      assert.deepEqual(found.map((f) => f.index), want, name);
      for (const f of found) {
        const { index, ...coin } = f;
        assert.deepEqual(asHexCoin(coin), expectedCoin(items[index].results[name]));
      }
    }
  }
});

test('tag hashes match Campfire (hashTags, hashTag, "(x,y)")', () => {
  assert.ok(V.hashTags.length >= 8);
  const hashes = core.hashTags(V.hashTags.map((t) => t.tag));
  assert.deepEqual(hashes, V.hashTags.map((t) => t.hash));
  for (const t of V.hashTags) {
    assert.equal(core.hashTag(t.x, t.y), t.hash);
    assert.equal(core.hashTagString(`(${t.x},${t.y})`), t.hash);
  }
  assert.deepEqual(core.hashTags([]), []);
});

test('fee estimates match Campfire, including its refusal', () => {
  const k1 = key('k1');
  const coins = coinList(V.estimateFee.coins);
  for (const c of V.estimateFee.cases) {
    const args = {
      privateKey: k1.privateKey, index: k1.index, sendAmount: c.sendAmount, subtractFeeFromAmount: c.subtractFeeFromAmount, coins,
      privateRecipientsCount: c.privateRecipientsCount, utxoNum: c.utxoNum, additionalTxSize: c.additionalTxSize, spendVersion: c.spendVersion,
    };
    if (c.error) assert.throws(() => core.estimateSparkFee(args), (e) => e.code === 'spark' && e.message === c.error);
    else assert.equal(core.estimateSparkFee(args), c.fee);
  }
});

function spendArgs(s, packed = false) {
  const k = key(s.key);
  return {
    privateKey: k.privateKey,
    index: k.index,
    recipients: s.recipients,
    privateRecipients: s.privateRecipients.map((p) => ({ address: p.address, amount: p.amount, memo: p.memo, subtractFeeFromAmount: p.subtractFeeFromAmount })),
    coins: coinList(s.coins),
    anonymitySets: s.anonymitySets.map((a) => ({
      setId: a.setId, setHash: hexToBytes(a.setHash),
      coins: packed ? packCoins(a.coins.map(hexToBytes)) : a.coins.map(hexToBytes),
    })),
    idAndBlockHashes: s.blockHashes.map((b) => ({ setId: b.setId, blockHash: hexToBytes(b.blockHash) })),
    txHash: hexToBytes(s.txHashSig),
    additionalTxSize: s.additionalTxSize,
    spendVersion: s.spendVersion,
    extensionCommitment: hexToBytes(s.extensionCommitment),
  };
}

test('spend transactions (V2 one/two inputs, extension commitment, V1) match Campfire byte for byte and verify', () => {
  assert.equal(V.spends.length, 4);
  for (const s of V.spends) {
    for (const packed of [false, true]) {
      const { result, used } = withVectorRng(s.rngLabel, () => core.createSparkSendTransaction(spendArgs(s, packed)));
      assert.equal(String(used), s.rngBytes, `${s.rngLabel}: same amount of randomness`);
      assert.equal(hex(result.serializedSpendPayload), s.result.serializedSpendPayload, `${s.rngLabel} payload`);
      assert.deepEqual(result.outputScripts.map(hex), s.result.outputScripts);
      assert.equal(result.fee, s.result.fee);
      assert.deepEqual(result.usedCoins.map((u) => ({ coin: hex(u.serializedCoin), context: hex(u.serializedCoinContext), groupId: u.groupId, height: u.height })),
        s.result.usedCoins);
    }
    const verifyArgs = {
      spendVersion: s.spendVersion,
      serializedSpendPayload: s.result.serializedSpendPayload,
      outputScripts: s.result.outputScripts,
      transparentOut: s.transparentOut,
      anonymitySets: spendArgs(s).anonymitySets,
      txHash: s.txHashSig,
    };
    assert.deepEqual(core.verifySparkSpend(verifyArgs), { valid: true, reason: '' }, `${s.rngLabel} verifies`);
    const bad = hexToBytes(s.result.serializedSpendPayload);
    bad[bad.length >> 1] ^= 1;
    assert.equal(core.verifySparkSpend({ ...verifyArgs, serializedSpendPayload: bad }).valid, false, 'a flipped bit does not verify');
    assert.equal(core.verifySparkSpend({ ...verifyArgs, transparentOut: BigInt(s.transparentOut) + 1n }).valid, false, 'a changed amount does not verify');
    assert.equal(core.verifySparkSpend({ ...verifyArgs, txHash: new Uint8Array(32) }).valid, false, 'another transaction hash does not verify');
  }
});

test('spends made with real randomness verify and pay the right coins', () => {
  const s = V.spends.find((x) => x.rngLabel === 'spend-v2-two-inputs');
  const r = core.createSparkSendTransaction(spendArgs(s));
  assert.notEqual(hex(r.serializedSpendPayload), s.result.serializedSpendPayload, 'fresh randomness, a different proof');
  assert.equal(r.fee, s.result.fee);
  assert.deepEqual(core.verifySparkSpend({
    spendVersion: s.spendVersion, serializedSpendPayload: r.serializedSpendPayload, outputScripts: r.outputScripts,
    transparentOut: s.transparentOut, anonymitySets: spendArgs(s).anonymitySets, txHash: s.txHashSig,
  }), { valid: true, reason: '' });
  // The recipient finds its coin in the outputs; the change comes back to us.
  const k2 = key('k2');
  const k1 = key('k1');
  const outs = r.outputScripts.map((sc) => ({ coin: sc.subarray(1), context: hexToBytes(s.outputContext) }));
  const theirs = core.identifyCoins({ fullViewKey: k2.fullViewKey, coins: outs }).found;
  const ours = core.identifyCoins({ fullViewKey: k1.fullViewKey, coins: outs }).found;
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].value, '100000000');
  assert.equal(theirs[0].memo, 'two inputs');
  assert.equal(ours.length, 1);
  assert.equal(ours[0].diversifier, '9999');
  assert.equal(BigInt(theirs[0].value) + BigInt(ours[0].value) + BigInt(r.fee), 100000000n + 12345n, 'inputs = outputs + fee');
});

test('Spark name scripts and commitments match Campfire', () => {
  for (const n of V.sparkNames) {
    const k = key(n.key);
    const args = {
      sparkNameValidityBlocks: n.validityBlocks, name: n.name, additionalInfo: n.additionalInfo,
      proofInput: { spendVersion: n.spendVersion, inputHex: reverseHex(n.ownershipDigest) },
      privateKey: k.privateKey, spendKeyIndex: k.index, diversifier: n.diversifier, isTestNet: n.isTestNet,
      hashFailSafe: n.hashFailSafe, ignoreProof: n.withoutProof,
    };
    const { result, used } = withVectorRng(n.rngLabel, () => {
      try { return core.createSparkNameScript(args); } catch (e) { return e; }
    });
    assert.equal(String(used), n.rngBytes);
    if (n.error) {
      assert.equal(result.message, n.error);
      continue;
    }
    assert.equal(hex(result.script), n.script, n.rngLabel);
    assert.equal(result.size, n.size + 20, 'size as the Dart wrapper reports it');
    if (n.commitment) assert.equal(hex(core.getSparkNameCommitment(result.script)), n.commitment);
  }
  assert.throws(() => core.getSparkNameCommitment(new Uint8Array(0)), (e) => e.code === 'invalid-argument');
  assert.throws(() => core.getSparkNameCommitment(new Uint8Array([2, 0, 1])), (e) => e.code === 'spark');
});

test('address ownership proofs match Campfire and verify only for their message and network', () => {
  for (const p of V.ownershipProofs) {
    const k = key(p.key);
    const { result } = withVectorRng(p.rngLabel, () => core.createSparkAddressOwnershipProof({
      message: p.message, privateKey: k.privateKey, spendKeyIndex: k.index, diversifier: p.diversifier,
    }));
    assert.equal(result, p.proof);
    assert.equal(core.verifySparkAddressOwnershipProof({ message: p.message, address: p.address, proof: p.proof }), true);
    assert.equal(core.verifySparkAddressOwnershipProof({ message: `${p.message}!`, address: p.address, proof: p.proof }), false);
    assert.equal(core.verifySparkAddressOwnershipProof({ message: p.message, address: p.address, proof: p.proof, isTestNet: true }), false);
    assert.equal(core.verifySparkAddressOwnershipProof({ message: p.message, address: p.address, proof: p.proof.slice(2) }), false);
  }
});

test('randomness comes from crypto.getRandomValues, and nothing works without it', () => {
  const m = V.mints[0];
  const args = { outputs: m.outputs.map((o) => ({ address: o.address, value: o.value, memo: o.memo })), serialContext: m.serialContext, generate: true };
  const a = core.createSparkMintRecipients(args).map((r) => hex(r.scriptPubKey));
  const b = core.createSparkMintRecipients(args).map((r) => hex(r.scriptPubKey));
  assert.notDeepEqual(a, b, 'two mints never repeat');
  assert.notDeepEqual(a, m.recipients.map((r) => r.scriptPubKey));
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    assert.throws(() => core.createSparkMintRecipients(args), (e) => e.code === 'spark', 'fails closed');
  } finally {
    Object.defineProperty(globalThis, 'crypto', original);
  }
  assert.equal(core.createSparkMintRecipients(args).length, 3, 'and works again');
});

test('the private key does not stay in wasm memory after a call', () => {
  const k1 = key('k1');
  const secret = sha256(new TextEncoder().encode('a key that must not linger'));
  core.getAddress({ privateKey: secret, diversifier: 0 });
  core.createSparkSendTransaction(spendArgs(V.spends[0])); // exercises a big request too
  const heap = core.heap();
  let hits = 0;
  outer: for (let i = 0; i + 32 <= heap.length; i++) {
    if (heap[i] !== secret[0]) continue;
    for (let j = 1; j < 32; j++) if (heap[i + j] !== secret[j]) continue outer;
    hits++;
  }
  assert.equal(hits, 0);
  assert.ok(k1);
});

test('spend version and transaction version (Campfire SparkSpendVersion)', () => {
  assert.equal(getSpendVersionForBlockHeight({ nextBlockHeight: 1370999 }), 1);
  assert.equal(getSpendVersionForBlockHeight({ nextBlockHeight: 1371000 }), 2);
  assert.equal(getSpendVersionForBlockHeight({ nextBlockHeight: 10, chaumV2ActivationHeight: 5 }), 2);
  assert.equal(sparkTransactionVersion(1), 3 | (9 << 16));
  assert.equal(sparkTransactionVersion(2), 3 | (11 << 16));
  assert.throws(() => getSpendVersionForBlockHeight({ nextBlockHeight: -1 }));
});

test('bad input is refused before reaching C++', () => {
  const bad = (fn) => assert.throws(fn, (e) => e.code === 'invalid-argument');
  bad(() => core.getAddress({ privateKey: new Uint8Array(31), diversifier: 0 }));
  bad(() => core.getAddress({ privateKey: 'zz'.repeat(32), diversifier: 0 }));
  bad(() => core.getAddress({ privateKey: new Uint8Array(32), diversifier: -1 }));
  bad(() => core.getAddress({ privateKey: new Uint8Array(32), diversifier: 1.5 }));
  bad(() => core.createSparkSendTransaction({ ...spendArgs(V.spends[3]), extensionCommitment: new Uint8Array(32).fill(1) }));
  bad(() => core.estimateSparkFee({ privateKey: new Uint8Array(32), sendAmount: '1', coins: [], privateRecipientsCount: 0, utxoNum: 0, spendVersion: 3 }));
  bad(() => core.identifyCoins({ fullViewKey: key('k1').fullViewKey, coins: 'nope' }));
  assert.throws(() => core.getAddressFromFullViewKey({ fullViewKey: new Uint8Array(10), diversifier: 0 }), (e) => e.code === 'spark');
});
