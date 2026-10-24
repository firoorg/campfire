/* Recovery words (create, step 1 of 3) / Backup (Settings, for the wallet on this device)
 * Spec (create): ONE job: write down the recovery words (24, or 12 if chosen).
 *       Primary CTA: "I wrote them down" (enabled after the words are shown).
 *       Taps from app open: 1 (Welcome -> Create).
 * Spec (Settings -> Backup): ONE job: say what brings this wallet back, and hand out a copy.
 *       Primary CTA: "Show my recovery words" (after the password: never Face ID alone, P2).
 *       Secondary: "Save an encrypted backup file", and the optional cloud copy.
 *       Taps from app open: 2 (Settings -> Backup), 3 to the words.
 * Exit-intent reasons and answers:
 *   - "Why do I need this?" -> one sentence: the words are the wallet; they bring it back on any device.
 *   - "Someone could see my screen" -> words stay blurred until tapped, and blur again (Settings:
 *     the sheet closes) as soon as the app is left, so the app switcher's picture never shows them.
 *   - "Can I screenshot it?" -> we say no, and why (photos sync to the cloud).
 *   - "24 words is a lot" -> "Use 12 words instead", one tap; both are as safe for a phone wallet.
 *   - "What is a passphrase?" -> behind Advanced, with what it means: a 25th word you must also keep.
 *   - "Will it open in the Campfire app?" -> yes: the same words, the same wallet (BIP39, Campfire's paths).
 *   - "Can it go to iCloud?" -> optional card "Keep a copy in iCloud Drive" (other platforms: "your
 *     cloud storage"): an encrypted backup file with a password of at least 12 characters (a file in
 *     the cloud can be attacked offline), and the exact taps to put it there and to bring it back
 *     (Welcome -> Restore from a backup file). Never offered unasked, never automatic.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, toast, focusSoon, textButton, onHidden } from '../lib/ui.js';
import { keys } from '../lib/chain.js';
import { openWithPasswordFor, markExported, isAdding, openSeedFor, MIN_PASSWORD, markWordsConfirmed } from '../lib/session.js';
import { passwordWeakness } from '../lib/password_strength.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { hasEthWallet } from '../lib/eth/record.js';
import { deliverExport, cloudPlatform, formatFileSize } from '../lib/export.js';
import { makeBackupFile, CLOUD_MIN_PASSWORD } from '../lib/backup_file.js';
import { nameOf } from '../lib/wallets.js';
import { t, tn, dateLocale } from '../lib/i18n.js';

/**
 * Recovery words in a grid that stays blurred until tapped (no shoulder
 * surfing), and blurred again whenever the app goes out of sight (the app
 * switcher keeps a picture of the last screen). fill(words) puts them in;
 * onReveal runs each time they are shown; hide() blurs them; destroy() stops
 * watching (a grid taken off the page stops by itself). Also used for the
 * Ethereum wallet's words (screens/eth_words.js).
 */
export function wordReveal(onReveal) {
  const grid = h('div', { class: 'words hidden-words', 'data-testid': 'words' });
  const cover = h('div', { class: 'cover' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'reveal' }, icon('eye'), t('Tap to show the words')));
  const el = h('div', { class: 'reveal' }, grid, cover);
  cover.querySelector('button').addEventListener('click', () => {
    grid.classList.remove('hidden-words');
    cover.remove();
    onReveal();
  });
  const hide = () => {
    grid.classList.add('hidden-words');
    if (!cover.isConnected) el.appendChild(cover);
  };
  const off = onHidden(() => (el.isConnected ? hide() : off()));
  return {
    el,
    fill: (words) => put(grid, ...words.map((w, i) => h('div', { class: 'word' }, h('span', { class: 'n', text: String(i + 1) }), h('span', { text: w })))),
    hide,
    destroy: off,
  };
}

/**
 * The passphrase field behind "Advanced" (create and restore). Returns {el, value(), ok()}. Typed once
 * and never shown, a typo locked the coins behind a passphrase nobody knew (public audit, P10): it
 * can be shown, and a new one is typed twice; ok() is false while the two differ. onChange: any edit.
 */
