/* Your buy (Buy FIRO -> "Get a … deposit address", or Your buys -> a buy)
 * Spec: ONE job: send exactly this much of this coin to this address; then see the buy go through
 *       until the FIRO is in the wallet.
 *       Primary CTA: "Copy address" while the payment is awaited; after it the one next step: back to
 *       the wallet, "Make it private" (Privatize) once the FIRO is in the public balance, "Start a new
 *       buy" when no payment came, "Contact buyfiro.app support" when buyfiro.app needs a look.
 *       Taps from app open: it opens by itself after Buy (1) -> the form's button (2);
 *       later, Buy -> Your buys -> the buy (3).
 * Exit-intent reasons and answers:
 *   - "Which network? How much exactly?" -> the coin and its network are said above the address; the
 *     exact amount has its own copy button.
 *   - "Did it work?" -> four steps, each ticked as it happens; the screen updates by itself.
 *     "Arrived" is said only once this wallet has the FIRO transaction, confirmed.
 *   - "Can others see it?" -> it arrives in the public balance (buyfiro.app pays transparent
 *     addresses); one tap makes it private, and the screen says so.
 *   - "Can I close this?" -> said: yes; the buy keeps going and the FIRO reaches the wallet even
 *     while Campfire is closed.
 *   - "It went wrong" -> what happened, where the coins are (sent back, or never taken), and the one
 *     next step.
 */
import { PAY_BY_MARGIN_MS } from '../lib/pay_by.js';
import { h, put, shorten, svg } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copyText, textButton, holdTaps } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { encodeQr, qrSvgPath } from '../lib/qr.js';
import { buyFiro, receivedInWallet } from '../lib/buy/wiring.js';
import { firoText, sats, buySteps, KEEP_BUY_ORDER_TEXT } from '../lib/buy/words.js';
import { buySiteUrl } from '../lib/buy/hosts.js';
import { coinBadge } from './buy_screens.js';

