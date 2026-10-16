// The Uniswap screens' words (screens/eth_swap*.js), with no DOM, so they can
// be tested: amounts, the rate, a pool's fee, a route as people read it.
// Ports of the desktop app's lib/pages/eth/uniswap/uniswap_format.dart and
// uniswap_widgets.dart (uniRouteText, uniRouteNote).
import { shorten } from '../dom.js';
import { compactUnits, compactRatio, exactUnits } from '../compact.js';
import { NATIVE_ETH, WETH } from './uniswap/constants.js';
import { UniV4Pool } from './uniswap/models.js';
import { TOKENS } from './tokens.js';

export const amt = (v, t) => `${exactUnits(v, t.decimals)} ${t.symbol}`;

/** Shown places for a token with more than 8 decimals (ETH): 8, as the wallet shows ETH. */
const SHOWN = 8;

/**
 * An amount as a screen shows it: every digit up to 8 decimals; beyond that
 * rounded down to 8, with "≈" unless it is a floor ("at least" stays true
 * rounded down).
 */
export function amtShown(v, t, { floor = false } = {}) {
  if (t.decimals <= SHOWN) return amt(v, t);
  const cut = 10n ** BigInt(t.decimals - SHOWN);
  const down = (v / cut) * cut;
  return `${down === v || floor ? '' : '≈'}${amt(down, t)}`;
}
export const short = (v, t) => `${compactUnits(v, t.decimals)} ${t.symbol}`;
export const ethAbout = (wei) => `${compactUnits(wei, 18)} ETH`;
/** An "at most" figure, rounded up at 8 places, so the limit is never understated. */
export function ethAtMost(wei) {
  const cut = 10n ** 10n;
  const up = wei % cut === 0n ? wei : wei + (cut - (wei % cut));
  return `${exactUnits(up, 18)} ETH`;
}
/** 100 → "1%", 50 → "0.5%". */
export const bipsText = (b) => `${b / 100}%`;
/** A pool's fee: 3000 → "0.3%", 100 → "0.01%", null → "set by its hook". */
export function feeText(hundredthsOfBip) {
  if (hundredthsOfBip == null) return 'set by its hook';
  return `${(hundredthsOfBip / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** "1 ETH ≈ 2,411.08 rsFIRO". */
export function rateText(q) {
  const num = q.amountOut * 10n ** BigInt(q.tokenIn.decimals);
  const den = q.amountIn * 10n ** BigInt(q.tokenOut.decimals);
  return den === 0n ? '' : `1 ${q.tokenIn.symbol} ≈ ${compactRatio(num, den)} ${q.tokenOut.symbol}`;
}

function symbolOf(q, currency) {
  if (currency === NATIVE_ETH) return 'ETH';
  if (currency === q.tokenIn.address) return q.tokenIn.symbol;
  if (currency === q.tokenOut.address) return q.tokenOut.symbol;
  const t = TOKENS.find((x) => x.address === currency);
  const s = currency === WETH ? 'WETH' : t ? t.symbol : shorten(currency, 6, 4);
  // ETH ⇄ WETH conversions on the way are the router's own; keep "ETH".
  return s === 'WETH' && !q.tokenIn.isWeth && !q.tokenOut.isWeth ? 'ETH' : s;
}

const poolWords = (p) => `${p.version} · ${feeText(p.fee)}${p instanceof UniV4Pool && p.hasHooks ? ' · hook' : ''}`;
const poolsOfRoute = (r, then = ', then ') => r.hops.map((x) => poolWords(x.pool)).join(then);

/** The route in words: "ETH → rsFIRO" for one route; "Split over 3 pools" when the swap is shared. */
export function routeText(q) {
  if (q.isSplit) return `Split over ${q.parts.length} ${q.parts.every((p) => p.route.isDirect) ? 'pools' : 'routes'}`;
  const r = q.route;
  return [symbolOf(q, r.hops[0].currencyIn), ...r.hops.map((x) => symbolOf(q, x.currencyOut))].join(' → ');
}

/** "Uniswap v4 · 1%" for one route; for a shared swap each share: "70% v4 · 1%, 30% via USDC (…)". */
export function routeNote(q) {
  if (!q.isSplit) return `Uniswap ${poolsOfRoute(q.route)}`;
  const share = (p) => `${Math.max(1, Math.round(q.shareOf(p) * 100))}%`;
  return q.parts.map((p) => (p.route.isDirect ? `${share(p)} ${poolsOfRoute(p.route)}` : `${share(p)} via ${p.route.hops.slice(1).map((x) => symbolOf(q, x.currencyIn)).join(', ')} (${poolsOfRoute(p.route, ' then ')})`)).join(', ');
}

/** How many different pools the swap goes through ("Shared between 2 pools."). */
export function poolCount(q) {
  return new Set(q.pools.map((p) => p.id)).size;
}

