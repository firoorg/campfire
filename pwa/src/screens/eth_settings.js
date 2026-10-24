/* Settings -> Ethereum & BNB
 * Spec: ONE job: choose how the Ethereum & BNB wallet connects, and know what its backup is.
 *       Primary CTA: none (a list, like Settings); "Remove Ethereum wallet" is last and asks for the password.
 *       Taps from app open: 2 (Settings -> Ethereum & BNB), 3 for any item; the private key is
 *       3 + the password (or Face ID).
 * Exit-intent reasons and answers:
 *   - "Which server should I pick?" -> one row per chain (Ethereum, BNB Chain) names the server in
 *     use and opens its screen: every listed server checked live, "Use this one". Each sees the IP
 *     with the address, so only the one picked is ever asked about it - no silent fallback.
 *   - "Can I use my own node?" -> yes, on that same screen ("Your own server"), checked first.
 *   - "Who knows my history?" -> the history switch says who is asked, and what is shown when it's off.
 *   - "Where are my Ethereum words?" -> not on this device: the person's paper is the backup.
 *   - "Imported from a private key: what is my backup?" -> that key, shown here after the password,
 *     with a copy button and the warning that nothing else brings the wallet back. Copy empties
 *     the clipboard again after a minute, and says so.
 *   - "How do I move this account to another wallet?" -> "Show private key", for words wallets too.
 *   - "Someone could see my screen" -> blurred until tapped, hidden again when the app is left.
 *   - "Will removing it lose my coins?" -> only without the words (or the key); said before the
 *     password is asked.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast, notice, openSheet, copySecret, onHidden } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { getEthRecord, ethRecordKind, withEthKey } from '../lib/eth/vault.js';
import { bytesToHex } from '../lib/eth/hex.js';
import { ethPrefs, evmPrefs, removeEthWallet } from '../lib/eth/wallet.js';
import { loadOutbox, isOpen, entryWords, entryChain } from '../lib/eth/outbox.js';
import { CHAINS } from '../lib/eth/chains.js';
import { t, tk, tn } from '../lib/i18n.js';

const MASK = '•'.repeat(64);
const KEY_WARNING = tk('The private key is the only way back to it: keep it somewhere safe and never share it.');

/**
 * The private key, blurred until the person confirms it is them; then shown
 * with Copy and Hide. Nothing is decrypted before that: the blur covers dots,
 * not the key. A JS string cannot be zeroed, so the shown key lives only in
 * this element and is dropped on Hide, on leaving the app and with the screen.
 */
function keyReveal(app, { onHide = null } = {}) {
  let hex = null;
  const text = h('p', { class: 'mono', 'data-testid': 'eth-key-text', 'aria-label': t('Private key, hidden'), text: MASK });
  const showBtn = h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'eth-key-reveal' }, icon('eye'), t('Tap to show the private key'));
  const cover = h('div', { class: 'cover' }, showBtn);
  const copyBtn = h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'eth-key-copy', onclick: () => hex && copySecret(hex, t('Private key copied'), { app }) }, icon('copy'), t('Copy'));
  const hideBtn = h('button', { class: 'btn btn-text btn-small', 'data-testid': 'eth-key-hide', onclick: () => hide() }, t('Hide'));
  const tools = h('div', { class: 'btn-row key-actions hidden' }, copyBtn, hideBtn);
  const box = h('div', { class: 'key-box masked', 'data-testid': 'eth-key-box', 'data-state': 'masked' }, text);
  const el = h('div', {}, h('div', { class: 'reveal' }, box, cover), tools);

  function hide() {
    if (!hex && box.dataset.state === 'masked') return;
    hex = null;
    text.textContent = MASK;
    text.setAttribute('aria-label', t('Private key, hidden'));
    box.classList.add('masked');
    box.dataset.state = 'masked';
    tools.classList.add('hidden');
    if (!cover.isConnected) box.after(cover);
    if (onHide) onHide();
  }

  /** Asks for the password (never Face ID alone: P2), then opens the sealed key. true once shown. */
  async function show() {
    const ok = await confirmIdentity(app, { title: t('Show the private key'), detail: t('Anyone who sees it can take your Ethereum coins. Make sure no one is looking.'), cta: t('Show private key'), passwordOnly: true });
    if (!ok) return false;
    try {
      hex = await withEthKey(app, async ({ sk }) => bytesToHex(sk, false));
    } catch (e) {
      toast(t('The key could not be opened: {message}', { message: e.message }));
      return false;
    }
    text.textContent = hex;
    text.removeAttribute('aria-label');
    box.classList.remove('masked');
    box.dataset.state = 'shown';
    cover.remove();
    tools.classList.remove('hidden');
    return true;
  }

  showBtn.addEventListener('click', show);
  return { el, show, hide };
}

