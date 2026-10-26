// FIRO's price in the person's currency, and how money values are written.
// As the Campfire app (lib/services/price.dart): from CoinGecko, whose id for
// FIRO is still "zcoin" (Firo's name before 2020).
//
// Privacy: nothing is asked unless prefs.fiatPrices is exactly true, which only
// the person sets ("Show values in dollars?" on Home, or the switch in
// Settings): CoinGecko sees the IP address. One request asks for FIRO in one
// currency, at most every two minutes; the URL can only be CoinGecko's
// simple/price path that the CSP allows (lib/price_host.js PRICE_HOST).
// Without an answer the screens show no money value at all, never a made-up 0.

import { PRICE_HOST, originOf } from './price_host.js';
import { t, tk } from './i18n.js';

export const COINGECKO_FIRO_ID = 'zcoin';
export const DEFAULT_CURRENCY = 'USD';
export const PRICE_MAX_AGE_MS = 2 * 60000;
/** After CoinGecko says "too many requests": wait this long before asking again. */
export const BUSY_BACKOFF_MS = 5 * 60000;
/** A price older than this is not shown (the request kept failing). */
export const PRICE_SHOW_MAX_MS = 30 * 60000;
const TIMEOUT_MS = 20000;

/**
 * The currencies the desktop app offers (lib/providers/global/base_currencies_provider.dart),
 * the national ones: CoinGecko prices FIRO in each. Its crypto units (BTC, sats…), gold,
 * silver, SDR and the retired VEF are left out: a wallet value in them helps no one here.
 */
export const FIAT_CURRENCIES = Object.freeze([
  ['USD', tk('US dollar')], ['EUR', tk('Euro')], ['GBP', tk('Pound sterling')], ['AUD', tk('Australian dollar')], ['AED', tk('UAE dirham')],
  ['ARS', tk('Argentine peso')], ['BDT', tk('Bangladeshi taka')], ['BHD', tk('Bahraini dinar')], ['BMD', tk('Bermudan dollar')], ['BRL', tk('Brazilian real')],
  ['CAD', tk('Canadian dollar')], ['CHF', tk('Swiss franc')], ['CLP', tk('Chilean peso')], ['CNY', tk('Chinese yuan')], ['CZK', tk('Czech koruna')],
  ['DKK', tk('Danish krone')], ['HKD', tk('Hong Kong dollar')], ['HUF', tk('Hungarian forint')], ['IDR', tk('Indonesian rupiah')], ['ILS', tk('Israeli shekel')],
  ['INR', tk('Indian rupee')], ['JPY', tk('Japanese yen')], ['KRW', tk('South Korean won')], ['KWD', tk('Kuwaiti dinar')], ['LKR', tk('Sri Lankan rupee')],
  ['MMK', tk('Myanmar kyat')], ['MXN', tk('Mexican peso')], ['MYR', tk('Malaysian ringgit')], ['NGN', tk('Nigerian naira')], ['NOK', tk('Norwegian krone')],
  ['NZD', tk('New Zealand dollar')], ['PHP', tk('Philippine peso')], ['PKR', tk('Pakistani rupee')], ['PLN', tk('Polish złoty')], ['RUB', tk('Russian ruble')],
  ['SAR', tk('Saudi riyal')], ['SEK', tk('Swedish krona')], ['SGD', tk('Singapore dollar')], ['THB', tk('Thai baht')], ['TRY', tk('Turkish lira')],
  ['TWD', tk('New Taiwan dollar')], ['UAH', tk('Ukrainian hryvnia')], ['VND', tk('Vietnamese dong')], ['ZAR', tk('South African rand')],
].map((c) => Object.freeze(c)));

