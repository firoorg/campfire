// buyfiro.app's buy API (v1): pay with a coin from another chain, get FIRO in
// this wallet. buyfiro.app buys the FIRO and sends it to the wallet; this file
// only asks it questions. Base: lib/buy/hosts.js (buyfiro.app/api/v1/buy).
//
//   GET  /assets                    the coins it takes
//   GET  /limits                    the smallest buy, as a hint
//   GET  /quote                     what an amount buys, nothing created
//   POST /order                     a deposit address for one buy
//   GET  /order/{deposit address}   where that buy is
//
// Every answer is {ok: true, …} or {ok: false, error: {code, …}}; the app
// branches on `ok` and the code only. An answer that is not JSON at all (a
// proxy's HTML page) or a request that never got an answer is "could not
// reach buyfiro.app", never "the order failed": a person who already paid
// must not be told it failed.
//
// Requests carry no cookies and no referrer. Addresses and amounts are never
// logged, and never put in a URL except the deposit address (the order's only
// handle) and the quote's own fields. (A browser cannot set a User-Agent of its
// own; it sends the browser's.)
//
// The coin's fields, as buyfiro.app API v1 names them: firo_wallet (in the
// order's body), firo_estimate, firo_estimate_raw and firo_txid; the address
// refusals firo_wallet_required / _invalid / _is_evm / _unpayable (and the
// _too_short / _too_long it may add).

import { buyApiBase } from './hosts.js';
import { EVM_CHAINS, isDepositAddressOf } from './deposit_address.js';
import { t, tk, lazyWords, tn } from '../i18n.js';

/** The prefix of the fields that name the coin (buyfiro.app API v1). */
export const FIELD_PREFIX = 'firo_';

/** j's coin field `name` ("estimate", "txid"…): firo_<name>. */
export function coinField(j, name) {
  if (!j || typeof j !== 'object') return undefined;
  return j[`${FIELD_PREFIX}${name}`];
}

/** The address refusals. */
export const WALLET_ERRORS = Object.freeze(['firo_wallet_required', 'firo_wallet_too_short', 'firo_wallet_too_long', 'firo_wallet_invalid', 'firo_wallet_is_evm', 'firo_wallet_unpayable']);

// ------------------------------------------------------------------ errors

/** Every code the API documents, plus the app's own four (blocked, network, unexpected_answer, unknown). */
export const ERROR_CODES = Object.freeze([
  'amount_below_upstream_minimum',
  'amount_below_our_minimum',
  'bad_amount',
  'amount_too_small',
  'unknown_asset',
  'asset_unavailable',
  'no_liquidity',
  'refund_address_required',
  ...WALLET_ERRORS,
  'asset_id_required',
  'bad_body',
  'order_not_found',
  'price_unavailable',
  'upstream_absent',
  'upstream_unavailable',
  'quote_failed',
  'no_deposit_address',
  'destination_unverifiable',
]);

/** Why buyfiro.app said no, or why there was no usable answer. */
export class BuyError extends Error {
  constructor(code, { rawCode = null, minimumUsd = null, orderValueUsd = null, retryAfterMs = null, httpStatus = null, cause = null } = {}) {
    super(`buyfiro.app: ${code}${httpStatus ? t(' (HTTP {httpStatus})', { httpStatus }) : ''}`);
    /**
     * One of ERROR_CODES, 'blocked' (not JSON), 'network' (no answer), 'unexpected_answer',
     * 'wrong_deposit_address' (not an address of the coin's chain: never shown), or 'unknown'.
     */
    this.code = code;
    /** The code exactly as sent. */
    this.rawCode = rawCode ?? code;
    /** The smallest buy in US dollars, when the amount was under it. */
    this.minimumUsd = minimumUsd;
    /** What the amount was worth, when buyfiro.app said. */
    this.orderValueUsd = orderValueUsd;
    /** Ask again no sooner than this. */
    this.retryAfterMs = retryAfterMs;
    this.httpStatus = httpStatus;
    /** For 'network': what the browser said ("timeout", "TypeError: Load failed"). */
    this.cause = cause;
  }

