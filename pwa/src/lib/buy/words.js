// What the Buy FIRO screens say: dollars and FIRO the way people read them,
// how long a buy usually takes, the smallest buy in the coin being paid with,
// every way buyfiro.app can say no (in plain words, never the person's fault,
// each with the one thing that fixes it), and a buy's four steps.

import { BuyAmount } from './buyfiro.js';
import { compactUnits } from '../compact.js';

/** "$1,000", "$1,497.27", "$5". */
export function usd(v) {
  const whole = v >= 1000 || v === Math.round(v);
  const cents = Math.round(v * 100);
  const dollars = whole ? Math.round(v) : Math.trunc(cents / 100);
  const g = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole) return `$${g}`;
  return `$${g}.${String(cents % 100).padStart(2, '0')}`;
}

/** The estimate buyfiro.app gave (FIRO, a number) in satoshi (1e-8 FIRO). */
export function sats(firo) {
  return BigInt(Math.round(firo * 1e8));
}

/** "1,668.69 FIRO" from satoshi. */
export function firoText(s) {
  return `${compactUnits(s, 8)} FIRO`;
}

/** "1,113 FIRO": whole FIRO from a thousand up, for a list. */
export function firoShort(firo) {
  return firo >= 1000 ? `${String(Math.floor(firo)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} FIRO` : firoText(sats(firo));
}

/** "Usually done in about 14 minutes" (rounded up; "a few minutes" under three). */
export function etaText(seconds) {
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 3) return 'Usually done in a few minutes';
  if (minutes < 90) return `Usually done in about ${minutes} minutes`;
  return `Usually done in about ${Math.ceil(minutes / 60)} hours`;
}

/**
 * The amount of `asset` worth at least minimumUsd (a little over, so a moving
 * price does not put it back under), rounded up to three significant digits,
 * and one buyfiro.app reads exactly; null without a price.
 */
export function minimumAmount(minimumUsd, asset, { priceUsd = null } = {}) {
  const price = priceUsd ?? asset.priceUsd;
  if (!price || price <= 0 || minimumUsd <= 0) return null;
  const value = (minimumUsd * 1.005) / price;
  const exponent = Math.floor(Math.log(value) / Math.LN10);
  const maxPlaces = BuyAmount.maxFractionDigits(asset.decimals);
  const places = Math.min(Math.max(0, 2 - exponent), maxPlaces);
  const step = 10 ** -places;
  let units = Math.ceil(value / step);
  for (let i = 0; i < 20; i++, units++) {
    const text = (units * step).toFixed(places);
    const a = BuyAmount.parse(text, asset.decimals).amount;
    if (a && a.isPositive && a.exact) return a.text;
  }
  return null;
}

function later(ms) {
  if (ms == null || ms < 5000) return 'Try again in a moment.';
  const s = Math.round(ms / 1000);
  if (s < 90) return `Try again in ${s} seconds.`;
  return `Try again in ${Math.ceil(s / 60)} minutes.`;
}

/**
 * The error `e` as the form shows it → {title, detail, fix, fixLabel, serious, smaller?}.
 * smaller: the amount is under this route's floor; the form also offers the way
 * this wallet buys smaller amounts.
 * fix: 'useMinimum' | 'editAmount' | 'pickCoin' | 'editRefund' | 'tryAgain' | 'contactSupport'.
 * minimum: the smallest buy in the coin ("0.0122"), when it could be worked out.
 */
