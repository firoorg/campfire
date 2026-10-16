/* Restore from a backup file (step 1 of 2)
 * Spec: ONE job: open a Campfire encrypted backup file with its password.
 *       Primary CTA: "Choose the backup file", then "Open my backup".
 *       Taps from app open: 1 (Welcome -> Restore from a backup file), 2 to pick the file
 *       (the system file picker: iCloud Drive, Files, Downloads), 3 to open it.
 * Exit-intent reasons and answers:
 *   - "Where is my file?" -> the file picker opens Files; iCloud Drive is there.
 *   - "Which password?" -> the one you chose when you saved the file (your Campfire password then,
 *     or the longer one for a cloud copy).
 *   - "Wrong file / wrong password?" -> says which, without blaming; nothing is saved until it opens.
 *   - "Does the file go anywhere?" -> no: it is read on this device only.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { isAdding } from '../lib/session.js';
import { openBackup, readBackupHeader, BACKUP_MAX_BYTES } from '../lib/backup_file.js';
import { keys } from '../lib/chain.js';
import { formatFileSize } from '../lib/export.js';

export default function restoreFile(app) {
  const adding = isAdding(app);
  const setup = app.setup && app.setup.mode === 'file' ? app.setup : (app.setup = { ...(adding ? app.setup : {}), mode: 'file' });
  let text = null;
  let fileName = '';
  let fileSize = 0;
  const msg = h('div', { 'aria-live': 'polite' });
  const chosen = h('div');
  const input = h('input', { type: 'file', class: 'file-input', id: 'backup-file', 'data-testid': 'backup-file' });
  const pick = h('label', { class: 'btn btn-secondary', for: 'backup-file', 'data-testid': 'backup-pick' }, icon('file'), 'Choose the backup file');
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'off', 'aria-label': 'Backup password', 'data-testid': 'backup-pw', placeholder: 'The password of the file' });
  const pwField = h('label', { class: 'field hidden' }, 'Password of the file', pw);
  const cta = primary('Open my backup', open, { disabled: true, 'data-testid': 'backup-open' });
  cta.classList.add('hidden');

  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.value = '';
    put(msg);
    if (!f) return;
    if (f.size > BACKUP_MAX_BYTES || f.size === 0) {
      text = null;
      put(msg, notice('warn', `${f.name} is not a Campfire backup file (those are small JSON files, "campfire-firo-backup-….json").`));
      return show();
    }
    try {
      const t = await f.text();
      readBackupHeader(t);
      text = t;
      fileName = f.name;
      fileSize = f.size;
    } catch (e) {
      text = null;
      put(msg, notice('warn', `${f.name}: ${e.message}`));
    }
    show();
  });
  pw.addEventListener('input', () => (cta.disabled = !text || !pw.value));
  pw.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !cta.disabled) open();
  });

  function show() {
    const ready = Boolean(text);
    put(chosen, ready ? h('div', { class: 'card file-card', 'data-testid': 'backup-chosen' }, h('span', { class: 'ico' }, icon('file')), h('span', { class: 'main' }, h('div', { class: 't', text: fileName }), h('div', { class: 's', text: `${formatFileSize(fileSize)} · read on this device only` }))) : null);
    pwField.classList.toggle('hidden', !ready);
    cta.classList.toggle('hidden', !ready);
    pick.classList.toggle('btn-primary', !ready);
    pick.classList.toggle('btn-secondary', ready);
    pick.lastChild.textContent = ready ? 'Choose another file' : 'Choose the backup file';
    cta.disabled = !ready || !pw.value;
  }

  async function open() {
    if (!text || !pw.value) return;
    cta.disabled = true;
    cta.textContent = 'Opening…';
    put(msg);
    try {
      const b = await openBackup(text, pw.value);
      const v = (await keys()).validateMnemonic(b.mnemonic);
      if (!v.ok) throw new Error('The backup opened, but the words inside are not a recovery phrase. The file may be damaged.');
      pw.value = '';
      text = null;
      app.setup = { ...setup, mode: 'file', words: b.mnemonic.split(' '), passphrase: b.passphrase, birthday: b.birthday, name: setup.name || b.name || undefined };
      app.go('setPassword');
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Open my backup';
      put(msg, h('div', { 'data-testid': 'backup-error' }, notice(e.code === 'wrong_password' ? 'warn' : 'error', e.message)));
    }
  }

  show();
  const el = screen(
    {
      title: 'Restore from a backup file',
      back: () => {
        app.setup = adding ? { adding: true, name: setup.name } : null;
        app.go(adding ? 'addWallet' : 'welcome');
      },
      actions: [pick, cta],
    },
    h('p', { class: 'step', text: 'Step 1 of 2' }),
    h('p', { class: 'lead', text: 'Choose the encrypted backup file you saved from Campfire (Settings → Backup), then type its password.' }),
    input,
    chosen,
    pwField,
    msg,
    h('p', { class: 'small', text: 'The file is read on this device only; nothing is uploaded.' }),
  );
  return { el };
}
