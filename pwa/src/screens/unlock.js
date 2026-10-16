/* Unlock
 * Spec: ONE job: open the wallet.
 *       Primary CTA: "Unlock with Face ID" when this wallet has a passkey, else "Unlock" (password).
 *       Taps from app open: 1. With several wallets, the one last opened is shown; its name opens
 *       the list (1) and a tap picks another (2), which then unlocks with its own password or Face ID.
 * Exit-intent reasons and answers:
 *   - "Face ID failed" -> says it was cancelled; the password is one tap away.
 *   - "Wrong password?" -> says so without blaming, and keeps the field.
 *   - "I forgot my password" -> the way back with the recovery words, stated plainly.
 *   - "Which wallet is this?" -> with several, its name is in the title and on the picker, which
 *     shows names only: a locked phone shows no amounts.
 *   - "It didn't open" -> what went wrong, in words, and the same button tries again.
 *   - "Why doesn't the browser fill my password?" -> one line under the field: a password kept in the
 *     browser sits next to the wallet it opens; Face ID / Touch ID saves the typing instead.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice, focusSoon } from '../lib/ui.js';
import { hasPasskey, openWithPasswordFor, openWithPasskeyFor } from '../lib/session.js';
import { takeSwitchNote, takeEvmSwitchNote } from '../lib/servers.js';
import { nameOf, rememberOpened } from '../lib/wallets.js';
import { unlockPicker } from './wallets.js';
import { notSavedNote } from '../lib/auth_ui.js';

export default function unlock(app, params = {}) {
  if (!app.record) {
    queueMicrotask(() => app.go('welcome'));
    return { el: h('div') };
  }
  const passkey = hasPasskey(app);
  const msg = h('div', { 'aria-live': 'polite' });
  if (params.reason === 'timeout') put(msg, h('div', { 'data-testid': 'locked-notice' }, notice('info', `Locked after ${app.prefs.autoLockMin} minute${app.prefs.autoLockMin === 1 ? '' : 's'} without use.`)));
  else if (params.reason === 'manual') put(msg, h('div', { 'data-testid': 'locked-notice' }, notice('info', 'Locked.')));
  else if (params.reason === 'switch' && params.from) put(msg, h('div', { 'data-testid': 'locked-notice' }, notice('info', `${params.from} is locked.`)));
  else if (params.reason === 'deleted' && params.deleted) put(msg, h('div', { 'data-testid': 'deleted-notice' }, notice('success', `${params.deleted} was deleted from this device. Your other wallets are here.`)));
  else if (params.reason === 'failed') put(msg, h('div', { 'data-testid': 'start-failed' }, notice('error', `The wallet did not start: ${params.error || 'an unknown problem'} Unlock to try again.`)));
  else if (params.updated) put(msg, h('div', { 'data-testid': 'updated-notice' }, notice('success', params.updated)));
  const switched = takeSwitchNote();
  if (switched) put(msg, notice('info', `Unlock to connect through your own node, ${switched}.`));
  const evmSwitched = takeEvmSwitchNote();
  if (evmSwitched) put(msg, h('div', { 'data-testid': 'evm-switched-note' }, notice('info', `Unlock to use your own ${evmSwitched.chain} server, ${evmSwitched.name}.`)));
  // A screen waits for the unlock (a notification was tapped, a buy is followed): say where it goes next.
  const follow = app.afterUnlock ? h('div', { 'data-testid': 'unlock-follow' }, notice('info', h('strong', { text: app.afterUnlock.lead || 'Unlock to go on. ' }), app.afterUnlock.note || 'Campfire goes back to it once the wallet is open.')) : null;

  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Password', 'data-testid': 'unlock-pw', placeholder: 'Password' });
  const pwBtn = primary('Unlock', () => withPassword(), { 'data-testid': 'unlock-submit' });
  const pwBlock = h('div', { class: passkey ? 'hidden' : '' }, h('label', { class: 'field' }, 'Password', pw), notSavedNote(app));
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && withPassword());

  let busy = false;
  async function opened(dbPass) {
    app.dbPass = dbPass;
    pw.value = '';
    rememberOpened(app);
    put(msg, notice('info', 'Opening your wallet…'));
    const next = app.afterUnlock;
    app.afterUnlock = null;
    if (!(await app.openWallet({ go: false }))) return;
    app.go(next ? next.name : 'home', next ? next.params : {});
  }

  async function withPassword() {
    if (busy) return;
    if (!pw.value) return put(msg, notice('warn', 'Enter your password.'));
    busy = true;
    pwBtn.disabled = true;
    pwBtn.textContent = 'Checking…';
    try {
      const dbPass = await openWithPasswordFor(app, pw.value);
      await opened(dbPass);
    } catch (e) {
      busy = false;
      pwBtn.disabled = false;
      pwBtn.textContent = 'Unlock';
      if (e.code === 'wrong_secret') {
        put(msg, notice('error', "That password didn't open the wallet. Try again."));
        pw.select();
      } else put(msg, notice('error', e.message));
    }
  }

  async function withPasskey() {
    if (busy) return;
    busy = true;
    try {
      const dbPass = await openWithPasskeyFor(app);
      await opened(dbPass);
    } catch (e) {
      busy = false;
      const text = e.code === 'cancelled' ? 'Face ID was cancelled. Try again, or use your password.' : `Face ID didn't unlock the wallet (${e.message}). Use your password.`;
      put(msg, notice(e.code === 'cancelled' ? 'info' : 'warn', text));
    }
  }

  const usePw = textButton('Use password instead', () => {
    pwBlock.classList.remove('hidden');
    usePw.classList.add('hidden');
    faceBtn.classList.replace('btn-primary', 'btn-secondary');
    put(actions, pwBtn, faceBtn, forgot);
    pw.focus();
  }, { 'data-testid': 'use-password' });
  const faceBtn = passkey ? primary('Unlock with Face ID', withPasskey, { 'data-testid': 'unlock-passkey' }) : null;
  if (faceBtn) faceBtn.prepend(icon('face'));
  const forgot = textButton('Forgot your password?', () => app.go('deleteWallet', { forgot: true }));

  const actions = h('div', { class: 'actions' });
  put(actions, ...(passkey ? [faceBtn, usePw, forgot] : [pwBtn, forgot]));

  // Several wallets: which one this is, and the way to another (names only, no amounts).
  const lead = h('p', { 'data-testid': 'unlock-lead', text: 'Unlock your wallet' });
  const picker = h('div');
  unlockPicker(app, picker, (list) => {
    if (list.length > 1 && app.record) lead.textContent = `Unlock ${nameOf(app.record)}`;
  });

  const el = screen(
    { topbar: false },
    h('div', { class: 'hero' }, h('img', { src: 'img/logo.svg', alt: '' }), h('h1', { text: 'Campfire' }), lead),
    picker,
    follow,
    pwBlock,
    msg,
  );
  el.appendChild(actions);
  if (!passkey) focusSoon(pw);
  return { el };
}
