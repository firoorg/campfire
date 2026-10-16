/* Spark view key (Settings -> Spark view key)
 * Spec: ONE job: hand out the key that lets another wallet SEE (never spend) this wallet's
 *       private payments.
 *       Primary CTA: "Show my view key" (after the password: never Face ID alone, P2), then "Copy".
 *       Taps from app open: 2 (☰ -> Spark view key), 3 to show it.
 * Exit-intent reasons and answers:
 *   - "Can someone take my money with it?" -> no, said first: it shows, it cannot spend. But it
 *     shows everything you receive and send privately, so share it only with someone you trust.
 *   - "Where do I use it?" -> a watch-only wallet (Campfire's "View only" restore).
 *   - "It isn't there" -> in a version without it, says so plainly instead of failing silently.
 *   - "Is it safe on the clipboard?" -> Copy says it is emptied after a minute (and at the lock),
 *     and that clipboard history apps may keep it.
 *   - "Someone could see it in the app switcher" -> the key and the xpub leave the screen as soon
 *     as the app is left (or locked, or this screen closed); showing them again asks again.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, copySecret, onHidden } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { wallet } from '../lib/wallet.js';
import { isNotYet } from '../lib/chain.js';

export default function viewKey(app) {
  const box = h('div');
  const msg = h('div', { 'aria-live': 'polite' });
  let key = null;
  const cta = primary('Show my view key', show, { 'data-testid': 'view-key-show' });

  async function show() {
    if (key) return copySecret(key, 'View key copied', { app });
    if (!(await confirmIdentity(app, { title: 'Show your Spark view key', detail: 'Anyone who has it can see your private payments.', cta: 'Show it', passwordOnly: true }))) return;
    try {
      key = await wallet.exportSparkViewKey();
      put(box, h('div', { class: 'address-box' }, h('p', { class: 'mono owner-key', 'data-testid': 'view-key', text: key })));
      cta.textContent = 'Copy view key';
      cta.prepend(icon('copy'));
      put(msg);
    } catch (e) {
      put(msg, h('div', { 'data-testid': 'view-key-result' }, notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? 'Showing the Spark view key is not in this version yet. It comes with the next engine update.' : `The key could not be read: ${e.message}`)));
    }
  }

  // The public side too: an xpub lets a watch-only wallet see the public (transparent) payments.
  const xpubBox = h('div');
  const xpubBtn = h('button', { class: 'btn btn-text', 'data-testid': 'xpub-show', onclick: showXpub }, 'Also show the xpub (public payments)');
  const xpubSlot = h('div', {}, xpubBtn);
  async function showXpub() {
    if (!(await confirmIdentity(app, { title: 'Show your xpub', detail: 'Anyone who has it can see your public payments.', cta: 'Show it', passwordOnly: true }))) return;
    try {
      const x = await wallet.exportXpub();
      put(xpubBox, h('div', { class: 'address-box' }, h('p', { class: 'small', text: 'xpub: public payments only' }), h('p', { class: 'mono owner-key', 'data-testid': 'xpub', text: x })), primary('Copy xpub', () => copySecret(x, 'xpub copied', { app }), { 'data-testid': 'xpub-copy' }));
      put(xpubSlot);
    } catch (e) {
      put(xpubBox, notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? 'This wallet has no xpub to show.' : `The xpub could not be read: ${e.message}`));
    }
  }

  // Off the screen as soon as it is left, locked, or out of sight (the app switcher keeps a picture
  // of the last screen); showing it again asks again.
  const wipe = () => {
    key = null;
    put(box);
    put(xpubBox);
    put(xpubSlot, xpubBtn);
    cta.textContent = 'Show my view key';
  };
  app.lockHooks.add(wipe);
  const offHidden = onHidden(wipe);

  const el = screen(
    { title: 'Spark view key', back: () => app.back('settings'), actions: [cta] },
    h('div', { 'data-testid': 'view-key-intro' }, notice('info', h('strong', { text: 'It can see, it cannot spend. ' }), 'A wallet given this key shows every payment you receive and send privately, but cannot move your money.')),
    notice('warn', 'Share it only with someone you trust to see your whole private history, for example your own watch-only wallet.'),
    box,
    msg,
    xpubSlot,
    xpubBox,
  );
  return {
    el,
    destroy() {
      wipe();
      offHidden();
      app.lockHooks.delete(wipe);
    },
  };
}
