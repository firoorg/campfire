/* Welcome
 * Spec: ONE job: start a Firo wallet on this device - a new one, one from its recovery words, or
 *       one from a Campfire backup file.
 *       Primary CTA: "Create a new wallet" (secondary: "Restore with recovery words",
 *       "Restore from a backup file").
 *       Taps from app open: 0 (first screen for a new device); each choice is 1 tap.
 * Exit-intent reasons and answers:
 *   - "Is this a scam / who holds my money?" -> the line under the buttons: no account, your keys
 *     stay on this device.
 *   - "Three buttons, which one is me?" -> the new wallet is the obvious (primary) one; the other two
 *     are named after what you bring: your words, or your backup file.
 *   - "I have a Campfire app wallet" -> its 12 or 24 words restore it here (same keys).
 *   - "Will I lose it if Safari clears data?" -> the Home Screen guide says when that happens.
 *   - "What does it cost?" -> nothing to install or sign up; network fees are shown before paying.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary } from '../lib/ui.js';

export function isIosSafariTab() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

export default function welcome(app) {
  const guide = isIosSafariTab() && !app.prefs.a2hsDismissed ? a2hsGuide(app) : null;
  const el = screen(
    {
      topbar: false,
      cls: 'welcome',
      actions: [
        primary('Create a new wallet', () => {
          app.setup = { mode: 'create' };
          app.go('backup');
        }, { 'data-testid': 'create' }),
        secondary('Restore with recovery words', () => {
          app.setup = { mode: 'restore' };
          app.go('restore');
        }, { 'data-testid': 'restore' }),
        secondary('Restore from a backup file', () => {
          app.setup = { mode: 'file' };
          app.go('restoreFile');
        }, { 'data-testid': 'restore-file' }),
        h('button', { class: 'btn btn-text', 'data-testid': 'watch', onclick: () => { app.setup = { mode: 'watch' }; app.go('watch'); } }, 'Watch a wallet with its view key'),
        h('p', { class: 'small center', text: 'No sign-up. Your keys stay on this device.' }),
      ],
    },
    h(
      'div',
      { class: `hero${guide ? ' compact' : ''}` },
      h('img', { src: 'img/logo.svg', alt: '' }),
      h('h1', { text: 'Campfire' }),
      h('p', { text: 'Your privacy. Your wallet. Your Firo.' }),
    ),
    guide,
  );
  return { el };
}

function a2hsGuide(app) {
  const card = h(
    'div',
    { class: 'card a2hs', 'data-testid': 'a2hs' },
    h(
      'div',
      { class: 'banner' },
      h('h3', { class: 'grow', text: 'First, add Campfire to your Home Screen' }),
      h('button', {
        class: 'icon-btn',
        'aria-label': 'Hide this tip',
        onclick: async () => {
          await app.setPrefs({ a2hsDismissed: true });
          card.remove();
        },
      }, icon('close')),
    ),
    h('p', {}, 'Tap Share ', icon('share', 'inline-icon'), ' in Safari, choose "Add to Home Screen", then open Campfire from there.'),
    h('p', { class: 'small', text: 'Home Screen apps keep their data. Safari tabs may lose it after 7 days without use, and a wallet made in a Safari tab does not move to the Home Screen app.' }),
  );
  return card;
}
