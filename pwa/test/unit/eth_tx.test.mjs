// EIP-1559 transactions and EIP-712 typed data: a real signed mainnet
// transaction, signatures byte-identical to Foundry's `cast mktx` and
// `cast wallet sign`, and Permit2's domain separator as Permit2 itself
// reports it on chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  signTransaction,
  signingHash,
  parseSignedTransaction,
  transactionHash,
  normalizeTx,
  hashTypedData,
  domainSeparator,
  hashStruct,
  encodeType,
  permit2DomainSeparator,
  permitSingleDigest,
  signPermitSingle,
  permit2PermitInput,
  PERMIT2_ADDRESS,
  TxError,
} from '../../src/lib/eth/tx.js';
import { ethKeyFromMnemonic, recoverAddress, parseRsvSignature } from '../../src/lib/eth/crypto.js';
import { bytesToHex } from '../../src/lib/eth/hex.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/eth/${n}`, import.meta.url), 'utf8'));
const MAINNET = fixture('mainnet_tx.json');
const CAST = fixture('cast_vectors.json');
const JUNK = 'test test test test test test test test test test test junk';
const anvil0 = () => ethKeyFromMnemonic(JUNK);
const castTx = (t) => ({ ...t, nonce: BigInt(t.nonce), gasLimit: BigInt(t.gasLimit), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas), value: BigInt(t.value) });

test('a real mainnet EIP-1559 transaction: keccak(raw) is its hash, and the sender recovers', () => {
  assert.equal(transactionHash(MAINNET.raw), MAINNET.hash);
  const p = parseSignedTransaction(MAINNET.raw);
  assert.equal(p.hash, MAINNET.hash);
  assert.equal(p.from.toLowerCase(), MAINNET.from);
  assert.equal(p.from, '0x00336BF6B66bb0508d54202cA36F38eCeA6066dC');
  assert.equal(p.tx.chainId, 1n);
  assert.equal(p.tx.nonce, BigInt(MAINNET.nonce));
  assert.equal(p.tx.gasLimit, BigInt(MAINNET.gas));
  assert.equal(p.tx.maxFeePerGas, BigInt(MAINNET.maxFeePerGas));
  assert.equal(p.tx.maxPriorityFeePerGas, BigInt(MAINNET.maxPriorityFeePerGas));
  assert.equal(p.tx.to.toLowerCase(), MAINNET.to);
  assert.equal(p.tx.value, BigInt(MAINNET.value));
  assert.equal(p.tx.data.slice(0, 10), MAINNET.inputSelector);
  assert.equal(p.yParity, Number(MAINNET.yParity));
  assert.equal(p.r, BigInt(MAINNET.r));
  assert.equal(p.s, BigInt(MAINNET.s));
  // The parsed fields, hashed again as this wallet would sign them, recover the same sender.
  assert.equal(recoverAddress(signingHash(p.tx), p), p.from);
});

test('signing with the anvil key 0 gives exactly the bytes cast mktx gives', async () => {
  const { sk, address } = await anvil0();
  for (const v of CAST.mktx) {
    const s = signTransaction(castTx(v.tx), sk);
    assert.equal(s.raw, v.raw, v.cmd);
    assert.equal(s.hash, v.hash);
    assert.equal(s.from, address);
    const back = parseSignedTransaction(s.raw);
    assert.equal(back.from, address);
    assert.equal(back.hash, v.hash);
  }
});

test('only mainnet, only with a recipient, and fees that make sense', async () => {
  const { sk } = await anvil0();
  const base = castTx(CAST.mktx[0].tx);
  assert.throws(() => signTransaction({ ...base, chainId: 5n }, sk), TxError);
  assert.throws(() => signTransaction({ ...base, to: undefined }, sk), TxError, 'no contract creation');
  assert.throws(() => signTransaction({ ...base, to: '0x70997970C51812dc3A010C7d01b50e0d17dc79c8' }, sk), TxError, 'bad checksum');
  assert.throws(() => signTransaction({ ...base, maxPriorityFeePerGas: base.maxFeePerGas + 1n }, sk), TxError);
  assert.throws(() => signTransaction({ ...base, gasLimit: 20999n }, sk), TxError);
  assert.throws(() => signTransaction({ ...base, nonce: -1n }, sk), TxError);
  assert.throws(() => signTransaction({ ...base, value: 1n << 256n }, sk), TxError);
  assert.throws(() => parseSignedTransaction('0xf86c' + '00'.repeat(10)), TxError, 'legacy transactions are not read');
  assert.equal(normalizeTx(base).chainId, 1n, 'chain 1 is the default');
});

