/* Import an Ethereum wallet (step 1 of 2)
 * Spec: ONE job: bring an Ethereum wallet here from its recovery words or its private key.
 *       Primary CTA: "Import Ethereum wallet" (enabled once what was typed checks out).
 *       Taps from app open: 2 (Home -> Ethereum -> Import), then paste.
 * Exit-intent reasons and answers:
 *   - "Words or key, which do I pick?" -> neither: one box, and the app tells which it is.
 *   - "Did I type it right?" -> checked as you type: the word count, which word is unknown, that
 *     the words don't fit together, or what a private key looks like - never just "invalid".
 *   - "Is this the right account?" -> a private key shows the address it opens before anything
 *     is saved, to compare with the other wallet.
 *   - "My wallet had a passphrase" -> under Advanced, for words only; most people never set one.
 *   - "Will this show my coins?" -> the next screen says what the server sees, then the balance
 *     shows; a wrong passphrase opens another, empty wallet, which is said next to the field.
 *   - "Is it stored?" -> the words are not: only the key, locked with this wallet's password.
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary } from '../lib/ui.js';
import { mnemonicProblem, normalizeMnemonic, secretKind, privateKeyProblem, privateKeyFromText, privateKeyToAddress, wipe } from '../lib/eth/crypto.js';
import { t, tn, tNodes } from '../lib/i18n.js';

/** What to say under the box for words: {text, cls}. Still typing is not an error. */
function wordsHint(p, count) {
  if (!p) return { text: tn({ one: '{n} word. It checks out.', other: '{n} words. They check out.' }, count), cls: 'good' };
  if (p.code === 'length') {
    if (count < 12) return { text: tn({ one: '{n} of 12 words so far.', other: '{n} of 12 words so far.' }, count), cls: '' };
    if (count < 24) return { text: tn({ one: '{n} word so far. Ethereum words come in sets of 12, 15, 18, 21 or 24.', other: '{n} words so far. Ethereum words come in sets of 12, 15, 18, 21 or 24.' }, count), cls: '' };
    return { text: tn({ one: 'That\'s {n} word. Ethereum words come in sets of 12 to 24.', other: 'That\'s {n} words. Ethereum words come in sets of 12 to 24.' }, count), cls: 'bad' };
  }
  if (p.code === 'word') return { text: t('Word #{position} isn\'t one of the words wallets use. Check its spelling on your paper.', { position: p.position }), cls: 'bad' };
  return { text: t("All the words are real ones, but they don't fit together: one may be mistyped or in the wrong place."), cls: 'bad' };
}

/** The same for a private key; `address` once it is a valid one (shown as it opens, so it can be compared). */
function keyHint(p, address) {
  if (!p) return { text: tNodes("This opens {address}. Check it's the account you expect.", { address: h('strong', { class: 'addr-inline', text: shorten(address, 6, 4) }) }), cls: 'good' };
  if (p.code === 'range') return { text: t('That private key is not valid. Copy it again from the wallet it came from.'), cls: 'bad' };
  if (p.hex && p.length < 64) return { text: tn({ one: '{n} of 64 characters so far.', other: '{n} of 64 characters so far.' }, p.length), cls: '' };
  return { text: t("That isn't a private key: it needs 64 characters, 0–9 and a–f."), cls: 'bad' };
}

/** Drops whatever an earlier visit left in app.ethSetup: words, a key. */
function forgetTyped(s) {
  if (!s) return;
  if (Array.isArray(s.words)) s.words.fill('');
  if (s.sk) wipe(s.sk);
  delete s.words;
  delete s.sk;
  delete s.address;
  delete s.kind;
  delete s.passphrase;
}

export default function ethImport(app) {
  if (!app.ethSetup || app.ethSetup.mode !== 'import') app.ethSetup = { mode: 'import', from: 'home' };
  forgetTyped(app.ethSetup);
  const area = h('textarea', { class: 'input', rows: 4, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: t('word1 word2 word3 … or 0x…'), 'aria-label': t('Recovery words or private key'), 'data-testid': 'eth-words-input', 'data-autofocus': true });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': t('Passphrase'), placeholder: t('Passphrase'), 'data-testid': 'eth-passphrase' });
  const hint = h('p', { class: 'hint', 'data-testid': 'eth-words-hint' });
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'eth-paste' }, icon('paste'), t('Paste'));
  const cta = primary(t('Import Ethereum wallet'), go, { disabled: true, 'data-testid': 'eth-import-submit' });
  const advanced = h(
    'details',
    { class: 'more', 'data-testid': 'eth-advanced' },
    h('summary', { text: t('Advanced') }),
    h('label', { class: 'field' }, t('Passphrase (only if you set one)'), pass),
    h('p', { class: 'small', text: t('A few wallets let you add a passphrase to the words. Leave this empty if you never set one: a wrong passphrase opens a different, empty wallet.') }),
  );

  /** {kind, words} or {kind, address} when what was typed can be imported, else null. */
  function check() {
    const kind = secretKind(area.value);
    let out = null;
    let shown;
    if (kind === 'key') {
      const p = privateKeyProblem(area.value);
      let address = null;
      if (!p) {
        const sk = privateKeyFromText(area.value);
        address = privateKeyToAddress(sk);
        wipe(sk);
        out = { kind, address };
      }
      shown = keyHint(p, address);
      hint.dataset.address = address || '';
    } else {
      const words = normalizeMnemonic(area.value);
      const count = words ? words.split(' ').length : 0;
      const p = mnemonicProblem(words);
      shown = count === 0 ? { text: '', cls: '' } : wordsHint(p, count);
      if (!p) out = { kind: 'words', words };
      hint.dataset.address = '';
    }
    put(hint, ...[].concat(shown.text));
    hint.className = `hint${shown.cls ? ` ${shown.cls}` : ''}`;
    hint.dataset.kind = kind;
    area.classList.toggle('bad', shown.cls === 'bad');
    // A passphrase belongs to words; a private key has none.
    advanced.classList.toggle('hidden', kind === 'key');
    cta.disabled = !out;
    return out;
  }

  function go() {
    const ok = check();
    if (!ok) return;
    if (ok.kind === 'key') {
      const sk = privateKeyFromText(area.value);
      app.ethSetup = { ...app.ethSetup, kind: 'key', sk, address: privateKeyToAddress(sk) };
    } else {
      app.ethSetup = { ...app.ethSetup, kind: 'words', words: ok.words.split(' '), passphrase: pass.value };
    }
    area.value = '';
    pass.value = '';
    app.go('ethPrivacy', { setup: true });
  }

  area.addEventListener('input', check);
  pasteBtn.addEventListener('click', async () => {
    try {
      area.value = (await navigator.clipboard.readText()).trim();
      check();
    } catch {
      put(hint, t('Press and hold in the box, then tap Paste.'));
      area.focus();
    }
  });
  check();

  const el = screen(
    {
      title: t('Import Ethereum wallet'),
      back: () => {
        const from = app.ethSetup && app.ethSetup.from;
        forgetTyped(app.ethSetup);
        app.ethSetup = null;
        app.back('ethStart', { from });
      },
      actions: [cta],
    },
    h('p', { class: 'step', text: t('Step 1 of 2') }),
    h('p', { class: 'lead', text: t("Enter your Ethereum wallet's recovery words, in order, or its private key.") }),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: t('Recovery words or private key') }), pasteBtn), area),
    hint,
    advanced,
    h('p', { class: 'small', text: t('Words are not stored. Only the private key is kept, locked with your Firo PWA password.') }),
  );
  return {
    el,
    destroy() {
      area.value = '';
      pass.value = '';
    },
  };
}
