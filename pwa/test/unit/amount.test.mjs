import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, toInputString, toSats, toSatString, firo, AmountError, UNIT, DECIMALS } from '../../src/lib/amount.js';

test('parses whole and decimal FIRO into sats', () => {
  assert.equal(parseAmount('1'), 100000000n);
  assert.equal(parseAmount('1.5'), 150000000n);
  assert.equal(parseAmount('0.00000001'), 1n);
  assert.equal(parseAmount('.5'), 50000000n);
  assert.equal(parseAmount('5.'), 500000000n);
  assert.equal(parseAmount('0.01'), 1000000n);
});

test('no float errors: 0.1 + 0.2 style inputs are exact', () => {
  assert.equal(parseAmount('0.1') + parseAmount('0.2'), parseAmount('0.3'));
  assert.equal(parseAmount('1.23456789'), 123456789n);
  assert.equal(parseAmount('19.99999999'), 1999999999n);
  assert.equal(parseAmount('0.29'), 29000000n); // 0.29 * 1e8 = 28999999.999999996 in floats
});

test('comma is a decimal mark; spaces group digits', () => {
  assert.equal(parseAmount('1,5'), 150000000n);
  assert.equal(parseAmount(' 1 000,25 '), 100025000000n);
  assert.equal(parseAmount('1 000.5'), 100050000000n);
});

test('rejects bad input with a reason', () => {
  for (const [s, code] of [['', 'empty'], ['   ', 'empty'], ['-1', 'negative'], ['1.2.3', 'format'], ['1,2.3', 'format'], ['abc', 'format'], ['1e5', 'format'], ['.', 'format'], ['0.000000001', 'precision'], ['999999999', 'too_large']]) {
    assert.throws(() => parseAmount(s), (e) => e instanceof AmountError && e.code === code, `input ${JSON.stringify(s)}`);
  }
});

test('formats sats for people', () => {
  assert.equal(formatAmount(0n), '0');
  assert.equal(formatAmount(1n), '0.00000001');
  assert.equal(formatAmount(150000000n), '1.5');
  assert.equal(formatAmount(123456789012345n), '1,234,567.89012345');
  assert.equal(formatAmount(123456789012345n, { group: false }), '1234567.89012345');
  assert.equal(formatAmount(100000000n, { minDecimals: 2 }), '1.00');
  assert.equal(firo(10000n), '0.0001 FIRO');
  assert.equal(UNIT, 'FIRO');
  assert.equal(DECIMALS, 8);
  assert.equal(formatAmount(-150000000n), '-1.5');
});

test('rounds when fewer decimals are asked for', () => {
  assert.equal(formatAmount(123456789n, { maxDecimals: 2 }), '1.23');
  assert.equal(formatAmount(129999999n, { maxDecimals: 2 }), '1.3');
  assert.equal(formatAmount(199999999n, { maxDecimals: 0 }), '2');
});

test('round trip through the input field', () => {
  for (const g of [0n, 1n, 99999999n, 100000000n, 2140000000000000n]) assert.equal(parseAmount(toInputString(g)), g);
});

test('engine values: satoshi strings in and out (WALLET_API.md: never JS numbers for amounts)', () => {
  assert.equal(toSats(5), 5n);
  assert.equal(toSats('9007199254740993'), 9007199254740993n);
  assert.equal(toSats('-10000'), -10000n, 'a signed amount from the engine reads as it is');
  assert.equal(toSats(7n), 7n);
  assert.throws(() => toSats(1.5));
  assert.throws(() => toSats('1.5'));
  assert.throws(() => toSats('abc'));
  assert.equal(toSatString(100000n), '100000');
  assert.throws(() => toSatString(-1n));
});

test('PN: "1,000" is asked about, never read as one (or a thousand); a decimal comma still works', () => {
  for (const s of ['1,000', '12,345', '999,999']) assert.throws(() => parseAmount(s), (e) => e instanceof AmountError && e.code === 'ambiguous' && /without the comma, or with a dot/.test(e.message), s);
  assert.match((() => { try { parseAmount('1,000'); } catch (e) { return e.message; } })(), /^Is that 1000 or 1\.000\?/);
  assert.equal(parseAmount('1,5'), 150000000n, 'a decimal comma');
  assert.equal(parseAmount('1,25'), 125000000n);
  assert.equal(parseAmount('0,001'), 100000n, 'nothing to mistake with a leading 0');
  assert.equal(parseAmount('1,0001'), 100010000n);
  assert.equal(parseAmount('1000'), 100000000000n);
});
