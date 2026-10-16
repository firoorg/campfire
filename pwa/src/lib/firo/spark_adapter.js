// SPDX-License-Identifier: MIT
// Joins the Spark client (lib/firo/spark/client.js, Firo's sparkmobile compiled to WebAssembly)
// to the interface the wallet engine expects (lib/firo/spark_iface.js). Only names, shapes and
// encodings change here; every cryptographic step is the client's.
//
//   const spark = adaptSparkClient(createSparkClient());
//   createBackend({ …, spark });
//
// Encodings handled:
//   - key material: the engine says `keyData`, the client `privateKey` (the same 32 bytes at
//     m/44'/136'/0'/6/1);
//   - amounts: the client answers decimal strings, the engine wants BigInt;
//   - full view keys: the client answers hex, the engine wants bytes;
//   - identification: the client answers { found: [{ index, … }] }, the engine wants one entry per
//     coin in the same order, null where the coin is not ours;
//   - anonymity sets: the engine stores a group oldest first; the library takes the server's order,
//     newest first, which is what Campfire hands it too (its cache stores oldest first and reverses
//     again on read: firo_cache_coordinator.dart getSetCoinsForGroupId). The engine passes sets
//     already newest first (backend._buildSparkSpend); this module only re-encodes them;
//   - set and block hashes: the engine keeps ElectrumX's base64; the client takes the raw 32 bytes.

import { base64ToBytes, bytesToHex, hexToBytes, sha256 } from './bytes.js';

const toBig = (v) => BigInt(v);
const asBytes = (v) => (v instanceof Uint8Array ? v : typeof v === 'string' ? hexToBytes(v) : new Uint8Array(v));

/** The client's own-coin shape from the engine's OwnCoin {coin, context, groupId, height}. */
function ownCoin(c) {
  return { serializedCoin: c.coin, serializedCoinContext: c.context, groupId: c.groupId, height: c.height ?? 0 };
}

/**
 * Wraps a Spark client (createSparkClient()) in the engine's interface.
 * @param {object} client
 */
export function adaptSparkClient(client) {
  // Full view keys derived from key material, per key (the engine asks once per identify batch).
  // Keyed by a SHA-256 fingerprint, never by the key itself: a hex string of the spend key would
  // stay in memory after Lock wiped its bytes (audit A-2 / B-4). Emptied on close() and, since the
  // client is one per page and outlives a Lock, by the engine's close (forgetKeys: public audit, PN).
  const fvkCache = new Map();
  async function fullViewKeyOf(keyData) {
    const k = bytesToHex(sha256(asBytes(keyData)));
    if (!fvkCache.has(k)) fvkCache.set(k, client.getFullViewKey({ privateKey: asBytes(keyData), index: 1 }));
    return fvkCache.get(k);
  }

  return {
    client,
    ready: client.ready,

    async getFullViewKey({ keyData, index }) {
      return hexToBytes(await client.getFullViewKey({ privateKey: asBytes(keyData), index }));
    },

    getAddress({ keyData, index, diversifier, isTestNet }) {
      return client.getAddress({ privateKey: asBytes(keyData), index, diversifier, isTestNet });
    },

    getAddressFromFullViewKey({ fullViewKey, diversifier, isTestNet }) {
      return client.getAddressFromFullViewKey({ fullViewKey: asBytes(fullViewKey), diversifier, isTestNet });
    },

    isValidSparkAddress({ address, isTestNet }) {
      return client.validateAddress({ address, isTestNet });
    },

    async identifyCoins({ keyData, fullViewKey, index, isTestNet, coins, onProgress, signal }) {
      if (index !== undefined && index !== 1) throw Object.assign(new Error('Only Spark key index 1 is supported.'), { code: 'invalid-key' });
      const fvk = fullViewKey ? asBytes(fullViewKey) : await fullViewKeyOf(keyData);
      const res = await client.identifyCoins({ fullViewKey: fvk, coins, isTestNet, onProgress, signal });
      const out = new Array(coins.length).fill(null);
      for (const f of res.found) {
        out[f.index] = {
          value: toBig(f.value),
          memo: f.memo ?? '',
          diversifier: Number(f.diversifier),
          lTagHash: f.lTagHash,
          isMint: f.type === 'mint',
          address: f.address,
        };
      }
      return out;
    },

    serializeMintContext({ inputs }) {
      return client.serializeMintContext(inputs);
    },

    async createSparkMintRecipients({ outputs, serialContext, generate }) {
      const res = await client.createSparkMintRecipients({
        outputs: outputs.map((o) => ({ address: o.address, value: o.value, memo: o.memo ?? '' })),
        serialContext,
        generate,
      });
      return res.map((r) => ({ script: asBytes(r.scriptPubKey), value: toBig(r.amount), subtractFee: r.subtractFeeFromAmount }));
    },

    async estimateSparkFee({ keyData, index, sendAmount, subtractFee, coins, privateRecipients, utxoNum, additionalTxSize, spendVersion }) {
      return toBig(
        await client.estimateSparkFee({
          privateKey: asBytes(keyData),
          index,
          sendAmount,
          subtractFeeFromAmount: !!subtractFee,
          coins: coins.map(ownCoin),
          privateRecipientsCount: typeof privateRecipients === 'number' ? privateRecipients : privateRecipients.length,
          utxoNum,
          additionalTxSize,
          spendVersion,
        }),
      );
    },

    async createSparkSpendTransaction({ keyData, index, recipients, privateRecipients, coins, coverSets, idAndBlockHashes, txHashSig, additionalTxSize, spendVersion, extensionCommitment }) {
      const r = await client.createSparkSendTransaction({
        privateKey: asBytes(keyData),
        index,
        recipients: recipients.map((x) => ({ amount: x.value, subtractFeeFromAmount: !!x.subtractFee })),
        privateRecipients: privateRecipients.map((x) => ({ address: x.address, amount: x.value, memo: x.memo ?? '', subtractFeeFromAmount: !!x.subtractFee })),
        coins: coins.map(ownCoin),
        anonymitySets: coverSets.map((s) => ({
          setId: s.groupId,
          setHash: typeof s.setHash === 'string' ? base64ToBytes(s.setHash) : s.setHash,
          coins: s.coins.map((c) => c.coin),
        })),
        idAndBlockHashes: idAndBlockHashes.map((x) => ({ setId: x.groupId, blockHash: x.blockHash })),
        txHash: txHashSig,
        additionalTxSize,
        spendVersion,
        extensionCommitment,
      });
      return {
        payload: asBytes(r.serializedSpendPayload),
        outputScripts: r.outputScripts.map(asBytes),
        fee: toBig(r.fee),
        usedCoins: (r.usedCoins ?? []).map((c) => ({ coin: c.serializedCoin, context: c.serializedCoinContext, groupId: c.groupId, height: c.height })),
      };
    },

    /** The node's proof check, run before a spend is broadcast (engine: backend._buildSparkSpend). */
    verifySparkSpend(args) {
      return client.verifySparkSpend(args);
    },

    createSparkNameScript(args) {
      return client.createSparkNameScript(args);
    },

    getSparkNameCommitment(data) {
      return client.getSparkNameCommitment(data);
    },

    /** Drops the full view keys derived so far (the engine's close, on Lock: PN). The client stays up. */
    forgetKeys() {
      fvkCache.clear();
    },

    close() {
      fvkCache.clear();
      return client.close();
    },
  };
}
