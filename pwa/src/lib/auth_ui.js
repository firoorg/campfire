// "Is it really you?" before money moves or settings that guard the wallet
// change. Face ID / Touch ID when a passkey is set up, the password otherwise.
//
// No password field invites the browser's password manager (autocomplete off, never the
// current-password / new-password tokens): a password saved there sits in the same browser profile
// as the wallet it opens, so whoever copies the profile (an infostealer, a backup) has both.
// Browsers may offer to save it anyway, so the screens where it is typed say why to refuse.
import { h } from './dom.js';
import { icon } from './icons.js';
import { openSheet, notice, focusSoon } from './ui.js';
import { hasPasskey, openWithPasswordFor, openWithPasskeyFor } from './session.js';
import { passkeyAvailable } from './passkey.js';
import { t, tk } from './i18n.js';

export const NOT_SAVED_TEXT = tk('If the browser offers to save this password, choose Never: there it would sit next to the wallet it opens.');
export const FACE_ID_HINT = tk('Face ID or Touch ID (Settings) saves the typing.');

/**
 * The line under a password field that says why the browser should not keep it. faceId: also
 * point to Face ID / Touch ID when this device has it and the wallet does not use it yet.
 */
export function notSavedNote(app, { faceId = true } = {}) {
  const el = h('p', { class: 'small', 'data-testid': 'pw-not-saved', text: t(NOT_SAVED_TEXT) });
  if (faceId && !hasPasskey(app))
    passkeyAvailable().then(
      (ok) => {
        if (ok) el.textContent = `${t(NOT_SAVED_TEXT)} ${t(FACE_ID_HINT)}`;
      },
      () => {},
    );
  return el;
}

/**
 * @returns {Promise<boolean>} true once the person proved it is them. passwordOnly: the password,
 * never Face ID: for what shows a secret (the recovery words, a private key, a view key) and for
 * turning Face ID on, so that whoever can unlock the phone cannot see or add their way into the
 * wallet with its face or passcode alone (public audit, P2).
 */
export function confirmIdentity(app, { title = t('Confirm it is you'), detail = '', cta = t('Confirm'), passwordOnly = false } = {}) {
  return new Promise((resolve) => {
    let usePassword = passwordOnly || !hasPasskey(app);
    let message = null;
    let busy = false;
    const sheet = openSheet((close, rerender) => {
      const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': t('Password'), placeholder: t('Password'), 'data-testid': 'auth-pw' });
      const finish = (ok) => {
        close(ok);
      };
      const tryPassword = async () => {
        if (busy) return;
        if (!pw.value) {
          message = notice('warn', t('Enter your password.'));
          return rerender();
        }
        busy = true;
        try {
          await openWithPasswordFor(app, pw.value);
          finish(true);
        } catch (e) {
          busy = false;
          message = notice('error', e.code === 'wrong_secret' ? t("That password didn't match. Try again.") : e.message);
          rerender();
        }
      };
      const tryPasskey = async () => {
        if (busy) return;
        busy = true;
        try {
          await openWithPasskeyFor(app);
          finish(true);
        } catch (e) {
          busy = false;
          message = notice(e.code === 'cancelled' ? 'info' : 'warn', e.code === 'cancelled' ? t('Face ID was cancelled. Try again, or use your password.') : t("Face ID didn't work. Use your password."));
          rerender();
        }
      };
      pw.addEventListener('keydown', (e) => e.key === 'Enter' && tryPassword());
      if (usePassword) focusSoon(pw);
      const faceBtn = h('button', { class: 'btn btn-primary', onclick: tryPasskey, 'data-testid': 'auth-passkey' }, icon('face'), cta.includes('Face ID') ? cta : t('{cta} with Face ID', { cta }));
      return [
        h('h2', { text: title }),
        detail ? h('p', { class: 'lead', text: detail }) : null,
        passwordOnly && hasPasskey(app) ? h('p', { class: 'small', 'data-testid': 'auth-password-only', text: t('This needs your password: Face ID cannot do it.') }) : null,
        usePassword ? h('label', { class: 'field' }, t('Password'), pw) : null,
        message,
        usePassword ? h('button', { class: 'btn btn-primary', onclick: tryPassword, 'data-testid': 'auth-submit' }, cta) : faceBtn,
        !usePassword
          ? h('button', { class: 'btn btn-text', 'data-testid': 'auth-use-password', onclick: () => { usePassword = true; message = null; rerender(); } }, t('Use password instead'))
          : null,
        h('button', { class: 'btn btn-text', onclick: () => finish(false), 'data-testid': 'auth-cancel' }, t('Cancel')),
      ];
    }, { label: title });
    sheet.then((v) => resolve(v === true));
  });
}
