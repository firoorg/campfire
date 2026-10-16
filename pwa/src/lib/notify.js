// Notifications, on this device only (the rules: lib/notify_rules.js).
//
//   - While Campfire runs: every change in the open wallet's payment list worth telling is a
//     banner inside the app when the app is on screen, and a system notification when it is not
//     in front (in the background until the app locks itself; on a computer, another window in
//     front).
//   - When the person leaves the app: the payment list's states are kept ('w:<id>:notify-snapshot',
//     sealed under the wallet's secret: which txids are this wallet's is its private history) for
//     the summary on return, and reminders for later are stored on the device
//     ('w:<id>:notify-reminders' in the app's own store, in the clear for the service worker, so
//     they name nothing: "A deposit address closes soon"). Both go when the wallet is deleted. A
//     Firo payment needs nothing from the app once sent, so nothing about payments is said on
//     leaving.
//   - Later, with the app closed, only when the person turned "Reminders when Campfire is closed"
//     on (prefs.notify.wakeUps): the service worker (sw.js) shows the reminders that are due when
//     the browser wakes it (Periodic Background Sync: Chrome / Edge, an installed app). Off by
//     default, because each wake-up is also a moment the browser checks the loader for new bytes
//     while no Campfire page is open to notice a change it did not sign (lib/loader.js). While the
//     page itself still runs in the background, it shows them on time. iPhone runs no web app in
//     the background: there notifications come while the app is open, and Home says what happened
//     while it was not.
//   - Back in the app: the app badge is cleared and Home says what happened while away.
//   - A tap on a notification opens the app at the payment or screen it names (#open=…; sw.js).
//
// Nothing is sent anywhere: no server, no push service. The browser shows what the app tells it.

import { wallet } from './wallet.js';
import { rawStore } from './store.js';
import { walletKey } from './wallet_scope.js';
import { listWallets, nameOf } from './wallets.js';
import { catchUp, notificationPermission } from './payment_notice.js';
import { txWatcher, wordsFor, settingsOf, remindersFor, dueReminders, awaySummary, snapshotOf, awayLine, NEAR_NOTICE_MS } from './notify_rules.js';
import { randomBytes, b64, unb64 } from './envelope.js';
import { oneTab } from './one_tab.js';

export const SYNC_TAG = 'campfire-reminders';
const ICON = 'icons/icon-192.png';
const remindersKey = (app) => walletKey(app, 'notify-reminders');
const snapshotKey = (app) => walletKey(app, 'notify-snapshot');

// What was told in this page's life (counts only, for the tests).
const stats = { banners: 0, system: 0, failed: 0, reminders: 0, badge: 0 };
export const notifyStats = () => ({ ...stats });

let bannerFn = null; // screens/payment_notices.js showBanner (the banner over any screen)
// The open wallet's unpaid NEAR swaps, once a screen has read them in this run; null: not read,
// so the reminders stored for them earlier are kept as they are.
let near = null;
let timers = new Map(); // reminder id -> timeout, while the page runs in the background
let unseen = 0;
let appRef = null;

/** The banner inside the app (screens/payment_notices.js draws it). */
export function setBanner(fn) {
  bannerFn = fn;
}

/** screens/near_intents*.js: unpaid swaps and when their deposit addresses stop taking coins. */
export function rememberNearSwaps(list) {
  near = (list || [])
    .filter((s) => s && s.quote && s.quote.sendBefore && (s.lastState == null || s.lastState === 'PENDING_DEPOSIT'))
    .map((s) => ({ id: String(s.quote.depositAddress || s.createdAt), symbol: s.origin.symbol, sendBefore: s.quote.sendBefore }));
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
/** In front: on screen, and (on a computer) its window has the focus. */
const inFront = () => visible() && (typeof document.hasFocus !== 'function' || document.hasFocus());

async function walletName(app) {
  try {
    return (await listWallets()).length > 1 ? nameOf(app.record) : null;
  } catch {
    return null;
  }
}

/** The system notification: through the service worker (sw.js opens the app at `url` on a tap); a page Notification otherwise. */
export async function showSystem({ title, body, tag, url }) {
  const opts = { body, tag: `campfire-${tag}`, icon: ICON, lang: 'en', data: { url: url || '#open=home' } };
  try {
    const reg = typeof navigator !== 'undefined' && navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, opts);
      stats.system++;
      return true;
    }
  } catch {
    /* the page's own, below */
  }
  try {
    const n = new Notification(title, opts);
    n.addEventListener('click', () => {
      try {
        window.focus();
      } catch {
        /* nothing to focus */
      }
      openTarget(opts.data.url);
      n.close();
    });
    stats.system++;
    return true;
  } catch {
    stats.failed++;
    return false;
  }
}

