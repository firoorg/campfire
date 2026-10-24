// SPDX-License-Identifier: MIT
// Firo Spark for the Campfire web wallet: the promise API the wallet core uses
// (injected into createBackend as `spark`, see WALLET_API.md).
//
// The cryptography is Firo's sparkmobile @ a9d0789 (the code Campfire runs, via
// cypherstack/flutter_libsparkmobile 3fdcb21), compiled to WebAssembly by
// pwa/spark/build.sh and pinned in pwa/spark/spark.lock.json. It runs in workers:
// one "prover" worker for everything that touches the spend key, and a pool of
// identification workers for scanning anonymity sets. No SharedArrayBuffer; each
// worker has its own wasm memory.
//
//   const spark = createSparkClient();            // browser defaults: workers + spark.wasm next to vendor/spark
//   await spark.ready;                            // { buildInfo, memoryBytes }
//
// Conventions
//   bytes      Uint8Array (hex strings are accepted wherever bytes are taken)
//   amounts    decimal strings out; decimal string | bigint | safe integer in
//   privateKey the 32-byte BIP32 private key at m/44'/136'/0'/6/1 (Campfire's Spark key material;
//              testnet m/44'/1'/0'/6/1); index = the Spark key index, 1 (Campfire's default)
//   coins      a coin's bytes as ElectrumX sends them in a set entry (base64-decoded first field);
//              bytes after the 244-byte coin are ignored
//   errors     SparkError with .code: 'invalid-argument' (bad input, nothing ran),
//              'spark' (the library refused: message is sparkmobile's), 'memory', 'aborted',
//              'worker' (a worker died), 'closed'
//
// Keys and addresses
//   getFullViewKey({ privateKey, index }) -> hex                  (Campfire getFullViewKeyHexFromPrivateKeyData)
//   getAddress({ privateKey, index, diversifier, isTestNet }) -> 'sm1…' | 'st1…'
//   getAddressFromFullViewKey({ fullViewKey, diversifier, isTestNet }) -> address
//   validateAddress({ address, isTestNet }) -> boolean            (a Spark address of that network)
//   checkAddress({ address, isTestNet }) -> { valid, error }
//   Diversifiers: receiving addresses 0, 1, 2, …; change is SPARK_CHANGE_DIVERSIFIER (9999).
//
// Scanning
//   identifyCoins({ fullViewKey, coins, isTestNet, chunkSize, onProgress, signal })
//       -> { found: [{ index, ...Coin }], unreadable }
//     coins: [{ coin, context }] or packCoins(list, true) ({ count, data }); index points into coins.
//     Spread over the identification pool; onProgress({ done, total }) after each chunk.
//   identifyAndRecoverCoinByFullViewKey({ serializedCoin, fullViewKey, context, isTestNet }) -> Coin | null
//   identifyAndRecoverCoin({ serializedCoin, privateKey, index, context, isTestNet }) -> Coin | null
//   Coin = { type: 'mint'|'spend', diversifier, value, address, memo, lTagHash, encryptedDiversifier,
//            nonceHex, serialHex, tag }   (lTagHash/nonceHex/serialHex as Campfire stores them;
//            tag = the 34-byte linking tag; Campfire's `serial` field is the UTF-8 of serialHex)
//   hashTags(tags: 34-byte tags[]) -> lTagHash[]                  (used tags from spark.getusedcoinstagstxhashes)
//   hashTag(x, y) / hashTagString('(x,y)') -> lTagHash            (mempool tags)
//
// Mint (transparent -> Spark)
//   serializeMintContext([{ txid, vout }]) -> Uint8Array          (txid in display hex, as in Campfire)
//   createSparkMintRecipients({ outputs: [{ address, value, memo }], serialContext, generate })
//       -> [{ scriptPubKey, amount, subtractFeeFromAmount }]      (≤ 16 outputs per tx, Campfire's limit)
//
// Spend
//   getSpendVersionForBlockHeight({ nextBlockHeight, chaumV2ActivationHeight = 1371000 }) -> 1 | 2   (sync)
//     Campfire uses V1 on testnet and V2 on mainnet from block 1,371,000; tx nVersion = sparkTransactionVersion(v).
//   estimateSparkFee({ privateKey, index, sendAmount, subtractFeeFromAmount, coins, privateRecipientsCount,
//                      utxoNum, additionalTxSize, spendVersion }) -> fee
//     coins (own, unspent): [{ serializedCoin, serializedCoinContext, groupId, height }]
//   createSparkSendTransaction({ privateKey, index, recipients: [{ amount, subtractFeeFromAmount }],
//       privateRecipients: [{ address, amount, memo, subtractFeeFromAmount }], coins,
//       anonymitySets: [{ setId, setHash, coins }], idAndBlockHashes: [{ setId, blockHash }],
//       txHash, additionalTxSize, spendVersion, extensionCommitment })
//       -> { serializedSpendPayload, outputScripts, fee, usedCoins }
//     anonymitySets: every group holding a coin you spend; setHash and blockHash are the 32 raw bytes of
//     spark.getsparkanonymitysetmeta's setHash/blockHash; coins are the set's coin bytes in server order,
//     as an array or packCoins(list) — 32,768 coins go to the worker as one buffer, never as JSON.
//     txHash: the 32-byte hash of the tx with an empty payload (Campfire: extractedTx.getHash()).
//   verifySparkSpend({ spendVersion, serializedSpendPayload, outputScripts, transparentOut, anonymitySets, txHash })
//       -> { valid, reason }   (the node's proof check; run it before broadcasting)
//
// Spark names and address ownership
//   createSparkNameScript({ sparkNameValidityBlocks, name, additionalInfo, proofInput: { spendVersion, inputHex },
//       privateKey, spendKeyIndex, diversifier, isTestNet, hashFailSafe, ignoreProof }) -> { script, size }
//   getSparkNameCommitment(serializedSparkNameData) -> Uint8Array(32)
//   createSparkAddressOwnershipProof({ message, privateKey, spendKeyIndex, diversifier }) -> proof hex
//   verifySparkAddressOwnershipProof({ message, address, proof, isTestNet }) -> boolean
//
// Lifecycle
//   stats() -> Promise<{ prover: memoryBytes, identify: [memoryBytes…] }>   close() -> terminates all workers
//   recycleProver() -> replaces the prover worker (done by itself after big spends, see proverMemoryLimitMB)

