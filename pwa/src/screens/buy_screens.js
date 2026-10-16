// The Buy FIRO screens, loaded only when one is opened (the buy code and
// buyfiro.app's client are not needed by a session that never buys), and the
// way in from Home: there is one thing to buy, FIRO into this wallet, so Buy
// opens its form straight away (no chooser).
import { h } from '../lib/dom.js';
import { notice, screen, openSheet, assetBadge } from '../lib/ui.js';
import { icon } from '../lib/icons.js';

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
        holder.replaceWith(screen({ title: 'Buy FIRO', back: () => app.back('home') }, notice('error', `This screen could not be opened: ${e.message}. Go back and try again.`)));
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

export const BUY_SCREENS = {
  buyFiro: lazyScreen(() => import('./buy_firo.js')),
  buyOrder: lazyScreen(() => import('./buy_order.js')),
  buyOrders: lazyScreen(() => import('./buy_orders.js')),
};

/** Home's Buy: the Buy FIRO form. */
/** rsFIRO's badge (drawn as FIRO: it is FIRO on Ethereum and BNB Chain, 1:1) with a small Ethereum mark. */
export function rsfiroChoiceBadge() {
  return h('span', { class: 'badge-pair' }, assetBadge({ id: 'firo' }), h('span', { class: 'badge-mark', 'aria-hidden': 'true' }, h('img', { src: 'img/eth.svg', alt: '' })));
}

export function choiceCard({ testid, badge, title, tag, tagCls, text, steps = null, action, onclick }) {
  return h(
    'button',
    { class: 'card choice-card', type: 'button', onclick, 'data-testid': testid },
    h('span', { class: 'choice-head' }, badge, h('span', { class: 'choice-title', text: title }), h('span', { class: `tag ${tagCls}`, text: tag })),
    h('span', { class: 'choice-text', text }),
    steps,
    h('span', { class: 'choice-action' }, h('span', { text: action }), icon('chevron')),
  );
}

/**
 * Buy: first, what to buy: private FIRO or public rsFIRO.
 *   FIRO (private)   buyfiro.app: the coin itself, into this Firo wallet.
 *   rsFIRO (public)  two steps: NEAR Intents turns any coin into ETH or BNB in the Ethereum & BNB
 *                    wallet, then a swap there makes it rsFIRO.
 * Spec: ONE job: choose which FIRO. Two equal cards, private first; each card is its own action.
 *       Taps from app open: Buy (1), a card (2), then its form.
 * Exit-intent: "which one do I want?" -> each says where it lives and how you pay, in one line;
 *       "no Ethereum wallet" -> the rsFIRO card says so and sets one up first.
 */
export function openBuy(app, params = {}) {
  if (params.direct || !app.has('nearIntents')) return app.go('buyFiro', params);
  let hasEth = null;
  const sheet = openSheet(
    (close) => [
      h('p', { class: 'overline', text: 'Buy' }),
      h('h2', { 'data-testid': 'buy-chooser-title', text: 'Both are FIRO. They live in different wallets.' }),
      choiceCard({
        testid: 'buy-choose-private',
        badge: assetBadge({ id: 'firo' }),
        title: 'FIRO',
        tag: 'Private',
        tagCls: 'private',
        text: 'The private coin, in your Firo wallet. Pay with Bitcoin, Ether, USDT or another coin.',
        action: 'Buy FIRO',
        onclick: () => {
          close(true);
          app.go('buyFiro', params);
        },
      }),
      choiceCard({
        testid: 'buy-choose-rsfiro',
        badge: rsfiroChoiceBadge(),
        title: 'rsFIRO on Ethereum or BNB',
        tag: 'Public',
        tagCls: 'public',
        text: 'FIRO as a token, in your Ethereum & BNB wallet. Pay with any coin, in two steps:',
        steps: h('ol', { class: 'choice-steps', 'data-testid': 'buy-rsfiro-steps' }, h('li', { text: 'NEAR Intents turns your coin into ETH or BNB.' }), h('li', { text: 'You swap it to rsFIRO.' })),
        action: hasEth === false ? 'Create an Ethereum & BNB wallet first' : 'Buy rsFIRO',
        onclick: () => {
          close(true);
          if (hasEth === false) app.go('ethStart', { from: 'nearIntents' });
          else app.go('nearIntents');
        },
      }),
      h('button', { class: 'btn btn-text', onclick: () => close(false), 'data-testid': 'buy-chooser-close' }, 'Not now'),
    ],
    { label: 'What do you want to buy?' },
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

/** HSL (0-360, 0-1, 0-1) → "#rrggbb". */
function hslHex(hue, sat, light) {
  const k = (n) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A coin from another chain: its letters on a colour made from its id. No
 * picture is downloaded, and a copy never borrows a real coin's look.
 */
export function coinBadge(assetId, symbol, size = '') {
  let hue = 7;
  for (const ch of String(assetId)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const clean = String(symbol).replace(/[^A-Za-z0-9]/g, '');
  const letters = clean.slice(0, 3).toUpperCase() || '?';
  const el = h('span', { class: `asset-badge tinted coin${letters.length > 2 ? ' three' : ''} ${size}`.trim(), 'aria-hidden': 'true', text: letters });
  el.style.setProperty('--badge', hslHex(hue, 0.5, 0.42));
  el.style.setProperty('--badge-ink', '#ffffff');
  return el;
}
