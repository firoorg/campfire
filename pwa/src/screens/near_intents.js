/* Pay with BTC, ZEC or LTC (Ethereum Home's row, and the Uniswap swap's)
 * Spec: ONE job: bring a coin from another chain (BTC, ZEC, LTC… any coin NEAR Intents swaps) into
 *       this Ethereum wallet as ETH, to swap it to rsFIRO (FIRO on Ethereum) with it.
 *       Primary CTA: "Get a BTC deposit address" (the ticker follows the coin). Paying happens on the
 *       next screen, from any wallet or exchange.
 *       Taps from app open: Ethereum (1) -> "Pay with BTC, ZEC or LTC" (2) -> amount and a refund
 *       address -> the button (3).
 * Exit-intent reasons and answers:
 *   - "Is this a scam?" -> NEAR Intents is named, the ETH goes to this wallet's own address (shown),
 *     and the next screen's address is shown only when NEAR Intents' signature on it checks out.
 *   - "What do I get?" -> the ETH, its worth, the least it can be, how long it takes and the rsFIRO
 *     it buys right now, before any address exists. (NEAR Intents lists neither FIRO nor rsFIRO.)
 *   - "What if it goes wrong?" -> the refund address is asked in plain words; the coins go back there
 *     if the swap cannot happen.
 *   - "Who sees this?" -> one line says what NEAR Intents sees: the IP address, the coin and amount,
 *     the refund address and this wallet's Ethereum address.
 *   - "What does it cost?" -> fees are in the quote; the difference in dollars is shown.
 *   - "I wanted FIRO" -> one link at the bottom: Buy FIRO, which pays into the Firo wallet (when this
 *     release has the Buy screens).
 *   - "It doesn't work" -> every refusal says what happened, that nothing was sent, and the one thing
 *     that fixes it.
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet } from '../lib/ui.js';
import { parseUnits } from '../lib/eth/units.js';
import { compactUnits, exactUnits } from '../lib/compact.js';
import { ETH } from '../lib/eth/tokens.js';
import { OneClickError, isPopular } from '../lib/intents/oneclick.js';
import { ONECLICK } from '../lib/intents/hosts.js';
import { makeSwap } from '../lib/intents/store.js';
import { intentsClient, intentsTokens, intentsFor, openSwaps } from '../lib/intents/wiring.js';
import { durationText, feeText, problemWords, stateLine, whoSees, usd } from '../lib/intents/words.js';
import { loaderBehind } from '../lib/loader.js';
import { ethBadge, coinBadge } from './eth_ui.js';
import { rememberNearSwaps } from '../lib/notify.js';
import { t, tNodes } from '../lib/i18n.js';

const QUOTE_DELAY_MS = 600;

/** "$82,967", "$1.00", "$0.0123": a coin's price in the picker. */
function priceText(p) {
  return p >= 1 ? usd(p >= 100 ? Math.round(p) : Math.round(p * 100) / 100) : `$${p.toPrecision(3)}`;
}
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Where the swap delivers, as one sentence (the address an element inside it): its parts, for h(). */
function deliveredTo(worth, address) {
  if (worth != null) return address ? tNodes('≈ {usd}, delivered to {address}', { usd: worth, address }) : [t('≈ {usd}, delivered to this wallet', { usd: worth })];
  return address ? tNodes('Delivered to {address}, this Ethereum wallet', { address }) : [t('Delivered to this wallet, this Ethereum wallet')];
}

