/* Change password
 * Spec: ONE job: replace the unlock password.
 *       Primary CTA: "Save new password".
 *       Taps from app open: 2 (Settings -> Change password).
 * Exit-intent reasons and answers:
 *   - "Will this touch my coins?" -> no: only the lock on this device changes.
 *   - "Wrong current password" -> says so, keeps the new one typed.
 *   - "Can the browser keep it?" -> one line: better not, it would sit next to the wallet it opens.
 *   - "Is the old password useless now?" -> on this device; a copy made before still opens with it (said).
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { changePassword, passwordProblem, MIN_PASSWORD } from '../lib/session.js';
import { notSavedNote } from '../lib/auth_ui.js';

export default function changePasswordScreen(app) {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Current password', 'data-testid': 'cp-current' });
  const n1 = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'New password', 'data-testid': 'cp-new' });
  const n2 = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Repeat new password', 'data-testid': 'cp-new2' });
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary('Save new password', save, { 'data-testid': 'cp-save' });

  async function save() {
    const p = passwordProblem(n1.value, n2.value);
    if (!cur.value) return put(msg, notice('warn', 'Enter your current password.'));
    if (p) return put(msg, notice('warn', p));
    cta.disabled = true;
    cta.textContent = 'Saving…';
    try {
      await changePassword(app, cur.value, n1.value);
      toast('Password changed');
      app.go('settings');
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Save new password';
      put(msg, notice('error', e.code === 'wrong_secret' ? "The current password didn't match. Try again." : e.message));
    }
  }

  const el = screen(
    { title: 'Change password', back: () => app.back('settings'), actions: [cta] },
    h('p', { class: 'lead', text: 'This changes how you unlock Firo PWA on this device. Your coins and your recovery words stay the same.' }),
    h('label', { class: 'field' }, 'Current password', cur),
    h('label', { class: 'field' }, `New password (${MIN_PASSWORD}+ characters, not a common one)`, n1),
    h('label', { class: 'field' }, 'Repeat new password', n2),
    msg,
    notSavedNote(app),
    // The wallet's own secret stays the same; only the lock on it changes (public audit, PN-keys).
    h('p', { class: 'small', 'data-testid': 'cp-old-copies', text: 'A copy of this browser\'s data made before the change (a backup, another computer) still opens with the old password. If the old one may be known, move your coins to a new wallet instead.' }),
  );
  return { el };
}
