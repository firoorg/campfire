// NEAR Intents' 1Click swap API: any coin 1Click takes (BTC, ZEC, LTC, USDT on
// Tron, …) into ETH on Ethereum or BNB on BNB Chain, delivered to this EVM
// wallet's own address (the same on both chains). A port of the desktop app's
// lib/wallets/ethereum/near_intents/one_click_client.dart:
//
//   GET  /v0/tokens                  the coins and chains it takes
//   POST /v0/quote  (dry: true)      a price, no deposit address
//   POST /v0/quote  (dry: false)     a price and a deposit address
//   GET  /v0/status?depositAddress=  where a swap is
//
// Every quote is signed by 1Click (ed25519, MANAGER_KEY: the key its
// TypeScript SDK 0.1.26 verifies with, "ONE_CLICK_MANAGER_PUB_KEY"). The
// signature is checked, and what it covers is compared with what was asked,
// before a deposit address is ever shown: an address 1Click did not issue for
// exactly this swap never reaches the screen, whatever happens between the
// browser and the API. That includes the deadline asked for (to the
// millisecond, so a quote signed for an earlier request cannot be passed off
// as this one's) and the time 1Click quoted, which must be recent.
//
// What 1Click learns: the browser's IP address, the coin and amount, the
// refund address on the coin's chain and this wallet's Ethereum address (the
// recipient). Never a key, never the Firo wallet: the only address of this
// app it is given is the Ethereum one the ETH goes to. Requests carry no
// cookies and no referrer.
//
// TODO(FIRO via Intents): 1Click does not list FIRO today. When it does, a swap could deliver
// FIRO straight to this wallet's Spark or transparent address instead of ETH (a destination
// asset other than ETH_ON_ETHEREUM, and the Firo wallet's address as recipient).
//
// Without a partner key 1Click adds 0.25% to each quote (its "Fees" page);
// the quote's amounts already include it.

import { intentsApiBase } from './hosts.js';
import { base58 } from '../../vendor/noble/scure-base/index.js';
import { chainName, chainNameEnglish, EVM_CHAINS, CHAINS } from '../eth/chains.js';
import { t } from '../i18n.js';

/** 1Click's quote-signing key ("ONE_CLICK_MANAGER_PUB_KEY" in its SDK 0.1.26). */
export const MANAGER_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

/** ETH on Ethereum, as 1Click names it. */
export const ETH_ON_ETHEREUM = 'nep141:eth.omft.near';

/**
 * What a swap here can deliver, by the wallet's chain key: ETH on Ethereum, BNB on BNB Chain
 * (both checked against 1Click's /v0/tokens on 2026-10-12: 18 decimals each).
 */
export const DESTINATIONS = Object.freeze({ ethereum: CHAINS.ethereum.intentsAsset, bsc: CHAINS.bsc.intentsAsset });

/** The wallet chain ('ethereum' | 'bsc') a 1Click destination asset is, or null. */
export function destinationChainOf(assetId) {
  return Object.keys(DESTINATIONS).find((k) => DESTINATIONS[k] === assetId) || null;
}

/** 1% price protection, as the desktop app asks. */
export const DEFAULT_SLIPPAGE_BIPS = 100;

/** How long a deposit address is asked for (1Click may give longer). */
export const DEPOSIT_WINDOW_MS = 60 * 60 * 1000;

/** A quote stamped longer ago than this (by this device's clock) is refused as stale; a few minutes of clock difference pass. */
export const QUOTE_MAX_AGE_MS = 5 * 60 * 1000;

export const DEFAULT_TIMEOUT_MS = 45000;

// ------------------------------------------------------------------ errors

/**
 * Why there is no usable answer. code:
 *   'refused'      1Click said no; message is its own words ("Amount is too low…")
 *   'network'      no answer at all (offline, timeout, blocked by the browser)
 *   'blocked'      something that is not 1Click's JSON came back (a proxy page)
 *   'busy'         1Click asked to slow down (HTTP 429)
 *   'unsigned'     the quote's signature does not check out: nothing to send to
 *   'cannot_verify' this browser cannot check an ed25519 signature
 *   'mismatch'     the signed quote is not for what was asked
 *   'stale'        the quote's time is too long ago: not a fresh answer to this request
 *   'no_address'   no deposit address in a real quote
 *   'not_found'    1Click does not know this deposit address
 *   'unexpected'   an answer this version cannot read
 */
