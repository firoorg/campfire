// Prices a swap on every route Uniswap offers and shares it between the
// routes that, together, give the most. A port of the desktop app's
// lib/wallets/ethereum/uniswap/uniswap_quoter.dart.
//
// Routes tried: every pool between the two tokens (v2, v3, v4, any fee or
// hook), and every two-pool route through ETH, USDC, USDT, DAI or WBTC. Each pool is priced by Uniswap's own quoter contracts (v3 QuoterV2,
// v4 V4Quoter) or, for v2, from the pair's reserves with v2's own formula,
// all through Multicall3.
//
// One pool is rarely the best place for a whole swap: the more of it goes
// through one pool, the further that pool's price moves, and a swap that
// moves one pool a lot is what front-runners wait for. So the amount is cut
// into twentieths and every route is priced at each number of twentieths;
// split.js then picks the sharing that gives the most after gas (each extra
// route costs its own swaps' gas, which only matters on small swaps). The
// search goes in four steps, each one request per 25 prices: every first
// pool at a twentieth and at the whole amount; the second pool of each
// two-pool route the same; then, for the routes that could take part, every
// other twentieth.
//
// A v4 hook is code the pool's creator wrote, and it can tell a quoter one
// price and give a swap another (seen on mainnet: a USDC/WETH pool quoting
// 20 % above the market, whose real swap reverts). Unless the real swap can
// be simulated, a route through a hooked pool takes part only when it is not
// more than HOOKED_EDGE_BIPS better than the best route without hooks.

import { encodeCall, abiDecode } from '../abi.js';
import { ADDRESSES, NATIVE_ETH, WETH, ROUTE_BASES } from './constants.js';
import { UniHop, UniRoute, UniPart, UniQuote, UniV2Pool, UniV3Pool, UniV4Pool } from './models.js';
import { bestSplit, splitCurve } from './split.js';

/** Gas a v2 step costs (v3 and v4 steps use the quoters' own estimates). */
export const V2_HOP_GAS = 90000n;
/** The router's own work around the swaps (commands, transfers, checks). */
export const ROUTER_OVERHEAD_GAS = 80000n;
/** How much better than the best route without hooks a route through a hooked pool may claim to be, unverified. */
export const HOOKED_EDGE_BIPS = 100n;
/** The gas price assumed when the server does not say (it only decides how many routes are worth their gas). */
export const ASSUMED_GAS_PRICE = 1000000000n;
/** How long a pair's ranking of its deepest pools is reused. */
export const RANKING_LIFE_MS = 5 * 60 * 1000;

const ZERO_BYTES = new Uint8Array(0);

/**
 * reason: 'noPool' (no Uniswap pool links the two tokens, directly or through
 * one of the base tokens), 'tooSmall' (every pool gives nothing back), or
 * 'sameAsset'.
 */
export class UniswapNoRoute extends Error {
  constructor(reason) {
    super(`UniswapNoRoute(${reason})`);
    this.code = 'no_route';
    this.reason = reason;
  }
}

/** Uniswap v2's getAmountOut: 0.3 % fee, constant product. */
export function v2AmountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}

