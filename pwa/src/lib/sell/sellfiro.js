// buyfiro.app's sell API (v1): FIRO from this wallet in, USDT (or another
// token on an Ethereum-style chain) out, paid to an address the person gives.
// buyfiro.app sells the FIRO and pays out; this file only asks it questions.
// Base: lib/sell/hosts.js (buyfiro.app/api/v1/sell).
//
//   GET  /payout-chains           the chains it pays on, and the one it recommends
//   GET  /payout-tokens           the tokens it pays on one chain (search by symbol)
//   GET  /limits                  the smallest and largest sell, as a hint
//   GET  /quote                   what an amount brings, nothing created
//   POST /order                   a FIRO deposit address for one sell
//   GET  /order/{order id}        where that sell is
//   GET  /health                  whether it runs, and takes Spark deposits
//
// Every answer is {ok: true, …} or {ok: false, error: {code, …}}; the app
// branches on `ok` and the code only. An answer that is not JSON at all (a
// proxy's HTML page) or a request that never got an answer is "could not
// reach buyfiro.app", never "the sell failed": a person who already sent FIRO
// must not be told it failed.
//
// An order's answer is checked against the question before anything is kept
// or shown: the same amount, the same payout (chain, token, address), the same
// kind of deposit, and deposit addresses that this wallet's own classifier
// (wallet.classifyAddress) reads as a Firo address of that kind. Anything else
// is refused with 'unexpected_answer': FIRO is never sent to an address
// Campfire did not check.
//
// Requests carry no cookies and no referrer. Addresses and amounts are never
// logged; the payout address goes in the order's body only. (A browser cannot
// set a User-Agent of its own; it sends the browser's.)

import { sellApiBase } from './hosts.js';
import { underTest } from '../buy/buyfiro.js';
import { toInputString } from '../amount.js';
import { t } from '../i18n.js';

export { underTest };

// ------------------------------------------------------------------ errors

/** Every code the API documents for selling, plus the app's own (blocked, network, unexpected_answer, unknown, sandbox_required, order_exists). */
export const ERROR_CODES = Object.freeze([
  'bad_body',
  'bad_amount',
  'amount_below_minimum',
  'amount_above_maximum',
  'payout_address_invalid',
  'payout_token_invalid',
  'payout_chain_unsupported',
  'bad_deposit_kind',
  'bad_order_type',
  'bad_limit_price',
  'bad_limit_duration',
  'spark_unavailable',
  'rate_limited',
  'price_unavailable',
  'unavailable',
  'order_not_found',
]);

/** Why buyfiro.app said no, or why there was no usable answer. */
export class SellError extends Error {
  constructor(code, { rawCode = null, minimumFiro = null, maximumFiro = null, retryAfterMs = null, httpStatus = null, cause = null, unknownFields = null, orderId = null, amountFiro = null, elsewhere = false } = {}) {
    super(`buyfiro.app: ${code}${httpStatus ? t(' (HTTP {httpStatus})', { httpStatus }) : ''}`);
    /** One of ERROR_CODES, 'blocked' (not JSON), 'network' (no answer), 'unexpected_answer', 'order_exists', 'sandbox_required' or 'unknown'. */
    this.code = code;
    /** The code exactly as sent. */
    this.rawCode = rawCode ?? code;
    /** The smallest sell in FIRO, when the amount was under it and buyfiro.app said. */
    this.minimumFiro = minimumFiro;
    /** The largest sell in FIRO, when the amount was over it and buyfiro.app said. */
    this.maximumFiro = maximumFiro;
    /** Ask again no sooner than this. */
    this.retryAfterMs = retryAfterMs;
    this.httpStatus = httpStatus;
    /** For 'network': what the browser said ("timeout", "TypeError: Load failed"). */
    this.cause = cause;
    /** For 'bad_body': the fields buyfiro.app did not know. */
    this.unknownFields = unknownFields;
    /** For 'order_exists': the open sell buyfiro.app already has for this payout, and its amount. */
    this.orderId = orderId;
    this.amountFiro = amountFiro;
    /** For 'order_exists': that sell was made from another wallet or device (buyfiro.app's reused, not this wallet's). */
    this.elsewhere = Boolean(elsewhere);
  }