function badge(n) {
  stats.badge = n;
  try {
    if (n > 0 && typeof navigator.setAppBadge === 'function') navigator.setAppBadge(n).catch(() => {});
    else if (n === 0 && typeof navigator.clearAppBadge === 'function') navigator.clearAppBadge().catch(() => {});
  } catch {
    /* no badge here */
  }
}

/** Whether a system notification of this kind may be shown. */
export function allowed(app, kind) {
  const s = settingsOf(app.prefs);
  return s.on && s.kinds[kind] !== false && notificationPermission() === 'granted';
}

/**
 * One event: the banner while the app is on screen (with the amount: the open wallet shows it
 * anyway); a system notification while it is not in front, with the amount only if the person
 * turned that on (it shows on the lock screen).
 */
export async function tell(app, ev, { banner = true } = {}) {
  const s = settingsOf(app.prefs);
  const name = await walletName(app);
  if (visible() && banner && bannerFn) {
    const b = wordsFor(ev, { amounts: true, walletName: name });
    bannerFn(app, b.title, b.body, b.url);
    stats.banners++;
  }
  if (inFront() || !allowed(app, ev.kind)) return false;
  const ok = await showSystem(wordsFor(ev, { amounts: s.amounts, walletName: name }));
  if (ok) badge(++unseen);
  return ok;
}

/**
 * What the app's other parts tell (not a Firo payment): a NEAR Intents swap done, a buy paid.
 * kind: one of KINDS; plainBody: body without amounts; banner: also the banner when on screen.
 */
export function tellOther(app, { kind, title, body, plainBody = null, tag, url = '#open=home', banner = false }) {
  return tell(app, { kind, type: 'free', title, body, plainBody, tag, url }, { banner });
}

// ---------------------------------------------------------------- where a tap opens

const OPENABLE = new Set(['home', 'activity', 'nearIntents', 'buyOrders', 'settings', 'notifications']);

/** "#open=activity&tx=…" -> { screen, params: {txid} }. Only the app's own screens; anything else is ignored. */
export function parseOpen(url) {
  const m = /^#open=([a-zA-Z]+)(?:&tx=([0-9a-f]{1,128}))?$/.exec(String(url || ''));
  if (!m || !OPENABLE.has(m[1])) return null;
  return { screen: m[1], params: m[2] ? { txid: m[2] } : {} };
}

/** Opens what a tap asked for: now when a wallet is open, else right after the unlock (screens/unlock.js). */
function openTarget(url) {
  const t = parseOpen(url);
  if (!t || !appRef) return;
  if (appRef.dbPass) return appRef.go(t.screen, t.params);
  appRef.afterUnlock = { name: t.screen, params: t.params, lead: 'Unlock to see what the notification was about. ', note: 'Firo PWA opens it once the wallet is open.' };
  if (appRef.currentName === 'unlock') appRef.go('unlock'); // shows the line saying so
}

// ---------------------------------------------------------------- reminders for later

async function readReminders(app) {
  try {
    return (await rawStore.get(remindersKey(app))) || [];
  } catch {
    return [];
  }
}

/** Replace this wallet's reminders, keeping those for swaps no screen read in this run. */
async function leaveReminders(app) {
  if (!app.record) return [];
  const before = await readReminders(app);
  const now = Date.now();
  const fresh = remindersFor({ nearSwaps: near || [], now });
  const carried = before.filter((r) => r && r.at > now && near === null && r.id.startsWith('rem-near-'));
  const mine = [...fresh, ...carried].filter((r) => allowed(app, r.kind));
  try {
    await rawStore.set(remindersKey(app), mine);
  } catch {
    /* kept in this page only */
  }
  if (mine.length) await askForWakeUps(app);
  return mine;
}

/** Whether the person turned on reminders while Campfire is closed (Settings -> Notifications). Off by default. */
export const wakeUpsOn = (prefs) => Boolean(prefs && prefs.notify && prefs.notify.wakeUps === true);
/** Wake-ups are asked for only with that switch and notifications both on. */
const wakeUpsWanted = (prefs) => wakeUpsOn(prefs) && settingsOf(prefs).on;

/** Whether this browser can wake an installed app for them (Periodic Background Sync: Chrome / Edge). */
export function wakeUpsSupported() {
  return typeof window !== 'undefined' && 'PeriodicSyncManager' in window && typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker);
}

/** Periodic Background Sync, only when turned on: sw.js shows due reminders when woken. */
async function askForWakeUps(app) {
  if (!wakeUpsWanted(app && app.prefs)) return dropWakeUps();
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.periodicSync) return false;
    if (navigator.permissions) {
      const st = await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => null);
      if (st && st.state === 'denied') return false;
    }
    await reg.periodicSync.register(SYNC_TAG, { minInterval: 15 * 60 * 1000 });
    return true;
  } catch {
    return false;
  }
}