function isqrt(n) {
  if (n <= 1n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** A pool's depth, comparable between pools of one pair: liquidity (v3/v4) or √(reserve0·reserve1) (v2). */
export function poolDepth(s) {
  if (s.reserve0 !== null && s.reserve1 !== null) return isqrt(s.reserve0 * s.reserve1);
  return s.liquidity ?? 0n;
}

const big = (a, b) => (a > b ? a : b);
const cmpDesc = (a, b) => (b > a ? 1 : b < a ? -1 : 0);
const pairKey = (a, b) => `${a}|${b}`;
const assetKey = (c) => (c === NATIVE_ETH || c === WETH ? 'eth' : c);

function leg(hop, amountIn, amountOut, gas) {
  return { hop, amountIn, amountOut, gas };
}

export class UniswapQuoter {
  /**
   * rpc: EthRpc; discovery: UniswapDiscovery; now: () => ms (tests).
   * The limits are the desktop app's.
   */
  constructor({ rpc, discovery, maxDirectPools = 16, maxPoolsPerPair = 4, splitSteps = 20, maxParts = 6, maxSplitRoutes = 10, now = () => Date.now() }) {
    this.rpc = rpc;
    this.discovery = discovery;
    this.maxDirectPools = maxDirectPools;
    this.maxPoolsPerPair = maxPoolsPerPair;
    this.splitSteps = splitSteps;
    this.maxParts = maxParts;
    this.maxSplitRoutes = maxSplitRoutes;
    this._now = now;
    /** Per pair, its deepest live pools and when they were ranked. */
    this._ranked = new Map();
    /** Pools whose swap failed where its quote said it would work: left out for the rest of the session. */
    this.distrusted = new Set();
  }

  /**
   * The deepest live pools of a pair: a pair like ETH/USDC has hundreds of v4
   * pools, most of them empty or tiny, so every pool is read once and only
   * the deepest are priced (and read again) for the next few minutes.
   */
  async _deepest([a, b], { direct, head }) {
    const key = pairKey(a, b);
    const cached = this._ranked.get(key);
    if (cached && this._now() - cached.at < RANKING_LIFE_MS) return cached.pools;
    const pools = await this.discovery.poolsBetween(a, b, { head: await head });
    if (!pools.length) {
      this._ranked.set(key, { at: this._now(), pools: [] });
      return [];
    }
    const states = await this.discovery.liveState(pools);
    const ranked = pools.filter((p) => states.get(p.id)?.isLive ?? false).sort((x, y) => cmpDesc(poolDepth(states.get(x.id)), poolDepth(states.get(y.id))));
    const top = ranked.slice(0, direct ? this.maxDirectPools : this.maxPoolsPerPair);
    this._ranked.set(key, { at: this._now(), pools: top });
    return top;
  }

  /**
   * The best way to swap amountIn of tokenIn into tokenOut, shared between
   * routes when that gives more. gasPriceWei (or the promise gasPrice), when
   * known, lets fewer routes win over more that give slightly more but burn
   * more gas. simulate(quote) → true / false / null checks the real swap of
   * a quote through a hooked pool.
   */
  async bestQuote({ tokenIn, tokenOut, amountIn, gasPriceWei = null, gasPrice = null, simulate = null }) {
    if (tokenIn.sameAsset(tokenOut)) throw new UniswapNoRoute('sameAsset');
    if (amountIn <= 0n) throw new UniswapNoRoute('tooSmall');
    // Read while the pools are priced; only needed at the end.
    const head = this.rpc.blockNumber();
    head.catch(() => {});
    if (gasPrice) gasPrice.catch(() => {});
    const ins = tokenIn.poolCurrencies;
    const outs = tokenOut.poolCurrencies;
    const mids = ROUTE_BASES.filter((m) => !ins.includes(m) && !outs.includes(m));

    // Every pool the search could use, found together.
    const pairs = new Map();
    const addPair = (a, b) => pairs.set(pairKey(a, b), [a, b]);
    for (const a of ins) for (const b of outs) addPair(a, b);
    for (const a of ins) for (const m of mids) addPair(a, m);
    for (const m of mids) for (const b of outs) addPair(m, b);
    const found = new Map();
    await Promise.all([...pairs.entries()].map(([k, p]) => this._deepest(p, { direct: ins.includes(p[0]) && outs.includes(p[1]), head }).then((pools) => found.set(k, pools))));
    const foundOf = (a, b) => found.get(pairKey(a, b)) ?? [];
    const allById = new Map();
    for (const l of found.values()) for (const p of l) if (!allById.has(p.id)) allById.set(p.id, p);
    if (!allById.size) throw new UniswapNoRoute('noPool');
    const states = await this.discovery.liveState([...allById.values()]);
    const live = (p) => !this.distrusted.has(p.id) && (states.get(p.id)?.isLive ?? false);

    const n = this.splitSteps;
    const at = (k) => (amountIn * BigInt(k)) / BigInt(n);
    const pricer = new Pricer(this, states);

    // Step 1: the direct pools and the first pool of each two-pool route,
    // with a twentieth of the amount and with all of it.
    const direct = [];
    for (const a of ins) for (const b of outs) for (const p of foundOf(a, b)) if (live(p)) direct.push(new UniHop(p, a, b));
    const firstToMid = [];
    for (const a of ins) for (const m of mids) for (const p of foundOf(a, m)) if (live(p)) firstToMid.push(new UniHop(p, a, m));
    // No pool at all, or first pools that lead nowhere: no route (the desktop
    // app reports the second case as 'tooSmall', which tells the person to
    // try a larger amount when no amount would do).
    const leadsOn = (h) => mids.some((m) => assetKey(m) === assetKey(h.currencyOut) && outs.some((b) => foundOf(m, b).some((p) => live(p) && p.id !== h.pool.id)));
    if (!direct.length && !firstToMid.some(leadsOn)) throw new UniswapNoRoute('noPool');
    // Also at nineteen twentieths: the best route's last step says whether
    // any other route could add to it (step 3).
    const probe = [...new Set([1, n - 1, n])].filter((k) => k >= 1);
    await pricer.price([...direct, ...firstToMid].flatMap((h) => probe.map((k) => [h, at(k)])));

    // Step 2: from the two best first pools into each middle token (ETH and
    // WETH count as one), every pool on to the token wanted.
    const byAsset = new Map();
    for (const h of firstToMid) {
      if (pricer.leg(h, at(n)) === null && pricer.leg(h, at(1)) === null) continue;
      const k = assetKey(h.currencyOut);
      if (!byAsset.has(k)) byAsset.set(k, []);
      byAsset.get(k).push(h);
    }
    const candidates = direct.map((h) => [h]);
    for (const [asset, firsts] of byAsset) {
      firsts.sort((x, y) => cmpDesc(pricer.leg(x, at(n))?.amountOut ?? 0n, pricer.leg(y, at(n))?.amountOut ?? 0n));
      for (const first of firsts.slice(0, 2)) {
        for (const m of mids.filter((m) => assetKey(m) === asset)) {
          for (const b of outs) {
            for (const p of foundOf(m, b)) {
              if (!live(p) || p.id === first.pool.id) continue;
              candidates.push([first, new UniHop(p, m, b)]);
            }
          }
        }
      }
    }
    await pricer.priceRoutes(
      candidates,
      probe.map((k) => at(k)),
    );

    const outAt = (c, k) => {
      const legs = pricer.route(c, at(k));
      return legs ? legs[legs.length - 1].amountOut : null;
    };
    const hooked = (c) => c.some((h) => h.pool instanceof UniV4Pool && h.pool.hasHooks);

    const suspicious = (c) => {
      if (!hooked(c)) return false;
      for (const k of new Set([1, n])) {
        const mine = outAt(c, k);
        if (mine === null) continue;
        let plain = null;
        for (const o of candidates) {
          if (hooked(o)) continue;
          const v = outAt(o, k);
          if (v !== null && (plain === null || v > plain)) plain = v;
        }
        if (plain === null || mine * 10000n > plain * (10000n + HOOKED_EDGE_BIPS)) return true;
      }
      return false;
    };

    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i];
      if ((outAt(c, 1) ?? 0n) <= 0n && (outAt(c, n) ?? 0n) <= 0n) candidates.splice(i, 1);
    }
    if (!candidates.length) throw new UniswapNoRoute('tooSmall');

    // What a route's gas costs, in the token received.
    const bestOut = candidates.map((c) => outAt(c, n) ?? 0n).reduce(big);
    let gp = gasPriceWei;
    if (gp === null && gasPrice) gp = await gasPrice.catch(() => null);
    const costPerGas = this._costPerGas({ tokenIn, tokenOut, amountIn, bestOut, gasPriceWei: gp ?? ASSUMED_GAS_PRICE, foundOf, states });
    const costOf = (c) => costPerGas((pricer.route(c, at(n)) ?? pricer.route(c, at(1)) ?? []).reduce((s, l) => s + l.gas, 0n));

    const quoteOf = (routes, split) => {
      const shares = [];
      routes.forEach((r, i) => {
        if (split.steps[i] > 0) shares.push([r, split.steps[i]]);
      });
      shares.sort((x, y) => y[1] - x[1]);
      const legsOf = [];
      let given = 0n;
      for (const [route, k] of shares) {
        const legs = pricer.route(route, at(k));
        if (!legs) return null;
        given += at(k);
        legsOf.push(legs);
      }
      const parts = legsOf.map((legs, i) => {
        // Whole steps leave a few raw units over; the largest share takes
        // them (its price is for slightly less, so it is not overstated).
        const extra = i === 0 ? amountIn - given : 0n;
        return new UniPart({
          route: new UniRoute(legs.map((l) => l.hop)),
          amountIn: legs[0].amountIn + extra,
          amountOut: legs[legs.length - 1].amountOut,
          hopOutputs: legs.map((l) => l.amountOut),
          gas: legs.reduce((s, l) => s + l.gas, 0n),
        });
      });
      return { parts, legsOf };
    };

    const dropped = new Set();
    for (let attempt = 0; attempt < 4; attempt++) {
      const usable = candidates.filter((c) => !dropped.has(c) && !c.some((h) => this.distrusted.has(h.pool.id)) && !(simulate === null && suspicious(c)));
      if (!usable.length) break;

      // Step 3: the best single route, and the routes that could add to it.
      // A route can only take part if its first twentieth, less its gas
      // spread over the swap, beats the best route's last twentieth (prices
      // fall the more goes through a pool, so nothing it could take from the
      // best route is worth more than that). Usually none can, and the
      // search ends here.
      const net = (c) => (outAt(c, n) ?? 0n) - costOf(c);
      const best = usable.reduce((x, y) => (net(y) > net(x) ? y : x));
      const full = outAt(best, n);
      const before = n > 1 ? outAt(best, n - 1) : 0n;
      const last = full === null || before === null ? null : full - before;
      const couldAdd = (c) => {
        if (c === best) return false;
        const first = outAt(c, 1);
        if (first === null || first <= 0n) return false;
        if (last === null) return true;
        return (first - last) * BigInt(n) > costOf(c);
      };
      const ranked = usable.filter(couldAdd).sort((x, y) => cmpDesc(outAt(x, 1) ?? 0n, outAt(y, 1) ?? 0n));
      const kept = [best, ...ranked.slice(0, this.maxSplitRoutes - 1)];
      if (kept.length > 1) {
        const levels = [];
        for (let k = 2; k < n - 1; k++) levels.push(at(k));
        await pricer.priceRoutes(kept, levels);
      }

      // Step 4: the best sharing of the amount between them.
      const curves = kept.map((c) => {
        const outsK = [0n];
        for (let k = 1; k <= n; k++) outsK.push(at(k) > 0n ? outAt(c, k) : null);
        return splitCurve({ pools: new Set(c.map((h) => h.pool.id)), outs: outsK, cost: costOf(c) });
      });
      const split = bestSplit(curves, { steps: n, maxParts: this.maxParts });
      const q = split === null ? null : quoteOf(kept, split);
      if (q === null) {
        dropped.add(best);
        continue;
      }
      const quote = new UniQuote({
        tokenIn,
        tokenOut,
        amountIn,
        parts: q.parts,
        gasEstimate: q.parts.reduce((s, p) => s + p.gas, ROUTER_OVERHEAD_GAS),
        priceImpact: impact(q.legsOf, states),
        block: await head,
      });

      // With the real swap simulated, a hooked pool that would not trade is
      // left out and the search runs again without it.
      const hookedIds = new Set(quote.pools.filter((p) => p instanceof UniV4Pool && p.hasHooks).map((p) => p.id));
      if (!hookedIds.size) return quote;
      const ok = simulate === null ? null : await simulate(quote);
      if (ok === true) return quote;
      if (ok === false) {
        for (const id of hookedIds) this.distrusted.add(id);
        continue;
      }
      const doubtful = kept.filter(suspicious);
      if (!doubtful.length) return quote;
      for (const c of doubtful) dropped.add(c);
    }
    throw new UniswapNoRoute('noPool');
  }

  /**
   * Prices q's routes again, each with its share of amountIn (the review's
   * fresh check; also how a route chosen elsewhere is priced).
   */
  async requote(q, { amountIn = null } = {}) {
    const amount = amountIn ?? q.amountIn;
    const head = await this.rpc.blockNumber();
    const poolsById = new Map(q.pools.map((p) => [p.id, p]));
    const states = await this.discovery.liveState([...poolsById.values()]);
    const pricer = new Pricer(this, states);
    const amounts = q.parts.map((p) => (q.amountIn === 0n ? 0n : (p.amountIn * amount) / q.amountIn));
    amounts[0] += amount - amounts.reduce((s, a) => s + a, 0n);
    const routes = q.parts.map((p) => p.route.hops);
    await pricer.priceRoutes(routes, null, amounts);
    const legsOf = routes.map((r, i) => {
      const legs = pricer.route(r, amounts[i]);
      if (!legs) throw new UniswapNoRoute('tooSmall');
      return legs;
    });
    const parts = legsOf.map(
      (legs) =>
        new UniPart({
          route: new UniRoute(legs.map((l) => l.hop)),
          amountIn: legs[0].amountIn,
          amountOut: legs[legs.length - 1].amountOut,
          hopOutputs: legs.map((l) => l.amountOut),
          gas: legs.reduce((s, l) => s + l.gas, 0n),
        }),
    );
    return new UniQuote({
      tokenIn: q.tokenIn,
      tokenOut: q.tokenOut,
      amountIn: amount,
      parts,
      gasEstimate: parts.reduce((s, p) => s + p.gas, ROUTER_OVERHEAD_GAS),
      priceImpact: impact(legsOf, states),
      block: head,
    });
  }

  /**
   * Turns gas into the token received: directly when that is ETH; at the
   * swap's own rate when ETH is paid; else at the price of the deepest pool
   * between ETH and the token received (zero if there is none).
   */
  _costPerGas({ tokenIn, tokenOut, amountIn, bestOut, gasPriceWei, foundOf, states }) {
    if (tokenOut.isEthLike) return (gas) => gas * gasPriceWei;
    if (tokenIn.isEthLike) {
      if (bestOut === null || amountIn <= 0n) return () => 0n;
      return (gas) => (gas * gasPriceWei * bestOut) / amountIn;
    }
    // Raw units of the token received per wei.
    let rate = null;
    let deepest = 0n;
    for (const eth of [NATIVE_ETH, WETH]) {
      for (const out of tokenOut.poolCurrencies) {
        for (const p of [...foundOf(eth, out), ...foundOf(out, eth)]) {
          const s = states.get(p.id);
          const price = s?.price0to1 ?? null;
          if (!s || price === null || price <= 0) continue;
          const d = poolDepth(s);
          if (d <= deepest) continue;
          deepest = d;
          rate = p.currency0 === eth ? price : 1 / price;
        }
      }
    }
    if (rate === null || !Number.isFinite(rate)) return () => 0n;
    const r = rate;
    return (gas) => {
      const v = Number(gas * gasPriceWei) * r;
      return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
    };
  }

  /** One price per [hop, amount] → [leg | null]; null where the pool would not quote. */
  async _quoteEach(asks, states) {
    const out = new Array(asks.length).fill(null);
    const calls = [];
    const callFor = [];
    asks.forEach(([hop, amount], i) => {
      if (amount <= 0n) return;
      const pool = hop.pool;
      if (pool instanceof UniV2Pool) {
        const s = states.get(pool.id);
        if (!s || s.reserve0 === null || s.reserve1 === null) return;
        const [rIn, rOut] = hop.zeroForOne ? [s.reserve0, s.reserve1] : [s.reserve1, s.reserve0];
        const amountOut = v2AmountOut(amount, rIn, rOut);
        if (amountOut > 0n) out[i] = leg(hop, amount, amountOut, V2_HOP_GAS);
      } else if (pool instanceof UniV3Pool) {
        calls.push({ to: ADDRESSES.v3QuoterV2, data: encodeCall('quoteExactInputSingle((address,address,uint256,uint24,uint160))', [[hop.currencyIn, hop.currencyOut, amount, pool.fee, 0n]]) });
        callFor.push(i);
      } else {
        if (amount >= 1n << 127n) return;
        calls.push({ to: ADDRESSES.v4Quoter, data: encodeCall('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))', [[pool.key, hop.zeroForOne, amount, ZERO_BYTES]]) });
        callFor.push(i);
      }
    });
    if (calls.length) {
      const results = await this.rpc.multicall(calls, { chunk: 25 });
      results.forEach((r, k) => {
        if (!r.success || r.data.length < 64) return;
        const i = callFor[k];
        const [hop, amount] = asks[i];
        let amountOut;
        let gas;
        try {
          if (hop.pool instanceof UniV3Pool) {
            const d = abiDecode('uint256,uint160,uint32,uint256', r.data);
            amountOut = d[0];
            gas = d[3];
          } else {
            const d = abiDecode('uint256,uint256', r.data);
            amountOut = d[0];
            gas = d[1];
          }
        } catch {
          return;
        }
        if (amountOut > 0n) out[i] = leg(hop, amount, amountOut, gas);
      });
    }
    return out;
  }
}

