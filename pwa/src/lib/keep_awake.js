/* Staying unlocked while received private FIRO is being checked (owner, 2026-10-21: "Private
 * balance 0, +3500 private, shown by the Firo node"). The first check of an old or restored wallet
 * reads every block since Spark began: about half an hour, and only while the wallet is open. The
 * auto-lock (5 minutes without a touch) and a phone's screen going dark both stopped it long before
 * that, so the coins never counted. On the person's tap only: the auto-lock waits and the screen
 * stays on, while the check runs and Firo PWA stays in sight, for at most an hour. Out of sight,
 * Lock, the check done or the hour over: back to the usual rules at once.
 */
import { isOwnServer } from './servers.js';

export const KEEP_AWAKE_MAX_MS = 60 * 60000;
/** Longer than this between two looks (the auto-lock looks every 15 s): the device slept, or froze the page. */
const GAP_MS = 45000;

let held = null; // {until, sentinel, seen}
const listeners = new Set();

function changed() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

/** Whether the auto-lock waits now (only ever while the page is in sight). */
export function keepingAwake(doc = globalThis.document) {
  if (!held) return false;
  const now = Date.now();
  // A sleep or a frozen page that never said "hidden" (0.1.11 audit M1): over, and the usual rules
  // decide, with the time away counted.
  if (now >= held.until || now - held.seen > GAP_MS || (doc && doc.visibilityState !== 'visible')) {
    stopKeepingAwake();
    return false;
  }
  held.seen = now;
  return true;
}

/** Whether the browser keeps the screen on (an iPhone app before iOS 18.4 does not: then not said). */
export function screenKeptOn() {
  return Boolean(held && held.sentinel);
}

export function onKeepAwakeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function askScreen() {
  try {
    const s = await globalThis.navigator?.wakeLock?.request('screen');
    if (!s) return;
    if (held && !held.sentinel) {
      held.sentinel = s;
      changed(); // the note may now say the screen is kept on
    } else s.release().catch(() => {});
  } catch {
    // No wake lock here (or refused): the auto-lock still waits while the page is in sight.
  }
}

export function startKeepingAwake() {
  if (held) return;
  held = { until: Date.now() + KEEP_AWAKE_MAX_MS, sentinel: null, seen: Date.now() };
  askScreen();
  changed();
}

export function stopKeepingAwake() {
  if (!held) return;
  const s = held.sentinel;
  held = null;
  if (s) s.release().catch(() => {});
  changed();
}

/**
 * Wires it once: Lock and the tripwire end it, as does leaving the page's sight (the browser lets
 * go of the screen then anyway), and so does the check being over.
 */
export function installKeepAwake(app, wallet, doc = globalThis.document) {
  app.lockHooks.add(stopKeepingAwake);
  doc?.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') stopKeepingAwake();
  });
  // Over whenever Home's note (and its Stop) would be gone (0.1.11 audit M2): the check done, a node's
  // lists that do not add up, watch-only, or the person's own node.
  wallet.onChange((s) => {
    if (!held) return;
    if (!((s.balance?.private?.checking ?? 0n) > 0n) || s.privateCheck || s.viewOnly || isOwnServer(app.prefs?.server)) stopKeepingAwake();
  });
}
