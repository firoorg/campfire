// SPDX-License-Identifier: MIT
// Auto-lock's decision (app.js runs it on its timers): lock now, look again in a few seconds, or stay
// unlocked. No dependencies: the unit tests drive it (test/unit/auto_lock.test.mjs).

/** A payment going out holds a due lock back at most this long (release re-audit R1-5). */
export const IN_FLIGHT_CAP_MS = 2 * 60 * 1000;
/** How often a held-back lock is looked at again. */
export const IN_FLIGHT_RETRY_MS = 3000;

/**
 * due: the chosen minutes without use (or out of sight) have passed, or a lock is owed from coming
 * back after as long away. inFlight: a payment is between send() and the end of its broadcast
 * (audit FE-4: a lock then cut its record short). The lock waits for it, but not for ever (R1-5: a
 * payment that never settled kept the wallet's secret and engine in memory in a background tab
 * indefinitely): from waitingSince, after capMs it locks anyway. Safe now: a payment locked while it
 * is built is "not sent"; once written down it is followed at the next unlock.
 * -> 'lock' | 'wait' | 'stay'
 */
export function lockStep({ due, inFlight, waitingSince = null, now, capMs = IN_FLIGHT_CAP_MS }) {
  if (!due) return 'stay';
  if (!inFlight) return 'lock';
  return waitingSince !== null && now - waitingSince >= capMs ? 'lock' : 'wait';
}

/**
 * Waits while underWay() says a payment is between being written down and the end of its broadcast,
 * for at most capMs: a lock the person asked for lets it finish first (audit of 0.1.8). -> true when it
 * finished, false at the cap.
 */
export async function waitForPayment(underWay, { capMs = IN_FLIGHT_CAP_MS, stepMs = 500, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = now();
  while (underWay()) {
    if (now() - t0 >= capMs) return false;
    await sleep(stepMs);
  }
  return true;
}

