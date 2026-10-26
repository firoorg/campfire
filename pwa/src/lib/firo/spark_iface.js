// The Spark client this engine expects from the spark stream
// (pwa/src/lib/firo/spark/): a promise API mirroring libsparkmobile's C ABI
// (flutter_libsparkmobile.h), stateless — key material goes in with each call,
// so the client can live in a Web Worker and keep nothing.
//
// Conventions: bytes are Uint8Array; amounts are BigInt satoshi; txids and
// lTagHash are display hex (as Firo Core's uint256::GetHex prints them);
// `index` is the Spark key index (1, Campfire's kDefaultSparkIndex);
// `isTestNet` is a boolean.
//
// Coins as this engine hands them over:
//   SetCoin = { coin, txHash, context }       coin: the anonymity-set entry's first element exactly as
//                                             the server sent it; txHash: 32 bytes internal order;
//                                             context: the serial context bytes
//   OwnCoin = { coin, context, groupId, height }   one of ours, to spend
//
// Methods (★ = needed for the first milestone; the rest throw NotYet in the
// engine until the client has them):
//
// ★ getFullViewKey({keyData, index}) → Uint8Array
//     getFullViewKeyFromPrivateKeyData + serializeFullViewKey
// ★ getAddress({keyData, index, diversifier, isTestNet}) → string 'sm1…'
// ★ getAddressFromFullViewKey({fullViewKey, index, diversifier, isTestNet}) → string
//   isValidSparkAddress({address, isTestNet}) → boolean
// ★ identifyCoins({keyData | fullViewKey, index, isTestNet, coins: [{coin, context}]}) → (IdentifiedCoin | null)[]
//     idAndRecoverCoin / idAndRecoverCoinByFullViewKey over a batch, same order, null = not ours.
//     IdentifiedCoin = {value: BigInt, memo: string, diversifier: number, lTagHash: hex,
//                       isMint?: boolean}   (lTagHash = GetLTagHash(T), SHA256d("tag_hash\0" ‖ tag))
// ★ serializeMintContext({inputs: [{txid, vout}]}) → Uint8Array
// ★ createSparkMintRecipients({outputs: [{address, value, memo}], serialContext, generate})
//     → [{script: Uint8Array (OP_SPARKMINT …), value: BigInt}]   generate:false gives same-size dummies
// ★ estimateSparkFee({keyData, index, sendAmount, subtractFee, coins: OwnCoin[], privateRecipients,
//                     utxoNum, additionalTxSize, spendVersion}) → BigInt
// ★ createSparkSpendTransaction({keyData, index,
//       recipients: [{address, value, subtractFee}],                  transparent outputs
//       privateRecipients: [{address, value, subtractFee, memo}],
//       coins: OwnCoin[],
//       coverSets: [{groupId, setHash (base64), blockHash (base64), coins: [{coin, txHash}]}],   oldest first
//       idAndBlockHashes: [{groupId, blockHash: Uint8Array (internal order)}],
//       txHashSig: Uint8Array,       SHA256d of the transaction without proof (see backend._buildSparkSpend)
//       additionalTxSize, spendVersion (1 | 2), extensionCommitment?: Uint8Array})
//     → {payload: Uint8Array (vExtraPayload), outputScripts: Uint8Array[] (OP_SPARKSMINT, value 0),
//        fee: BigInt, usedCoins: [{coin, groupId}]}
//   createSparkNameScript(...), getSparkNameCommitment(...), createSparkAddressOwnershipProof(...)  later
import { t } from '../i18n.js';

export const SPARK_METHODS = Object.freeze({
  keys: ['getFullViewKey', 'getAddress'],
  viewOnly: ['getAddressFromFullViewKey'],
  scan: ['identifyCoins'],
  mint: ['serializeMintContext', 'createSparkMintRecipients'],
  spend: ['estimateSparkFee', 'createSparkSpendTransaction'],
  names: ['createSparkNameScript', 'getSparkNameCommitment'],
  validate: ['isValidSparkAddress'],
});

/** Whether `spark` has every method of `group` (a key of SPARK_METHODS). */
export function sparkHas(spark, group) {
  return !!spark && SPARK_METHODS[group].every((m) => typeof spark[m] === 'function');
}

/** Throws Error code 'NotYet' unless `spark` has every method of `group`. */
export function requireSpark(spark, group, what) {
  if (!sparkHas(spark, group)) {
    const e = new Error(t('{what} needs the Spark library, which is not available yet.', { what }));
    e.code = 'NotYet';
    throw e;
  }
}
