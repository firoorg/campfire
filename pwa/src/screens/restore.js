/* Restore (step 1 of 2)
 * Spec: ONE job: enter the recovery words (12 or 24; a pasted 15, 18 or 21 too).
 *       Primary CTA: "Restore my wallet".
 *       Taps from app open: 1 (Welcome -> Restore), then typing or one paste.
 * Exit-intent reasons and answers:
 *   - "Typing 24 words on a phone is painful" -> paste all of them into any box; they spread out,
 *     and 12 or 24 is picked by itself from what was pasted.
 *   - "Which word is wrong?" -> each unknown word is marked as you go, with its number.
 *   - "Will my coins come back?" -> said up front: yes, once the wallet has read the blockchain
 *     (it can take a while; "Restore from block" makes it faster).
 *   - "My wallet had a passphrase" -> Advanced: the BIP39 passphrase, with what happens without it.
 *   - "Restoring takes long" -> Advanced: when the wallet was made (a date, or a block): reading starts there.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { keys } from '../lib/chain.js';
import { isAdding, WORD_COUNTS, RESTORE_WORD_COUNTS, walletWithWords } from '../lib/session.js';
import { wordlist } from '../vendor/noble/scure-bip39/wordlists/english.js';
import { passphraseField } from './backup.js';
import { heightForDate } from '../lib/heights.js';
import { t, tn } from '../lib/i18n.js';

const WORDS = new Set(wordlist);

/** "12 words" / "24 words" segmented choice; a pasted 15, 18 or 21 shows as a third, chosen. */
function countPicker(count, onPick) {
  const shown = WORD_COUNTS.includes(count) ? WORD_COUNTS : [...WORD_COUNTS, count];
  return h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-label': t('Number of words') },
    ...shown.map((n) =>
      h('button', { type: 'button', class: `seg${n === count ? ' on' : ''}`, role: 'radio', 'aria-checked': String(n === count), 'data-testid': `count-${n}`, onclick: () => onPick(n) }, tn({ one: '{n} word', other: '{n} words' }, n)),
    ),
  );
}

/** A block height as typed: null when empty, a whole number, or false when not one. */
export function parseHeight(text) {
  const s = String(text ?? '').replace(/[\s,._]/g, '');
  if (!s) return null;
  if (!/^\d{1,9}$/.test(s)) return false;
  return Number(s);
}