export class OneClickError extends Error {
  constructor(code, message = '', { status = null, cause = null } = {}) {
    super(message || code);
    this.code = code;
    /** 1Click's own words when it gave any. */
    this.said = code === 'refused' ? message : null;
    this.status = status;
    this.cause = cause;
  }

  /** No answer from 1Click at all: not its refusal. */
  get unreachable() {
    return this.code === 'network' || this.code === 'blocked' || this.code === 'busy';
  }
}

// ------------------------------------------------------------------ coins

/** A coin on a chain 1Click swaps; null for an entry this version cannot read. */
export function tokenFromJson(j) {
  if (!j || typeof j !== 'object') return null;
  const { assetId, symbol, blockchain, decimals } = j;
  if (typeof assetId !== 'string' || !assetId || typeof symbol !== 'string' || !symbol || typeof blockchain !== 'string' || !blockchain) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const contract = typeof j.contractAddress === 'string' && j.contractAddress ? j.contractAddress : null;
  const price = typeof j.price === 'number' && Number.isFinite(j.price) && j.price > 0 ? j.price : null;
  return Object.freeze({
    assetId,
    symbol,
    blockchain,
    decimals,
    priceUsd: price,
    /** Null for a chain's own coin (BTC, ZEC, SOL…). */
    contractAddress: contract,
    isNative: contract === null,
    /** "Bitcoin", "Tron", "BNB Chain"… */
    chainName: chainName(blockchain),
    chainNameEn: chainNameEnglish(blockchain),
    /** Addresses on this chain are Ethereum's (0x and 40 hex digits). */
    isEvm: EVM_CHAINS.has(blockchain),
  });
}

/** The fields a swap keeps of its coin. */
export function tokenToJson(token) {
  const j = { assetId: token.assetId, symbol: token.symbol, blockchain: token.blockchain, decimals: token.decimals };
  if (token.priceUsd != null) j.price = token.priceUsd;
  if (token.contractAddress != null) j.contractAddress = token.contractAddress;
  return j;
}

/** The coins people bring most, first (BTC, ZEC, LTC and the main coins by traffic), as [symbol, chain]: the desktop app's kOneClickPopular. */
export const POPULAR = Object.freeze([
  ['BTC', 'btc'],
  ['ZEC', 'zec'],
  ['LTC', 'ltc'],
  ['USDT', 'tron'],
  ['USDT', 'eth'],
  ['USDC', 'sol'],
  ['USDC', 'base'],
  ['SOL', 'sol'],
  ['XRP', 'xrp'],
  ['DOGE', 'doge'],
  ['BNB', 'bsc'],
  ['USDT', 'bsc'],
  ['TRX', 'tron'],
  ['TON', 'ton'],
  ['BCH', 'bch'],
  ['DASH', 'dash'],
  ['ADA', 'cardano'],
  ['SUI', 'sui'],
  ['AVAX', 'avax'],
  ['POL', 'pol'],
  ['wNEAR', 'near'],
  ['ETH', 'arb'],
  ['ETH', 'base'],
  ['ETH', 'op'],
]);

export function isPopular(token) {
  return POPULAR.some(([s, c]) => s === token.symbol && c === token.blockchain);
}

/** In picker order: POPULAR first, in its order; then each chain's own coin; then the rest; ties by chain name, then symbol. */
export function sortTokens(list) {
  const rank = (token) => {
    const i = POPULAR.findIndex(([s, c]) => s === token.symbol && c === token.blockchain);
    if (i >= 0) return i;
    return POPULAR.length + (token.isNative ? 0 : 1000);
  };
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || cmp(a.chainName, b.chainName) || cmp(a.symbol, b.symbol));
}

/** Every coin 1Click takes except ETH on Ethereum itself (what arrives), in picker order. */
export function payableTokens(list, destination = 'ethereum') {
  const into = DESTINATIONS[destination] || ETH_ON_ETHEREUM;
  return sortTokens(list.filter((item) => item.assetId !== into));
}

