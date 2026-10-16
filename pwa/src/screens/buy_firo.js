/* Buy FIRO (Home -> Buy)
 * Spec: ONE job: pay with a coin from another chain, get FIRO in this wallet.
 *       Primary CTA: "Get a BTC deposit address" (the ticker follows the coin). Paying happens on
 *       the next screen, from any wallet.
 *       Taps from app open: Buy (1) -> amount (and a refund address, filled in when the app has
 *       one) -> the button (2).
 * Exit-intent reasons and answers:
 *   - "What do I get?" -> about how much FIRO, as buyfiro.app prices it, that it arrives in the
 *     public balance (one tap to make it private), and how long it usually takes, before any
 *     address exists.
 *   - "Is there a minimum?" -> said up front ("Smallest buy right now: about $1,000"); when an
 *     amount is under it, the route's own floor is said ("This route starts at about $1,005",
 *     from buyfiro.app's answer), the amount that is not is one tap away, and so is this
 *     wallet's way for smaller amounts (rsFIRO on Ethereum).
 *   - "Who has my money?" -> buyfiro.app is named; the FIRO goes to a new address of this wallet
 *     that the app makes itself; refunds go to the person's own address on the coin's chain.
 *   - "It doesn't work" -> every refusal says what happened, that nothing was sent, and the one
 *     thing that fixes it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, assetBadge } from '../lib/ui.js';
import { BuyAmount, BuyError, isDefaultCoin, isPopular } from '../lib/buy/buyfiro.js';
import { usd, firoText, etaText, minimumAmount, problemText, whyUnreachable } from '../lib/buy/words.js';
import { compactUnits } from '../lib/compact.js';
import { buyFiro, buyAddress, WalletNotReady } from '../lib/buy/wiring.js';
import { hasEthWallet } from '../lib/eth/record.js';
import { coinBadge } from './buy_screens.js';
import { buySiteUrl } from '../lib/buy/hosts.js';
import { loaderBehind } from '../lib/loader.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The person's own address on the coin's chain, when the app has a wallet there (the Ethereum wallet, for coins on Ethereum). */
async function ownAddressOn(app, coin) {
  if (coin.blockchain !== 'eth' || !(await hasEthWallet())) return null;
  const { ethWallet, forgetEthWallet } = await import('../lib/eth/wallet.js');
  app.lockHooks.add(forgetEthWallet);
  const w = await ethWallet(app);
  return w ? w.state.address : null;
}

