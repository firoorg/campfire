// SPDX-License-Identifier: MIT
// Shared by the Spark benchmarks (Node and the browser page): reading a downloaded group
// (fetch_group.mjs format) and building the inputs of an identification run and of a spend.

export const COIN_BYTES = 244;

/** group-<id>.bin -> [{ serialized, txHash, context }] (views into the buffer, no copies). */
export function parseGroup(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = [];
  let off = 0;
  const field = () => {
    const n = dv.getUint32(off, true);
    const v = buf.subarray(off + 4, off + 4 + n);
    off += 4 + n;
    return v;
  };
  while (off < buf.length) out.push({ serialized: field(), txHash: field(), context: field() });
  return out;
}

/** The identify list as one packed buffer: count * (bytes coin, bytes context). */
export function packIdentify(entries) {
  let total = 0;
  for (const e of entries) total += 8 + e.serialized.length + e.context.length;
  const data = new Uint8Array(total);
  const dv = new DataView(data.buffer);
  let off = 0;
  for (const e of entries) {
    for (const f of [e.serialized, e.context]) {
      dv.setUint32(off, f.length, true);
      data.set(f, off + 4);
      off += 4 + f.length;
    }
  }
  return { count: entries.length, data };
}

/** A set's coins as one packed buffer: count * (bytes coin). */
export function packSet(coins) {
  let total = 0;
  for (const c of coins) total += 4 + c.length;
  const data = new Uint8Array(total);
  const dv = new DataView(data.buffer);
  let off = 0;
  for (const c of coins) {
    dv.setUint32(off, c.length, true);
    data.set(c, off + 4);
    off += 4 + c.length;
  }
  return { count: coins.length, data };
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A spend over a real, full-size group: our own freshly minted coin is added to the group's
 * coins (as a mint would add it), then spent to another address.
 * spark: anything with the client's async API (client.js) or a sync SparkCore wrapped in promises.
 */
export async function prepareSpend(spark, groupEntries, meta, { setId = 10, coinOnly = true } = {}) {
  const me = randomBytes(32);
  const them = randomBytes(32);
  const myAddress = await spark.getAddress({ privateKey: me, index: 1, diversifier: 0 });
  const theirAddress = await spark.getAddress({ privateKey: them, index: 1, diversifier: 0 });
  const mintContext = await spark.serializeMintContext([{ txid: Array.from(randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join(''), vout: 0 }]);
  const [rec] = await spark.createSparkMintRecipients({ outputs: [{ address: myAddress, value: '100000000', memo: 'bench' }], serialContext: mintContext, generate: true });
  const myCoin = rec.scriptPubKey.subarray(1, 1 + COIN_BYTES); // after OP_SPARKMINT; a first mint output also carries the mint proof
  // A set entry is the 244-byte coin, then the tx hash and serial context (fetch_group.mjs
  // measured every mainnet coin at 244 bytes); a wallet only needs to keep the coin.
  const setCoins = groupEntries.map((e) => (coinOnly ? e.serialized.subarray(0, COIN_BYTES) : e.serialized));
  setCoins.push(myCoin);
  const anonymitySets = [{ setId, setHash: base64ToBytes(meta.setHash), coins: packSet(setCoins) }];
  return {
    me,
    setSize: setCoins.length,
    args: {
      privateKey: me,
      index: 1,
      recipients: [],
      privateRecipients: [{ address: theirAddress, amount: '50000000', memo: 'bench spend', subtractFeeFromAmount: false }],
      coins: [{ serializedCoin: myCoin, serializedCoinContext: mintContext, groupId: setId, height: 1 }],
      anonymitySets,
      idAndBlockHashes: [{ setId, blockHash: base64ToBytes(meta.blockHash) }],
      txHash: randomBytes(32),
      spendVersion: 2,
    },
  };
}
