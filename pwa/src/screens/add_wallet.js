/* Add a wallet
 * Spec: ONE job: add another Firo wallet to this device, under a name: a new one, one from its
 *       recovery words, or one from a backup file (the same steps as the first wallet's).
 *       Primary CTA: "Create a new wallet" (secondary: "Restore with recovery words", "Restore
 *       from a backup file").
 *       Taps from app open: Home's wallet name (1) → Add a wallet (2) → a choice (3).
 * Exit-intent reasons and answers:
 *   - "Will this touch the wallet I have?" -> said first: your wallets stay as they are; each has
 *     its own password.
 *   - "What do I call it?" -> a name is filled in ("Wallet 2"); change it or keep it. A name in use
 *     is said, with what to do.
 *   - "What happens to the open wallet?" -> it locks once the new one is ready; Home's wallet name
 *     opens it again.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { listWallets, nextName, nameProblem, nameOf, cleanName, MAX_NAME } from '../lib/wallets.js';

export default function addWallet(app) {
  // A fresh start: words or a choice from an add flow left midway do not linger (Settings -> Backup
  // must never take a leftover "adding" for a new wallet).
  if (app.setup && Array.isArray(app.setup.words)) app.setup.words.fill('');
  app.setup = null;
  let list = null;
  const msg = h('div', { 'aria-live': 'polite', 'data-testid': 'add-msg' });
  const input = h('input', { class: 'input', type: 'text', maxlength: String(MAX_NAME), autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', 'aria-label': 'Wallet name', 'data-testid': 'add-name' });
  const openNote = h('p', { class: 'small' });
  listWallets().then((l) => {
    list = l;
    if (!input.value) input.value = nextName(l);
    const open = app.dbPass && app.record ? nameOf(app.record) : null;
    openNote.textContent = open ? `${open} locks once the new wallet is ready. Tap the wallet name on Home to open it again.` : 'Each wallet opens with its own password or Face ID.';
  });
  input.addEventListener('input', () => put(msg));

  function go(mode, to) {
    if (!list) return;
    const problem = nameProblem(input.value, list);
    if (problem) {
      put(msg, notice('warn', problem));
      input.focus();
      return;
    }
    app.setup = { mode, adding: true, name: cleanName(input.value) };
    app.go(to);
  }

  const el = screen(
    {
      title: 'Add a wallet',
      back: () => (app.dbPass ? app.back('home') : app.go('unlock')),
      actions: [
        primary('Create a new wallet', () => go('create', 'backup'), { 'data-testid': 'add-create' }),
        secondary('Restore with recovery words', () => go('restore', 'restore'), { 'data-testid': 'add-restore' }),
        secondary('Restore from a backup file', () => go('file', 'restoreFile'), { 'data-testid': 'add-file' }),
        h('button', { class: 'btn btn-text', 'data-testid': 'add-watch', onclick: () => go('watch', 'watch') }, 'Watch a wallet with its view key'),
      ],
    },
    h('p', { class: 'lead', text: 'Your wallets stay as they are. The new one gets its own password, and its own Face ID if you turn it on.' }),
    h('label', { class: 'field' }, 'Name', input),
    msg,
    openNote,
  );
  return { el };
}