// ------------------------------------------------------------------ quotes

const UINT = /^[0-9]{1,80}$/;
const big = (v) => (typeof v === 'string' && UINT.test(v) ? BigInt(v) : null);
const usdNum = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const earliest = (...ts) => {
  const known = ts.filter((item) => item != null);
  return known.length ? Math.min(...known) : null;
};
const when = (v) => {
  const item = typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isFinite(item) ? item : null;
};

/**
 * What 1Click quoted, read from its whole answer (kept as it came: 1Click asks
 * integrators to keep the quote and its signature to settle any dispute).
 * Throws OneClickError('unexpected') when the amounts cannot be read.
 */
export function readQuote(raw) {
  const q = raw && typeof raw.quote === 'object' && raw.quote ? raw.quote : null;
  const r = raw && typeof raw.quoteRequest === 'object' && raw.quoteRequest ? raw.quoteRequest : null;
  if (!q || !r || typeof raw.signature !== 'string' || typeof raw.timestamp !== 'string') throw new OneClickError('unexpected', t('NEAR Intents sent an answer Firo PWA cannot read.'));
  const amountIn = big(q.amountIn);
  const amountOut = big(q.amountOut);
  const minAmountOut = big(q.minAmountOut);
  if (amountIn === null || amountOut === null || minAmountOut === null) throw new OneClickError('unexpected', t('NEAR Intents sent an answer Firo PWA cannot read.'));
  const deposit = typeof q.depositAddress === 'string' && q.depositAddress.trim() ? q.depositAddress : null;
  const memo = typeof q.depositMemo === 'string' && q.depositMemo ? q.depositMemo : null;
  const estimate = typeof q.timeEstimate === 'number' && Number.isFinite(q.timeEstimate) && q.timeEstimate >= 0 ? Math.round(q.timeEstimate) : null;
  return Object.freeze({
    raw,
    dry: r.dry === true,
    originAsset: r.originAsset,
    destinationAsset: r.destinationAsset,
    refundTo: r.refundTo,
    recipient: r.recipient,
    amountIn,
    amountOut,
    minAmountOut,
    amountInUsd: usdNum(q.amountInUsd),
    amountOutUsd: usdNum(q.amountOutUsd),
    /** Seconds from the deposit being confirmed to the ETH arriving. */
    timeEstimate: estimate,
    depositAddress: deposit,
    /** Some chains need this memo with the deposit, or the coins are lost. */
    depositMemo: memo,
    /** After this (ms), the deposit address no longer works (1Click gives days). */
    deadline: when(q.deadline),
    /**
     * The time asked for (ms): when refunds begin if the swap is not done by
     * then. What the screens call "send before", the earlier of the two.
     */
    sendBefore: earliest(when(r.deadline), when(q.deadline)),
    signature: raw.signature,
    timestamp: raw.timestamp,
  });
}

// ------------------------------------------------------------------ signature

/** JSON with every object's keys sorted and no spaces, keys whose value is undefined left out (json-stable-stringify). */
export function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',')}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

const or = (v) => v || undefined;

/**
 * What 1Click signs for a quote answer, as its SDK builds it
 * (buildSignedQuoteRequest / buildSignedQuote / hashQuote, 0.1.26): the
 * request's swap fields, the quote's amounts (and for a real quote its
 * deposit address, memo, deadline, times and fees) and the timestamp, as
 * stable JSON. Returns that JSON (the SDK hashes it).
 */
