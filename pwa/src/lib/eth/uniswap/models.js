// Tokens, pools, routes and quotes for the Uniswap swap. A port of the
// desktop app's lib/wallets/ethereum/uniswap/uniswap_models.dart.
//
// ETH and WETH are one asset to a person and two to Uniswap: v2 and v3 pools
// hold WETH, v4 pools hold either. A UniToken is what the person holds; a
// pool side is a raw currency address. poolCurrencies says which pool sides
// a token can trade through, and the router converts ETH ⇄ WETH on the way
// (planner.js).
//
// Every address in here is 0x + 40 lowercase hex; amounts are bigint.

import { abiEncode } from '../abi.js';
import { keccak256, normAddress } from '../crypto.js';
import { bytesToHex, hexToBytes, concatBytes } from '../hex.js';
import { NATIVE_ETH, WETH, V4_DYNAMIC_FEE_FLAG } from './constants.js';

export class UniToken {
  constructor({ address, symbol, decimals, name = null }) {
    this.address = address === null || address === undefined ? NATIVE_ETH : normAddress(address);
    this.symbol = String(symbol);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`bad decimals for ${symbol}`);
    this.decimals = decimals;
    this.name = name;
    Object.freeze(this);
  }

  get isEth() {
    return this.address === NATIVE_ETH;
  }

  get isWeth() {
    return this.address === WETH;
  }

  /** ETH and WETH: the same asset, two forms. */
  get isEthLike() {
    return this.isEth || this.isWeth;
  }

  /** The pool sides this token trades through: for ETH and WETH both native ETH (v4) and WETH. */
  get poolCurrencies() {
    return this.isEthLike ? [NATIVE_ETH, WETH] : [this.address];
  }

  sameAsset(other) {
    return this.address === other.address || (this.isEthLike && other.isEthLike);
  }

  toString() {
    return this.symbol;
  }
}

export const ETH_TOKEN = new UniToken({ address: NATIVE_ETH, symbol: 'ETH', decimals: 18, name: 'Ether' });

/** A UniToken from a tokens.js entry (whose ETH has address null). */
export function uniTokenOf(t) {
  return new UniToken({ address: t.address ?? NATIVE_ETH, symbol: t.symbol, decimals: t.decimals, name: t.name ?? null });
}

function int(v, lo, hi, what) {
  if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`bad ${what}: ${v}`);
  return v;
}

/** One Uniswap pool; currency0 < currency1 as Uniswap sorts them. */
class UniPool {
  constructor(currency0, currency1) {
    this.currency0 = normAddress(currency0);
    this.currency1 = normAddress(currency1);
    if (!(this.currency0 < this.currency1)) throw new Error('pool currencies out of order');
  }

  has(currency) {
    return this.currency0 === currency || this.currency1 === currency;
  }

  other(currency) {
    return currency === this.currency0 ? this.currency1 : this.currency0;
  }
}

export class UniV2Pool extends UniPool {
  constructor({ pair, currency0, currency1 }) {
    super(currency0, currency1);
    if (this.currency0 === NATIVE_ETH) throw new Error('v2 has no native ETH pools');
    this.pair = normAddress(pair);
    this.id = this.pair;
    Object.freeze(this);
  }

  get version() {
    return 'v2';
  }

  get fee() {
    return 3000;
  }

  toJson() {
    return { v: 'v2', pair: this.pair, c0: this.currency0, c1: this.currency1 };
  }
}

export class UniV3Pool extends UniPool {
  constructor({ pool, currency0, currency1, fee, tickSpacing }) {
    super(currency0, currency1);
    if (this.currency0 === NATIVE_ETH) throw new Error('v3 has no native ETH pools');
    this.pool = normAddress(pool);
    this.fee = int(fee, 0, 0xffffff, 'fee');
    this.tickSpacing = int(tickSpacing, 1, 0x7fffff, 'tick spacing');
    this.id = this.pool;
    Object.freeze(this);
  }

  get version() {
    return 'v3';
  }

  toJson() {
    return { v: 'v3', pool: this.pool, c0: this.currency0, c1: this.currency1, fee: this.fee, ts: this.tickSpacing };
  }
}

export class UniV4Pool extends UniPool {
  /** fee: as stored in the pool key (it may carry V4_DYNAMIC_FEE_FLAG). */
  constructor({ currency0, currency1, fee, tickSpacing, hooks }) {
    super(currency0, currency1);
    this.feeField = int(fee, 0, 0xffffff, 'fee');
    this.tickSpacing = int(tickSpacing, 1, 0x7fffff, 'tick spacing');
    this.hooks = normAddress(hooks);
    /** keccak256(abi.encode(PoolKey)): the pool's id. */
    this.id = bytesToHex(keccak256(abiEncode('address,address,uint24,int24,address', this.key)));
    Object.freeze(this);
  }

  get version() {
    return 'v4';
  }

  get isDynamicFee() {
    return (this.feeField & V4_DYNAMIC_FEE_FLAG) !== 0;
  }

  /** Fee in hundredths of a bip; null for a pool whose hook sets the fee per swap. */
  get fee() {
    return this.isDynamicFee ? null : this.feeField;
  }

  get hasHooks() {
    return this.hooks !== NATIVE_ETH;
  }

  /** The PoolKey tuple: (currency0, currency1, fee, tickSpacing, hooks). */
  get key() {
    return [this.currency0, this.currency1, this.feeField, this.tickSpacing, this.hooks];
  }

  toJson() {
    return { v: 'v4', c0: this.currency0, c1: this.currency1, fee: this.feeField, ts: this.tickSpacing, hooks: this.hooks };
  }
}

