// What the Sell FIRO screens say: FIRO and dollars the way people read them,
// the payout in words ("USDT on BNB Chain"), the smallest and largest sell,
// every way buyfiro.app can say no (in plain words, never the person's fault,
// each with the one thing that fixes it), a sell's three steps, and each
// state in one line. Never a cost of buyfiro.app's: only what the person
// receives (the rule for Buy and Sell).

import { formatAmount, UNIT } from '../amount.js';
import { usd, whyUnreachable } from '../buy/words.js';
import { WALLET_CHAINS } from './sellfiro.js';

export { usd, whyUnreachable };

/** "500 FIRO", "1,234.5 FIRO": every digit the person typed. */
export function firoText(sats) {
  return `${formatAmount(sats)} ${UNIT}`;
}

/** A FIRO figure from buyfiro.app (a number) as people read it: "300", "9,691.8". */
export function firoFigure(v) {
  return formatAmount(BigInt(Math.round(v * 1e8)), { maxDecimals: 2 });
}

/** The smallest sell, rounded up to whole FIRO (what "Use …" fills in), as text for the field. */
export function minimumAmountText(minimumFiro) {
  return String(Math.ceil(minimumFiro));
}

/** The largest sell, rounded down to whole FIRO (a moving price keeps it under), as text for the field. */
export function maximumAmountText(maximumFiro) {
  return String(Math.floor(maximumFiro));
}

/** "USDT on BNB Chain". */
export function payoutText(payout) {
  return `${payout.symbol} on ${payout.chainName}`;
}

/** "≈ $480 in USDT on BNB Chain". */
export function receiveText(receiveUsd, payout) {
  return `≈ ${usd(receiveUsd)} in ${payoutText(payout)}`;
}

/** Said when a payout goes to this wallet's address on a chain its Ethereum & BNB wallet does not show. */
export function otherChainNote(payout) {
  if (!payout.own || WALLET_CHAINS.includes(payout.chainId)) return null;
  return `Campfire's Ethereum & BNB wallet shows Ethereum and BNB Chain only. ${payout.chainName} pays to the same address: you will see it in a wallet that shows ${payout.chainName}.`;
}

function later(ms) {
  if (ms == null || ms < 5000) return 'Try again in a moment.';
  const s = Math.round(ms / 1000);
  if (s < 90) return `Try again in ${s} seconds.`;
  return `Try again in ${Math.ceil(s / 60)} minutes.`;
}

/**
 * The error `e` as the form shows it → {title, detail, fix, fixLabel, serious}.
 * fix: 'useMinimum' | 'useMaximum' | 'editAmount' | 'editPayout' | 'editAddress' | 'payPublic' |
 *      'openExisting' | 'undoPaidElsewhere' | 'tryAgain' | 'contactSupport'.
 * minimum / maximum: the smallest / largest sell in FIRO when known (a number).
 * markedElsewhere: the open sell buyfiro.app keeps for this payout ('order_exists') is one this
 * wallet marked "I paid it from another wallet", and the mark can still be undone (R-9).
 */
export function problemText(e, { payout, minimum = null, maximum = null, markedElsewhere = false }) {
  const p = (title, detail, fix, fixLabel, serious = false) => ({ title, detail, fix, fixLabel, serious });
  const min = e.minimumFiro ?? minimum;
  const max = e.maximumFiro ?? maximum;
  switch (e.code) {
    case 'amount_below_minimum':
      if (min != null) return p(`Sell at least ${firoFigure(Math.ceil(min))} ${UNIT}`, "That's the smallest sell buyfiro.app can do right now. Nothing was sent.", 'useMinimum', `Use ${firoFigure(Math.ceil(min))} ${UNIT}`);
      return p('This is under the smallest sell', "buyfiro.app can't sell this little right now. Nothing was sent.", 'editAmount', 'Change the amount');
    case 'amount_above_maximum':
      if (max != null) return p(`Sell at most ${firoFigure(Math.floor(max))} ${UNIT} at a time`, "That's the largest single sell. Sell the rest in a second sell. Nothing was sent.", 'useMaximum', `Use ${firoFigure(Math.floor(max))} ${UNIT}`);
      return p('This is more than one sell can take', 'Try a smaller amount, and sell the rest in a second sell. Nothing was sent.', 'editAmount', 'Change the amount');
    case 'bad_amount':
      return p("buyfiro.app can't use this amount", 'Try a round amount, like 500. Nothing was sent.', 'editAmount', 'Change the amount');
    case 'payout_address_invalid':
      return p("buyfiro.app didn't take the payout address", 'Copy the address again, or pick another one. Nothing was sent.', 'editAddress', 'Change the address');
    case 'payout_token_invalid':
      return p(`buyfiro.app can't pay ${payout.symbol} on ${payout.chainName} right now`, 'Pick another token. Nothing was sent.', 'editPayout', 'Pick another token');
    case 'payout_chain_unsupported':
      return p(`buyfiro.app doesn't pay on ${payout.chainName} right now`, 'Pick another network. Nothing was sent.', 'editPayout', 'Pick another network');
    case 'spark_unavailable':
      return p('buyfiro.app takes public FIRO only right now', 'Pay from your public balance, or try again later. Nothing was sent.', 'payPublic', 'Pay from public');
    case 'order_exists':
      // buyfiro.app's open sell for this payout belongs to another wallet or device: paid from there only (X4).
      if (e.elsewhere && !markedElsewhere) return p('This payout address already has an open sell', "It was made from another wallet or device, so it isn't paid from this one: pay it from where you made it, or wait until it ends, then sell again. Nothing was sent.", 'editPayout', 'Use another payout address');
      if (markedElsewhere) return p(`You marked your open sell to this address${e.amountFiro != null ? ` (${firoFigure(e.amountFiro)} ${UNIT})` : ''} as paid from another wallet`, "buyfiro.app keeps one unpaid sell per payout address and hasn't seen FIRO for that one. If you haven't paid it, undo the mark and pay it here, or use another address. Nothing was sent.", 'undoPaidElsewhere', "I haven't paid it: undo");
      return p(`You already have an open sell to this address${e.amountFiro != null ? ` (${firoFigure(e.amountFiro)} ${UNIT})` : ''}`, 'buyfiro.app keeps one unpaid sell per payout address. Pay that one, or use another address; an unpaid sell ends by itself after a day. Nothing was sent.', 'openExisting', 'Open that sell');
    case 'rate_limited':
      return p('buyfiro.app takes a few new sells an hour from one connection', `This is not something you did, and nothing was sent. ${later(e.retryAfterMs)}`, 'tryAgain', 'Try again');
    case 'price_unavailable':
    case 'unavailable':
      return p("buyfiro.app can't price this right now", `This is not something you did, and nothing was sent. ${later(e.retryAfterMs)}`, 'tryAgain', 'Try again');
    case 'bad_body':
    case 'bad_deposit_kind':
    case 'bad_order_type':
    case 'bad_limit_price':
    case 'bad_limit_duration':
      return p("buyfiro.app couldn't read Campfire's request", 'This is not something you did. Nothing was sent.', 'tryAgain', 'Try again');
    case 'order_not_found':
      return p("buyfiro.app can't find this sell", 'If you already sent FIRO, contact buyfiro.app support with the order number.', 'contactSupport', 'Contact buyfiro.app support', true);
    case 'blocked':
    case 'network':
      return p("Couldn't reach buyfiro.app", 'Nothing was sent.', 'tryAgain', 'Try again');
    case 'unexpected_answer':
      return p("buyfiro.app sent an answer Campfire didn't expect. Nothing to pay.", 'This is not something you did. Try again in a moment.', 'tryAgain', 'Try again', true);
    default:
      return p("buyfiro.app couldn't do this sell", 'Nothing was sent. Try again.', 'tryAgain', 'Try again');
  }
}

