/* The banner over any screen: money on its way, money arrived
 * Spec: ONE job: tell me, inside the app, what happened in my wallet that I did not do myself.
 *       Primary CTA: none (a tap on the banner opens the payment in Activity).
 *       Taps from app open: 0 (it appears by itself).
 * Exit-intent reasons and answers:
 *   - "Did my money arrive?" -> "0.5 FIRO is on its way to you" the moment it is seen, then
 *     "Received 0.5 FIRO" once confirmed, saying whether it arrived privately or publicly; a tap
 *     shows it.
 *   - "Is this a fake popup?" -> it is drawn inside the app, never asks for anything, and only
 *     opens the payment in Activity.
 * What is told, when, and the system notifications: lib/notify.js. Settings: screens/notifications.js.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { setBanner, installNotify, parseOpen } from '../lib/notify.js';
import { t } from '../lib/i18n.js';

const BANNER_MS = 8000;

export function installPaymentNotices(app) {
  setBanner(showBanner);
  installNotify(app);
}

/** The banner over whatever is on screen; a tap opens what it is about (url: '#open=…'). One at a time: a newer one replaces it. */
export function showBanner(app, title, body, url) {
  document.querySelectorAll('.pay-banner').forEach((b) => b.remove());
  const close = () => banner.remove();
  const open = () => {
    close();
    const item = parseOpen(url) || { screen: 'activity', params: {} };
    if (app.dbPass) app.go(item.screen, item.params);
  };
  const banner = h(
    'div',
    { class: 'pay-banner', role: 'status', 'aria-live': 'polite', 'data-testid': 'pay-banner' },
    h(
      'button',
      { class: 'pay-banner-main', type: 'button', onclick: open, 'data-testid': 'pay-banner-open' },
      h('span', { class: 'ico' }, icon('receive')),
      h('span', { class: 'main' }, h('span', { class: 't', 'data-testid': 'pay-banner-title', text: title }), h('span', { class: 's', text: body })),
    ),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Close'), onclick: close, 'data-testid': 'pay-banner-close' }, icon('close')),
  );
  document.body.appendChild(banner);
  setTimeout(close, BANNER_MS);
}