export function problemText(e, { coin, minimum = null }) {
  const sym = coin.symbol;
  const p = (title, detail, fix, fixLabel, serious = false) => ({ title, detail, fix, fixLabel, serious });
  switch (e.code) {
    case 'amount_below_upstream_minimum': {
      // The route's own floor, as buyfiro.app gave it (error.minimum_usd): never a number of the app's.
      const usdText = e.minimumUsd == null ? null : usd(e.minimumUsd);
      const title = usdText ? `This route starts at about ${usdText}` : 'This is under the smallest buy';
      if (minimum) return { ...p(title, `That is about ${minimum} ${sym}. Nothing was sent.`, 'useMinimum', `Use ${minimum} ${sym}`), smaller: true };
      return { ...p(title, 'Nothing was sent.', 'editAmount', 'Change the amount'), smaller: true };
    }
    case 'amount_below_our_minimum': {
      const usdText = e.minimumUsd == null ? null : usd(e.minimumUsd);
      if (minimum) return p(`Buy at least ${minimum} ${sym}${usdText ? ` (${usdText})` : ''}`, "That's the smallest buy buyfiro.app can do. Nothing was sent.", 'useMinimum', `Use ${minimum} ${sym}`);
      return p(usdText ? `Buy at least ${usdText} of ${sym}` : 'This is under the smallest buy', "That's the smallest buy buyfiro.app can do. Nothing was sent.", 'editAmount', 'Change the amount');
    }
    case 'bad_amount':
    case 'amount_too_small':
      return p(`buyfiro.app can't use this amount of ${sym}`, 'It is too small to send. Nothing was sent.', 'editAmount', 'Change the amount');
    case 'unknown_asset':
      return p(`buyfiro.app no longer takes ${sym} on ${coin.chainName}`, 'Pick another coin. Nothing was sent.', 'pickCoin', 'Pick another coin');
    case 'asset_unavailable':
      return p(`${sym} on ${coin.chainName} can't be used right now`, 'buyfiro.app has paused it for a while. Pick another coin, or try again later. Nothing was sent.', 'pickCoin', 'Pick another coin');
    case 'no_liquidity':
      return p(`buyfiro.app can't take this much ${sym} right now`, 'Try a smaller amount or another coin. Nothing was sent.', 'editAmount', 'Change the amount');
    case 'refund_address_required':
      return p(`Add your ${coin.chainName} address`, `Your ${sym} goes back there if the buy can't go through. Nothing was sent.`, 'editRefund', 'Add the address');
    case 'firo_wallet_required':
    case 'firo_wallet_too_short':
    case 'firo_wallet_too_long':
    case 'firo_wallet_invalid':
    case 'firo_wallet_is_evm':
      return p("buyfiro.app didn't take your wallet's new FIRO address", 'This is not something you did. Nothing was sent. Try again: Campfire makes another one.', 'tryAgain', 'Try again');
    case 'firo_wallet_unpayable':
      return p("buyfiro.app can't pay this kind of FIRO address right now", 'This is not something you did. Nothing was sent. Try again: Campfire makes another address.', 'tryAgain', 'Try again');
    case 'destination_unverifiable':
      return p("buyfiro.app can't check your FIRO address right now", `This is not something you did, and nothing was sent. ${later(e.retryAfterMs)}`, 'tryAgain', 'Try again');
    case 'asset_id_required':
    case 'bad_body':
      return p("buyfiro.app couldn't read Campfire's request", 'This is not something you did. Nothing was sent.', 'tryAgain', 'Try again');
    case 'order_not_found':
      return p("buyfiro.app can't find this buy", 'If you already paid, contact buyfiro.app support with the deposit address.', 'contactSupport', 'Contact buyfiro.app support', true);
    case 'price_unavailable':
    case 'upstream_absent':
    case 'upstream_unavailable':
    case 'quote_failed':
      return p("buyfiro.app can't price this right now", `This is not something you did, and nothing was sent. ${later(e.retryAfterMs)}`, 'tryAgain', 'Try again');
    case 'no_deposit_address':
      return p("buyfiro.app didn't give a deposit address", 'Nothing to pay, and nothing was sent. Try again.', 'tryAgain', 'Try again');
    case 'blocked':
    case 'network': {
      const server = (e.httpStatus ?? 0) >= 500;
      return p("Couldn't reach buyfiro.app", ['Nothing was sent.', server && !coin.isEvm ? `If it keeps happening, check that your ${coin.chainName} address is right.` : null].filter(Boolean).join(' '), 'tryAgain', 'Try again');
    }
    case 'unexpected_answer':
      return p("buyfiro.app sent an answer Campfire didn't expect. Nothing to pay.", 'This is not something you did. Try again in a moment.', 'tryAgain', 'Try again', true);
    case 'wrong_deposit_address':
      return p(`buyfiro.app's deposit address isn't a ${coin.chainName} address, so it isn't shown`, `${sym} sent to it would be lost. Nothing to pay, and nothing was sent. This is not something you did. Try again in a moment.`, 'tryAgain', 'Try again', true);
    default:
      return p("buyfiro.app couldn't do this buy", 'Nothing was sent. Try again, or pick another coin.', 'tryAgain', 'Try again');
  }
}

