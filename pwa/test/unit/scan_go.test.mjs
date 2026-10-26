// Home's Scan: where each kind of code goes (screens/scan_go.js destination), never a payment by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { destination } from '../../src/screens/scan_go.js';
import { recognize } from '../../src/lib/scan_recognize.js';
import { TOKENS } from '../../src/lib/eth/tokens.js';
import { SPARK, TRANSPARENT, ETH_ADDR } from './helpers/firo_samples.mjs';

const yes = async () => true;
const no = async () => false;

test('a Firo address, a firo: link with amount and memo, and a Spark name: Send, filled', async () => {
  assert.deepEqual(await destination(recognize(`firo:${TRANSPARENT}?amount=2`)), { to: 'send', draft: { address: TRANSPARENT, amount: '2', memo: '' } });
  assert.deepEqual(await destination(recognize(`firo:${SPARK}?amount=0.1&memo=Hi`)), { to: 'send', draft: { address: SPARK, amount: '0.1', memo: 'Hi' } });
  assert.deepEqual(await destination(recognize(SPARK)), { to: 'send', draft: { address: SPARK, amount: '', memo: '' } });
  assert.deepEqual(await destination(recognize('@Alice')), { to: 'send', draft: { address: '@alice', amount: '', memo: '' } });
});

test('Ethereum: its Send with the recipient (and value), a known token, or a way to add the wallet', async () => {
  const tok = TOKENS[0];
  assert.deepEqual(await destination(recognize(`ethereum:${ETH_ADDR}?value=1e18`), { hasEth: yes, tokens: TOKENS }), { to: 'ethSend', draft: { to: ETH_ADDR, amountWei: '1000000000000000000', symbol: 'ETH' } });
  assert.deepEqual(await destination(recognize(ETH_ADDR), { hasEth: no }), { sheet: 'noEth' });
  assert.deepEqual(await destination(recognize(`ethereum:${tok.address}/transfer?address=${ETH_ADDR}&uint256=100`), { hasEth: yes, tokens: TOKENS }), { to: 'ethSend', draft: { to: ETH_ADDR, amount: '', symbol: tok.symbol } });
  assert.deepEqual(await destination(recognize(`ethereum:0x1111111111111111111111111111111111111111/transfer?address=${ETH_ADDR}`), { hasEth: yes, tokens: TOKENS }), { sheet: 'token' });
});

test('BNB Chain, links, other coins and anything else: shown, never opened', async () => {
  assert.deepEqual(await destination(recognize(`ethereum:${ETH_ADDR}@56`)), { sheet: 'bsc' });
  assert.deepEqual(await destination(recognize('https://example.com')), { sheet: 'link' });
  assert.deepEqual(await destination(recognize('bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')), { sheet: 'coin' });
  assert.deepEqual(await destination(recognize('hello world')), { sheet: 'unknown' });
});
