// What Campfire tells the person about, and what it says. Pure: the effects (banner, system
// notification, badge, reminders stored for the service worker) are lib/notify.js.
//
// Everything is decided on this device from the wallet's own payment list (lib/wallet.js:
// {txid, direction, kind, amount, fee, confirmations, time, …}). No server watches the wallet:
// none could read whose Spark payment is whose, and the app must keep working when every server
// of ours is gone. So:
//   - while the app runs (on screen, or in the background for as long as the system lets it),
//     each change in the payment list is checked here;
//   - when the person leaves the app, what happens next needs nothing from it (a Firo payment is
//     on the network once sent), so only reminders for later are worked out (a NEAR Intents deposit
//     about to stop taking coins) and left on the device for the service worker;
//   - when they come back, what happened meanwhile is summed up from the same list.
//
// Kinds (one switch each in Settings → Notifications):
//   in     money in: a payment on its way to you, then received (privately or publicly)
//   out    money out: a payment you sent, and funds you privatized, once confirmed
//   moves  buying, and paying with other coins (NEAR Intents): a deposit address about to stop
//          taking coins, a swap done

import { formatAmount } from './amount.js';
import { isNews } from './payment_notice.js';

export const KINDS = Object.freeze(['in', 'out', 'moves']);
export const KIND_WORDS = Object.freeze({
  in: { title: 'Money in', sub: 'A payment on its way to you, and once it is received, privately or publicly' },
  out: { title: 'Money out', sub: 'Payments you sent, and funds you privatized, once confirmed' },
  moves: { title: 'Buying, and paying with other coins', sub: 'A swap done; a deposit address about to stop taking coins' },
});

/** Defaults: everything on once notifications are on. */
export const DEFAULT_KINDS = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, true])));

const PRIVATE_KINDS = new Set(['spark', 'spark-name', 'lelantus', 'privatize']);

/**
 * The person's settings, with defaults; prefs.notify = { on, kinds, amounts }. amounts: whether a
 * system notification (the lock screen, read by whoever holds the phone) says how much; off unless
 * the person turns it on. Inside the open app amounts are always shown.
 */
export function settingsOf(prefs) {
  const n = (prefs && prefs.notify) || {};
  return { on: n.on === true, kinds: { ...DEFAULT_KINDS, ...(n.kinds || {}) }, amounts: n.amounts === true };
}

const confirmed = (t) => Number(t.confirmations) >= 1;
const stateOf = (t) => (confirmed(t) ? 'c' : 'p');
const amountOf = (t) => `${formatAmount(BigInt(t.amount ?? 0))} FIRO`;
/** "privately" or "publicly": where a payment arrived (or went). */
export const howWords = (t) => (PRIVATE_KINDS.has(t && t.kind) ? 'privately' : 'publicly');
const isPrivatize = (t) => t.kind === 'privatize';
const isMineOut = (t) => (t.direction === 'out' || t.direction === 'self') && !isPrivatize(t);

/**
 * Watches the payment list. update(txs, loaded, live) returns the changes worth telling: the
 * first read only records (it is history), and so does any read while live is false (a wallet
 * catching up finds old payments: lib/payment_notice.js catchUp). Each change once.
 * Events: { kind, type, tx } with type
 *   'incoming'   a payment to you, first seen waiting for its confirmation;
 *   'received'   a payment to you, confirmed (or first seen already confirmed);
 *   'sent'       a payment you sent (or to yourself), seen waiting and now confirmed;
 *   'privatized' funds you privatized, seen waiting and now confirmed.
 */
export function txWatcher() {
  let seen = null; // txid -> 'p' | 'c'
  return {
    reset() {
      seen = null;
    },
    get started() {
      return seen !== null;
    },
    update(txs, loaded = true, live = true) {
      if (!loaded) return [];
      const list = txs || [];
      const first = seen === null;
      if (first) seen = new Map();
      const out = [];
      for (const t of list) {
        if (!t || !t.txid) continue;
        const now = stateOf(t);
        const before = seen.get(t.txid);
        seen.set(t.txid, now);
        if (first || !live || before === now) continue;
        if (isNews(t)) {
          if (now === 'p') out.push({ kind: 'in', type: 'incoming', tx: t });
          else out.push({ kind: 'in', type: 'received', tx: t });
        } else if (before === 'p' && now === 'c') {
          if (isPrivatize(t)) out.push({ kind: 'out', type: 'privatized', tx: t });
          else if (isMineOut(t)) out.push({ kind: 'out', type: 'sent', tx: t });
        }
      }
      return out;
    },
  };
}

/**
 * What a notification says. ev: { type, tx } or a free one { type: 'free', title, body }.
 * amounts false: no amounts in the text (a lock screen shows it). Returns { title, body, tag, url }:
 * url is where a tap opens (a hash the app reads). A payment's "on its way" and "received" share a
 * tag, so the second replaces the first in the notification list.
 */
