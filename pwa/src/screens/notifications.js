/* Settings -> Notifications
 * Spec: ONE job: choose what Campfire tells you about, on this device.
 *       Primary CTA: the switch at the top ("Notifications"): the browser's permission is asked on
 *       that tap, never by itself. Then one switch per kind, "Show amounts", and a test.
 *       Taps from app open: 2 (Settings -> Notifications).
 * Exit-intent reasons and answers:
 *   - "Will it tell me when the app is closed?" -> said plainly under the switch, per device: on
 *     iPhone only while the app is open (iOS runs no web app in the background); on Android and
 *     computers also while it runs in the background, and reminders the browser may show later.
 *     No server watches the wallet: none can read whose private payment is whose, and the app
 *     works without ours.
 *   - "Too many?" -> one switch per kind.
 *   - "Someone can read my lock screen" -> no amounts there unless "Show amounts" is turned on
 *     ("Payment received"); inside the open app amounts are always shown.
 *   - "Is it working?" -> Send a test notification.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, openSheet, toast, secondary } from '../lib/ui.js';
import { notificationPermission, isIos, isStandalone } from '../lib/payment_notice.js';
import { KINDS, KIND_WORDS, settingsOf } from '../lib/notify_rules.js';
import { testNotification, forgetReminders, wakeUpsOn, wakeUpsSupported, applyWakeUps } from '../lib/notify.js';
import { refreshPersistence } from '../lib/storage.js';
import { t, tk, lazyWords } from '../lib/i18n.js';

export const NOTIFY_TEXT = lazyWords({
  title: tk('Notifications'),
  lead: tk('Firo PWA tells you about your wallet from this device. No server watches it: none can read whose private payment is whose, and the app keeps working without ours.'),
  whereIos: tk('On iPhone: while Firo PWA is open. iPhone runs no web app in the background, so when you come back, Home says what happened meanwhile.'),
  whereOther: tk('While Firo PWA is open, and in the background until it locks itself (Auto-lock). Reminders (a swap deposit address about to stop taking coins) come then too; when Firo PWA is closed, only if you turn that on below. When you come back, Home says what happened meanwhile.'),
  iosHomeScreen: tk('On iPhone, notifications work in the app added to your Home Screen (Share → Add to Home Screen).'),
  unsupported: tk("This browser can't show notifications. The banner inside the app still tells you while it is open."),
  denied: tk("Notifications are blocked for Firo PWA in this browser's settings. Allow them there, then turn this on again."),
  notAsked: tk("Not turned on: the browser's question was closed. Tap the switch to be asked again."),
  on: tk('Notifications are on'),
  off: tk('Notifications are off. The banner inside the app stays.'),
  amounts: tk('Show amounts'),
  amountsSub: tk('Off: "Payment received" on your lock screen. On: "Received 0.5 FIRO", for anyone who sees it'),
  test: tk('Send a test notification'),
  wakeUps: tk('Reminders when Firo PWA is closed'),
  wakeUpsSub: tk("To show them, this browser wakes Firo PWA now and then. A wake-up can also bring in changed code from Firo PWA's web address, with no Firo PWA screen open to warn you if it is not signed. Off unless you turn it on."),
});

/** Asks the browser, from the person's tap (the first thing that tap does). Old Safari answers through a callback. */
export function askPermission() {
  return new Promise((resolve) => {
    try {
      const r = Notification.requestPermission((v) => resolve(v));
      if (r && typeof r.then === 'function') r.then(resolve, () => resolve('denied'));
    } catch {
      resolve('denied');
    }
  });
}

/** Settings' row: the state in a few words, and the way in. */
export function notificationsRow(app) {
  const s = settingsOf(app.prefs);
  const permission = notificationPermission();
  const sub = permission === 'unsupported' ? (isIos() && !isStandalone() ? t('On iPhone: add Firo PWA to your Home Screen first') : t("This browser can't show them")) : permission === 'denied' ? t('Blocked in this browser’s settings') : s.on && permission === 'granted' ? t('On') : t('Off');
  return h(
    'button',
    { class: 'row', type: 'button', onclick: () => app.go('notifications'), 'data-testid': 'notify-row' },
    h('span', { class: 'ico' }, icon('bell')),
    h('span', { class: 'main' }, h('div', { class: 't', text: NOTIFY_TEXT.title }), h('div', { class: 's', 'data-testid': 'notify-row-sub', text: sub })),
    h('span', { class: 'chev' }, icon('chevron')),
  );
}