import { SparkError, invalid, isPacked, packCoins, toBytes } from './codec.js';
import {
  CHAUM_V2_ACTIVATION_HEIGHT, DEFAULT_SPARK_INDEX, SPARK_CHANGE_DIVERSIFIER, getSpendVersionForBlockHeight,
  sparkTransactionVersion,
} from './core.js';
import { t } from '../../i18n.js';

export {
  CHAUM_V2_ACTIVATION_HEIGHT, DEFAULT_SPARK_INDEX, SPARK_CHANGE_DIVERSIFIER, SparkError, getSpendVersionForBlockHeight,
  packCoins, sparkTransactionVersion,
};

const DEFAULT_CHUNK = 1000;

function defaultIdentifyWorkers() {
  const n = (typeof navigator === 'object' && navigator && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, n - 1));
}

class WorkerHandle {
  constructor(make, initArgs, name) {
    this.name = name;
    this.pending = new Map();
    this.nextId = 1;
    this.dead = null;
    this.w = make(name);
    this.w.onmessage = (ev) => this.receive(ev.data);
    this.w.onerror = (ev) => this.fail(new SparkError(t('Spark worker {name} failed: {value}', { name, value: (ev && ev.message) || 'error' }), 'worker'));
    this.ready = this.request('init', initArgs);
  }

  receive(msg) {
    const p = msg && this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      p.resolve(msg.result);
      return;
    }
    const err = new SparkError(msg.error.message, msg.error.code);
    p.reject(err);
    // A module that trapped cannot be trusted: retire this worker (a new one is started on demand).
    if (msg.error.code === 'aborted') this.fail(err);
  }

  fail(err) {
    if (this.dead) return;
    this.dead = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    try { this.w.terminate(); } catch { /* already gone */ }
  }

  request(op, args, transfer = []) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.w.postMessage({ id, op, args }, transfer);
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
}

