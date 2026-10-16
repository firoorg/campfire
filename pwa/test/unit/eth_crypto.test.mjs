// Ethereum keys and hashing against published vectors: keccak-256, selectors
// and topics, EIP-55, BIP39 (Trezor's vectors), BIP32 (vector 1), the
// m/44'/60'/0'/0/0 addresses every Ethereum wallet agrees on, and the two
// noble 2.x behaviours that would silently produce wrong signatures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { secp256k1 } from '../../src/vendor/noble/noble-curves/secp256k1.js';
import { HDKey } from '../../src/vendor/noble/scure-bip32/index.js';
import { mnemonicToSeedSync, entropyToMnemonic } from '../../src/vendor/noble/scure-bip39/index.js';
import {
  keccak256,
  toChecksumAddress,
  isAddress,
  normAddress,
  privateKeyToAddress,
  signDigest,
  recoverAddress,
  rsvSignature,
  parseRsvSignature,
  newMnemonic,
  normalizeMnemonic,
  mnemonicProblem,
  isValidMnemonic,
  mnemonicToSeed,
  deriveSecretKey,
  ethKeyFromMnemonic,
  ETH_PATH,
  BIP39_ENGLISH,
  EthKeyError,
} from '../../src/lib/eth/crypto.js';
import { selectorHex, eventTopic } from '../../src/lib/eth/abi.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '../../src/lib/eth/hex.js';

