// EVM transactions the wallet signs: EIP-1559 (type 2) only, on Ethereum
// mainnet (1) or BNB Chain (56) only (lib/eth/chains.js: BNB Chain's blocks
// carry a base fee of 0, so type-2 transactions are valid there), and EIP-712
// typed data (Permit2's PermitSingle for Uniswap, Ethereum only).
//
// The hash of a signed transaction is keccak256(raw), known before it is
// sent: the caller stores {hash, raw, nonce} first and then broadcasts, so a
// network error can be retried with the identical bytes.

import { rlpEncode, rlpDecode, rlpToBigInt } from './rlp.js';
import { keccak256, signDigest, recoverAddress, rsvSignature, isAddress, toChecksumAddress } from './crypto.js';
import { abiEncode } from './abi.js';
import { bytesToHex, toBytes, toBigInt, concatBytes, utf8ToBytes } from './hex.js';
import { SIGNABLE_CHAIN_IDS } from './chains.js';

export const MAINNET_CHAIN_ID = 1n;
export const BSC_CHAIN_ID = 56n;
export const TX_TYPE_EIP1559 = 0x02;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;

export class TxError extends Error {
  constructor(message) {
    super(message);
    this.code = 'tx';
  }
}

function uint(v, max, what) {
  let n;
  try {
    n = toBigInt(v);
  } catch {
    throw new TxError(`${what}: not an integer`);
  }
  if (n < 0n || n > max) throw new TxError(`${what} out of range`);
  return n;
}

/**
 * Checks and normalizes an EIP-1559 transaction:
 * {chainId=1, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value=0, data='0x', accessList=[]}.
 * chainId: 1 (Ethereum) or 56 (BNB Chain); anything else is refused.
 * `to` is required: this wallet never deploys contracts, and a missing `to` would.
 */
export function normalizeTx(tx) {
  const chainId = uint(tx.chainId ?? MAINNET_CHAIN_ID, MAX_U64, 'chainId');
  if (!SIGNABLE_CHAIN_IDS.includes(chainId)) throw new TxError(`refusing to sign for chain ${chainId}: only Ethereum mainnet (1) and BNB Chain (56)`);
  if (!isAddress(tx.to)) throw new TxError('to: not an address, or a bad checksum');
  const out = {
    chainId,
    nonce: uint(tx.nonce, MAX_U64 - 1n, 'nonce'), // EIP-2681
    maxPriorityFeePerGas: uint(tx.maxPriorityFeePerGas, MAX_U256, 'maxPriorityFeePerGas'),
    maxFeePerGas: uint(tx.maxFeePerGas, MAX_U256, 'maxFeePerGas'),
    gasLimit: uint(tx.gasLimit, MAX_U64, 'gasLimit'),
    to: tx.to.toLowerCase(),
    value: uint(tx.value ?? 0n, MAX_U256, 'value'),
    data: toBytes(tx.data ?? '0x'),
    accessList: (tx.accessList ?? []).map((e) => {
      if (!isAddress(e.address) || !Array.isArray(e.storageKeys)) throw new TxError('accessList: bad entry');
      return {
        address: e.address.toLowerCase(),
        storageKeys: e.storageKeys.map((k) => {
          const b = toBytes(k);
          if (b.length !== 32) throw new TxError('accessList: a storage key is 32 bytes');
          return bytesToHex(b);
        }),
      };
    }),
  };
  if (out.maxPriorityFeePerGas > out.maxFeePerGas) throw new TxError('the tip (maxPriorityFeePerGas) is above maxFeePerGas');
  if (out.gasLimit < 21000n) throw new TxError('gasLimit below 21,000');
  return out;
}

function fields(t) {
  return [
    t.chainId,
    t.nonce,
    t.maxPriorityFeePerGas,
    t.maxFeePerGas,
    t.gasLimit,
    toBytes(t.to),
    t.value,
    t.data,
    t.accessList.map((e) => [toBytes(e.address), e.storageKeys.map(toBytes)]),
  ];
}

