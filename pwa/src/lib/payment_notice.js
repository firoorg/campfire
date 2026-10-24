// Which incoming payments are news, and when a run's payments start being news. Pure. What is
// told and how: lib/notify_rules.js and lib/notify.js.
//
// Rules:
//   - only a payment that came IN to this wallet from someone else (direction 'in', an amount above
//     0): received privately (Spark) or publicly, a mining or masternode reward. Never the wallet's
//     own sends, a payment to itself, privatizing, or Lelantus coins moving over to Spark;
//   - the first read of the payment list in a session is history, not news: it is recorded and
//     nothing is announced;
//   - what turns up before the wallet has caught up once in this run is history too: a restore or
//     a rescan finds past payments as it reads the blockchain, and a payment made while the app
//     was closed is found the same way after an unlock. So news starts once the wallet is Synced,
//     and CATCH_UP_GRACE_MS after that (catchUp below); from then on it stays on for the run;
//   - each payment once (lib/notify_rules.js txWatcher).
//
// There is no server: nothing watches the wallet while Campfire is closed (lib/notify.js says
// what is done instead).
import { t } from './i18n.js';

const NEWS_KINDS = new Set(['spark', 'transparent', 'coinbase', 'masternode']);

/** An incoming payment worth announcing (pending or confirmed). */
export function isNews(tx) {
  if (!tx || tx.direction !== 'in' || !NEWS_KINDS.has(tx.kind)) return false;
  try {
    return BigInt(tx.amount ?? 0) > 0n;
  } catch {
    return false;
  }
}

export const CATCH_UP_GRACE_MS = 10000;

/** The wallet is up to date with the network (the engine's sync finished, the tip is fresh). */
export function settled(s) {
  return Boolean(s && s.running && s.sync && s.sync.state === 'synced');
}

/**
 * When a run has caught up: live(s, now) is false until the wallet has first been settled for
 * CATCH_UP_GRACE_MS, then true for the rest of the run (a new block or a reconnect does not turn
 * it off again, so a payment arriving then is still news). reset() for a new run.
 */
export function catchUp(graceMs = CATCH_UP_GRACE_MS) {
  let since = null;
  return {
    reset() {
      since = null;
    },
    live(s, now = Date.now()) {
      if (since === null && settled(s)) since = now;
      return since !== null && now - since >= graceMs;
    },
  };
}

// ---------------------------------------------------------------- the browser's notifications

/** 'granted' | 'denied' | 'default' | 'unsupported' (no Notification API here: an iPhone's Safari tab, an old browser). */
export function notificationPermission(win = globalThis) {
  const N = win && win.Notification;
  if (typeof N !== 'function' || typeof N.requestPermission !== 'function') return 'unsupported';
  return ['granted', 'denied', 'default'].includes(N.permission) ? N.permission : 'default';
}

export function isIos(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  // iPadOS reports a Mac; it has touch.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
}

export function isStandalone(win = globalThis) {
  try {
    return Boolean((win.navigator && win.navigator.standalone) || (win.matchMedia && win.matchMedia('(display-mode: standalone)') /* i18n-ignore: a media query */.matches));
  } catch {
    return false;
  }
}
