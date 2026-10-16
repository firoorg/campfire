import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onMobileData } from '../../src/lib/network.js';

test('Wi-Fi advice only when the browser says mobile data', () => {
  assert.equal(onMobileData({ connection: { type: 'cellular' } }), true);
  assert.equal(onMobileData({ connection: { type: 'wifi', saveData: false } }), false);
  assert.equal(onMobileData({ connection: { type: 'wifi', saveData: true } }), true);
  assert.equal(onMobileData({ connection: { effectiveType: '4g' } }), false);
  // iPhone and desktop browsers do not tell: nothing is assumed.
  assert.equal(onMobileData({}), false);
  assert.equal(onMobileData(undefined), false);
});