/** keccak256(0x02 ‖ rlp([chainId, nonce, tip, maxFee, gas, to, value, data, accessList])): what is signed. */
export function signingHash(tx) {
  return keccak256(concatBytes(Uint8Array.of(TX_TYPE_EIP1559), rlpEncode(fields(normalizeTx(tx)))));
}

/** 0x02 ‖ rlp([..., yParity, r, s]) as bytes. */
export function serializeSigned(tx, { r, s, yParity }) {
  return concatBytes(Uint8Array.of(TX_TYPE_EIP1559), rlpEncode([...fields(normalizeTx(tx)), yParity, r, s]));
}

/**
 * Signs `tx` with `sk`. Returns {raw, hash, from, nonce, r, s, yParity}; raw and
 * hash are 0x-hex. The signature is checked by recovering the sender.
 */
export function signTransaction(tx, sk) {
  const t = normalizeTx(tx);
  const digest = signingHash(t);
  const sig = signDigest(digest, sk);
  const raw = serializeSigned(t, sig);
  const from = recoverAddress(digest, sig);
  return { raw: bytesToHex(raw), hash: bytesToHex(keccak256(raw)), from, nonce: t.nonce, ...sig };
}

/** keccak256(raw): the transaction hash. */
export function transactionHash(raw) {
  return bytesToHex(keccak256(toBytes(raw)));
}

/**
 * Parses a signed type-2 transaction and recovers its sender. Refuses other
 * types, non-canonical RLP and high-s signatures.
 */
export function parseSignedTransaction(raw) {
  const b = toBytes(raw);
  if (b[0] !== TX_TYPE_EIP1559) throw new TxError('not an EIP-1559 (type 2) transaction');
  const list = rlpDecode(b.subarray(1));
  if (!Array.isArray(list) || list.length !== 12) throw new TxError('a signed type-2 transaction has 12 fields');
  const [chainId, nonce, tip, maxFee, gas, to, value, data, accessList, yParity, r, s] = list;
  if (!(to instanceof Uint8Array) || to.length !== 20) throw new TxError('to: not 20 bytes');
  if (!Array.isArray(accessList)) throw new TxError('accessList: not a list');
  const tx = {
    chainId: rlpToBigInt(chainId),
    nonce: rlpToBigInt(nonce),
    maxPriorityFeePerGas: rlpToBigInt(tip),
    maxFeePerGas: rlpToBigInt(maxFee),
    gasLimit: rlpToBigInt(gas),
    to: toChecksumAddress(bytesToHex(to)),
    value: rlpToBigInt(value),
    data: bytesToHex(data),
    accessList: accessList.map((e) => {
      if (!Array.isArray(e) || e.length !== 2 || !Array.isArray(e[1])) throw new TxError('accessList: bad entry');
      return { address: bytesToHex(e[0]), storageKeys: e[1].map((k) => bytesToHex(k)) };
    }),
  };
  const sig = { yParity: Number(rlpToBigInt(yParity)), r: rlpToBigInt(r), s: rlpToBigInt(s) };
  // The digest is computed from the decoded fields, without the chain-1 rule, so a
  // foreign transaction can still be read; the caller decides what to do with it.
  const digest = keccak256(concatBytes(Uint8Array.of(TX_TYPE_EIP1559), rlpEncode(list.slice(0, 9))));
  return { tx, ...sig, from: recoverAddress(digest, sig), hash: bytesToHex(keccak256(b)) };
}

// ---------------------------------------------------------------- a server's transaction

const quantity = (v, what) => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{0,64}$/.test(v)) throw new TxError(`${what}: not a quantity`);
  return v === '0x' ? 0n : BigInt(v);
};
const fixedBytes = (v, n, what) => {
  const b = toBytes(v);
  if (b.length !== n) throw new TxError(`${what}: not ${n} bytes`);
  return b;
};

/**
 * A transaction as a server's JSON shows it (eth_getTransactionByHash, a block's full list),
 * checked instead of believed: its signed bytes are rebuilt from the fields, their keccak must be
 * the hash the server gave, and the sender is recovered from the signature. A server can write
 * any `from` it likes; it cannot sign for a key it does not hold. Legacy (with or without
 * EIP-155), EIP-2930, EIP-1559 and EIP-7702 transactions; anything else, or anything that does
 * not add up, is null. Returns {hash, from, nonce, chainId (null for a pre-EIP-155 legacy one)}.
 */
