// Around a payment (lib/payments.js): where to look it up (a link the person taps, never fetched)
// and a memo as it may be shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPLORERS, DEFAULT_EXPLORER, explorerById, txExplorerUrl, addressExplorerUrl, explorerName, cleanMemo, memoBytes, MEMO_MAX } from '../../src/lib/payments.js';

const TX = '2b30e1ab611dbcfb77a5a25edb4f367a77516d4b2415a56a3c3a9498e7493687';

test("explorers: Firo's own (hash route, the default) and Chainz; an unknown choice falls back to the default", () => {
  assert.deepEqual(EXPLORERS.map((e) => e.id), ['firo', 'chainz']);
  assert.equal(DEFAULT_EXPLORER, 'firo');
  assert.equal(txExplorerUrl(TX), `https://explorer.firo.org/#!/tx/${TX}`);
  assert.equal(txExplorerUrl(TX.toUpperCase(), 'chainz'), `https://chainz.cryptoid.info/firo/tx.dws?${TX}.htm`);
  assert.equal(txExplorerUrl(TX, 'nope'), txExplorerUrl(TX));
  assert.equal(explorerById(undefined).id, 'firo');
  assert.equal(explorerName('chainz'), 'Chainz (cryptoID)');
  for (const bad of ['', 'abc', `${TX}0`, `${TX.slice(0, 63)}g`, null]) assert.throws(() => txExplorerUrl(bad), /transaction ID/);
});

test('a public address has a page; a Spark address does not', () => {
  assert.equal(addressExplorerUrl('aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7'), 'https://explorer.firo.org/#!/address/aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7');
  assert.throws(() => addressExplorerUrl(`sm1${'q'.repeat(141)}`));
  assert.throws(() => addressExplorerUrl('javascript:alert(1)'));
});

test('a memo: printable, single-spaced, 31 characters at most', () => {
  assert.equal(MEMO_MAX, 31);
  assert.equal(cleanMemo('  Rent \n share  '), 'Rent share');
  assert.equal(cleanMemo('a‮b\u0000c'), 'a b c');
  assert.equal([...cleanMemo('x'.repeat(99))].length, 31);
  assert.equal(cleanMemo(null), '');
});

test('PN: a memo is counted in bytes, as the Spark library counts it, and cut between characters', () => {
  assert.equal(MEMO_MAX, 31);
  assert.equal(cleanMemo('x'.repeat(40)), 'x'.repeat(31));
  const ru = 'Оплата за квартиру в марте спасибо'; // 2 bytes a letter
  const cut = cleanMemo(ru);
  assert.ok(memoBytes(cut) <= 31, `${memoBytes(cut)} bytes`);
  assert.ok(ru.startsWith(cut), 'a beginning of it, whole letters only');
  assert.equal(memoBytes(cleanMemo('🔥'.repeat(10))), 28, 'seven 4-byte emoji, never a half one');
  assert.equal(memoBytes('é'), 2);
});
