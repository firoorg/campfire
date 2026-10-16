// What a scanned code is (lib/scan_recognize.js): Firo addresses and links, Spark names, Ethereum
// (and BNB Chain, which is named, not opened), links and other coins, never opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recognize, weiOf } from '../../src/lib/scan_recognize.js';
import { SPARK, TRANSPARENT, EXCHANGE, ETH_ADDR } from './helpers/firo_samples.mjs';

test('Firo: addresses of every kind, and firo: links with amount and memo', () => {
  assert.deepEqual(recognize(SPARK), { kind: 'firo', address: SPARK, shape: 'spark' });
  assert.deepEqual(recognize(` ${TRANSPARENT} `), { kind: 'firo', address: TRANSPARENT, shape: 'transparent' });
  assert.deepEqual(recognize(EXCHANGE), { kind: 'firo', address: EXCHANGE, shape: 'exchange' });
  assert.deepEqual(recognize(`firo:${TRANSPARENT}?amount=2`), { kind: 'firo', address: TRANSPARENT, shape: 'transparent', amount: '2' });
  assert.deepEqual(recognize(`firo:${SPARK}?amount=0.5&message=Coffee`), { kind: 'firo', address: SPARK, shape: 'spark', amount: '0.5', memo: 'Coffee' });
  assert.deepEqual(recognize(`firo:${TRANSPARENT}?amount=-1`), { kind: 'firo', address: TRANSPARENT, shape: 'transparent' }, 'a bad amount is left out');
  assert.deepEqual(recognize(`${TRANSPARENT}\nsecond line`), { kind: 'firo', address: TRANSPARENT, shape: 'transparent' });
  assert.deepEqual(recognize('firo:not-an-address'), { kind: 'unknown' });
});

test('Spark names: "@alice", also in a firo: link', () => {
  assert.deepEqual(recognize('@Alice'), { kind: 'name', name: 'alice' });
  assert.deepEqual(recognize('firo:@bob'), { kind: 'name', name: 'bob' });
  assert.deepEqual(recognize('alice'), { kind: 'unknown' }, 'a bare word is not a name');
});

test('Ethereum: address, EIP-681 link with value or token; BNB Chain and other chains are named, not opened', () => {
  assert.deepEqual(recognize(ETH_ADDR), { kind: 'eth', to: ETH_ADDR });
  assert.deepEqual(recognize(`ethereum:${ETH_ADDR}?value=1e18`), { kind: 'eth', to: ETH_ADDR, valueWei: '1000000000000000000' });
  assert.deepEqual(recognize(`ethereum:${ETH_ADDR}@1?value=1.5`), { kind: 'eth', to: ETH_ADDR });
  assert.deepEqual(recognize(`ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7/transfer?address=${ETH_ADDR}&uint256=1`), { kind: 'eth', to: ETH_ADDR, token: '0xdac17f958d2ee523a2206206994597c13d831ec7' });
  assert.deepEqual(recognize(`ethereum:${ETH_ADDR}@56?value=1`), { kind: 'unsupported', reason: 'bsc' });
  assert.deepEqual(recognize(`ethereum:${ETH_ADDR}@137`), { kind: 'unsupported', reason: 'chain' });
  assert.deepEqual(recognize(`ethereum:${ETH_ADDR}/approve?x=1`), { kind: 'unknown' });
});

test('links and other coins: unsupported (never followed); anything else unknown; empty', () => {
  assert.deepEqual(recognize('https://example.com/pay'), { kind: 'unsupported', reason: 'link' });
  assert.deepEqual(recognize('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), { kind: 'unsupported', reason: 'coin' });
  assert.deepEqual(recognize('litecoin:ltc1qg82tqdwl2fcqd4kxwvfmq4qxahkfldgl28sdd5'), { kind: 'unsupported', reason: 'coin' });
  assert.deepEqual(recognize('hello world'), { kind: 'unknown' });
  assert.deepEqual(recognize('ABCD-EFGH-JKLM-NPQR'), { kind: 'unknown' });
  assert.deepEqual(recognize('   '), { kind: 'empty' });
  assert.deepEqual(recognize(null), { kind: 'empty' });
});

test('wei: whole numbers only, scientific notation as EIP-681 writes it', () => {
  assert.equal(weiOf('1000'), '1000');
  assert.equal(weiOf('2.014e18'), '2014000000000000000');
  assert.equal(weiOf('1.5'), null);
  assert.equal(weiOf('1.50e1'), '15');
  assert.equal(weiOf('0'), null);
  assert.equal(weiOf('-1'), null);
});

test('PN: a scanned firo: link with an unknown req- parameter is named as such, not opened', () => {
  assert.deepEqual(recognize(`firo:${TRANSPARENT}?amount=1&req-escrow=1`), { kind: 'unsupported', reason: 'requires', what: ['req-escrow'] });
});
