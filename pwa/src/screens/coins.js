/* Coins (Settings -> Coins)
 * Spec: ONE job: see each coin this wallet holds, keep a public coin out of payments, note what
 *       a coin is.
 *       Primary CTA: none (a list); each public coin has Freeze / Unfreeze, each coin Note.
 *       Taps from app open: 2 (☰ -> Coins).
 * Exit-intent reasons and answers:
 *   - "Why freeze a coin?" -> one line: a frozen public coin is never spent, for example a coin you
 *     do not want linked to your other payments, or a masternode's 1,000 FIRO.
 *   - "Can I freeze private coins?" -> no, said in the private section: private coins cannot be
 *     linked to each other, so there is nothing to keep apart.
 *   - "Nothing here" -> says the wallet holds no coins yet, with Receive.
 */
import { h, put } from '../lib/dom.js';
import { screen, notice, primary, secondary, textButton, openSheet, toast } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { isNotYet } from '../lib/chain.js';
import { t, tn } from '../lib/i18n.js';

const short = (s) => (s && s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s || '');

export default function coins(app) {
  const body = h('div', { 'aria-live': 'polite' });

  function noteSheet(c) {
    const input = h('input', { class: 'input', type: 'text', maxlength: '200', value: c.label || '', placeholder: t('What this coin is'), 'data-testid': 'coin-note-input' });
    openSheet((close) => [
      h('h2', { text: t('Note') }),
      h('p', { class: 'small', text: t('{amount} {UNIT}. The note stays on this device.', { amount: formatAmount(c.amount), UNIT }) }),
      input,
      primary(t('Save'), async () => {
        await wallet.labelCoin(c.id, input.value.trim());
        close();
        load();
      }, { 'data-testid': 'coin-note-save' }),
      textButton(t('Cancel'), () => close()),
    ], { label: t('Coin note') });
  }

  async function toggle(c) {
    // A masternode's collateral (or a coin of 1,000 FIRO that may be one): Campfire's warning first (P3).
    if (c.frozen && c.collateral) {
      const sure = await new Promise((resolve) => {
        openSheet((close) => [
          h('h2', { text: t('Spend a masternode coin?') }),
          h('p', { class: 'lead', 'data-testid': 'coin-mn-warning', text: t('This coin of 1,000 FIRO may be the collateral of a masternode. If it is, spending it takes the masternode off the list and its rewards stop.') }),
          primary(t('Let it be spent'), () => close(true), { 'data-testid': 'coin-mn-unlock' }),
          textButton(t('Keep it locked'), () => close(false), { 'data-testid': 'coin-mn-keep' }),
        ], { label: t('Spend a masternode coin?') }).then((v) => resolve(v === true));
      });
      if (!sure) return;
    }
    try {
      await wallet.freezeCoin(c.id, !c.frozen);
      toast(c.frozen ? t('The coin can be spent again.') : t('Frozen: it will not be spent.'));
      load();
    } catch (e) {
      toast(e.message, 4000);
    }
  }

  function row(c) {
    const pub = c.kind === 'transparent';
    const sub = [pub ? short(c.address) : t('Private coin'), c.confirmations ? tn({ one: '{n} confirmation', other: '{n} confirmations' }, c.confirmations) : c.spendable ? null : c.unproven ? t('in a block, says the Firo node: checking') : t('waiting for a block'), c.memo ? `“${c.memo}”` : null].filter(Boolean).join(' · ');
    return h(
      'div',
      { class: `row${c.frozen ? ' frozen' : ''}`, 'data-testid': 'coin-row', 'data-kind': c.kind, 'data-frozen': String(Boolean(c.frozen)) },
      h('div', { class: 'main' }, h('p', { class: 'title', text: `${formatAmount(c.amount)} ${UNIT}${c.collateral && c.frozen ? t(' · masternode coin, locked') : c.frozen ? t(' · frozen') : ''}` }), h('p', { class: `sub small${pub ? ' mono' : ''}`, text: sub }), c.label ? h('p', { class: 'sub small', 'data-testid': 'coin-label', text: c.label }) : null),
      h(
        'div',
        { class: 'row-actions' },
        h('button', { class: 'btn btn-text btn-inline', 'data-testid': 'coin-note', onclick: () => noteSheet(c) }, t('Note')),
        pub ? h('button', { class: 'btn btn-text btn-inline', 'data-testid': 'coin-freeze', onclick: () => toggle(c) }, c.frozen ? t('Unfreeze') : t('Freeze')) : null,
      ),
    );
  }

  async function load() {
    let list;
    try {
      list = await wallet.coins();
    } catch (e) {
      put(body, notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? t('Coin control is not in this version yet.') : t('The coins could not be read: {message}', { message: e.message })), isNotYet(e) ? null : secondary(t('Try again'), load));
      return;
    }
    const pub = list.filter((c) => c.kind === 'transparent');
    const priv = list.filter((c) => c.kind === 'spark');
    if (!list.length) {
      put(body, h('div', { class: 'card empty', 'data-testid': 'coins-empty' }, h('p', { text: t('No coins yet. Receive some FIRO and each payment shows here as a coin.') })), primary(t('Receive'), () => app.go('receive')));
      return;
    }
    put(
      body,
      h('p', { class: 'section-title', text: t('Public coins ({length})', { length: pub.length }) }),
      pub.length ? h('div', { class: 'card list', 'data-testid': 'coins-public' }, ...pub.map(row)) : h('p', { class: 'small muted', text: t('None.') }),
      h('p', { class: 'small', text: t('A frozen public coin is never spent: keep apart a coin you do not want linked to your other payments, or a masternode’s 1,000 FIRO.') }),
      h('p', { class: 'section-title', text: t('Private coins ({length})', { length: priv.length }) }),
      priv.length ? h('div', { class: 'card list', 'data-testid': 'coins-private' }, ...priv.map(row)) : h('p', { class: 'small muted', text: t('None.') }),
      h('p', { class: 'small', text: t('Private coins cannot be linked to each other, so there is nothing to keep apart.') }),
    );
  }

  load();
  const off = wallet.onChange(() => {});
  return { el: screen({ title: t('Coins'), back: () => app.back('settings') }, body), destroy: off };
}
