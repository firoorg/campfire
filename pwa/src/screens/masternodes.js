/* Masternodes (Settings -> Masternodes)
 * Spec: ONE job: see this wallet's masternodes: running or not, where, when last paid.
 *       Primary CTA: none (a status list).
 *       Taps from app open: 2 (☰ -> Masternodes).
 * Exit-intent reasons and answers:
 *   - "Is mine running?" -> each masternode says Active or Banned (PoSe) first.
 *   - "When was it paid?" -> about when, from its last paid block.
 *   - "How do I start one?" -> said plainly: 1,000 FIRO as collateral and a server; registering is
 *     not in this version (Campfire has it switched off too), Firo's desktop wallet does it.
 *   - "Nothing here" -> says so, with what a masternode needs.
 */
import { h, put } from '../lib/dom.js';
import { screen, notice, secondary } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { isNotYet } from '../lib/chain.js';
import { aboutDate } from './names.js';
import { t } from '../lib/i18n.js';

const short = (s) => (s && s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s || '');

export default function masternodes(app) {
  const body = h('div', { 'aria-live': 'polite' });

  async function load() {
    put(body, h('div', { class: 'card empty' }, h('p', { text: t('Looking for masternodes…') })));
    let list;
    try {
      list = await wallet.need().masternodes.list();
    } catch (e) {
      put(body, notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? t('Masternodes are not in this version yet.') : t('Masternodes could not be read: {message}', { message: e.message })), isNotYet(e) ? null : secondary(t('Try again'), load));
      return;
    }
    const tip = wallet.state.tip?.height;
    const nodes = list.filter((m) => m.proTxHash);
    const spare = list.filter((m) => !m.proTxHash);
    const how = notice('info', t('A masternode needs 1,000 FIRO as collateral and a server. Registering one is not in this version (Firo PWA has it switched off too): Firo’s desktop wallet does it.'));
    if (!list.length) {
      put(body, h('div', { class: 'card empty', 'data-testid': 'mn-empty' }, h('p', { text: t('No masternode in this wallet.') })), how);
      return;
    }
    put(
      body,
      nodes.length
        ? h(
            'div',
            { class: 'card list', 'data-testid': 'mn-list' },
            ...nodes.map((m) => {
              const i = m.info;
              const state = !i ? t('Status unknown') : i.banned ? t('Banned (PoSe)') : t('Active');
              const paid = i && i.lastPaidHeight ? aboutDate(i.lastPaidHeight, tip) : null;
              return h(
                'div',
                { class: 'row', 'data-testid': 'mn-row', 'data-state': state },
                h(
                  'div',
                  { class: 'main' },
                  h('p', { class: 'title', text: state }),
                  i ? h('p', { class: 'sub small mono', text: i.service }) : null,
                  i ? h('p', { class: 'sub small', text: [t('Pays {address}', { address: short(i.payoutAddress) }), paid ? t('last paid about {when}', { when: paid }) : null, i.posePenalty ? t('penalty {penalty}', { penalty: i.posePenalty }) : null].filter(Boolean).join(' · ') }) : null,
                  h('p', { class: 'sub small mono', text: t('Collateral {address}', { address: short(m.collateral) }) }),
                ),
              );
            }),
          )
        : null,
      spare.length ? h('p', { class: 'section-title', text: t('Coins that can back a masternode') }) : null,
      spare.length ? h('div', { class: 'card list', 'data-testid': 'mn-spare' }, ...spare.map((m) => h('div', { class: 'row' }, h('div', { class: 'main' }, h('p', { class: 'title', text: `${formatAmount(BigInt(m.amount))} ${UNIT}` }), h('p', { class: 'sub small mono', text: short(m.collateral) }))))) : null,
      how,
    );
  }

  load();
  return { el: screen({ title: t('Masternodes'), back: () => app.back('settings') }, body) };
}
