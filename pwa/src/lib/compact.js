// Amounts rounded down to what people read, the desktop app's
// DexFormat.number of the desktop app this was ported from, which its swap
// and buy screens use: from 1,000 two places, from 1 four, below 1 four
// significant digits. Exact integers in, never a float: each token keeps its
// own number of decimals (ETH 18, USDC 6, FIRO and rsFIRO 8).
import { t } from './i18n.js';

function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** num / den (BigInt, den > 0) as "1,234.56", "12.3456", "0.0001234". */
export function compactRatio(num, den) {
  if (den <= 0n) throw new Error(t('bad ratio'));
  if (num === 0n) return '0';
  const negative = num < 0n;
  const a = negative ? -num : num;
  let places;
  if (a >= 1000n * den) places = 2;
  else if (a >= den) places = 4;
  else {
    // Leading zeros after the point, then 4 significant digits.
    let p = 0;
    let scaled = a;
    while (scaled < den && p < 12) {
      scaled *= 10n;
      p++;
    }
    places = Math.min(12, Math.max(1, p + 3));
  }
  const scale = 10n ** BigInt(places);
  const digits = ((a * scale) / den).toString().padStart(places + 1, '0');
  const cut = digits.length - places;
  let s = `${digits.slice(0, cut)}.${digits.slice(cut)}`.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '0') return negative ? '> -0.000000000001' : '< 0.000000000001';
  const dot = s.indexOf('.');
  const w = dot < 0 ? s : s.slice(0, dot);
  const rest = dot < 0 ? '' : s.slice(dot);
  return `${negative ? '-' : ''}${group(w)}${rest}`;
}

/** An amount in a token's smallest unit, rounded down to what people read. */
export function compactUnits(value, decimals) {
  return compactRatio(BigInt(value), 10n ** BigInt(decimals));
}

/** Every digit, trailing zeros trimmed, thousands grouped ("1,234.000001"). */
export function exactUnits(value, decimals) {
  const v = BigInt(value);
  const negative = v < 0n;
  const a = negative ? -v : v;
  const unit = 10n ** BigInt(decimals);
  const frac = decimals === 0 ? '' : (a % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${group((a / unit).toString())}${frac ? `.${frac}` : ''}`;
}

/** 0.0313 → "3.13%", 0.123 → "12.3%", tiny → "< 0.01%". */
export function percentText(fraction) {
  const p = fraction * 100;
  if (!(p > 0)) return '0%';
  if (p < 0.01) return '< 0.01%';
  return `${p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`;
}
