/* Protect this wallet: password (last setup step)
 * Spec: ONE job: choose the password that unlocks this wallet on this device.
 *       Primary CTA: "Protect my wallet".
 *       Taps from app open: 3 (create) / 2 (restore), plus typing.
 * Exit-intent reasons and answers:
 *   - "Another password to remember?" -> Face ID comes next; the password is the fallback.
 *   - "What if I forget it?" -> said plainly: we can't reset it, the recovery words always can.
 *   - "Rules are annoying" -> 10 characters and not a common password; it says why (whoever copies
 *     this device's data can guess at it), and what works: a few unrelated words. Each problem is
 *     named as it is typed, never only after the tap.
 *   - "Why won't the browser remember it?" -> one line: kept there, it would sit next to the wallet
 *     it opens; Face ID / Touch ID (next) saves the typing.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { createWallet, passwordProblem, isAdding, MIN_PASSWORD } from '../lib/session.js';
import { passwordWeakness } from '../lib/password_strength.js';
import { passkeyAvailable } from '../lib/passkey.js';
import { notSavedNote } from '../lib/auth_ui.js';

export default function setPassword(app) {
  if (!app.setup || (!app.setup.words && !(app.setup.mode === 'watch' && (app.setup.viewKey || app.setup.xpub)))) {
    queueMicrotask(() => app.go(app.record ? 'unlock' : 'welcome'));
    return { el: h('div') };
  }
  const restoring = app.setup.mode !== 'create';
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'data-testid': 'pw1', 'data-autofocus': true, 'aria-label': 'Password' });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'data-testid': 'pw2', 'aria-label': 'Repeat password' });
  const showBtn = h('button', { class: 'btn btn-text btn-small inside', type: 'button', 'aria-label': 'Show password' }, icon('eye'));
  showBtn.addEventListener('click', () => {
    const t = pw.type === 'password' ? 'text' : 'password';
    pw.type = t;
    pw2.type = t;
  });
  const FIRST_HINT = `At least ${MIN_PASSWORD} characters. A few unrelated words are strong and easy to type.`;
  const hint = h('p', { class: 'hint', 'data-testid': 'pw-hint', text: FIRST_HINT });
  const err = h('div', { 'aria-live': 'polite' });
  const cta = primary('Protect my wallet', save, { disabled: true, 'data-testid': 'save-password' });

  // What the password still needs, as it is typed: the length first (no red while typing it), then
  // what makes it guessable, then the second field.
  const update = () => {
    cta.disabled = Boolean(passwordProblem(pw.value, pw2.value));
    const weak = passwordWeakness(pw.value);
    const short = !pw.value || (weak && weak.code === 'short');
    const mismatch = !weak && pw2.value && pw.value !== pw2.value;
    hint.textContent = short ? FIRST_HINT : weak ? weak.text : mismatch ? "The two passwords don't match yet." : 'Good.';
    hint.className = 'hint' + (short ? '' : weak ? ' bad' : mismatch ? '' : ' good');
    hint.dataset.state = short ? 'short' : weak ? weak.code : mismatch ? 'mismatch' : 'good';
  };
  pw.addEventListener('input', update);
  pw2.addEventListener('input', update);
  pw2.addEventListener('keydown', (e) => e.key === 'Enter' && !cta.disabled && save());

  async function save() {
    const p = passwordProblem(pw.value, pw2.value);
    if (p) return put(err, notice('warn', p));
    cta.disabled = true;
    cta.textContent = 'Securing your wallet…';
    try {
      await createWallet(app, pw.value);
      pw.value = '';
      pw2.value = '';
      app.setup = null;
      // The wallet exists: no setup step before this is a Back target any more.
      if (await passkeyAvailable()) app.go('passkeySetup', { first: true }, { reset: true });
      else await app.openWallet();
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Protect my wallet';
      put(err, notice('error', `The wallet could not be saved on this device: ${e.message}`));
    }
  }

  const el = screen(
    { title: 'Protect this wallet', back: () => app.go(app.setup && app.setup.mode === 'file' ? 'restoreFile' : app.setup && app.setup.mode === 'watch' ? 'watch' : restoring ? 'restore' : 'confirmWords'), actions: [cta] },
    h('p', { class: 'step', text: restoring ? 'Step 2 of 2' : 'Step 3 of 3' }),
    h('p', { class: 'lead', text: isAdding(app) && app.setup.name ? `Choose a password for ${app.setup.name}. It can differ from your other wallets'. Next you can turn on Face ID or Touch ID for it.` : 'Choose a password for this device. Next you can turn on Face ID or Touch ID, and use the password when they are not available.' }),
    h('label', { class: 'field' }, 'Password', h('div', { class: 'input-wrap' }, pw, showBtn)),
    h('label', { class: 'field' }, 'Repeat password', pw2),
    hint,
    err,
    // Face ID / Touch ID is the next step, said in the lead.
    notSavedNote(app, { faceId: false }),
    h('p', { class: 'small', 'data-testid': 'pw-why', text: "It guards this wallet if someone copies this device's data, and nobody can reset it, not even us. If you forget it, your recovery words bring the wallet back." }),
  );
  return { el };
}
