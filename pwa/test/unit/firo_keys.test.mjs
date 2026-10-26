// Firo keys and addresses against vectors from an independent implementation
// (tools/firo_vectors.py: Python stdlib BIP39/BIP32 + textbook secp256k1) and
// Firo's own Spark library for the Spark key material's addresses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FiroKeys, validateMnemonic, generateMnemonic, mnemonicToSeed, toWif, fromWif, normalizeMnemonic, publicKeyOf } from '../../src/lib/firo/keys.js';
import { NETWORKS, network, bip44Path, sparkKeyPath, isValidSparkName, sparkNameFee, sparkNameMaxYears, sparkSpendTxVersion } from '../../src/lib/firo/params.js';
import { decodeTransparent, addressToScript, scriptToAddress, scriptHash, classifyAddress, isSparkAddressShape, exchangeAddress, p2pkhAddress, pubkeyToAddress } from '../../src/lib/firo/address.js';
import { bytesToHex, hexToBytes, hash160 } from '../../src/lib/firo/bytes.js';

const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const MAIN = NETWORKS.main;
const TEST = NETWORKS.test;

test('the BIP39 reference seed (TREZOR) comes out of mnemonicToSeed', async () => {
  const r = KEYS.bip39_reference;
  assert.equal(bytesToHex(await mnemonicToSeed(r.mnemonic, r.passphrase)), r.seed);
});

for (const v of KEYS.vectors) {
  test(`${v.network} ${v.mnemonic.split(' ').length} words${v.passphrase ? ` + "${v.passphrase}"` : ''}: addresses, keys, WIF, xpub and Spark key match the independent vectors`, async () => {
    const net = network(v.network);
    assert.equal(bytesToHex(await mnemonicToSeed(v.mnemonic, v.passphrase)), v.seed);
    const k = await FiroKeys.fromMnemonic(v.mnemonic, v.passphrase, net);
    assert.equal(k.xpub(), v.accountXpub);
    for (const a of v.addresses) {
      const e = k.address(a.chain, a.index);
      assert.equal(e.path, a.path);
      assert.equal(e.address, a.address);
      assert.equal(bytesToHex(e.pubkey), a.pubkey);
      assert.equal(bytesToHex(k.privateKey(a.chain, a.index)), a.privkey);
      assert.equal(k.wif(a.chain, a.index), a.wif);
      assert.equal(e.scripthash, scriptHash(addressToScript(a.address, net)));
      const w = fromWif(a.wif, net);
      assert.equal(bytesToHex(w.sk), a.privkey);
      assert.equal(w.compressed, true);
    }
    assert.equal(sparkKeyPath(net), v.spark.path);
    assert.equal(bytesToHex(k.sparkKeyMaterial()), v.spark.keyMaterial);
    // The Spark addresses the real library made from this key material have the shape we accept.
    for (const addr of Object.values(v.spark.addresses ?? {})) {
      assert.ok(isSparkAddressShape(addr, net), addr);
      assert.equal(classifyAddress(addr, net).kind, 'spark');
      assert.equal(isSparkAddressShape(addr, net === MAIN ? TEST : MAIN), false);
    }
    // View-only from the xpub derives the same addresses and holds no secrets.
    const vo = FiroKeys.fromXpub(v.accountXpub, net);
    for (const a of v.addresses) assert.equal(vo.address(a.chain, a.index).address, a.address);
    assert.throws(() => vo.privateKey(0, 0), /view-only/);
    assert.throws(() => vo.sparkKeyMaterial(), /no Spark spend key/);
    k.wipe();
    assert.throws(() => k.xpub(), /wiped/);
  });
}

