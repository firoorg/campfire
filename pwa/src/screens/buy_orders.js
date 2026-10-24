/* Your buys (Buy FIRO -> Your buys)
 * Spec: ONE job: find a buy of this wallet and see where it is.
 *       Primary CTA: tap the buy (its deposit address and steps open); "Buy FIRO" when there is none.
 *       Taps from app open: Buy (1) -> Your buys (2) -> the buy (3).
 * Exit-intent reasons and answers:
 *   - "Where is my FIRO?" -> each buy says where it is in words, the unfinished ones first, newest first.
 *   - "I have none" -> says so, with the way back to buying.
 */
import { h, put, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { buyFiro } from '../lib/buy/wiring.js';
import { firoShort, stateLine } from '../lib/buy/words.js';
import { coinBadge } from './buy_screens.js';
import { t } from '../lib/i18n.js';

function tone(state) {
  if (state === 'delivered') return 'in';
  if (state === 'attention') return 'bad';
  if (state === 'refunded' || state === 'expired' || state === 'failed') return 'quiet';
  return 'wait';
}

export default function buyOrdersScreen(app) {
  const c = buyFiro(app);
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'stack' });
  let loaded = false;

  function render() {
    const all = c.orders(app.record.id);
    const open = all.filter((o) => o.isOpen);
    const ended = all.filter((o) => !o.isOpen);
    if (!loaded && !all.length) {
      put(body, h('p', { class: 'small', text: t('Loading your buys…') }));
      put(actions);
      return;
    }
    if (c.loadError && !all.length) {
      put(body, notice('error', t('Your buys could not be opened: {message}', { message: c.loadError.message })));
      put(actions, primary(t('Buy FIRO'), () => app.go('buyFiro'), { 'data-testid': 'buy-orders-buy' }));
      return;
    }
    if (!all.length) {
      put(body, h('div', { class: 'card empty', 'data-testid': 'buy-orders-empty' }, icon('activity'), h('p', { text: t('No buys yet. Pay with Bitcoin, Ether, USDT or another coin, and the FIRO arrives in your wallet.') })));
      put(actions, primary(t('Buy FIRO'), () => app.go('buyFiro'), { 'data-testid': 'buy-orders-buy' }));
      return;
    }
    put(
      body,
      h(
        'div',
        { class: 'card list', 'data-testid': 'buy-orders' },
        ...[...open, ...ended].map((o) =>
          h(
            'button',
            { class: 'row', 'data-testid': 'buy-order-row', 'data-deposit': o.depositAddress, 'data-state': o.lastState || 'awaiting_deposit', onclick: () => app.go('buyOrder', { deposit: o.depositAddress, from: 'list' }) },
            coinBadge(o.assetId, o.symbol),
            h('span', { class: 'main' }, h('div', { class: 't', text: `${o.sendAmount} ${o.symbol}${o.estimate == null ? '' : ` → ≈\u00a0${firoShort(o.estimate)}`}` }), h('div', { class: `s wrap tone-${tone(o.lastState)}`, text: stateLine(o) }), h('div', { class: 's', text: fmtDate(Math.floor(o.createdAt / 1000)) })),
            h('span', { class: 'chev' }, icon('chevron')),
          ),
        ),
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
  const el = screen({ title: t('Your buys'), back: () => app.back('buyFiro'), actions: [actions] }, body);
  return { el, destroy: off };
}
