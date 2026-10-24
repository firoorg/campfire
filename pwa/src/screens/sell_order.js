/* Your sell (Sell FIRO -> "Sell 500 FIRO", or Your sells -> a sell)
 * Spec: ONE job: pay exactly this much FIRO to buyfiro.app from this wallet; then see the sell go
 *       through until the payout is sent.
 *       Primary CTA: "Send 500 FIRO to buyfiro.app" while it is unpaid: this screen is the payment's
 *       review (the amount, buyfiro.app's deposit address, the balance it comes from, what leaves the
 *       wallet, what arrives and where), then Face ID / the password, then it is broadcast. After it
 *       the one next step: back to the wallet, the Ethereum & BNB wallet once paid out, "Start a new
 *       sell" when nothing came, "Contact buyfiro.app support" when buyfiro.app needs a look.
 *       Taps from app open: it opens by itself after Sell (1) -> FIRO (2) -> the form's button (3);
 *       the payment is one more (4), then the password. Later: Sell -> FIRO -> Your sells -> the sell.
 * Exit-intent reasons and answers:
 *   - "What exactly leaves my wallet, and where to?" -> the amount, buyfiro.app's deposit address
 *     (checked by this wallet as a Firo address of the right kind), the balance, and the total that
 *     leaves are on this screen before anything is signed; who can see what, in one line.
 *   - "Did it work?" -> three steps, each ticked as buyfiro.app reports it; the screen updates by itself.
 *   - "Did I pay already?" -> once paid, it says so with the payment, and never offers to pay again
 *     (written down before and after the payment leaves); after an interrupted payment it says to look
 *     in Activity first; a payment the node didn't answer for "may have left": it is followed, and
 *     offered again only once the wallet has let it go (6 blocks without it), or once the person let
 *     it go on the node in use's word after an hour with no other node to check it (RE3-3).
 *   - "I opened it again while it was sending" -> the payment under way is shown as such ("Sending…"),
 *     never "It isn't there: send": one payment of a sell at a time in this page (lib/sell/pay.js),
 *     and a sell left before the password never asks for it (release verification 0.1.8).
 *   - "Can I close this?" -> said: yes; the sell keeps going and the payout arrives either way.
 *   - "It went wrong" -> what happened, whether anything was taken, and the one next step.
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copyText, textButton, toast, holdTaps } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { privacyLine } from './review.js';
import { sellFiro, paymentInWallet, mayPay } from '../lib/sell/wiring.js';
import { firoText, firoFigure, usd, receiveText, otherChainNote, sellSteps, untilText, KEEP_ORDER_TEXT } from '../lib/sell/words.js';
import { sellSiteUrl, payoutTxUrl } from '../lib/sell/hosts.js';
import { WALLET_CHAINS } from '../lib/sell/sellfiro.js';
import { paySell, unsureState, settleUnsure, expiryReason, sellPaymentUnderWay, onSellPayment } from '../lib/sell/pay.js';
import { UNSURE_TITLE } from '../lib/send_outcome.js';
import { paymentInFlight, onPaymentFlight, IN_FLIGHT_NOTE } from '../lib/payment_flight.js';
import { letGoOffer } from './let_go.js';
import { t, lang } from '../lib/i18n.js';


function kv(label, value, extra = {}) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value));
}

/** Where buyfiro.app pays, as a value: "Your Ethereum & BNB wallet" over its short address, or the address. */
function payoutCell(payout, testid = null) {
  const short = shorten(payout.address, 6, 4);
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Paid to') }), h('span', { class: 'v list', 'data-testid': testid }, payout.own ? h('span', { text: t('Your Ethereum & BNB wallet') }) : null, h('span', { class: 'mono small', text: short })));
}

/** buyfiro.app's page of the payout on its chain's explorer: a link the person taps (only a known explorer's). */
function payoutLink(o) {
  const url = o.payoutTxid ? payoutTxUrl(o.payoutExplorer, { chainId: o.payout.chainId, txid: o.payoutTxid }) : null;
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  return h('div', { class: 'explorer-link' }, h('a', { class: 'btn btn-text', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'sell-payout-link' }, icon('external'), t('See the {symbol} payout on {host}', { symbol: o.payout.symbol, host })), h('p', { class: 'small center', text: t('Opens {host} in your browser.', { host }) }));
}

