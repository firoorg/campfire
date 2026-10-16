// What the "Pay with BTC, ZEC or LTC" screens say, with no DOM, so it can be
// tested: how long a swap takes, where a swap is (in words, with its steps),
// every way 1Click can say no (in plain words, never the person's fault, each
// with the one thing that fixes it), who sees what, and how much of the coin
// that arrived (ETH or BNB) to swap to rsFIRO. Ports of the desktop app's
// near_intents_view.dart / near_intents_deposit_view.dart wording.
// NEAR Intents lists neither FIRO nor rsFIRO (2026-10): ETH or BNB arrives,
// then a swap in this wallet makes it rsFIRO (Uniswap rsFIRO/WETH on
// Ethereum, PancakeSwap rsFIRO/WBNB on BNB Chain).

import { minimumFromMessage, usdMinimumFromMessage, unitsAboveUsd, destinationChainOf } from './oneclick.js';
import { CHAINS } from '../eth/chains.js';

/** What a swap delivers: {coin: 'ETH' | 'BNB', chain: the wallet chain}, from its quote. */
export function deliveryOf(swap) {
  const key = (swap && swap.quote && destinationChainOf(swap.quote.destinationAsset)) || 'ethereum';
  const chain = CHAINS[key];
  return { coin: chain.native.symbol, chain };
}
import { exactUnits } from '../compact.js';

/** "$1,240", "$12.34": dollars as people read them (whole from $1,000 up). */
export function usd(v) {
  const whole = v >= 1000 || v === Math.round(v);
  const cents = Math.round(v * 100);
  const dollars = whole ? Math.round(v) : Math.trunc(cents / 100);
  const g = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole) return `$${g}`;
  return `$${g}.${String(cents % 100).padStart(2, '0')}`;
}