  /** The amount is under the smallest buy. */
  get belowMinimum() {
    return this.code === 'amount_below_upstream_minimum' || this.code === 'amount_below_our_minimum';
  }

  /** No answer from buyfiro.app at all. */
  get unreachable() {
    return this.code === 'blocked' || this.code === 'network';
  }
}

function errorFromJson(e, { httpStatus, retryAfterMs }) {
  const raw = typeof e.code === 'string' ? e.code : '';
  const known = raw;
  const code = ERROR_CODES.includes(known) ? known : 'unknown';
  return new BuyError(code, { rawCode: raw, minimumUsd: num(e.minimum_usd), orderValueUsd: num(e.order_value_usd), retryAfterMs: seconds(e.retry_after) ?? retryAfterMs, httpStatus });
}

// ----------------------------------------------------------------- amounts

const NUMBER = /^[0-9]*\.?[0-9]*$/;

/**
 * An amount the person typed, in a coin with `decimals` decimals.
 *
 * buyfiro.app reads amounts as JSON numbers and works out the coin's smallest
 * unit itself, rounding amount × 10^decimals in floating point. The app keeps
 * the exact amount from the text (raw) and checks that buyfiro.app's figure is
 * the same before it shows a deposit address. Where floating point cannot
 * carry an amount exactly, it is refused before anything is asked, and
 * nearestExact() offers one that it can carry.
 */
export class BuyAmount {
  constructor(text, raw, decimals) {
    /** "0.0122": no grouping, no leading or trailing zeros to speak of. */
    this.text = text;
    /** In the coin's smallest unit (BigInt). */
    this.raw = raw;
    this.decimals = decimals;
    Object.freeze(this);
  }

  /** Digits after the point that may be typed: the coin's own, at most 8. */
  static maxFractionDigits(decimals) {
    return Math.min(decimals, 8);
  }

  /** text as typed → {amount, error}: an error in plain words when it is not an amount, both null when empty. */
  static parse(text, decimals) {
    const item = String(text ?? '').trim();
    if (!item) return { amount: null, error: null };
    if (item.includes(',')) return { amount: null, error: t('Use a dot for decimals, like 0.5') };
    if (!NUMBER.test(item) || item === '.') return { amount: null, error: t('Enter a number, like 0.5') };
    const dot = item.indexOf('.');
    const whole = (dot < 0 ? item : item.slice(0, dot)).replace(/^0+(?=.)/, '');
    let frac = dot < 0 ? '' : item.slice(dot + 1);
    const max = BuyAmount.maxFractionDigits(decimals);
    if (frac.length > max) return { amount: null, error: tn({ one: 'Use at most {n} digit after the point', other: 'Use at most {n} digits after the point' }, max) };
    if (whole.length > 15) return { amount: null, error: t('That amount is too large') };
    frac = frac.replace(/0+$/, '');
    const w = whole || '0';
    const normal = frac ? `${w}.${frac}` : w;
    const unit = 10n ** BigInt(decimals);
    const raw = BigInt(w) * unit + (frac ? BigInt(frac.padEnd(decimals, '0')) : 0n);
    return { amount: new BuyAmount(normal, raw, decimals), error: null };
  }

  /** Exactly `text` (for amounts the app works out, e.g. the smallest buy). */
  static fromDecimalText(text, decimals) {
    return BuyAmount.parse(text, decimals).amount;
  }

  get isPositive() {
    return this.raw > 0n;
  }

  /** The number sent to buyfiro.app. */
  get value() {
    return Number(this.text);
  }

  /** The smallest-unit figure buyfiro.app works out from `value` (round(value × 10^decimals) in doubles). */
  static serverRaw(value, decimals) {
    return BigInt(Math.round(value * Number(`1e${decimals}`)));
  }