export function wordsFor(ev, { amounts = true, walletName = null } = {}) {
  const where = walletName ? ` In ${walletName}.` : '';
  const tx = ev.tx;
  const open = tx ? `#open=activity&tx=${encodeURIComponent(tx.txid)}` : '#open=home';
  const amt = tx && amounts ? amountOf(tx) : null;
  switch (ev.type) {
    case 'incoming':
      return { title: amt ? `${amt} is on its way to you` : 'A payment is on its way to you', body: `It arrives ${howWords(tx)} and counts once the network confirms it, usually within minutes.${where}`, tag: `in-${tx.txid}`, url: open };
    case 'received':
      return { title: amt ? `Received ${amt}` : 'Payment received', body: `It arrived ${howWords(tx)}. Tap to see it in Activity.${where}`, tag: `in-${tx.txid}`, url: open };
    case 'sent':
      return { title: amt ? `Sent ${amt}` : 'Payment sent', body: `The network confirmed it.${where}`, tag: `out-${tx.txid}`, url: open };
    case 'privatized':
      return { title: amt ? `${amt} is now private` : 'Your funds are now private', body: `Privatizing is confirmed: it is in your private balance.${where}`, tag: `priv-${tx.txid}`, url: open };
    case 'several':
      return { title: ev.title, body: `Tap to see them in Activity.${where}`, tag: `sev-${ev.count}-${Date.now()}`, url: '#open=activity' };
    default: {
      // plainBody: the same without amounts, for when the person turned amounts off.
      const body = !amounts && ev.plainBody != null ? ev.plainBody : ev.body || '';
      return { title: ev.title, body: `${body}${where}`.trim(), tag: ev.tag || `free-${Date.now()}`, url: ev.url || '#open=home' };
    }
  }
}

export const DAY_MS = 24 * 3600 * 1000;
export const NEAR_NOTICE_MS = 30 * 60 * 1000;

export const NEAR_REMINDER = Object.freeze({ title: 'A deposit address closes soon', body: 'Send the coins for your swap in the next 30 minutes: then its deposit address stops taking them.' });

/**
 * Reminders for later, worked out when the person leaves; the service worker shows each when it
 * is due (if the browser wakes it: Periodic Background Sync, Chromium) and the page shows them
 * while it still runs. Each: { id, kind, at, title, body, url }.
 *   - a NEAR Intents swap: 30 minutes before its deposit address stops taking coins.
 * A Firo payment needs no reminder: once sent it is on the network, with or without the app.
 * They are stored in the clear (the service worker reads them while the wallet is locked), so they
 * say only when, in words that name nothing: no coin, amount, deposit address or wallet (audit
 * A-1). The tap opens NEAR Intents, which shows the swap once the wallet is unlocked.
 */
export function remindersFor({ nearSwaps = [], now = Date.now() } = {}) {
  const out = [];
  const ids = new Set();
  for (const s of nearSwaps) {
    const at = s.sendBefore - NEAR_NOTICE_MS;
    if (!(at > now)) continue;
    // Named by its time only, which is stored anyway; two at the same moment are one reminder.
    const id = `rem-near-${at}`;
    if (ids.has(id)) continue;
    ids.add(id);
    out.push({ id, kind: 'moves', at, title: NEAR_REMINDER.title, body: NEAR_REMINDER.body, url: '#open=nearIntents' });
  }
  return out;
}

/** The reminders that are due now, and the ones to keep. */
export function dueReminders(list, now = Date.now()) {
  const due = [];
  const keep = [];
  for (const r of list || []) (r && r.at <= now ? due : keep).push(r);
  return { due, keep };
}

/**
 * What happened while the person was away, from what was saved when they left (snapshot:
 * { at, txs: { txid: 'p' | 'c' } }, the newest 200 payments) and the list now: received (and
 * still arriving), sent, privatized. A payment not in the snapshot counts only if it is newer than
 * the moment the person left (an older one was simply not among the 200).
 */
export function awaySummary(snapshot, txs) {
  const was = (snapshot && snapshot.txs) || {};
  const since = snapshot && Number.isFinite(snapshot.at) ? snapshot.at - 60000 : Infinity;
  const r = { received: [], arriving: [], sent: [], privatized: [] };
  for (const t of txs || []) {
    if (!t || !t.txid) continue;
    const before = was[t.txid];
    if (before === undefined && !(Number(t.time) * 1000 >= since)) continue;
    const now = stateOf(t);
    if (before === now) continue;
    if (isNews(t)) (now === 'c' ? r.received : r.arriving).push(t);
    else if (before === 'p' && now === 'c') {
      if (isPrivatize(t)) r.privatized.push(t);
      else if (isMineOut(t)) r.sent.push(t);
    }
  }
  return r;
}

/** The states to remember when the person leaves (the newest 200 payments). */
export function snapshotOf(txs) {
  const o = {};
  for (const t of (txs || []).slice(0, 200)) if (t && t.txid) o[t.txid] = stateOf(t);
  return o;
}

/** "While you were away: received 2 payments (0.5 FIRO) · a payment is on its way to you". */
export function awayLine(summary, { amounts = true } = {}) {
  const parts = [];
  const sum = (list) => list.reduce((a, t) => a + BigInt(t.amount ?? 0), 0n);
  if (summary.received.length) {
    const v = sum(summary.received);
    const n = summary.received.length;
    parts.push(`received ${n === 1 ? 'a payment' : `${n} payments`}${amounts && v > 0n ? ` (${formatAmount(v)} FIRO)` : ''}`);
  }
  if (summary.arriving.length) parts.push(summary.arriving.length === 1 ? 'a payment is on its way to you' : `${summary.arriving.length} payments are on their way to you`);
  if (summary.sent.length) parts.push(summary.sent.length === 1 ? 'a payment you sent was confirmed' : `${summary.sent.length} payments you sent were confirmed`);
  if (summary.privatized.length) parts.push('your privatized funds are now private');
  if (!parts.length) return null;
  return `While you were away: ${parts.join(' · ')}.`;
}