/** One line for a buy in a list: where it is, in plain words. */
export function stateLine(order) {
  switch (order.lastState) {
    case null:
    case undefined:
    case 'awaiting_deposit':
      return 'Waiting for your payment';
    case 'deposit_detected':
      return 'Payment received';
    case 'sending':
      return 'Sending FIRO to your wallet';
    case 'delivered':
      return 'FIRO sent to your wallet';
    case 'refunded':
      return 'Sent back to you';
    case 'expired':
      return 'No payment arrived in time';
    case 'failed':
      return "The payment couldn't be processed";
    case 'attention':
      return 'buyfiro.app is checking it';
    default:
      return 'Buying your FIRO';
  }
}

/**
 * The four steps of a buy, from where it is → [{label, mark, note}], mark
 * 'done' | 'active' | 'waiting' | 'failed'. Never more than four. arrived: the
 * wallet has the FIRO buyfiro.app sent ('delivered' alone means it was sent).
 */
export function buySteps(state, { arrived = false } = {}) {
  const s = state || 'awaiting_deposit';
  const buying = ['deposit_detected', 'swapping', 'buying', 'processing', 'in_progress', 'attention'].includes(s);
  const bought = s === 'sending' || s === 'delivered';
  const first =
    s === 'awaiting_deposit'
      ? { label: 'Waiting for your payment', mark: 'active' }
      : s === 'expired'
        ? { label: 'No payment arrived in time', mark: 'failed' }
        : s === 'failed'
          ? { label: "The payment couldn't be processed", mark: 'failed' }
          : { label: 'Payment received', mark: 'done', note: s === 'deposit_detected' ? 'being confirmed' : null };
  return [
    { note: null, ...first },
    { label: s === 'refunded' ? "Your FIRO couldn't be bought" : 'Buying your FIRO', mark: s === 'refunded' ? 'failed' : bought ? 'done' : buying ? 'active' : 'waiting', note: null },
    { label: 'Sending FIRO to your wallet', mark: s === 'delivered' ? 'done' : s === 'sending' ? 'active' : 'waiting', note: null },
    s === 'delivered' && !arrived ? { label: 'Arriving in your public balance', mark: 'active', note: null } : { label: 'Arrived in your public balance', mark: s === 'delivered' ? 'done' : 'waiting', note: null },
  ];
}

/** One line on why buyfiro.app gave no usable answer: what the browser saw, to pass on if it keeps happening. */
export function whyUnreachable(e) {
  if (!e) return '';
  if (e.code === 'network') return e.cause === 'timeout' ? 'Details: no answer within a minute.' : `Details: no answer (${e.cause || 'the request did not get through'}).`;
  if (e.code === 'blocked') return `Details: a web page came back instead of buyfiro.app's data${e.httpStatus ? ` (HTTP ${e.httpStatus})` : ''}; something on the way may be blocking it.`;
  return `Details: ${(e && e.message) || e}`;
}

/**
 * A buy's handle at buyfiro.app (its deposit address) is kept on this device only: the backup
 * file carries the wallet's words, not its buys (release audit FM-6). Said while it is open.
 */
export const KEEP_BUY_ORDER_TEXT = 'Keep this order (tap it to copy) until your FIRO arrives: it is on this device only, not in your backup file, and buyfiro.app support asks for it.';