const CODES = new Set(FIAT_CURRENCIES.map(([c]) => c));
export const isCurrency = (code) => CODES.has(code);
export const currencyOf = (prefs) => (prefs && isCurrency(prefs.fiatCurrency) ? prefs.fiatCurrency : DEFAULT_CURRENCY);
/** Only an explicit yes turns prices on. */
export const fiatAllowed = (prefs) => Boolean(prefs) && prefs.fiatPrices === true;
/** Not asked yet: neither yes nor no. */
export const fiatUnasked = (prefs) => !prefs || (prefs.fiatPrices !== true && prefs.fiatPrices !== false);

/** "dollars" for USD, else the currency's name, for the question and the switch. */
export function currencyWords(code) {
  if (code === 'USD') return t('dollars');
  const c = FIAT_CURRENCIES.find(([k]) => k === code);
  return c ? c[0] : code;
}

/** The one URL this asks: CoinGecko's simple/price for FIRO in `code`. */
export function fiatPriceUrl(code) {
  if (!isCurrency(code)) throw new Error(t('not a currency: {code}', { code }));
  return `${originOf(PRICE_HOST)}${PRICE_HOST.path}?ids=${COINGECKO_FIRO_ID}&vs_currencies=${code.toLowerCase()}`;
}

/** CoinGecko's answer -> a usable price (a positive finite number), or null. */
export function parsePrice(body, code) {
  const v = body && typeof body === 'object' && !Array.isArray(body) ? body[COINGECKO_FIRO_ID] : null;
  const p = v && typeof v === 'object' ? v[String(code).toLowerCase()] : undefined;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * FIRO's price, kept in memory for this page. get() never throws: it answers
 * the last good price for the currency (while not too old) or null, and asks
 * CoinGecko again when the price is older than two minutes. Listeners hear
 * every new price.
 */
export class FiatPrice {
  /** prefs: () => the app's prefs; fetch and clock for tests. */
  constructor({ prefs, fetch: fetchImpl = null, clock = () => Date.now(), maxAgeMs = PRICE_MAX_AGE_MS } = {}) {
    this.prefs = prefs || (() => null);
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.clock = clock;
    this.maxAgeMs = maxAgeMs;
    this.last = null; // { price, currency, at }
    this.error = null; // { message, at }
    this.loading = null;
    this.waitUntil = 0;
    this.requests = 0;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The price to show now ({price, currency, at}), or null: never asks anything itself. */
  current() {
    const prefs = this.prefs();
    if (!fiatAllowed(prefs)) return null;
    const cur = currencyOf(prefs);
    const l = this.last;
    if (!l || l.currency !== cur || this.clock() - l.at > PRICE_SHOW_MAX_MS) return null;
    return l;
  }

  /** current(), and a request in the background when the price is missing or old. */
  get() {
    this.refresh();
    return this.current();
  }

  /** Asks CoinGecko when allowed and due. Resolves to the price shown afterwards (or null). */
  refresh({ force = false } = {}) {
    const prefs = this.prefs();
    if (!fiatAllowed(prefs)) return Promise.resolve(null);
    const cur = currencyOf(prefs);
    const now = this.clock();
    const l = this.last;
    const fresh = l && l.currency === cur && now - l.at < this.maxAgeMs;
    if (this.loading) return this.loading;
    if (!force && (fresh || now < this.waitUntil)) return Promise.resolve(this.current());
    this.loading = this.#load(cur).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async #load(cur) {
    this.requests++;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    let price = null;
    try {
      const res = await this._fetch(fiatPriceUrl(cur), {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (res.status === 429) {
        this.waitUntil = this.clock() + BUSY_BACKOFF_MS;
        this.error = { message: t('CoinGecko is busy; the price is asked again in a few minutes.'), at: this.clock() };
      } else if (res.status !== 200) {
        this.waitUntil = this.clock() + this.maxAgeMs;
        this.error = { message: t('CoinGecko answered HTTP {status}.', { status: res.status }), at: this.clock() };
      } else {
        price = parsePrice(JSON.parse(await res.text()), cur);
        if (price == null) this.error = { message: t('CoinGecko gave no price for FIRO.'), at: this.clock() };
      }
    } catch (e) {
      this.waitUntil = this.clock() + 30000;
      this.error = { message: t('The price could not be read ({error}).', { error: ctrl && ctrl.signal.aborted ? t('no answer in time') : (e && e.message) || e }), at: this.clock() };
    } finally {
      if (timer) clearTimeout(timer);
    }
    // The answer is only kept if prices are still on, in the same currency.
    const prefs = this.prefs();
    if (price != null && fiatAllowed(prefs) && currencyOf(prefs) === cur) {
      this.last = { price, currency: cur, at: this.clock() };
      this.error = null;
      for (const fn of this.listeners) {
        try {
          fn(this.last);
        } catch (e) {
          console.error(e);
        }
      }
    }
    return this.current();
  }

  /** Forgets the price (prices turned off, or another currency picked). */
  forget() {
    this.last = null;
    this.error = null;
    this.waitUntil = 0;
  }
}

/** sats at `price` per FIRO, as a plain number of the currency (display only). */
export function fiatValue(sats, price) {
  return (Number(BigInt(sats)) / 1e8) * price;
}

/**
 * A money amount as people read it: "$1,240", "$12.34", "< $0.01", "€0". `locale`
 * for digit grouping (default: the browser's). USD is written with "$".
 */
export function fiatText(value, currency, locale = undefined) {
  const opts = { style: 'currency', currency, currencyDisplay: currency === 'USD' ? 'narrowSymbol' : 'symbol' };
  const fmt = (o = {}) => {
    try {
      return new Intl.NumberFormat(locale, { ...opts, ...o }).format;
    } catch {
      return new Intl.NumberFormat('en-US', { ...opts, ...o }).format;
    }
  };
  // The currency's own decimals (yen: none), at most two.
  const places = Math.min(2, new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  const exact = { minimumFractionDigits: places, maximumFractionDigits: places };
  if (!(value > 0)) return fmt(exact)(0);
  const smallest = 10 ** -places;
  if (value < smallest) return `< ${fmt(exact)(smallest)}`;
  if (value >= 1000) return fmt({ minimumFractionDigits: 0, maximumFractionDigits: 0 })(Math.floor(value));
  // Rounded down: an estimate never shows more than the exact value.
  const step = 10 ** places;
  return fmt(exact)(Math.floor(value * step + 1e-9) / step);
}

/** "≈ $12.34" (or "< $0.01") for `sats` at `p` ({price, currency}); null without a price. */
export function fiatEstimate(sats, p, locale = undefined) {
  if (!p || sats == null) return null;
  const item = fiatText(fiatValue(sats, p.price), p.currency, locale);
  return item.startsWith('<') ? item : `≈ ${item}`;
}

const instances = new WeakMap();

/** The page's one FiatPrice for `app` (its prefs decide whether anything is asked). */
export function firoPrice(app) {
  let p = instances.get(app);
  if (!p) {
    p = new FiatPrice({ prefs: () => app.prefs });
    instances.set(app, p);
  }
  return p;
}

/**
 * FIRO's price in US dollars, asked once on purpose (the Rosen bridge needs it to work out its $10
 * minimum, whatever the person chose for showing values). The caller asks the person first: it is
 * a request to CoinGecko, which sees the IP address. Kept for ten minutes. -> number | null.
 */
let usdOnce = null;
/** When the price firoUsdOnce() last gave was read (ms), or null. */
export function firoUsdOnceAt() {
  return usdOnce ? usdOnce.at : null;
}

export async function firoUsdOnce({ fetch: fetchImpl = globalThis.fetch, clock = () => Date.now() } = {}) {
  if (usdOnce && clock() - usdOnce.at < 10 * 60 * 1000) return usdOnce.price;
  try {
    const res = await fetchImpl(fiatPriceUrl('USD'), { method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status !== 200) return null;
    const price = parsePrice(JSON.parse(await res.text()), 'USD');
    if (price != null) usdOnce = { price, at: clock() };
    return price;
  } catch {
    return null;
  }
}
