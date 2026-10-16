/* Your sells (Sell FIRO -> Your sells)
 * Spec: ONE job: find a sell of this wallet and see where it is.
 *       Primary CTA: tap the sell (its payment and steps open); "Sell FIRO" when there is none.
 *       Taps from app open: Sell (1) -> FIRO (2) -> Your sells (3) -> the sell (4).
 * Exit-intent reasons and answers:
 *   - "Where is my money?" -> each sell says where it is in words, the unfinished ones first, newest first.
 *   - "I have none" -> says so, with the way back to selling.
 */
import { h, put, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, assetBadge } from '../lib/ui.js';
import { sellFiro, paymentInWallet } from '../lib/sell/wiring.js';
import { firoText, stateLine, usd } from '../lib/sell/words.js';

function tone(state) {
  if (state === 'delivered') return 'in';
  if (state === 'attention') return 'bad';
  if (state === 'expired' || state === 'refused') return 'quiet';
  return 'wait';
}

export default function sellOrdersScreen(app) {
  const c = sellFiro(app);
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'stack' });
  let loaded = false;

  function render() {
    const all = c.orders(app.record.id);
    const open = all.filter((o) => o.isOpen);
    const ended = all.filter((o) => !o.isOpen);
    if (!loaded && !all.length) {
      put(body, h('p', { class: 'small', text: 'Loading your sells…' }));
      put(actions);
      return;
    }
    if (c.loadError && !all.length) {
      put(body, notice('error', `Your sells could not be opened: ${c.loadError.message}`));
      put(actions, primary('Sell FIRO', () => app.go('sellFiro'), { 'data-testid': 'sell-orders-sell' }));
      return;
    }
    if (!all.length) {
      put(body, h('div', { class: 'card empty', 'data-testid': 'sell-orders-empty' }, icon('activity'), h('p', { text: 'No sells yet. Sell FIRO for USDT on BNB Chain or another token, paid to your own address.' })));
      put(actions, primary('Sell FIRO', () => app.go('sellFiro'), { 'data-testid': 'sell-orders-sell' }));
      return;
    }
    put(
      body,
      h(
        'div',
        { class: 'card list', 'data-testid': 'sell-orders' },
        ...[...open, ...ended].map((o) => {
          const money = o.proceedsUsd ?? o.receiveUsd;
          return h(
            'button',
            { class: 'row', 'data-testid': 'sell-order-row', 'data-order': o.orderId, 'data-state': o.lastState || 'awaiting_deposit', onclick: () => app.go('sellOrder', { id: o.orderId, from: 'list' }) },
            assetBadge({ id: 'firo' }),
            h('span', { class: 'main' }, h('div', { class: 't', text: `${firoText(o.amount)}${money == null ? '' : ` → ${o.proceedsUsd == null ? '≈ ' : ''}${usd(money)} ${o.payout.symbol}`}` }), h('div', { class: `s wrap tone-${tone(o.lastState)}`, text: stateLine(o, { sent: Boolean(o.sentTxid || paymentInWallet(o)) }) }), h('div', { class: 's', text: fmtDate(Math.floor(o.createdAt / 1000)) })),
            h('span', { class: 'chev' }, icon('chevron')),
          );
        }),
      ),
    );
    put(actions);
  }

  const off = c.onChange(() => render());
  c.resumeAll().then(() => {
    loaded = true;
    render();
  });
  render();
  const el = screen({ title: 'Your sells', back: () => app.back('sellFiro'), actions: [actions] }, body);
  return { el, destroy: off };
}