export function passphraseField(setup, { restoring = false, onChange = () => {} } = {}) {
  const field = (attrs) => h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...attrs });
  const input = field({ 'aria-label': t('BIP39 passphrase'), 'data-testid': 'passphrase' });
  const again = restoring ? null : field({ 'aria-label': t('The same passphrase again'), 'data-testid': 'passphrase2' });
  const hint = h('p', { class: 'hint', 'data-testid': 'passphrase-hint', 'aria-live': 'polite' });
  input.value = (setup && setup.passphrase) || '';
  if (again) again.value = input.value;
  const ok = () => !again || input.value === again.value;
  const check = () => {
    const differ = Boolean(again && again.value && !ok());
    hint.textContent = differ ? t('The two passphrases are not the same yet.') : '';
    hint.className = differ ? 'hint bad' : 'hint'; // i18n-ignore: class names
  };
  const show = h('input', {
    type: 'checkbox',
    'data-testid': 'passphrase-show',
    onchange: (e) => {
      for (const f of [input, again]) if (f) f.type = e.target.checked ? 'text' : 'password';
    },
  });
  for (const f of [input, again]) {
    if (!f) continue;
    f.addEventListener('input', () => {
      if (setup) setup.passphrase = input.value;
      check();
      onChange();
    });
  }
  const el = h(
    'details',
    { class: 'advanced', 'data-testid': 'advanced', open: input.value ? true : null },
    h('summary', { text: restoring ? t('Advanced: passphrase, starting block') : t('Advanced: passphrase') }),
    h(
      'p',
      { class: 'small', text: restoring ? t('If the recovery phrase you are restoring was created with an optional BIP39 passphrase, enter it here. Without it you get a different, empty wallet.') : t('Optional. A passphrase works like an extra word: the wallet opens only with the words AND the passphrase. Lose either and the money is gone. Leave it empty unless you know you want one.') },
    ),
    h('label', { class: 'field' }, t('BIP39 passphrase'), input),
    again ? h('label', { class: 'field' }, t('The same passphrase again'), again) : null,
    hint,
    h('label', { class: 'check-row' }, show, h('span', { text: t('Show the passphrase') })),
  );
  return { el, value: () => input.value, ok };
}

export default function backup(app) {
  // A wallet already lives on this device: never make new words here, unless another is being made
  // (Add a wallet -> Create a new wallet).
  const adding = isAdding(app) && app.setup.mode === 'create';
  if (app.record && !adding) return existingBackup(app);
  if (!app.setup || app.setup.mode !== 'create') app.setup = { mode: 'create' };
  const setup = app.setup;
  const count = setup.count === 12 ? 12 : 24;
  // On once the words were shown, and while a passphrase typed is the same both times (P10).
  let revealed = false;
  const cta = primary(t('I wrote them down'), () => pass.ok() && app.go('confirmWords'), { disabled: true, 'data-testid': 'wrote-down' });
  const reveal = wordReveal(() => {
    revealed = true;
    cta.disabled = !pass.ok();
  });
  const status = h('p', { class: 'small', text: t('Making your words…') });
  const pass = passphraseField(setup, { onChange: () => (cta.disabled = !revealed || !pass.ok()) });

  (async () => {
    try {
      if (!setup.words || setup.words.length !== count) setup.words = (await keys()).generateMnemonic(count).split(' ');
      reveal.fill(setup.words);
      status.textContent = '';
    } catch (e) {
      status.textContent = t('The words could not be made: {message}. Reload the page to try again.', { message: e.message });
    }
  })();

  const other = count === 24 ? 12 : 24;
  const switchCount = textButton(tn({ one: 'Use {n} word instead', other: 'Use {n} words instead' }, other), () => {
    if (setup.words) setup.words.fill('');
    setup.words = null;
    setup.count = other;
    app.go('backup', {}, { replace: true });
  }, { 'data-testid': 'word-count' });

  const el = screen(
    {
      title: tn({ one: 'Your {n} word', other: 'Your {n} words' }, count),
      back: () => {
        if (setup.words) setup.words.fill('');
        app.setup = adding ? { adding: true, name: setup.name } : null;
        app.go(adding ? 'addWallet' : 'welcome');
      },
      actions: [cta],
    },
    h('p', { class: 'step', text: t('Step 1 of 3') }),
    h('p', { class: 'lead', text: t('These words are your wallet. With them you can open it on any device, in Campfire or another Firo wallet, even if this phone is lost.') }),
    notice('warn', h('strong', { text: t('Write them on paper, in order. ') }), t('Anyone who sees them can take your money. No screenshots: photos sync to the cloud.')),
    reveal.el,
    status,
    h('div', { class: 'btn-row center' }, switchCount),
    pass.el,
  );
  return { el, destroy: reveal.destroy };
}