/** One line for a sell in a list: where it is, in plain words. sent: this wallet paid it. */
export function stateLine(order, { sent = Boolean(order.sentTxid) } = {}) {
  const sym = order.payout.symbol;
  switch (order.lastState) {
    case null:
    case undefined:
    case 'awaiting_deposit':
      return sent ? 'Your FIRO is on its way to buyfiro.app' : 'Waiting for your FIRO';
    case 'deposit_detected':
      return 'buyfiro.app has your FIRO';
    case 'limit_open':
      return 'Waiting for your price';
    case 'paying_out':
      return `Sending ${sym} to you`;
    case 'delivered':
      return `${sym} sent to you`;
    case 'expired':
      return 'No FIRO arrived in time';
    case 'refused':
      return "buyfiro.app couldn't start it";
    case 'attention':
      return 'buyfiro.app is checking it';
    default:
      return 'Selling your FIRO';
  }
}

/**
 * The three steps of a sell, from where it is → [{label, mark, note}], mark
 * 'done' | 'active' | 'waiting' | 'failed'. sent: this wallet paid it; unsure: a payment of this
 * wallet may have left (the node didn't answer).
 */
export function sellSteps(state, { sent = false, unsure = false, symbol = 'USDT' } = {}) {
  const s = state || 'awaiting_deposit';
  // Held for review before this wallet paid it: nothing says buyfiro.app has any FIRO.
  const held = s === 'attention' && !sent;
  const first =
    s === 'awaiting_deposit' || held
      ? { label: sent ? 'Your FIRO is on its way to buyfiro.app' : unsure ? 'Your FIRO may be on its way to buyfiro.app' : held ? 'Waiting for your FIRO' : 'Send your FIRO', mark: 'active' }
      : s === 'expired'
        ? { label: 'No FIRO arrived in time', mark: 'failed' }
        : s === 'refused'
          ? { label: "buyfiro.app couldn't start this sell", mark: 'failed' }
          : { label: 'buyfiro.app has your FIRO', mark: 'done', note: s === 'deposit_detected' ? 'being confirmed' : null };
  const selling = ['selling', 'limit_open', 'in_progress', 'attention'].includes(s) && !held;
  const sold = s === 'paying_out' || s === 'delivered';
  return [
    { note: null, ...first },
    { label: s === 'limit_open' ? 'Waiting for your price' : sold ? 'FIRO sold' : 'Selling your FIRO', mark: sold ? 'done' : selling ? 'active' : 'waiting', note: null },
    { label: s === 'delivered' ? `${symbol} sent to you` : `Sending ${symbol} to you`, mark: s === 'delivered' ? 'done' : s === 'paying_out' ? 'active' : 'waiting', note: null },
  ];
}

/** "Your private balance" / "Your public balance". */
export function fromText(from) {
  return from === 'public' ? 'Your public balance' : 'Your private balance';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05 today" or "14:05 on 9 Oct" (this device's time zone). */
export function untilText(ms, now = Date.now()) {
  const t = new Date(ms);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (t.toDateString() === new Date(now).toDateString()) return `${hm} today`;
  return `${hm} on ${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

/**
 * The order number is a sell's only handle at buyfiro.app and is kept on this device only: the
 * backup file carries the wallet's words, not its sells (release audit FM-6: whether backups
 * should carry open orders is still open). Said while a sell is open.
 */
export const KEEP_ORDER_TEXT = 'Keep this order number (tap it to copy) until the payout arrives: it is on this device only, not in your backup file, and buyfiro.app support asks for it.';