export function signedJson(response) {
  const r = response.quoteRequest;
  const q = response.quote;
  const request = {
    dry: r.dry,
    swapType: r.swapType,
    slippageTolerance: r.slippageTolerance,
    originAsset: r.originAsset,
    depositType: r.depositType,
    destinationAsset: r.destinationAsset,
    amount: r.amount,
    refundTo: r.refundTo,
    refundType: r.refundType,
    recipient: r.recipient,
    recipientType: r.recipientType,
    deadline: r.deadline,
    quoteWaitingTimeMs: or(r.quoteWaitingTimeMs),
    referral: or(r.referral),
    virtualChainRecipient: or(r.virtualChainRecipient),
    virtualChainRefundRecipient: or(r.virtualChainRefundRecipient),
    customRecipientMsg: or(r.customRecipientMsg),
  };
  const amounts = {
    amountIn: q.amountIn,
    amountInFormatted: q.amountInFormatted,
    amountInUsd: q.amountInUsd,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    amountOutFormatted: q.amountOutFormatted,
    amountOutUsd: q.amountOutUsd,
    minAmountOut: q.minAmountOut,
  };
  const quote = r.dry
    ? amounts
    : {
        ...amounts,
        depositAddress: or(q.depositAddress),
        depositMemo: or(q.depositMemo),
        deadline: or(q.deadline),
        timeWhenInactive: or(q.timeWhenInactive),
        timeEstimate: or(q.timeEstimate),
        refundFee: or(q.refundFee),
        withdrawFee: or(q.withdrawFee),
      };
  return stableJson({ ...request, ...quote, timestamp: response.timestamp });
}

const subtle = () => globalThis.crypto && globalThis.crypto.subtle;
const enc = new TextEncoder();

/** base58 of SHA-256 of signedJson(response): the message 1Click's key signs. */
export async function quoteHash(response) {
  const digest = new Uint8Array(await subtle().digest('SHA-256', enc.encode(signedJson(response))));
  return base58.encode(digest);
}

function ed25519Bytes(s) {
  return base58.decode(s.startsWith('ed25519:') ? s.slice(8) : s);
}