// Splits a packed identify list ({ count, data }: count * (bytes coin, bytes context)) into chunks.
function splitPacked(packed, chunkSize) {
  const { count, data } = packed;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const chunks = [];
  let off = 0;
  let start = 0;
  let item = 0;
  let chunkStartOff = 0;
  while (item < count) {
    for (let f = 0; f < 2; f++) {
      if (off + 4 > data.length) throw invalid(t('packed coins are truncated'));
      const len = dv.getUint32(off, true);
      off += 4 + len;
      if (off > data.length) throw invalid(t('packed coins are truncated'));
    }
    item++;
    if (item - start === chunkSize || item === count) {
      chunks.push({ start, count: item - start, data: data.subarray(chunkStartOff, off) });
      start = item;
      chunkStartOff = off;
    }
  }
  if (off !== data.length) throw invalid(t('packed coins have trailing bytes'));
  return chunks;
}

/**
 * options:
 *   identifyWorkers  size of the identification pool (default min(4, cores - 1); 0 = use the prover)
 *   workerUrl        URL of spark_worker.js (default: next to this file)
 *   wasmUrl          URL of spark.wasm (default: ../../../vendor/spark/spark.wasm from here)
 *   wasmBinary       the wasm bytes instead of a URL (Node tests)
 *   createWorker     (name) => Worker-like { postMessage, onmessage, onerror, terminate } (tests)
 *   proverMemoryLimitMB  wasm memory never shrinks: after a spend or a verification leaves the
 *                    prover above this (default 64; a 32,000-coin spend takes it to ~120 MB),
 *                    the idle prover is replaced by a fresh one. 0 = never.
 */
