// Amounts. FIRO has 8 decimals; the engine speaks satoshi strings (1 FIRO = 100,000,000 sats,
// WALLET_API.md). Everything here is BigInt, so there are no float errors anywhere between what
// the person types and what the engine receives.

export const DECIMALS = 8;
export const UNIT = 'FIRO';
export const SATS_PER_COIN = 100000000n;
// FIRO's total supply is about 21.4 million: no real amount comes near this.
export const MAX_SATS = 21000000n * 10n * SATS_PER_COIN;

export class AmountError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Parses what a person typed into sats.
 * Accepts "1", "1.5", "1,5" (comma as the decimal mark), ".5", spaces
 * (including thin and no-break spaces) as group separators.
 * Rejects: empty, negative, letters, two decimal marks, more than 8 decimals.
 */
export function parseAmount(input) {
  if (typeof input !== 'string') throw new AmountError('empty', 'Enter an amount.');
  let s = input.replace(/[\s   ]/g, '');
  if (s === '') throw new AmountError('empty', 'Enter an amount.');
  if (s.startsWith('-')) throw new AmountError('negative', 'The amount must be more than zero.');
  const marks = s.match(/[.,]/g) || [];
  if (marks.length > 1) throw new AmountError('format', 'Use one decimal mark, like 1.25');
  // "1,000": one thousand in some places, one in others. Never guessed (public audit, PN: a
  // thousand read as one).
  if (/^[1-9]\d*,\d{3}$/.test(s)) throw new AmountError('ambiguous', `Is that ${s.replace(',', '')} or ${s.replace(',', '.')}? Write it without the comma, or with a dot for decimals.`);
  s = s.replace(',', '.');
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) throw new AmountError('format', 'Only digits and one decimal mark, like 1.25');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > DECIMALS) throw new AmountError('precision', 'FIRO has 8 decimal places at most.');
  const sats = BigInt(whole || '0') * SATS_PER_COIN + BigInt((frac + '00000000').slice(0, DECIMALS) || '0');
  if (sats > MAX_SATS) throw new AmountError('too_large', 'That amount is too large.');
  return sats;
}

/** sats → "1,234.5" (trailing zeros dropped, grouped thousands). */
export function formatAmount(sats, { group = true, minDecimals = 0, maxDecimals = DECIMALS } = {}) {
  let g = BigInt(sats);
  const neg = g < 0n;
  if (neg) g = -g;
  let whole = (g / SATS_PER_COIN).toString();
  let frac = (g % SATS_PER_COIN).toString().padStart(DECIMALS, '0');
  if (maxDecimals < DECIMALS) {
    // round half up to maxDecimals
    const cut = DECIMALS - maxDecimals;
    const unit = 10n ** BigInt(cut);
    const rounded = (g + unit / 2n) / unit; // in units of 10^-maxDecimals
    const base = 10n ** BigInt(maxDecimals);
    whole = (rounded / base).toString();
    frac = maxDecimals ? (rounded % base).toString().padStart(maxDecimals, '0') : '';
  }
  frac = frac.replace(/0+$/, '');
  while (frac.length < minDecimals) frac += '0';
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

/** sats → "1.5 FIRO". */
export const firo = (sats, opts) => `${formatAmount(sats, opts)} ${UNIT}`;

/** sats → the plain decimal string an input field can hold ("1234.5"). */
export function toInputString(sats) {
  return formatAmount(sats, { group: false });
}

/** An engine amount (a satoshi string, or a BigInt/safe integer) as BigInt sats. */
export function toSats(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new AmountError('format', 'bad amount from the wallet');
    return BigInt(v);
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  throw new AmountError('format', 'bad amount from the wallet');
}

/** BigInt sats → the satoshi string the engine takes. */
export function toSatString(sats) {
  const v = BigInt(sats);
  if (v < 0n || v > MAX_SATS) throw new AmountError('too_large', 'That amount is too large.');
  return v.toString();
}
