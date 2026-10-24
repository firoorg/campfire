// SPDX-License-Identifier: MIT
// The Spark wasm module, wrapped: synchronous calls with plain JS values in and out.
// Runs wherever the module is loaded: inside spark_worker.js in the app, directly in
// Node for tests and benchmarks. The app talks to it only through client.js.
//
// Semantics mirror Campfire's Dart wrapper (cypherstack/flutter_libsparkmobile
// lib/flutter_libsparkmobile.dart, class LibSpark) over the same C++ (sparkmobile
// a9d0789); see client.js for the documented API. Differences from the Dart wrapper:
// coins, contexts and sets are bytes (not base64 strings), amounts are decimal strings
// (in: string | bigint | safe integer), and identification takes many coins per call.
// i18n-ignore-file: setup checks of the Spark engine: a message here means a bug in this app, shown as it is

import {
  Reader, SparkError, Writer, bytesToHex, fixedBytes, fromUtf8, invalid, isPacked, reversedHex,
  toBigInt, toBytes, toI32, toU32, utf8,
} from './codec.js';

export const CHAUM_V2_ACTIVATION_HEIGHT = 1371000; // mainnet, firo chainparams; Campfire _sparkChaumV2ActivationHeight
export const SPARK_CHANGE_DIVERSIFIER = 0x270f; // kSparkChange
export const DEFAULT_SPARK_INDEX = 1; // kDefaultSparkIndex
export const SPEND_V1 = 1; // tx type 9 (Spark)
export const SPEND_V2 = 2; // tx type 11 (Spark v2, from block 1,371,000 on mainnet)
export const SPARK_TX_TYPE = { 1: 9, 2: 11 };
export const SPARK_TX_VERSION_BASE = 3;
export const OWNERSHIP_PROOF_HEX_LENGTH = 260; // one 34-byte point + three 32-byte scalars

/** Campfire SparkSpendVersion.forBlockHeight: chaum V2 from the activation height on. */
export function getSpendVersionForBlockHeight({ nextBlockHeight, chaumV2ActivationHeight = CHAUM_V2_ACTIVATION_HEIGHT }) {
  if (!Number.isInteger(nextBlockHeight) || nextBlockHeight < 0) throw invalid('nextBlockHeight must be a non-negative integer');
  if (!Number.isInteger(chaumV2ActivationHeight) || chaumV2ActivationHeight < 0) throw invalid('chaumV2ActivationHeight must be a non-negative integer');
  return nextBlockHeight >= chaumV2ActivationHeight ? SPEND_V2 : SPEND_V1;
}

/** Transaction nVersion for a Spark spend: 3 | type << 16 (type 9 for V1, 11 for V2). */
export function sparkTransactionVersion(spendVersion) {
  const type = SPARK_TX_TYPE[spendVersion];
  if (!type) throw invalid('spendVersion must be 1 or 2');
  return SPARK_TX_VERSION_BASE | (type << 16);
}

/**
 * Loads the module from the bytes of spark.wasm (wasmBinary) or its URL (wasmUrl, fetched
 * here: the vendored glue has no loader of its own). createModule is the default export of
 * pwa/src/vendor/spark/spark.js (an Emscripten MINIMAL_RUNTIME factory).
 */
export async function loadSparkCore({ createModule, wasmBinary, wasmUrl, timeoutMs = 120000 }) {
  if (typeof createModule !== 'function') throw invalid('createModule (the spark.js default export) is required');
  let bytes;
  if (wasmBinary) {
    bytes = toBytes(wasmBinary, 'wasmBinary');
  } else if (wasmUrl) {
    const res = await fetch(wasmUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new SparkError(`spark.wasm: HTTP ${res.status}`, 'load');
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    throw invalid('wasmBinary or wasmUrl is required');
  }
  // The minimal runtime does not report a failed instantiation, so refuse what cannot work first.
  if (!WebAssembly.validate(bytes)) throw new SparkError('spark.wasm is not a valid WebAssembly module', 'load');
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SparkError('the Spark module did not start', 'load')), timeoutMs);
  });
  try {
    const M = await Promise.race([createModule({ wasm: bytes }), timeout]);
    if (typeof M.sparkExports !== 'function') throw new SparkError('spark.js is not the Campfire build', 'load');
    return new SparkCore(M);
  } finally {
    clearTimeout(timer);
  }
}

