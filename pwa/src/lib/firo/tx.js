// Firo transactions: decode any of them, and build + sign transparent P2PKH
// spends. From Firo Core src/primitives/transaction.h and
// src/script/interpreter.cpp (44aff224eb):
//
//   int32 nVersion = version (low 16 bits) | type << 16
//   vin, vout, nLockTime, and when version == 3 && type != 0: vExtraPayload
//
// Types: 0 normal, 1-4 masternode (ProTx), 5 coinbase, 6 quorum commitment,
// 7 spork, 8 Lelantus, 9 Spark spend (chaum v1), 10 alias, 11 Spark spend
// (chaum v2, from block 1,371,000).
//
// Signatures use the legacy (pre-segwit) sighash: the transaction with every
// scriptSig blanked except the signed input's, which carries the previous
// output script; then the 32-bit nVersion including the type, the extra
// payload for special transactions, and the 4-byte hash type, SHA256d.

import { secp256k1 } from '../../vendor/noble/noble-curves/secp256k1.js';
import { Reader, Writer, BytesError, hexToBytes, bytesToHex, hashFromHex, hashToHex, sha256d, concatBytes, equalBytes, hash160, utf8ToBytes, bytesToUtf8, reverse } from './bytes.js';
import { OP, classifyOutputScript, classifyInputScript, parseScript, pushData, p2pkhScript, outputSize } from './script.js';
import { scriptToAddress } from './address.js';
import { TX_TYPE, SPARK_NAME_RE } from './params.js';

export class TxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'decode' | 'build' | 'sign' | 'dust' | 'insufficient'
  }
}

export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;
/** nSequence Firo Core's wallet uses: final for relay, locktime still enforced. */
export const SEQUENCE_LOCKTIME = 0xfffffffe;
export const SEQUENCE_FINAL = 0xffffffff;

const NULL_HASH = new Uint8Array(32);

// ---------------------------------------------------------------- decoding

function readTx(r) {
  const versionRaw = r.i32();
  const version = versionRaw & 0xffff;
  const type = (versionRaw >>> 16) & 0xffff;
  let vinCount = r.varint();
  let flags = 0;
  if (vinCount === 0) {
    // BIP144 marker: an empty vin, then flags.
    flags = r.u8();
    if (flags !== 0) vinCount = r.varint();
  }
  const vin = [];
  for (let i = 0; i < vinCount; i++) {
    const prevHash = r.bytes(32);
    const vout = r.u32();
    const scriptSig = r.varbytes();
    const sequence = r.u32();
    vin.push({ prevHash: Uint8Array.from(prevHash), vout, scriptSig: Uint8Array.from(scriptSig), sequence });
  }
  const voutCount = r.varint();
  const vout = [];
  for (let i = 0; i < voutCount; i++) {
    const value = r.u64();
    const script = r.varbytes();
    vout.push({ value, script: Uint8Array.from(script) });
  }
  if (flags & 1) {
    for (const input of vin) {
      const n = r.varint();
      input.witness = [];
      for (let j = 0; j < n; j++) input.witness.push(Uint8Array.from(r.varbytes()));
    }
    flags ^= 1;
  }
  if (flags) throw new TxError('decode', 'Unknown transaction optional data.');
  const locktime = r.u32();
  const extraPayload = version === 3 && type !== TX_TYPE.NORMAL ? Uint8Array.from(r.varbytes()) : null;
  return { versionRaw, version, type, vin, vout, locktime, extraPayload, hasWitness: vin.some((i) => i.witness) };
}

/**
 * Raw transaction (hex or bytes) → its parts and what kind of Firo
 * transaction it is. With `net`, outputs carry their address.
 *
 * {txid, size, versionRaw, version, type, vin[], vout[], locktime,
 *  extraPayload, kind, isCoinbase, spark?, sparkName?}
 */