export default function ethSettings(app) {
  const body = h('div', { class: 'stack' });
  let reveal = null;
  // An app switcher snapshot must not carry the key (visibilitychange, and pagehide).
  const offHidden = onHidden(() => reveal && reveal.hide());
  const row = (ico, title, sub, onclick, extra = {}) =>
    h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));

  function render(record) {
    if (reveal) reveal.hide();
    reveal = null;
    const pref = ethPrefs(app);
    const bsc = evmPrefs(app, 'bsc');
    const serverSub = (p) => (p.host.unusable ? t("Your own: its saved address can't be used any more") : p.custom ? t('Your own: {name}', { name: p.host.name }) : p.host.name);
    // On or off as the person set it; while their own Ethereum server is in use an "on" is held (the
    // index is not asked), and the row says so, and that it is asked again with a listed server.
    const hist = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': t('History from Stack Wallet'), 'data-testid': 'eth-history-switch', 'data-held': pref.historyHeld ? 'true' : null, checked: pref.history || pref.historyHeld });
    hist.addEventListener('change', async () => {
      await app.setPrefs({ ethHistory: hist.checked });
      const now = ethPrefs(app);
      toast(now.historyHeld ? t("History is on: Stack Wallet's index is asked again once you use a listed Ethereum server") : hist.checked ? t("History from Stack Wallet's index is on") : t('Only what this device sent is shown'));
      render(record);
    });
    put(
      body,
      h('p', { class: 'section-title', text: t('Connection') }),
      h(
        'div',
        { class: 'card list' },
        row('globe', t('Ethereum server'), serverSub(pref), () => app.go('ethServers', { chain: 'ethereum' }), { 'data-testid': 'eth-server-row', 'data-server': pref.host.id }),
        row('globe', t('BNB Chain server'), serverSub(bsc), () => app.go('ethServers', { chain: 'bsc' }), { 'data-testid': 'bsc-server-row', 'data-server': bsc.host.id }),
        h(
          'label',
          { class: 'row' },
          h('span', { class: 'ico' }, icon('activity')),
          h('span', { class: 'main' }, h('div', { class: 't', text: t('History from Stack Wallet') }), h('div', { class: 's wrap', 'data-testid': 'eth-history-sub', text: pref.historyHeld ? t("On, held: not asked while your own Ethereum server is in use (it would learn your address). Asked again once you use a listed Ethereum server. Only what this device sent is shown meanwhile.") : pref.custom ? t("Off. While your own Ethereum server is in use it is not asked anyway.") : t("Asks Stack Wallet's index for this address's past Ethereum payments. Off: only what this device sent.") })),
          hist,
        ),
        row('shield', t('Privacy'), t('Who can see what'), () => app.go('ethPrivacy'), { 'data-testid': 'eth-privacy-row' }),
      ),
      h('p', { class: 'small', 'data-testid': 'eth-servers-note', text: pref.history ? t("Your address is the same on both chains, and each chain's server is asked about it there, with your IP address (and Stack Wallet's history index, while History is on). Pick another server, or add your own, on each chain's screen.") : pref.historyHeld ? t("Your address is the same on both chains, and each chain's server is asked about it there, with your IP address (Stack Wallet's history index is not asked while your own Ethereum server is in use). Pick another server, or add your own, on each chain's screen.") : t("Your address is the same on both chains, and each chain's server is asked about it there, with your IP address. Pick another server, or add your own, on each chain's screen.") }),
      h('p', { class: 'section-title', text: t('Backup') }),
      ...backup(record),
      h('p', { class: 'section-title', text: t('Remove') }),
      h('div', { class: 'card list' }, row('trash', t('Remove Ethereum wallet'), t('From this device only. Coins stay on Ethereum.'), () => removeSheet(record), { 'data-testid': 'eth-remove' })),
    );
  }

  /** What brings it back: the private key (shown here), or the words on paper (and the key on request). */
  function backup(record) {
    if (ethRecordKind(record) === 'key') {
      reveal = keyReveal(app);
      return [
        h(
          'div',
          { class: 'card', 'data-testid': 'eth-backup', 'data-kind': 'key' },
          h('h3', { text: t('Private key') }),
          notice('warn', h('strong', { text: t('This wallet has no recovery words. ') }), t(KEY_WARNING)),
          reveal.el,
        ),
      ];
    }
    const words = h(
      'div',
      { class: 'card', 'data-testid': 'eth-backup', 'data-kind': 'words' },
      h('h3', { text: t('Your Ethereum words are your backup') }),
      h('p', { text: record.passphrase ? tn({ one: "This device doesn't keep them, so it cannot show them again. Keep your paper with the {n} word and the passphrase safe; they are not your Firo words.", other: "This device doesn't keep them, so it cannot show them again. Keep your paper with the {n} words and the passphrase safe; they are not your Firo words." }, record.words) : tn({ one: "This device doesn't keep them, so it cannot show them again. Keep your paper with the {n} word safe; they are not your Firo words.", other: "This device doesn't keep them, so it cannot show them again. Keep your paper with the {n} words safe; they are not your Firo words." }, record.words) }),
    );
    const slot = h('div');
    const collapsed = () =>
      put(slot, h('div', { class: 'card list' }, row('key', t('Show private key'), t('To move it to another wallet'), open, { 'data-testid': 'eth-show-key' })));
    async function open() {
      reveal = keyReveal(app, { onHide: () => { reveal = null; collapsed(); } });
      if (!(await reveal.show())) {
        reveal = null;
        return;
      }
      put(
        slot,
        h(
          'div',
          { class: 'card', 'data-testid': 'eth-key-card' },
          h('h3', { text: t('Private key') }),
          notice('warn', h('strong', { text: t('The same account as your words, in one line. ') }), t('Anyone who has it can take your Ethereum coins: never share it, and paste it only into a wallet you trust.')),
          reveal.el,
        ),
      );
    }
    collapsed();
    return [words, slot];
  }

  async function removeSheet(record) {
    let message = null;
    // Transactions still followed: removing forgets their guards, so one sent again could go through
    // twice. Said, and ticked, before anything is removed (second audit, XR).
    const open = await loadOutbox(app, { ethId: record.id })
      .then((l) => l.filter(isOpen))
      .catch(() => []);
    let understood = open.length === 0;
    let confirmBtn = null;
    const byKey = ethRecordKind(record) === 'key';
    const onlyWay = byKey ? t('Only its private key can bring it back. ') : record.passphrase ? tn({ one: 'Only your {n} Ethereum word and passphrase can bring it back. ', other: 'Only your {n} Ethereum words and passphrase can bring it back. ' }, record.words) : tn({ one: 'Only your {n} Ethereum word can bring it back. ', other: 'Only your {n} Ethereum words can bring it back. ' }, record.words);
    const stopIf = byKey ? t('If you have not saved it (Backup, above), stop here: removing it without it loses its coins for good.') : t('If you do not have them written down, stop here: removing it without them loses its coins for good.');
    openSheet((close, rerender) => [
      h('h2', { text: t('Remove the Ethereum wallet?') }),
      notice('warn', h('strong', { text: onlyWay }), stopIf),
      h('p', { class: 'lead', text: t('This removes the Ethereum key and what this device sent from this device. Nothing changes on Ethereum, and your Firo wallet stays as it is.') }),
      open.length
        ? h(
            'div',
            { 'data-testid': 'eth-remove-open' },
            notice(
              'error',
              h('strong', { text: tn({ one: 'Firo PWA is still following a transaction from this wallet: ', other: 'Firo PWA is still following {n} transactions from this wallet: ' }, open.length) }),
              [open.map((e) => t('{payment} on {chainName}', { payment: entryWords(e), chainName: CHAINS[entryChain(e)].name })).join('; '), tn({ one: 'Removing the wallet forgets it: if you then send it again, it may go through twice. Best wait until it settles.', other: 'Removing the wallet forgets them: if you then send one of them again, it may go through twice. Best wait until they settle.' }, open.length)].join('. '),
            ),
            h(
              'label',
              { class: 'check-row' },
              h('input', {
                type: 'checkbox',
                'data-testid': 'eth-remove-understood',
                onchange: (ev) => {
                  understood = ev.target.checked;
                  if (confirmBtn) confirmBtn.disabled = !understood;
                },
                checked: understood,
              }),
              h('span', { text: t('I understand: a payment sent again may go through twice') }),
            ),
          )
        : null,
      message,
      (confirmBtn = h('button', {
        class: 'btn btn-danger',
        'data-testid': 'eth-remove-confirm',
        disabled: !understood,
        onclick: async () => {
          if (!understood) return;
          const ok = await confirmIdentity(app, { title: t('Remove the Ethereum wallet'), detail: t('Confirm it is you to remove it from this device.'), cta: t('Remove') });
          if (!ok) return;
          try {
            await removeEthWallet();
            close();
            toast(t('Ethereum wallet removed from this device'));
            app.go('settings');
          } catch (e) {
            message = notice('error', t('It could not be removed: {message}', { message: e.message }));
            rerender();
          }
        },
      }, t('Remove Ethereum wallet'))),
      h('button', { class: 'btn btn-text', onclick: () => close() }, t('Keep it')),
    ], { label: t('Remove the Ethereum wallet') });
  }

  (async () => {
    const record = await getEthRecord();
    if (!record) return app.go('ethStart', { from: 'settings' }, { replace: true });
    render(record);
  })();

  const el = screen({ title: t('Ethereum & BNB'), back: () => app.back('settings'), cls: 'settings' }, body);
  return {
    el,
    destroy() {
      offHidden();
      if (reveal) reveal.hide();
      reveal = null;
    },
  };
}