// ---- argument helpers -----------------------------------------------------------------------

function key32(v) {
  return fixedBytes(v, 32, 'privateKey');
}

function index(v, what = 'index') {
  const i = v ?? DEFAULT_SPARK_INDEX;
  if (!Number.isInteger(i) || i < 0 || i > 0x7fffffff) throw invalid(`${what} must be an integer 0..2^31-1`);
  return i;
}

function version(v) {
  if (v !== SPEND_V1 && v !== SPEND_V2) throw invalid('spendVersion must be 1 (chaum V1) or 2 (chaum V2)');
  return v;
}

function amountString(n) {
  return n.toString();
}

function writeOwnCoins(w, coins) {
  if (!Array.isArray(coins)) throw invalid('coins must be an array');
  w.u32(coins.length);
  for (const c of coins) {
    w.bytes(toBytes(c.serializedCoin, 'serializedCoin'));
    w.bytes(toBytes(c.serializedCoinContext, 'serializedCoinContext'));
    w.u32(toU32(c.groupId, 'groupId'), 'groupId');
    w.i32(toI32(c.height ?? 0, 'height'), 'height');
  }
}

function writeSets(w, sets) {
  if (!Array.isArray(sets)) throw invalid('anonymitySets must be an array');
  w.u32(sets.length);
  for (const s of sets) {
    w.u32(toU32(s.setId, 'setId'), 'setId');
    w.bytes(toBytes(s.setHash, 'setHash'));
    if (isPacked(s.coins)) {
      w.u32(s.coins.count, 'set size');
      w.raw(s.coins.data);
    } else if (Array.isArray(s.coins)) {
      w.u32(s.coins.length, 'set size');
      for (const c of s.coins) w.bytes(toBytes(c, 'set coin'));
    } else {
      throw invalid('anonymity set coins must be an array of byte strings or { count, data }');
    }
  }
}

function readCoinRecord(r) {
  const type = r.u8();
  return {
    type: type === 0 ? 'mint' : type === 1 ? 'spend' : `unknown-${type}`,
    diversifier: amountString(r.u64()),
    value: amountString(r.u64()),
    address: fromUtf8(r.bytes()),
    memo: fromUtf8(r.bytes()),
    lTagHash: fromUtf8(r.bytes()),
    encryptedDiversifier: r.bytes(),
    nonceHex: fromUtf8(r.bytes()),
    serialHex: fromUtf8(r.bytes()),
    tag: r.fixed(34),
  };
}

function readUsedCoins(r) {
  const n = r.u32();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ serializedCoin: r.bytes(), serializedCoinContext: r.bytes(), groupId: r.u32(), height: r.i32() });
  }
  return out;
}

// ---- the module ----------------------------------------------------------------------------

export class SparkCore {
  constructor(M) {
    this.M = M;
    this.aborted = null;
  }

  /** The exports and the current heap view (it changes when memory grows). */
  x() {
    return this.M.sparkExports();
  }

  heap() {
    return this.M.sparkExports().HEAPU8;
  }

  /** wasm linear memory in bytes (grows, never shrinks). */
  memoryBytes() {
    return this.heap().length;
  }