  /** buyfiro.app's figure for this amount is exactly raw. */
  get exact() {
    return BuyAmount.serverRaw(this.value, this.decimals) === this.raw;
  }

  /** The closest amount with fewer digits after the point that buyfiro.app carries exactly; null when there is none (or this one already is). */
  nearestExact() {
    if (this.exact) return null;
    const dot = this.text.indexOf('.');
    const digits = dot < 0 ? 0 : this.text.length - dot - 1;
    for (let f = digits - 1; f >= 0; f--) {
      const c = this.#rounded(f);
      if (!c || !c.isPositive) continue;
      if (c.exact) return c.text;
    }
    return null;
  }

  /** Rounded half up to `places` digits after the point. */
  #rounded(places) {
    const step = 10n ** BigInt(this.decimals - places);
    const r = ((this.raw + step / 2n) / step) * step;
    const unit = 10n ** BigInt(this.decimals);
    const whole = r / unit;
    const frac = (r % unit).toString().padStart(this.decimals, '0').slice(0, places);
    return BuyAmount.fromDecimalText(places === 0 ? `${whole}` : `${whole}.${frac}`, this.decimals);
  }

  equals(o) {
    return o instanceof BuyAmount && o.raw === this.raw && o.decimals === this.decimals;
  }

  toString() {
    return this.text;
  }
}

// ------------------------------------------------------------------ coins

/** Chain names people know, by the chain id the API uses. */
const CHAIN_NAME_WORDS = Object.freeze({
  btc: tk('Bitcoin'),
  bitcoin: tk('Bitcoin'),
  zec: tk('Zcash'),
  ltc: tk('Litecoin'),
  eth: 'Ethereum',
  sol: tk('Solana'),
  tron: tk('Tron'),
  bsc: 'BNB Chain',
  xrp: tk('XRP Ledger'),
  doge: tk('Dogecoin'),
  ton: 'TON',
  bch: tk('Bitcoin Cash'),
  dash: tk('Dash'),
  cardano: tk('Cardano'),
  sui: tk('Sui'),
  avax: tk('Avalanche'),
  pol: tk('Polygon'),
  arb: tk('Arbitrum'),
  base: tk('Base'),
  op: tk('Optimism'),
  gnosis: tk('Gnosis'),
  stellar: tk('Stellar'),
  aptos: tk('Aptos'),
  bera: tk('Berachain'),
  starknet: tk('Starknet'),
  scroll: tk('Scroll'),
  monad: tk('Monad'),
  xlayer: tk('X Layer'),
  movement: tk('Movement'),
  plasma: tk('Plasma'),
  aleo: tk('Aleo'),
  hypercore: tk('Hyperliquid'),
  abs: tk('Abstract'),
  fogo: tk('Fogo'),
});
/** Each chain's name in the app's language (a name some languages write their own way). */
export const CHAIN_NAMES = lazyWords(CHAIN_NAME_WORDS);

/** Chains whose addresses are Ethereum's (0x and 40 hex digits): lib/buy/deposit_address.js. */
export { EVM_CHAINS };

export function chainName(blockchain) {
  return Object.hasOwn(CHAIN_NAMES, blockchain) ? CHAIN_NAMES[blockchain] : String(blockchain).toUpperCase();
}

/** The chain's English name, which a search also matches ("bitcoin" finds Bitcoin in every language). */
export function chainNameEnglish(blockchain) {
  return Object.hasOwn(CHAIN_NAME_WORDS, blockchain) ? CHAIN_NAME_WORDS[blockchain] : String(blockchain).toUpperCase();
}