export default function buyFiroScreen(app) {
  const c = buyFiro(app);
  const draft = (app.buyDraft = app.buyDraft || { assetId: null, amount: '', refund: '', prefilled: null });
  let assets = null;
  let assetsFailed = false;
  let assetsError = null;
  let coin = null;
  let value = null;
  let amountError = null;
  let busy = false;
  let orderError = null;
  let walletProblem = null;
  let alive = true;

  const amountInput = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount you pay', 'data-testid': 'buy-amount' });
  amountInput.value = draft.amount;
  const coinBtn = h('button', { class: 'asset-pick', type: 'button', 'data-testid': 'buy-coin', onclick: () => pickCoin() });
  const paySub = h('div', { class: 'swap-sub' });
  const refundLabel = h('span', { class: 'grow' });
  const refund = h('input', { class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Your refund address', 'data-testid': 'buy-refund' });
  refund.value = draft.refund;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'buy-refund-paste' }, icon('paste'), 'Paste');
  const refundHint = h('p', { class: 'hint', 'data-testid': 'buy-refund-hint' });
  const getsBox = h('div', { class: 'card swap-box' });
  const topBox = h('div');
  const problemBox = h('div', { 'aria-live': 'polite' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'buy-reason', 'aria-live': 'polite' });
  const cta = primary('Get a deposit address', getAddress, { disabled: true, 'data-testid': 'buy-cta' });

  // ------------------------------------------------------------ coins
  async function load(refresh = false) {
    try {
      const list = await c.assets({ refresh });
      if (!alive) return;
      assets = list;
      assetsFailed = false;
      if (!coin && list.length) await setCoin(list.find((a) => a.assetId === draft.assetId) || list.find(isDefaultCoin) || list[0]);
    } catch (e) {
      if (!alive) return;
      assetsFailed = true;
      assetsError = e;
    }
    render();
  }

  async function setCoin(next) {
    const previous = coin;
    coin = next;
    draft.assetId = next.assetId;
    if (!previous || previous.blockchain !== next.blockchain) {
      // A refund address only works on its own chain.
      if (!refund.value.trim() || refund.value === draft.prefilled) {
        refund.value = '';
        draft.refund = '';
        draft.prefilled = null;
      }
      changed();
      const mine = await ownAddressOn(app, next).catch(() => null);
      if (alive && mine && !refund.value.trim() && coin === next) {
        refund.value = mine;
        draft.refund = mine;
        draft.prefilled = mine;
      }
    }
    changed();
  }

  function pickCoin() {
    if (!assets) return;
    openSheet((close, rerender) => {
      const search = h('input', { class: 'input', type: 'search', placeholder: 'Coin or chain (BTC, Tron, Solana…)', 'aria-label': 'Search', autocomplete: 'off', 'data-testid': 'buy-coin-search' });
      const list = h('div', { class: 'card list picker-list' });
      const row = (a) =>
        h(
          'button',
          { class: `row${coin && a.assetId === coin.assetId ? ' on' : ''}`, 'data-testid': 'buy-coin-row', 'data-asset-id': a.assetId, onclick: () => close(a) },
          coinBadge(a.assetId, a.symbol),
          h('span', { class: 'main' }, h('div', { class: 't', text: a.symbol }), h('div', { class: 's', text: a.isNative ? a.chainName : `on ${a.chainName}` })),
          a.priceUsd ? h('span', { class: 'end small', text: a.priceUsd >= 100 ? `$${a.priceUsd.toFixed(0)}` : a.priceUsd >= 1 ? `$${a.priceUsd.toFixed(2)}` : `$${a.priceUsd.toPrecision(3)}` }) : null,
        );
      const fill = () => {
        const q = search.value.trim().toLowerCase();
        const shown = assets.filter((a) => !q || a.symbol.toLowerCase().includes(q) || a.chainName.toLowerCase().includes(q) || a.blockchain.includes(q));
        const popular = shown.filter(isPopular);
        const rest = shown.filter((a) => !isPopular(a));
        put(
          list,
          ...(popular.length ? [h('p', { class: 'section-title', text: 'Most used' }), ...popular.map(row)] : []),
          ...(rest.length ? [h('p', { class: 'section-title', text: `All coins (${assets.length})` }), ...rest.map(row)] : []),
          shown.length ? null : h('p', { class: 'small center pad', text: `buyfiro.app does not take "${search.value.trim()}". Try its ticker or its chain.` }),
        );
      };
      search.addEventListener('input', fill);
      fill();
      return [h('h2', { text: 'Pay with' }), search, list, h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close')];
    }, { label: 'Pay with' }).then((a) => {
      if (a && alive) setCoin(a);
    });
  }

  // ------------------------------------------------------------ input
  // An EVM refund address in mixed case carries a checksum (EIP-55): one character mistyped and the
  // refund goes to an address nobody holds (public audit, PN). Checked once the checker is loaded
  // (it is loaded with this screen); until then a quote waits for it.
  let checksumOk = null;
  import('../lib/eth/crypto.js')
    .then((m) => {
      checksumOk = m.isAddress;
      if (alive) changed();
    })
    .catch(() => {});
  function refundError() {
    const r = refund.value.trim();
    if (!coin || !r || !coin.isEvm) return null;
    if (!EVM_ADDRESS.test(r)) return `${coin.chainName} addresses start with 0x and have 42 characters.`;
    if (!checksumOk) return 'Checking the address…';
    if (!checksumOk(r)) return "One character of this address looks mistyped (its capital letters don't add up). Copy it again rather than typing it.";
    return null;
  }

  function changed() {
    const parsed = coin ? BuyAmount.parse(amountInput.value, coin.decimals) : { amount: null, error: null };
    value = parsed.amount;
    amountError = parsed.error;
    orderError = null;
    walletProblem = null;
    const r = refund.value.trim();
    if (!coin || !value || !value.isPositive || !value.exact || !r || refundError()) c.requestQuote(null);
    else c.requestQuote({ asset: coin, amount: value, refundAddress: r });
    render();
  }

  function setAmount(text) {
    amountInput.value = text;
    draft.amount = text;
    changed();
  }

  // ------------------------------------------------------------ the order
  async function getAddress() {
    if (!coin || !value || busy) return;
    busy = true;
    orderError = null;
    walletProblem = null;
    render();
    try {
      const order = await c.placeOrder({ asset: coin, amount: value, refundAddress: refund.value.trim(), walletId: app.record.id, newWalletAddress: () => buyAddress(), quote: c.quote });
      if (!alive) return;
      app.buyDraft = null;
      app.go('buyOrder', { deposit: order.depositAddress, fresh: true }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      if (e instanceof BuyError) orderError = e;
      else if (e instanceof WalletNotReady) walletProblem = 'Your wallet is still starting, so it cannot make an address for the FIRO yet. Try again in a moment.';
      else walletProblem = "Campfire couldn't finish setting up this buy. Nothing was sent. Try again.";
    }
    busy = false;
    render();
  }

  function ctaState() {
    if (busy) return { off: 'Asking buyfiro.app for a deposit address…' };
    if (assetsFailed) return { off: '' };
    if (!coin) return { off: assets === null ? 'Loading the coins buyfiro.app takes…' : 'Pick the coin you pay with.' };
    if (amountError) return { off: amountError };
    if (!value || !value.isPositive) return { off: `Enter how much ${coin.symbol} you pay.` };
    if (!value.exact) return { off: '' };
    if (!refund.value.trim()) return { off: `Add your ${coin.chainName} address for a refund.` };
    if (refundError()) return { off: refundError() };
    if (c.quoteError) return { off: '' };
    if (c.quoting || !c.quote) return { off: 'Getting a price from buyfiro.app…' };
    return { off: null };
  }

  // ------------------------------------------------------------ problems
  function problem() {
    if (!coin) return null;
    if (walletProblem) {
      return notice('warn', h('strong', { text: 'Nothing was sent. ' }), walletProblem, h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: getAddress, 'data-testid': 'buy-wallet-retry' }, 'Try again')));
    }
    if (value && value.isPositive && !value.exact) {
      const nearest = value.nearestExact();
      const n = notice(
        'warn',
        h('strong', { text: `buyfiro.app can't take exactly ${value.text} ${coin.symbol}. ` }),
        nearest ? `It would read it as a slightly different amount, and the payment would not match. ${nearest} ${coin.symbol} is read exactly.` : `Campfire can't send buyfiro.app an exact amount of ${coin.symbol}. Pick another coin.`,
        h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'buy-fix', onclick: () => (nearest ? setAmount(nearest) : pickCoin()) }, nearest ? `Use ${nearest} ${coin.symbol}` : 'Pick another coin')),
      );
      n.dataset.testid = 'buy-inexact';
      return n;
    }
    const e = orderError || c.quoteError;
    if (!e) return null;
    let minimum = null;
    if (e.belowMinimum && e.minimumUsd != null) {
      const price = coin.priceUsd ?? (e.orderValueUsd != null && value && value.value > 0 ? e.orderValueUsd / value.value : null);
      minimum = minimumAmount(e.minimumUsd, coin, { priceUsd: price });
    }
    const p = problemText(e, { coin, minimum });
    const fix = () => {
      if (p.fix === 'useMinimum' && minimum) setAmount(minimum);
      else if (p.fix === 'editAmount') {
        amountInput.focus();
        amountInput.select();
      } else if (p.fix === 'pickCoin') pickCoin();
      else if (p.fix === 'editRefund') refund.focus();
      else if (p.fix === 'tryAgain') {
        if (orderError) getAddress();
        else c.requote();
      }
    };
    const action =
      p.fix === 'contactSupport'
        ? h('a', { class: 'btn btn-secondary btn-small', href: buySiteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'buy-support' }, p.fixLabel)
        : h('button', { class: 'btn btn-secondary btn-small', onclick: fix, 'data-testid': 'buy-fix' }, p.fixLabel);
    // Under this route's floor: this wallet's other way, for smaller amounts (rsFIRO, FIRO on Ethereum).
    const smaller =
      p.smaller && app.has('nearIntents')
        ? [h('p', { class: 'small', 'data-testid': 'buy-smaller-note', text: 'For a smaller amount, buy rsFIRO (FIRO on Ethereum or BNB Chain) with any coin.' }), h('button', { class: 'btn btn-text btn-small', 'data-testid': 'buy-smaller', onclick: () => ((app.buyDraft = null), app.go('nearIntents', {}, { replace: true })) }, 'Buy rsFIRO instead')]
        : [];
    const n = notice(p.serious || e.unreachable ? 'error' : 'warn', h('strong', { text: `${p.title} ` }), p.detail || '', h('div', { class: 'btn-row prompt-actions' }, action, ...smaller.slice(1)), ...smaller.slice(0, 1));
    n.dataset.testid = 'buy-problem';
    n.dataset.code = e.code;
    return n;
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!alive) return;
    const mine = c.orders(app.record.id);
    const open = mine.filter((o) => o.isOpen).length;
    put(
      topBox,
      mine.length
        ? h(
            'button',
            { class: 'card row entry-row', onclick: () => app.go('buyOrders'), 'data-testid': 'buy-your-buys' },
            h('span', { class: `ico${open ? ' wait' : ''}` }, icon(open ? 'clock' : 'activity')),
            h('span', { class: 'main' }, h('div', { class: 't', text: open ? `Your buys (${open} in progress)` : 'Your buys' })),
            h('span', { class: 'chev' }, icon('chevron')),
          )
        : null,
      assetsFailed && loaderBehind()
        ? notice('warn', h('strong', { text: 'Finish the update first. ' }), 'Until it is finished this version cannot reach buyfiro.app. Nothing was sent.', h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-primary btn-small', 'data-testid': 'buy-update-finish', onclick: () => location.reload() }, 'Finish now')))
        : assetsFailed
          ? notice('error', h('strong', { text: "Couldn't reach buyfiro.app. " }), 'This is not something you did. Nothing was sent.', h('div', { class: 'hint', 'data-testid': 'buy-assets-why', text: whyUnreachable(assetsError) }), h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'buy-assets-retry', onclick: () => ((assetsFailed = false), render(), load(true)) }, 'Try again')))
          : null,
    );

    put(coinBtn, ...(coin ? [coinBadge(coin.assetId, coin.symbol, 'small'), h('span', { class: 'coin-chip' }, h('span', { text: coin.symbol }), h('span', { class: 'chain', text: coin.chainName }))] : [h('span', { text: assets ? 'Choose' : '…' })]), icon('down'));
    const worth = coin && coin.priceUsd != null && value && value.isPositive ? `≈\u00a0${usd(value.value * coin.priceUsd)}` : '';
    const hint = c.minimumHintUsd;
    put(paySub, h('span', { 'data-testid': 'buy-worth', text: worth }), h('span', { class: 'grow right', 'data-testid': 'buy-minimum-hint', text: hint == null ? '' : `Smallest buy right now: about ${usd(hint)}` }));

    refundLabel.textContent = coin ? `Your ${coin.chainName} address, for a refund if the buy can't go through` : "Your address, for a refund if the buy can't go through";
    refund.placeholder = coin ? `Paste your ${coin.symbol} address` : 'Address';
    const rErr = refundError();
    refundHint.textContent = rErr || (refund.value && refund.value === draft.prefilled ? 'Your Ethereum wallet’s address, filled in for you.' : '');
    refundHint.className = `hint${rErr ? ' bad' : ''}`;
    refund.classList.toggle('bad', Boolean(rErr));

    const q = c.quote;
    put(
      getsBox,
      h('div', { class: 'swap-label', text: 'You receive' }),
      h(
        'div',
        { class: 'swap-line' },
        h('div', { class: `swap-out${q ? '' : ' muted'}`, 'data-testid': q ? 'buy-estimate' : c.quoting ? 'buy-estimate-loading' : 'buy-estimate-empty', 'data-sats': q ? String(q.estimateSats) : '', title: q ? `About ${firoText(q.estimateSats)}` : null, text: q ? `≈\u00a0${compactUnits(q.estimateSats, 8)}` : c.quoting ? '…' : '0' }),
        h('span', { class: 'asset-pick static' }, assetBadge({ id: 'firo' }, { size: 'small' }), h('span', { text: 'FIRO' })),
      ),
      h('div', { class: 'swap-sub stacked' }, h('span', { 'data-testid': 'buy-arrives-in', text: 'Arrives in your public balance' }), q && q.etaSeconds != null ? h('span', { 'data-testid': 'buy-eta', text: etaText(q.etaSeconds) }) : null),
    );

    put(problemBox, problem());
    const st = ctaState();
    cta.disabled = Boolean(st.off !== null);
    cta.textContent = coin ? `Get a ${coin.symbol} deposit address` : 'Get a deposit address';
    reason.textContent = st.off || '';
    reason.classList.toggle('hidden', !st.off);
  }

  amountInput.addEventListener('input', () => {
    draft.amount = amountInput.value;
    changed();
  });
  refund.addEventListener('input', () => {
    draft.refund = refund.value;
    changed();
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      refund.value = (await navigator.clipboard.readText()).trim();
      draft.refund = refund.value;
      changed();
    } catch {
      refundHint.textContent = 'Press and hold in the box, then tap Paste.';
      refund.focus();
    }
  });

  const off = c.onChange(() => render());
  c.cancelQuote();
  c.resumeAll();
  c.refreshLimits();
  load();
  render();

  const el = screen(
    {
      title: 'Buy private FIRO',
      back: () => {
        app.buyDraft = null;
        app.back('home');
      },
      actions: [reason, cta],
      cls: 'swap buy sticky-actions',
    },
    topBox,
    h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: 'You pay' }), h('div', { class: 'swap-line' }, amountInput, coinBtn), paySub),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, refundLabel, pasteBtn), refund),
    refundHint,
    getsBox,
    problemBox,
    h('p', { class: 'small', 'data-testid': 'buy-footer', text: 'buyfiro.app buys the FIRO and sends it to your wallet.' }),
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
      c.cancelQuote();
    },
  };
}
