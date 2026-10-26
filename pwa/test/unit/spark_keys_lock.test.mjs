// Lock drops the Spark full view keys the page's one Spark client derived (public audit, PN-keys):
// that client outlives a wallet's engine, and a full view key shows every private payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptSparkClient } from '../../src/lib/firo/spark_adapter.js';

test('the adapter derives a view key once per key, and forgets them on forgetKeys (the engine calls it on close)', async () => {
  let derived = 0;
  const client = {
    ready: Promise.resolve(),
    getFullViewKey: async () => (derived++, 'ab'.repeat(32)),
    identifyCoins: async () => ({ found: [] }),
    close: async () => {},
  };
  const spark = adaptSparkClient(client);
  const keyData = new Uint8Array(32).fill(7);
  await spark.identifyCoins({ keyData, index: 1, isTestNet: false, coins: [] });
  await spark.identifyCoins({ keyData, index: 1, isTestNet: false, coins: [] });
  assert.equal(derived, 1, 'kept between batches of one session');
  spark.forgetKeys();
  await spark.identifyCoins({ keyData, index: 1, isTestNet: false, coins: [] });
  assert.equal(derived, 2, 'forgotten: derived again after the next unlock');
});
