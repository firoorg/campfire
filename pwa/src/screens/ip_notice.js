/* IP privacy (Settings -> IP privacy). Not a setup step: create, restore and import go straight
 * to connecting (optional, never in the way of a new wallet).
 * Spec: ONE job: say who can see the person's IP address, and how to hide it.
 *       Primary CTA: "Done" (secondary: "How to hide my IP").
 *       Taps from app open: 2 (Settings -> IP privacy).
 * Exit-intent reasons and answers:
 *   - "A privacy coin that leaks my IP?" -> said first, with the fixes that work on any device
 *     (public audit, PN: it was written for iPhones only, and named one node where several are asked).
 *   - "Is Private Relay enough?" -> honest: Apple documents it for Safari; for a Home Screen
 *     app it is not documented, so a VPN is the sure way.
 *   - "What else does the server learn?" -> listed: when you're online, your public addresses and
 *     the payments you send; never your private balance or your recovery words.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary } from '../lib/ui.js';

export const IP_NOTICE_TEXT =
  'The Firo nodes your wallet reads the blockchain from (the one in use, and others it asks to check its answers) can see your IP address. To hide it, use a VPN you trust, or run your own Firo node.';

export default function ipNotice(app) {
  const details = h(
    'div',
    { class: 'card hidden', 'data-testid': 'ip-details' },
    h('h3', { text: 'How to hide your IP address' }),
    h(
      'ol',
      { class: 'steps-list' },
      h('li', { text: 'A VPN you trust covers every app on the device, Campfire too, on a phone or a computer. Turn it on before you open the wallet.' }),
      h('li', { text: 'On an iPhone, iCloud Private Relay (iCloud+: Settings → [your name] → iCloud → Private Relay) hides it for Safari. For apps added to the Home Screen Apple does not say, so do not count on it there: a VPN is the sure way.' }),
      h('li', { text: 'Or run your own Firo node with ElectrumX and choose it in Settings → Firo nodes: then no one else sees your IP address or which addresses are yours.' }),
    ),
    h('p', { class: 'small', text: "Campfire itself talks to the site it was loaded from (only to install and when you check for updates) and to Firo's public nodes in Settings → Firo nodes (two of them, to check that neither gives a wrong answer; with your own node, to that one only). Prices, Buy and Ethereum ask their own servers only when you use them. No analytics." }),
    h('p', { class: 'small', text: 'A node can see your IP address, when your wallet is online, your public addresses and the payments it broadcasts. It cannot see your private balance, who you pay privately, or your recovery words.' }),
    // What stays readable on the device itself (public audit, PN: not said anywhere).
    h('p', { class: 'small', 'data-testid': 'ip-on-device', text: "On this device, each wallet's name, its number of words, whether it has a passphrase, the block it was made at, and a fingerprint that tells when the same words are added again (it cannot be turned back into them) are kept unencrypted, so the unlock screen can list the wallets. The words, payments, addresses, contacts and buy and sell orders are encrypted under your password; the app's settings (which nodes, the lock time) are not." }),
  );
  const toggle = secondary('How to hide my IP', () => {
    details.classList.toggle('hidden');
    toggle.textContent = details.classList.contains('hidden') ? 'How to hide my IP' : 'Hide details';
  }, { 'data-testid': 'ip-how' });

  const cta = primary('Done', () => app.back('settings'), { 'data-testid': 'ip-done' });

  const el = screen(
    { title: 'IP privacy', back: () => app.back('settings'), actions: [cta, toggle] },
    h('div', { class: 'status-icon wait' }, icon('globe')),
    h('p', { class: 'lead', 'data-testid': 'ip-text', text: IP_NOTICE_TEXT }),
    details,
  );
  return { el };
}