/** How much less the swap gives than its pools' current prices (less their fees) promise, as a fraction; null if a price is unknown. */
function impact(parts, states) {
  let ideal = 0;
  let actual = 0;
  for (const legs of parts) {
    let v = Number(legs[0].amountIn);
    for (const l of legs) {
      const s = states.get(l.hop.pool.id);
      const p = s?.price0to1 ?? null;
      if (p === null || p <= 0) return null;
      const rate = l.hop.zeroForOne ? p : 1 / p;
      const feePpm = l.hop.pool instanceof UniV4Pool ? (s.lpFee ?? l.hop.pool.fee ?? 0) : (l.hop.pool.fee ?? 0);
      v = v * rate * (1 - feePpm / 1e6);
    }
    ideal += v;
    actual += Number(legs[legs.length - 1].amountOut);
  }
  if (ideal <= 0) return null;
  return Math.max(0, 1 - actual / ideal);
}

/** Prices hops and routes at given amounts, each (hop, amount) once. */
class Pricer {
  constructor(quoter, states) {
    this.quoter = quoter;
    this.states = states;
    this._legs = new Map();
  }

  static key(h, amount) {
    return `${h.pool.id}:${h.currencyIn}:${amount}`;
  }

  leg(h, amount) {
    return this._legs.get(Pricer.key(h, amount)) ?? null;
  }