  /** The amount is under the smallest sell. */
  get belowMinimum() {
    return this.code === 'amount_below_minimum';
  }

  /** The amount is over the largest sell. */
  get aboveMaximum() {
    return this.code === 'amount_above_maximum';
  }

  /** No answer from buyfiro.app at all. */
  get unreachable() {
    return this.code === 'blocked' || this.code === 'network';
  }
}

function errorFromJson(e, { httpStatus, retryAfterMs }) {
  const raw = typeof e.code === 'string' ? e.code : '';
  const code = ERROR_CODES.includes(raw) ? raw : 'unknown';
  const unknownFields = Array.isArray(e.unknown_fields) ? e.unknown_fields.filter((x) => typeof x === 'string') : null;
  return new SellError(code, { rawCode: raw, minimumFiro: num(e.minimum_firo), maximumFiro: num(e.maximum_firo), retryAfterMs: seconds(e.retry_after) ?? retryAfterMs, httpStatus, unknownFields });
}

// ----------------------------------------------------------------- amounts

/**
 * Amounts are the wallet's own: satoshi as BigInt (1 FIRO = 100,000,000).
 * buyfiro.app reads amount_firo as a JSON number; the app sends the decimal
 * the person typed and checks that the number it gets back is the same
 * satoshi amount before it shows anything.
 */
export function firoNumber(sats) {
  return Number(toInputString(sats));
}

/** A FIRO figure buyfiro.app sent → satoshi (BigInt); null for anything that is not a number of 0 or more. */
export function satsOf(v) {
  const n = num(v);
  if (n === null || n < 0) return null;
  return BigInt(Math.round(n * 1e8));
}

/** Whether buyfiro.app reads `sats` exactly as sent (a JSON number carries it). */
export function exactForApi(sats) {
  return typeof sats === 'bigint' && sats > 0n && satsOf(firoNumber(sats)) === sats;
}

// ----------------------------------------------------------------- payouts

/** The chain's own coin, as a payout token. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
/** Tether's USDT on BNB Chain: paid straight from buyfiro.app's bank, the lowest minimum and the fastest. */
export const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
/** What a sell pays by default: USDT on BNB Chain. */
export const DEFAULT_PAYOUT = Object.freeze({ chainId: 56, chainName: 'BNB Chain', token: USDT_BSC, symbol: 'USDT' });

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Chain names people know, where buyfiro.app's differ. */
const CHAIN_NAMES = Object.freeze({ 56: 'BNB Chain', 1: 'Ethereum' });

export function payoutChainName(chainId, apiName = null) {
  if (Object.hasOwn(CHAIN_NAMES, chainId)) return CHAIN_NAMES[chainId];
  return typeof apiName === 'string' && apiName ? clean(apiName, 30) : t('Chain {chainId}', { chainId });
}

/** The chains Campfire's own Ethereum & BNB wallet shows (others pay to the same address, seen elsewhere). */
export const WALLET_CHAINS = Object.freeze([1, 56]);

