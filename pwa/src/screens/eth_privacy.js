/* Ethereum & BNB privacy (last setup step, before the wallet's first connection; also Settings -> Ethereum & BNB)
 * Spec: ONE job: say, before anything connects, what Ethereum, BNB Chain and their servers can see.
 *       Primary CTA: "Connect" (secondary: "How to hide my IP"). From Settings: "Done".
 *       Taps from app open: 6 + 3 word taps when creating (Ethereum, Create, I wrote them down,
 *       3 words, Confirm words, Connect), 4 + paste when importing words or a private key.
 * Exit-intent reasons and answers:
 *   - "A privacy wallet on a public chain?" -> said first and plainly: everything on Ethereum and BNB
 *     Chain is public; the Firo wallet's private balance stays private.
 *   - "Who sees my IP?" -> the server picked for each chain, both named (Stack Wallet's and BNB
 *     Chain's official one by default, or the person's own), and how to hide it.
 *   - "Is there a fallback that leaks to more servers?" -> no: one server per chain, picked by you,
 *     is asked about your address. (A swap's price is asked again of a second listed server, a
 *     transaction stuck "Not sure yet" is checked with one, and a server screen checks the listed
 *     servers: all said here, with what each sees.)
 *   - "What if I use my own server?" -> what it sees and what it can (wrong balances or
 *     confirmations) and cannot do (move coins).
 *   - "Can I see my history without telling Stack Wallet?" -> the history switch, named here.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { ethKeyFromMnemonic, wipe } from '../lib/eth/crypto.js';
import { saveEthKey, VaultError } from '../lib/eth/vault.js';
import { ethPrefs, evmPrefs } from '../lib/eth/wallet.js';
import { BSC_NOTE_PREF } from '../lib/eth/server_notes.js';

export function ethPrivacyLead(app) {
  const { host, custom } = ethPrefs(app);
  const who = custom ? `your own, ${host.name}` : `${host.name}'s${host.id === 'stackwallet' ? ', unless you pick another in Settings' : ''}`;
  return `The Ethereum server this wallet uses (${who}) sees your IP address together with your Ethereum address each time the app checks a balance or sends. It can link the two and see when you are online.`;
}

/** The same for BNB Chain, whose server is asked about the same address (release audit 0.1.5, K1). */
export function bscPrivacyLine(app) {
  const { host, custom } = evmPrefs(app, 'bsc');
  return `So does the BNB Chain server, ${custom ? `your own (${host.name})` : host.name}: your address is the same on BNB Chain, and the app checks its balance there too.`;
}