export function decodeTx(raw, net = null) {
  const bytes = typeof raw === 'string' ? hexToBytes(raw) : raw;
  const r = new Reader(bytes);
  let t;
  try {
    t = readTx(r);
  } catch (e) {
    throw new TxError('decode', `Not a Firo transaction: ${e.message}`);
  }
  if (r.remaining !== 0) throw new TxError('decode', 'Not a Firo transaction: bytes left over.');
  const txid = hashToHex(sha256d(t.hasWitness ? serializeTx(t, { witness: false }) : bytes));

  const isCoinbase = t.type === TX_TYPE.COINBASE || (t.vin.length === 1 && equalBytes(t.vin[0].prevHash, NULL_HASH) && t.vin[0].vout === 0xffffffff && classifyInputScript(t.vin[0].scriptSig) === null && t.type !== TX_TYPE.SPARK && t.type !== TX_TYPE.SPARK_V2);
  const vin = t.vin.map((i) => {
    const privacy = classifyInputScript(i.scriptSig);
    const nullPrev = equalBytes(i.prevHash, NULL_HASH);
    return {
      txid: nullPrev ? null : hashToHex(i.prevHash),
      vout: i.vout,
      scriptSig: i.scriptSig,
      sequence: i.sequence,
      witness: i.witness,
      kind: isCoinbase ? 'coinbase' : privacy ?? (t.type === TX_TYPE.SPARK || t.type === TX_TYPE.SPARK_V2 ? 'spark-spend' : 'regular'),
    };
  });
  const vout = t.vout.map((o, n) => {
    const c = classifyOutputScript(o.script);
    const out = { n, value: o.value, script: o.script, type: c.type };
    if (c.type === 'nulldata') out.data = c.data;
    if (c.type === 'spark-name-fee') out.sparkName = { name: c.name, address: c.sparkAddress };
    if (net) out.address = scriptToAddress(o.script, net);
    return out;
  });

  const tx = { txid, size: bytes.length, versionRaw: t.versionRaw, version: t.version, type: t.type, vin, vout, locktime: t.locktime, extraPayload: t.extraPayload, isCoinbase };

  if ((t.type === TX_TYPE.SPARK || t.type === TX_TYPE.SPARK_V2) && t.version >= 3 && t.extraPayload) {
    const smints = vout.filter((o) => o.type === 'spark-smint').length;
    try {
      tx.spark = parseSparkSpendHeader(t.extraPayload, t.type === TX_TYPE.SPARK_V2 ? 2 : 1, smints);
    } catch {
      tx.spark = { version: t.type === TX_TYPE.SPARK_V2 ? 2 : 1, unparsed: true };
    }
    const nm = findSparkNameData(t.extraPayload);
    const feeOut = vout.find((o) => o.sparkName);
    if (nm) tx.sparkName = nm;
    else if (feeOut) tx.sparkName = { name: feeOut.sparkName.name, address: feeOut.sparkName.address };
  }
  tx.kind = txKind(tx);
  return tx;
}

/**
 * coinbase | spark-spend | spark-mint | lelantus | sigma | zerocoin |
 * masternode-tx (ProTx) | quorum | spork | transparent
 */
function txKind(tx) {
  if (tx.isCoinbase) return 'coinbase';
  if (tx.type === TX_TYPE.SPARK || tx.type === TX_TYPE.SPARK_V2) return 'spark-spend';
  if (tx.type === TX_TYPE.LELANTUS || tx.vin.some((i) => i.kind === 'lelantus-joinsplit') || tx.vout.some((o) => o.type === 'lelantus-mint' || o.type === 'lelantus-jmint')) return 'lelantus';
  if (tx.vout.some((o) => o.type === 'spark-mint')) return 'spark-mint';
  if (tx.vin.some((i) => i.kind === 'sigma-spend' || i.kind === 'remint') || tx.vout.some((o) => o.type === 'sigma-mint')) return 'sigma';
  if (tx.vin.some((i) => i.kind === 'zerocoin-spend') || tx.vout.some((o) => o.type === 'zerocoin-mint')) return 'zerocoin';
  if (tx.version === 3 && tx.type >= TX_TYPE.PROVIDER_REGISTER && tx.type <= TX_TYPE.PROVIDER_UPDATE_REVOKE) return 'masternode-tx';
  if (tx.version === 3 && tx.type === TX_TYPE.QUORUM_COMMITMENT) return 'quorum';
  if (tx.version === 3 && tx.type === TX_TYPE.SPORK) return 'spork';
  return 'transparent';
}

