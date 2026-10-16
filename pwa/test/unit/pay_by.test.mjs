// A Buy's deposit address paid from the Ethereum wallet: Send and Review look at its deadline again
// just before signing (audit of 0.1.8, XB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { payByState, payByText, PAY_BY_MARGIN_MS } from '../../src/lib/pay_by.js';
import { BUY_PAY_MARGIN_MS } from '../../src/screens/buy_order.js';

const A = '0xAbC0000000000000000000000000000000000001';

test('past, too soon, or fine; and nothing once the address is another', () => {
  const now = 1_800_000_000_000;
  assert.equal(payByState({ address: A, deadline: now - 1 }, A, now), 'past');
  assert.equal(payByState({ address: A, deadline: now }, A, now), 'past');
  assert.equal(payByState({ address: A, deadline: now + PAY_BY_MARGIN_MS }, A, now), 'soon');
  assert.equal(payByState({ address: A, deadline: now + PAY_BY_MARGIN_MS + 1 }, A, now), null);
  assert.equal(payByState({ address: A, deadline: now - 1 }, ` ${A.toLowerCase()} `, now), 'past', 'the same address, however written');
  assert.equal(payByState({ address: A, deadline: now - 1 }, '0x' + '22'.repeat(20), now), null, 'the person paid someone else');
  assert.equal(payByState(null, A, now), null);
  assert.equal(payByState({ address: A, deadline: null }, A, now), null);
  assert.equal(BUY_PAY_MARGIN_MS, PAY_BY_MARGIN_MS, 'one margin for Buy and for Send');
  assert.match(payByText('past'), /no longer takes payments, so nothing was sent/);
  assert.match(payByText('soon'), /too soon/);
  assert.equal(payByText(null), '');
});