test('mnemonics: generate 12/24 valid words; validate says what is wrong', () => {
  for (const n of [12, 24]) {
    const m = generateMnemonic(n);
    assert.equal(m.split(' ').length, n);
    assert.deepEqual(validateMnemonic(m), { ok: true });
  }
  assert.throws(() => generateMnemonic(18), /12 or 24/);
  assert.equal(validateMnemonic('abandon abandon').code, 'length');
  const w = validateMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzz');
  assert.equal(w.code, 'word');
  assert.equal(w.position, 12);
  assert.equal(validateMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon').code, 'checksum');
  assert.deepEqual(validateMnemonic('  Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT \n'), { ok: true });
  assert.equal(normalizeMnemonic(' A  b\tc '), 'a b c');
});

test('addresses: P2PKH, P2SH and EX decode to their scripts; the other network is refused', () => {
  const v = KEYS.vectors[0].addresses[0];
  const d = decodeTransparent(v.address, MAIN);
  assert.equal(d.type, 'p2pkh');
  assert.equal(bytesToHex(d.hash), bytesToHex(hash160(hexToBytes(v.pubkey))));
  assert.equal(bytesToHex(d.script), `76a914${bytesToHex(d.hash)}88ac`);
  assert.equal(scriptToAddress(d.script, MAIN), v.address);
  assert.throws(() => decodeTransparent(v.address, TEST), /tFiro/);
  // Firo's dev fund addresses from chainparams are P2PKH "a…" addresses.
  assert.equal(decodeTransparent(MAIN.sparkNameFeeAddress, MAIN).type, 'p2pkh');
  assert.equal(decodeTransparent(TEST.sparkNameFeeAddress, TEST).type, 'p2pkh');
  // EX: three version bytes 01 b9 bb, script OP_EXCHANGEADDR + P2PKH, round trip.
  const ex = exchangeAddress(d.hash, MAIN);
  assert.ok(ex.startsWith('EX'), ex);
  const de = decodeTransparent(ex, MAIN);
  assert.equal(de.type, 'exchange');
  assert.equal(bytesToHex(de.script), `e076a914${bytesToHex(d.hash)}88ac`);
  assert.equal(scriptToAddress(de.script, MAIN), ex);
  assert.equal(classifyAddress(ex, MAIN).kind, 'exchange');
  assert.ok(exchangeAddress(d.hash, TEST).startsWith('EXT'));
  assert.throws(() => decodeTransparent(ex, TEST));
  // Checksum errors are caught.
  const bad = v.address.slice(0, -1) + (v.address.endsWith('a') ? 'b' : 'a');
  assert.equal(classifyAddress(bad, MAIN).kind, 'invalid');
});

test('classifyAddress: transparent, Spark, names, junk', () => {
  const v = KEYS.vectors[0];
  assert.deepEqual(classifyAddress(` ${v.addresses[0].address} `, MAIN), { kind: 'transparent', address: v.addresses[0].address });
  const sp = v.spark.addresses['1'];
  assert.deepEqual(classifyAddress(sp.toUpperCase(), MAIN), { kind: 'spark', address: sp });
  // A testnet Spark address on mainnet is refused, not taken for a name.
  assert.equal(classifyAddress(KEYS.vectors[4].spark.addresses['1'], MAIN).kind, 'invalid');
  assert.deepEqual(classifyAddress('@Satoshi', MAIN), { kind: 'spark-name', name: 'Satoshi' });
  assert.deepEqual(classifyAddress('my-name.1', MAIN), { kind: 'spark-name', name: 'my-name.1' });
  assert.equal(classifyAddress('', MAIN).kind, 'invalid');
  assert.equal(classifyAddress('not an address!', MAIN).kind, 'invalid');
  assert.equal(classifyAddress('@' + 'a'.repeat(21), MAIN).kind, 'invalid');
});

test('a corrupted Spark address fails the bech32m checksum', () => {
  const sp = KEYS.vectors[0].spark.addresses['1'];
  const i = 60;
  const bad = sp.slice(0, i) + (sp[i] === 'q' ? 'p' : 'q') + sp.slice(i + 1);
  assert.equal(isSparkAddressShape(bad, MAIN), false);
  assert.notEqual(classifyAddress(bad, MAIN).kind, 'spark');
});

test('WIF refuses the other network and garbage; publicKeyOf is compressed', () => {
  const a = KEYS.vectors[0].addresses[0];
  assert.throws(() => fromWif(a.wif, TEST), /tFiro/);
  assert.throws(() => fromWif('nope', MAIN), /WIF/);
  const sk = hexToBytes(a.privkey);
  assert.equal(toWif(sk, MAIN), a.wif);
  assert.equal(bytesToHex(publicKeyOf(sk)), a.pubkey);
  assert.equal(pubkeyToAddress(publicKeyOf(sk), MAIN), a.address);
  assert.equal(p2pkhAddress(hash160(publicKeyOf(sk)), MAIN), a.address);
});

test('params: paths, name rules and fees, spend versions around the chaum v2 fork', () => {
  assert.equal(bip44Path(MAIN, 1, 7), "m/44'/136'/0'/1/7");
  assert.equal(bip44Path(TEST, 0, 0), "m/44'/1'/0'/0/0");
  assert.ok(isValidSparkName('a'));
  assert.ok(isValidSparkName('A.b-9'));
  assert.ok(!isValidSparkName(''));
  assert.ok(!isValidSparkName('a'.repeat(21)));
  assert.ok(!isValidSparkName('a b'));
  assert.ok(!isValidSparkName('ä'));
  assert.equal(sparkNameFee(MAIN, 'x', 1), 1000n * 100000000n);
  assert.equal(sparkNameFee(MAIN, 'xy', 2), 200n * 100000000n);
  assert.equal(sparkNameFee(MAIN, 'abcde', 1), 10n * 100000000n);
  assert.equal(sparkNameFee(MAIN, 'abcdef', 3), 3n * 100000000n);
  assert.equal(sparkNameMaxYears(MAIN, 1328999), 10);
  assert.equal(sparkNameMaxYears(MAIN, 1329000), 15);
  assert.deepEqual(sparkSpendTxVersion(MAIN, 1370999), { type: 9, version: 0x90003, spendVersion: 1, multiInput: false });
  assert.deepEqual(sparkSpendTxVersion(MAIN, 1371000), { type: 11, version: 0xb0003, spendVersion: 2, multiInput: true });
  assert.equal(sparkSpendTxVersion(TEST, 210800).type, 11);
  assert.throws(() => network('regtest'), /Unknown/);
});

test('PN: a restore takes any BIP39 length: 18 words made by another wallet are a phrase here', async () => {
  const { validateMnemonic, FiroKeys, MNEMONIC_LENGTHS } = await import('../../src/lib/firo/keys.js');
  const { getNetwork } = await import('../../src/lib/firo/params.js').then((m) => ({ getNetwork: m.network }));
  assert.deepEqual(MNEMONIC_LENGTHS, [12, 15, 18, 21, 24]);
  const eighteen = `${'abandon '.repeat(17)}agent`; // BIP39's own vector: 192 bits of zeros
  assert.deepEqual(validateMnemonic(eighteen), { ok: true });
  const keys = await FiroKeys.fromMnemonic(eighteen, '', getNetwork('main'));
  assert.ok(keys);
  assert.match(validateMnemonic('abandon '.repeat(16).trim()).error, /12, 15, 18, 21 or 24 words; this has 16/);
});