export default function notifications(app) {
  const box = h('div', { class: 'stack' });
  const ios = isIos();

  const setNotify = (patch) => {
    const cur = (app.prefs && app.prefs.notify) || {};
    return app.setPrefs({ notify: { ...cur, ...patch, kinds: { ...(cur.kinds || {}), ...(patch.kinds || {}) } } });
  };
  const explain = (text, testid) =>
    openSheet((close) => [h('h2', { text: NOTIFY_TEXT.title }), h('div', { 'data-testid': testid }, notice('info', text)), h('button', { class: 'btn btn-primary', onclick: () => close() }, t('OK'))], { label: NOTIFY_TEXT.title });

  function render() {
    const s = settingsOf(app.prefs);
    const permission = notificationPermission();
    const on = s.on && permission === 'granted';
    const master = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': NOTIFY_TEXT.title, 'data-testid': 'notify-switch', checked: on });
    master.addEventListener('change', () => {
      if (!master.checked) {
        forgetReminders(app);
        setNotify({ on: false }).then(() => {
          applyWakeUps(app); // off: no more wake-ups either
          toast(NOTIFY_TEXT.off);
          render();
        });
        return;
      }
      if (permission === 'unsupported') {
        master.checked = false;
        explain(ios && !isStandalone() ? NOTIFY_TEXT.iosHomeScreen : NOTIFY_TEXT.unsupported, 'notify-unsupported');
        return;
      }
      if (permission === 'denied') {
        master.checked = false;
        explain(NOTIFY_TEXT.denied, 'notify-denied');
        return;
      }
      // The browser's question comes from this tap, before anything else is awaited.
      const asked = permission === 'granted' ? Promise.resolve('granted') : askPermission();
      asked.then(async (result) => {
        await setNotify({ on: result === 'granted' });
        // A site allowed to notify is one Chrome keeps the storage of: ask again now.
        if (result === 'granted') refreshPersistence(app, { request: true }).catch(() => {});
        if (result === 'granted') toast(NOTIFY_TEXT.on, 3000);
        else if (result === 'denied') explain(NOTIFY_TEXT.denied, 'notify-denied');
        else toast(NOTIFY_TEXT.notAsked, 4000);
        render();
      });
    });
    const sub = permission === 'unsupported' ? (ios && !isStandalone() ? t('On iPhone: add Firo PWA to your Home Screen first') : t("This browser can't show them")) : permission === 'denied' ? t('Blocked in this browser’s settings') : on ? (ios ? t('On, while Firo PWA is open') : t('On')) : t('Off. A banner in the app tells you while it is open.');
    const kindRow = (k) => {
      const sw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': KIND_WORDS[k].title, 'data-testid': `notify-kind-${k}`, checked: s.kinds[k] !== false });
      sw.addEventListener('change', () => setNotify({ kinds: { [k]: sw.checked } }));
      return h('label', { class: 'row' }, h('span', { class: 'main' }, h('div', { class: 't', text: KIND_WORDS[k].title }), h('div', { class: 's wrap', text: KIND_WORDS[k].sub })), sw);
    };
    const amounts = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': NOTIFY_TEXT.amounts, 'data-testid': 'notify-amounts', checked: s.amounts });
    amounts.addEventListener('change', () => setNotify({ amounts: amounts.checked }));
    // Periodic Background Sync, only on the person's say-so (lib/notify.js): Chrome / Edge, an installed app.
    const wake = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': NOTIFY_TEXT.wakeUps, 'data-testid': 'notify-wakeups', checked: wakeUpsOn(app.prefs) });
    wake.addEventListener('change', () => setNotify({ wakeUps: wake.checked }).then(() => applyWakeUps(app)));
    put(
      box,
      h('p', { class: 'lead', text: NOTIFY_TEXT.lead }),
      h(
        'div',
        { class: 'card list' },
        h('label', { class: 'row', 'data-testid': 'notify-master' }, h('span', { class: 'ico' }, icon('bell')), h('span', { class: 'main' }, h('div', { class: 't', text: NOTIFY_TEXT.title }), h('div', { class: 's wrap', 'data-testid': 'notify-sub', text: sub })), master),
      ),
      h('p', { class: 'small settings-note', 'data-testid': 'notify-note', text: ios ? NOTIFY_TEXT.whereIos : NOTIFY_TEXT.whereOther }),
      // What to be told about: once they are on (switches under an Off would look on).
      on ? h('p', { class: 'section-title', text: t('Tell me about') }) : null,
      on ? h('div', { class: 'card list', 'data-testid': 'notify-kinds' }, ...KINDS.map(kindRow)) : null,
      on ? h('div', { class: 'card list' }, h('label', { class: 'row' }, h('span', { class: 'main' }, h('div', { class: 't', text: NOTIFY_TEXT.amounts }), h('div', { class: 's wrap', text: NOTIFY_TEXT.amountsSub })), amounts)) : null,
      on && !ios && wakeUpsSupported()
        ? h('div', { class: 'card list' }, h('label', { class: 'row' }, h('span', { class: 'main' }, h('div', { class: 't', text: NOTIFY_TEXT.wakeUps }), h('div', { class: 's wrap', 'data-testid': 'notify-wakeups-sub', text: NOTIFY_TEXT.wakeUpsSub })), wake))
        : null,
      on
        ? secondary(NOTIFY_TEXT.test, async () => {
            const ok = await testNotification();
            toast(ok ? t('Sent. It shows when the app is not in front, or in your notifications.') : t("The browser didn't show it. Check its notification settings."), 4000);
          }, { 'data-testid': 'notify-test' })
        : null,
    );
  }
  render();
  const el = screen({ title: NOTIFY_TEXT.title, back: () => app.back('settings'), cls: 'settings' }, box);
  return { el };
}