// ---------------------------------------------------------------- Spark spend payload

/** SHA256d("tag_hash\0" ‖ tag), shown reversed: Firo's primitives::GetLTagHash, as ElectrumX and libspark use it. */
export function lTagHash(tag34) {
  if (!(tag34 instanceof Uint8Array) || tag34.length !== 34) throw new BytesError('A linking tag is 34 bytes.');
  return bytesToHex(reverse(sha256d(concatBytes(TAG_HASH_PREFIX, tag34))));
}
const TAG_HASH_PREFIX = Uint8Array.of(...utf8ToBytes('tag_hash'), 0);

/**
 * The front of a Spark spend payload (libspark spend_transaction.h): the
 * cover set (group) ids, their block hashes, the fee and the linking tags.
 * The proofs after them are not read.
 */
export function parseSparkSpendHeader(payload, version, privateOutputs = null) {
  const r = new Reader(payload);
  const out = { version, coverSetIds: [], blockHashes: {}, fee: 0n, tags: [], lTagHashes: [] };
  let n;
  if (version === 2) {
    const wire = r.u8();
    if (wire !== 2) throw new TxError('decode', 'Unknown Spark spend version.');
    n = r.varint();
    out.outputs = r.varint();
    if (n === 0 || n > 1000 || out.outputs === 0 || out.outputs > 16) throw new TxError('decode', 'Bad Spark spend size.');
    if (privateOutputs !== null && out.outputs !== privateOutputs) throw new TxError('decode', 'Spark output count does not match.');
    for (let i = 0; i < n; i++) out.coverSetIds.push(Number(r.u64()));
    const hashes = r.varint();
    if (hashes > n) throw new TxError('decode', 'Bad Spark spend.');
    for (let i = 0; i < hashes; i++) {
      const id = Number(r.u64());
      out.blockHashes[id] = hashToHex(r.bytes(32));
    }
    out.fee = r.u64();
    out.extensionCommitment = bytesToHex(r.bytes(32));
    r.bytes(34 * n); // S1
    r.bytes(34 * n); // C1
    for (let i = 0; i < n; i++) out.tags.push(Uint8Array.from(r.bytes(34)));
  } else {
    const ids = r.varint();
    if (ids > 1000) throw new TxError('decode', 'Bad Spark spend.');
    for (let i = 0; i < ids; i++) out.coverSetIds.push(Number(r.u64()));
    const hashes = r.varint();
    if (hashes > 1000) throw new TxError('decode', 'Bad Spark spend.');
    for (let i = 0; i < hashes; i++) {
      const id = Number(r.u64());
      out.blockHashes[id] = hashToHex(r.bytes(32));
    }
    out.fee = r.u64();
    const s1 = r.varint();
    r.bytes(34 * s1);
    const c1 = r.varint();
    r.bytes(34 * c1);
    n = r.varint();
    if (n !== s1 || n !== c1 || n > 1000) throw new TxError('decode', 'Bad Spark spend.');
    for (let i = 0; i < n; i++) out.tags.push(Uint8Array.from(r.bytes(34)));
  }
  out.inputs = n;
  out.lTagHashes = out.tags.map(lTagHash);
  return out;
}

const SPARK_ADDR_RE = /^s[a-z]1[02-9ac-hj-np-z]{100,200}$/;