/** Where this wallet's FIRO goes for `o` from `from`: buyfiro.app's Spark address for a private payment when there is one, else its transparent one. */
function target(o, from) {
  return from === 'private' && o.sparkDepositAddress ? { address: o.sparkDepositAddress, kind: 'spark' } : { address: o.depositAddress, kind: 'transparent' };
}

/** When a payment started: its time today ("14:05"), or its time and day (untilText). */
function startedAt(ms) {
  const d = new Date(ms);
  if (d.toDateString() !== new Date().toDateString()) return untilText(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function sellOrderScreen(app, params = {}) {
  const c = sellFiro(app);
  const id = params.id;
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'stack' });
  const fromBox = h('div', { class: 'segmented from-pick', role: 'radiogroup', 'aria-label': t('Pay from') });
  let payFrom = null;
  let pq = { key: null, quote: null, error: null, busy: false };
  let pqSeq = 0;
  let canPay = null; // mayPay(): null until known
  let canPayFor = null;
  let sending = false;
  let sendingText = t('Sending…');
  let sendMsg = null;
  let retryOk = false; // the person looked: an interrupted payment did not leave
  let settling = false; // an unsure payment is being settled (in a block, or let go)
  let goneNote = false; // the engine (true) or the person ('let-go') let an unsure payment go: said once, above the payment
  let otherOpen = false; // "Pay from another wallet" stays open across re-renders
  let alive = true;
  /** This sell's payment is under way: from this screen (sending), or from one left meanwhile (lib/sell/pay.js). */
  const underWay = () => sending || sellPaymentUnderWay(id);

  const copy = (text, what) => copyText(text, what);

  // ------------------------------------------------------------ paying
  function payKey(o) {
    const token = target(o, payFrom);
    return [o.orderId, payFrom, token.address, String(wallet.state.balance[payFrom].available), String(wallet.state.sync.canSend)].join('|');
  }

  /** What the payment takes from the wallet, asked of the engine whenever what it depends on changes. */
  function askPayQuote(o) {
    const key = payKey(o);
    if (pq.key === key) return;
    const seq = ++pqSeq;
    pq = { key, quote: null, error: null, busy: true };
    if (!wallet.session || !wallet.state.sync.canSend) {
      pq.busy = false;
      return;
    }
    wallet.quote({ from: payFrom, to: [{ address: target(o, payFrom).address, amount: o.amount }], subtractFee: false }).then(
      (q) => {
        if (seq !== pqSeq || !alive) return;
        pq = { ...pq, quote: q, busy: false };
        render();
      },
      (e) => {
        if (seq !== pqSeq || !alive) return;
        pq = { ...pq, error: e, busy: false };
        render();
      },
    );
  }

  /** Why the payment cannot go yet, in words; null when it can. */
  function payReason(o) {
    if (wallet.state.viewOnly) return t('This wallet can only watch: it cannot send FIRO.');
    // Too close to buyfiro.app's deadline, or past it (FM-3): the FIRO could arrive too late.
    const ex = expiryReason(o);
    if (ex) return ex;
    if (canPay === null) return t('Checking the deposit address…');
    const sync = wallet.state.sync;
    if (!wallet.session || !sync.canSend) return t('Sending is paused: {reason}.', { reason: (lang() === 'en' ? sync.title.toLowerCase() : sync.title).replace(/[.…。]+$/, '') });
    // Another payment from this wallet (Review, Privatize…) is still being sent: one at a time.
    if (paymentInFlight()) return t(IN_FLIGHT_NOTE);
    if (pq.error) {
      const have = wallet.available(payFrom);
      if (pq.error.code === 'insufficient') return have >= o.amount ? (payFrom === 'private' ? t('Your private balance has {amount}: sending {amount2} needs a little more.', { amount: firoText(have), amount2: firoText(o.amount) }) : t('Your public balance has {amount}: sending {amount2} needs a little more.', { amount: firoText(have), amount2: firoText(o.amount) })) : (payFrom === 'private' ? t('Your private balance has {amount}: not enough to send {amount2}.', { amount: firoText(have), amount2: firoText(o.amount) }) : t('Your public balance has {amount}: not enough to send {amount2}.', { amount: firoText(have), amount2: firoText(o.amount) }));
      return `${pq.error.message || pq.error}`;
    }
    if (pq.busy || !pq.quote) return t('Working out the payment…');
    return null;
  }

  async function pay() {
    const o = c.order(id);
    // Never twice: not while one is on its way, not once one left, not after one that may have.
    if (!o || underWay() || o.sentTxid || o.unsureTxid || paymentInWallet(o) || (o.sendStartedAt && !retryOk) || payReason(o) !== null) return;
    sending = true;
    sendingText = t('Sending…');
    sendMsg = null;
    goneNote = false;
    render();
    const from = payFrom;
    const to = [{ address: target(o, from).address, amount: o.amount }];
    let handedOver = false; // from here on, a failure may come after the payment left
    try {
      // The engine's figures again, a last look at buyfiro.app, the password, the sell read again,
      // then the payment with the figures reviewed: lib/sell/pay.js (audit FM-3).
      const r = await paySell({
        c,
        w: wallet,
        orderId: o.orderId,
        from,
        to,
        reviewedTotal: pq.quote ? pq.quote.total : null,
        retry: retryOk,
        // Left before it got here: no password over the next screen; left while it was asked: nothing sent.
        confirm: async () => alive && (await confirmIdentity(app, { title: t('Confirm the payment'), detail: t('{amount} to buyfiro.app', { amount: firoText(o.amount) }), cta: t('Confirm') })) && alive,
        onStage: (stage) => {
          if (stage === 'send') handedOver = true;
          sendingText = stage === 'look' ? t('Checking with buyfiro.app…') : t('Sending…');
          if (alive) render();
        },
      });
      if (!alive) return;
      const why = r.error ? `${r.error.message || r.error}` : '';
      if (r.kind === 'changed') {
        pq = { ...pq, quote: r.quote };
        sendMsg = h('div', { 'data-testid': 'sell-pay-changed' }, notice('warn', t('What leaves your wallet changed to {amount}. Check it, then send.', { amount: firoText(r.quote.total) })));
      } else if (r.kind === 'refused') {
        sendMsg = h('div', { 'data-testid': 'sell-pay-refused', 'data-code': r.code }, notice(r.code === 'unreachable' ? 'warn' : 'error', r.text));
      } else if (r.kind === 'sent') toast(t('Sent to buyfiro.app'));
      else if (r.kind === 'not-noted') sendMsg = notice('error', t('Firo PWA couldn\'t note this payment on this device, so it was not sent: {why} Nothing left your wallet.', { why }));
      else if (r.kind === 'not-sent' && r.error && r.error.code === 'fee-changed') {
        // The engine's new figures (BigInt), shown before anything is sent; asked again otherwise.
        const e = r.error;
        pq = typeof e.total === 'bigint' && typeof e.fee === 'bigint' ? { ...pq, quote: { ...(pq.quote || { warnings: [] }), fee: e.fee, total: e.total, change: typeof e.change === 'bigint' ? e.change : 0n } } : { key: null, quote: null, error: null, busy: false };
        sendMsg = h('div', { 'data-testid': 'sell-pay-changed' }, notice('warn', typeof e.total === 'bigint' ? t('What leaves your wallet changed to {amount} since you checked it, so nothing was sent. Check it, then send.', { amount: firoText(e.total) }) : t('What leaves your wallet changed since you checked it, so nothing was sent. Check the new figure, then send.')));
      } else if (r.kind === 'not-sent')
        sendMsg = h(
          'div',
          { 'data-testid': 'sell-pay-error' },
          notice('error', t('The payment was not sent: {why} Nothing left your wallet.', { why })),
          // A node's list of private coins did not check out (audit D-09): fetched again from another (FM-7).
          r.otherServer ? secondary(t('Try another node'), otherNode, { 'data-testid': 'sell-other-node' }) : null,
        );
      // 'unsure': the sell now carries the payment, and says so (render). 'cancelled': nothing to say.
      else if (r.kind === 'unknown') {
        sendMsg = h('div', { 'data-testid': 'sell-pay-error' }, notice('error', t('Firo PWA couldn\'t tell whether the payment left: {why} Look in Activity before you send again.', { why })));
        retryOk = false;
      }
    } catch (e) {
      sendMsg = handedOver
        ? h('div', { 'data-testid': 'sell-pay-error' }, notice('error', t('Firo PWA couldn\'t tell whether the payment left: {value} Look in Activity before you send again.', { value: (e && e.message) || e })))
        : h('div', { 'data-testid': 'sell-pay-error' }, notice('error', t('The payment was not sent: {value} Nothing left your wallet.', { value: (e && e.message) || e })));
      if (handedOver) retryOk = false;
    } finally {
      sending = false;
      if (alive) render();
    }
  }

  /** After a private payment stopped by a node's list of private coins: the next node, its lists fetched again. */
  async function otherNode() {
    sendMsg = notice('info', t('Connecting to another Firo node…'));
    render();
    try {
      await wallet.useAnotherServer();
      sendMsg = h('div', { 'data-testid': 'sell-other-node-done' }, notice('info', t('Now on another Firo node. It is sending its list of private coins; send again once your wallet says it is up to date.')));
    } catch (e) {
      sendMsg = h('div', { 'data-testid': 'sell-pay-error' }, notice('error', t('Could not move to another node: {value}', { value: e.message || e })));
    }
    if (alive) render();
  }

  function renderFrom(o) {
    const b = wallet.state.balance;
    const opt = (fid, label, avail) =>
      h(
        'button',
        { type: 'button', class: `seg${payFrom === fid ? ' on' : ''}`, role: 'radio', 'aria-checked': String(payFrom === fid), 'data-testid': `sell-pay-from-${fid}`, disabled: underWay(), onclick: () => ((payFrom = fid), (sendMsg = null), render()) },
        h('span', { class: 'seg-t' }, icon(fid === 'private' ? 'spark' : 'eye'), label),
        h('span', { class: 'seg-s', text: `${formatAmount(avail)} ${UNIT}` }),
      );
    put(fromBox, opt('private', t('Private'), b.private.available), opt('public', t('Public'), b.public.available));
    return o;
  }

  /** The payment's own review: everything that happens when the button is pressed. */
  function payment(o) {
    const token = target(o, payFrom);
    askPayQuote(o);
    renderFrom(o);
    const other = otherChainNote(o.payout);
    const n = pq.quote && pq.quote.warnings ? pq.quote.warnings : [];
    return [
      o.fellBack ? notice('info', h('span', { 'data-testid': 'sell-fell-back', text: t("buyfiro.app takes public FIRO only right now, so this sell has a public deposit address. You can still pay from your private balance; anyone can see what arrives at that address.") })) : null,
      h(
        'div',
        { class: 'card sell-pay', 'data-testid': 'sell-pay-card' },
        h('p', { class: 'center small', text: t('You send') }),
        h('div', { class: 'big-amount', 'data-testid': 'sell-pay-amount', text: firoText(o.amount) }),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v list' }, h('span', { text: 'buyfiro.app' }), h('span', { class: 'mono small', 'data-testid': 'sell-pay-to', 'data-address': token.address, text: shorten(token.address, 10, 8) }))), // i18n-ignore: a name, the same in every language
        h('div', { class: 'field' }, h('span', { text: t('From') }), fromBox),
        pq.quote ? kv(t('Leaves your wallet'), firoText(pq.quote.total), { 'data-testid': 'sell-pay-total' }) : null,
        o.receiveUsd != null ? kv(t('You receive'), receiveText(o.receiveUsd, o.payout), { 'data-testid': 'sell-pay-receive' }) : null,
        payoutCell(o.payout, 'sell-pay-payout'),
      ),
      h('div', { 'data-testid': 'sell-pay-privacy' }, notice(payFrom === 'private' && token.kind === 'spark' ? 'success' : 'info', privacyLine(payFrom, token.kind))),
      ...n.map((w) => notice('info', w)),
      other ? notice('info', other) : null,
      o.expiresAt ? h('p', { class: 'small', 'data-testid': 'sell-expires', text: t('buyfiro.app takes it until {when}. A payment cannot be taken back once it is sent.', { when: untilText(o.expiresAt) }) }) : h('p', { class: 'small', text: t('A payment cannot be taken back once it is sent.') }),
      sendMsg,
      o.payable && !expiryReason(o)
        ? h(
            'details',
            { class: 'more card flat', 'data-testid': 'sell-other-wallet', open: otherOpen, ontoggle: (ev) => (otherOpen = ev.currentTarget.open) },
            h('summary', { text: t('Pay from another wallet') }),
            h('p', { class: 'small', text: t('Send exactly {amount} to this address, from any Firo wallet:', { amount: firoText(o.amount) }) }),
            h('p', { class: 'mono', 'data-testid': 'sell-deposit-address', text: o.depositAddress }),
            h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: () => copy(o.depositAddress, t('Address copied')) }, icon('copy'), t('Copy address')), h('button', { class: 'btn btn-text btn-small', onclick: () => copy(formatAmount(o.amount, { group: false }), t('Amount copied')) }, icon('copy'), t('Copy amount'))),
            // Paid there: this wallet must not pay it too (FM-10).
            h('p', { class: 'small', text: t("Paid it from another wallet? Say so, and Firo PWA won't offer to pay it from this one too.") }),
            h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'sell-paid-elsewhere-mark', disabled: underWay(), onclick: paidElsewhere }, t('I paid it from another wallet')),
          )
        : null,
    ];
  }

  async function paidElsewhere() {
    if (underWay()) return;
    try {
      const o = await c.markPaidElsewhere(id);
      // This wallet's own payment started too: the person is told it may be paid twice, and what to do.
      if (o && (o.sentTxid || o.unsureTxid || (o.sendStartedAt && o.sendStartedAt !== o.paidElsewhereAt))) {
        sendMsg = h('div', { 'data-testid': 'sell-paid-both' }, notice('warn', h('strong', { text: t('This wallet started a payment for this sell too. ') }), t('If both left, buyfiro.app was paid twice: look in Activity, and contact buyfiro.app with both payments so the second one can be sorted out.')));
      }
    } catch (e) {
      sendMsg = notice('error', t('Firo PWA couldn\'t note this on this device: {value}', { value: e.message || e }));
    }
    if (alive) render();
  }

  async function notPaidElsewhere() {
    await c.unmarkPaidElsewhere(id);
    if (alive) render();
  }

  // ------------------------------------------------------------ the sell
  function stateNotice(o, s, paid) {
    const n = (kind, key, title, detail) => {
      const el = notice(kind, h('strong', { text: `${title} ` }), detail || '');
      el.dataset.testid = key;
      return el;
    };
    const short = shorten(o.payout.address, 6, 4);
    switch (s) {
      case 'awaiting_deposit':
        return paid ? n('success', 'sell-sent', t('Sent to buyfiro.app.'), t('buyfiro.app sees it once it is in a block, usually within 5 minutes. Then it sells your FIRO and pays you.')) : null;
      case 'limit_open':
        return n('info', 'sell-limit', t('Waiting for your price.'), t('buyfiro.app sells when FIRO reaches it, or at the market price when the time is up.'));
      case 'delivered': {
        const amount = o.proceedsUsd != null ? usd(o.proceedsUsd) : o.receiveUsd != null ? `≈ ${usd(o.receiveUsd)}` : t('Your money');
        return n('success', 'sell-delivered', t('Paid: {amount} in {symbol}.', { amount, symbol: o.payout.symbol }), (o.payout.own ? t('buyfiro.app sent it to your Ethereum & BNB wallet on {chainName}.', { chainName: o.payout.chainName }) : t('buyfiro.app sent it to {address} on {chainName}.', { address: short, chainName: o.payout.chainName })));
      }
      case 'expired':
        return paid
          ? n('error', 'sell-expired', paid.elsewhere ? t('buyfiro.app says no FIRO arrived in time, but you paid it from another wallet.') : t('buyfiro.app says no FIRO arrived in time, but this wallet sent it.'), t('Contact buyfiro.app support with the order number (copy it below). They can see where it is.'))
          : n('warn', 'sell-expired', t('No FIRO arrived in time. Nothing was taken.'), t('This sell has ended. Start a new one to get a new deposit address.'));
      case 'refused':
        return paid
          ? n('error', 'sell-refused', t("buyfiro.app couldn't start this sell."), t('Your FIRO was sent: contact buyfiro.app support with the order number (copy it below).'))
          : n('warn', 'sell-refused', t("buyfiro.app couldn't start this sell. Nothing was taken."), t('Start a new sell, or contact buyfiro.app support with the order number.'));
      case 'attention':
        return n('warn', 'sell-attention', t('buyfiro.app is checking this sell.'), t('Contact their support with the order number (copy it below). Firo PWA keeps checking meanwhile.'));
      default:
        return null;
    }
  }

  function steps(o, s, paid) {
    const mark = { done: 'check', active: 'clock', waiting: null, failed: 'close' };
    return h(
      'div',
      { class: 'card steps', 'data-testid': 'sell-steps' },
      ...sellSteps(s, { sent: Boolean(paid || o.paidElsewhereAt), unsure: Boolean(o.unsureTxid), symbol: o.payout.symbol }).map((st, i) =>
        h('div', { class: `step-row ${st.mark}`, 'data-testid': `sell-step-${i}`, 'data-mark': st.mark }, h('span', { class: 'step-mark' }, mark[st.mark] ? icon(mark[st.mark]) : null), h('span', { class: 'grow', text: st.label }), st.note ? h('span', { class: 'small', text: st.note }) : null),
      ),
    );
  }

  function details(o, s, paid) {
    const delivered = s === 'delivered';
    const tx = paid ? paid.txid || o.sentTxid : o.unsureTxid || null;
    return h(
      'div',
      { class: 'card flat swap-details' },
      kv(paid ? t('You sent') : t('You sell'), firoText(o.amount)),
      o.receivedFiro != null ? kv(t('buyfiro.app received'), `${firoFigure(o.receivedFiro)} ${UNIT}`, { 'data-testid': 'sell-received-firo' }) : null,
      delivered && o.proceedsUsd != null
        ? kv(t('You received'), t('{proceedsUsd} in {symbol}', { proceedsUsd: usd(o.proceedsUsd), symbol: o.payout.symbol }), { 'data-testid': 'sell-proceeds' })
        : o.receiveUsd != null && s !== 'expired' && s !== 'refused'
          ? kv(t('You receive'), receiveText(o.receiveUsd, o.payout), { 'data-testid': 'sell-order-receive' })
          : null,
      payoutCell(o.payout),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Order') }), h('button', { class: 'v mono btn-text', 'data-testid': 'sell-copy-order', onclick: () => copy(o.orderId, t('Order number copied')), text: shorten(o.orderId, 8, 6) })),
      tx ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Your payment') }), h('button', { class: 'v mono btn-text', 'data-testid': 'sell-your-payment', onclick: () => app.go('activity', { txid: tx }), text: shorten(tx, 6, 4) })) : null,
      o.payoutTxid
        ? h(
            'div',
            { class: 'kv' },
            h('span', { class: 'k', text: t('{symbol} payout', { symbol: o.payout.symbol }) }),
            h('button', { class: 'v mono btn-text', 'data-testid': 'sell-payout-txid', onclick: () => copy(o.payoutTxid, t('Transaction ID copied')), text: shorten(o.payoutTxid, 6, 4) }),
          )
        : null,
    );
  }

  function render() {
    if (!alive) return;
    const o = c.order(id);
    if (!o) {
      put(body, c.loadError ? notice('error', t('Your sells could not be opened: {message}', { message: c.loadError.message })) : h('p', { class: 'small', text: t('Loading your sell…') }));
      put(actions, primary(t('Back to your wallet'), () => app.go('home'), { 'data-testid': 'sell-order-cta' }));
      return;
    }
    if (payFrom === null) payFrom = o.sentFrom || o.payFrom;
    if (canPayFor !== o.orderId) {
      canPayFor = o.orderId;
      canPay = null;
      mayPay(o).then((v) => {
        canPay = v;
        render();
      });
    }
    const s = o.lastState || 'awaiting_deposit';
    // A payment that may have left (no answer from the node): in a block it is paid; once the engine
    // says the network does not have it (Tx.dropped) the sell may be paid again; until then it is
    // followed and nothing is offered (FM-1). A payment the node took that is dropped after all too.
    const unsure = unsureState(o, wallet);
    // This sell's payment as the wallet follows it (its Tx), while it carries one.
    const payTx = o.unsureTxid || o.sentTxid ? wallet.state.txs.find((tx) => tx.txid === (o.unsureTxid || o.sentTxid)) || null : null;
    if ((unsure === 'left' || unsure === 'gone') && !settling) {
      settling = true;
      const letGo = Boolean(payTx && payTx.letGo);
      settleUnsure(c, id, wallet)
        .then((st) => {
          if (st === 'gone') goneNote = letGo ? 'let-go' : true;
        })
        .catch(() => {})
        .finally(() => {
          settling = false;
          render();
        });
    }
    // A payment the network does not have (Tx.dropped) is not paid: settled above, then payable again.
    const paid = o.sentTxid ? (unsure === 'gone' ? null : { txid: o.sentTxid }) : o.unsureTxid ? null : paymentInWallet(o);
    // For an ending: this wallet's payment, or one that may have left.
    const claimed = paid || (o.unsureTxid ? { txid: o.unsureTxid } : null) || (o.paidElsewhereAt ? { elsewhere: true } : null);
    const unpaid = s === 'awaiting_deposit' && !paid;
    // This sell's payment under way here or from a screen left meanwhile: shown as being sent, never
    // as an interrupted one to send again (release verification 0.1.8).
    const busy = underWay();
    const following = unpaid && Boolean(o.unsureTxid) && !busy;
    // Paid from another wallet, by the person's word (FM-10): never offered from this one.
    const elsewhere = unpaid && Boolean(o.paidElsewhereAt) && !o.unsureTxid && !busy;
    const uncertain = unpaid && o.sendStartedAt && !o.unsureTxid && !o.paidElsewhereAt && !busy && !retryOk;
    // The node in use says this payment never left, and no other node could check it for an hour:
    // the person may let it go (RE3-3); never the engine alone.
    const offer = s === 'awaiting_deposit' && payTx && payTx.oneNode ? letGoOffer(payTx) : null;
    const testOnly = o.sandbox && (!o.payable || canPay === false);
    titleEl.textContent = unpaid && !testOnly && !following && !elsewhere ? t('Send {amount}', { amount: firoText(o.amount) }) : t('Sell FIRO');
    const pollError = c.pollError(id);
    put(
      body,
      o.sandbox ? notice('info', h('span', { 'data-testid': 'sell-test-mode', text: testOnly ? t("buyfiro.app's test mode: nothing to pay.") : t("buyfiro.app's test mode: nothing is sold.") })) : null,
      uncertain ? h('div', { 'data-testid': 'sell-interrupted' }, notice('warn', h('strong', { text: t('A payment for this sell started at {when}, and Firo PWA can\'t tell whether it left. ', { when: startedAt(o.sendStartedAt) }) }), t('Look in Activity first: if it is there, there is nothing more to do.'))) : null,
      following ? h('div', { 'data-testid': 'sell-unsure', 'data-txid': o.unsureTxid }, notice('warn', h('strong', { text: `${t(UNSURE_TITLE)} ` }), t('The Firo node didn\'t answer when your {amount} went out. Follow it in Activity: once it is in a block, buyfiro.app takes it and this sell goes on by itself. If the Firo network turns out not to have it, Firo PWA says so here once two Firo nodes confirm they do not have it, and you can send it again.', { amount: firoText(o.amount) }))) : null,
      following ? offer : null,
      elsewhere ? h('div', { 'data-testid': 'sell-paid-elsewhere' }, notice('info', h('strong', { text: t('You paid this sell from another wallet. ') }), t("buyfiro.app shows it here once it arrives, usually a few minutes after its first block. Firo PWA won't offer to pay it from this wallet."))) : null,
      goneNote && unpaid && !following
        ? h(
            'div',
            { 'data-testid': 'sell-unsure-gone', 'data-let-go': String(goneNote === 'let-go') },
            notice('info', goneNote === 'let-go' ? t('You let your earlier payment go on the word of the Firo node in use: its FIRO is back in your balance. If it did leave, buyfiro.app shows it here once it arrives, and sending it again would pay twice.') : t("Your earlier payment didn't go through: the Firo network doesn't have it, and its FIRO is back in your balance. You can send it again.")),
          )
        : null,
      stateNotice(o, s, s === 'expired' || s === 'refused' ? claimed : paid),
      following ? null : offer,
      ...(unpaid && !uncertain && !following && !elsewhere && !testOnly ? payment(o) : []),
      steps(o, s, paid),
      details(o, s, paid),
      // Not in the backup file (FM-6): said while it matters.
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'sell-keep-order', text: t(KEEP_ORDER_TEXT) }) : null,
      s === 'delivered' ? payoutLink(o) : null,
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'sell-can-leave', text: t('You can leave this screen or close Firo PWA: once your FIRO is sent the sell keeps going, and the payout arrives even while Firo PWA is closed.') }) : null,
      pollError && o.isOpen ? h('p', { class: 'small', 'data-testid': 'sell-poll-error', text: pollError.unreachable ? t("Couldn't reach buyfiro.app just now. Firo PWA keeps checking.") : t("buyfiro.app's last answer didn't make sense. Firo PWA keeps checking.") }) : null,
    );

    const support = (label = t('Contact buyfiro.app support')) => h('a', { class: 'btn btn-primary', href: sellSiteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'sell-order-cta' }, label);
    const home = () => primary(t('Back to your wallet'), () => app.go('home'), { 'data-testid': 'sell-order-cta' });
    if (following) {
      put(actions, primary(t('Follow it in Activity'), () => app.go('activity', { txid: o.unsureTxid }), { 'data-testid': 'sell-order-cta' }));
    } else if (elsewhere) {
      put(actions, primary(t('Back to your wallet'), () => app.go('home'), { 'data-testid': 'sell-order-cta' }), textButton(t("I haven't paid it: undo"), notPaidElsewhere, { 'data-testid': 'sell-paid-elsewhere-undo' }));
    } else if (unpaid && uncertain) {
      put(actions, primary(t('Open Activity'), () => app.go('activity'), { 'data-testid': 'sell-order-cta' }), textButton(t('It isn\'t there: send {amount}', { amount: firoText(o.amount) }), () => ((retryOk = true), render()), { 'data-testid': 'sell-pay-anyway' }));
    } else if (unpaid && !testOnly) {
      const why = busy ? null : payReason(o);
      const cta = primary(sending ? sendingText : busy ? t('Sending…') : t('Send {amount} to buyfiro.app', { amount: firoText(o.amount) }), pay, { 'data-testid': 'sell-order-cta', disabled: busy || why !== null });
      cta.dataset.action = 'pay';
      const other = payFrom === 'private' ? 'public' : 'private';
      const fix = pq.error && pq.error.code === 'insufficient' && wallet.available(other) > o.amount ? textButton((other === 'private' ? t('Pay from private instead') : t('Pay from public instead')), () => ((payFrom = other), render()), { 'data-testid': 'sell-pay-other' }) : null;
      put(actions, why ? h('p', { class: 'hint center', 'data-testid': 'sell-pay-reason', text: why }) : null, cta, fix);
    } else if (s === 'delivered') {
      const ethSide = o.payout.own && WALLET_CHAINS.includes(o.payout.chainId) && app.has('ethHome');
      put(actions, ethSide ? primary(t('Open your Ethereum & BNB wallet'), () => app.go('ethHome'), { 'data-testid': 'sell-order-cta' }) : home(), ethSide ? textButton(t('Back to your wallet'), () => app.go('home'), { 'data-testid': 'sell-order-home' }) : null);
    } else if ((s === 'expired' || s === 'refused') && !claimed) {
      put(actions, primary(t('Start a new sell'), () => app.go('sellFiro', {}, { replace: true }), { 'data-testid': 'sell-order-cta' }));
    } else if (s === 'expired' || s === 'refused' || s === 'attention') {
      put(actions, support());
    } else {
      put(actions, home(), paid && paid.txid ? textButton(t('See your payment'), () => app.go('activity', { txid: paid.txid }), { 'data-testid': 'sell-order-see' }) : null);
    }
    root.dataset.state = s;
    root.dataset.paid = String(Boolean(paid));
  }

  const el = screen({ title: t('Sell FIRO'), back: () => app.back(params.from === 'list' ? 'sellOrders' : 'home'), actions: [actions], cls: 'sell-order sticky-actions' }, body);
  const titleEl = el.querySelector('.topbar h1');
  const root = el;
  const off = c.onChange(() => render());
  const offW = wallet.onChange(() => render());
  // A payment of this sell from a screen left meanwhile, or another Firo payment, ended (or started).
  const offPaying = onSellPayment(() => render());
  const offFlight = onPaymentFlight(() => render());
  render();
  (async () => {
    await c.resumeAll();
    // Where it is now, not where it was when the app last looked.
    const o = c.order(id);
    if (o && o.isOpen && alive) await c.poll(id);
    render();
  })();
  // The sell form's button sits where "Send 500 FIRO to buyfiro.app" is: the second tap of a double tap is held.
  const hold = holdTaps(el);
  return {
    el,
    destroy() {
      alive = false;
      hold.stop();
      off();
      offW();
      offPaying();
      offFlight();
    },
  };
}