/** Settings -> Backup: what brings the wallet on this device back. */
function existingBackup(app) {
  if (!app.dbPass) {
    queueMicrotask(() => app.go('unlock'));
    return { el: h('div') };
  }
  const r = app.record;
  if (r.watchOnly) {
    // No words and nothing secret to back up: the view key it was made from watches it anywhere.
    const el = screen(
      { title: t('Backup'), back: () => app.back('settings') },
      h('div', { 'data-testid': 'watch-backup' }, notice('info', h('strong', { text: t('This is a watch-only wallet. ') }), t('It has no recovery words and cannot spend, so there is nothing to back up. To watch it on another device, use the same Spark view key there.'))),
    );
    return { el };
  }
  const fileCard = h(
    'div',
    { class: 'card', 'data-testid': 'file-card' },
    h('h3', { text: t('Encrypted backup file') }),
    h('p', { text: t('Your recovery words, passphrase and wallet name in one small file that opens only with a password. Welcome → "Restore from a backup file" brings the wallet back on any device.') }),
    h('p', { class: 'small', 'data-testid': 'export-last', text: r.exportedAt ? t('Last saved {when}.', { when: new Date(r.exportedAt).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) }) : t('Not saved yet.') }),
    h('button', { class: 'btn btn-secondary card-btn', onclick: () => fileSheet(app, { cloud: false }), 'data-testid': 'export-start' }, icon('download'), t('Save an encrypted backup file')),
  );
  // The Ethereum & BNB wallet has its own words or key: none of this brings it back (P11). Said
  // once it is known to be there (read without loading any Ethereum code).
  const ethNote = h('div');
  hasEthWallet()
    .then((has) => {
      if (!has) return;
      put(
        ethNote,
        h(
          'div',
          { 'data-testid': 'eth-not-included' },
          notice(
            'warn',
            h('strong', { text: t('Your Ethereum & BNB wallet is not in these words or the file. ') }),
            t('It has its own words or private key: back it up in its settings too, or its coins cannot be brought back.'),
          ),
          h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'eth-backup-go', onclick: () => app.go('ethSettings') }, t('Ethereum & BNB backup')),
        ),
      );
    })
    .catch(() => {});
  const el = screen(
    { title: t('Backup'), back: () => app.back('settings'), actions: [primary(t('Show my recovery words'), () => showWords(app), { 'data-testid': 'show-words' })] },
    ethNote,
    h('div', { 'data-testid': 'phrase-backup' }, notice('info', h('strong', { text: tn({ one: 'Your {n} recovery word is this wallet\'s backup. ', other: 'Your {n} recovery words are this wallet\'s backup. ' }, r.words || 24) }), r.passphrase ? t('With them and your passphrase you can restore it on any device.') : t('With them you can restore it on any device.'))),
    r.passphrase ? h('p', { class: 'small', 'data-testid': 'passphrase-note', text: t('This wallet also has a BIP39 passphrase. The words alone open a different, empty wallet: keep the passphrase as safe as the words.') }) : null,
    fileCard,
    cloudCard(app),
    notice('warn', h('strong', { text: t('The words, or the file with its password, are your wallet. ') }), t('Anyone who has them can take your money. Keep them private.')),
  );
  return { el };
}