export function createSparkClient(options = {}) {
  const workerUrl = options.workerUrl || new URL('./spark_worker.js', import.meta.url);
  const initArgs = options.wasmBinary
    ? { wasmBinary: options.wasmBinary }
    : { wasmUrl: String(options.wasmUrl || new URL('../../../vendor/spark/spark.wasm', import.meta.url)) };
  const make = options.createWorker || ((name) => new Worker(workerUrl, { type: 'module', name }));
  const poolSize = options.identifyWorkers ?? defaultIdentifyWorkers();
  if (!Number.isInteger(poolSize) || poolSize < 0 || poolSize > 16) throw invalid(t('identifyWorkers must be 0..16'));

  const memoryLimit = (options.proverMemoryLimitMB ?? 64) * 1024 * 1024;
  let closed = false;
  let prover = new WorkerHandle(make, initArgs, 'spark-prover');
  let proverGeneration = 1;
  let pool = null;
  let poolStarts = 0;
  const idlePool = () => {
    if (!pool) pool = Array.from({ length: poolSize }, () => new WorkerHandle(make, initArgs, `spark-identify-${++poolStarts}`));
    // Replace workers that crashed or trapped.
    pool = pool.map((w) => (w.dead ? new WorkerHandle(make, initArgs, `spark-identify-${++poolStarts}`) : w));
    return pool;
  };

  const call = (op, args) => {
    if (closed) return Promise.reject(new SparkError(t('the Spark client is closed'), 'closed'));
    if (prover.dead) recycleProver(); // it crashed or trapped: start a fresh one
    return prover.request(op, args);
  };

  // Spends grow the prover's memory by ~100 MB and wasm memory never shrinks: give it back
  // (important on iPhones) by replacing the prover once it is idle.
  function recycleProver() {
    if (closed) return false;
    const old = prover;
    prover = new WorkerHandle(make, initArgs, `spark-prover-${++proverGeneration}`);
    client.ready = prover.ready;
    // Calls already sent to the old prover finish there first.
    const retire = () => (old.pending.size === 0 ? old.fail(new SparkError('replaced', 'closed')) : setTimeout(retire, 250));
    retire();
    return true;
  }
  const heavy = (op) => async (args) => {
    const result = await call(op, args);
    if (memoryLimit > 0 && !closed) {
      const handle = prover;
      try {
        const bytes = await handle.request('memoryBytes');
        if (bytes > memoryLimit && handle === prover && handle.pending.size === 0) recycleProver();
      } catch { /* the result stands; recycling is only housekeeping */ }
    }
    return result;
  };

  async function identifyCoins({ fullViewKey, coins, isTestNet = false, chunkSize = DEFAULT_CHUNK, onProgress, signal } = {}) {
    if (closed) throw new SparkError(t('the Spark client is closed'), 'closed');
    if (!Number.isInteger(chunkSize) || chunkSize < 1) throw invalid(t('chunkSize must be a positive integer'));
    const fvk = toBytes(fullViewKey, 'fullViewKey');
    let chunks;
    if (isPacked(coins)) {
      chunks = splitPacked(coins, chunkSize);
    } else if (Array.isArray(coins)) {
      chunks = [];
      for (let s = 0; s < coins.length; s += chunkSize) {
        const part = packCoins(coins.slice(s, s + chunkSize), true);
        chunks.push({ start: s, count: part.count, data: part.data });
      }
    } else {
      throw invalid(t('coins must be an array or { count, data }'));
    }
    const total = chunks.reduce((n, c) => n + c.count, 0);
    if (poolSize === 0 && prover.dead) recycleProver();
    const workers = poolSize === 0 ? [prover] : idlePool();
    const found = [];
    let unreadable = 0;
    let done = 0;
    let next = 0;
    let failure = null;
    const runOn = async (w) => {
      while (!failure && next < chunks.length) {
        if (signal && signal.aborted) throw new SparkError(t('identification cancelled'), 'aborted');
        const c = chunks[next++];
        // Copy the chunk into its own buffer and transfer it: no structured-clone copy of the rest.
        const data = c.data.slice();
        const r = await w.request('identifyCoins', { fullViewKey: fvk, isTestNet, coins: { count: c.count, data } }, [data.buffer]);
        for (const f of r.found) found.push({ ...f, index: f.index + c.start });
        unreadable += r.unreadable;
        done += c.count;
        if (onProgress) onProgress({ done, total });
      }
    };
    await Promise.all(workers.map((w) => runOn(w).catch((e) => { failure = failure || e; })));
    if (failure) throw failure;
    found.sort((a, b) => a.index - b.index);
    return { found, unreadable };
  }

  const client = {
    ready: prover.ready,
    getSpendVersionForBlockHeight,
    sparkTransactionVersion,

    buildInfo: () => call('buildInfo'),
    getFullViewKey: (a) => call('getFullViewKey', a),
    getFullViewKeyHexFromPrivateKeyData: ({ privateKey, privateKeyHex, index }) => call('getFullViewKey', { privateKey: privateKey ?? privateKeyHex, index }),
    getAddress: (a) => call('getAddress', a),
    getAddressFromFullViewKey: (a) => call('getAddressFromFullViewKey', a),
    validateAddress: (a) => call('validateAddress', a),
    checkAddress: (a) => call('checkAddress', a),

    identifyCoins,
    identifyAndRecoverCoinByFullViewKey: (a) => call('identifyAndRecoverCoinByFullViewKey', a),
    identifyAndRecoverCoin: (a) => call('identifyAndRecoverCoin', a),
    hashTags: (tags) => call('hashTags', { tags }),
    hashTag: (x, y) => call('hashTag', { x, y }),
    hashTagString: (tag) => call('hashTagString', { tag }),

    serializeMintContext: (inputs) => call('serializeMintContext', { inputs }),
    createSparkMintRecipients: (a) => call('createSparkMintRecipients', a),

    estimateSparkFee: (a) => call('estimateSparkFee', a),
    createSparkSendTransaction: heavy('createSparkSendTransaction'),
    verifySparkSpend: heavy('verifySparkSpend'),

    createSparkNameScript: (a) => call('createSparkNameScript', a),
    getSparkNameCommitment: (bytes) => call('getSparkNameCommitment', { serializedSparkNameData: bytes }),
    createSparkAddressOwnershipProof: (a) => call('createSparkAddressOwnershipProof', a),
    verifySparkAddressOwnershipProof: (a) => call('verifySparkAddressOwnershipProof', a),

    recycleProver,

    async stats() {
      const prov = await prover.request('memoryBytes');
      const identify = pool ? await Promise.all(pool.map((w) => w.request('memoryBytes').catch(() => null))) : [];
      return { prover: prov, identify };
    },

    close() {
      if (closed) return;
      closed = true;
      const err = new SparkError(t('the Spark client is closed'), 'closed');
      prover.fail(err);
      if (pool) for (const w of pool) w.fail(err);
    },
  };
  return client;
}