let support = null;
/** Whether this browser's WebCrypto checks ed25519 signatures (Safari 17+, Chrome 137+, Firefox 129+). */
export function ed25519Supported() {
  if (!support) {
    support = (async () => {
      try {
        await subtle().importKey('raw', ed25519Bytes(MANAGER_KEY), { name: 'Ed25519' }, false, ['verify']);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return support;
}

/** Whether 1Click's signature on a quote answer checks out, as its SDK's verifyQuoteSignature decides. */
export async function verifyQuote(response, managerKey = MANAGER_KEY) {
  try {
    const key = await subtle().importKey('raw', ed25519Bytes(managerKey), { name: 'Ed25519' }, false, ['verify']);
    const sig = ed25519Bytes(response.signature);
    if (sig.length !== 64) return false;
    return await subtle().verify({ name: 'Ed25519' }, key, sig, enc.encode(await quoteHash(response)));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ states

/** Where a swap is, as 1Click says it. */
export const STATES = Object.freeze(['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS', 'INCOMPLETE_DEPOSIT', 'REFUNDED', 'FAILED']);
const FINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

/** 1Click will not change it again. */
export function isFinalState(s) {
  return FINAL.has(s);
}

/** A status answer → {state, amountOut, refunded, refundReason, destinationTxs, originTxs, updatedAt}. */
export function readStatus(j) {
  if (!j || typeof j !== 'object' || !STATES.includes(j.status)) throw new OneClickError('unexpected', (j && typeof j.status === 'string' ? t('NEAR Intents sent a state Firo PWA does not know ({status}).', { status: j.status }) : t('NEAR Intents sent a state Firo PWA does not know.')));
  const d = j.swapDetails && typeof j.swapDetails === 'object' ? j.swapDetails : {};
  const hashes = (list) => (Array.isArray(list) ? list.filter((tx) => tx && typeof tx.hash === 'string' && tx.hash).map((tx) => tx.hash) : []);
  return Object.freeze({
    state: j.status,
    /** What arrived (wei), once it did (1Click fills the field earlier; only SUCCESS says it arrived). */
    amountOut: j.status === 'SUCCESS' ? big(d.amountOut) : null,
    /** What went back to the refund address (1Click says "0" before any did). */
    refunded: big(d.refundedAmount) || null,
    refundReason: typeof d.refundReason === 'string' && d.refundReason ? d.refundReason : null,
    deposited: big(d.depositedAmount),
    /** Transactions that delivered the ETH on Ethereum. */
    destinationTxs: hashes(d.destinationChainTxHashes),
    originTxs: hashes(d.originChainTxHashes),
    updatedAt: when(j.updatedAt),
  });
}

// ------------------------------------------------------------------ minimums

/**
 * The smallest amount 1Click named when it refused one as too small, in the
 * coin's smallest unit ("Amount is too low for bridge, try at least 8516"),
 * or null when its words name none.
 */
export function minimumFromMessage(said) {
  if (typeof said !== 'string') return null;
  const m = /at least\s+([0-9]{1,40})\b/i.exec(said);
  return m ? BigInt(m[1]) : null;
}

/**
 * A minimum NEAR Intents states in dollars ("Temporary swap limits: minimum swap amount is
 * $1,000", seen 2026-10-12) -> 1000, or null.
 */
export function usdMinimumFromMessage(said) {
  if (typeof said !== 'string') return null;
  const m = /minimum[^$]{0,40}\$\s?([0-9][0-9,]{0,12}(?:\.[0-9]{1,2})?)/i.exec(said);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The coin amount (base units) worth a little over `usd` at the coin's listed price: 2% above,
 * since an amount worth exactly the minimum can price just under it after NEAR's own costs
 * (measured: $1,000 of USDC refused on the BNB Chain route, $1,010 quoted). null without a price.
 */
export function unitsAboveUsd(usd, coin) {
  if (!coin || !(coin.priceUsd > 0) || !(usd > 0)) return null;
  const whole = (usd * 1.02) / coin.priceUsd;
  // Round up at 6 significant digits, so the amount reads cleanly and is never below.
  const digits = Math.max(0, Math.min(coin.decimals, 6 - Math.floor(Math.log10(whole)) - 1));
  const shown = Math.ceil(whole * 10 ** digits);
  return BigInt(shown) * 10n ** BigInt(coin.decimals - digits);
}

/**
 * Whether the coin 1Click echoes in a quote is the one asked for. 1Click now
 * answers some coins with its newer id instead of the one its coin list gives:
 * BTC is asked as "nep141:btc.omft.near" and quoted (and signed) as
 * "1cs_v1:btc:native:coin" (measured 2026-10-11). Accepted only as the same
 * chain and the same coin: the chain's own coin for a native one, the same
 * contract for a token.
 */
export function sameOriginAsset(origin, echoed) {
  if (typeof echoed !== 'string') return false;
  if (echoed === origin.assetId) return true;
  const parts = echoed.split(':');
  if (parts.length !== 4 || parts[0] !== '1cs_v1' || parts[1] !== origin.blockchain) return false;
  if (origin.isNative) return parts[2] === 'native' && parts[3] === 'coin';
  const a = String(origin.contractAddress);
  const b = parts[3];
  return parts[2] !== 'native' && (b === a || (/^0x[0-9a-fA-F]{40}$/.test(a) && b.toLowerCase() === a.toLowerCase()));
}

// ------------------------------------------------------------------ client

export class OneClickClient {
  /** fetch: the window's fetch (tests inject one). */
  constructor({ fetch: fetchImpl = (...a) => globalThis.fetch(...a), base = intentsApiBase(), timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now(), verify = verifyQuote } = {}) {
    this.fetch = fetchImpl;
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.verify = verify;
  }

  /** Every coin 1Click takes (unreadable entries left out), in 1Click's order. */
  async tokens() {
    const body = await this._send('GET', '/tokens');
    if (!Array.isArray(body)) throw new OneClickError('unexpected', t('NEAR Intents sent a coin list Firo PWA cannot read.'));
    return body.map(tokenFromJson).filter(Boolean);
  }

  /**
   * A quote for swapping exactly amountIn (BigInt, smallest unit) of origin
   * into ETH on Ethereum (destination 'ethereum') or BNB on BNB Chain ('bsc')
   * for recipient (this wallet's address); refunds go to
   * refundTo on origin's chain. dry: a price only. Otherwise the answer
   * carries a deposit address, and it is refused unless 1Click's signature
   * over it checks out and it is exactly the swap asked for.
   */
  async quote({ origin, amountIn, recipient, refundTo, dry, destination = 'ethereum', slippageBips = DEFAULT_SLIPPAGE_BIPS, depositWindowMs = DEPOSIT_WINDOW_MS }) {
    if (typeof amountIn !== 'bigint' || amountIn <= 0n) throw new TypeError(t('quote: amountIn must be a positive BigInt'));
    if (!Object.hasOwn(DESTINATIONS, destination)) throw new TypeError(t('quote: destination must be ethereum or bsc'));
    const ask = {
      dry: Boolean(dry),
      swapType: 'EXACT_INPUT',
      slippageTolerance: slippageBips,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: DESTINATIONS[destination],
      amount: amountIn.toString(),
      refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(this.now() + depositWindowMs).toISOString(),
    };
    const body = await this._send('POST', '/quote', ask);
    const q = readQuote(body);
    if (!dry) {
      if (!(await ed25519Supported())) throw new OneClickError('cannot_verify', t("This browser can't check NEAR Intents' signature, so no address is shown."));
      if (!(await this.verify(body))) throw new OneClickError('unsigned', t('The quote is not signed by NEAR Intents. Nothing to send to.'));
    }
    // What was asked for is what was quoted (the signature covers both), deadline included.
    const r = body.quoteRequest;
    const same =
      when(r.deadline) === Date.parse(ask.deadline) &&
      r.dry === ask.dry &&
      r.swapType === ask.swapType &&
      sameOriginAsset(origin, r.originAsset) &&
      r.depositType === ask.depositType &&
      r.destinationAsset === ask.destinationAsset &&
      r.amount === ask.amount &&
      r.refundTo === refundTo &&
      r.refundType === ask.refundType &&
      typeof r.recipient === 'string' &&
      r.recipient.toLowerCase() === recipient.toLowerCase() &&
      r.recipientType === ask.recipientType &&
      Number(r.slippageTolerance) === slippageBips &&
      q.amountIn === amountIn &&
      q.minAmountOut <= q.amountOut;
    if (!same) throw new OneClickError('mismatch', t('The quote does not match what was asked for.'));
    // Fresh: quoted for this request, not long ago (the signed timestamp, by this device's clock).
    const quotedAt = when(body.timestamp);
    if (quotedAt === null || this.now() - quotedAt > QUOTE_MAX_AGE_MS) throw new OneClickError('stale', t('The quote is not recent.'));
    if (!dry && !q.depositAddress) throw new OneClickError('no_address', t('NEAR Intents gave no deposit address.'));
    return q;
  }

  /** Where the swap paid to depositAddress is. */
  async status(depositAddress, { memo = null } = {}) {
    const params = new URLSearchParams({ depositAddress });
    if (memo) params.set('depositMemo', memo);
    return readStatus(await this._send('GET', `/status?${params}`));
  }

  async _send(method, path, json = null) {
    const headers = { accept: 'application/json' };
    if (json) headers['content-type'] = 'application/json';
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
        const r = await this.fetch(`${this.base}${path}`, { method, headers, body: json ? JSON.stringify(json) : undefined, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors', signal: ctrl.signal });
        return [r, await r.text()];
      })();
      [res, text] = await Promise.race([ask, late]);
    } catch (e) {
      // TLS, socket, CORS, the CSP, offline, the time ran out: nothing came back.
      throw new OneClickError('network', t("Couldn't reach NEAR Intents."), { cause: e && e.message === 'timeout' ? 'timeout' : `${(e && e.name) || t('Error')}: ${(e && e.message) || e}` });
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.status === 429) throw new OneClickError('busy', t('NEAR Intents is busy.'), { status: 429 });
    if (res.status >= 400) {
      const msg = body && typeof body === 'object' && typeof body.message === 'string' && body.message.trim() ? body.message.trim() : null;
      if (res.status === 404 && path.startsWith('/status')) throw new OneClickError('not_found', msg || t('NEAR Intents does not know this deposit address.'), { status: 404 });
      if (msg) throw new OneClickError('refused', msg, { status: res.status });
      throw new OneClickError(body === null ? 'blocked' : 'unexpected', t('NEAR Intents answered HTTP {status}.', { status: res.status }), { status: res.status });
    }
    if (body === null || typeof body !== 'object') throw new OneClickError('blocked', t('NEAR Intents sent no data.'), { status: res.status });
    return body;
  }
}