export default function restore(app) {
  const adding = isAdding(app);
  if (!app.setup || app.setup.mode !== 'restore') app.setup = { ...(adding ? app.setup : {}), mode: 'restore' };
  const setup = app.setup;
  let count = RESTORE_WORD_COUNTS.includes(setup.count) ? setup.count : 12;
  const inputs = [];
  const boxes = [];
  const grid = h('div', { class: 'words' });
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary(t('Restore my wallet'), submit, { disabled: true, 'data-testid': 'restore-submit' });
  const pickerBox = h('div');
  const pass = passphraseField(setup, { restoring: true });
  const height = h('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: t('Leave empty to read everything'), 'aria-label': t('Restore from block'), 'data-testid': 'restore-height' });
  if (Number.isSafeInteger(setup.birthday)) height.value = String(setup.birthday);
  const heightHint = h('p', { class: 'hint', text: t('Only if you know when your wallet was made: reading starts there, which is faster. Payments before it are not found. Empty: everything is read.') });
  height.addEventListener('input', () => {
    const v = parseHeight(height.value);
    heightHint.className = `hint${v === false ? ' bad' : ''}`;
    heightHint.textContent = v === false ? t('Use digits only, like 1100000.') : v != null ? t('Reading starts at block {height}. Payments before it are not found.', { height: v.toLocaleString('en-US') }) : t('Only if you know when your wallet was made: reading starts there, which is faster. Payments before it are not found. Empty: everything is read.');
    validate();
  });
  // A date is easier to know than a block: it fills the block in, two days early (nothing missed).
  const date = h('input', { class: 'input', type: 'date', 'aria-label': t('Wallet made around'), 'data-testid': 'restore-date', max: new Date().toISOString().slice(0, 10) });
  date.addEventListener('change', () => {
    const hgt = date.value ? heightForDate(date.value) : null;
    height.value = hgt == null ? '' : String(hgt);
    height.dispatchEvent(new Event('input'));
  });
  pass.el.append(h('label', { class: 'field' }, t('Wallet made around (optional)'), date), h('label', { class: 'field' }, t('Or restore from block'), height), heightHint);

  function build(keep = []) {
    inputs.length = 0;
    boxes.length = 0;
    for (let i = 0; i < count; i++) {
      const input = h('input', {
        type: 'text',
        autocomplete: 'off',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: 'false',
        inputmode: 'text',
        enterkeyhint: i === count - 1 ? 'done' : 'next',
        'aria-label': t('Word {n}', { n: i + 1 }),
        'data-testid': `word-${i + 1}`,
      });
      input.value = keep[i] || '';
      input.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        const parts = splitWords(text);
        if (parts.length > 1) {
          e.preventDefault();
          fill(i, parts);
        }
      });
      input.addEventListener('input', () => {
        const parts = splitWords(input.value);
        if (parts.length > 1) fill(i, parts);
        else validate();
      });
      input.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && i < count - 1) {
          e.preventDefault();
          inputs[i + 1].focus();
        }
      });
      input.addEventListener('blur', validate);
      inputs.push(input);
      boxes.push(h('label', { class: 'word-input' }, h('span', { class: 'n', text: String(i + 1) }), input));
    }
    put(grid, ...boxes);
    put(pickerBox, countPicker(count, (n) => setCount(n)));
  }

  function setCount(n, words = null) {
    if (n === count && !words) return;
    const keep = words || inputs.map((x) => x.value);
    count = n;
    setup.count = n;
    build(keep);
    validate();
  }

  function splitWords(item) {
    return String(item).toLowerCase().split(/[\s,;]+/).map((w) => w.replace(/^\d+[.)]?$/, '')).filter(Boolean);
  }

  function fill(start, parts) {
    // A whole phrase pasted: its length (12, 15, 18, 21 or 24) is decided by what came (PN: another
    // wallet's 18 words had no boxes here).
    if (start === 0 && RESTORE_WORD_COUNTS.includes(parts.length) && parts.length !== count) {
      setCount(parts.length, parts);
      inputs[count - 1].focus();
      return;
    }
    const from = parts.length >= count ? 0 : start;
    parts.slice(0, count - from).forEach((w, k) => (inputs[from + k].value = w));
    const next = Math.min(count - 1, from + parts.length);
    inputs[next].focus();
    validate();
  }

  let checkSeq = 0;
  async function validate() {
    const seq = ++checkSeq;
    const words = inputs.map((x) => x.value.trim().toLowerCase());
    const bad = [];
    words.forEach((w, i) => {
      const ok = w === '' ? null : WORDS.has(w);
      boxes[i].classList.toggle('bad', ok === false && document.activeElement !== inputs[i]);
      if (ok === false) bad.push(i + 1);
    });
    if (bad.length) {
      put(msg, notice('warn', tn({ one: 'Word #{list} isn\'t a recovery word. Check the spelling.', other: 'Words #{list} aren\'t a recovery word. Check the spelling.' }, bad.length, { list: bad.join(', #') })));
      cta.disabled = true;
      return;
    }
    if (parseHeight(height.value) === false) {
      put(msg);
      cta.disabled = true;
      return;
    }
    if (words.every(Boolean)) {
      const v = (await keys()).validateMnemonic(words.join(' '));
      if (seq !== checkSeq) return;
      if (!v.ok) {
        put(msg, notice('warn', t("These words don't form a valid recovery phrase. Check the order and each word.")));
        cta.disabled = true;
        return;
      }
      put(msg, notice('success', tn({ one: 'All {n} word checks out.', other: 'All {n} words check out.' }, count)));
      cta.disabled = false;
      return;
    }
    put(msg);
    cta.disabled = true;
  }

  async function submit() {
    const words = inputs.map((x) => x.value.trim().toLowerCase());
    if (!(await keys()).validateMnemonic(words.join(' ')).ok) return validate();
    const hgt = parseHeight(height.value);
    if (hgt === false) return validate();
    // Already a wallet here (the same words and passphrase): two copies would each keep their own
    // payment records, and neither would know what the other spent (PN). Said before a password.
    const twin = await walletWithWords(words, pass.value()).catch(() => null);
    if (twin) {
      return put(
        msg,
        h(
          'div',
          { 'data-testid': 'restore-same-words' },
          notice('info', h('strong', { text: t('These words are already on this device as "{name}". ', { name: twin.name }) }), t('Open that wallet instead: two copies of one wallet would not know what the other has spent.')),
        ),
      );
    }
    // Adding a wallet: its name and "adding" go along.
    app.setup = { ...setup, mode: 'restore', words, passphrase: pass.value(), birthday: hgt };
    for (const x of inputs) x.value = '';
    app.go('setPassword');
  }

  build();
  const el = screen(
    {
      title: t('Restore your wallet'),
      back: () => {
        app.setup = adding ? { adding: true, name: setup.name } : null;
        app.go(adding ? 'addWallet' : 'welcome');
      },
      actions: [cta],
    },
    h('p', { class: 'step', text: t('Step 1 of 2') }),
    h('p', { class: 'lead', text: t('Enter your recovery words in order. You can paste all of them into the first box.') }),
    pickerBox,
    grid,
    msg,
    pass.el,
    h('p', { class: 'small', text: t('Your coins come back once the wallet has read the blockchain; that can take a while the first time. The words never leave this device.') }),
  );
  return { el };
}
