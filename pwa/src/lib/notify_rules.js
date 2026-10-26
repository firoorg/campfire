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
import { t, tn, tk, lazyWords, sentences } from './i18n.js';

export const KINDS = Object.freeze(['in', 'out', 'moves']);
export const KIND_WORDS = Object.freeze({
  in: lazyWords({ title: tk('Money in'), sub: tk('A payment on its way to you, and once it is received, privately or publicly') }),
  out: lazyWords({ title: tk('Money out'), sub: tk('Payments you sent, and funds you privatized, once confirmed') }),
  moves: lazyWords({ title: tk('Buying, and paying with other coins'), sub: tk('A swap done; a deposit address about to stop taking coins') }),
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

const confirmed = (item) => Number(item.confirmations) >= 1;
const stateOf = (item) => (confirmed(item) ? 'c' : 'p');
const amountOf = (item) => `${formatAmount(BigInt(item.amount ?? 0))} FIRO`;
/** "privately" or "publicly": where a payment arrived (or went). */
export const howWords = (item) => (PRIVATE_KINDS.has(item && item.kind) ? 'privately' : 'publicly');
const isPrivatize = (item) => item.kind === 'privatize';
const isMineOut = (item) => (item.direction === 'out' || item.direction === 'self') && !isPrivatize(item);

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
      for (const tx2 of list) {
        if (!tx2 || !tx2.txid) continue;
        const now = stateOf(tx2);
        const before = seen.get(tx2.txid);
        seen.set(tx2.txid, now);
        if (first || !live || before === now) continue;
        if (isNews(tx2)) {
          if (now === 'p') out.push({ kind: 'in', type: 'incoming', tx: tx2 });
          else out.push({ kind: 'in', type: 'received', tx: tx2 });
        } else if (before === 'p' && now === 'c') {
          if (isPrivatize(tx2)) out.push({ kind: 'out', type: 'privatized', tx: tx2 });
          else if (isMineOut(tx2)) out.push({ kind: 'out', type: 'sent', tx: tx2 });
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
  // "In <wallet>." after the body when there are several wallets: a sentence of its own.
  const where = walletName ? t('In {walletName}.', { walletName }) : null;
  const tx = ev.tx;
  const open = tx ? `#open=activity&tx=${encodeURIComponent(tx.txid)}` : '#open=home';
  const amt = tx && amounts ? amountOf(tx) : null;
  switch (ev.type) {
    case 'incoming':
      return { title: amt ? t('{amt} is on its way to you', { amt }) : t('A payment is on its way to you'), body: sentences((PRIVATE_KINDS.has(tx && tx.kind) ? t('It arrives privately and counts once the network confirms it, usually within minutes.') : t('It arrives publicly and counts once the network confirms it, usually within minutes.')), where), tag: `in-${tx.txid}`, url: open };
    case 'received':
      return { title: amt ? t('Received {amt}', { amt }) : t('Payment received'), body: sentences((PRIVATE_KINDS.has(tx && tx.kind) ? t('It arrived privately. Tap to see it in Activity.') : t('It arrived publicly. Tap to see it in Activity.')), where), tag: `in-${tx.txid}`, url: open };
    case 'sent':
      return { title: amt ? t('Sent {amt}', { amt }) : t('Payment sent'), body: sentences(t('The network confirmed it.'), where), tag: `out-${tx.txid}`, url: open };
    case 'privatized':
      return { title: amt ? t('{amt} is now private', { amt }) : t('Your funds are now private'), body: sentences(t('Privatizing is confirmed: it is in your private balance.'), where), tag: `priv-${tx.txid}`, url: open };
    case 'several':
      return { title: ev.title, body: sentences(t('Tap to see them in Activity.'), where), tag: `sev-${ev.count}-${Date.now()}`, url: '#open=activity' };
    default: {
      // plainBody: the same without amounts, for when the person turned amounts off.
      const body = !amounts && ev.plainBody != null ? ev.plainBody : ev.body || '';
      return { title: ev.title, body: sentences(body, where).trim(), tag: ev.tag || `free-${Date.now()}`, url: ev.url || '#open=home' };
    }
  }
}

export const DAY_MS = 24 * 3600 * 1000;
export const NEAR_NOTICE_MS = 30 * 60 * 1000;

export const NEAR_REMINDER = lazyWords({ title: tk('A deposit address closes soon'), body: tk('Send the coins for your swap in the next 30 minutes: then its deposit address stops taking them.') });

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
  for (const tx of txs || []) {
    if (!tx || !tx.txid) continue;
    const before = was[tx.txid];
    if (before === undefined && !(Number(tx.time) * 1000 >= since)) continue;
    const now = stateOf(tx);
    if (before === now) continue;
    if (isNews(tx)) (now === 'c' ? r.received : r.arriving).push(tx);
    else if (before === 'p' && now === 'c') {
      if (isPrivatize(tx)) r.privatized.push(tx);
      else if (isMineOut(tx)) r.sent.push(tx);
    }
  }
  return r;
}

/** The states to remember when the person leaves (the newest 200 payments). */
export function snapshotOf(txs) {
  const o = {};
  for (const tx of (txs || []).slice(0, 200)) if (tx && tx.txid) o[tx.txid] = stateOf(tx);
  return o;
}

/** "While you were away: received 2 payments (0.5 FIRO) · a payment is on its way to you". */
export function awayLine(summary, { amounts = true } = {}) {
  const parts = [];
  const sum = (list) => list.reduce((a, item) => a + BigInt(item.amount ?? 0), 0n);
  if (summary.received.length) {
    const v = sum(summary.received);
    const n = summary.received.length;
    parts.push(amounts && v > 0n ? tn({ one: 'received a payment ({amount} FIRO)', other: 'received {n} payments ({amount} FIRO)' }, n, { amount: formatAmount(v) }) : tn({ one: 'received a payment', other: 'received {n} payments' }, n));
  }
  if (summary.arriving.length) parts.push(tn({ one: 'a payment is on its way to you', other: '{n} payments are on their way to you' }, summary.arriving.length));
  if (summary.sent.length) parts.push(tn({ one: 'a payment you sent was confirmed', other: '{n} payments you sent were confirmed' }, summary.sent.length));
  if (summary.privatized.length) parts.push(t('your privatized funds are now private'));
  if (!parts.length) return null;
  return t('While you were away: {events}.', { events: parts.join(' · ') });
}
