/* Face ID / Touch ID setup
 * Spec: ONE job: let Face ID / Touch ID unlock the wallet.
 *       Primary CTA: "Turn on Face ID" (secondary: "Not now").
 *       Taps from app open: 4 (create) / 3 (restore); from Settings: 2.
 * Exit-intent reasons and answers:
 *   - "Does Apple get my keys?" -> no: the passkey only unlocks a key kept on this device. But the
 *     passkey itself lives in Apple's or Google's password manager and may sync there, so that
 *     account, with a copy of this device's data, would open the wallet: said plainly, with what
 *     to do (protect the account).
 *   - "What if it fails?" -> the password still works; we say so if this device can't do it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice } from '../lib/ui.js';
import { addPasskey } from '../lib/session.js';
import { confirmIdentity } from '../lib/auth_ui.js';

export default function passkeySetup(app, params = {}) {
  const first = Boolean(params.first);
  const msg = h('div', { 'aria-live': 'polite' });
  const next = () => (first ? app.openWallet() : app.go('settings'));
  const cta = primary(h('span', {}, 'Turn on Face ID'), turnOn, { 'data-testid': 'passkey-on' });
  cta.prepend(icon('face'));

  async function turnOn() {
    cta.disabled = true;
    // From Settings: the password first. An unlocked phone in someone else's hands must not be able
    // to add a passkey of theirs (a security key, another account) to this wallet (public audit, P2).
    // Right after the password was set (first), it was just typed.
    if (!first && !(await confirmIdentity(app, { title: 'Turn on Face ID', detail: 'Your password first.', cta: 'Continue', passwordOnly: true }))) {
      cta.disabled = false;
      return;
    }
    try {
      await addPasskey(app);
      put(msg, notice('success', 'Face ID / Touch ID is on for this wallet.'));
      setTimeout(next, 700);
    } catch (e) {
      cta.disabled = false;
      const text =
        e.code === 'cancelled'
          ? 'Face ID was cancelled. You can try again, or skip and use your password.'
          : e.code === 'no_prf' || e.code === 'unsupported'
            ? "This device can't use a passkey to protect the wallet key (it needs iOS 18 or newer). Your password keeps working."
            : `That didn't work: ${e.message} Your password keeps working.`;
      put(msg, notice(e.code === 'cancelled' ? 'info' : 'warn', text));
    }
  }

  const el = screen(
    { title: 'Unlock with Face ID', back: first ? null : () => app.go('settings'), actions: [cta, textButton(first ? 'Not now' : 'Cancel', next, { 'data-testid': 'passkey-skip' })] },
    first ? h('p', { class: 'step', text: 'Almost done' }) : null,
    h('p', { class: 'lead', text: 'Open Firo PWA with Face ID or Touch ID instead of typing your password.' }),
    h(
      'div',
      { class: 'card' },
      h('h3', { text: 'How it stays private' }),
      h('p', { class: 'small', text: "A passkey unlocks the wallet's key, which never leaves this device. Firo PWA has no server and no account. Your password keeps working too." }),
      h('p', { class: 'small', 'data-testid': 'passkey-account', text: 'The passkey is kept by your Apple or Google password manager and may sync with that account. Protect the account (two-step sign-in) as you would this password.' }),
    ),
    msg,
  );
  return { el };
}