/** A coin buyfiro.app takes, on one chain; null for an entry this version cannot read. */
export function assetFromJson(j) {
  if (!j || typeof j !== 'object') return null;
  const { asset_id: id, symbol, blockchain: chain, decimals } = j;
  if (typeof id !== 'string' || !id) return null;
  if (typeof symbol !== 'string' || typeof chain !== 'string' || typeof decimals !== 'number' || !Number.isFinite(decimals)) return null;
  if (decimals < 0 || decimals > 36) return null;
  const contract = typeof j.contract_address === 'string' && j.contract_address ? j.contract_address : null;
  const d = Math.trunc(decimals);
  return Object.freeze({
    assetId: id,
    symbol,
    blockchain: chain,
    decimals: d,
    /** Null for a chain's own coin (BTC, ETH on Ethereum, SOL…). */
    contractAddress: contract,
    priceUsd: num(j.price_usd),
    isNative: contract === null,
    /** "Bitcoin", "Tron", "BNB Chain"… */
    chainName: chainName(chain),
    chainNameEn: chainNameEnglish(chain),
    /** Addresses on this chain are Ethereum's. */
    isEvm: EVM_CHAINS.has(chain),
  });
}

/** The fields an asset is kept with (an order remembers its coin). */
export function assetToJson(a) {
  return { asset_id: a.assetId, symbol: a.symbol, blockchain: a.blockchain, decimals: a.decimals, contract_address: a.contractAddress, price_usd: a.priceUsd };
}

/** The coins people bring most, first, as [symbol, chain]. */
export const POPULAR = Object.freeze([
  ['BTC', 'btc'],
  ['BTC', 'bitcoin'],
  ['ETH', 'eth'],
  ['USDT', 'tron'],
  ['USDT', 'eth'],
  ['USDC', 'sol'],
  ['USDC', 'base'],
  ['SOL', 'sol'],
  ['LTC', 'ltc'],
  ['ZEC', 'zec'],
  ['DOGE', 'doge'],
  ['XRP', 'xrp'],
  ['BNB', 'bsc'],
  ['TRX', 'tron'],
  ['TON', 'ton'],
  ['BCH', 'bch'],
  ['DASH', 'dash'],
  ['ADA', 'cardano'],
]);

export function isPopular(a) {
  return POPULAR.some(([s, c]) => s === a.symbol && c === a.blockchain);
}

/** In picker order: POPULAR first, in its order; then each chain's own coin; then the rest; ties by chain name, then symbol. */
export function sortAssets(list) {
  const rank = (a) => {
    const i = POPULAR.findIndex(([s, c]) => s === a.symbol && c === a.blockchain);
    if (i >= 0) return i;
    return POPULAR.length + (a.isNative ? 0 : 1000);
  };
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || cmp(a.chainName, b.chainName) || cmp(a.symbol, b.symbol));
}

/** The coin the form starts with: BTC, on Bitcoin. */
export function isDefaultCoin(a) {
  return a.symbol === 'BTC' && a.isNative && (a.blockchain === 'btc' || a.blockchain === 'bitcoin');
}

/** The smallest buy, as a hint for the form ({ourMinimumUsd, upstreamObservedMinimumUsd, hintUsd}). /quote decides. */
export function limitsFromJson(j) {
  const ours = num(j.our_minimum_usd);
  const observed = num(j.upstream_observed_minimum_usd);
  return Object.freeze({ ourMinimumUsd: ours, upstreamObservedMinimumUsd: observed, hintUsd: observed ?? ours });
}

// ------------------------------------------------------------------ states

/** Where a buy is, as buyfiro.app says it. Anything else is 'in_progress': still going, keep asking. */
export const STATES = Object.freeze(['awaiting_deposit', 'deposit_detected', 'swapping', 'buying', 'processing', 'sending', 'delivered', 'refunded', 'expired', 'failed', 'attention']);
const FINAL = new Set(['delivered', 'refunded', 'expired', 'failed']);

export function parseState(s) {
  return STATES.includes(s) ? s : 'in_progress';
}

/** buyfiro.app will not change it again. */
export function isFinalState(s) {
  return FINAL.has(s);
}

// ------------------------------------------------------------------ client

export const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Whether this runs under a test runner (node --test sets NODE_TEST_CONTEXT in
 * its test processes; CAMPFIRE_TEST is for any other harness). Never true in a browser.
 */