export default function nearIntents(app, params = {}) {
  const draft = (app.intentsDraft = app.intentsDraft || { assetId: null, amount: '', refund: '', prefilled: null });
  let ctx = null; // {w, address, store}
  let tokens = null;
  let tokensError = null;
  let coin = null;
  let quote = null;
  let quoting = false;
  let problem = null; // OneClickError, from a price or a deposit address
  let saveProblem = null;
  let rsfiro = null; // rsFIRO the minimum ETH buys now
  let busy = false;
  let open = [];
  let seq = 0;
  let timer = null;
  let alive = true;

  const amountInput = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t('Amount you send'), 'data-testid': 'ni-amount' });
  amountInput.value = draft.amount;
  const coinBtn = h('button', { class: 'asset-pick', type: 'button', 'data-testid': 'ni-coin', onclick: () => pickCoin() });
  const paySub = h('div', { class: 'swap-sub' });
  const refundLabel = h('span', { class: 'grow' });
  const refund = h('input', { class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', 'aria-label': t('Your refund address'), 'data-testid': 'ni-refund' });
  refund.value = draft.refund;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'ni-refund-paste' }, icon('paste'), t('Paste'));
  const refundHint = h('p', { class: 'hint', 'data-testid': 'ni-refund-hint' });
  const getsBox = h('div', { class: 'card swap-box' });
  const detailsBox = h('div');
  const topBox = h('div', { class: 'stack' });
  const problemBox = h('div', { 'aria-live': 'polite' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'ni-reason', 'aria-live': 'polite' });
  const cta = primary(t('Get a deposit address'), getAddress, { disabled: true, 'data-testid': 'ni-cta' });

  // ------------------------------------------------------------ amounts
  function amountState() {
    const item = amountInput.value.trim();
    if (!coin || !item) return { value: null, error: null };
    try {
      const v = parseUnits(item, coin.decimals, { symbol: coin.symbol });
      return v > 0n ? { value: v, error: null } : { value: null, error: t('The amount must be more than zero.') };
    } catch (e) {
      return { value: null, error: e.message };
    }
  }

  // A mixed-case EVM refund address carries a checksum (EIP-55): checked, so one mistyped character
  // never sends a refund to an address nobody holds (public audit, PN). The checker is loaded with
  // this screen; until it is, a quote waits.
  let checksumOk = null;
  import('../lib/eth/crypto.js')
    .then((m) => {
      checksumOk = m.isAddress;
      if (alive) changed();
    })
    .catch(() => {});
  function refundError() {
    const r = refund.value.trim();
    if (!coin || !r) return null;
    if (coin.isEvm && !EVM_ADDRESS.test(r)) return t('{chainName} addresses start with 0x and have 42 characters.', { chainName: coin.chainName });
    if (coin.isEvm && !checksumOk) return t('Checking the address…');
    if (coin.isEvm && !checksumOk(r)) return t("One character of this address looks mistyped (its capital letters don't add up). Copy it again rather than typing it.");
    if (/\s/.test(r)) return t('An address has no spaces.');
    return null;
  }

  // ------------------------------------------------------------ coins
  async function loadTokens(refresh = false) {
    tokensError = null;
    render();
    try {
      const list = await intentsTokens({ refresh });
      if (!alive) return;
      tokens = list;
      if (!coin && list.length) setCoin(list.find((item) => item.assetId === (params.assetId || draft.assetId)) || list.find((token) => token.symbol === 'BTC' && token.blockchain === 'btc') || list[0]);
    } catch (e) {
      if (!alive) return;
      tokensError = e instanceof OneClickError ? e : new OneClickError('network', String(e && e.message));
    }
    render();
  }

  function setCoin(next) {
    const before = coin;
    coin = next;
    draft.assetId = next.assetId;
    if (!before || before.blockchain !== next.blockchain) {
      // A refund address only works on its own chain.
      if (!refund.value.trim() || refund.value === draft.prefilled) {
        refund.value = '';
        draft.refund = '';
        draft.prefilled = null;
      }
      prefillRefund();
    }
    changed();
  }

  /** This wallet's own address takes refunds for a coin on Ethereum. */
  function prefillRefund() {
    if (coin && coin.blockchain === 'eth' && ctx && !refund.value.trim()) {
      refund.value = ctx.address;
      draft.refund = ctx.address;
      draft.prefilled = ctx.address;
    }
  }

  function pickCoin() {
    if (!tokens) return;
    openSheet((close) => {
      const search = h('input', { class: 'input', type: 'search', placeholder: t('Coin or chain (BTC, Tron, Solana…)'), 'aria-label': t('Search'), autocomplete: 'off', 'data-testid': 'ni-coin-search' });
      const list = h('div', { class: 'card list picker-list' });
      const row = (token) =>
        h(
          'button',
          { class: `row${coin && token.assetId === coin.assetId ? ' on' : ''}`, 'data-testid': 'ni-coin-row', 'data-asset-id': token.assetId, 'data-symbol': token.symbol, 'data-chain': token.blockchain, onclick: () => close(token) },
          coinBadge(token.assetId, token.symbol),
          h('span', { class: 'main' }, h('div', { class: 't', text: token.symbol }), h('div', { class: 's', text: token.isNative ? token.chainName : t('on {chainName}', { chainName: token.chainName }) })),
          token.priceUsd ? h('span', { class: 'end small', text: priceText(token.priceUsd) }) : null,
        );
      const fill = () => {
        const q = search.value.trim().toLowerCase();
        const shown = tokens.filter((token) => !q || token.symbol.toLowerCase().includes(q) || token.chainName.toLowerCase().includes(q) || (token.chainNameEn || '').toLowerCase().includes(q) || token.blockchain.includes(q));
        const popular = shown.filter(isPopular);
        const rest = shown.filter((item) => !isPopular(item));
        put(
          list,
          ...(popular.length ? [h('p', { class: 'section-title', text: t('Most used') }), ...popular.map(row)] : []),
          ...(rest.length ? [h('p', { class: 'section-title', text: t('All coins ({n})', { n: tokens.length }) }), ...rest.map(row)] : []),
          shown.length ? null : h('p', { class: 'small center pad', text: t('NEAR Intents does not take "{search}". Try its ticker or its chain.', { search: search.value.trim() }) }),
        );
      };
      search.addEventListener('input', fill);
      fill();
      return [h('h2', { text: t('The coin you send') }), search, list, h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close'))];
    }, { label: t('The coin you send') }).then((item) => {
      if (item && alive) setCoin(item);
    });
  }

  // ------------------------------------------------------------ quotes
  function changed() {
    clearTimeout(timer);
    seq++;
    quote = null;
    rsfiro = null;
    problem = null;
    saveProblem = null;
    const a = amountState();
    quoting = Boolean(ctx && coin && a.value != null && refund.value.trim() && !refundError());
    render();
    if (quoting) timer = setTimeout(requote, QUOTE_DELAY_MS);
  }

  async function requote() {
    const a = amountState();
    const r = refund.value.trim();
    if (!ctx || !coin || a.value == null || !r) return;
    const mine = ++seq;
    quoting = true;
    render();
    try {
      const q = await intentsClient().quote({ origin: coin, amountIn: a.value, recipient: ctx.address, refundTo: r, dry: true });
      if (!alive || mine !== seq) return;
      quote = q;
      problem = null;
      priceRsfiro(q.minAmountOut, mine);
    } catch (e) {
      if (!alive || mine !== seq) return;
      quote = null;
      problem = e instanceof OneClickError ? e : new OneClickError('unexpected', String(e && e.message));
    }
    quoting = false;
    render();
  }

  /** What that ETH buys in rsFIRO right now, through the wallet's own Ethereum server (the ETH estimate alone is still right without it). */
  async function priceRsfiro(eth, mine) {
    try {
      const { uniswapFor, SWAP_TOKENS, RSFIRO_TOKEN } = await import('../lib/eth/uniswap_app.js');
      const svc = await uniswapFor(ctx.w);
      const q = await svc.quote({ tokenIn: SWAP_TOKENS[0], tokenOut: RSFIRO_TOKEN, amountIn: eth, owner: ctx.address });
      if (alive && mine === seq) {
        rsfiro = q.amountOut;
        render();
      }
    } catch {
      // Without it the form still says what arrives.
    }
  }

  // ------------------------------------------------------------ the deposit address
  async function getAddress() {
    const a = amountState();
    if (!coin || a.value == null || busy || !ctx) return;
    busy = true;
    problem = null;
    saveProblem = null;
    render();
    try {
      const q = await intentsClient().quote({ origin: coin, amountIn: a.value, recipient: ctx.address, refundTo: refund.value.trim(), dry: false });
      const swap = makeSwap({ quote: q.raw, origin: coin, createdAt: Date.now() });
      try {
        // Kept on this device before it is shown: a deposit address nobody can look up again is lost money.
        await ctx.store.save(swap);
      } catch (e) {
        if (!alive) return;
        saveProblem = t('Firo PWA couldn\'t keep this swap on this device ({message}), so no address is shown. Nothing was sent. Try again.', { message: e.message });
        busy = false;
        render();
        problemBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (!alive) return;
      app.intentsDraft = null;
      app.go('nearIntentsDeposit', { deposit: swap.depositAddress, fresh: true }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      problem = e instanceof OneClickError ? e : new OneClickError('unexpected', String(e && e.message));
    }
    busy = false;
    render();
    // What went wrong, where the person is looking.
    if (problemBox.firstChild) problemBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function ctaState() {
    if (busy) return { off: t('Asking NEAR Intents for a deposit address…') };
    if (!ctx) return { off: t('Opening your Ethereum wallet…') };
    if (tokensError) return { off: '' };
    if (!coin) return { off: tokens === null ? t('Loading the coins NEAR Intents takes…') : t('Pick the coin you have.') };
    const a = amountState();
    if (a.error) return { off: a.error };
    if (a.value == null) return { off: t('Enter how much {symbol} you send.', { symbol: coin.symbol }) };
    if (!refund.value.trim()) return { off: t('Add your {chainName} address for a refund.', { chainName: coin.chainName }) };
    if (refundError()) return { off: refundError() };
    // The notice can be below the fold (the keyboard is up): its title goes right above the button too.
    if (saveProblem) return { off: t("Firo PWA couldn't keep this swap. Nothing was sent.") };
    if (problem) return { off: problem.unreachable && loaderBehind() ? t('Finish the update first.') : problemWords(problem, { coin }).title };
    if (quoting || !quote) return { off: t('Getting a price from NEAR Intents…') };
    return { off: null };
  }

  // ------------------------------------------------------------ problems
  function problemNotice() {
    if (saveProblem) {
      const n = notice('error', h('strong', { text: t('Nothing was sent. ') }), saveProblem, h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'ni-fix', onclick: getAddress }, t('Try again'))));
      n.dataset.testid = 'ni-problem';
      return n;
    }
    if (!problem) return null;
    if (problem.unreachable && loaderBehind()) return updateNotice();
    const a = amountState();
    const p = problemWords(problem, { coin, amountText: a.value != null ? `${exactUnits(a.value, coin.decimals)} ${coin.symbol}` : null });
    const fix = () => {
      if (p.fix === 'useMinimum' && p.minimum != null) setAmount(exactUnits(p.minimum, coin.decimals).replace(/,/g, ''));
      else if (p.fix === 'editAmount') {
        amountInput.focus();
        amountInput.select();
      } else if (p.fix === 'editRefund') refund.focus();
      else if (p.fix === 'pickCoin') pickCoin();
      else changed();
    };
    const n = notice(p.kind, h('strong', { text: `${p.title} ` }), p.detail, h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: fix, 'data-testid': 'ni-fix' }, p.fixLabel)));
    n.dataset.testid = 'ni-problem';
    n.dataset.code = problem.code;
    return n;
  }

  function updateNotice() {
    const n = notice('warn', h('strong', { text: t('Finish the update first. ') }), t('Until it is finished this version cannot reach NEAR Intents. Nothing was sent.'), h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-primary btn-small', 'data-testid': 'ni-update-finish', onclick: () => location.reload() }, t('Finish now'))));
    n.dataset.testid = 'ni-update';
    return n;
  }

  function setAmount(text) {
    amountInput.value = text;
    draft.amount = text;
    changed();
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!alive) return;
    put(
      topBox,
      ...open.map((s) =>
        h(
          'button',
          { class: 'card row entry-row', 'data-testid': 'ni-open-swap', 'data-deposit': s.depositAddress, onclick: () => app.go('nearIntentsDeposit', { deposit: s.depositAddress }) },
          h('span', { class: 'ico wait' }, coinBadge(s.origin.assetId, s.origin.symbol, 'small')),
          h('span', { class: 'main' }, h('div', { class: 't', text: stateLine(s) }), h('div', { class: 's', text: t('NEAR Intents · tap to see the deposit address') })),
          h('span', { class: 'chev' }, icon('chevron')),
        ),
      ),
      tokensError && tokensError.unreachable && loaderBehind()
        ? updateNotice()
        : tokensError
          ? (() => {
              const n = notice('error', h('strong', { text: t("Couldn't load NEAR Intents' coins. ") }), t('This is not something you did. Nothing was sent.'), h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'ni-coins-retry', onclick: () => loadTokens(true) }, t('Try again'))));
              n.dataset.testid = 'ni-coins-failed';
              return n;
            })()
          : null,
    );

    const a = amountState();
    put(coinBtn, ...(coin ? [coinBadge(coin.assetId, coin.symbol, 'small'), h('span', { class: 'coin-chip' }, h('span', { text: coin.symbol }), h('span', { class: 'chain', text: coin.chainName }))] : [h('span', { text: tokens || tokensError ? t('Choose') : '…' })]), icon('down'));
    const worth = coin && coin.priceUsd != null && a.value != null ? `≈ ${usd((Number(a.value) / 10 ** coin.decimals) * coin.priceUsd)}` : '';
    put(paySub, h('span', { 'data-testid': 'ni-worth', text: worth }));

    refundLabel.textContent = coin ? t('Your {chainName} address for a refund', { chainName: coin.chainName }) : t('Your address for a refund');
    refund.placeholder = coin ? t('Your {symbol} address', { symbol: coin.symbol }) : t('Address');
    const rErr = refundError() || (problem && problem.code === 'refused' && /refund/i.test(problem.said || '') ? t('NEAR Intents says this isn\'t a {chainName} address.', { chainName: coin ? coin.chainName : '' }) : null);
    refundHint.textContent = rErr || (refund.value && refund.value === draft.prefilled ? t('This wallet’s address, filled in for you.') : coin ? t('If the swap can\'t happen, your {symbol} goes back here.', { symbol: coin.symbol }) : '');
    refundHint.className = `hint${rErr ? ' bad' : ''}`;
    refund.classList.toggle('bad', Boolean(rErr));

    const q = quote;
    put(
      getsBox,
      h('div', { class: 'swap-label', text: t('You get in this wallet') }),
      h(
        'div',
        { class: 'swap-line' },
        h('div', { class: `swap-out${q ? '' : ' muted'}`, 'data-testid': q ? 'ni-eth' : quoting ? 'ni-eth-loading' : 'ni-eth-empty', 'data-wei': q ? String(q.amountOut) : '', title: q ? t('{amount} ETH', { amount: exactUnits(q.amountOut, 18) }) : null, text: q ? `≈ ${compactUnits(q.amountOut, 18)}` : quoting ? '…' : '0' }),
        h('span', { class: 'asset-pick static' }, ethBadge(ETH, 'small'), h('span', { text: 'ETH' })), // i18n-ignore: a ticker
      ),
      h(
        'div',
        { class: 'swap-sub stacked' },
        h('span', { 'data-testid': 'ni-eth-worth' }, ...deliveredTo(q && q.amountOutUsd != null ? usd(q.amountOutUsd) : null, ctx ? h('span', { class: 'mono', text: shorten(ctx.address, 6, 4) }) : null)),
        q && rsfiro != null ? h('span', { 'data-testid': 'ni-rsfiro-estimate', text: t('Then swaps to about {rsfiro} rsFIRO at today\'s price', { rsfiro: compactUnits(rsfiro, 8) }) }) : null,
      ),
    );
    put(
      detailsBox,
      q
        ? h(
            'div',
            { class: 'card flat swap-details', 'data-testid': 'ni-details' },
            kv(t('At least'), `${compactUnits(q.minAmountOut, 18)} ETH`, { 'data-testid': 'ni-min' }, t('with 1% price protection')),
            q.timeEstimate != null ? kv(t('Takes about'), durationText(q.timeEstimate), { 'data-testid': 'ni-time' }, t('after your deposit is confirmed')) : null,
            kv(t('Fees'), t('Included above'), { 'data-testid': 'ni-fees' }, feeText(q) ? t('{amount}: NEAR Intents\' fee and network fees', { amount: feeText(q) }) : t("NEAR Intents' fee and network fees")),
          )
        : null,
    );

    put(problemBox, problemNotice());
    const st = ctaState();
    cta.disabled = st.off !== null;
    cta.textContent = coin ? t('Get a {symbol} deposit address', { symbol: coin.symbol }) : t('Get a deposit address');
    reason.textContent = st.off || '';
    reason.classList.toggle('hidden', !st.off);
  }

  function kv(label, value, extra, note) {
    return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value, note ? h('div', { class: 'small', text: note }) : null));
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
      refundHint.textContent = t('Press and hold in the box, then tap Paste.');
      refund.focus();
    }
  });

  const intro = h('p', { class: 'small', 'data-testid': 'ni-intro', text: t('Send BTC, ZEC, LTC or 200 other coins from any wallet or exchange. NEAR Intents swaps them into ETH or BNB for this wallet; then you swap that to rsFIRO (FIRO on Ethereum or BNB Chain) here.') });
  const who = h('p', { class: 'small', 'data-testid': 'ni-who-sees', text: whoSees(ONECLICK.host) });
  // The Buy screens (buyfiro.app) pay FIRO into the Firo wallet; offered when this release has them.
  const wantFiro = typeof app.has === 'function' && app.has('buyFiro') ? h('button', { class: 'btn btn-text link-left wrap', 'data-testid': 'ni-buy-firo', onclick: () => app.go('buyFiro', { from: 'eth' }) }, t('Want private FIRO in your Firo wallet instead?')) : null;

  const el = screen(
    {
      title: t('Buy rsFIRO'),
      back: () => {
        app.intentsDraft = null;
        app.back('home');
      },
      actions: [reason, cta],
      cls: 'swap intents sticky-actions',
    },
    h('p', { class: 'step', 'data-testid': 'ni-step', text: t('Step 1 of 2 · your coin becomes ETH or BNB in this wallet') }),
    topBox,
    intro,
    h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: t('You send') }), h('div', { class: 'swap-line' }, amountInput, coinBtn), paySub),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, refundLabel, pasteBtn), refund),
    refundHint,
    getsBox,
    detailsBox,
    problemBox,
    who,
    wantFiro,
  );

  (async () => {
    try {
      ctx = await intentsFor(app);
    } catch (e) {
      put(problemBox, notice('error', t('The Ethereum wallet could not be opened: {message}', { message: e.message })));
      return;
    }
    if (!alive) return;
    if (!ctx) return app.go('ethStart', { from: 'nearIntents' }, { replace: true });
    prefillRefund();
    open = await openSwaps(ctx.store);
    rememberNearSwaps(open); // reminders before a deposit address stops taking coins (lib/notify.js)
    if (!alive) return;
    changed();
  })();
  loadTokens();
  render();

  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
    },
  };
}