export function verifyRpcTransaction(t) {
  try {
    if (!t || typeof t !== 'object') return null;
    const type = t.type == null ? 0 : Number(quantity(t.type, 'type'));
    const nonce = quantity(t.nonce, 'nonce');
    const gas = quantity(t.gas, 'gas');
    const value = quantity(t.value, 'value');
    const to = t.to == null ? new Uint8Array(0) : fixedBytes(t.to, 20, 'to');
    const data = toBytes(t.input ?? t.data ?? '0x');
    const r = quantity(t.r, 'r');
    const s = quantity(t.s, 's');
    const access = () =>
      (t.accessList ?? []).map((e) => [fixedBytes(e.address, 20, 'accessList'), (e.storageKeys ?? []).map((k) => fixedBytes(k, 32, 'storage key'))]);
    let chainId = null;
    let yParity;
    let unsigned;
    let raw;
    if (type === 0) {
      const v = quantity(t.v, 'v');
      const base = [nonce, quantity(t.gasPrice, 'gasPrice'), gas, to, value, data];
      if (v === 27n || v === 28n) {
        yParity = Number(v - 27n);
        unsigned = rlpEncode(base);
      } else {
        if (v < 35n) return null;
        chainId = (v - 35n) / 2n;
        yParity = Number((v - 35n) % 2n);
        unsigned = rlpEncode([...base, chainId, 0n, 0n]);
      }
      raw = rlpEncode([...base, v, r, s]);
    } else if (type === 1 || type === 2 || type === 4) {
      chainId = quantity(t.chainId, 'chainId');
      yParity = Number(quantity(t.yParity ?? t.v, 'yParity'));
      const fees = type === 1 ? [quantity(t.gasPrice, 'gasPrice')] : [quantity(t.maxPriorityFeePerGas, 'maxPriorityFeePerGas'), quantity(t.maxFeePerGas, 'maxFeePerGas')];
      const fields = [chainId, nonce, ...fees, gas, to, value, data, access()];
      if (type === 4) {
        if (!Array.isArray(t.authorizationList)) return null;
        fields.push(t.authorizationList.map((a) => [quantity(a.chainId, 'chainId'), fixedBytes(a.address, 20, 'authorization'), quantity(a.nonce, 'nonce'), quantity(a.yParity, 'yParity'), quantity(a.r, 'r'), quantity(a.s, 's')]));
      }
      unsigned = concatBytes(Uint8Array.of(type), rlpEncode(fields));
      raw = concatBytes(Uint8Array.of(type), rlpEncode([...fields, yParity, r, s]));
    } else return null;
    const hash = bytesToHex(keccak256(raw));
    if (typeof t.hash !== 'string' || t.hash.toLowerCase() !== hash) return null;
    const from = recoverAddress(keccak256(unsigned), { r, s, yParity });
    return { hash, from, nonce, chainId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- EIP-712

function typeDeps(primary, types, found = new Set()) {
  if (found.has(primary) || !types[primary]) return found;
  found.add(primary);
  for (const f of types[primary]) typeDeps(f.type.replace(/\[\d*\]$/, ''), types, found);
  return found;
}

/** encodeType: the primary type, then its dependencies sorted by name. */
export function encodeType(primary, types) {
  const deps = [...typeDeps(primary, types)].filter((t) => t !== primary).sort();
  return [primary, ...deps].map((t) => `${t}(${types[t].map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}

export function typeHash(primary, types) {
  return keccak256(encodeType(primary, types));
}

function encodeField(type, value, types) {
  if (types[type]) return hashStruct(type, value, types);
  const arr = /^(.*)\[(\d*)\]$/.exec(type);
  if (arr) {
    if (!Array.isArray(value)) throw new TxError(`${type}: expected a list`);
    if (arr[2] !== '' && value.length !== Number(arr[2])) throw new TxError(`${type}: wrong length`);
    return keccak256(concatBytes(...value.map((v) => encodeField(arr[1], v, types))));
  }
  if (type === 'string') return keccak256(utf8ToBytes(String(value)));
  if (type === 'bytes') return keccak256(toBytes(value));
  return abiEncode(type, [value]);
}

/** hashStruct(s) = keccak256(typeHash ‖ encodeData(s)). */
export function hashStruct(primary, data, types) {
  if (!types[primary]) throw new TxError(`unknown EIP-712 type ${primary}`);
  const parts = [typeHash(primary, types)];
  for (const f of types[primary]) {
    if (!(f.name in data)) throw new TxError(`${primary}.${f.name} is missing`);
    parts.push(encodeField(f.type, data[f.name], types));
  }
  return keccak256(concatBytes(...parts));
}

const DOMAIN_FIELDS = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
  ['salt', 'bytes32'],
];

/** EIP712Domain's fields, in the standard order, for those `domain` has. */
export function domainType(domain) {
  return DOMAIN_FIELDS.filter(([n]) => domain[n] !== undefined).map(([name, type]) => ({ name, type }));
}

export function domainSeparator(domain) {
  return hashStruct('EIP712Domain', domain, { EIP712Domain: domainType(domain) });
}

/**
 * The EIP-712 digest of {types, primaryType, domain, message}:
 * keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(message)).
 */
export function hashTypedData({ types, primaryType, domain, message }) {
  const own = { ...types, EIP712Domain: types.EIP712Domain || domainType(domain) };
  return keccak256(concatBytes(Uint8Array.of(0x19, 0x01), hashStruct('EIP712Domain', domain, own), hashStruct(primaryType, message, own)));
}

// ---------------------------------------------------------------- Permit2

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export const PERMIT_SINGLE_TYPES = Object.freeze({
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
});

/** Permit2's domain: a name and no version. */
export function permit2Domain(chainId = MAINNET_CHAIN_ID) {
  return { name: 'Permit2', chainId: toBigInt(chainId), verifyingContract: PERMIT2_ADDRESS };
}

export function permit2DomainSeparator(chainId = MAINNET_CHAIN_ID) {
  return domainSeparator(permit2Domain(chainId));
}

/** {token, amount, expiration, nonce, spender, sigDeadline} → the typed data Permit2 checks. */
export function permitSingleTypedData(p, chainId = MAINNET_CHAIN_ID) {
  return {
    types: PERMIT_SINGLE_TYPES,
    primaryType: 'PermitSingle',
    domain: permit2Domain(chainId),
    message: {
      details: { token: p.token, amount: toBigInt(p.amount), expiration: toBigInt(p.expiration), nonce: toBigInt(p.nonce) },
      spender: p.spender,
      sigDeadline: toBigInt(p.sigDeadline),
    },
  };
}

/** The 32-byte digest the wallet signs to let `spender` take `amount` of `token`. */
export function permitSingleDigest(p, chainId = MAINNET_CHAIN_ID) {
  return hashTypedData(permitSingleTypedData(p, chainId));
}

/**
 * Signs a PermitSingle: 65 bytes r‖s‖v (v 27/28), as Permit2 and the router take it. The chain is
 * named, never assumed (public audit, PN): Permit2's domain binds it, so a permit is good on that
 * chain only.
 */
export function signPermitSingle(p, sk, chainId = MAINNET_CHAIN_ID) {
  if (BigInt(chainId) !== BigInt(MAINNET_CHAIN_ID)) throw new Error('Permit2 is used on Ethereum only here.');
  return rsvSignature(signDigest(permitSingleDigest(p, chainId), sk));
}

/** The router's PERMIT2_PERMIT input: abi.encode(PermitSingle, bytes signature). */
export function permit2PermitInput(p, signature) {
  return abiEncode('((address,uint160,uint48,uint48),address,uint256),bytes', [
    [[p.token, toBigInt(p.amount), toBigInt(p.expiration), toBigInt(p.nonce)], p.spender, toBigInt(p.sigDeadline)],
    signature,
  ]);
}