export function underTest(env = typeof process !== 'undefined' && process && process.env ? process.env : null) {
  return Boolean(env && (env.NODE_TEST_CONTEXT || env.CAMPFIRE_TEST));
}

export class BuyClient {
  /**
   * fetch: the window's fetch (tests inject one). sandbox: buyfiro.app's test
   * mode (no funds, nothing payable). In sandbox mode every call carries
   * ?sandbox=true in its URL, and the order's body says sandbox: true as well;
   * the URL is what counts (a body flag alone was once ignored by the same
   * kind of API, which then made a real order).
   */
  constructor({ fetch: fetchImpl = null, base = buyApiBase(), sandbox = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    /** Requests go to the real network (no fetch was handed in). */
    this.realNetwork = !fetchImpl;
    this.base = base;
    this.sandbox = sandbox === true;
    this.timeoutMs = timeoutMs;
  }

  /** The coins buyfiro.app takes (unreadable entries left out), in its order. */
  async assets() {
    const j = await this._send('GET', '/assets');
    if (!Array.isArray(j.assets)) throw new BuyError('unexpected_answer');
    return j.assets.map(assetFromJson).filter(Boolean);
  }

  async limits() {
    return limitsFromJson(await this._send('GET', '/limits'));
  }

  /**
   * What `amount` (a BuyAmount) of assetId buys now; refunds would go to
   * refundAddress (on the coin's chain). Refused unless the answer is about
   * this coin and this amount.
   */
  async quote({ assetId, amount, refundAddress }) {
    const j = await this._send('GET', '/quote', { query: { asset_id: assetId, amount: String(amount.value), refund_address: refundAddress } });
    const raw = bigInt(j.send_amount_raw);
    const estimate = num(coinField(j, 'estimate'));
    if ((j.asset_id != null && j.asset_id !== assetId) || (raw !== null && raw !== amount.raw) || estimate === null || estimate < 0) throw new BuyError('unexpected_answer');
    const estimateRaw = bigInt(coinField(j, 'estimate_raw'));
    return Object.freeze({
      assetId,
      /** The FIRO that arrives, as buyfiro.app says it (nothing to subtract). */
      estimate,
      estimateRaw,
      /** estimate in satoshi (1e-8 FIRO). */
      estimateSats: estimateRaw ?? BigInt(Math.round(estimate * 1e8)),
      sendAmountRaw: raw,
      orderValueUsd: num(j.order_value_usd),
      /** Usual time from the payment to the FIRO. */
      etaSeconds: int(j.eta_seconds),
    });
  }

  /**
   * A deposit address for buying with `amount` of assetId (a coin on `blockchain`, buyfiro.app's
   * chain id), the FIRO going to walletAddress. Asking again with the same four values returns
   * the same order. Refused ('unexpected_answer') unless the answer is exactly this order and can
   * be paid, and ('wrong_deposit_address') unless the deposit address is one of the coin's own
   * chain (lib/buy/deposit_address.js): a payment to another chain's address is lost. Sandbox
   * orders carry made-up addresses (sbx_…) that nobody can pay, and are not checked.
   */
  async order({ assetId, amount, walletAddress, refundAddress, blockchain = null }) {
    const j = await this._send('POST', '/order', { body: { asset_id: assetId, amount: amount.value, [`${FIELD_PREFIX}wallet`]: walletAddress, refund_address: refundAddress } });
    const deposit = j.deposit_address;
    const raw = bigInt(j.send_amount_raw);
    const sent = num(j.send_amount);
    const payable = j.payable === true;
    // Sandbox orders carry no raw figure: the number must be ours.
    const sameAmount = raw !== null ? raw === amount.raw : this.sandbox && sent === amount.value;
    if (typeof deposit !== 'string' || !deposit.trim() || j.asset_id !== assetId || coinField(j, 'wallet') !== walletAddress || !sameAmount || (!this.sandbox && !payable)) throw new BuyError('unexpected_answer');
    if (!this.sandbox && !isDepositAddressOf(deposit, blockchain)) throw new BuyError('wrong_deposit_address');
    return Object.freeze({
      /** Where the person pays, and the order's only handle. */
      depositAddress: deposit,
      assetId,
      walletAddress,
      payable,
      /** False when the same order already existed (a retry): still success. */
      created: j.created !== false,
      sendAmountRaw: raw,
      estimate: num(coinField(j, 'estimate')),
      estimateRaw: bigInt(coinField(j, 'estimate_raw')),
      /** After this (ms), the address no longer takes payments. */
      deadline: time(j.deadline),
      etaSeconds: int(j.eta_seconds),
    });
  }

  /** Where the buy paid at depositAddress is. forceState: sandbox only (buyfiro.app answers with that state). */
  async status(depositAddress, { forceState = null } = {}) {
    const id = forceState && this.sandbox ? `${depositAddress}:${forceState}` : depositAddress;
    const j = await this._send('GET', `/order/${encodeURIComponent(id)}`);
    if (j.deposit_address !== depositAddress) throw new BuyError('unexpected_answer');
    const rawState = typeof j.state === 'string' ? j.state : '';
    const state = parseState(rawState);
    const after = seconds(j.poll_after_seconds);
    return Object.freeze({
      depositAddress,
      state,
      rawState,
      // Only a state the app knows as an ending ends the polling.
      terminal: j.terminal === true && isFinalState(state),
      pollAfterMs: after === null || after <= 0 ? null : after,
      txid: typeof coinField(j, 'txid') === 'string' && coinField(j, 'txid') ? coinField(j, 'txid') : null,
      estimate: num(coinField(j, 'estimate')),
      deadline: time(j.deadline),
    });
  }

  async _send(method, path, { query = null, body = null } = {}) {
    // A test may never make a real order: under a test runner a POST through the
    // real network goes out in sandbox mode or not at all.
    if (method !== 'GET' && this.realNetwork && !this.sandbox && underTest()) throw new BuyError('sandbox_required');
    const params = new URLSearchParams(query || {});
    if (this.sandbox) params.set('sandbox', 'true');
    if (this.sandbox && body) body = { ...body, sandbox: true };
    const qs = params.toString();
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    const ctrl = new AbortController();
    let timer = null;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Error('timeout'));
      }, this.timeoutMs);
    });
    let res;
    let text;
    try {
      const ask = (async () => {
        const r = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors', signal: ctrl.signal });
        return [r, await r.text()];
      })();
      [res, text] = await Promise.race([ask, late]);
    } catch (e) {
      // TLS, socket, CORS, offline, the time ran out: nothing came back.
      throw new BuyError('network', { cause: e && e.message === 'timeout' ? 'timeout' : `${(e && e.name) || t('Error')}: ${(e && e.message) || e}` });
    } finally {
      clearTimeout(timer);
    }
    const status = res.status;
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      j = null;
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new BuyError('blocked', { httpStatus: status });
    if (j.ok === true && status < 400) return j;
    if (j.ok === false && j.error && typeof j.error === 'object') {
      let header = null;
      try {
        header = seconds(res.headers && res.headers.get ? res.headers.get('retry-after') : null);
      } catch {
        header = null;
      }
      throw errorFromJson(j.error, { httpStatus: status, retryAfterMs: seconds(j.retry_after) ?? header });
    }
    throw new BuyError('unexpected_answer', { httpStatus: status });
  }
}

// ------------------------------------------------------------------ reading

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function int(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

function bigInt(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  return null;
}

/** Seconds (number or numeric string) → ms; null for anything else or a negative. */
function seconds(v) {
  const d = num(v);
  if (d === null || d < 0) return null;
  return Math.round(d * 1000);
}

/** Unix seconds or an ISO date → ms since 1970, or null. */
function time(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v * 1000);
  if (typeof v === 'string' && v) {
    const item = Date.parse(v);
    return Number.isFinite(item) ? item : null;
  }
  return null;
}