  call(name, w) {
    if (this.aborted) throw new SparkError(`the Spark module stopped (${this.aborted}); start a new one`, 'aborted');
    const fn = this.x()[`spark_${name}`];
    if (typeof fn !== 'function') throw new SparkError(`no export spark_${name}`, 'internal');
    const len = w.length;
    let ptr = 0;
    try {
      ptr = this.x().spark_alloc(len);
      if (!ptr) throw new SparkError('the Spark module is out of memory', 'memory');
      w.writeInto(this.heap().subarray(ptr, ptr + len)); // the heap is re-read: alloc may have grown memory
      const res = fn(ptr, len);
      if (!res) throw new SparkError('the Spark module is out of memory', 'memory');
      const heap = this.heap();
      const status = heap[res] | (heap[res + 1] << 8) | (heap[res + 2] << 16) | (heap[res + 3] << 24);
      const n = (heap[res + 4] | (heap[res + 5] << 8) | (heap[res + 6] << 16) | (heap[res + 7] << 24)) >>> 0;
      const data = heap.slice(res + 8, res + 8 + n);
      heap.fill(0, res, res + 8 + n);
      this.x().spark_free(res);
      if (status !== 0) throw new SparkError(fromUtf8(data) || 'Spark error', 'spark');
      return new Reader(data);
    } catch (e) {
      if (e instanceof SparkError) throw e;
      // A trap or abort inside wasm (out of bounds, unreachable, assertion): the instance
      // cannot be trusted any more.
      this.aborted = String((e && e.message) || e);
      throw new SparkError(`the Spark module stopped: ${this.aborted}`, 'aborted');
    } finally {
      if (ptr) {
        // Requests carry private keys: zero them before handing the memory back
        // (and even when the instance has stopped, so no copy is left behind).
        this.heap().fill(0, ptr, ptr + len);
        if (!this.aborted) this.x().spark_free(ptr);
      }
    }
  }

  buildInfo() {
    return fromUtf8(this.call('build_info', new Writer()).rest());
  }

  // -- keys and addresses --

  /** Campfire getFullViewKeyHexFromPrivateKeyData: serialized FullViewKey, hex. */
  getFullViewKey({ privateKey, index: i }) {
    const w = new Writer().fixed(key32(privateKey), 32, 'privateKey').u32(index(i));
    return bytesToHex(this.call('full_view_key', w).rest());
  }

  getAddress({ privateKey, index: i, diversifier, isTestNet = false }) {
    const w = new Writer().fixed(key32(privateKey), 32, 'privateKey').u32(index(i)).u64(diversifier, 'diversifier').flag(isTestNet);
    return fromUtf8(this.call('get_address', w).rest());
  }

  getAddressFromFullViewKey({ fullViewKey, diversifier, isTestNet = false }) {
    const w = new Writer().bytes(toBytes(fullViewKey, 'fullViewKey')).u64(diversifier, 'diversifier').flag(isTestNet);
    return fromUtf8(this.call('address_from_fvk', w).rest());
  }

  /** { valid, error }: valid only for a Spark address of the given network. */
  checkAddress({ address, isTestNet = false }) {
    if (typeof address !== 'string') return { valid: false, error: 'not a string' };
    const r = this.call('validate_address', new Writer().str(address).flag(isTestNet));
    const valid = r.u8() === 1;
    const error = r.str();
    r.end();
    return { valid, error };
  }

  validateAddress({ address, isTestNet = false }) {
    return this.checkAddress({ address, isTestNet }).valid;
  }

  // -- identification --

  /**
   * Identifies many coins with one full view key.
   * coins: [{ coin, context }] (bytes or hex) or packCoins(list, true) output.
   * Returns { found: [{ index, ...coin }], unreadable } (index into coins).
   */
  identifyCoins({ fullViewKey, coins, isTestNet = false }) {
    const w = new Writer().bytes(toBytes(fullViewKey, 'fullViewKey')).flag(isTestNet);
    if (isPacked(coins)) {
      w.u32(coins.count, 'count');
      w.raw(coins.data);
    } else if (Array.isArray(coins)) {
      w.u32(coins.length, 'count');
      for (const c of coins) {
        w.bytes(toBytes(c.coin ?? c.serializedCoin, 'coin'));
        w.bytes(toBytes(c.context ?? c.serializedCoinContext ?? new Uint8Array(0), 'context'));
      }
    } else {
      throw invalid('coins must be an array or { count, data }');
    }
    const r = this.call('identify_coins', w);
    const n = r.u32();
    const unreadable = r.u32();
    const found = [];
    for (let i = 0; i < n; i++) {
      const idx = r.u32();
      found.push({ index: idx, ...readCoinRecord(r) });
    }
    r.end();
    return { found, unreadable };
  }

