// Payment history as CSV (lib/tx_csv.js): Firo payments, newest first, net change, and a value at
// today's price only when one is known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CSV_HEADER, csvField, csvText, csvDate, buildCsv, csvFileName, typeWords, balanceWords, netChange, fiatAmount, saveCsv } from '../../src/lib/tx_csv.js';

const tx = (txid, extra = {}) => ({ txid, direction: 'in', kind: 'spark', amount: 50000000n, fee: 0n, confirmations: 3, height: 1393000, time: 1760000000, memo: null, counterparty: null, ...extra });

test('the columns', () => {
  assert.deepEqual([...CSV_HEADER], ['Date | Time', 'Type', 'Balance', 'Amount, FIRO', 'Fee, FIRO', 'Net change, FIRO', 'Memo', 'Address', 'Status', 'Block', 'Transaction ID']);
});

test('fields are quoted only when they need it', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a, b'), '"a, b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField(' lead'), '" lead"');
  assert.equal(csvField(null), '');
});

test("dates in this device's time zone", () => {
  const t = 1760184480;
  const d = new Date(t * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  assert.equal(csvDate(t), `${p(d.getDate())} ${mon} ${d.getFullYear()} | ${p(d.getHours())}:${p(d.getMinutes())}`);
});

test('what each payment was, which balance, and what it changed', () => {
  assert.equal(typeWords(tx('1')), 'Received');
  assert.equal(typeWords(tx('1', { direction: 'out' })), 'Sent');
  assert.equal(typeWords(tx('1', { direction: 'self' })), 'Sent to yourself');
  assert.equal(typeWords(tx('1', { kind: 'privatize', direction: 'self' })), 'Privatized');
  assert.equal(typeWords(tx('1', { kind: 'masternode' })), 'Masternode payment');
  assert.equal(typeWords(tx('1', { kind: 'coinbase' })), 'Mining reward');
  assert.equal(typeWords(tx('1', { kind: 'spark-name', direction: 'out' })), 'Spark name registration');
  assert.equal(balanceWords(tx('1')), 'Private');
  assert.equal(balanceWords(tx('1', { kind: 'transparent' })), 'Public');
  assert.equal(balanceWords(tx('1', { kind: 'privatize' })), 'Public → Private');
  assert.equal(netChange(tx('1')), 50000000n);
  assert.equal(netChange(tx('1', { direction: 'out', amount: 40000000n, fee: 20000n })), -40020000n);
  assert.equal(netChange(tx('1', { direction: 'self', kind: 'privatize', amount: 100000000n, fee: 10000n })), -10000n, 'a move inside the wallet costs only its fee');
  assert.equal(netChange(tx('1', { amount: '25000000' })), 25000000n, 'engine strings too');
});

test('a value at a price: exact cents, half up, signed; nothing without a price', () => {
  assert.equal(fiatAmount(50000000n, 1.5), '0.75');
  assert.equal(fiatAmount(-40020000n, 1.234), '-0.49');
  assert.equal(fiatAmount(1n, 1.5), '0.00');
  assert.equal(fiatAmount(250000000000n, 1.5), '3750.00');
  assert.equal(fiatAmount(50000000n, 0), '');
  assert.equal(fiatAmount(50000000n, null), '');
});

test('the file: newest first, memos quoted, a BOM and CRLF; a value column only with a price', () => {
  const txs = [
    tx('old', { time: 1700000000, kind: 'transparent', counterparty: 'aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7' }),
    tx('new', { direction: 'out', amount: 40000000n, fee: 20000n, memo: 'rent, October', time: 1760000000, counterparty: 'sm1abc' }),
    tx('wait', { confirmations: 0, height: null, time: 1750000000, amount: '30000000' }),
  ];
  const text = buildCsv(txs);
  assert.ok(text.startsWith('﻿'), 'UTF-8 byte order mark for Excel');
  assert.ok(text.endsWith('\r\n'));
  const lines = text.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Date | Time,Type,Balance,"Amount, FIRO","Fee, FIRO","Net change, FIRO",Memo,Address,Status,Block,Transaction ID');
  assert.match(lines[1], /^[^,]+,Sent,Private,0\.4,0\.0002,-0\.4002,"rent, October",sm1abc,Confirmed \(3\),1393000,new$/);
  assert.match(lines[2], /^[^,]+,Received,Private,0\.3,0,0\.3,,,Waiting for confirmation,,wait$/, 'no block yet: empty');
  assert.match(lines[3], /^[^,]+,Received,Public,0\.5,0,0\.5,,aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7,Confirmed \(3\),1393000,old$/);
  const priced = buildCsv(txs, { price: { price: 1.5, currency: 'EUR', at: Date.UTC(2026, 9, 12) } }).slice(1).split('\r\n');
  assert.equal(priced[0], 'Date | Time,Type,Balance,"Amount, FIRO","Fee, FIRO","Net change, FIRO","Net change, EUR (price of 2026-10-12)",Memo,Address,Status,Block,Transaction ID');
  assert.match(priced[1], /,-0\.4002,-0\.60,"rent, October",/);
  assert.match(text, /FIRO/);
});

test('file name: the date, and the wallet when there are several', () => {
  const d = new Date(2026, 9, 11);
  assert.equal(csvFileName(d), 'campfire-firo-payments-2026-10-11.csv');
  assert.equal(csvFileName(d, 'My Savings / 2'), 'campfire-firo-payments-My-Savings-2-2026-10-11.csv');
});

test('saveCsv: nothing to save says so, without touching anything', async () => {
  assert.equal(await saveCsv({ wallet: { state: { txs: [] } } }), 'empty');
  assert.equal(await saveCsv(null), 'empty');
});

test('P15: a memo or address a spreadsheet would run as a formula is plain text in the file; amounts stay numbers', () => {
  for (const evil of ['=HYPERLINK("https://x.example","pay")', '+cmd|calc', '-2+3', '@SUM(A1)', '\tx']) assert.equal(csvText(evil), `'${evil}`);
  assert.equal(csvText('thanks for lunch'), 'thanks for lunch');
  assert.equal(csvText(''), '');
  const csv = buildCsv([{ txid: 'ab'.repeat(32), kind: 'spark', direction: 'in', amount: 150000000n, fee: 0n, time: 1760000000, height: 1393000, confirmations: 5, memo: '=HYPERLINK("https://x.example","pay")', counterparty: '@evil' }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""https://x.example"",""pay"")"`), 'the memo, quoted, starts with an apostrophe');
  assert.ok(csv.includes(",'@evil,"), 'the address too');
  assert.ok(!/,=HYPERLINK/.test(csv));
});