export default function ethPrivacy(app, params = {}) {
  const setup = Boolean(params.setup) && app.ethSetup && (Array.isArray(app.ethSetup.words) || app.ethSetup.sk instanceof Uint8Array);
  const msg = h('div', { 'aria-live': 'polite' });
  const details = h(
    'div',
    { class: 'card hidden', 'data-testid': 'eth-ip-details' },
    h('h3', { text: 'How to hide your IP address' }),
    h(
      'ol',
      { class: 'steps-list' },
      h('li', { text: 'iCloud Private Relay (needs iCloud+): Settings → [your name] → iCloud → Private Relay → On. Apple documents it for browsing in Safari; for apps added to the Home Screen it does not say, so do not rely on it alone.' }),
      h('li', { text: 'A VPN you trust covers every app on the phone, including Firo PWA. Turn it on before you open the wallet.' }),
    ),
  );
  const toggle = secondary('How to hide my IP', () => {
    details.classList.toggle('hidden');
    toggle.textContent = details.classList.contains('hidden') ? 'How to hide my IP' : 'Hide details';
  }, { 'data-testid': 'eth-ip-how' });

  async function connect() {
    cta.disabled = true;
    cta.textContent = 'Setting up…';
    put(msg);
    const s = app.ethSetup;
    let key = null;
    try {
      if (s.kind === 'key') {
        await saveEthKey(app, { sk: s.sk, address: s.address, kind: 'key' });
        wipe(s.sk);
      } else {
        key = await ethKeyFromMnemonic(s.words.join(' '), s.mode === 'import' ? s.passphrase || '' : '');
        await saveEthKey(app, { sk: key.sk, address: key.address, words: s.words.length, passphrase: Boolean(s.passphrase) });
        s.words.fill('');
      }
      // This screen has just named the BNB Chain server: nothing to tell later (lib/eth/server_notes.js).
      await app.setPrefs({ [BSC_NOTE_PREF]: 1 }).catch(() => {});
      app.ethSetup = null;
      // The setup steps are behind it. Opened on the way to rsFIRO: carry on there.
      if (s.from === 'nearIntents') app.go('nearIntents', {}, { replace: true });
      else if (s.from === 'bridge') app.go('bridge', { back: 'home' }, { replace: true });
      else if (s.from === 'sell') app.go('sellFiro', {}, { replace: true });
      else app.go('ethHome', { created: s.mode }, { replace: true });
    } catch (e) {
      cta.disabled = false;
      cta.textContent = 'Connect';
      const text =
        e instanceof VaultError && e.code === 'exists'
          ? 'This device already has an Ethereum wallet. Remove it in Settings → Ethereum & BNB first; nothing was changed.'
          : `The Ethereum wallet could not be set up: ${e.message} Nothing was saved; try again.`;
      put(msg, notice('error', text));
    } finally {
      if (key) wipe(key.sk);
    }
  }

  const cta = setup ? primary('Connect', connect, { 'data-testid': 'eth-connect' }) : primary('Done', () => app.back('ethSettings'), { 'data-testid': 'eth-privacy-done' });
  const step = setup ? (app.ethSetup.mode === 'create' ? 'Step 3 of 3' : 'Step 2 of 2') : null;
  const el = screen(
    { title: 'Ethereum & BNB privacy', back: () => (setup ? app.go(app.ethSetup.mode === 'create' ? 'ethConfirm' : 'ethImport') : app.back('ethSettings')), actions: [cta, toggle] },
    step ? h('p', { class: 'step', text: step }) : null,
    h('div', { class: 'status-icon wait' }, icon('globe')),
    h('p', { class: 'lead', 'data-testid': 'eth-privacy-text', text: ethPrivacyLead(app) }),
    h('p', { 'data-testid': 'eth-privacy-bsc', text: bscPrivacyLine(app) }),
    notice('warn', h('strong', { text: 'Everything on Ethereum and BNB Chain is public: ' }), 'your address, your balance and every payment, for good. Your private FIRO stays private.'),
    h(
      'details',
      { class: 'more card flat', 'data-testid': 'eth-privacy-more' },
      h('summary', { text: 'What else is shared' }),
      h(
        'ul',
        { class: 'steps-list small' },
        h('li', { text: "Past Ethereum payments come from Stack Wallet's history index, which is asked about your address. You can turn it off in Settings → Ethereum & BNB; it is not asked while your own Ethereum server is in use." }),
        h('li', { text: "Swaps on Uniswap and PancakeSwap contact no exchange's server. Before a swap, its price is checked with a second server from the list, which sees your IP address and the swap's amount, never your address (also when you use your own server)." }),
        h('li', { 'data-testid': 'eth-privacy-stuck', text: `A transaction stuck "Not sure yet" (your server says another took its place but can't show it) is checked with one more server from the list (the next one only if that one can't answer), which then sees your IP address with your address. Not while you use your own server on that chain: then no other listed server is asked to settle it. Nothing is sent through it.` }),
        h('li', { 'data-testid': 'eth-privacy-failed', text: 'A transaction your server shows as failed is checked with one more server from the list before Firo PWA says it failed (the next one only if that one has no answer), which then sees your IP address with your address. Not while you use your own server on that chain.' }),
        h('li', { 'data-testid': 'eth-privacy-checks', text: 'Opening a server screen (Settings → Ethereum & BNB) checks the listed servers of that chain: each sees your IP address, never your address.' }),
        h('li', { 'data-testid': 'eth-privacy-own', text: "Your own server, if you add one, is the only server asked about your address on its chain (with your own Ethereum server, Stack Wallet's history index is not asked either), and it sees your IP address with your address. Your address is the same on both chains: the other chain's server still sees it, unless you add your own there too. Your own server could show wrong balances, or say a payment went through when it did not; it can never move your coins: payments are signed on this device." }),
        h('li', { text: "Values in dollars ask CoinGecko for prices, and CoinGecko sees your IP. They are off until you turn them on." }),
      ),
    ),
    h('p', { class: 'small', text: 'To hide your IP address, turn on iCloud Private Relay or use a VPN, as for FIRO.' }),
    details,
    msg,
  );
  return { el };
}
