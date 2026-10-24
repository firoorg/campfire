/* Delete wallet from this device (also: "Forgot your password?")
 * Spec: ONE job: remove this wallet from this device, knowingly.
 *       Primary CTA: "Delete from this device" (enabled only after typing DELETE).
 *       Taps from app open: 3 (Settings -> Delete) / 2 from the unlock screen / 4 for another
 *       wallet (Settings -> Wallets -> its row -> Delete).
 * Exit-intent reasons and answers:
 *   - "Will I lose my money?" -> only if the recovery words (and passphrase, if any) are lost too;
 *     said in one sentence.
 *   - "I forgot my password" -> this is the way back: delete here, restore with the words.
 *   - "Does this delete my other wallets?" -> with several, it names the one that goes and says the
 *     others stay as they are; only its own file and data are removed (lib/wallets.js).
 *   - "Is it really all gone?" -> what Campfire cannot remove is said, small: its Face ID passkey
 *     lives in the password manager (Campfire asks it to forget it; where to check), and, for the
 *     last wallet, the browser may keep deleted data on disk until it tidies up (clearing the
 *     site's data in the browser's settings removes it).
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { wipeWallet } from '../lib/session.js';
import { hasEthWallet, ethWalletKind } from '../lib/eth/record.js';
import { listWallets, nameOf, walletStore } from '../lib/wallets.js';
import { t, tn } from '../lib/i18n.js';

export default function deleteWallet(app, params = {}) {
  const forgot = Boolean(params.forgot);
  // Several wallets: Settings -> Wallets names the one to delete; otherwise it is the selected one.
  const other = Boolean(params.id && !(app.record && app.record.id === params.id));
  if (!app.record && !other) {
    queueMicrotask(() => app.go('welcome'));
    return { el: h('div') };
  }
  const target = other ? { id: params.id, name: params.name, slot0: false } : app.record;
  const name = other ? params.name : nameOf(app.record);
  const passphrase = other ? Boolean(params.passphrase) : Boolean(app.record.passphrase);
  const words = (other ? params.words : app.record.words) || 24;
  const othersBox = h('div');
  const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'aria-label': t('Type {word}', { word: 'DELETE' }), 'data-testid': 'delete-confirm', placeholder: 'DELETE' }); // i18n-ignore: the word typed to confirm, the same in every language
  const msg = h('div');
  // With an Ethereum wallet beside it, its own words (or private key) are needed too: it goes with it.
  const ethBox = h('div');
  const kvP = other ? listWallets().then((l) => {
    const r = l.find((x) => x.id === params.id);
    if (!r) throw new Error('gone');
    return walletStore(r);
  }) : Promise.resolve(undefined);
  kvP.then((kv) => Promise.all([hasEthWallet(kv), ethWalletKind(kv)])).then(([has, known]) => {
    const kind = has ? known || 'words' : null;
    const text =
      kind === 'key'
        ? t('Its private key brings it back; your Firo words do not. Save the key (Settings → Ethereum & BNB → Backup) and keep your Firo words before you delete.')
        : t('Its own words bring it back; your Firo words do not. Keep both sets of words before you delete.');
    if (kind) put(ethBox, h('div', { 'data-testid': 'delete-eth-words', 'data-kind': kind }, notice('warn', h('strong', { text: t('Your Ethereum wallet is removed too. ') }), text)));
  }, () => {});
  const cta = primary(t('Delete from this device'), run, { disabled: true, 'data-testid': 'delete-submit' });
  cta.classList.replace('btn-primary', 'btn-danger');
  input.addEventListener('input', () => (cta.disabled = input.value.trim().toUpperCase() !== 'DELETE'));

  // What stays where Campfire cannot reach it.
  const tracesBox = h('div');
  listWallets().then((l) => {
    if (l.length > 1) put(othersBox, h('p', { class: 'lead', 'data-testid': 'delete-others', text: t('Only {name} is deleted. {value}', { name, value: l.length === 2 ? t('Your other wallet stays as it is.') : tn({ one: 'Your other {n} wallet stays as it is.', other: 'Your other {n} wallets stay as they are.' }, l.length - 1) }) }));
    const r = l.find((x) => x.id === target.id);
    const passkey = Boolean(r && r.envelopes && r.envelopes.passkey);
    put(
      tracesBox,
      passkey ? h('p', { class: 'small', 'data-testid': 'delete-passkey', text: t('Its Face ID key (a passkey for {hostname}, “Campfire Firo wallet {id}”, or “BEAM Campfire wallet {id}” if it was made before this name existed) is kept by your password manager, not by Campfire. Campfire asks it to forget the key; if it is still listed in Passwords or Google Password Manager, delete it there.', { hostname: location.hostname, id: target.id.slice(0, 6) }) }) : null,
      l.length === 1 ? h('p', { class: 'small', 'data-testid': 'delete-traces', text: t("The browser may keep deleted data on its disk for a while. To leave nothing, also clear this site's data in the browser's settings.") }) : null,
    );
  }, () => {});

  async function run() {
    cta.disabled = true;
    cta.textContent = t('Deleting…');
    try {
      const list = await listWallets();
      const rec = list.find((r) => r.id === target.id);
      if (!rec) throw new Error(t('it is not on this device any more'));
      const { others } = await wipeWallet(app, rec);
      if (other) {
        toast(t('{name} was deleted from this device', { name }));
        app.go('wallets', {}, { replace: true });
      } else if (others.length) app.go('unlock', { reason: 'deleted', deleted: name }, { reset: true });
      else app.go('welcome', {}, { reset: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = t('Delete from this device');
      put(msg, notice('error', t('It could not be deleted: {message}', { message: e.message })));
    }
  }

  const el = screen(
    { title: forgot ? t('Forgot your password?') : t('Delete wallet'), back: () => app.back(forgot ? 'unlock' : other ? 'wallets' : 'settings'), actions: [cta] },
    forgot ? h('p', { class: 'lead', text: passphrase ? tn({ one: 'Nobody can reset the password. With your {n} recovery word and your passphrase you can delete the wallet from this device and restore it; your coins come back.', other: 'Nobody can reset the password. With your {n} recovery words and your passphrase you can delete the wallet from this device and restore it; your coins come back.' }, words) : tn({ one: 'Nobody can reset the password. With your {n} recovery word you can delete the wallet from this device and restore it; your coins come back.', other: 'Nobody can reset the password. With your {n} recovery words you can delete the wallet from this device and restore it; your coins come back.' }, words) }) : null,
    notice('warn', h('strong', { text: passphrase ? tn({ one: 'Only your {n} recovery word and your passphrase (or an encrypted backup file and its password) can bring this wallet back. ', other: 'Only your {n} recovery words and your passphrase (or an encrypted backup file and its password) can bring this wallet back. ' }, words) : tn({ one: 'Only your {n} recovery word (or an encrypted backup file and its password) can bring this wallet back. ', other: 'Only your {n} recovery words (or an encrypted backup file and its password) can bring this wallet back. ' }, words) }), t('If you do not have them, stop here: deleting without them loses the money for good.')),
    ethBox,
    h('p', { class: 'lead', 'data-testid': 'delete-what', text: t('This removes {name}, its history and its settings from this device. Nothing is changed on the blockchain.', { name }) }),
    othersBox,
    h('label', { class: 'field' }, t('Type {word} to confirm', { word: 'DELETE' }), input),
    msg,
    tracesBox,
  );
  return { el };
}
