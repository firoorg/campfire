// The Sell FIRO screens, loaded only when one is opened (the sell code and
// buyfiro.app's client are not needed by a session that never sells), and the
// way in from Home: Sell asks first which FIRO, as Buy does.
import { h } from '../lib/dom.js';
import { notice, screen, openSheet, assetBadge } from '../lib/ui.js';
import { icon } from '../lib/icons.js';
import { choiceCard, rsfiroChoiceBadge } from './buy_screens.js';

/** A screen whose module is imported on first use; a spinner until then. */
function lazyScreen(load) {
  return (app, params) => {
    const holder = h('main', { class: 'screen splash', 'aria-busy': 'true' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Opening' }));
    let inner = null;
    let dead = false;
    load()
      .then((m) => {
        if (dead) return;
        inner = m.default(app, params) || {};
        holder.replaceWith(inner.el || inner);
      })
      .catch((e) => {
        if (dead) return;
        console.error(e);
        holder.replaceWith(screen({ title: 'Sell FIRO', back: () => app.back('home') }, notice('error', `This screen could not be opened: ${e.message}. Go back and try again.`)));
      });
    return {
      el: holder,
      destroy() {
        dead = true;
        if (inner && inner.destroy) inner.destroy();
      },
    };
  };
}

export const SELL_SCREENS = {
  sellFiro: lazyScreen(() => import('./sell_firo.js')),
  sellOrder: lazyScreen(() => import('./sell_order.js')),
  sellOrders: lazyScreen(() => import('./sell_orders.js')),
};

/** One of the rsFIRO card's two ways out: a full-width row, so each is its own action. */
function splitAction(testid, text, onclick) {
  return h('button', { class: 'choice-action choice-split', type: 'button', 'data-testid': testid, onclick }, h('span', { text }), icon('chevron'));
}

/**
 * Sell (as Buy asks): first, which FIRO.
 *   FIRO (private or public)  buyfiro.app: sold for USDT on BNB Chain or another token, paid to an
 *                             Ethereum-style address (this wallet's own by default).
 *   rsFIRO (public)           swapped in the Ethereum & BNB wallet: Uniswap for ETH, PancakeSwap for BNB.
 * Spec: ONE job: choose what to sell. FIRO first; each action is one tap into its screen.
 *       Taps from app open: Sell (1), a card (2), then its form.
 * Exit-intent: "which one?" -> each card says where that FIRO lives and what you get;
 *       "no Ethereum wallet" -> the rsFIRO card says rsFIRO lives there and sets one up first.
 */
export function openSell(app, params = {}) {
  if (params.direct || !app.has('ethSwapBsc')) return app.go('sellFiro', params);
  let hasEth = null;
  const go = (close, name, p = {}) => {
    close(true);
    app.go(name, p);
  };
  const sheet = openSheet(
    (close) => [
      h('p', { class: 'overline', text: 'Sell' }),
      h('h2', { 'data-testid': 'sell-chooser-title', text: 'Which FIRO do you want to sell?' }),
      choiceCard({
        testid: 'sell-choose-firo',
        badge: assetBadge({ id: 'firo' }),
        title: 'FIRO',
        tag: 'Private or public',
        tagCls: 'private',
        text: 'From your Firo wallet. Get USDT on BNB Chain, or another token, through buyfiro.app.',
        action: 'Sell FIRO',
        onclick: () => go(close, 'sellFiro', params),
      }),
      h(
        'div',
        { class: 'card choice-card split', 'data-testid': 'sell-choose-rsfiro' },
        h('span', { class: 'choice-head' }, rsfiroChoiceBadge(), h('span', { class: 'choice-title', text: 'rsFIRO on Ethereum or BNB' }), h('span', { class: 'tag public', text: 'Public' })),
        h('span', { class: 'choice-text', text: hasEth === false ? 'FIRO as a token lives in an Ethereum & BNB wallet. Add yours, then swap it there.' : 'FIRO as a token, in your Ethereum & BNB wallet. Swap it there:' }),
        ...(hasEth === false
          ? [splitAction('sell-rsfiro-setup', 'Add an Ethereum & BNB wallet first', () => go(close, 'ethStart', { from: 'sellRsfiro' }))]
          : [splitAction('sell-rsfiro-eth', 'For ETH, on Ethereum', () => go(close, 'ethSwap', { pay: 'rsFIRO', receive: 'ETH' })), splitAction('sell-rsfiro-bnb', 'For BNB, on BNB Chain', () => go(close, 'ethSwapBsc', { side: 'sell' }))]),
      ),
      h('button', { class: 'btn btn-text', onclick: () => close(false), 'data-testid': 'sell-chooser-close' }, 'Not now'),
    ],
    { label: 'What do you want to sell?' },
  );
  import('../lib/eth/record.js')
    .then(({ hasEthWallet }) => hasEthWallet())
    .then((v) => {
      hasEth = v;
      if (!sheet.closed) sheet.rerender();
    })
    .catch(() => {
      hasEth = null;
    });
  return null;
}
