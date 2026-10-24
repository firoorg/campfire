/* Sell FIRO (Home -> Sell -> FIRO)
 * Spec: ONE job: say how much FIRO to sell, and see what arrives and where, before anything moves.
 *       Primary CTA: "Sell 500 FIRO" (the amount follows the field): it asks buyfiro.app for a deposit
 *       address only; the FIRO is sent on the next screen, after its own review and the password.
 *       Taps from app open: Sell (1) -> FIRO (2) -> amount (or Max) -> the button (3).
 * Exit-intent reasons and answers:
 *   - "What do I get?" -> "You receive ≈ $480 in USDT on BNB Chain", as buyfiro.app prices it, before
 *     any order exists; nothing to subtract (buyfiro.app's figure is what arrives).
 *   - "Is there a minimum?" -> said up front ("Smallest sell right now: 300 FIRO", from buyfiro.app's
 *     own limits); under it or over the largest sell, the amount that works is one tap away.
 *   - "Where does the money go?" -> to this wallet's own Ethereum & BNB address by default, said with
 *     its first and last characters; no such wallet: set one up in place, or paste an address (its
 *     checksum is checked as it is pasted).
 *   - "Can others see it?" -> Pay from Private (the default when it covers the amount) or Public,
 *     each with what it holds.
 *   - "I want something other than USDT" -> the token chip opens every chain and token buyfiro.app
 *     pays.
 *   - "It doesn't work" -> every refusal says what happened, that nothing was sent, and the one
 *     thing that fixes it.
 *   - "It says I already have a sell here, but I tapped 'I paid it from another wallet' by mistake"
 *     -> the refusal says so and offers the undo in place, which opens that sell payable (R-9).
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet, secondary, assetBadge, focusSoon } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { SellError, DEFAULT_PAYOUT, exactForApi, satsOf, sameToken } from '../lib/sell/sellfiro.js';
import { usd, firoFigure, minimumAmountText, maximumAmountText, payoutText, otherChainNote, problemText, whyUnreachable, fromText } from '../lib/sell/words.js';
import { sellFiro, ownPayoutAddress, checkPayoutAddress } from '../lib/sell/wiring.js';
import { sellSiteUrl } from '../lib/sell/hosts.js';
import { coinBadge } from './buy_screens.js';
import { loaderBehind } from '../lib/loader.js';
import { t } from '../lib/i18n.js';

export default function sellFiroScreen(app) {
  const c = sellFiro(app);
  const draft = (app.sellDraft = app.sellDraft || { amount: '', from: 'private', fromPicked: false, payout: null, paste: false, address: '' });
  let payout = draft.payout || { ...DEFAULT_PAYOUT };
  let own = undefined; // this wallet's Ethereum & BNB address; null: none; undefined: not known yet
  let pasted = { ok: false, address: null, problem: null };
  let pasteSeq = 0;
  let value = null;
  let amountError = null;
  let busy = false;
  let orderError = null;
  let walletProblem = null;
  let maxNote = null;
  let alive = true;

  const amountInput = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t('Amount of FIRO you sell'), 'data-testid': 'sell-amount' });
  amountInput.value = draft.amount;
  const maxBtn = h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'sell-max', onclick: () => fillMax() }, t('Max'));
  const sellSub = h('div', { class: 'swap-sub' });
  const fromBox = h('div', { class: 'segmented from-pick', role: 'radiogroup', 'aria-label': t('Pay from') });
  const payoutBtn = h('button', { class: 'asset-pick', type: 'button', 'data-testid': 'sell-payout', onclick: () => pickPayout() });
  const getsBox = h('div', { class: 'card swap-box' });
  const addressInput = h('input', { class: 'input mono', type: 'text', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: '0x…', 'aria-label': t('Address buyfiro.app pays'), 'data-testid': 'sell-address' });
  addressInput.value = draft.address;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'sell-address-paste' }, icon('paste'), t('Paste'));
  const addressHint = h('p', { class: 'hint', 'data-testid': 'sell-address-hint' });
  const addressBox = h('div');
  const noteBox = h('div');
  const topBox = h('div');
  const problemBox = h('div', { 'aria-live': 'polite' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'sell-reason', 'aria-live': 'polite' });
  const cta = primary(t('Sell FIRO'), sell, { disabled: true, 'data-testid': 'sell-cta' });

  // ------------------------------------------------------------ the payout
  /** Where buyfiro.app pays, as the order asks it: {chainId, chainName, token, symbol, address, own}, or null. */
  function payoutTo() {
    if (!draft.paste && own) return { ...payout, address: own, own: true };
    if (draft.paste && pasted.ok) return { ...payout, address: pasted.address, own: Boolean(own) && pasted.address.toLowerCase() === own.toLowerCase() };
    return null;
  }

  async function checkPasted() {
    const seq = ++pasteSeq;
    const r = await checkPayoutAddress(addressInput.value, { token: payout.token }).catch(() => ({ ok: false, address: null, problem: t("Firo PWA couldn't check this address. Try again.") }));
    if (seq !== pasteSeq || !alive) return;
    pasted = r;
    addressChanged();
  }

  function setPaste(on) {
    draft.paste = on;
    addressChanged();
    if (on) focusSoon(addressInput);
  }

  function setPayout(next) {
    payout = { chainId: next.chainId, chainName: next.chainName, token: next.token, symbol: next.symbol };
    draft.payout = payout;
    c.refreshLimits(payout);
    if (draft.paste && addressInput.value.trim()) checkPasted();
    changed();
  }

  /** Every chain buyfiro.app pays on, then a token on the chain picked; searched by ticker. */
  function pickPayout() {
    const st = { chains: null, chain: null, tokens: null, error: null, query: '', seq: 0 };
    const sheet = openSheet((close, rerender) => {
      const head = h('h2', { text: st.chain ? t('Get paid on {name}', { name: st.chain.name }) : t('Get paid in') });
      if (st.error) {
        return [head, notice('error', h('strong', { text: t("Couldn't reach buyfiro.app. ") }), t('Nothing was sent.'), h('div', { class: 'hint', text: whyUnreachable(st.error) })), h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close'))];
      }
      if (!st.chain) {
        const list = h('div', { class: 'card list picker-list' });
        const usdt = h('button', { class: `row${payout.chainId === DEFAULT_PAYOUT.chainId && sameToken(payout.token, DEFAULT_PAYOUT.token) ? ' on' : ''}`, 'data-testid': 'sell-payout-default', onclick: () => close({ ...DEFAULT_PAYOUT }) }, coinBadge(DEFAULT_PAYOUT.token, 'USDT'), h('span', { class: 'main' }, h('div', { class: 't', text: t('USDT on BNB Chain') }), h('div', { class: 's', text: t('Recommended: the smallest sells, and the fastest') })), h('span', { class: 'chev' }, icon('chevron')));
        put(
          list,
          usdt,
          h('p', { class: 'section-title', text: t('Other networks') }),
          ...(st.chains || []).filter((x) => x.chainId !== DEFAULT_PAYOUT.chainId).map((ch) =>
            h('button', { class: 'row', 'data-testid': 'sell-chain-row', 'data-chain-id': String(ch.chainId), onclick: () => openChain(ch) }, h('span', { class: 'ico' }, icon('globe')), h('span', { class: 'main' }, h('div', { class: 't', text: ch.name })), h('span', { class: 'chev' }, icon('chevron'))),
          ),
          st.chains ? null : h('p', { class: 'small center pad', text: t('Loading the networks buyfiro.app pays on…') }),
        );
        return [head, h('p', { class: 'small', text: t('Anything other than USDT on BNB Chain is paid through a cross-chain swap: it can take a few minutes longer, and the smallest sell can be larger.') }), list, h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close'))];
      }
      const search = h('input', { class: 'input', type: 'search', placeholder: t('Ticker (USDT, USDC, ETH…)'), 'aria-label': t('Search by ticker'), autocomplete: 'off', 'data-testid': 'sell-token-search', value: st.query });
      search.addEventListener('change', () => findToken(search.value.trim()));
      search.addEventListener('keydown', (e) => e.key === 'Enter' && findToken(search.value.trim()));
      const list = h('div', { class: 'card list picker-list' });
      const row = (token2) =>
        h(
          'button',
          { class: `row${payout.chainId === token2.chainId && sameToken(payout.token, token2.token) ? ' on' : ''}`, 'data-testid': 'sell-token-row', 'data-token': token2.token, onclick: () => close({ chainId: st.chain.chainId, chainName: st.chain.name, token: token2.token, symbol: token2.symbol }) },
          coinBadge(token2.token, token2.symbol),
          h('span', { class: 'main' }, h('div', { class: 't', text: token2.symbol }), h('div', { class: 's', text: token2.isNative ? t('{name}\'s own coin', { name: st.chain.name }) : `${token2.name} · ${shorten(token2.token, 6, 4)}` })),
        );
      put(list, ...(st.tokens ? st.tokens.slice(0, 30).map(row) : [h('p', { class: 'small center pad', text: t('Loading…') })]), st.tokens && !st.tokens.length ? h('p', { class: 'small center pad', text: t('buyfiro.app doesn\'t pay "{query}" on {name}. Try its ticker, like USDC.', { query: st.query, name: st.chain.name }) }) : null);
      return [head, search, list, h('button', { class: 'btn btn-text', onclick: () => ((st.chain = null), (st.tokens = null), (st.query = ''), rerender()) }, t('Other networks'))];

      async function findToken(q) {
        st.query = q;
        st.tokens = null;
        rerender();
        await loadTokens(q || null);
      }
    }, { label: t('Get paid in') });
    async function loadTokens(symbol) {
      const seq = ++st.seq;
      try {
        const r = await c.payoutTokens(st.chain.chainId, { symbol });
        if (seq !== st.seq || sheet.closed) return;
        // The chain's own coin, then the dollar coins people ask for, then buyfiro.app's order.
        const rank = (token) => (token.isNative ? 0 : token.symbol === 'USDT' ? 1 : token.symbol === 'USDC' ? 2 : 3);
        st.tokens = [...r.tokens].sort((a, b) => rank(a) - rank(b));
      } catch (e) {
        if (seq !== st.seq || sheet.closed) return;
        st.error = e;
      }
      sheet.rerender();
    }
    function openChain(ch) {
      st.chain = ch;
      st.tokens = null;
      sheet.rerender();
      loadTokens(null);
    }
    c.payoutChains()
      .then((r) => {
        st.chains = r.chains;
        if (!sheet.closed) sheet.rerender();
      })
      .catch((e) => {
        st.error = e;
        if (!sheet.closed) sheet.rerender();
      });
    sheet.then((p) => {
      if (p && alive) setPayout(p);
    });
  }

  // ------------------------------------------------------------ input
  function from() {
    if (draft.fromPicked) return draft.from;
    const b = wallet.state.balance;
    // Private by default whenever it covers the amount; public when only that one does.
    if (value && value > 0n) return b.private.available < value && b.public.available >= value ? 'public' : 'private';
    return b.private.available === 0n && b.public.available > 0n ? 'public' : 'private';
  }

  function renderFrom() {
    const b = wallet.state.balance;
    const f = from();
    const opt = (id, label, avail) =>
      h(
        'button',
        { type: 'button', class: `seg${f === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(f === id), 'data-testid': `sell-from-${id}`, onclick: () => ((draft.from = id), (draft.fromPicked = true), changed()) },
        h('span', { class: 'seg-t' }, icon(id === 'private' ? 'spark' : 'eye'), label),
        h('span', { class: 'seg-s', text: `${formatAmount(avail)} ${UNIT}` }),
      );
    put(fromBox, opt('private', t('Private'), b.private.available), opt('public', t('Public'), b.public.available));
  }

  /** The address changed: only the button and the words under it (the price does not depend on it). */
  function addressChanged() {
    orderError = null;
    walletProblem = null;
    render();
  }

  function changed() {
    const item = amountInput.value.trim();
    amountError = null;
    value = null;
    if (item) {
      try {
        value = parseAmount(item);
        if (value <= 0n) amountError = t('The amount must be more than zero.');
        else if (!exactForApi(value)) amountError = t('Use a shorter amount, like 500.5');
      } catch (e) {
        amountError = e.message;
      }
    }
    orderError = null;
    walletProblem = null;
    if (!value || amountError) c.requestQuote(null);
    else c.requestQuote({ amount: value, payout });
    render();
  }

  function setAmount(text) {
    amountInput.value = text;
    draft.amount = text;
    maxNote = null;
    changed();
  }

  /** Everything the chosen balance can send, the network's part taken out; never over the largest sell. */
  async function fillMax() {
    const f = from();
    const avail = wallet.available(f);
    maxNote = null;
    if (avail <= 0n) {
      maxNote = (f === 'private' ? t('Your private balance is empty.') : t('Your public balance is empty.'));
      return render();
    }
    let most = avail;
    const to = (f === 'public' ? wallet.state.receive.transparent : wallet.state.receive.spark) || wallet.state.receive.transparent;
    try {
      if (to) {
        const q = await wallet.quote({ from: f, to: [{ address: to, amount: avail }], subtractFee: true });
        most = q.total - q.fee;
      }
    } catch (e) {
      maxNote = t('Firo PWA couldn\'t work out the most you can send: {message}', { message: e.message });
      return render();
    }
    if (!alive) return;
    const cap = c.limits?.maximumFiro;
    if (cap != null && most > satsOf(Math.floor(cap))) {
      most = satsOf(Math.floor(cap));
      maxNote = t('The largest single sell right now is {amount} {UNIT}.', { amount: firoFigure(Math.floor(cap)), UNIT });
    }
    draft.from = f;
    draft.fromPicked = true;
    amountInput.value = toInputString(most);
    draft.amount = amountInput.value;
    changed();
  }

  // ------------------------------------------------------------ the order
  async function sell() {
    const to = payoutTo();
    if (!value || !to || busy) return;
    if (!wallet.session) {
      walletProblem = t('Your wallet is still starting, so it cannot check the deposit address yet. Try again in a moment.');
      return render();
    }
    busy = true;
    orderError = null;
    walletProblem = null;
    render();
    try {
      const order = await c.placeOrder({ amount: value, payout: to, payFrom: from(), walletId: app.record.id, quote: c.quote });
      if (!alive) return;
      app.sellDraft = null;
      app.go('sellOrder', { id: order.orderId, fresh: true }, { replace: true });
      return;
    } catch (e) {
      if (!alive) return;
      if (e instanceof SellError) orderError = e;
      else walletProblem = t("Firo PWA couldn't finish setting up this sell. Nothing was sent. Try again.");
    }
    busy = false;
    render();
  }

  function ctaState() {
    const to = payoutTo();
    if (wallet.state.viewOnly) return { off: t('This wallet can only watch: it cannot send FIRO.') };
    if (busy) return { off: t('Asking buyfiro.app for a deposit address…') };
    if (amountError) return { off: amountError };
    if (!value) return { off: t('Enter how much {UNIT} you sell.', { UNIT }) };
    const f = from();
    if (value > wallet.available(f)) return { off: (f === 'private' ? t('That\'s more than your private balance ({amount} {UNIT}).', { amount: formatAmount(wallet.available(f)), UNIT }) : t('That\'s more than your public balance ({amount} {UNIT}).', { amount: formatAmount(wallet.available(f)), UNIT })) };
    if (!to) {
      if (draft.paste) return { off: pasted.problem || t('Paste the address buyfiro.app pays.') };
      return { off: own === undefined ? t('Looking for your Ethereum & BNB wallet…') : t('Choose where buyfiro.app pays you.') };
    }
    if (c.quoteError) return { off: '' };
    if (c.quoting || !c.quote) return { off: t('Getting a price from buyfiro.app…') };
    return { off: null };
  }

  /** "I haven't paid it": the mark comes off that sell (if nothing of this wallet's started), which then opens payable. */
  async function undoPaidElsewhere(id) {
    try {
      await c.unmarkPaidElsewhere(id);
    } catch {
      /* kept in memory; that sell's screen says what it is */
    }
    if (alive) app.go('sellOrder', { id });
  }

  // ------------------------------------------------------------ problems
  function problem() {
    if (walletProblem) {
      return notice('warn', h('strong', { text: t('Nothing was sent. ') }), walletProblem, h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: sell, 'data-testid': 'sell-wallet-retry' }, t('Try again'))));
    }
    const e = orderError || c.quoteError;
    if (!e) return null;
    const known = e.code === 'order_exists' && e.orderId ? c.order(e.orderId) : null;
    // The sell buyfiro.app keeps for this payout was marked "paid from another wallet" (R-9).
    const markedElsewhere = Boolean(known && c.canUnmarkPaidElsewhere(known));
    const p = problemText(e, { payout, minimum: c.minimumHintFiro, maximum: c.limits?.maximumFiro ?? null, markedElsewhere });
    const fix = () => {
      const min = e.minimumFiro ?? c.minimumHintFiro;
      const max = e.maximumFiro ?? c.limits?.maximumFiro;
      if (p.fix === 'useMinimum' && min != null) setAmount(minimumAmountText(min));
      else if (p.fix === 'useMaximum' && max != null) setAmount(maximumAmountText(max));
      else if (p.fix === 'editAmount') {
        amountInput.focus();
        amountInput.select();
      } else if (p.fix === 'editPayout') pickPayout();
      else if (p.fix === 'editAddress' || (p.fix === 'openExisting' && !known)) setPaste(true);
      else if (p.fix === 'openExisting') app.go('sellOrder', { id: known.orderId });
      else if (p.fix === 'undoPaidElsewhere') undoPaidElsewhere(known.orderId);
      else if (p.fix === 'payPublic') {
        draft.from = 'public';
        draft.fromPicked = true;
        changed();
      } else if (p.fix === 'tryAgain') {
        if (orderError) sell();
        else c.requote();
      }
    };
    const label = p.fix === 'openExisting' && !known ? t('Use another address') : p.fixLabel;
    const action =
      p.fix === 'contactSupport'
        ? h('a', { class: 'btn btn-secondary btn-small', href: sellSiteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'sell-support' }, p.fixLabel)
        : h('button', { class: 'btn btn-secondary btn-small', onclick: fix, 'data-testid': 'sell-fix' }, label);
    const n = notice(p.serious || e.unreachable ? 'error' : 'warn', h('strong', { text: `${p.title}${/[.!?]$/.test(p.title) ? '' : '.'} ` }), p.detail || '', e.unreachable ? h('div', { class: 'hint', 'data-testid': 'sell-why', text: whyUnreachable(e) }) : null, h('div', { class: 'btn-row prompt-actions' }, action));
    n.dataset.testid = 'sell-problem';
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
      wallet.state.viewOnly ? notice('info', h('strong', { text: t('Watch-only. ') }), t('This wallet sees payments from its view key; it cannot send FIRO, so it cannot sell.')) : null,
      mine.length
        ? h(
            'button',
            { class: 'card row entry-row', onclick: () => app.go('sellOrders'), 'data-testid': 'sell-your-sells' },
            h('span', { class: `ico${open ? ' wait' : ''}` }, icon(open ? 'clock' : 'activity')),
            h('span', { class: 'main' }, h('div', { class: 't', text: open ? t('Your sells ({open} in progress)', { open }) : t('Your sells') })),
            h('span', { class: 'chev' }, icon('chevron')),
          )
        : null,
      loaderBehind() && c.quoteError && c.quoteError.unreachable
        ? notice('warn', h('strong', { text: t('Finish the update first. ') }), t('Until it is finished this version cannot reach buyfiro.app. Nothing was sent.'), h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-primary btn-small', 'data-testid': 'sell-update-finish', onclick: () => location.reload() }, t('Finish now'))))
        : null,
    );

    const hint = c.minimumHintFiro;
    put(sellSub, maxBtn, h('span', { class: 'grow right', 'data-testid': 'sell-minimum-hint', text: hint == null ? '' : t('Smallest sell right now: {amount} {UNIT}', { amount: firoFigure(Math.ceil(hint)), UNIT }) }));
    renderFrom();

    put(payoutBtn, coinBadge(payout.token, payout.symbol, 'small'), h('span', { class: 'coin-chip' }, h('span', { text: payout.symbol }), h('span', { class: 'chain', text: payout.chainName })), icon('down'));
    const q = c.quote;
    const to = payoutTo();
    put(
      getsBox,
      h('div', { class: 'swap-label', text: t('You receive') }),
      h('div', { class: 'swap-line' }, h('div', { class: `swap-out${q ? '' : ' muted'}`, 'data-testid': q ? 'sell-estimate' : c.quoting ? 'sell-estimate-loading' : 'sell-estimate-empty', 'data-usd': q ? String(q.receiveUsd) : '', text: q ? `≈ ${usd(q.receiveUsd)}` : c.quoting ? '…' : '$0' }), payoutBtn),
      h('div', { class: 'swap-sub stacked' }, h('span', { 'data-testid': 'sell-receive-line', text: (q && q.route && q.route !== 'direct' ? t('In {payout}, through a cross-chain swap', { payout: payoutText(payout) }) : t('In {payout}', { payout: payoutText(payout) })) })),
      !draft.paste && own
        ? h('div', { class: 'payout-to', 'data-testid': 'sell-paid-to' }, icon('wallet'), h('span', { class: 'grow', text: t('To your Ethereum & BNB wallet ({address})', { address: shorten(own, 6, 4) }) }), h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'sell-address-change', onclick: () => setPaste(true) }, t('Change')))
        : null,
      !draft.paste && own === null
        ? h(
            'div',
            { class: 'payout-ask', 'data-testid': 'sell-no-eth' },
            h('p', { class: 'small', text: t('Where should buyfiro.app pay you? An Ethereum & BNB wallet next to your FIRO takes it, or any address you paste.') }),
            secondary(t('Set up an Ethereum & BNB wallet'), () => app.go('ethStart', { from: 'sell' }), { 'data-testid': 'sell-eth-setup' }),
            h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'sell-address-paste-mode', onclick: () => setPaste(true) }, t('Paste an address instead')),
          )
        : null,
    );

    put(
      addressBox,
      draft.paste
        ? h(
            'div',
            {},
            h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: t('Paid to (an address on {chainName})', { chainName: payout.chainName }) }), pasteBtn), addressInput),
            addressHint,
            own
              ? h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'sell-address-own', onclick: () => setPaste(false) }, t('Use my Ethereum & BNB wallet ({address})', { address: shorten(own, 6, 4) }))
              : own === null
                ? h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'sell-eth-setup-instead', onclick: () => ((draft.paste = false), app.go('ethStart', { from: 'sell' })) }, t('Set up an Ethereum & BNB wallet instead'))
                : null,
          )
        : null,
    );
    addressHint.textContent = pasted.problem || (pasted.ok ? t('buyfiro.app pays {symbol} to this address on {chainName}.', { symbol: payout.symbol, chainName: payout.chainName }) : '');
    addressHint.className = `hint${pasted.problem ? ' bad' : pasted.ok ? ' good' : ''}`;
    addressInput.classList.toggle('bad', Boolean(pasted.problem));

    const other = to ? otherChainNote(to) : null;
    put(noteBox, maxNote ? h('p', { class: 'hint', 'data-testid': 'sell-max-note', text: maxNote }) : null, other ? notice('info', h('span', { 'data-testid': 'sell-other-chain', text: other })) : null);

    put(problemBox, problem());
    const st = ctaState();
    cta.disabled = Boolean(st.off !== null);
    cta.textContent = value && !amountError ? t('Sell {amount} {UNIT}', { amount: formatAmount(value), UNIT }) : t('Sell FIRO');
    reason.textContent = st.off || '';
    reason.classList.toggle('hidden', !st.off);
    maxBtn.disabled = wallet.state.viewOnly;
  }

  amountInput.addEventListener('input', () => {
    draft.amount = amountInput.value;
    maxNote = null;
    changed();
  });
  addressInput.addEventListener('input', () => {
    draft.address = addressInput.value;
    pasted = { ok: false, address: null, problem: null };
    addressChanged();
    checkPasted();
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      addressInput.value = (await navigator.clipboard.readText()).trim();
      draft.address = addressInput.value;
      checkPasted();
    } catch {
      addressHint.textContent = t('Press and hold in the box, then tap Paste.');
      addressInput.focus();
    }
  });

  const off = c.onChange(() => render());
  const offW = wallet.onChange(() => render());
  c.cancelQuote();
  c.resumeAll();
  c.refreshLimits(payout);
  ownPayoutAddress(app).then((a) => {
    if (!alive) return;
    own = a;
    render();
  });
  if (draft.paste && draft.address) checkPasted();
  changed();

  const el = screen(
    {
      title: t('Sell FIRO'),
      back: () => {
        app.sellDraft = null;
        app.back('home');
      },
      actions: [reason, cta],
      cls: 'swap sell sticky-actions',
    },
    topBox,
    h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: t('You sell') }), h('div', { class: 'swap-line' }, amountInput, h('span', { class: 'asset-pick static' }, assetBadge({ id: 'firo' }, { size: 'small' }), h('span', { text: UNIT }))), sellSub),
    h('div', { class: 'field' }, h('span', { text: t('Pay from') }), fromBox),
    getsBox,
    addressBox,
    noteBox,
    problemBox,
    h('p', { class: 'small', 'data-testid': 'sell-footer', text: t('buyfiro.app sells your FIRO and pays you. Nothing leaves your wallet until you confirm the payment on the next screen.') }),
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
      offW();
      c.cancelQuote();
    },
  };
}