/** A pool from its toJson() form (the desktop app's UniPool.fromJson). Throws on anything malformed. */
export function poolFromJson(j) {
  if (!j || typeof j !== 'object') throw new Error('not a pool');
  switch (j.v) {
    case 'v2':
      return new UniV2Pool({ pair: j.pair, currency0: j.c0, currency1: j.c1 });
    case 'v3':
      return new UniV3Pool({ pool: j.pool, currency0: j.c0, currency1: j.c1, fee: j.fee, tickSpacing: j.ts });
    case 'v4':
      return new UniV4Pool({ currency0: j.c0, currency1: j.c1, fee: j.fee, tickSpacing: j.ts, hooks: j.hooks });
    default:
      throw new Error(`unknown pool ${j.v}`);
  }
}

/** One step of a route: `pool` from currencyIn to currencyOut (raw pool sides). */
export class UniHop {
  constructor(pool, currencyIn, currencyOut) {
    this.pool = pool;
    this.currencyIn = currencyIn;
    this.currencyOut = currencyOut;
    if (!pool.has(currencyIn) || pool.other(currencyIn) !== currencyOut || currencyIn === currencyOut) throw new Error('a hop must cross its pool');
    Object.freeze(this);
  }

  get zeroForOne() {
    return this.currencyIn === this.pool.currency0;
  }
}

/** The pools a swap goes through, in order. */
export class UniRoute {
  constructor(hops) {
    if (!hops.length) throw new Error('a route has at least one pool');
    this.hops = Object.freeze([...hops]);
    Object.freeze(this);
  }

  get isDirect() {
    return this.hops.length === 1;
  }

  get pools() {
    return this.hops.map((h) => h.pool);
  }

  get id() {
    return this.hops.map((h) => h.pool.id).join('>');
  }
}

/** The least `amountOut` less `slippageBips` / 10,000 allows. */
export function minimumOf(amountOut, slippageBips) {
  if (!Number.isInteger(slippageBips) || slippageBips < 0 || slippageBips >= 10000) throw new Error(`bad price protection: ${slippageBips}`);
  return (amountOut * BigInt(10000 - slippageBips)) / 10000n;
}

/** One share of a swap: amountIn of it through route. */
export class UniPart {
  constructor({ route, amountIn, amountOut, hopOutputs, gas }) {
    this.route = route;
    this.amountIn = amountIn;
    this.amountOut = amountOut;
    /** What each pool of the route gives, in order (the last is amountOut). */
    this.hopOutputs = Object.freeze([...hopOutputs]);
    /** The quoters' gas estimate for this share's swaps. */
    this.gas = gas;
    Object.freeze(this);
  }

  /**
   * The least this share may give. The router checks it on this share's last
   * pool, so no pool can be pushed further than this on its own.
   */
  minimumOut(slippageBips) {
    return minimumOf(this.amountOut, slippageBips);
  }
}

/**
 * A price for swapping amountIn of tokenIn into tokenOut, split between one
 * or more routes (parts, largest share first). Spread over every pool that
 * adds to the result, each pool moves less (less for a front-runner to wait
 * for), and each share carries its own minimum, checked on that pool.
 */
export class UniQuote {
  constructor({ tokenIn, tokenOut, amountIn, parts, gasEstimate, priceImpact = null, block }) {
    this.tokenIn = tokenIn;
    this.tokenOut = tokenOut;
    this.amountIn = amountIn;
    this.parts = Object.freeze([...parts].sort((a, b) => (b.amountIn > a.amountIn ? 1 : b.amountIn < a.amountIn ? -1 : 0)));
    /** What all the shares give together. */
    this.amountOut = parts.reduce((s, p) => s + p.amountOut, 0n);
    /** The quoters' gas estimate for the swaps alone; the real limit comes from eth_estimateGas. */
    this.gasEstimate = gasEstimate;
    /** How much worse this is than the pools' current prices, as a fraction (0.031 = 3.1 %); null when unknown. */
    this.priceImpact = priceImpact;
    /** The block the quote was read at. */
    this.block = block;
    Object.freeze(this);
  }

  static single({ tokenIn, tokenOut, amountIn, amountOut, route, hopOutputs, gasEstimate, priceImpact = null, block }) {
    return new UniQuote({ tokenIn, tokenOut, amountIn, parts: [new UniPart({ route, amountIn, amountOut, hopOutputs, gas: gasEstimate })], gasEstimate, priceImpact, block });
  }

  get isSplit() {
    return this.parts.length > 1;
  }

  /** The largest share's route. */
  get route() {
    return this.parts[0].route;
  }

  /** Every pool the swap goes through. */
  get pools() {
    return this.parts.flatMap((p) => p.route.pools);
  }

  /** The least the person accepts: each share's minimum, added up. */
  minimumOut(slippageBips) {
    return this.parts.reduce((s, p) => s + p.minimumOut(slippageBips), 0n);
  }

  /** The share of the amount in that `part` carries (0–1). */
  shareOf(part) {
    return this.amountIn === 0n ? 0 : Number(part.amountIn) / Number(this.amountIn);
  }
}

/** An address as an indexed event topic. */
export function topicOfAddress(address) {
  return `0x${normAddress(address).slice(2).padStart(64, '0')}`;
}

export function addressOfTopic(topic) {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/** The two currencies in Uniswap's order (lower address first). */
export function sortCurrencies(a, b) {
  const x = normAddress(a);
  const y = normAddress(b);
  return x < y ? [x, y] : [y, x];
}

/** Bytes of a v3 path: token, fee (3 bytes), token, … */
export function v3Path(tokens, fees) {
  const parts = [];
  tokens.forEach((t, i) => {
    parts.push(hexToBytes(normAddress(t)));
    if (i < fees.length) parts.push(Uint8Array.of((fees[i] >> 16) & 0xff, (fees[i] >> 8) & 0xff, fees[i] & 0xff));
  });
  return concatBytes(...parts);
}