/** The password (never Face ID alone: P2), then the words in a sheet, blurred until tapped. */
async function showWords(app) {
  if (!(await confirmIdentity(app, { title: t('Show your recovery words'), detail: t('Make sure nobody can see your screen.'), cta: t('Show the words'), passwordOnly: true }))) return;
  let seed;
  try {
    seed = await openSeedFor(app);
  } catch (e) {
    return toast(t('The words could not be read: {message}', { message: e.message }), 5000);
  }
  const words = seed.mnemonic.split(' ');
  // Shown with the words (P10: it was never shown, and a typo made at the start stayed unseen).
  const passphrase = seed.passphrase ? String(seed.passphrase) : '';
  seed = null;
  const passBox = passphrase
    ? h('p', { class: 'small', 'data-testid': 'words-passphrase' }, t('Plus your BIP39 passphrase, exactly as here: '), h('span', { class: 'mono wrap', 'data-testid': 'words-passphrase-text', text: passphrase }))
    : null;
  const reveal = wordReveal(() => {});
  reveal.fill(words);
  // A wallet from a backup file: its words were never shown before; saying so ends Home's reminder.
  const firstTime = app.record.wordsConfirmed === false;
  const sheet = openSheet((close) => [
    h('h2', { text: tn({ one: 'Your {n} word', other: 'Your {n} words' }, words.length) }),
    notice('warn', t('Write them on paper, in order. No screenshots.')),
    reveal.el,
    passBox,
    h('button', {
      class: 'btn btn-primary',
      'data-testid': 'words-done',
      onclick: async () => {
        if (firstTime) await markWordsConfirmed(app).catch(() => {});
        close();
      },
    }, firstTime ? t('I wrote them down') : t('Done')),
  ], { label: t('Your recovery words') });
  // Off the page as soon as the sheet goes, on lock, and when the app goes out of sight (the app
  // switcher's picture must not carry them; the password shows them again).
  const wipe = () => {
    words.fill('');
    if (passBox) passBox.textContent = '';
    sheet.close();
  };
  app.lockHooks.add(wipe);
  const offHidden = onHidden(wipe);
  sheet.then(() => {
    words.fill('');
    if (passBox) passBox.textContent = '';
    reveal.destroy();
    offHidden();
    app.lockHooks.delete(wipe);
  });
}

/** Words for the cloud copy, per platform (cloudPlatform). Exported for the tests. */
export function cloudText(where) {
  const apple = where === 'ios' || where === 'mac';
  const place = apple ? t('iCloud Drive') : t('your cloud storage');
  // Whole sentences per platform: the place and the device change their words' form in other languages.
  return {
    place,
    apple,
    title: apple ? t('Keep a copy in iCloud Drive') : t('Keep a copy in your cloud storage'),
    lead: where === 'mac'
      ? t('Optional. If this computer is lost, open Firo PWA anywhere, choose Restore from a backup file and pick the copy in iCloud Drive.')
      : apple
        ? t('Optional. If this phone is lost, open Firo PWA anywhere, choose Restore from a backup file and pick the copy in iCloud Drive.')
        : t('Optional. If this phone is lost, open Firo PWA anywhere, choose Restore from a backup file and pick the copy in your cloud storage.'),
    lock: apple
      ? tn({ one: 'The copy is encrypted (AES-256) and opens only with its password. Apple cannot open it, but anyone who gets into your account can keep guessing the password, so it must be at least {n} character.', other: 'The copy is encrypted (AES-256) and opens only with its password. Apple cannot open it, but anyone who gets into your account can keep guessing the password, so it must be at least {n} characters.' }, CLOUD_MIN_PASSWORD)
      : tn({ one: 'The copy is encrypted (AES-256) and opens only with its password. The cloud service cannot open it, but anyone who gets into your account can keep guessing the password, so it must be at least {n} character.', other: 'The copy is encrypted (AES-256) and opens only with its password. The cloud service cannot open it, but anyone who gets into your account can keep guessing the password, so it must be at least {n} characters.' }, CLOUD_MIN_PASSWORD),
    cta: apple ? t('Save a copy to iCloud Drive') : t('Save a copy to the cloud'),
    save: where === 'ios' ? t('Save to iCloud Drive') : where === 'mac' ? t('Save the file') : t('Save to the cloud'),
    steps:
      where === 'ios'
        ? [t(`Tap “Save to iCloud Drive”.`), t('In the list that opens, choose “Save to Files”.'), t('Choose iCloud Drive, then Save.')]
        : where === 'mac'
          ? [t('Tap “Save the file”: it goes to your Downloads folder.'), t('In Finder, move it into iCloud Drive.')]
          : [t('Tap “Save to the cloud”.'), t('Choose your cloud storage in the list (for example Google Drive), or open your downloads and move it there.')],
    // how: what deliverExport did ('shared' through the share sheet, or 'downloaded').
    done: (how) =>
      how === 'shared'
        ? where === 'ios'
          ? t('Saved. Check Files → iCloud Drive for the copy.')
          : t('Saved. Check your cloud storage for the copy.')
        : where === 'mac'
          ? t('Saved to Downloads. Move it into iCloud Drive in Finder.')
          : where === 'ios'
            ? t('Saved to your downloads. Move it into iCloud Drive in Files.')
            : t('Saved to your downloads. Move it to your cloud storage.'),
  };
}