function readSparkNameAt(p, b) {
  const r = new Reader(b, p);
  const nVersion = r.u16();
  if (nVersion !== 1 && nVersion !== 2) return null;
  r.bytes(32); // inputsHash
  const name = bytesToUtf8(r.varbytes(64));
  if (!SPARK_NAME_RE.test(name)) return null;
  const address = bytesToUtf8(r.varbytes(256));
  if (!SPARK_ADDR_RE.test(address)) return null;
  r.varbytes(4096); // address ownership proof
  const validityBlocks = r.u32();
  const additionalInfo = bytesToUtf8(r.varbytes(1024));
  r.u32(); // hashFailsafe
  let operation = 'register';
  let oldAddress = null;
  if (nVersion >= 2) {
    const op = r.u8();
    if (op > 2) return null;
    operation = ['register', 'transfer', 'unregister'][op];
    if (op === 1) {
      oldAddress = bytesToUtf8(r.varbytes(256));
      if (!SPARK_ADDR_RE.test(oldAddress)) return null;
      r.varbytes(4096);
    }
  }
  if (r.remaining !== 0) return null;
  return { name, address, validityBlocks, additionalInfo, operation, oldAddress, dataVersion: nVersion };
}

/**
 * The Spark name record Firo Core appends after the spend proof
 * (CSparkNameTxData), found by trying the tail of the payload: it must parse
 * to the last byte with a valid name and Spark address. null if none.
 */
export function findSparkNameData(payload) {
  const minLen = 2 + 32 + 2 + 1 + 1 + 4 + 1 + 4 + 100;
  const start = Math.max(0, payload.length - 8192);
  for (let p = start; p <= payload.length - minLen; p++) {
    if (payload[p + 1] !== 0 || (payload[p] !== 1 && payload[p] !== 2)) continue;
    try {
      const nm = readSparkNameAt(p, payload);
      if (nm) return nm;
    } catch {
      // not here
    }
  }
  return null;
}

// ---------------------------------------------------------------- encoding

/**
 * {versionRaw | version+type, vin: [{prevHash | txid, vout, scriptSig, sequence}],
 *  vout: [{value, script}], locktime, extraPayload?} → bytes.
 */
export function serializeTx(tx, { witness = true } = {}) {
  const w = new Writer();
  const versionRaw = tx.versionRaw ?? ((tx.version ?? 1) | ((tx.type ?? 0) << 16));
  w.i32(versionRaw | 0);
  const version = versionRaw & 0xffff;
  const type = (versionRaw >>> 16) & 0xffff;
  const withWitness = witness && tx.vin.some((i) => i.witness && i.witness.length);
  if (withWitness) w.u8(0).u8(1);
  w.varint(tx.vin.length);
  for (const i of tx.vin) {
    w.push(i.prevHash ?? (i.txid ? hashFromHex(i.txid) : NULL_HASH));
    w.u32(i.vout);
    w.varbytes(i.scriptSig ?? new Uint8Array(0));
    w.u32(i.sequence ?? SEQUENCE_FINAL);
  }
  w.varint(tx.vout.length);
  for (const o of tx.vout) {
    w.u64(o.value);
    w.varbytes(o.script);
  }
  if (withWitness) {
    for (const i of tx.vin) {
      const stack = i.witness ?? [];
      w.varint(stack.length);
      for (const item of stack) w.varbytes(item);
    }
  }
  w.u32(tx.locktime ?? 0);
  if (version === 3 && type !== TX_TYPE.NORMAL) w.varbytes(tx.extraPayload ?? new Uint8Array(0));
  return w.toBytes();
}

/** scriptCode with every OP_CODESEPARATOR removed, as SerializeScriptCode does. */
function stripCodeSeparators(script) {
  if (!script.includes(0xab)) return script;
  const ops = parseScript(script);
  if (!ops.some((o) => o.op === 0xab)) return script;
  return concatBytes(...ops.filter((o) => o.op !== 0xab).map((o) => (o.data ? pushData(o.data) : Uint8Array.of(o.op))));
}

/**
 * Legacy signature hash of input `nIn` (Firo Core SignatureHash with
 * SIGVERSION_BASE). `scriptCode` is the output script being spent.
 * Returns the 32-byte digest that is signed.
 */