/** No more wake-ups (turned off, or never turned on: an earlier release asked for them by itself). */
async function dropWakeUps() {
  try {
    const reg = typeof navigator !== 'undefined' && navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.periodicSync) await reg.periodicSync.unregister(SYNC_TAG);
  } catch {
    /* none asked for */
  }
  return false;
}

/** Settings -> Notifications: after "Reminders when Campfire is closed" or the main switch changed (and was saved). */
export function applyWakeUps(app) {
  return askForWakeUps(app);
}

function clearTimers() {
  for (const t of timers.values()) clearTimeout(t);
  timers = new Map();
}

/** While the page still runs in the background: each reminder on time, then forgotten. */
function armTimers(app, list) {
  clearTimers();
  for (const r of list) {
    const ms = r.at - Date.now();
    if (ms < 0 || ms > 2 ** 31 - 1) continue;
    timers.set(
      r.id,
      setTimeout(async () => {
        timers.delete(r.id);
        if (inFront() || !allowed(app, r.kind)) return;
        if (!(await showSystem({ title: r.title, body: r.body, tag: r.id, url: r.url }))) return;
        stats.reminders++;
        badge(++unseen);
        try {
          await rawStore.set(remindersKey(app), (await readReminders(app)).filter((x) => x && x.id !== r.id));
        } catch {
          /* sw.js drops it once due */
        }
      }, ms),
    );
  }
}

/** Back in the app: due reminders go (anything else a reminder kind no longer covers, too). */
async function dropOnReturn(app) {
  if (!app.record) return;
  try {
    const { keep } = dueReminders(await readReminders(app));
    await rawStore.set(remindersKey(app), keep.filter((r) => r && typeof r.id === 'string' && r.id.startsWith('rem-near-')));
  } catch {
    /* nothing kept */
  }
}

/** Turned off: nothing stored for later is shown. */
export async function forgetReminders(app) {
  clearTimers();
  try {
    if (app.record) await rawStore.set(remindersKey(app), []);
  } catch {
    /* none kept */
  }
}

// ---------------------------------------------------------------- what happened while away

let away = null;
/** Home's line: what happened while the person was away, for the open wallet; null when nothing did. */
export const awayNow = () => away;
export function dismissAway() {
  away = null;
}

// The snapshot, sealed: AES-256-GCM under a key made with HKDF-SHA256 from the wallet's secret
// (app.dbPass, 32 random bytes), its own info string, a random salt and IV; the header and the
// wallet id are additional data, so a copy moved to another wallet or edited does not open.
export const NOTIFY_INFO = 'campfire-firo-notify-v1';
const SNAP_KIND = 'notify-snapshot';
const enc = new TextEncoder();
const dec = new TextDecoder();
const snapAad = (env) => enc.encode(JSON.stringify([env.v, env.kind, env.walletId, env.salt]));

async function snapKey(dbPass, salt) {
  const raw = Uint8Array.from(dbPass.match(/../g), (x) => parseInt(x, 16));
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(NOTIFY_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** {at, txs} sealed for wallet `walletId` under its secret `dbPass` (64 hex). */
export async function sealSnapshot(dbPass, walletId, snap) {
  const salt = randomBytes(16);
  const env = { v: 1, kind: SNAP_KIND, walletId, salt: b64(salt) };
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: snapAad(env) }, await snapKey(dbPass, salt), enc.encode(JSON.stringify(snap)));
  return { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

/** The snapshot back, or null (none, locked, another wallet's, edited). One an earlier version kept in the clear is read as it is. */
export async function openSnapshot(dbPass, walletId, env) {
  if (!env || typeof env !== 'object') return null;
  if (env.txs && typeof env.txs === 'object' && env.kind === undefined) return env;
  if (env.v !== 1 || env.kind !== SNAP_KIND || env.walletId !== walletId || typeof dbPass !== 'string' || !/^[0-9a-f]{64}$/.test(dbPass)) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: snapAad(env) }, await snapKey(dbPass, unb64(env.salt)), unb64(env.ct));
    const v = JSON.parse(dec.decode(pt));
    return v && v.txs ? v : null;
  } catch {
    return null;
  }
}

async function saveSnapshot(app) {
  try {
    if (!app.dbPass || !app.record) return;
    const key = snapshotKey(app);
    await rawStore.set(key, await sealSnapshot(app.dbPass, app.record.id, { at: Date.now(), txs: snapshotOf(wallet.state.txs) }));
  } catch {
    /* no summary next time */
  }
}