/** Settings -> Backup: the optional card for a copy in the person's cloud. */
function cloudCard(app) {
  const item = cloudText(cloudPlatform());
  return h(
    'div',
    { class: 'card', 'data-testid': 'cloud-card' },
    h('h3', { text: item.title }),
    h('p', { text: item.lead }),
    h('p', { class: 'small', text: item.lock }),
    h('button', { class: 'btn btn-secondary card-btn', onclick: () => fileSheet(app, { cloud: true }), 'data-testid': 'cloud-start' }, icon('cloud'), item.cta),
  );
}

/**
 * The encrypted backup file (cloud: the copy for the person's cloud): Campfire password (who is
 * asking) -> when it is shorter than the file needs (any file: MIN_PASSWORD; a cloud copy:
 * CLOUD_MIN_PASSWORD) or easy to guess (a password set before the rules, lib/password_strength.js),
 * a stronger one for this file only -> prepare -> a fresh tap to save it. A file can be guessed at
 * offline like this device's data, so it takes the same rules.
 */
function fileSheet(app, { cloud }) {
  const where = cloudPlatform();
  const item = cloudText(where);
  const minPw = cloud ? CLOUD_MIN_PASSWORD : MIN_PASSWORD;
  let step = 'who';
  let filePw = null;
  let sameAsApp = false;
  let file = null;
  let busy = false;
  let message = null;
  const p = cloud ? 'cloud' : 'export';
  // Not saved by the browser (any of them): a password kept in the same account as the copy, or in
  // the same browser profile as the wallet, would protect nothing.
  const field = (attrs) => h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...attrs });
  const pw = field({ 'aria-label': t('Firo PWA password'), placeholder: t('Password'), 'data-testid': `${p}-pw` });
  const pw1 = field({ 'aria-label': t('Password for the file'), placeholder: tn({ one: 'At least {n} character', other: 'At least {n} characters' }, minPw), 'data-testid': `${p}-pw1` });
  const pw2 = field({ 'aria-label': t('The same password again'), placeholder: t('The same password again'), 'data-testid': `${p}-pw2` });
  const title = cloud ? item.cta : t('Save an encrypted backup file');
  openSheet((close, rerender) => {
    const prepare = async () => {
      busy = true;
      message = h('p', { class: 'small', 'data-testid': `${p}-busy`, text: t('Encrypting the file…') });
      rerender();
      try {
        let seed = await openSeedFor(app);
        file = await makeBackupFile({ mnemonic: seed.mnemonic, passphrase: seed.passphrase, birthday: app.record.birthday, name: nameOf(app.record) }, filePw);
        seed = null;
        filePw = null;
        message = null;
        step = 'save';
      } catch (e) {
        message = notice('error', t('The file could not be made: {message} Your wallet is unchanged.', { message: e.message }));
      }
      busy = false;
      rerender();
    };
    const who = async () => {
      if (busy) return;
      if (!pw.value) {
        message = notice('warn', t('Enter your Firo PWA password.'));
        return rerender();
      }
      busy = true;
      rerender();
      try {
        await openWithPasswordFor(app, pw.value);
      } catch (e) {
        busy = false;
        message = notice('error', e.code === 'wrong_secret' ? t("That password didn't match. Try again.") : e.message);
        return rerender();
      }
      busy = false;
      message = null;
      if (!passwordWeakness(pw.value, { min: minPw })) {
        filePw = pw.value;
        sameAsApp = true;
        pw.value = '';
        return prepare();
      }
      pw.value = '';
      step = 'choose';
      rerender();
    };
    const chosen = () => {
      if (busy) return;
      const weak = passwordWeakness(pw1.value, { min: minPw });
      if (weak) {
        message = notice('warn', weak.text);
        return rerender();
      }
      if (pw1.value !== pw2.value) {
        message = notice('warn', t("The two passwords don't match."));
        return rerender();
      }
      filePw = pw1.value;
      pw1.value = '';
      pw2.value = '';
      prepare();
    };
    // A block body: an on… property handler that returns false cancels the key, so every letter but
    // Enter was dropped ("I can't type there, only Paste").
    pw.onkeydown = (e) => {
      if (e.key === 'Enter') who();
    };
    pw2.onkeydown = (e) => {
      if (e.key === 'Enter') chosen();
    };
    const cancel = h('button', { class: 'btn btn-text', onclick: () => close(), 'data-testid': `${p}-cancel` }, t('Cancel'));
    if (step === 'who') {
      focusSoon(pw);
      return [
        h('h2', { text: title }),
        h('p', { class: 'lead', text: cloud ? t('Enter your Firo PWA password.') : t('Enter your Firo PWA password. The file opens with it (or with a stronger one you choose next, if yours is short or common).') }),
        h('label', { class: 'field' }, t('Password'), pw),
        message,
        h('button', { class: 'btn btn-primary', onclick: who, disabled: busy, 'data-testid': `${p}-continue` }, busy ? t('Checking…') : t('Continue')),
        cancel,
      ];
    }
    if (step === 'choose') {
      focusSoon(pw1);
      return [
        h('h2', { text: t('Choose a password for the file') }),
        h('p', { class: 'lead', 'data-testid': `${p}-choose-lead`, text: cloud ? (item.apple ? tn({ one: 'Your Firo PWA password is too easy to guess for a file kept in iCloud Drive. Choose one of at least {n} character, not a common one, for this copy. You need it to open the copy, so write it down, not in the same account as the copy.', other: 'Your Firo PWA password is too easy to guess for a file kept in iCloud Drive. Choose one of at least {n} characters, not a common one, for this copy. You need it to open the copy, so write it down, not in the same account as the copy.' }, minPw) : tn({ one: 'Your Firo PWA password is too easy to guess for a file kept in your cloud storage. Choose one of at least {n} character, not a common one, for this copy. You need it to open the copy, so write it down, not in the same account as the copy.', other: 'Your Firo PWA password is too easy to guess for a file kept in your cloud storage. Choose one of at least {n} characters, not a common one, for this copy. You need it to open the copy, so write it down, not in the same account as the copy.' }, minPw)) : tn({ one: 'Choose a password of at least {n} character, not a common one, for the file. You need it to open the file, so write it down.', other: 'Choose a password of at least {n} characters, not a common one, for the file. You need it to open the file, so write it down.' }, minPw) }),
        h('label', { class: 'field' }, t('Password for the file'), pw1),
        h('label', { class: 'field' }, t('Again'), pw2),
        message,
        h('button', { class: 'btn btn-primary', onclick: chosen, disabled: busy, 'data-testid': `${p}-prepare` }, busy ? t('Preparing…') : t('Make the file')),
        cancel,
      ];
    }
    return [
      h('h2', { text: t('Your backup file is ready') }),
      h('div', { class: 'card file-card' }, h('span', { class: 'ico' }, icon('file')), h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': `${p}-name`, text: file.name }), h('div', { class: 's', 'data-testid': `${p}-opens-with`, text: sameAsApp ? t('{size} · opens with your Firo PWA password', { size: formatFileSize(file.size) }) : t('{size} · opens with the password you chose', { size: formatFileSize(file.size) }) }))),
      cloud ? h('ol', { class: 'steps-list', 'data-testid': 'cloud-steps' }, ...item.steps.map((s) => h('li', { text: s }))) : notice('warn', t('Keep it private: this file and its password are your wallet.')),
      h(
        'button',
        {
          class: 'btn btn-primary',
          'data-testid': `${p}-save`,
          onclick: async () => {
            const how = await deliverExport(file, { download: cloud && where === 'mac', title: t('Firo PWA backup') });
            if (how === 'cancelled') return;
            await markExported(app).catch(() => {});
            toast(cloud ? item.done(how) : how === 'shared' ? t('Backup file shared') : t('Backup file saved to your downloads'));
            close();
          },
        },
        icon(cloud ? 'cloud' : 'download'),
        cloud ? item.save : t('Save the backup file'),
      ),
      h('button', { class: 'btn btn-text', onclick: () => close() }, t('Done')),
    ];
  }, { label: title });
}