export function legacySighash(tx, nIn, scriptCode, hashType = SIGHASH_ALL) {
  if (nIn < 0 || nIn >= tx.vin.length) throw new TxError('sign', 'Input index out of range.');
  const base = hashType & 0x1f;
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  if (base === SIGHASH_SINGLE && nIn >= tx.vout.length) {
    // Bitcoin's historical quirk: the "hash" is 1.
    const one = new Uint8Array(32);
    one[0] = 1;
    return one;
  }
  const code = stripCodeSeparators(scriptCode);
  const inputs = anyoneCanPay ? [nIn] : tx.vin.map((_, i) => i);
  const vin = inputs.map((i) => ({
    prevHash: tx.vin[i].prevHash ?? (tx.vin[i].txid ? hashFromHex(tx.vin[i].txid) : NULL_HASH),
    vout: tx.vin[i].vout,
    scriptSig: i === nIn ? code : new Uint8Array(0),
    sequence: i !== nIn && (base === SIGHASH_SINGLE || base === SIGHASH_NONE) ? 0 : tx.vin[i].sequence ?? SEQUENCE_FINAL,
  }));
  let vout;
  if (base === SIGHASH_NONE) vout = [];
  else if (base === SIGHASH_SINGLE) vout = tx.vout.slice(0, nIn + 1).map((o, i) => (i === nIn ? o : { value: 0xffffffffffffffffn, script: new Uint8Array(0) }));
  else vout = tx.vout;
  const body = serializeTx({ versionRaw: tx.versionRaw ?? ((tx.version ?? 1) | ((tx.type ?? 0) << 16)), vin, vout, locktime: tx.locktime ?? 0, extraPayload: tx.extraPayload }, { witness: false });
  const w = new Writer();
  w.push(body).u32(hashType >>> 0);
  return sha256d(w.toBytes());
}

// ---------------------------------------------------------------- signatures

/** DER signature (low S, RFC 6979) of a 32-byte digest. */
export function signDigestDer(digest, sk) {
  return secp256k1.sign(digest, sk, { prehash: false, lowS: true, format: 'der' });
}

/**
 * Checks the signature in a P2PKH input's scriptSig against the transaction.
 * `prevScript` defaults to the P2PKH script of the pubkey in the scriptSig.
 */
