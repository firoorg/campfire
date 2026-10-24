// Auto-lock and a payment going out (app.js, lib/auto_lock.js): the lock waits for the payment's
// record and broadcast (audit FE-4), but not for ever (release re-audit R1-5: a payment that never
// settled kept the wallet's secret and engine in memory in a background tab indefinitely).
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockStep, IN_FLIGHT_CAP_MS } from '../../src/lib/auto_lock.js';

test('release re-audit R1-5: a due lock waits for a payment going out, at most two minutes', () => {
  assert.equal(IN_FLIGHT_CAP_MS, 120000);
  const at = 1_000_000;
  assert.equal(lockStep({ due: false, inFlight: true, waitingSince: null, now: at }), 'stay');
  assert.equal(lockStep({ due: false, inFlight: false, waitingSince: null, now: at }), 'stay');
  assert.equal(lockStep({ due: true, inFlight: false, waitingSince: null, now: at }), 'lock');
  assert.equal(lockStep({ due: true, inFlight: true, waitingSince: null, now: at }), 'wait', 'the payment is written down and broadcast first');
  assert.equal(lockStep({ due: true, inFlight: true, waitingSince: at, now: at + IN_FLIGHT_CAP_MS - 1 }), 'wait');
  assert.equal(lockStep({ due: true, inFlight: true, waitingSince: at, now: at + IN_FLIGHT_CAP_MS }), 'lock', 'a payment that never settles does not keep the wallet open');
  assert.equal(lockStep({ due: true, inFlight: false, waitingSince: at, now: at + 5000 }), 'lock', 'the payment is through: locked at once');
});

test('release re-audit R1-5: app.js no longer skips a lock owed on return while a payment is going out', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/app.js', import.meta.url), 'utf8');
  // The return from the background: due and a payment under way is owed, not dropped by touch().
  assert.match(src, /lockOwed = true;/);
  assert.match(src, /lockStep\(/);
  assert.doesNotMatch(src, />= app\.autoLockMs\(\) && app\.lockAllowedNow\(\)\) app\.lock\('timeout'\);/, 'the old check that dropped the lock');
});

test('a lock the person asked for waits for a payment under way, at most the cap', async () => {
  const { waitForPayment } = await import('../../src/lib/auto_lock.js');
  let t = 0;
  let under = 3;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; under -= 1; } };
  assert.equal(await waitForPayment(() => under > 0, { capMs: 10000, stepMs: 500, ...clock }), true, 'it finished: then the lock');
  assert.equal(t, 1500);
  t = 0;
  assert.equal(await waitForPayment(() => true, { capMs: 2000, stepMs: 500, ...clock }), false, 'never ends: the lock goes ahead at the cap');
  assert.equal(t, 2000);
  assert.equal(await waitForPayment(() => false, clock), true, 'nothing under way: at once');
});