/** The deposit address as a QR code (black on white, whatever the theme). */
function qrElement(text) {
  const qr = encodeQr(text, { ecl: 'M' });
  const n = qr.size + 8;
  return svg('svg', { viewBox: `0 0 ${n} ${n}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': 'QR code of the deposit address' }, svg('rect', { width: n, height: n, fill: '#ffffff' }), svg('path', { d: qrSvgPath(qr, 4), fill: '#000000' }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05 today" or "14:05 on 9 Oct". */
export function untilText(ms, now = Date.now()) {
  const t = new Date(ms);
  const n = new Date(now);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (t.toDateString() === n.toDateString()) return `${hm} today`;
  return `${hm} on ${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

/** Too close to a buy's deadline to pay from here: a payment must reach buyfiro.app in time. */
export const BUY_PAY_MARGIN_MS = PAY_BY_MARGIN_MS;

/**
 * Where a buy stands against its deadline: 'past' (the address no longer takes payments), 'soon' (too
 * close for a payment to be sure to reach it), or null (audit of 0.1.8: Buy paid an expired address).
 */
export function buyDeadline(o, now = Date.now()) {
  if (!o || o.deadline == null) return null;
  if (o.deadline <= now) return 'past';
  if (o.deadline - now <= BUY_PAY_MARGIN_MS) return 'soon';
  return null;
}

function kv(label, value, extra = {}) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value));
}

export default function buyOrderScreen(app, params = {}) {
  const c = buyFiro(app);
  const deposit = params.deposit;
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'stack' });
  let copied = false;
  let amountCopied = false;
  const payNote = h('div', { 'aria-live': 'polite' }); // why "Pay from this wallet" did not go on
  let alive = true;

  const copy = async (text, amount = false) => {
    if (await copyText(text, amount ? 'Amount copied' : 'Address copied')) {
      if (amount) amountCopied = true;
      else copied = true;
      render();
    }
  };

  function payment(o) {
    const from = payFromWallet(o);
    // Paid from this wallet already: said first, above the address and QR code that invite paying.
    const paid = Boolean(sentFromHere(o));
    return [
      paid ? from : null,
      notice('warn', h('span', { 'data-testid': 'buy-network-warning', text: `Send only ${o.symbol} on the ${o.chainName} network to this address.` })),
      h('div', { class: 'qr qr-small', 'data-testid': 'buy-qr' }, qrElement(o.depositAddress)),
      h(
        'div',
        { class: 'card address-box' },
        h('div', { class: 'banner' }, coinBadge(o.assetId, o.symbol, 'small'), h('span', { class: 'grow small', text: `${o.chainName} deposit address` }), h('button', { class: 'btn btn-text btn-small', 'data-testid': 'buy-copy-address', onclick: () => copy(o.depositAddress) }, icon('copy'), copied ? 'Copied' : 'Copy')),
        h('p', { class: 'mono', 'data-testid': 'buy-deposit-address', text: o.depositAddress }),
      ),
      h(
        'div',
        { class: 'card banner exact-amount' },
        h('div', { class: 'grow' }, h('div', { class: 'small', text: 'Send exactly' }), h('div', { class: 'big', 'data-testid': 'buy-exact-amount', text: `${o.sendAmount} ${o.symbol}` })),
        h('button', { class: 'btn btn-text btn-small', 'data-testid': 'buy-copy-amount', onclick: () => copy(o.sendAmount, true) }, icon('copy'), amountCopied ? 'Copied' : 'Copy'),
      ),
      o.deadline ? h('p', { class: 'small', 'data-testid': 'buy-deadline', text: `This address works until ${untilText(o.deadline)}.` }) : null,
      paid ? null : from,
    ];
  }

  /** This wallet's payment to the buy's deposit address that left or may have, or null. */
  function sentFromHere(o) {
    return payFrom.deposit === o.depositAddress && payFrom.chain && payFrom.sent ? payFrom.sent : null;
  }

  /**
   * ETH, BNB or a token this wallet knows on Ethereum or BNB Chain: pay it from this wallet's own
   * Ethereum / BNB side, the address and exact amount filled in (reviewed and confirmed there).
   * Worked out once per buy (the screen redraws while it follows the buy) and drawn from then on.
   * Once this wallet sent something to the deposit address (on its way or mined, not one that never
   * left), it is never offered again: that payment is linked instead (release verification 0.1.8:
   * back from the payment, the same button paid the buy a second time).
   */
  let payFrom = { deposit: null, chain: null, pending: false, sent: null };
  function payFromWallet(o) {
    const chain = { eth: 'ethereum', bsc: 'bsc' }[o.chain];
    if (!chain) return null;
    if (payFrom.deposit !== o.depositAddress) {
      payFrom = { deposit: o.depositAddress, chain: null, pending: true, sent: null };
      Promise.all([import('../lib/eth/tokens.js'), import('../lib/eth/record.js')])
        .then(async ([{ tokenBySymbol }, { hasEthWallet }]) => {
          // The very coin the deposit address takes: the chain's own coin for a buy in ETH / BNB,
          // or the token with the same contract. A same-named token elsewhere is never paid.
          const t = tokenBySymbol(o.symbol, chain);
          const same = Boolean(t) && (t.address == null ? o.contract == null && ['ETH', 'BNB'].includes(o.symbol) : Boolean(o.contract) && t.address.toLowerCase() === o.contract.toLowerCase());
          const ok = same && (await hasEthWallet().catch(() => false));
          // Not known to have sent nothing: never offered (the outbox could not be read).
          const sent = ok ? await sentToDeposit(o.depositAddress, chain).catch(() => 'unknown') : null;
          if (payFrom.deposit !== o.depositAddress) return;
          payFrom = { deposit: o.depositAddress, chain: ok && sent !== 'unknown' ? chain : null, pending: false, sent: sent === 'unknown' ? null : sent };
          if (ok) render();
        })
        .catch(() => {
          payFrom.pending = false;
        });
      return null;
    }
    if (!payFrom.chain) return null;
    if (payFrom.sent) {
      const e = payFrom.sent;
      // "See your payment" is the screen's one button then (render()): never "Copy address" to pay again.
      return h('div', { 'data-testid': 'buy-paid-from-wallet', 'data-hash': e.hash }, notice('info', h('strong', { text: 'You sent this from this wallet. ' }), `buyfiro.app shows it here once it arrives on ${payFrom.chain === 'bsc' ? 'BNB Chain' : 'Ethereum'}. Sending it again would pay twice.`));
    }
    // Too close to the deadline, or past it: never offered from here (it could arrive too late).
    if (buyDeadline(o)) return h('div', { 'data-testid': 'buy-pay-too-late' }, notice('warn', `This address takes payments only until ${untilText(o.deadline)}: too soon for a payment from this wallet to be sure to reach it in time. Start a new buy to pay from this wallet.`));
    const btn = secondary(`Pay from this wallet's ${payFrom.chain === 'bsc' ? 'BNB Chain' : 'Ethereum'} balance`, async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      // A fresh look first: buyfiro.app still waits for this payment, and its deadline is not near.
      await c.poll(o.depositAddress).catch(() => null);
      if (!alive) return;
      const fresh = c.order(o.depositAddress);
      const unreachable = Boolean(c.pollError(o.depositAddress));
      const still = fresh && fresh.isOpen && (fresh.lastState || 'awaiting_deposit') === 'awaiting_deposit' && !buyDeadline(fresh);
      if (unreachable || !still) {
        btn.disabled = false;
        render();
        put(payNote, h('div', { 'data-testid': 'buy-pay-not-now' }, notice('info', unreachable ? "Campfire couldn't reach buyfiro.app to check that this buy still waits for your payment, so nothing was started. Try again in a moment." : 'This buy no longer waits for a payment from here, so nothing was started.')));
        return;
      }
      // With its deadline: Send and Review look again just before signing (XB).
      app.ethSendDraft = { to: o.depositAddress, amount: o.sendAmount, symbol: o.symbol, chain: payFrom.chain, payBy: o.deadline != null ? { address: o.depositAddress, deadline: o.deadline } : null };
      app.go('ethSend', { chain: payFrom.chain });
    }, { 'data-testid': 'buy-pay-from-wallet' });
    return h('div', {}, btn, payNote);
  }

  /**
   * This wallet's payment to `deposit` on `chain` that left or may have (signed, on its way, mined),
   * from its Ethereum & BNB outbox read now; null when there is none. One that never left
   * ('rejected'), failed on chain or was replaced paid nothing and does not count.
   */
  async function sentToDeposit(deposit, chain) {
    const [{ ethWallet }, { entryChain }] = await Promise.all([import('../lib/eth/wallet.js'), import('../lib/eth/outbox.js')]);
    const w = await ethWallet(app);
    if (!w) return null;
    const list = await w.reloadOutbox();
    const to = String(deposit).toLowerCase();
    return (list || []).find((e) => e && String(e.to || '').toLowerCase() === to && entryChain(e) === chain && !['rejected', 'failed', 'replaced'].includes(e.state)) || null;
  }

  function stateNotice(o, s, arrived) {
    const got = o.estimate == null ? 'Your FIRO' : `≈\u00a0${firoText(sats(o.estimate))}`;
    const n = (kind, key, title, detail) => {
      const el = notice(kind, h('strong', { text: `${title} ` }), detail || '');
      el.dataset.testid = key;
      return el;
    };
    switch (s) {
      case 'delivered':
        return arrived
          ? n('success', 'buy-arrived', 'Your FIRO has arrived in your public balance.', `${got} is there. Anyone can see a public balance on the blockchain: make it private with one tap.`)
          : n('info', 'buy-delivered', 'buyfiro.app sent your FIRO.', `${got} shows in your public balance once its transaction is in a block, usually within minutes.`);
      case 'refunded':
        return n('warn', 'buy-refunded', `Your payment was sent back to ${shorten(o.refundAddress, 6, 4)}.`, `buyfiro.app couldn't buy the FIRO, so your ${o.symbol} went back to your ${o.chainName} address. There is nothing else to do.`);
      case 'expired':
        return n('warn', 'buy-expired', 'No payment arrived in time. Nothing was taken.', 'This address no longer takes payments. Start a new buy to get a new one.');
      case 'failed':
        return n('error', 'buy-failed', "The payment couldn't be processed.", 'Contact buyfiro.app support with this order (copy it below). They can see where your coins are.');
      case 'attention':
        return n('warn', 'buy-attention', 'buyfiro.app is checking this order.', 'Contact their support with this order (copy it below). Campfire keeps checking meanwhile.');
      default:
        return null;
    }
  }

  function steps(s, arrived) {
    const mark = { done: 'check', active: 'clock', waiting: null, failed: 'close' };
    return h(
      'div',
      { class: 'card steps', 'data-testid': 'buy-steps' },
      ...buySteps(s, { arrived }).map((st, i) =>
        h('div', { class: `step-row ${st.mark}`, 'data-testid': `buy-step-${i}`, 'data-mark': st.mark }, h('span', { class: 'step-mark' }, mark[st.mark] ? icon(mark[st.mark]) : null), h('span', { class: 'grow', text: st.label }), st.note ? h('span', { class: 'small', text: st.note }) : null),
      ),
    );
  }

  function details(o, s, arrived) {
    const paid = !['awaiting_deposit', 'expired', 'failed'].includes(s);
    return h(
      'div',
      { class: 'card flat swap-details' },
      kv(paid ? 'You paid' : 'You pay', `${o.sendAmount} ${o.symbol}`),
      o.estimate != null ? kv(arrived ? 'You received' : 'You receive', `≈ ${firoText(sats(o.estimate))}`, { 'data-testid': 'buy-order-estimate' }) : null,
      kv('Arrives in', 'Your public balance', { 'data-testid': 'buy-order-arrives' }),
      kv('Refunds go to', shorten(o.refundAddress, 6, 4), { class: 'v mono' }),
      s !== 'awaiting_deposit' ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Order' }), h('button', { class: 'v mono btn-text', 'data-testid': 'buy-copy-order', onclick: () => copy(o.depositAddress), text: shorten(o.depositAddress, 6, 4) })) : null,
      o.txid ? kv('FIRO transaction', shorten(o.txid, 6, 4), { class: 'v mono', 'data-testid': 'buy-firo-tx' }) : null,
    );
  }

  function render() {
    if (!alive) return;
    const o = c.order(deposit);
    if (!o) {
      put(body, c.loadError ? notice('error', `Your buys could not be opened: ${c.loadError.message}`) : h('p', { class: 'small', text: 'Loading your buy…' }));
      put(actions, primary('Back to your wallet', () => app.go('home'), { 'data-testid': 'buy-order-cta' }));
      return;
    }
    const s = o.lastState || 'awaiting_deposit';
    const arrived = s === 'delivered' && receivedInWallet(o.txid);
    const pollError = c.pollError(deposit);
    put(
      body,
      o.sandbox ? notice('info', "buyfiro.app's test mode: nothing to pay.") : null,
      stateNotice(o, s, arrived),
      // Past its deadline while buyfiro.app has not said so yet: the address is never shown to pay.
      s === 'awaiting_deposit' && buyDeadline(o) === 'past' ? h('div', { 'data-testid': 'buy-deadline-past' }, notice('warn', h('strong', { text: 'This address no longer takes payments. ' }), `It took them until ${untilText(o.deadline)}. Don't send anything to it: start a new buy.`)) : null,
      ...(s === 'awaiting_deposit' && buyDeadline(o) !== 'past' ? payment(o) : []),
      steps(s, arrived),
      details(o, s, arrived),
      // Not in the backup file (FM-6): said once the order shows, while it is open.
      o.isOpen && s !== 'awaiting_deposit' ? h('p', { class: 'small', 'data-testid': 'buy-keep-order', text: KEEP_BUY_ORDER_TEXT }) : null,
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-can-leave', text: 'You can leave this screen or close Campfire: your buy keeps going, and the FIRO reaches your wallet even while it is closed.' }) : null,
      pollError && o.isOpen ? h('p', { class: 'small', 'data-testid': 'buy-poll-error', text: pollError.unreachable ? "Couldn't reach buyfiro.app just now. Campfire keeps checking." : "buyfiro.app's last answer didn't make sense. Campfire keeps checking." }) : null,
    );
    // Sent from this wallet and not seen by buyfiro.app yet: its payment is the one thing to look at.
    const sent = s === 'awaiting_deposit' ? sentFromHere(o) : null;
    titleEl.textContent = s === 'awaiting_deposit' && !sent ? `Send ${o.sendAmount} ${o.symbol}` : 'Buy FIRO';
    let cta;
    if (sent) cta = primary('See your payment', () => app.go('ethTx', { hash: sent.hash, chain: payFrom.chain }), { 'data-testid': 'buy-paid-from-wallet-see' });
    else if (s === 'awaiting_deposit' && buyDeadline(o) === 'past') cta = primary('Start a new buy', () => app.go('buyFiro', {}, { replace: true }), { 'data-testid': 'buy-order-cta' });
    else if (s === 'awaiting_deposit') cta = primary(h('span', { text: copied ? 'Address copied' : 'Copy address' }), () => copy(o.depositAddress), { 'data-testid': 'buy-order-cta' });
    else if (s === 'delivered' && arrived) cta = primary('Make it private', () => app.go('privatize'), { 'data-testid': 'buy-order-cta' });
    else if (s === 'expired') cta = primary('Start a new buy', () => app.go('buyFiro', {}, { replace: true }), { 'data-testid': 'buy-order-cta' });
    else if (s === 'failed' || s === 'attention') cta = h('a', { class: 'btn btn-primary', href: buySiteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'buy-order-cta' }, 'Contact buyfiro.app support');
    else cta = primary('Back to your wallet', () => app.go('home'), { 'data-testid': 'buy-order-cta' });
    if (s === 'awaiting_deposit' && !sent && buyDeadline(o) !== 'past') cta.prepend(icon('copy'));
    put(actions, cta, s === 'delivered' && arrived ? textButton('See it in your wallet', () => app.go('activity', { txid: o.txid, txId: o.txid }), { 'data-testid': 'buy-order-see' }) : null);
    root.dataset.state = s;
  }

  const el = screen({ title: 'Buy FIRO', back: () => app.back(params.from === 'list' ? 'buyOrders' : 'home'), actions: [actions], cls: 'buy-order sticky-actions' }, body);
  const titleEl = el.querySelector('.topbar h1');
  const root = el;
  const off = c.onChange(() => render());
  const offW = wallet.onChange(() => render());
  render();
  (async () => {
    await c.resumeAll();
    // Where it is now, not where it was when the app last looked.
    const o = c.order(deposit);
    if (o && o.isOpen && alive) await c.poll(deposit);
    render();
  })();
  // The buy form's button sits where "Pay from this wallet" or Copy is: the second tap of a double tap is held.
  const hold = holdTaps(el);
  return {
    el,
    destroy() {
      alive = false;
      hold.stop();
      off();
      offW();
    },
  };
}
