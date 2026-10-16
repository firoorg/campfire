// The way into buying rsFIRO with any coin (NEAR Intents), as the desktop app
// shows it on its Uniswap swap (UniPayWithOtherCoinCard): one row, on the
// Uniswap swap and on Ethereum Home. Nothing is asked of NEAR Intents until it is
// tapped; the row only reads this device's own record of swaps under way.
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

/** The row; `swaps`: a promise of the swaps under way (the line then says so). */
export function payWithCoinEntry(app, { testid = 'ni-entry', swaps = null } = {}) {
  const sub = h('div', { class: 's', 'data-testid': `${testid}-sub`, text: 'BTC, ZEC, LTC, USDT and more, through NEAR Intents' });
  const ico = h('span', { class: 'ico' }, icon('swap'));
  const row = h(
    'button',
    { class: 'card row bridge-entry intents-entry', type: 'button', onclick: () => app.go('nearIntents'), 'data-testid': testid },
    ico,
    h('span', { class: 'main' }, h('div', { class: 't', text: 'Buy rsFIRO with any coin' }), sub),
    h('span', { class: 'chev' }, icon('chevron')),
  );
  if (swaps) {
    swaps
      .then((list) => {
        const n = (list || []).length;
        if (!n) return;
        sub.textContent = n === 1 ? 'A swap is on its way · tap to see it' : `${n} swaps on their way · tap to see them`;
        ico.classList.add('wait');
        put(ico, icon('clock'));
      })
      .catch(() => {});
  }
  return row;
}