const fixture = (n) => JSON.parse(readFileSync(new URL(`./fixtures/eth/${n}`, import.meta.url), 'utf8'));
const TREZOR = fixture('bip39_trezor.json');
const BIP32 = fixture('bip32_vector1.json');
const ALL_LENGTHS = [12, 15, 18, 21, 24];
// Public test phrases: Foundry/Hardhat's default accounts, and BIP39's all-zero entropy.
const JUNK = 'test test test test test test test test test test test junk';
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('keccak256: the empty string and the selectors and topics the bridge and Uniswap use', () => {
  assert.equal(bytesToHex(keccak256(new Uint8Array())), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(bytesToHex(keccak256('')), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  // ERC-20 Transfer (Flutter's kTransferEventSignature) and the bridge's NewLocalMessage (kBridgeNewLocalMessageTopic).
  assert.equal(eventTopic('Transfer(address,address,uint256)'), '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  assert.equal(eventTopic('NewLocalMessage(uint64,uint256,uint256,bytes)'), '0x5f52670be4e2f3d7b079180b485ab44712641a10d1c77e843355f96036608ac7');
  assert.equal(selectorHex('sendFunds(uint256,uint256,bytes)'), '0x4d5dd2bc');
  assert.equal(selectorHex('approve(address,uint256)'), '0x095ea7b3');
  assert.equal(selectorHex('execute(bytes,bytes[],uint256)'), '0x3593564c');
  assert.equal(selectorHex('aggregate3((address,bool,bytes)[])'), '0x82ad56cb');
  assert.equal(selectorHex('transfer(address, uint256)'), '0xa9059cbb', 'spaces are not part of the signature');
});

test('EIP-55: the vectors from the EIP, both ways', () => {
  const vectors = [
    '0x52908400098527886E0F7030069857D2E4169EE7',
    '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
    '0xde709f2102306220921060314715629080e2fb77',
    '0x27b1fdb04752bbc536007a920d24acb045561c26',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ];
  for (const v of vectors) {
    assert.equal(toChecksumAddress(v.toLowerCase()), v);
    assert.equal(toChecksumAddress(v), v);
    assert.ok(isAddress(v));
  }
  assert.equal(toChecksumAddress('0xe5acbb03d73267c03349c76ead672ee4d941f499'), '0xE5AcBB03D73267c03349c76EaD672Ee4d941F499');
  // One flipped letter case breaks the checksum; all-lowercase carries none and is fine.
  assert.equal(isAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), false);
  assert.equal(isAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), true);
  assert.equal(isAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA'), false);
  assert.equal(isAddress('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), false);
  assert.throws(() => normAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), EthKeyError);
  assert.equal(normAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
});

test('BIP39: all 24 English Trezor vectors (entropy → words, words + "TREZOR" → seed → root xprv)', async () => {
  assert.equal(TREZOR.english.length, 24);
  for (const [entropy, words, seed, xprv] of TREZOR.english) {
    assert.equal(entropyToMnemonic(hexToBytes(entropy), BIP39_ENGLISH), words);
    assert.ok(isValidMnemonic(words, ALL_LENGTHS), words);
    const s = await mnemonicToSeed(words, TREZOR.passphrase, ALL_LENGTHS);
    assert.equal(bytesToHex(s, false), seed);
    assert.equal(bytesToHex(mnemonicToSeedSync(words, TREZOR.passphrase), false), seed, 'WebCrypto and pure-JS PBKDF2 agree');
    assert.equal(HDKey.fromMasterSeed(s).privateExtendedKey, xprv);
  }
});

test('BIP32 vector 1: every node of the chain, private and public', () => {
  const seed = hexToBytes(BIP32.seed);
  const root = HDKey.fromMasterSeed(seed);
  for (const n of BIP32.chain) {
    const k = root.derive(n.path);
    assert.equal(k.privateExtendedKey, n.xprv, n.path);
    assert.equal(k.publicExtendedKey, n.xpub, n.path);
    // deriveSecretKey walks the same path, wiping as it goes.
    if (n.path !== 'm') assert.deepEqual(deriveSecretKey(seed, n.path), k.privateKey, n.path);
  }
  assert.throws(() => deriveSecretKey(seed, "m/44'/x"), EthKeyError);
});

test("m/44'/60'/0'/0/0: the addresses every Ethereum wallet derives from the public test phrases", async () => {
  const junk = await ethKeyFromMnemonic(JUNK);
  assert.equal(junk.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(bytesToHex(junk.sk), '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const abandon = await ethKeyFromMnemonic(ABANDON);
  assert.equal(abandon.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.equal(ETH_PATH, "m/44'/60'/0'/0/0");
  // A BIP39 passphrase is a different wallet; typing noise around the words is not.
  const withPass = await ethKeyFromMnemonic(JUNK, 'TREZOR');
  assert.notEqual(withPass.address, junk.address);
  assert.equal((await ethKeyFromMnemonic(`  ${JUNK.toUpperCase().replace(/ /g, '   ')}\n`)).address, junk.address);
});

test('phrases: new ones are valid, wrong ones say why', () => {
  for (const n of [12, 24]) {
    const p = newMnemonic(n);
    assert.equal(p.split(' ').length, n);
    assert.ok(isValidMnemonic(p));
  }
  assert.notEqual(newMnemonic(), newMnemonic());
  assert.throws(() => newMnemonic(15), EthKeyError);
  assert.equal(normalizeMnemonic(' Test\tTEST  junk '), 'test test junk');
  assert.deepEqual(mnemonicProblem('test test test'), { code: 'length', words: 3 });
  assert.deepEqual(mnemonicProblem(JUNK.replace('junk', 'junkk')), { code: 'word', position: 12 });
  assert.deepEqual(mnemonicProblem(JUNK.replace('junk', 'test')), { code: 'checksum' });
  // Every BIP39 length imports (as in MetaMask); only 12 are made here.
  for (const n of ALL_LENGTHS) assert.equal(mnemonicProblem(entropyToMnemonic(new Uint8Array((n / 3) * 4).fill(0x7f), BIP39_ENGLISH)), null, `${n} words`);
  assert.deepEqual(mnemonicProblem(`${JUNK} test`), { code: 'length', words: 13 });
  return assert.rejects(ethKeyFromMnemonic(JUNK.replace('junk', 'test')), (e) => e.code === 'mnemonic');
});

test('noble 2.x trap 1: sign() and recoverPublicKey() pre-hash with SHA-256 unless prehash:false', async () => {
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const digest = keccak256('a digest, not a message');
  const ours = signDigest(digest, sk);
  const raw = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered' });
  const prehashed = secp256k1.sign(digest, sk, { format: 'recovered' }); // the default
  assert.equal(BigInt(bytesToHex(raw.subarray(1, 33))), ours.r);
  assert.notDeepEqual(prehashed, raw, 'the default signs sha256(digest), a different message');
  assert.equal(recoverAddress(digest, ours), address);
  // Recovering with the default would hash again and name a stranger.
  const stranger = secp256k1.recoverPublicKey(raw, digest);
  assert.notEqual(bytesToHex(stranger), bytesToHex(secp256k1.getPublicKey(sk, true)));
});

test("noble 2.x trap 2: the 'recovered' format is [recid, r, s], recovery byte first", async () => {
  const { sk } = await ethKeyFromMnemonic(JUNK);
  const digest = keccak256('order of the bytes');
  const rec = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered' });
  assert.equal(rec.length, 65);
  const ours = signDigest(digest, sk);
  assert.equal(rec[0], ours.yParity);
  assert.equal(BigInt(bytesToHex(rec.subarray(1, 33))), ours.r);
  assert.equal(BigInt(bytesToHex(rec.subarray(33, 65))), ours.s);
  // Ethereum's r‖s‖v puts it last, as 27/28.
  const rsv = rsvSignature(ours);
  assert.equal(rsv[64], 27 + ours.yParity);
  assert.deepEqual(rsv.subarray(0, 64), rec.subarray(1));
  assert.deepEqual(parseRsvSignature(rsv), ours);
});

test('signatures: deterministic, low s, and recovery refuses high s and bad lengths', async () => {
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const digest = keccak256(utf8ToBytes('deterministic'));
  assert.deepEqual(signDigest(digest, sk), signDigest(digest, sk));
  const n = secp256k1.Point.Fn.ORDER;
  for (let i = 0; i < 16; i++) {
    const sig = signDigest(keccak256(`m${i}`), sk);
    assert.ok(sig.s <= n / 2n, 'low s (EIP-2)');
    assert.equal(recoverAddress(keccak256(`m${i}`), sig), address);
  }
  const sig = signDigest(digest, sk);
  assert.throws(() => recoverAddress(digest, { ...sig, s: n - sig.s, yParity: 1 - sig.yParity }), EthKeyError);
  assert.throws(() => signDigest(new Uint8Array(31), sk), EthKeyError);
  assert.throws(() => signDigest(digest, new Uint8Array(32)), EthKeyError, 'the zero key is not a key');
  assert.equal(privateKeyToAddress(sk), address);
});
