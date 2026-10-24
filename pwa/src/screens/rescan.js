/* Rescan (Settings -> Rescan)
 * Spec: ONE job: read the blockchain again for this wallet's payments.
 *       Primary CTA: "Rescan".
 *       Taps from app open: 2 (☰ -> Rescan), 3 to start.
 * Exit-intent reasons and answers:
 *   - "Will I lose coins or history?" -> no: it only reads again; nothing is sent.
 *   - "How long?" -> said up front: from the start of the wallet it is quicker, everything takes
 *     longest; Home shows how far along it is, and sending waits until it is done.
 *   - "Which block do I start at?" -> the block the wallet was made at is filled in when known;
 *     "Everything" is always safe.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { isNotYet } from '../lib/chain.js';
import { parseHeight } from './restore.js';
import { t } from '../lib/i18n.js';

export default function rescan(app) {
  const birthday = Number.isSafeInteger(app.record.birthday) ? app.record.birthday : null;
  let choice = birthday != null ? 'birthday' : 'all';
  const msg = h('div', { 'aria-live': 'polite' });
  const height = h('input', { class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: t('Block height, like 1100000'), 'aria-label': t('Start at block'), 'data-testid': 'rescan-height' });
  const options = h('div', { class: 'card list', role: 'radiogroup', 'aria-label': t('Where to start') });
  const cta = primary(t('Rescan'), run, { 'data-testid': 'rescan-start' });

  function option(id, title, sub) {
    return h(
      'button',
      { class: `row choice-row${choice === id ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(choice === id), 'data-testid': `rescan-${id}`, onclick: () => ((choice = id), render()) },
      h('span', { class: `radio${choice === id ? ' on' : ''}`, 'aria-hidden': 'true' }),
      h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's wrap', text: sub })),
    );
  }

  function render() {
    put(
      options,
      birthday != null ? option('birthday', t('From when this wallet was made'), t('Block {birthday}. Quicker; payments before it are not looked for.', { birthday: birthday.toLocaleString('en-US') })) : null,
      option('height', t('From a block I choose'), t('If you know when your first payment arrived.')),
      option('all', t('Everything'), t('Reads the whole Spark history. Slowest, and always complete.')),
    );
    height.classList.toggle('hidden', choice !== 'height');
  }

  async function run() {
    let from = null;
    if (choice === 'birthday') from = birthday;
    if (choice === 'height') {
      from = parseHeight(height.value);
      if (from == null || from === false) return put(msg, notice('warn', t('Type the block height to start at, in digits.')));
    }
    cta.disabled = true;
    try {
      await wallet.rescan(from);
      toast(t('Rescanning. Home shows how far along it is.'), 4000);
      app.go('home');
    } catch (e) {
      cta.disabled = false;
      put(msg, notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? t('Rescanning is not in this version yet.') : t('The rescan did not start: {message}', { message: e.message })));
    }
  }

  render();
  const el = screen(
    { title: t('Rescan'), back: () => app.back('settings'), actions: [cta] },
    h('p', { class: 'lead', text: t('Firo PWA reads the Firo blockchain again for your payments. Nothing is sent and nothing is deleted.') }),
    options,
    height,
    notice('info', t('It may take a while. Sending waits until it is done; you can leave the app and come back.')),
    msg,
  );
  return { el };
}
