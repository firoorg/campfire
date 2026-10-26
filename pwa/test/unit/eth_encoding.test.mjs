// Ethereum encodings: hex, amounts, RLP (the spec's vectors) and the ABI
// codec (against Foundry's cast calldata / abi-encode output).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hexToBytes, bytesToHex, toQuantity, fromQuantity, fromQuantityNumber, bigIntToBytes, toBigInt, utf8ToBytes, HexError } from '../../src/lib/eth/hex.js';
import { parseUnits, formatUnits, toInputString, isRoundedDown, formatGwei, UnitsError, MAX_UINT256 } from '../../src/lib/eth/units.js';
import { rlpEncode, rlpDecode, rlpToBigInt, RlpError } from '../../src/lib/eth/rlp.js';
import { abiEncode, abiDecode, encodeCall, decodeCall, parseType, addressTopic, AbiError } from '../../src/lib/eth/abi.js';

const CAST = JSON.parse(readFileSync(new URL('./fixtures/eth/cast_vectors.json', import.meta.url), 'utf8'));
const hex = (b) => bytesToHex(b);

test('hex: strict both ways', () => {
  assert.deepEqual(hexToBytes('0x00ff10'), Uint8Array.of(0, 255, 16));
  assert.deepEqual(hexToBytes(''), new Uint8Array());
  assert.equal(bytesToHex(Uint8Array.of(1, 171)), '0x01ab');
  assert.throws(() => hexToBytes('0x123'), HexError);
  assert.throws(() => hexToBytes('0xzz'), HexError);
  assert.equal(toQuantity(0), '0x0');
  assert.equal(toQuantity(1024n), '0x400');
  assert.equal(fromQuantity('0x'), 0n, "some nodes say '0x' for zero");
  assert.equal(fromQuantity('0x2d79883d20000'), 800000000000000n);
  assert.throws(() => fromQuantity('12'), HexError);
  assert.throws(() => fromQuantityNumber('0x20000000000000'), HexError);
  assert.deepEqual(bigIntToBytes(0n), new Uint8Array());
  assert.deepEqual(bigIntToBytes(258n, 4), Uint8Array.of(0, 0, 1, 2));
  assert.throws(() => bigIntToBytes(256n, 1), HexError);
  assert.equal(toBigInt('0x10'), 16n);
  assert.throws(() => toBigInt(1.5), HexError);
  assert.throws(() => toBigInt('1e18'), HexError);
});

test('units: exact parsing for 18, 8 and 6 decimals', () => {
  assert.equal(parseUnits('1', 18), 10n ** 18n);
  assert.equal(parseUnits('0.000000000000000001', 18), 1n);
  assert.equal(parseUnits('1,5', 8), 150000000n);
  assert.equal(parseUnits('.5', 6), 500000n);
  assert.equal(parseUnits('1 000.25', 6), 1000250000n);
  assert.equal(parseUnits('256.67540099', 8), 25667540099n);
  for (const [s, code] of [['', 'empty'], ['-1', 'negative'], ['1.2.3', 'format'], ['1e5', 'format'], ['abc', 'format'], ['.', 'format']]) {
    assert.throws(() => parseUnits(s, 18), (e) => e instanceof UnitsError && e.code === code, s);
  }
  assert.throws(() => parseUnits('0.0000001', 6, { symbol: 'USDT' }), (e) => e.code === 'precision' && /USDT has 6 decimal places/.test(e.message));
  assert.equal(parseUnits(MAX_UINT256.toString(), 0), MAX_UINT256);
  assert.throws(() => parseUnits((MAX_UINT256 + 1n).toString(), 0), (e) => e.code === 'too_large');
});

test('units: display rounds down to 8 places; the input form keeps every digit', () => {
  assert.equal(formatUnits(1234567891234567891234n, 18), '1,234.56789123');
  assert.equal(formatUnits(999999999999999999n, 18), '0.99999999', 'never rounded up to 1');
  assert.equal(formatUnits(1n, 18), '0');
  assert.ok(isRoundedDown(1n, 18));
  assert.ok(!isRoundedDown(10n ** 10n, 18));
  assert.ok(!isRoundedDown(1n, 8), '8 decimals are shown in full');
  assert.equal(formatUnits(25667540099n, 8), '256.67540099');
  assert.equal(formatUnits(1500000n, 6, { minDecimals: 2 }), '1.50');
  assert.equal(formatUnits(-1n, 18), '0', 'no "-0"');
  assert.equal(formatUnits(-(10n ** 18n), 18), '-1');
  assert.equal(toInputString(1234567891234567891234n, 18), '1234.567891234567891234');
  assert.equal(parseUnits(toInputString(1234567891234567891234n, 18), 18), 1234567891234567891234n);
  assert.equal(formatGwei(12500000000n), '12.5');
  assert.equal(formatGwei(10000000n), '0.01');
});

test('RLP: the vectors from the RLP specification', () => {
  const v = [
    [utf8ToBytes('dog'), '0x83646f67'],
    [[utf8ToBytes('cat'), utf8ToBytes('dog')], '0xc88363617483646f67'],
    [new Uint8Array(), '0x80'],
    [[], '0xc0'],
    [0, '0x80'],
    [Uint8Array.of(0), '0x00'],
    [Uint8Array.of(15), '0x0f'],
    [15n, '0x0f'],
    [Uint8Array.of(4, 0), '0x820400'],
    [1024, '0x820400'],
    [[[], [[]], [[], [[]]]], '0xc7c0c1c0c3c0c1c0'],
    [utf8ToBytes('Lorem ipsum dolor sit amet, consectetur adipisicing elit'), '0xb8384c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365637465747572206164697069736963696e6720656c6974'],
    // From ethereum/tests rlptest.json: a 33-byte integer and 100,000.
    [1n << 256n, '0xa1010000000000000000000000000000000000000000000000000000000000000000'],
    [100000, '0x830186a0'],
  ];
  for (const [item, want] of v) {
    assert.equal(hex(rlpEncode(item)), want);
    const back = rlpDecode(hexToBytes(want));
    assert.equal(hex(rlpEncode(back)), want, 'decode → encode is the identity');
  }
  assert.equal(rlpToBigInt(rlpDecode(hexToBytes('0x820400'))), 1024n);
  assert.throws(() => rlpEncode('dog'), RlpError, 'strings are refused: hex or text?');
  assert.throws(() => rlpEncode(-1), RlpError);
});

