// The Ethereum & BNB Chain screens, loaded only when one is opened: the EVM code
// (noble-curves, keccak, BIP39...) is about half a megabyte that a Firo-only
// session never needs, so nothing here imports it statically. Also the
// FIRO / Ethereum & BNB switcher both Homes show, with the bridge's way in (⇄)
// when this release has the bridge screen.
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { notice, screen, canAutofocus } from '../lib/ui.js';
import { t } from '../lib/i18n.js';

let lockHookInstalled = false;

/** On lock: forget the address, the derived data keys and any words still in memory. */
async function ensureEthLockHook(app) {
  if (lockHookInstalled) return;
  lockHookInstalled = true;
  const { forgetEthWallet } = await import('../lib/eth/wallet.js');
  // On lock: forget the address, the derived data keys and any words or typed key still in memory.
  app.lockHooks.add(() => {
    forgetEthWallet();
    if (app.ethSetup && Array.isArray(app.ethSetup.words)) app.ethSetup.words.fill('');
    if (app.ethSetup && app.ethSetup.sk instanceof Uint8Array) app.ethSetup.sk.fill(0);
    app.ethSetup = null;
  });
}

/** A screen whose module is imported on first use; a spinner until then. */
function lazyScreen(load) {
  return (app, params) => {
    const holder = h('main', { class: 'screen splash', 'aria-busy': 'true' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('Opening') }));
    let inner = null;
    let dead = false;
    load()
      .then(async (m) => {
        await ensureEthLockHook(app);
        if (dead) return;
        inner = m.default(app, params) || {};
        holder.replaceWith(inner.el || inner);
        const focus = document.querySelector('#app [data-autofocus]');
        if (focus && canAutofocus()) focus.focus();
      })
      .catch((e) => {
        if (dead) return;
        console.error(e);
        holder.replaceWith(screen({ title: 'Ethereum', back: () => app.back('home') }, notice('error', t('This screen could not be opened: {message}. Go back and try again.', { message: e.message })))); // i18n-ignore: a name, the same in every language
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

export const ETH_SCREENS = {
  ethStart: lazyScreen(() => import('./eth_start.js')),
  ethWords: lazyScreen(() => import('./eth_words.js')),
  ethConfirm: lazyScreen(() => import('./eth_confirm.js')),
  ethImport: lazyScreen(() => import('./eth_import.js')),
  ethPrivacy: lazyScreen(() => import('./eth_privacy.js')),
  ethHome: lazyScreen(() => import('./eth_home.js')),
  ethReceive: lazyScreen(() => import('./eth_receive.js')),
  ethSend: lazyScreen(() => import('./eth_send.js')),
  ethTx: lazyScreen(() => import('./eth_tx.js')),
  ethSettings: lazyScreen(() => import('./eth_settings.js')),
  ethServers: lazyScreen(() => import('./eth_servers.js')),
  ethSwap: lazyScreen(() => import('./eth_swap.js')),
  ethSwapTx: lazyScreen(() => import('./eth_swap_tx.js')),
  ethSwapBsc: lazyScreen(() => import('./eth_swap_bsc.js')),
  ethRawReview: lazyScreen(() => import('./eth_raw_review.js')),
  nearIntents: lazyScreen(() => import('./near_intents.js')),
  nearIntentsDeposit: lazyScreen(() => import('./near_intents_deposit.js')),
};

/**
 * One compact row at the top of both Homes: which wallet is on screen, FIRO or Ethereum & BNB
 * (one EVM wallet on both chains). Ethereum & BNB opens its Home, which offers to create one when
 * there is none. ⇄ opens the bridge (FIRO <-> rsFIRO), when this release has it.
 */
export function chainSwitch(app, active) {
  const opt = (id, label, go) =>
    h('button', { class: `chain-opt${active === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(active === id), 'data-testid': `chain-${id}`, onclick: active === id ? null : go }, label);
  const bridge =
    typeof app.has === 'function' && app.has('bridge')
      ? h('button', { class: 'chain-move', type: 'button', 'data-testid': 'chain-bridge', 'aria-label': t('Bridge FIRO and rsFIRO'), title: t('Bridge FIRO and rsFIRO'), onclick: () => app.go('bridge', { back: active === 'eth' ? 'ethHome' : 'home' }) }, icon('bridge'))
      : null;
  return h(
    'div',
    { class: 'chain-row' },
    h('div', { class: 'chain-switch', role: 'tablist', 'aria-label': t('Wallet') }, opt('firo', 'FIRO', () => app.go('home')), opt('eth', 'Ethereum & BNB', () => app.go('ethHome'))),
    bridge,
  );
}