test('an access list is signed into the transaction', async () => {
  const { sk, address } = await anvil0();
  const t = { ...castTx(CAST.mktx[1].tx), accessList: [{ address: '0xe5acbb03d73267c03349c76ead672ee4d941f499', storageKeys: ['0x' + '00'.repeat(31) + '02'] }] };
  const s = signTransaction(t, sk);
  assert.notEqual(s.hash, CAST.mktx[1].hash);
  const back = parseSignedTransaction(s.raw);
  assert.equal(back.from, address);
  assert.deepEqual(back.tx.accessList, t.accessList);
});

test('EIP-712: the example from the EIP (domain, message, digest, signature)', () => {
  const m = CAST.eip712Mail;
  const td = m.typedData;
  assert.equal(encodeType('Mail', td.types), 'Mail(Person from,Person to,string contents)Person(string name,address wallet)');
  assert.equal(bytesToHex(domainSeparator(td.domain)), m.domainSeparator);
  assert.equal(bytesToHex(hashStruct('Mail', td.message, td.types)), m.messageHash);
  const digest = hashTypedData(td);
  assert.equal(bytesToHex(digest), m.digest);
  // Signed with keccak256("cow"), the EIP's key: the signature recovers to Cow's wallet.
  assert.equal(recoverAddress(digest, parseRsvSignature(m.signature)), td.message.from.wallet);
});

test("Permit2: the domain separator equals Permit2's own DOMAIN_SEPARATOR() on mainnet", () => {
  assert.equal(bytesToHex(permit2DomainSeparator()), CAST.permit2DomainSeparator.value);
  assert.equal(PERMIT2_ADDRESS.toLowerCase(), '0x000000000022d473030f116ddee9f6b43ac78ba3');
});

test('Permit2: the PermitSingle digest, signature and router input match cast', async () => {
  const { sk, address } = await anvil0();
  const p = CAST.permit2.permit;
  assert.equal(bytesToHex(permitSingleDigest(p)), CAST.permit2.digest);
  const sig = signPermitSingle(p, sk);
  assert.equal(bytesToHex(sig), CAST.permit2.signature);
  assert.ok(sig[64] === 27 || sig[64] === 28, 'v is 27/28, last');
  assert.equal(recoverAddress(permitSingleDigest(p), parseRsvSignature(sig)), address);
  assert.equal(bytesToHex(permit2PermitInput(p, sig)), CAST.abiEncode[2].out);
  // The same permit through the generic typed-data path.
  assert.equal(bytesToHex(hashTypedData({ types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }], PermitSingle: [{ name: 'details', type: 'PermitDetails' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }] }, primaryType: 'PermitSingle', domain: { name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS }, message: { details: { token: p.token, amount: p.amount, expiration: p.expiration, nonce: p.nonce }, spender: p.spender, sigDeadline: p.sigDeadline } })), CAST.permit2.digest);
  // The chain is named (PN): Ethereum's signs as before; another chain is refused, never signed as Ethereum.
  assert.equal(bytesToHex(signPermitSingle(p, sk, 1)), CAST.permit2.signature);
  assert.throws(() => signPermitSingle(p, sk, 56), /Ethereum only/);
  // Any change to what is permitted changes the digest.
  assert.notEqual(bytesToHex(permitSingleDigest({ ...p, amount: '12834000001' })), CAST.permit2.digest);
  assert.notEqual(bytesToHex(permitSingleDigest({ ...p, spender: address })), CAST.permit2.digest);
});