/** Text from a token's creator or the API: no control or direction characters, at most `max` long. */
export function clean(v, max = 40) {
  return (
    String(v ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
      .trim()
      .slice(0, max)
  );
}

/** A chain buyfiro.app pays on; null for an entry this version cannot read. */
export function payoutChainFromJson(j) {
  if (!j || typeof j !== 'object' || !Number.isSafeInteger(j.chain_id) || j.chain_id <= 0) return null;
  return Object.freeze({ chainId: j.chain_id, name: payoutChainName(j.chain_id, j.name) });
}

/** A token buyfiro.app pays on one chain; null for an entry this version cannot read. */
export function payoutTokenFromJson(j, chainId) {
  if (!j || typeof j !== 'object' || typeof j.token !== 'string' || !EVM_ADDRESS.test(j.token)) return null;
  const symbol = clean(j.symbol, 20);
  if (!symbol) return null;
  const decimals = Number.isSafeInteger(j.decimals) && j.decimals >= 0 && j.decimals <= 36 ? j.decimals : null;
  return Object.freeze({ chainId, token: j.token, symbol, name: clean(j.name, 40) || symbol, decimals, isNative: j.token === NATIVE_TOKEN });
}

/** Two token addresses are the same contract (buyfiro.app answers in lower case). */
export function sameToken(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The smallest and largest sell for a payout, in FIRO, as a hint for the form: /quote decides. */
export function limitsFromJson(j) {
  return Object.freeze({ minimumFiro: num(j.minimum_firo), maximumFiro: num(j.maximum_firo), route: typeof j.payout_route === 'string' ? j.payout_route : null });
}

// ------------------------------------------------------------------ states

/** Where a sell is, as buyfiro.app says it. Anything else is 'in_progress': still going, keep asking. */
export const STATES = Object.freeze(['awaiting_deposit', 'deposit_detected', 'selling', 'limit_open', 'paying_out', 'delivered', 'expired', 'refused', 'attention']);
const FINAL = new Set(['delivered', 'expired', 'refused']);

export function parseState(s) {
  return STATES.includes(s) ? s : 'in_progress';
}

/** buyfiro.app will not change it again. */
export function isFinalState(s) {
  return FINAL.has(s);
}

/** Every state a sandbox order can be forced into (the ladder and the endings). */
export const FORCEABLE = Object.freeze(['awaiting_deposit', 'deposit_detected', 'selling', 'limit_open', 'paying_out', 'delivered', 'expired', 'refused', 'attention']);

// ------------------------------------------------------------------ client

export const DEFAULT_TIMEOUT_MS = 60000;
const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PAYOUT_TXID = /^[A-Za-z0-9_]{1,200}$/;

export class SellClient {
  /**
   * fetch: the window's fetch (tests inject one). sandbox: buyfiro.app's test
   * mode (no funds, nothing payable): every call carries ?sandbox=true in its
   * URL and the order's body says sandbox: true as well. classifyAddress: the
   * wallet's own (text → {kind}); a deposit address is used only when it reads
   * as the kind asked for.
   */
  constructor({ fetch: fetchImpl = null, base = sellApiBase(), sandbox = false, timeoutMs = DEFAULT_TIMEOUT_MS, classifyAddress = null } = {}) {
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    /** Requests go to the real network (no fetch was handed in). */
    this.realNetwork = !fetchImpl;
    this.base = base;
    this.sandbox = sandbox === true;
    this.timeoutMs = timeoutMs;
    this.classifyAddress = typeof classifyAddress === 'function' ? classifyAddress : null;
  }

  /** The chains buyfiro.app pays on: {chains: [{chainId, name}], recommended: {chainId, token, symbol} | null}. */
  async payoutChains() {
    const j = await this._send('GET', '/payout-chains');
    if (!Array.isArray(j.chains)) throw new SellError('unexpected_answer');
    const chains = j.chains.map(payoutChainFromJson).filter(Boolean);
    const r = j.recommended;
    const recommended = r && Number.isSafeInteger(r.chain_id) && typeof r.token === 'string' && EVM_ADDRESS.test(r.token) ? Object.freeze({ chainId: r.chain_id, token: r.token, symbol: clean(r.symbol, 20) }) : null;
    return Object.freeze({ chains, recommended });
  }

  /** The tokens paid on chainId (symbol: only those with that ticker), in buyfiro.app's order: {tokens, truncated}. */
  async payoutTokens(chainId, { symbol = null } = {}) {
    const query = { chain_id: String(chainId) };
    if (symbol) query.symbol = symbol;
    const j = await this._send('GET', '/payout-tokens', { query });
    if (!Array.isArray(j.tokens) || (j.chain_id != null && j.chain_id !== chainId)) throw new SellError('unexpected_answer');
    return Object.freeze({ tokens: j.tokens.map((item) => payoutTokenFromJson(item, chainId)).filter(Boolean), truncated: j.truncated === true });
  }

  /** The smallest and largest sell for a payout ({chainId, token}), in FIRO. */
  async limits(payout = null) {
    const query = payout ? { payout_chain_id: String(payout.chainId), payout_token: payout.token } : null;
    return limitsFromJson(await this._send('GET', '/limits', { query }));
  }

  /** Whether buyfiro.app runs, and takes Spark (private) deposits now: for a status line, never to gate a sell. */
  async health() {
    const j = await this._send('GET', '/health');
    return Object.freeze({ healthy: j.healthy === true, sparkDeposits: j.spark_deposits === true });
  }

  /**
   * What selling `amount` (satoshi) brings, paid as payout ({chainId, token}).
   * Refused unless the answer is about this amount. Under the smallest or over
   * the largest sell the answer itself names (minimum_firo, maximum_firo), it is
   * the matching refusal.
   */
  async quote({ amount, payout }) {
    if (!exactForApi(amount)) throw new SellError('bad_amount');
    const j = await this._send('GET', '/quote', { query: { amount_firo: String(firoNumber(amount)), payout_chain_id: String(payout.chainId), payout_token: payout.token } });
    const receive = num(j.receive_usd_estimate);
    if (satsOf(j.amount_firo) !== amount || receive === null || receive < 0) throw new SellError('unexpected_answer');
    if ((j.payout_chain_id != null && j.payout_chain_id !== payout.chainId) || (j.payout_token != null && !sameToken(j.payout_token, payout.token))) throw new SellError('unexpected_answer');
    const minimumFiro = num(j.minimum_firo);
    const maximumFiro = num(j.maximum_firo);
    if (minimumFiro !== null && amount < satsOf(minimumFiro)) throw new SellError('amount_below_minimum', { minimumFiro, maximumFiro });
    if (maximumFiro !== null && amount > satsOf(maximumFiro)) throw new SellError('amount_above_maximum', { minimumFiro, maximumFiro });
    return Object.freeze({
      amount,
      /** What arrives, in US dollars at today's price (in the chosen token for another payout): nothing to subtract. */
      receiveUsd: receive,
      /** 'direct' (USDT on BNB Chain, from buyfiro.app's bank), or a cross-chain swap. */
      route: typeof j.payout_route === 'string' ? j.payout_route : null,
      minimumFiro,
      maximumFiro,
    });
  }

  /**
   * A FIRO deposit address for selling `amount` (satoshi), paid as payout
   * ({chainId, token, address}). depositKind 'spark' also returns a Spark
   * (private) deposit address; 'firo' a transparent one only. Asking again for
   * the same payout before it is funded returns the same order. Refused
   * ('unexpected_answer') unless the answer is exactly this order, can be paid
   * (outside test mode), and its addresses are Firo addresses of the right kind.
   */
  async order({ amount, payout, depositKind }) {
    if (depositKind !== 'spark' && depositKind !== 'firo') throw new TypeError(t('depositKind must be spark or firo'));
    if (!exactForApi(amount)) throw new SellError('bad_amount');
    if (!EVM_ADDRESS.test(String(payout.address)) || !EVM_ADDRESS.test(String(payout.token))) throw new SellError('payout_address_invalid');
    const body = { amount_firo: firoNumber(amount), payout_chain_id: payout.chainId, payout_token: payout.token, payout_address: payout.address, deposit_kind: depositKind, order_type: 'market' };
    const j = await this._send('POST', '/order', { body });
    const bad = () => new SellError('unexpected_answer');
    const id = j.order_id;
    if (typeof id !== 'string' || !ORDER_ID.test(id)) throw bad();
    // A test-mode order is buyfiro.app's sandbox's ("sbx_…"): never a real one made while testing.
    if (this.sandbox && !id.startsWith('sbx_')) throw bad();
    const reused = j.reused === true;
    const echoed = satsOf(j.amount_firo);
    if (echoed !== amount || j.deposit_kind !== depositKind) {
      // The open sell buyfiro.app keeps for this payout, for another amount: not this one.
      if (reused && echoed !== null) throw new SellError('order_exists', { orderId: id, amountFiro: num(j.amount_firo) });
      throw bad();
    }
    if (j.order_type != null && j.order_type !== 'market') throw bad();
    const p = j.payout;
    if (p != null) {
      if (typeof p !== 'object' || p.chain_id !== payout.chainId || !sameToken(p.token, payout.token) || typeof p.address !== 'string' || p.address.toLowerCase() !== payout.address.toLowerCase()) throw bad();
    } else if (!this.sandbox) throw bad();
    const payable = j.payable === true;
    if (!this.sandbox && !payable) throw bad();
    const deposit = typeof j.deposit_address === 'string' ? j.deposit_address.trim() : '';
    const spark = typeof j.spark_deposit_address === 'string' && j.spark_deposit_address.trim() ? j.spark_deposit_address.trim() : null;
    if (!deposit) throw bad();
    if (payable) {
      if (this.kind(deposit) !== 'transparent') throw bad();
      if (depositKind === 'spark' && (!spark || this.kind(spark) !== 'spark')) throw bad();
      if (depositKind === 'firo' && spark !== null && this.kind(spark) !== 'spark') throw bad();
    } else if (depositKind === 'spark' && !spark) throw bad();
    const hours = num(j.expires_in_h);
    return Object.freeze({
      /** The sell's handle at buyfiro.app. */
      orderId: id,
      amount,
      depositKind,
      /** Where FIRO from the public balance (or any wallet) goes: transparent. */
      depositAddress: deposit,
      /** Where FIRO from the private balance goes (deposit_kind 'spark'). */
      sparkDepositAddress: depositKind === 'spark' ? spark : null,
      payable,
      /** True when the same order already existed (a retry): still success. */
      reused,
      receiveUsd: num(j.receive_usd_estimate),
      /** After this long unfunded, the order lapses. */
      expiresInMs: hours !== null && hours > 0 ? Math.round(hours * 3600 * 1000) : null,
    });
  }

  /** Where the sell orderId is. forceState: sandbox only (buyfiro.app answers with that state). */
  async status(orderId, { forceState = null } = {}) {
    const id = forceState && this.sandbox ? `${orderId}:${forceState}` : orderId;
    const j = await this._send('GET', `/order/${encodeURIComponent(id)}`);
    // The sandbox echoes a forced id with its ":<state>".
    if (j.order_id !== orderId && j.order_id !== id) throw new SellError('unexpected_answer');
    const rawState = typeof j.state === 'string' ? j.state : '';
    const state = parseState(rawState);
    const after = seconds(j.poll_after_seconds);
    const p = j.payout && typeof j.payout === 'object' ? j.payout : null;
    return Object.freeze({
      orderId,
      state,
      rawState,
      // Only a state the app knows as an ending ends the polling.
      terminal: j.terminal === true && isFinalState(state),
      pollAfterMs: after === null || after <= 0 ? null : after,
      receivedFiro: num(j.received_firo),
      proceedsUsd: num(j.proceeds_usd),
      payout: p ? Object.freeze({ chainId: Number.isSafeInteger(p.chain_id) ? p.chain_id : null, token: typeof p.token === 'string' ? p.token : null, address: typeof p.address === 'string' ? p.address : null, symbol: p.symbol == null ? null : clean(p.symbol, 20) }) : null,
      payoutTxid: typeof j.payout_txid === 'string' && PAYOUT_TXID.test(j.payout_txid) ? j.payout_txid : null,
      /** buyfiro.app's link to the payout; shown only through hosts.js payoutTxUrl(). */
      payoutExplorer: typeof j.payout_explorer === 'string' ? j.payout_explorer : null,
    });
  }

  kind(text) {
    if (!this.classifyAddress) return 'invalid';
    try {
      const c = this.classifyAddress(text);
      return c && typeof c.kind === 'string' ? c.kind : 'invalid';
    } catch {
      return 'invalid';
    }
  }

  async _send(method, path, { query = null, body = null } = {}) {
    // A test may never reach buyfiro.app outside its test mode: under a test runner a request
    // through the real network goes out in sandbox mode or not at all.
    if (this.realNetwork && !this.sandbox && underTest()) throw new SellError('sandbox_required');
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
      throw new SellError('network', { cause: e && e.message === 'timeout' ? 'timeout' : `${(e && e.name) || t('Error')}: ${(e && e.message) || e}` });
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
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new SellError('blocked', { httpStatus: status });
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
    throw new SellError('unexpected_answer', { httpStatus: status });
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

/** Seconds (number or numeric string) → ms; null for anything else or a negative. */
function seconds(v) {
  const d = num(v);
  if (d === null || d < 0) return null;
  return Math.round(d * 1000);
}
