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


function kv(label, value, extra = {}) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value));
}

/** Where buyfiro.app pays, as a value: "Your Ethereum & BNB wallet" over its short address, or the address. */
function payoutCell(payout, testid = null) {
  const short = shorten(payout.address, 6, 4);
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Paid to' }), h('span', { class: 'v list', 'data-testid': testid }, payout.own ? h('span', { text: 'Your Ethereum & BNB wallet' }) : null, h('span', { class: 'mono small', text: short })));
}

/** buyfiro.app's page of the payout on its chain's explorer: a link the person taps (only a known explorer's). */
function payoutLink(o) {
  const url = o.payoutTxid ? payoutTxUrl(o.payoutExplorer, { chainId: o.payout.chainId, txid: o.payoutTxid }) : null;
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  return h('div', { class: 'explorer-link' }, h('a', { class: 'btn btn-text', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'sell-payout-link' }, icon('external'), `See the ${o.payout.symbol} payout on ${host}`), h('p', { class: 'small center', text: `Opens ${host} in your browser.` }));
}

/** Where this wallet's FIRO goes for `o` from `from`: buyfiro.app's Spark address for a private payment when there is one, else its transparent one. */
function target(o, from) {
  return from === 'private' && o.sparkDepositAddress ? { address: o.sparkDepositAddress, kind: 'spark' } : { address: o.depositAddress, kind: 'transparent' };
}