async function readSnapshot(app) {
  try {
    return await openSnapshot(app.dbPass, app.record && app.record.id, await rawStore.get(snapshotKey(app)));
  } catch {
    return null;
  }
}

/**
 * At start: what an earlier version left in the clear goes. Snapshots that name txids (it seals
 * them now), and reminders that named the coin, the deposit address and the wallet (rewritten
 * with words that name nothing, at the same times).
 */
export async function forgetPlainNotes(kv = rawStore) {
  let changed = 0;
  for (const k of await kv.keys('w:')) {
    if (/^w:[0-9a-f]{16}:notify-snapshot$/.test(k)) {
      const v = await kv.get(k);
      if (v && v.txs) {
        await kv.del(k);
        changed++;
      }
    } else if (/^w:[0-9a-f]{16}:notify-reminders$/.test(k)) {
      const list = await kv.get(k);
      if (!Array.isArray(list)) continue;
      const generic = remindersFor({ nearSwaps: list.filter((r) => r && typeof r.id === 'string' && r.id.startsWith('rem-near-') && Number.isFinite(r.at)).map((r) => ({ sendBefore: r.at + NEAR_NOTICE_MS })), now: -Infinity });
      if (JSON.stringify(generic) !== JSON.stringify(list)) {
        await kv.set(k, generic);
        changed++;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------- wiring

export function installNotify(app) {
  appRef = app;
  // Start-up tidying that touches the app's store: only in the tab that holds the wallet
  // (lib/one_tab.js), once it does; a second tab opens no storage at all.
  oneTab().whenHeld(() => {
    // An earlier release asked for wake-ups by itself; now only the switch does.
    rawStore
      .get('prefs')
      .then((p) => (wakeUpsWanted(p) ? null : dropWakeUps()))
      .catch(() => {});
    if (typeof indexedDB !== 'undefined') forgetPlainNotes().catch(() => {});
  });
  const watch = txWatcher();
  const run = catchUp();
  let summarised = false;
  let runOf = null; // which wallet the watcher's history is about

  wallet.onChange(async (s) => {
    // Stopped (locked, another wallet): the next run starts over; its swaps are its own.
    const id = wallet.run ? wallet.run.walletId : null;
    if (!s.running || id !== runOf) {
      watch.reset();
      run.reset();
      summarised = false;
      near = null;
      away = null;
      runOf = s.running ? id : null;
      if (!s.running) return;
    }
    // Locked: nothing is told (the lock stops the wallet anyway).
    if (!app.dbPass) return;
    const live = run.live(s);
    // Caught up: what happened while away, against the states saved when the person last left.
    if (live && !summarised && s.txsLoaded === true) {
      summarised = true;
      const snap = await readSnapshot(app);
      // On Home, in the open wallet: with the amounts.
      const line = snap ? awayLine(awaySummary(snap, s.txs), { amounts: true }) : null;
      saveSnapshot(app);
      dropOnReturn(app);
      if (line) {
        away = line;
        wallet.emit();
      }
    }
    // News only while the wallet is in step: a rescan reading old payments says nothing.
    const events = watch.update(s.txs, s.txsLoaded === true, live && s.sync && s.sync.state === 'synced');
    if (!events.length) return;
    // In the app, the banner tells what the person did not do themselves (money in); what they sent
    // has its own status screen. Out of it, each is a notification, and many at once are one.
    if (events.length > 3 && !inFront()) {
      tell(app, { kind: 'in', type: 'several', title: `${events.length} changes in your wallet`, count: events.length }, { banner: false });
      return;
    }
    for (const ev of events) tell(app, ev, { banner: ev.type === 'incoming' || ev.type === 'received' });
  });

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', async () => {
      if (visible()) {
        unseen = 0;
        badge(0);
        clearTimers();
        if (app.dbPass && app.record) dropOnReturn(app);
        return;
      }
      if (!app.dbPass || !wallet.session || !wallet.state.running) return;
      // Leaving: the states for the summary on return; reminders for later.
      saveSnapshot(app);
      armTimers(app, await leaveReminders(app));
    });
  }
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'campfire-open') openTarget(e.data.url);
    });
  }
  // Opened by a tap on a notification while the app was closed (sw.js openWindow).
  if (typeof location !== 'undefined' && /^#open=/.test(location.hash)) {
    openTarget(location.hash);
    try {
      history.replaceState(history.state, '', location.pathname + location.search);
    } catch {
      /* the hash stays */
    }
  }
}

/** The app object notifications were installed with (the e2e harness tells through it). */
export const notifyApp = () => appRef;

/** Settings → Notifications: "Send a test notification". */
export function testNotification() {
  return showSystem({ title: 'Firo PWA notifications are on', body: 'A payment will be told like this.', tag: 'test', url: '#open=notifications' });
}
