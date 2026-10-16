// Ethereum amounts: integers in the token's smallest unit (wei for ETH, 18
// decimals; WBTC 8; USDT and USDC 6), BigInt throughout, so what a
// person types reaches the transaction exactly.
//
// Display rounds DOWN (to 8 places by default): a balance is never shown as
// more than it is, and "Send all" never asks for a unit that isn't there.
// toInputString() gives the full precision for when the person taps it.

export const ETH_DECIMALS = 18;
export const DISPLAY_DECIMALS = 8;
export const WEI_PER_ETH = 10n ** 18n;
export const WEI_PER_GWEI = 10n ** 9n;
export const MAX_UINT256 = (1n << 256n) - 1n;

export class UnitsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'empty' | 'negative' | 'format' | 'precision' | 'too_large'
  }
}

function checkDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw new UnitsError('format', `bad decimals: ${decimals}`);
}

/**
 * What a person typed → the smallest unit. Accepts "1", "1.5", "1,5", ".5"
 * and spaces as group separators, like the FIRO amount field. Refuses more
 * decimals than the token has rather than rounding them away.
 */
export function parseUnits(input, decimals, { symbol = '' } = {}) {
  checkDecimals(decimals);
  if (typeof input !== 'string') throw new UnitsError('empty', 'Enter an amount.');
  let s = input.replace(/[\s   ]/g, '');
  if (s === '') throw new UnitsError('empty', 'Enter an amount.');
  if (s.startsWith('-')) throw new UnitsError('negative', 'The amount must be more than zero.');
  if ((s.match(/[.,]/g) || []).length > 1) throw new UnitsError('format', 'Use one decimal mark, like 1.25');
  s = s.replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) throw new UnitsError('format', 'Only digits and one decimal mark, like 1.25');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    const what = symbol || 'This token';
    throw new UnitsError('precision', decimals === 0 ? `${what} has no decimal places.` : `${what} has ${decimals} decimal places at most.`);
  }
  const unit = 10n ** BigInt(decimals);
  const v = BigInt(whole || '0') * unit + BigInt(frac.padEnd(decimals, '0') || '0');
  if (v > MAX_UINT256) throw new UnitsError('too_large', 'That amount is too large.');
  return v;
}

/**
 * Smallest unit → "1,234.5", rounded down to `maxDecimals` places, trailing
 * zeros dropped. Negative values keep their sign (a balance change).
 */
export function formatUnits(value, decimals, { maxDecimals = DISPLAY_DECIMALS, minDecimals = 0, group = true } = {}) {
  checkDecimals(decimals);
  let v = BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const shown = Math.min(maxDecimals, decimals);
  const cut = 10n ** BigInt(decimals - shown);
  v /= cut; // round down
  const base = 10n ** BigInt(shown);
  let whole = (v / base).toString();
  let frac = shown ? (v % base).toString().padStart(shown, '0').replace(/0+$/, '') : '';
  while (frac.length < Math.min(minDecimals, shown)) frac += '0';
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const out = whole + (frac ? `.${frac}` : '');
  return neg && out.replace(/[0.,]/g, '') !== '' ? `-${out}` : out;
}

/** True when formatUnits would hide part of the value (show "≈", or offer the full figure). */
export function isRoundedDown(value, decimals, maxDecimals = DISPLAY_DECIMALS) {
  checkDecimals(decimals);
  if (maxDecimals >= decimals) return false;
  const v = BigInt(value);
  return (v < 0n ? -v : v) % 10n ** BigInt(decimals - maxDecimals) !== 0n;
}

/** Smallest unit → the exact plain decimal an input field can hold ("1234.000000000000000001"). */
export function toInputString(value, decimals) {
  return formatUnits(value, decimals, { maxDecimals: decimals, group: false });
}

/** wei → gwei with up to 9 places, for fee lines ("12.5"). */
export function formatGwei(wei, maxDecimals = 3) {
  return formatUnits(wei, 9, { maxDecimals, group: true });
}