export function verifyP2PKHInput(tx, nIn, prevScript = null) {
  const ops = parseScript(tx.vin[nIn].scriptSig);
  if (ops.length !== 2 || !ops[0].data || !ops[1].data) return false;
  const sigWithType = ops[0].data;
  const pubkey = ops[1].data;
  const hashType = sigWithType[sigWithType.length - 1];
  const der = sigWithType.subarray(0, sigWithType.length - 1);
  const script = prevScript ?? p2pkhScript(hash160(pubkey));
  if (prevScript && !equalBytes(classifyOutputScript(prevScript).hash ?? new Uint8Array(0), hash160(pubkey))) return false;
  const digest = legacySighash(tx, nIn, script, hashType);
  try {
    return secp256k1.verify(der, digest, pubkey, { prehash: false, lowS: false, format: 'der' });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- building

/** Serialized size of a signed P2PKH input, upper bound (low-S DER ≤ 71 bytes + hash type). */
export const P2PKH_INPUT_SIZE = 148;
/** version + vin count + vout count + locktime, for up to 252 inputs and outputs. */
export const TX_OVERHEAD = 10;

/** Upper bound of a P2PKH-spending transaction's size with these output scripts. */
export function estimateSize(inputCount, outputScripts) {
  let n = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE;
  if (inputCount > 252) n += 2;
  if (outputScripts.length > 252) n += 2;
  for (const s of outputScripts) n += outputSize(s);
  return n;
}

/** Fee for `size` bytes at `feePerKb` sat/kB, rounded up, never below the relay minimum. */
export function feeForSize(size, feePerKb, minRelayFeePerKb = 1000n) {
  const rate = feePerKb > minRelayFeePerKb ? feePerKb : minRelayFeePerKb;
  return (BigInt(size) * rate + 999n) / 1000n;
}

/**
 * Builds and signs a transparent transaction.
 *
 * inputs:  [{txid, vout, value (bigint), script (prev P2PKH output script), sk (32 bytes)}]
 * outputs: [{script, value (bigint)}] — OP_RETURN outputs may be 0
 * Returns {hex, txid, size, fee, tx}. The caller wipes the keys.
 */
export function buildSignedTransaction({ inputs, outputs, locktime = 0, version = 1, type = 0, sequence = SEQUENCE_LOCKTIME, dust = 1000n, maxMoney = 21000000n * 100000000n }) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new TxError('build', 'A transaction needs at least one input.');
  if (!Array.isArray(outputs) || outputs.length === 0) throw new TxError('build', 'A transaction needs at least one output.');
  let inSum = 0n;
  for (const i of inputs) {
    if (typeof i.value !== 'bigint' || i.value <= 0n) throw new TxError('build', 'Every input needs its value.');
    const c = classifyOutputScript(i.script);
    if (c.type !== 'p2pkh') throw new TxError('build', 'Only P2PKH coins can be spent here.');
    inSum += i.value;
  }
  let outSum = 0n;
  let opReturns = 0;
  for (const o of outputs) {
    if (typeof o.value !== 'bigint' || o.value < 0n) throw new TxError('build', 'Bad output value.');
    const c = classifyOutputScript(o.script);
    if (c.type === 'nulldata') {
      opReturns++;
      if (o.value !== 0n) throw new TxError('build', 'An OP_RETURN output carries no coins.');
    } else if (o.value < dust) {
      throw new TxError('dust', 'An amount is too small to send (dust).');
    }
    outSum += o.value;
  }
  if (opReturns > 1) throw new TxError('build', 'Only one OP_RETURN output is standard.');
  if (outSum > maxMoney || inSum > maxMoney) throw new TxError('build', 'Amount out of range.');
  if (outSum > inSum) throw new TxError('insufficient', 'The outputs are more than the inputs.');

  const tx = {
    version,
    type,
    vin: inputs.map((i) => ({ txid: i.txid, prevHash: hashFromHex(i.txid), vout: i.vout, scriptSig: new Uint8Array(0), sequence })),
    vout: outputs.map((o) => ({ value: o.value, script: o.script })),
    locktime,
  };
  inputs.forEach((input, n) => {
    const pubkey = secp256k1.getPublicKey(input.sk, true);
    if (!equalBytes(hash160(pubkey), classifyOutputScript(input.script).hash)) throw new TxError('sign', 'A key does not match the coin it should spend.');
    const digest = legacySighash(tx, n, input.script, SIGHASH_ALL);
    const der = signDigestDer(digest, input.sk);
    tx.vin[n].scriptSig = concatBytes(pushData(concatBytes(der, Uint8Array.of(SIGHASH_ALL))), pushData(pubkey));
  });
  const bytes = serializeTx(tx);
  return { hex: bytesToHex(bytes), txid: hashToHex(sha256d(bytes)), size: bytes.length, fee: inSum - outSum, tx };
}

export { OP };

/**
 * The collateral of a masternode registration (special transaction type 1, ProRegTx): its payload
 * starts version u16, type u16, mode u16, then the collateral outpoint (32-byte txid, u32 index).
 * A null txid means the collateral is an output of the registration itself.
 * Returns {txid (display hex) | null, vout} or null when the payload is too short.
 */
export function proRegCollateral(payload) {
  if (!payload || payload.length < 6 + 36) return null;
  const hash = payload.subarray(6, 38);
  const vout = payload[38] | (payload[39] << 8) | (payload[40] << 16) | (payload[41] * 0x1000000);
  const isNull = hash.every((b) => b === 0);
  return { txid: isNull ? null : Array.from(hash).reverse().map((b) => b.toString(16).padStart(2, '0')).join(''), vout };
}