  /** Campfire identifyAndRecoverCoinByFullViewKey: the coin's data, or null if it is not ours. */
  identifyAndRecoverCoinByFullViewKey({ serializedCoin, fullViewKey, context, isTestNet = false }) {
    const { found } = this.identifyCoins({ fullViewKey, coins: [{ coin: serializedCoin, context }], isTestNet });
    if (!found.length) return null;
    const { index: _, ...coin } = found[0];
    return coin;
  }

  /** Campfire identifyAndRecoverCoin (from the private key). */
  identifyAndRecoverCoin({ serializedCoin, privateKey, index: i, context, isTestNet = false }) {
    const fullViewKey = this.getFullViewKey({ privateKey, index: i });
    return this.identifyAndRecoverCoinByFullViewKey({ serializedCoin, fullViewKey, context, isTestNet });
  }

  // -- tags --

  /** Campfire hashTags: 34-byte serialized tags -> lTagHash hex strings. */
  hashTags(tags) {
    if (!Array.isArray(tags)) throw invalid('tags must be an array');
    const w = new Writer().u32(tags.length);
    for (const t of tags) w.fixed(fixedBytes(t, 34, 'tag'), 34, 'tag');
    const text = fromUtf8(this.call('hash_tags', w).rest());
    const out = [];
    for (let i = 0; i < tags.length; i++) out.push(text.slice(64 * i, 64 * i + 64));
    return out;
  }

  /** Campfire hashTag(x, y): coordinates in hex. */
  hashTag(x, y) {
    if (typeof x !== 'string' || typeof y !== 'string' || !/^-?[0-9a-fA-F]+$/.test(x) || !/^-?[0-9a-fA-F]+$/.test(y)) {
      throw invalid('hashTag takes hex x and y');
    }
    return fromUtf8(this.call('hash_tag', new Writer().str(x).str(y)).rest());
  }

  /** A tag as ElectrumX's mempool calls send it, "(x,y)" (Campfire _hashTag). */
  hashTagString(tag) {
    const m = /^\(([0-9a-fA-F]+),([0-9a-fA-F]+)\)$/.exec(String(tag).trim());
    if (!m) throw invalid('tag must look like "(x,y)" in hex');
    return this.hashTag(m[1], m[2]);
  }

  // -- mint --

  /** Campfire serializeMintContext: inputs [{ txid (display hex), vout }] -> serial context bytes. */
  serializeMintContext(inputs) {
    if (!Array.isArray(inputs)) throw invalid('inputs must be an array');
    const w = new Writer().u32(inputs.length);
    for (const inp of inputs) {
      const txid = Array.isArray(inp) ? inp[0] : inp.txid;
      const vout = Array.isArray(inp) ? inp[1] : inp.vout;
      w.fixed(reversedHex(txid, 'txid'), 32, 'txid');
      w.u32(toU32(vout, 'vout'), 'vout');
    }
    return this.call('serialize_mint_context', w).rest();
  }

