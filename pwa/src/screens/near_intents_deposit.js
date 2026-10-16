/* Your NEAR Intents swap (Pay with another coin -> "Get a … deposit address", or a swap under way)
 * Spec: ONE job: send exactly this much of this coin to this address; then see the swap go through
 *       until the ETH is in this wallet, and swap it to rsFIRO (FIRO on Ethereum).
 *       Primary CTA: "Copy address" while the deposit is awaited; "Back to your Ethereum wallet"
 *       while it swaps; "Swap 0.0034 ETH to rsFIRO" once the ETH is here (secondary: keep it as
 *       ETH); "Done" when it was sent back or failed.
 *       Taps from app open: it opens by itself after Ethereum (1) -> Pay with BTC, ZEC or LTC (2) ->
 *       the form's button (3); later, Ethereum -> the swap's row (2).
 * Exit-intent reasons and answers:
 *   - "Is this address real?" -> "Signed by NEAR Intents": the signature is checked before this
 *     screen opens.
 *   - "Which network? How much exactly?" -> the coin and its network above the address; the exact
 *     amount with its own copy button; what happens to anything else.
 *   - "Did it work?" -> three steps, ticked as they happen; the screen updates by itself.
 *   - "Can I close this?" -> said: the swap is kept on this device and shows again on Ethereum Home.
 *   - "It went wrong" -> where the coins are (sent back, or still waiting) and the one next step.
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice, copyText } from '../lib/ui.js';
import { compactUnits, exactUnits } from '../lib/compact.js';
import { txExplorerUrl } from '../lib/eth/hosts.js';
import { isFinalState, OneClickError } from '../lib/intents/oneclick.js';
import { intentsExplorerUrl } from '../lib/intents/hosts.js';
import { withStatus, sameSwap } from '../lib/intents/store.js';
import { intentsClient, intentsFor, openSwaps } from '../lib/intents/wiring.js';
import { toInputString } from '../lib/eth/units.js';
import { statusWords, swapSteps, sendText, isWaiting, isExpired, swapSpend, untilText, deliveryOf } from '../lib/intents/words.js';
import { qrElement, coinBadge } from './eth_ui.js';
import { rememberNearSwaps } from '../lib/notify.js';

const POLL_MS = 15000;

function kv(label, value, extra = {}, note = null) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value, note ? h('div', { class: 'small', text: note }) : null));
}

export default function nearIntentsDeposit(app, params = {}) {
  const deposit = params.deposit;
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'stack' });
  let ctx = null;
  let swap = null;
  let loadError = null;
  let pollError = null;
  let copied = false;
  let amountCopied = false;
  let timer = null;
  let polling = false;
  let alive = true;

  const copy = async (text, amount = false) => {
    if (await copyText(text, amount ? 'Amount copied' : 'Address copied')) {
      if (amount) amountCopied = true;
      else copied = true;
      render();
    }
  };
  // ETH or BNB: what this swap delivers (both have 18 decimals).
  const coinOf = () => (swap ? deliveryOf(swap).coin : 'ETH');
  const eth = (wei) => `${compactUnits(wei, 18)} ${coinOf()}`;

  function payment(s) {
    const o = s.origin;
    const warn = notice('warn', h('span', { 'data-testid': 'ni-network-warning', text: `Send only ${o.symbol} on the ${o.chainName} network to this address. Other coins or networks sent here are lost.` }));
    return [
      warn,
      s.depositMemo
        ? (() => {
            const n = notice('error', h('strong', { text: `Add this memo: ${s.depositMemo} ` }), 'Without it the coins cannot be matched to your swap and are lost.', h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: () => copyText(s.depositMemo, 'Memo copied') }, icon('copy'), 'Copy memo')));
            n.dataset.testid = 'ni-memo';
            return n;
          })()
        : null,
      h('div', { class: 'qr qr-small', 'data-testid': 'ni-qr' }, qrElement(s.depositAddress)),
      h(
        'div',
        { class: 'card address-box' },
        h('div', { class: 'banner' }, coinBadge(o.assetId, o.symbol, 'small'), h('span', { class: 'grow small', text: `${o.chainName} deposit address` }), h('button', { class: 'btn btn-text btn-small', 'data-testid': 'ni-copy', onclick: () => copy(s.depositAddress) }, icon('copy'), copied ? 'Copied' : 'Copy')),
        h('p', { class: 'mono', 'data-testid': 'ni-deposit-address', text: s.depositAddress }),
        h('p', { class: 'small intents-signed', 'data-testid': 'ni-signed' }, icon('shield', 'inline-icon'), ' Signed by NEAR Intents'),
      ),
      h(
        'div',
        { class: 'card banner exact-amount' },
        h('div', { class: 'grow' }, h('div', { class: 'small', text: 'Send exactly' }), h('div', { class: 'big', 'data-testid': 'ni-exact-amount', text: sendText(s) })),
        h('button', { class: 'btn btn-text btn-small', 'data-testid': 'ni-copy-amount', onclick: () => copy(exactUnits(s.quote.amountIn, o.decimals).replace(/,/g, ''), true) }, icon('copy'), amountCopied ? 'Copied' : 'Copy'),
      ),
      s.quote.sendBefore ? h('p', { class: 'small', 'data-testid': 'ni-deadline', text: `Send it before ${untilText(s.quote.sendBefore)}. A deposit that comes later may be sent back to your refund address.` }) : null,
    ];
  }

  function steps(state, expired) {
    const mark = { done: 'check', active: 'clock', waiting: null, failed: 'close' };
    return h(
      'div',
      { class: 'card steps', 'data-testid': 'ni-steps' },
      ...swapSteps(state, { expired }).map((st, i) => h('div', { class: `step-row ${st.mark}`, 'data-testid': `ni-step-${i}`, 'data-mark': st.mark }, h('span', { class: 'step-mark' }, mark[st.mark] ? icon(mark[st.mark]) : null), h('span', { class: 'grow', text: st.label }))),
    );
  }

  function details(s) {
    const q = s.quote;
    const state = s.lastState;
    const got = state === 'SUCCESS' && s.amountOut != null;
    return h(
      'div',
      { class: 'card flat swap-details' },
      kv(isWaiting(state) ? 'You send' : 'You sent', sendText(s)),
      got ? kv('You got', eth(s.amountOut), { 'data-testid': 'ni-got' }) : kv('You get here', `≈ ${eth(q.amountOut)}`, { 'data-testid': 'ni-quoted' }, `at least ${eth(q.minAmountOut)}`),
      kv('Delivered to', h('span', { class: 'mono', text: shorten(q.recipient, 6, 4) }), {}, 'this Ethereum wallet'),
      kv('Refunds go to', h('span', { class: 'mono', text: shorten(q.refundTo, 6, 4) }), { 'data-testid': 'ni-refund-to' }),
      !isWaiting(state) ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Swap' }), h('button', { class: 'v mono btn-text', 'data-testid': 'ni-copy-swap', onclick: () => copy(s.depositAddress), text: shorten(s.depositAddress, 6, 4) })) : null,
      ...s.destinationTxs.filter((x) => /^0x[0-9a-fA-F]{64}$/.test(x)).map((hash) => kv('ETH transaction', h('a', { class: 'btn btn-text btn-small', href: txExplorerUrl(hash), target: '_blank', rel: 'noopener noreferrer', title: hash }, icon('external'), 'View on Etherscan'), { 'data-testid': 'ni-eth-tx' })),
    );
  }

  function render() {
    if (!alive) return;
    if (!swap) {
      titleEl.textContent = 'Pay with another coin';
      put(body, loadError ? notice('error', `Your swap could not be opened: ${loadError}`) : h('p', { class: 'small', text: 'Loading your swap…' }));
      put(actions, primary('Back to your Ethereum wallet', () => app.go('ethHome'), { 'data-testid': 'ni-deposit-cta' }));
      return;
    }
    const s = swap;
    const state = s.lastState;
    const expired = isExpired(s);
    const waiting = isWaiting(state) && !expired;
    titleEl.textContent = waiting ? `Send ${sendText(s)}` : 'Buy rsFIRO';
    const w = statusWords(s, { got: s.amountOut, ethText: eth });
    const st = notice(w.kind, h('strong', { text: `${w.title} ` }), w.detail);
    st.dataset.testid = `ni-status-${w.key}`;
    put(
      body,
      st,
      ...(waiting ? payment(s) : []),
      steps(state, expired),
      details(s),
      s.isOpen ? h('p', { class: 'small', 'data-testid': 'ni-can-leave', text: `You can leave this screen: the swap is kept on this device, and the Ethereum & BNB tab shows it until the ${coinOf()} arrives.` }) : null,
      pollError && s.isOpen ? h('p', { class: 'small', 'data-testid': 'ni-poll-error', text: "Couldn't reach NEAR Intents just now. Campfire keeps checking while this screen is open." }) : null,
      state === 'FAILED' ? h('a', { class: 'btn btn-text link-left', href: intentsExplorerUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'ni-explorer' }, 'Open the NEAR Intents explorer') : null,
    );
    let cta;
    const more = [];
    if (waiting) {
      cta = primary(h('span', { text: copied ? 'Address copied' : 'Copy address' }), () => copy(s.depositAddress), { 'data-testid': 'ni-deposit-cta' });
      cta.prepend(icon('copy'));
    } else if (expired) {
      cta = primary('Start a new swap', () => app.go('nearIntents', { assetId: s.origin.assetId }, { replace: true }), { 'data-testid': 'ni-deposit-cta' });
    } else if (state === 'SUCCESS' && swapSpend(s.amountOut, deliveryOf(s).chain.key) > 0n) {
      // Step 2 of 2: what arrived (ETH or BNB), less what its own network fee needs, to rsFIRO.
      const spend = swapSpend(s.amountOut, deliveryOf(s).chain.key);
      cta = primary(`Swap ${eth(spend)} to rsFIRO`, () => swapToRsfiro(spend), { 'data-testid': 'ni-deposit-cta' });
      more.push(textButton(`Keep it as ${coinOf()}`, () => app.go('ethHome'), { 'data-testid': 'ni-keep-eth' }));
    } else if (isFinalState(state)) {
      cta = primary('Done', () => app.go('ethHome'), { 'data-testid': 'ni-deposit-cta' });
    } else {
      cta = primary('Back to your Ethereum wallet', () => app.go('ethHome'), { 'data-testid': 'ni-deposit-cta' });
    }
    put(actions, cta, ...more);
    el.dataset.state = state || 'PENDING_DEPOSIT';
  }

  /**
   * Step 2, filled: this ETH to rsFIRO on Uniswap (Ethereum), or this BNB to rsFIRO on PancakeSwap
   * (BNB Chain), less what the swap's own network fee needs.
   */
  async function swapToRsfiro(spend) {
    if (deliveryOf(swap).chain.key === 'bsc') {
      app.bscSwapDraft = { side: 'buy', amount: toInputString(spend, 18) };
      return app.go('ethSwapBsc', { step2: true }, { replace: true });
    }
    const { DEFAULT_SLIPPAGE } = await import('../lib/eth/uniswap/service.js');
    app.uniDraft = { pay: 'ETH', receive: 'rsFIRO', amount: toInputString(spend, 18), slippage: DEFAULT_SLIPPAGE };
    app.go('ethSwap', { step2: true }, { replace: true });
  }

  async function poll() {
    if (!alive || !swap || !swap.isOpen || polling || !ctx) return;
    if (document.visibilityState !== 'visible' || !app.dbPass) return;
    polling = true;
    try {
      const st = await intentsClient().status(swap.depositAddress, { memo: swap.depositMemo });
      if (!alive) return;
      pollError = null;
      const next = withStatus(swap, st, Date.now());
      if (!sameSwap(swap, next)) {
        swap = next;
        await ctx.store.save(next).catch((e) => console.warn('[campfire] near intents save', e && e.message));
        if (next.lastState === 'SUCCESS') ctx.w.refresh().catch(() => {});
      }
    } catch (e) {
      if (!alive) return;
      pollError = e instanceof OneClickError ? e : new OneClickError('unexpected', String(e && e.message));
    } finally {
      polling = false;
    }
    render();
  }

  const el = screen({ title: 'Pay with another coin', back: () => app.back('ethHome'), actions: [actions], cls: 'buy-order intents sticky-actions' }, body);
  const titleEl = el.querySelector('.topbar h1');
  const onVis = () => {
    if (document.visibilityState === 'visible') poll();
  };
  document.addEventListener('visibilitychange', onVis);
  render();

  (async () => {
    try {
      ctx = await intentsFor(app);
      if (!ctx) return app.go('ethStart', { from: 'buy' });
      swap = await ctx.store.get(deposit);
      openSwaps(ctx.store).then(rememberNearSwaps); // reminders before the deposit address stops taking coins
      if (!swap) loadError = 'this device does not keep that swap.';
    } catch (e) {
      loadError = e.message;
    }
    if (!alive) return;
    render();
    // Where it is now, not where it was when the app last looked.
    await poll();
    timer = setInterval(poll, POLL_MS);
  })();

  return {
    el,
    destroy() {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
