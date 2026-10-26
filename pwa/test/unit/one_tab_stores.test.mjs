// One tab at a time (lib/one_tab.js) at the Spark cache (lib/chain.js tabGuarded): reads always go
// through; a write goes through only while this tab holds the wallet, and is refused, untouched,
// once it let it go or lost it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabGuarded, memoryStore } from '../../src/lib/chain.js';

const tab = (ok) => ({ confirmWrite: async () => ok.value });

test('the Spark cache: writes only while this tab holds the wallet; reads always', async () => {
  const ok = { value: true };
  const inner = memoryStore();
  const s = tabGuarded(inner, tab(ok));
  await s.put('set/1', 'a');
  assert.equal(await s.get('set/1'), 'a');
  ok.value = false;
  await assert.rejects(s.put('set/1', 'stale'), (e) => e.code === 'other_tab');
  await assert.rejects(s.del('set/1'), (e) => e.code === 'other_tab');
  assert.equal(await inner.get('set/1'), 'a', 'nothing was written or deleted');
  assert.deepEqual(await s.keys('set/'), ['set/1']);
});