/** "45 seconds", "14 minutes", "1.5 hours" (the desktop app's _duration). */
export function durationText(seconds) {
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05 today" or "14:05 on 9 Oct" (as the Buy screens say it). */
export function untilText(ms, now = Date.now()) {
  const t = new Date(ms);
  const n = new Date(now);
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (t.toDateString() === n.toDateString()) return `${hm} today`;
  return `${hm} on ${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

/** "0.00012 BTC": every digit of what is sent (it must be sent exactly). */
export function sendText(swap) {
  return `${exactUnits(swap.quote.amountIn, swap.origin.decimals)} ${swap.origin.symbol}`;
}

/** Who learns what when the person uses this screen. */
export function whoSees(host) {
  return `NEAR Intents (${host}) sees your IP address, the coin and amount, your refund address and this wallet's address on Ethereum and BNB Chain. Not your Firo wallet, and never a key.`;
}

/** The fees in the quote, as the difference between what is sent and what arrives, in dollars: {usd, share} or null. */
export function feeShare(q) {
  if (q.amountInUsd == null || q.amountOutUsd == null || !(q.amountInUsd > 0)) return null;
  const d = Math.max(0, q.amountInUsd - q.amountOutUsd);
  return { usd: d, share: d / q.amountInUsd };
}

/** "about $0.11 (1.1%)" or "less than $0.01". */
export function feeText(q) {
  const f = feeShare(q);
  if (!f) return null;
  if (f.usd < 0.01) return 'less than $0.01';
  const pct = f.share * 100;
  return `about ${usd(Math.round(f.usd * 100) / 100)} (${pct < 0.1 ? '< 0.1' : pct.toFixed(1)}%)`;
}

/** Nothing was paid and the time asked for has passed: the price no longer holds, the address should not be paid. */
export function isExpired(swap, now = Date.now()) {
  const unpaid = swap.lastState == null || swap.lastState === 'PENDING_DEPOSIT';
  return unpaid && swap.quote.sendBefore != null && now > swap.quote.sendBefore;
}

/** One line for an unfinished swap in a list. */
export function stateLine(swap, now = Date.now()) {
  const amount = sendText(swap);
  if (isExpired(swap, now)) return `No ${swap.origin.symbol} arrived in time`;
  switch (swap.lastState) {
    case 'KNOWN_DEPOSIT_TX':
    case 'PROCESSING':
      return `Swapping your ${amount} into ${deliveryOf(swap).coin}…`;
    case 'INCOMPLETE_DEPOSIT':
      return `Less than ${amount} arrived`;
    case 'SUCCESS':
      return `Your ${deliveryOf(swap).coin} is in this wallet`;
    case 'REFUNDED':
      return `Sent back to your ${swap.origin.chainName} address`;
    case 'FAILED':
      return 'The swap failed';
    default:
      return `Waiting for your ${amount}`;
  }
}

/** Waiting for the deposit: the address is the thing on screen. */
export function isWaiting(state) {
  return state == null || state === 'PENDING_DEPOSIT' || state === 'INCOMPLETE_DEPOSIT';
}

/**
 * The status notice for a state → {kind, key, title, detail}. got: the wei
 * that arrived (SUCCESS), when 1Click said.
 */
export function statusWords(swap, { got = null, ethText = (w) => `${w} wei`, now = Date.now() } = {}) {
  const amount = sendText(swap);
  const { coin, chain } = deliveryOf(swap);
  if (isExpired(swap, now)) return { kind: 'warn', key: 'expired', title: 'The time for this price has passed.', detail: "Don't send to this address any more: a deposit now may be sent back to your refund address. If you already sent it, this screen shows it as soon as NEAR Intents sees it." };
  switch (swap.lastState) {
    case 'KNOWN_DEPOSIT_TX':
      return { kind: 'info', key: 'seen', title: 'Deposit seen.', detail: `Waiting for the ${swap.origin.chainName} network to confirm it.` };
    case 'PROCESSING':
      return { kind: 'info', key: 'processing', title: `Swapping into ${coin}…`, detail: `The ${coin} arrives in this wallet on ${chain.name} when it is done.` };
    case 'SUCCESS':
      return { kind: 'success', key: 'success', title: got == null ? `Your ${coin} is in this wallet.` : `${ethText(got)} arrived in this wallet.`, detail: `Swap it to rsFIRO (FIRO on ${chain.name}) now, or keep it as ${coin}.` };
    case 'INCOMPLETE_DEPOSIT':
      return { kind: 'warn', key: 'incomplete', title: `Less than ${amount} arrived.`, detail: 'Send the rest to the same address before the time below, or the deposit goes back to your refund address.' };
    case 'REFUNDED':
      return { kind: 'warn', key: 'refunded', title: `Sent back to your ${swap.origin.chainName} address.`, detail: swap.refundReason ? `NEAR Intents said: "${swap.refundReason}". There is nothing else to do.` : 'The swap could not be done, so your coins went back. There is nothing else to do.' };
    case 'FAILED':
      return { kind: 'error', key: 'failed', title: 'The swap failed.', detail: 'NEAR Intents could not complete it. Look the deposit address up on its explorer; refunds go to your refund address.' };
    default:
      return { kind: 'info', key: 'waiting', title: 'Waiting for your deposit.', detail: 'Send it from any wallet or exchange. This screen updates by itself; you can close it and come back.' };
  }
}

/**
 * The three steps of a swap → [{label, mark}], mark 'done' | 'active' |
 * 'waiting' | 'failed'.
 */
export function swapSteps(state, { expired = false, coin = 'ETH' } = {}) {
  const s = state || 'PENDING_DEPOSIT';
  if (expired) return [{ label: 'No deposit arrived in time', mark: 'failed' }, { label: `Swapping into ${coin}`, mark: 'waiting' }, { label: `${coin} in this wallet`, mark: 'waiting' }];
  const paid = !['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT'].includes(s);
  const swapping = s === 'KNOWN_DEPOSIT_TX' || s === 'PROCESSING';
  return [
    { label: s === 'INCOMPLETE_DEPOSIT' ? 'Part of your deposit arrived' : paid ? 'Deposit received' : 'Waiting for your deposit', mark: paid ? 'done' : 'active' },
    { label: s === 'REFUNDED' ? 'Sent back to you' : s === 'FAILED' ? 'The swap failed' : `Swapping into ${coin}`, mark: s === 'REFUNDED' || s === 'FAILED' ? 'failed' : s === 'SUCCESS' ? 'done' : swapping ? 'active' : 'waiting' },
    { label: `${coin} in this wallet`, mark: s === 'SUCCESS' ? 'done' : 'waiting' },
  ];
}

/**
 * The error `e` (OneClickError) as the form shows it → {kind, title, detail,
 * fix, fixLabel, minimum}. fix: 'tryAgain' | 'editAmount' | 'editRefund' |
 * 'pickCoin' | 'useMinimum' | 'update'. coin: the coin being paid with.
 */
export function problemWords(e, { coin, amountText = null, into = 'ETH' } = {}) {
  const sym = coin ? coin.symbol : 'this coin';
  const chain = coin ? coin.chainName : 'its chain';
  const p = (kind, title, detail, fix, fixLabel, extra = {}) => ({ kind, title, detail, fix, fixLabel, minimum: null, ...extra });
  const said = (e && e.said) || '';
  switch (e && e.code) {
    case 'refused': {
      if (/refund.*not valid|invalid refund/i.test(said)) return p('warn', `That isn't a ${chain} address.`, `Check your refund address: your ${sym} goes back there if the swap can't happen. Nothing was sent.`, 'editRefund', 'Check the address');
      if (/no liquidity/i.test(said)) return p('warn', `NEAR Intents can't swap ${sym} into ${into} right now.`, 'No one is offering this swap at the moment. Try again in a few minutes, a larger amount, or another coin. Nothing was sent.', 'tryAgain', 'Try again');
      const min = minimumFromMessage(said);
      if (min !== null && coin) return p('warn', `Send at least ${exactUnits(min, coin.decimals)} ${sym}.`, "That's the smallest amount NEAR Intents swaps. Nothing was sent.", 'useMinimum', `Use ${exactUnits(min, coin.decimals)} ${sym}`, { minimum: min });
      const usdMin = usdMinimumFromMessage(said);
      if (usdMin !== null) {
        const units = unitsAboveUsd(usdMin, coin);
        const title = `NEAR Intents swaps ${usd(usdMin)} or more right now.`;
        if (units !== null) return p('warn', title, `That's their smallest swap for the moment. About ${exactUnits(units, coin.decimals)} ${sym} is enough. Nothing was sent.`, 'useMinimum', `Use ${exactUnits(units, coin.decimals)} ${sym}`, { minimum: units });
        return p('warn', title, `That's their smallest swap for the moment. Enter at least ${usd(usdMin)} worth of ${sym}. Nothing was sent.`, 'editAmount', 'Change the amount');
      }
      if (/failed to get quote|too (low|small)/i.test(said)) return p('warn', `NEAR Intents can't price ${amountText || 'this amount'}.`, 'It may be too small to swap. Try a larger amount. Nothing was sent.', 'editAmount', 'Change the amount');
      return p('warn', 'NEAR Intents would not price this.', `It said: "${said || 'no reason given'}". Check the amount and the refund address. Nothing was sent.`, 'editAmount', 'Change the amount');
    }
    case 'busy':
      return p('warn', 'NEAR Intents is busy.', 'This is not something you did, and nothing was sent. Try again in a minute.', 'tryAgain', 'Try again');
    case 'cannot_verify':
      return p('error', "This browser can't check NEAR Intents' signature.", 'Without that check no deposit address is shown. Update the browser (iOS 17 or newer) and try again. Nothing was sent.', 'tryAgain', 'Try again');
    case 'stale':
      return p('error', 'NEAR Intents sent an old price, so no address is shown.', "This is not something you did, and nothing was sent. Try again; if it keeps happening, check this device's date and time.", 'tryAgain', 'Try again');
    case 'unsigned':
    case 'mismatch':
    case 'no_address':
    case 'unexpected':
      return p('error', "NEAR Intents' answer didn't check out, so no address is shown.", 'This is not something you did, and nothing was sent. Try again in a moment.', 'tryAgain', 'Try again');
    default:
      return p('error', "Couldn't reach NEAR Intents.", 'This is not something you did, and nothing was sent.', 'tryAgain', 'Try again');
  }
}

/** ETH kept for the rsFIRO swap's own network fee: 0.0005 ETH (on BNB Chain, 0.0005 BNB: fees there are far lower). */
export const KEEP_FOR_GAS = 5n * 10n ** 14n;
export const KEEP_FOR_GAS_BY_CHAIN = Object.freeze({ ethereum: KEEP_FOR_GAS, bsc: 5n * 10n ** 14n });

/** How much of the coin that arrived to swap to rsFIRO: all but the gas reserve, or half when it is small. */
export function swapSpend(arrived, chainKey = 'ethereum') {
  if (typeof arrived !== 'bigint' || arrived <= 0n) return 0n;
  const keep = KEEP_FOR_GAS_BY_CHAIN[chainKey] ?? KEEP_FOR_GAS;
  return arrived > keep * 2n ? arrived - keep : arrived / 2n;
}
