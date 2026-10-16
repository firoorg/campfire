// SPDX-License-Identifier: MIT
// Module worker that owns one instance of the Spark wasm module (pwa/src/vendor/spark).
// Started by client.js (one prover worker + a pool of identification workers); never
// used directly by screens. Plain message protocol, no shared memory:
//   in:  { id, op, args }            op 'init' first: args { wasmUrl } or { wasmBinary }
//   out: { id, ok: true, result }    result buffers are transferred, not copied
//        { id, ok: false, error: { message, code } }
// Private keys arrive per call and live in wasm memory only for that call (core.js
// zeroes every request buffer before freeing it).

import createSparkModule from '../../../vendor/spark/spark.js';
import { loadSparkCore } from './core.js';

// The operations a page may ask for: SparkCore methods, nothing else.
const OPS = new Set([
  'buildInfo', 'getFullViewKey', 'getAddress', 'getAddressFromFullViewKey', 'checkAddress', 'validateAddress',
  'identifyCoins', 'identifyAndRecoverCoinByFullViewKey', 'identifyAndRecoverCoin', 'hashTags', 'hashTag',
  'hashTagString', 'serializeMintContext', 'createSparkMintRecipients', 'estimateSparkFee',
  'createSparkSendTransaction', 'verifySparkSpend', 'createSparkNameScript', 'getSparkNameCommitment',
  'createSparkAddressOwnershipProof', 'verifySparkAddressOwnershipProof', 'memoryBytes',
]);

let core = null;

function transferables(value, out = new Set(), depth = 0) {
  if (depth > 4 || value == null || typeof value !== 'object') return out;
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) out.add(value.buffer);
    return out;
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) transferables(v, out, depth + 1);
  return out;
}

async function handle(msg) {
  const { id, op, args } = msg || {};
  try {
    if (op === 'init') {
      if (!core) {
        core = loadSparkCore({
          createModule: createSparkModule,
          wasmBinary: args && args.wasmBinary,
          wasmUrl: args && args.wasmUrl,
        });
      }
      const c = await core;
      return { id, ok: true, result: { buildInfo: c.buildInfo(), memoryBytes: c.memoryBytes() } };
    }
    if (!core) throw Object.assign(new Error('the worker was not initialised'), { code: 'internal' });
    if (!OPS.has(op)) throw Object.assign(new Error(`unknown operation ${String(op)}`), { code: 'internal' });
    const c = await core;
    const result = op === 'hashTag' ? c.hashTag(args.x, args.y)
      : op === 'hashTags' ? c.hashTags(args.tags)
      : op === 'serializeMintContext' ? c.serializeMintContext(args.inputs)
      : op === 'getSparkNameCommitment' ? c.getSparkNameCommitment(args.serializedSparkNameData)
      : op === 'hashTagString' ? c.hashTagString(args.tag)
      : op === 'memoryBytes' || op === 'buildInfo' ? c[op]()
      : c[op](args);
    return { id, ok: true, result };
  } catch (e) {
    return { id, ok: false, error: { message: String((e && e.message) || e), code: (e && e.code) || 'spark' } };
  }
}

self.onmessage = (ev) => {
  handle(ev.data).then((reply) => {
    let transfer = [];
    if (reply.ok) transfer = [...transferables(reply.result)];
    self.postMessage(reply, transfer);
  });
};