export default function sellOrderScreen(app, params = {}) {
  const c = sellFiro(app);
  const id = params.id;
  const body = h('div', { class: 'stack' });
  const actions = h('div', { class: 'stack' });
  const fromBox = h('div', { class: 'segmented from-pick', role: 'radiogroup', 'aria-label': 'Pay from' });
  let payFrom = null;
  let pq = { key: null, quote: null, error: null, busy: false };
  let pqSeq = 0;
  let canPay = null; // mayPay(): null until known
  let canPayFor = null;
  let sending = false;
  let sendingText = 'Sending…';
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
    const t = target(o, payFrom);
    return [o.orderId, payFrom, t.address, String(wallet.state.balance[payFrom].available), String(wallet.state.sync.canSend)].join('|');
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
    if (wallet.state.viewOnly) return 'This wallet can only watch: it cannot send FIRO.';
    // Too close to buyfiro.app's deadline, or past it (FM-3): the FIRO could arrive too late.
    const ex = expiryReason(o);
    if (ex) return ex;
    if (canPay === null) return 'Checking the deposit address…';
    const sync = wallet.state.sync;
    if (!wallet.session || !sync.canSend) return `Sending is paused: ${sync.title.toLowerCase().replace(/[.…]+$/, '')}.`;
    // Another payment from this wallet (Review, Privatize…) is still being sent: one at a time.
    if (paymentInFlight()) return IN_FLIGHT_NOTE;
    if (pq.error) {
      const have = wallet.available(payFrom);
      if (pq.error.code === 'insufficient') return have >= o.amount ? `Your ${payFrom} balance has ${firoText(have)}: sending ${firoText(o.amount)} needs a little more.` : `Your ${payFrom} balance has ${firoText(have)}: not enough to send ${firoText(o.amount)}.`;
      return `${pq.error.message || pq.error}`;
    }
    if (pq.busy || !pq.quote) return 'Working out the payment…';
    return null;
  }

  async function pay() {
    const o = c.order(id);
    // Never twice: not while one is on its way, not once one left, not after one that may have.
    if (!o || underWay() || o.sentTxid || o.unsureTxid || paymentInWallet(o) || (o.sendStartedAt && !retryOk) || payReason(o) !== null) return;
    sending = true;
    sendingText = 'Sending…';
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
        confirm: async () => alive && (await confirmIdentity(app, { title: 'Confirm the payment', detail: `${firoText(o.amount)} to buyfiro.app`, cta: 'Confirm' })) && alive,
        onStage: (stage) => {
          if (stage === 'send') handedOver = true;
          sendingText = stage === 'look' ? 'Checking with buyfiro.app…' : 'Sending…';
          if (alive) render();
        },
      });
      if (!alive) return;
      const why = r.error ? `${r.error.message || r.error}` : '';
      if (r.kind === 'changed') {
        pq = { ...pq, quote: r.quote };
        sendMsg = h('div', { 'data-testid': 'sell-pay-changed' }, notice('warn', `What leaves your wallet changed to ${firoText(r.quote.total)}. Check it, then send.`));
      } else if (r.kind === 'refused') {
        sendMsg = h('div', { 'data-testid': 'sell-pay-refused', 'data-code': r.code }, notice(r.code === 'unreachable' ? 'warn' : 'error', r.text));
      } else if (r.kind === 'sent') toast('Sent to buyfiro.app');
      else if (r.kind === 'not-noted') sendMsg = notice('error', `Campfire couldn't note this payment on this device, so it was not sent: ${why} Nothing left your wallet.`);
      else if (r.kind === 'not-sent' && r.error && r.error.code === 'fee-changed') {
        // The engine's new figures (BigInt), shown before anything is sent; asked again otherwise.
        const e = r.error;
        pq = typeof e.total === 'bigint' && typeof e.fee === 'bigint' ? { ...pq, quote: { ...(pq.quote || { warnings: [] }), fee: e.fee, total: e.total, change: typeof e.change === 'bigint' ? e.change : 0n } } : { key: null, quote: null, error: null, busy: false };
        sendMsg = h('div', { 'data-testid': 'sell-pay-changed' }, notice('warn', typeof e.total === 'bigint' ? `What leaves your wallet changed to ${firoText(e.total)} since you checked it, so nothing was sent. Check it, then send.` : 'What leaves your wallet changed since you checked it, so nothing was sent. Check the new figure, then send.'));
      } else if (r.kind === 'not-sent')
        sendMsg = h(
          'div',
          { 'data-testid': 'sell-pay-error' },
          notice('error', `The payment was not sent: ${why} Nothing left your wallet.`),
          // A node's list of private coins did not check out (audit D-09): fetched again from another (FM-7).
          r.otherServer ? secondary('Try another node', otherNode, { 'data-testid': 'sell-other-node' }) : null,
        );
      // 'unsure': the sell now carries the payment, and says so (render). 'cancelled': nothing to say.
      else if (r.kind === 'unknown') {
        sendMsg = h('div', { 'data-testid': 'sell-pay-error' }, notice('error', `Campfire couldn't tell whether the payment left: ${why} Look in Activity before you send again.`));
        retryOk = false;
      }
    } catch (e) {
      sendMsg = handedOver
        ? h('div', { 'data-testid': 'sell-pay-error' }, notice('error', `Campfire couldn't tell whether the payment left: ${(e && e.message) || e} Look in Activity before you send again.`))
        : h('div', { 'data-testid': 'sell-pay-error' }, notice('error', `The payment was not sent: ${(e && e.message) || e} Nothing left your wallet.`));
      if (handedOver) retryOk = false;
    } finally {
      sending = false;
      if (alive) render();
    }
  }

  /** After a private payment stopped by a node's list of private coins: the next node, its lists fetched again. */
  async function otherNode() {
    sendMsg = notice('info', 'Connecting to another Firo node…');
    render();
    try {
      await wallet.useAnotherServer();
      sendMsg = h('div', { 'data-testid': 'sell-other-node-done' }, notice('info', 'Now on another Firo node. It is sending its list of private coins; send again once your wallet says it is up to date.'));
    } catch (e) {
      sendMsg = h('div', { 'data-testid': 'sell-pay-error' }, notice('error', `Could not move to another node: ${e.message || e}`));
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
    put(fromBox, opt('private', 'Private', b.private.available), opt('public', 'Public', b.public.available));
    return o;
  }

  /** The payment's own review: everything that happens when the button is pressed. */
  function payment(o) {
    const t = target(o, payFrom);
    askPayQuote(o);
    renderFrom(o);
    const other = otherChainNote(o.payout);
    const n = pq.quote && pq.quote.warnings ? pq.quote.warnings : [];
    return [
      o.fellBack ? notice('info', h('span', { 'data-testid': 'sell-fell-back', text: "buyfiro.app takes public FIRO only right now, so this sell has a public deposit address. You can still pay from your private balance; anyone can see what arrives at that address." })) : null,
      h(
        'div',
        { class: 'card sell-pay', 'data-testid': 'sell-pay-card' },
        h('p', { class: 'center small', text: 'You send' }),
        h('div', { class: 'big-amount', 'data-testid': 'sell-pay-amount', text: firoText(o.amount) }),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v list' }, h('span', { text: 'buyfiro.app' }), h('span', { class: 'mono small', 'data-testid': 'sell-pay-to', 'data-address': t.address, text: shorten(t.address, 10, 8) }))),
        h('div', { class: 'field' }, h('span', { text: 'From' }), fromBox),
        pq.quote ? kv('Leaves your wallet', firoText(pq.quote.total), { 'data-testid': 'sell-pay-total' }) : null,
        o.receiveUsd != null ? kv('You receive', receiveText(o.receiveUsd, o.payout), { 'data-testid': 'sell-pay-receive' }) : null,
        payoutCell(o.payout, 'sell-pay-payout'),
      ),
      h('div', { 'data-testid': 'sell-pay-privacy' }, notice(payFrom === 'private' && t.kind === 'spark' ? 'success' : 'info', privacyLine(payFrom, t.kind))),
      ...n.map((w) => notice('info', w)),
      other ? notice('info', other) : null,
      o.expiresAt ? h('p', { class: 'small', 'data-testid': 'sell-expires', text: `buyfiro.app takes it until ${untilText(o.expiresAt)}. A payment cannot be taken back once it is sent.` }) : h('p', { class: 'small', text: 'A payment cannot be taken back once it is sent.' }),
      sendMsg,
      o.payable && !expiryReason(o)
        ? h(
            'details',
            { class: 'more card flat', 'data-testid': 'sell-other-wallet', open: otherOpen, ontoggle: (ev) => (otherOpen = ev.currentTarget.open) },
            h('summary', { text: 'Pay from another wallet' }),
            h('p', { class: 'small', text: `Send exactly ${firoText(o.amount)} to this address, from any Firo wallet:` }),
            h('p', { class: 'mono', 'data-testid': 'sell-deposit-address', text: o.depositAddress }),
            h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: () => copy(o.depositAddress, 'Address copied') }, icon('copy'), 'Copy address'), h('button', { class: 'btn btn-text btn-small', onclick: () => copy(formatAmount(o.amount, { group: false }), 'Amount copied') }, icon('copy'), 'Copy amount')),
            // Paid there: this wallet must not pay it too (FM-10).
            h('p', { class: 'small', text: "Paid it from another wallet? Say so, and Campfire won't offer to pay it from this one too." }),
            h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'sell-paid-elsewhere-mark', disabled: underWay(), onclick: paidElsewhere }, 'I paid it from another wallet'),
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
        sendMsg = h('div', { 'data-testid': 'sell-paid-both' }, notice('warn', h('strong', { text: 'This wallet started a payment for this sell too. ' }), 'If both left, buyfiro.app was paid twice: look in Activity, and contact buyfiro.app with both payments so the second one can be sorted out.'));
      }
    } catch (e) {
      sendMsg = notice('error', `Campfire couldn't note this on this device: ${e.message || e}`);
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
        return paid ? n('success', 'sell-sent', 'Sent to buyfiro.app.', 'buyfiro.app sees it once it is in a block, usually within 5 minutes. Then it sells your FIRO and pays you.') : null;
      case 'limit_open':
        return n('info', 'sell-limit', 'Waiting for your price.', 'buyfiro.app sells when FIRO reaches it, or at the market price when the time is up.');
      case 'delivered': {
        const amount = o.proceedsUsd != null ? usd(o.proceedsUsd) : o.receiveUsd != null ? `≈ ${usd(o.receiveUsd)}` : 'Your money';
        return n('success', 'sell-delivered', `Paid: ${amount} in ${o.payout.symbol}.`, `buyfiro.app sent it to ${o.payout.own ? 'your Ethereum & BNB wallet' : short} on ${o.payout.chainName}.`);
      }
      case 'expired':
        return paid
          ? n('error', 'sell-expired', paid.elsewhere ? 'buyfiro.app says no FIRO arrived in time, but you paid it from another wallet.' : 'buyfiro.app says no FIRO arrived in time, but this wallet sent it.', 'Contact buyfiro.app support with the order number (copy it below). They can see where it is.')
          : n('warn', 'sell-expired', 'No FIRO arrived in time. Nothing was taken.', 'This sell has ended. Start a new one to get a new deposit address.');
      case 'refused':
        return paid
          ? n('error', 'sell-refused', "buyfiro.app couldn't start this sell.", 'Your FIRO was sent: contact buyfiro.app support with the order number (copy it below).')
          : n('warn', 'sell-refused', "buyfiro.app couldn't start this sell. Nothing was taken.", 'Start a new sell, or contact buyfiro.app support with the order number.');
      case 'attention':
        return n('warn', 'sell-attention', 'buyfiro.app is checking this sell.', 'Contact their support with the order number (copy it below). Campfire keeps checking meanwhile.');
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
      kv(paid ? 'You sent' : 'You sell', firoText(o.amount)),
      o.receivedFiro != null ? kv('buyfiro.app received', `${firoFigure(o.receivedFiro)} ${UNIT}`, { 'data-testid': 'sell-received-firo' }) : null,
      delivered && o.proceedsUsd != null
        ? kv('You received', `${usd(o.proceedsUsd)} in ${o.payout.symbol}`, { 'data-testid': 'sell-proceeds' })
        : o.receiveUsd != null && s !== 'expired' && s !== 'refused'
          ? kv('You receive', receiveText(o.receiveUsd, o.payout), { 'data-testid': 'sell-order-receive' })
          : null,
      payoutCell(o.payout),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Order' }), h('button', { class: 'v mono btn-text', 'data-testid': 'sell-copy-order', onclick: () => copy(o.orderId, 'Order number copied'), text: shorten(o.orderId, 8, 6) })),
      tx ? h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Your payment' }), h('button', { class: 'v mono btn-text', 'data-testid': 'sell-your-payment', onclick: () => app.go('activity', { txid: tx }), text: shorten(tx, 6, 4) })) : null,
      o.payoutTxid
        ? h(
            'div',
            { class: 'kv' },
            h('span', { class: 'k', text: `${o.payout.symbol} payout` }),
            h('button', { class: 'v mono btn-text', 'data-testid': 'sell-payout-txid', onclick: () => copy(o.payoutTxid, 'Transaction ID copied'), text: shorten(o.payoutTxid, 6, 4) }),
          )
        : null,
    );
  }

  function render() {
    if (!alive) return;
    const o = c.order(id);
    if (!o) {
      put(body, c.loadError ? notice('error', `Your sells could not be opened: ${c.loadError.message}`) : h('p', { class: 'small', text: 'Loading your sell…' }));
      put(actions, primary('Back to your wallet', () => app.go('home'), { 'data-testid': 'sell-order-cta' }));
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
    const payTx = o.unsureTxid || o.sentTxid ? wallet.state.txs.find((t) => t.txid === (o.unsureTxid || o.sentTxid)) || null : null;
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
    titleEl.textContent = unpaid && !testOnly && !following && !elsewhere ? `Send ${firoText(o.amount)}` : 'Sell FIRO';
    const pollError = c.pollError(id);
    put(
      body,
      o.sandbox ? notice('info', h('span', { 'data-testid': 'sell-test-mode', text: testOnly ? "buyfiro.app's test mode: nothing to pay." : "buyfiro.app's test mode: nothing is sold." })) : null,
      uncertain ? h('div', { 'data-testid': 'sell-interrupted' }, notice('warn', h('strong', { text: `A payment for this sell started at ${untilText(o.sendStartedAt).replace(/ today$/, '')}, and Campfire can't tell whether it left. ` }), 'Look in Activity first: if it is there, there is nothing more to do.')) : null,
      following ? h('div', { 'data-testid': 'sell-unsure', 'data-txid': o.unsureTxid }, notice('warn', h('strong', { text: `${UNSURE_TITLE} ` }), `The Firo node didn't answer when your ${firoText(o.amount)} went out. Follow it in Activity: once it is in a block, buyfiro.app takes it and this sell goes on by itself. If the Firo network turns out not to have it, Campfire says so here once two Firo nodes confirm they do not have it, and you can send it again.`)) : null,
      following ? offer : null,
      elsewhere ? h('div', { 'data-testid': 'sell-paid-elsewhere' }, notice('info', h('strong', { text: 'You paid this sell from another wallet. ' }), "buyfiro.app shows it here once it arrives, usually a few minutes after its first block. Campfire won't offer to pay it from this wallet.")) : null,
      goneNote && unpaid && !following
        ? h(
            'div',
            { 'data-testid': 'sell-unsure-gone', 'data-let-go': String(goneNote === 'let-go') },
            notice('info', goneNote === 'let-go' ? 'You let your earlier payment go on the word of the Firo node in use: its FIRO is back in your balance. If it did leave, buyfiro.app shows it here once it arrives, and sending it again would pay twice.' : "Your earlier payment didn't go through: the Firo network doesn't have it, and its FIRO is back in your balance. You can send it again."),
          )
        : null,
      stateNotice(o, s, s === 'expired' || s === 'refused' ? claimed : paid),
      following ? null : offer,
      ...(unpaid && !uncertain && !following && !elsewhere && !testOnly ? payment(o) : []),
      steps(o, s, paid),
      details(o, s, paid),
      // Not in the backup file (FM-6): said while it matters.
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'sell-keep-order', text: KEEP_ORDER_TEXT }) : null,
      s === 'delivered' ? payoutLink(o) : null,
      o.isOpen ? h('p', { class: 'small', 'data-testid': 'sell-can-leave', text: 'You can leave this screen or close Campfire: once your FIRO is sent the sell keeps going, and the payout arrives even while Campfire is closed.' }) : null,
      pollError && o.isOpen ? h('p', { class: 'small', 'data-testid': 'sell-poll-error', text: pollError.unreachable ? "Couldn't reach buyfiro.app just now. Campfire keeps checking." : "buyfiro.app's last answer didn't make sense. Campfire keeps checking." }) : null,
    );

    const support = (label = 'Contact buyfiro.app support') => h('a', { class: 'btn btn-primary', href: sellSiteUrl(), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'sell-order-cta' }, label);
    const home = () => primary('Back to your wallet', () => app.go('home'), { 'data-testid': 'sell-order-cta' });
    if (following) {
      put(actions, primary('Follow it in Activity', () => app.go('activity', { txid: o.unsureTxid }), { 'data-testid': 'sell-order-cta' }));
    } else if (elsewhere) {
      put(actions, primary('Back to your wallet', () => app.go('home'), { 'data-testid': 'sell-order-cta' }), textButton("I haven't paid it: undo", notPaidElsewhere, { 'data-testid': 'sell-paid-elsewhere-undo' }));
    } else if (unpaid && uncertain) {
      put(actions, primary('Open Activity', () => app.go('activity'), { 'data-testid': 'sell-order-cta' }), textButton(`It isn't there: send ${firoText(o.amount)}`, () => ((retryOk = true), render()), { 'data-testid': 'sell-pay-anyway' }));
    } else if (unpaid && !testOnly) {
      const why = busy ? null : payReason(o);
      const cta = primary(sending ? sendingText : busy ? 'Sending…' : `Send ${firoText(o.amount)} to buyfiro.app`, pay, { 'data-testid': 'sell-order-cta', disabled: busy || why !== null });
      cta.dataset.action = 'pay';
      const other = payFrom === 'private' ? 'public' : 'private';
      const fix = pq.error && pq.error.code === 'insufficient' && wallet.available(other) > o.amount ? textButton(`Pay from ${other} instead`, () => ((payFrom = other), render()), { 'data-testid': 'sell-pay-other' }) : null;
      put(actions, why ? h('p', { class: 'hint center', 'data-testid': 'sell-pay-reason', text: why }) : null, cta, fix);
    } else if (s === 'delivered') {
      const ethSide = o.payout.own && WALLET_CHAINS.includes(o.payout.chainId) && app.has('ethHome');
      put(actions, ethSide ? primary('Open your Ethereum & BNB wallet', () => app.go('ethHome'), { 'data-testid': 'sell-order-cta' }) : home(), ethSide ? textButton('Back to your wallet', () => app.go('home'), { 'data-testid': 'sell-order-home' }) : null);
    } else if ((s === 'expired' || s === 'refused') && !claimed) {
      put(actions, primary('Start a new sell', () => app.go('sellFiro', {}, { replace: true }), { 'data-testid': 'sell-order-cta' }));
    } else if (s === 'expired' || s === 'refused' || s === 'attention') {
      put(actions, support());
    } else {
      put(actions, home(), paid && paid.txid ? textButton('See your payment', () => app.go('activity', { txid: paid.txid }), { 'data-testid': 'sell-order-see' }) : null);
    }
    root.dataset.state = s;
    root.dataset.paid = String(Boolean(paid));
  }

  const el = screen({ title: 'Sell FIRO', back: () => app.back(params.from === 'list' ? 'sellOrders' : 'home'), actions: [actions], cls: 'sell-order sticky-actions' }, body);
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