  /**
   * Campfire createSparkMintRecipients.
   * outputs: [{ sparkAddress | address, value, memo }]; serialContext: bytes; generate: as Campfire.
   * -> [{ scriptPubKey: Uint8Array, amount: string, subtractFeeFromAmount }]
   */
  createSparkMintRecipients({ outputs, serialContext, generate = false }) {
    if (!Array.isArray(outputs)) throw invalid('outputs must be an array');
    const w = new Writer().u32(outputs.length);
    for (const o of outputs) {
      w.str(o.sparkAddress ?? o.address);
      w.u64(o.value, 'value');
      w.str(o.memo ?? '');
    }
    w.bytes(toBytes(serialContext, 'serialContext')).flag(generate);
    const r = this.call('mint_recipients', w);
    const n = r.u32();
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ scriptPubKey: r.bytes(), amount: amountString(r.u64()), subtractFeeFromAmount: r.u8() === 1 });
    }
    r.end();
    return out;
  }

  // -- spend --

  /** Campfire estimateSparkFee -> fee (decimal string). */
  estimateSparkFee({ privateKey, index: i, sendAmount, subtractFeeFromAmount, coins, privateRecipientsCount, utxoNum,
    additionalTxSize = 0, spendVersion }) {
    const w = new Writer().fixed(key32(privateKey), 32, 'privateKey').u32(index(i))
      .i64(sendAmount, 'sendAmount').flag(subtractFeeFromAmount);
    writeOwnCoins(w, coins);
    w.u32(toU32(privateRecipientsCount, 'privateRecipientsCount')).u32(toU32(utxoNum, 'utxoNum'))
      .u32(toU32(additionalTxSize, 'additionalTxSize')).u8(version(spendVersion));
    const r = this.call('estimate_fee', w);
    const fee = r.i64();
    r.end();
    return amountString(fee);
  }

  /**
   * Campfire createSparkSendTransaction.
   *   recipients:        [{ amount, subtractFeeFromAmount }]  transparent outputs (the caller adds them to the tx)
   *   privateRecipients: [{ sparkAddress | address, amount, memo, subtractFeeFromAmount }]
   *   coins:             own coins [{ serializedCoin, serializedCoinContext, groupId, height }]
   *   anonymitySets:     [{ setId, setHash (32 bytes), coins: [bytes] | { count, data } }]
   *   idAndBlockHashes:  [{ setId, blockHash (32 bytes) }]
   *   txHash:            32 bytes, the hash of the tx without the spend payload (Campfire extractedTx.getHash())
   *   spendVersion:      1 | 2;  extensionCommitment: 32 bytes (V2 only; default zero)
   * -> { serializedSpendPayload, outputScripts: [Uint8Array], fee: string, usedCoins: [...] }
   */
  createSparkSendTransaction({ privateKey, index: i, recipients = [], privateRecipients = [], coins, anonymitySets,
    idAndBlockHashes, txHash, additionalTxSize = 0, spendVersion, extensionCommitment }) {
    const v = version(spendVersion);
    const ext = extensionCommitment == null ? new Uint8Array(32) : fixedBytes(extensionCommitment, 32, 'extensionCommitment');
    if (v === SPEND_V1 && ext.some((b) => b !== 0)) throw invalid('Chaum V1 cannot bind a non-zero extension commitment');
    const w = new Writer().fixed(key32(privateKey), 32, 'privateKey').u32(index(i));
    w.u32(recipients.length);
    for (const rcp of recipients) w.i64(rcp.amount, 'recipient amount').flag(rcp.subtractFeeFromAmount);
    w.u32(privateRecipients.length);
    for (const p of privateRecipients) {
      w.str(p.sparkAddress ?? p.address).u64(p.amount, 'private recipient amount').str(p.memo ?? '').flag(p.subtractFeeFromAmount);
    }
    writeOwnCoins(w, coins);
    writeSets(w, anonymitySets);
    if (!Array.isArray(idAndBlockHashes)) throw invalid('idAndBlockHashes must be an array');
    w.u32(idAndBlockHashes.length);
    for (const b of idAndBlockHashes) w.u32(toU32(b.setId, 'setId')).fixed(fixedBytes(b.blockHash, 32, 'blockHash'), 32, 'blockHash');
    w.fixed(fixedBytes(txHash, 32, 'txHash'), 32, 'txHash').u32(toU32(additionalTxSize, 'additionalTxSize')).u8(v).fixed(ext, 32, 'extensionCommitment');
    const r = this.call('create_spend', w);
    const serializedSpendPayload = r.bytes();
    const ns = r.u32();
    const outputScripts = [];
    for (let k = 0; k < ns; k++) outputScripts.push(r.bytes());
    const fee = amountString(r.i64());
    const usedCoins = readUsedCoins(r);
    r.end();
    return { serializedSpendPayload, outputScripts, fee, usedCoins };
  }

  /**
   * Checks a spend proof as a Firo node does (not double spends): the payload against the
   * tx's Spark output scripts, its transparent output total and the anonymity sets it uses.
   * -> { valid, reason }
   */
  verifySparkSpend({ spendVersion, serializedSpendPayload, outputScripts, transparentOut, anonymitySets, txHash }) {
    const w = new Writer().u8(version(spendVersion)).bytes(toBytes(serializedSpendPayload, 'serializedSpendPayload'));
    if (!Array.isArray(outputScripts)) throw invalid('outputScripts must be an array');
    w.u32(outputScripts.length);
    for (const s of outputScripts) w.bytes(toBytes(s, 'output script'));
    w.u64(transparentOut ?? 0, 'transparentOut');
    writeSets(w, anonymitySets);
    w.fixed(fixedBytes(txHash, 32, 'txHash'), 32, 'txHash');
    const r = this.call('verify_spend', w);
    const valid = r.u8() === 1;
    const reason = r.str();
    r.end();
    return { valid, reason };
  }

  // -- Spark names --

  /**
   * Campfire createSparkNameScript. proofInput: { spendVersion, inputHex } where inputHex is
   * the V1 scalar hex or the V2 ownership digest, in the byte order Campfire passes (it is
   * reversed before the C call, as the Dart wrapper does). -> { script, size } (size + 20 as Dart).
   */
  createSparkNameScript({ sparkNameValidityBlocks, name, additionalInfo = '', proofInput, privateKey, spendKeyIndex,
    diversifier, isTestNet = false, hashFailSafe = 0, ignoreProof = false }) {
    if (!proofInput || typeof proofInput.inputHex !== 'string') throw invalid('proofInput { spendVersion, inputHex } is required');
    const w = new Writer().u32(toU32(sparkNameValidityBlocks, 'sparkNameValidityBlocks')).str(name).str(additionalInfo)
      .fixed(reversedHex(proofInput.inputHex.padStart(64, '0'), 'proofInput.inputHex'), 32, 'proofInput.inputHex')
      .u8(version(proofInput.spendVersion)).fixed(key32(privateKey), 32, 'privateKey').u32(index(spendKeyIndex, 'spendKeyIndex'))
      .u32(toU32(diversifier, 'diversifier')).flag(isTestNet).u32(toU32(hashFailSafe, 'hashFailSafe')).flag(ignoreProof);
    const r = this.call('name_script', w);
    const script = r.bytes();
    const size = r.u32() + 20; // Dart: sparkwallet.cpp L1624, the name tx data size estimate
    r.end();
    return { script, size };
  }

  /** Campfire getSparkNameCommitment: 32-byte extension commitment of serialized name data. */
  getSparkNameCommitment(serializedSparkNameData) {
    const b = toBytes(serializedSparkNameData, 'serializedSparkNameData');
    if (!b.length) throw invalid('serializedSparkNameData must not be empty');
    return this.call('name_commitment', new Writer().bytes(b)).fixed(32);
  }

  // -- address ownership proofs --

  createSparkAddressOwnershipProof({ message, privateKey, spendKeyIndex, diversifier }) {
    if (typeof message !== 'string') throw invalid('message must be a string');
    if (!Number.isInteger(diversifier) || diversifier < 0 || diversifier > 0x7fffffff) throw invalid('diversifier must be an integer 0..2^31-1');
    const w = new Writer().bytes(utf8(message)).fixed(key32(privateKey), 32, 'privateKey')
      .u32(index(spendKeyIndex, 'spendKeyIndex')).u32(diversifier);
    return bytesToHex(this.call('ownership_proof', w).rest());
  }

  verifySparkAddressOwnershipProof({ message, address, proof, isTestNet = false }) {
    // As the Dart wrapper: refuse malformed input before calling into C++.
    if (typeof message !== 'string' || typeof address !== 'string' || typeof proof !== 'string') return false;
    if (proof.length !== OWNERSHIP_PROOF_HEX_LENGTH || !address || address.includes('\u0000') || !/^[0-9a-fA-F]+$/.test(proof)) return false;
    const w = new Writer().bytes(utf8(message)).str(address).bytes(toBytes(proof, 'proof')).flag(isTestNet);
    return this.call('verify_ownership_proof', w).u8() === 1;
  }
}

export { SparkError, toBigInt };