  /** Prices every [hop, amount] not priced yet, in one batch. */
  async price(asks) {
    const todo = [];
    const seen = new Set();
    for (const a of asks) {
      const k = Pricer.key(a[0], a[1]);
      if (this._legs.has(k) || seen.has(k)) continue;
      seen.add(k);
      todo.push(a);
    }
    if (!todo.length) return;
    const r = await this.quoter._quoteEach(todo, this.states);
    todo.forEach((a, i) => this._legs.set(Pricer.key(a[0], a[1]), r[i]));
  }

  /** Prices each route at each of `levels` (or route i at amounts[i]), pool by pool: one batch per pool position. */
  async priceRoutes(routes, levels, amounts = null) {
    const starts = [];
    routes.forEach((_, i) => {
      if (amounts) starts.push({ route: i, amount: amounts[i] });
      else for (const a of levels) starts.push({ route: i, amount: a });
    });
    const depth = routes.reduce((m, r) => Math.max(m, r.length), 0);
    // What enters each route's next pool, per (route, starting amount).
    const current = starts.map((s) => s.amount);
    for (let d = 0; d < depth; d++) {
      const asks = [];
      starts.forEach((s, i) => {
        if (d < routes[s.route].length && current[i] !== null) asks.push([routes[s.route][d], current[i]]);
      });
      await this.price(asks);
      starts.forEach((s, i) => {
        if (d >= routes[s.route].length || current[i] === null) return;
        current[i] = this.leg(routes[s.route][d], current[i])?.amountOut ?? null;
      });
    }
  }

  /** The legs of `route` starting with `amount`, if every pool priced. */
  route(route, amount) {
    const legs = [];
    let a = amount;
    for (const h of route) {
      if (a <= 0n) return null;
      const l = this.leg(h, a);
      if (!l) return null;
      legs.push(l);
      a = l.amountOut;
    }
    return legs;
  }
}