test('RLP: only the canonical encoding decodes', () => {
  for (const bad of [
    '0x8100', // a byte below 0x80 must be its own encoding
    '0xb80100', // long form for a 1-byte string
    '0xb90001' + '00'.repeat(1), // length with a leading zero
    '0x83646f', // truncated
    '0x83646f6700', // trailing byte
    '0xc3836461', // list shorter than its item
    '0xf800', // long list form for an empty list
  ]) assert.throws(() => rlpDecode(hexToBytes(bad)), RlpError, bad);
  assert.throws(() => rlpToBigInt(Uint8Array.of(0, 1)), RlpError, 'integers have no leading zeros');
});

test('ABI: calldata and encodings byte for byte as cast produces them', () => {
  for (const c of CAST.calldata) assert.equal(hex(encodeCall(c.signature, c.args)), c.out, c.cmd);
  for (const c of CAST.abiEncode.filter((x) => x.types)) assert.equal(hex(abiEncode(c.types, c.args)), c.out, c.cmd);
});

test('ABI: decoding gives back what was encoded', () => {
  const [a, b, c, d, e, f, g] = abiDecode('int24,int256,bytes32,bool,uint8[],string,bytes3', CAST.abiEncode[0].out);
  assert.equal(a, -60n);
  assert.equal(b, -1n);
  assert.equal(hex(c), '0x5f52670be4e2f3d7b079180b485ab44712641a10d1c77e843355f96036608ac7');
  assert.equal(d, true);
  assert.deepEqual(e, [1n, 2n, 255n]);
  assert.equal(f, 'WBEAM');
  assert.equal(hex(g), '0x0b060f');
  const [bytesList, tuples] = abiDecode('bytes[],(uint256,bytes)[]', CAST.abiEncode[1].out);
  assert.deepEqual(bytesList.map(hex), ['0x01', '0x']);
  assert.deepEqual(tuples.map(([n, x]) => [n, hex(x)]), [[1n, '0xdeadbeef'], [2n, '0x00']]);
  const [calls] = decodeCall('aggregate3((address,bool,bytes)[])', CAST.calldata[1].out);
  assert.deepEqual(calls.map(([to, ok, data]) => [to, ok, hex(data)]), [
    ['0xE5AcBB03D73267c03349c76EaD672Ee4d941F499', true, '0x313ce567'],
    ['0x000000000022D473030F116dDEE9F6B43aC78BA3', false, '0x'],
  ]);
  assert.throws(() => decodeCall('approve(address,uint256)', CAST.calldata[0].out), AbiError);
});

test('ABI: encoding refuses values that do not fit', () => {
  assert.throws(() => abiEncode('uint8', [256]), AbiError);
  assert.throws(() => abiEncode('uint256', [-1n]), AbiError);
  assert.throws(() => abiEncode('int8', [128]), AbiError);
  assert.throws(() => abiEncode('int8', [-129]), AbiError);
  assert.throws(() => abiEncode('address', ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD']), AbiError, 'bad checksum');
  assert.throws(() => abiEncode('bytes4', ['0x0102']), AbiError);
  assert.throws(() => abiEncode('bool', [1]), AbiError);
  assert.throws(() => abiEncode('uint256,bool', [1]), AbiError);
  assert.throws(() => parseType('uint7'), AbiError);
  assert.throws(() => parseType('bytes33'), AbiError);
  assert.throws(() => parseType('uint256[2]'), AbiError);
  assert.equal(addressTopic('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'), '0x00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8');
});

test('ABI: decoding refuses what a hostile RPC could send', () => {
  const w = (h) => h.padStart(64, '0');
  assert.throws(() => abiDecode('address', '0x' + 'ff' + w('').slice(2, 24) + '70997970c51812dc3a010c7d01b50e0d17dc79c8'), AbiError, 'dirty address padding');
  assert.throws(() => abiDecode('bool', '0x' + w('2')), AbiError);
  assert.throws(() => abiDecode('uint8', '0x' + w('100')), AbiError);
  assert.throws(() => abiDecode('int8', '0x' + w('80')), AbiError, '0x80 is not a sign-extended int8');
  assert.equal(abiDecode('int8', '0x' + 'f'.repeat(62) + '80')[0], -128n);
  assert.throws(() => abiDecode('uint256', '0x' + w('1').slice(2)), AbiError, 'short data');
  assert.throws(() => abiDecode('bytes', '0x' + w('20') + w('ff')), AbiError, 'length beyond the data');
  assert.throws(() => abiDecode('bytes', '0x' + w('1000')), AbiError, 'offset beyond the data');
  assert.throws(() => abiDecode('uint256[]', '0x' + w('20') + w('ffffffff')), AbiError, 'an array longer than the data');
  assert.throws(() => abiDecode('bytes2', '0x' + 'abcd01' + '0'.repeat(58)), AbiError, 'dirty bytesN padding');
  assert.throws(() => abiDecode('bytes', '0x' + w('20') + w('1') + 'ab' + '01'.padEnd(62, '0')), AbiError, 'dirty bytes padding');
});
