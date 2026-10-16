/* Watch a wallet (Welcome / Add a wallet -> "Watch a wallet with its view key")
 * Spec: ONE job: follow a wallet's payments from its Spark view key, without being able to spend.
 *       Primary CTA: "Watch this wallet" (then a password for this device).
 *       Taps from app open: 2 (Welcome -> Watch a wallet), paste, 1.
 * Exit-intent reasons and answers:
 *   - "Can this spend my money?" -> no, said first: a view key sees, it cannot spend.
 *   - "Where do I get the key?" -> Campfire: wallet settings -> Spark view key; this app: Settings ->
 *     Spark view key.
 *   - "Public payments too?" -> add the wallet's xpub as well (optional).
 *   - "It takes long" -> give the date the wallet was made: reading starts there.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { isAdding } from '../lib/session.js';
import { heightForDate } from '../lib/heights.js';
import { parseHeight } from './restore.js';

// A Spark full view key is long hex (Campfire shows it as hex); an xpub is base58 starting xpub.
const VIEW_KEY = /^[0-9a-f]{100,600}$/;
const XPUB = /^xpub[1-9A-HJ-NP-Za-km-z]{100,120}$/;

export default function watch(app) {
  const adding = isAdding(app);
  const setup = app.setup && app.setup.mode === 'watch' ? app.setup : { ...(adding ? app.setup : {}), mode: 'watch' };
  app.setup = setup;
  const msg = h('div', { 'aria-live': 'polite' });
  const key = h('textarea', { class: 'input mono', rows: '4', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Paste the Spark view key', 'aria-label': 'Spark view key', 'data-testid': 'watch-key' });
  const xpub = h('input', { class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'xpub… (optional, for public payments)', 'aria-label': 'xpub', 'data-testid': 'watch-xpub' });
  const date = h('input', { class: 'input', type: 'date', 'aria-label': 'Wallet made around', 'data-testid': 'watch-date', max: new Date().toISOString().slice(0, 10) });
  const height = h('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Leave empty to read everything', 'aria-label': 'Start at block', 'data-testid': 'watch-height' });
  const cta = primary('Watch this wallet', submit, { disabled: true, 'data-testid': 'watch-submit' });

  const keyText = () => key.value.replace(/\s+/g, '').toLowerCase();
  const xpubText = () => xpub.value.trim();

  function validate() {
    const k = keyText();
    const x = xpubText();
    const kOk = !k || VIEW_KEY.test(k);
    const xOk = !x || XPUB.test(x);
    const hgt = parseHeight(height.value);
    if (!kOk) put(msg, notice('warn', 'That is not a Spark view key: it is a long string of digits and the letters a to f.'));
    else if (!xOk) put(msg, notice('warn', 'That is not an xpub: it starts with xpub.'));
    else if (hgt === false) put(msg, notice('warn', 'Use digits only for the block, like 1100000.'));
    else put(msg);
    cta.disabled = !((k || x) && kOk && xOk && hgt !== false);
  }
  for (const el of [key, xpub, height]) el.addEventListener('input', validate);
  date.addEventListener('change', () => {
    const hgt = date.value ? heightForDate(date.value) : null;
    height.value = hgt == null ? '' : String(hgt);
    validate();
  });

  function submit() {
    validate();
    if (cta.disabled) return;
    const hgt = parseHeight(height.value);
    app.setup = { ...setup, mode: 'watch', viewKey: keyText(), xpub: xpubText(), birthday: hgt };
    key.value = '';
    app.go('setPassword');
  }

  const el = screen(
    { title: 'Watch a wallet', back: () => app.back(adding ? 'addWallet' : 'welcome'), actions: [cta], cls: 'sticky-actions' },
    h('div', { 'data-testid': 'watch-intro' }, notice('info', h('strong', { text: 'It sees, it cannot spend. ' }), "A view key shows a wallet's private payments and balance; nobody can move money with it.")),
    h('label', { class: 'field' }, h('span', { class: 'label', text: 'Spark view key' }), key),
    h('p', { class: 'hint', text: "In Campfire: the wallet's settings -> Spark view key. In this app: Settings -> Spark view key." }),
    h('label', { class: 'field' }, h('span', { class: 'label', text: 'xpub (optional)' }), xpub),
    h('label', { class: 'field' }, h('span', { class: 'label', text: 'Wallet made around (optional)' }), date),
    h('label', { class: 'field' }, h('span', { class: 'label', text: 'Or start at block' }), height),
    msg,
  );
  return { el };
}
