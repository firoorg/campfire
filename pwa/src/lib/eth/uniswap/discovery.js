// Finds Uniswap pools: every v2 pair, every v3 pool (any fee tier) and every
// v4 pool (any fee, tick spacing or hook) between two currencies, or every
// pool that holds one token. A port of the desktop app's
// lib/wallets/ethereum/uniswap/uniswap_discovery.dart.
//
// Where pools come from, in order:
// 1. The list shipped with the app (known_pools.json, in the compact format of
//    tools/uniswap_pools.mjs): every pool between two of the main tokens
//    (constants.js ROUTE_BASES), and every pool holding rsFIRO (FIRO on
//    Ethereum: v3 rsFIRO/WETH 0.3% and 1%, and the rest, found on chain from
//    rsFIRO's first block, 25,559,054), up to a block.
// 2. Uniswap's own events after that block (v2 PairCreated, v3 PoolCreated,
//    v4 Initialize), searched through the person's chosen server in windows
//    of at most 10,000 blocks. How far each search got is kept through the
//    `store` the caller passes ({read(key), write(key, scan)}; pool lists
//    are public chain data), so the next search starts where this one
//    stopped.
// 3. When the server will not search events at all, direct lookups: the v2
//    pair, the v3 pool of each fee tier, the common v4 pools without hooks.
//
// Then liveState() reads each pool's price and liquidity through Multicall3,
// so empty pools are dropped before quoting.

import { encodeCall, abiDecode, selector } from '../abi.js';
import { normAddress } from '../crypto.js';
import { hexToBytes, bytesToBigInt } from '../hex.js';
import { EthRpcError, MAX_LOG_RANGE } from '../rpc.js';
import { ADDRESSES, NATIVE_ETH, DEPLOY_BLOCKS, TOPICS, V3_FEE_TICK_SPACING, V4_PROBE_KEYS, ROUTE_BASES } from './constants.js';
import { UniV2Pool, UniV3Pool, UniV4Pool, poolFromJson, topicOfAddress, addressOfTopic, sortCurrencies } from './models.js';
import { t } from '../../i18n.js';

/** "Up to date for good": a v2 pair, once created, never goes away. */
const FOREVER = Number.MAX_SAFE_INTEGER;

/**
 * The shipped list from its compact JSON form (known_pools.json) →
 * {block, pools: [UniPool]}. Throws on anything malformed.
 */
export function parseKnownPools(json) {
  if (!json || json.format !== 1 || !Number.isSafeInteger(json.block) || !Array.isArray(json.currencies) || !Array.isArray(json.hooks) || !Array.isArray(json.pools)) throw new Error('not a known-pools list');
  const cur = (i) => {
    const c = json.currencies[i];
    if (typeof c !== 'string') throw new Error(t('bad currency index'));
    return c;
  };
  const hook = (i) => {
    const h = json.hooks[i];
    if (typeof h !== 'string') throw new Error(t('bad hook index'));
    return h;
  };
  const pools = json.pools.map((p) => {
    switch (p[0]) {
      case 2:
        return new UniV2Pool({ pair: p[1], currency0: cur(p[2]), currency1: cur(p[3]) });
      case 3:
        return new UniV3Pool({ pool: p[1], currency0: cur(p[2]), currency1: cur(p[3]), fee: p[4], tickSpacing: p[5] });
      case 4:
        return new UniV4Pool({ currency0: cur(p[1]), currency1: cur(p[2]), fee: p[3], tickSpacing: p[4], hooks: hook(p[5]) });
      default:
        throw new Error(t('unknown pool version in the list'));
    }
  });
  return { block: json.block, pools };
}

/**
 * Reads known_pools.json from beside this file (same origin; it ships, and is
 * cached, with the app) → parseKnownPools of it.
 */
export async function loadKnownPools(fetchImpl = (...a) => globalThis.fetch(...a)) {
  const r = await fetchImpl(new URL('./known_pools.json', import.meta.url), { credentials: 'omit' });
  if (!r.ok) throw new Error(t('The list of Uniswap pools could not be loaded.'));
  return parseKnownPools(await r.json());
}

/** A store that forgets on reload (tests, or a caller with nowhere to keep it). */
export function memoryPoolStore() {
  const m = new Map();
  return {
    async read(key) {
      return m.has(key) ? m.get(key) : null;
    },
    async write(key, scan) {
      m.set(key, scan);
    },
  };
}

/** A search as stored: {to, pools: [toJson()]}. */
function scanToJson(scan) {
  return { to: scan.scannedTo, pools: scan.pools.map((p) => p.toJson()) };
}

function scanFromJson(j) {
  if (!j || !Number.isSafeInteger(j.to) || !Array.isArray(j.pools)) return null;
  try {
    return { scannedTo: j.to, pools: j.pools.map(poolFromJson) };
  } catch {
    return null;
  }
}

/**
 * A pool's price and liquidity right now: v2 reserves, or v3/v4
 * sqrtPriceX96 and in-range liquidity, and (v4) the fee it charges now.
 */
export class UniPoolState {
  constructor({ reserve0 = null, reserve1 = null, sqrtPriceX96 = null, liquidity = null, lpFee = null } = {}) {
    this.reserve0 = reserve0;
    this.reserve1 = reserve1;
    this.sqrtPriceX96 = sqrtPriceX96;
    this.liquidity = liquidity;
    this.lpFee = lpFee;
    Object.freeze(this);
  }

  /** The pool can trade: v2 with both reserves, v3/v4 initialised with liquidity in range. */
  get isLive() {
    if (this.reserve0 !== null) return this.reserve0 > 0n && this.reserve1 !== null && this.reserve1 > 0n;
    return (this.sqrtPriceX96 ?? 0n) > 0n && (this.liquidity ?? 0n) > 0n;
  }

  /** Raw units of currency1 per raw unit of currency0, before fees. */
  get price0to1() {
    if (this.reserve0 !== null && this.reserve1 !== null && this.reserve0 > 0n) return Number(this.reserve1) / Number(this.reserve0);
    const s = this.sqrtPriceX96;
    if (s === null || s === 0n) return null;
    const r = Number(s) / 2 ** 96;
    return r * r;
  }
}

const KNOWN_BASES = new Set(ROUTE_BASES);

/**
 * The shipped list covers every pool between two base tokens, and every pool of a token the
 * caller says it lists in full (`fullyListed`, none by default). TODO(BSC rsFIRO): a BNB Chain
 * list would bring its own bases and pools.
 */
function knownCoversPair(c0, c1, fullyListed) {
  return fullyListed.has(c0) || fullyListed.has(c1) || (KNOWN_BASES.has(c0) && KNOWN_BASES.has(c1));
}

function uniquePools(lists) {
  const m = new Map();
  for (const l of lists) for (const p of l) if (!m.has(p.id)) m.set(p.id, p);
  return [...m.values()];
}

export class UniswapDiscovery {
  /**
   * rpc: an EthRpc (or anything with blockNumber, ethCall, multicall, getLogs).
   * known: parseKnownPools(known_pools.json).
   * store: {read(key) → stored|null, write(key, stored)}; memoryPoolStore() if omitted.
   * fullyListed: tokens whose every pool (up to the list's block) is in `known`.
   */
  constructor({ rpc, known, store = memoryPoolStore(), maxLogRequests = 40, interactiveLogRequests = 3, freshBlocks = 300, fullyListed = [] }) {
    if (!known || !Array.isArray(known.pools)) throw new Error(t('UniswapDiscovery needs the known pools list'));
    this.rpc = rpc;
    this.store = store;
    this.known = known.pools;
    this.knownBlock = known.block;
    this.fullyListed = new Set(fullyListed.map((a) => normAddress(a)));
    /** Event-search requests one background search may make. */
    this.maxLogRequests = maxLogRequests;
    /** Event-search requests a quote waits for. */
    this.interactiveLogRequests = interactiveLogRequests;
    /** A search younger than this many blocks (about an hour) is not repeated. */
    this.freshBlocks = freshBlocks;
    /** The widest event search the server took (learnt from its refusals). */
    this._logRange = null;
    /** False once the server refused event searches outright: lookups only. */
    this._logsWork = true;
    /** Searches still running in the background, by store key. */
    this._background = new Map();
  }

  /** 'events' while event searches work on this server, else 'lookups'. */
  get source() {
    return this._logsWork ? 'events' : 'lookups';
  }

  /** Resolves when the background searches started so far have finished (tests). */
  async idle() {
    while (this._background.size) await Promise.all([...this._background.values()]);
  }

  async _read(key) {
    try {
      return scanFromJson(await this.store.read(key));
    } catch {
      return null;
    }
  }

  async _write(key, scan) {
    try {
      await this.store.write(key, scanToJson(scan));
    } catch {
      // Storage is a cache: without it the next search starts over.
    }
  }

  /** Every pool between a and b (raw pool currencies: native ETH is the zero address; v2 and v3 have no native pools). */
  async poolsBetween(a, b, { head = null } = {}) {
    const [c0, c1] = sortCurrencies(a, b);
    if (c0 === c1) return [];
    const tip = head ?? (await this.rpc.blockNumber());
    const native = c0 === NATIVE_ETH;
    const seeded = knownCoversPair(c0, c1, this.fullyListed);
    const searches = [];
    if (!native) {
      searches.push(this._v2Pair(c0, c1));
      searches.push(
        this._scan({
          key: `v3:${c0}:${c1}`,
          address: ADDRESSES.v3Factory,
          topics: [TOPICS.v3PoolCreated, topicOfAddress(c0), topicOfAddress(c1)],
          deployBlock: DEPLOY_BLOCKS.v3Factory,
          head: tip,
          seed: () => this._knownBetween('v3', c0, c1),
          seeded,
          parse: parseV3,
          fallback: () => this._probeV3(c0, c1),
        }),
      );
    }
    searches.push(
      this._scan({
        key: `v4:${c0}:${c1}`,
        address: ADDRESSES.v4PoolManager,
        topics: [TOPICS.v4Initialize, null, topicOfAddress(c0), topicOfAddress(c1)],
        deployBlock: DEPLOY_BLOCKS.v4PoolManager,
        head: tip,
        seed: () => this._knownBetween('v4', c0, c1),
        seeded,
        parse: parseV4,
        fallback: () => this._probeV4(c0, c1),
      }),
    );
    return uniquePools(await Promise.all(searches));
  }

  /**
   * Every pool holding `token` (all versions), for "what trades with this token".
   * Only sensible for tokens with a modest number of pools.
   */
  async poolsOf(token, { head = null } = {}) {
    const item = normAddress(token);
    const tip = head ?? (await this.rpc.blockNumber());
    const topic = topicOfAddress(item);
    const native = item === NATIVE_ETH;
    const none = async () => [];
    const searches = [];
    const sideTopics = (side) => (side === 0 ? [topic] : [null, topic]);
    if (!native) {
      for (const side of [0, 1]) {
        searches.push(this._scan({ key: `v2of${side}:${item}`, address: ADDRESSES.v2Factory, topics: [TOPICS.v2PairCreated, ...sideTopics(side)], deployBlock: DEPLOY_BLOCKS.v2Factory, head: tip, seed: () => this._knownOf('v2', item, side), seeded: this.fullyListed.has(item), parse: parseV2, fallback: none }));
      }
      for (const side of [0, 1]) {
        searches.push(this._scan({ key: `v3of${side}:${item}`, address: ADDRESSES.v3Factory, topics: [TOPICS.v3PoolCreated, ...sideTopics(side)], deployBlock: DEPLOY_BLOCKS.v3Factory, head: tip, seed: () => this._knownOf('v3', item, side), seeded: this.fullyListed.has(item), parse: parseV3, fallback: none }));
      }
    }
    for (const side of [0, 1]) {
      searches.push(this._scan({ key: `v4of${side}:${item}`, address: ADDRESSES.v4PoolManager, topics: [TOPICS.v4Initialize, null, ...sideTopics(side)], deployBlock: DEPLOY_BLOCKS.v4PoolManager, head: tip, seed: () => this._knownOf('v4', item, side), seeded: this.fullyListed.has(item), parse: parseV4, fallback: none }));
    }
    return uniquePools(await Promise.all(searches));
  }

  /** Price and liquidity of `pools` → Map(pool id → UniPoolState), through Multicall3. */
  async liveState(pools) {
    const calls = [];
    const owners = [];
    for (const p of pools) {
      if (p instanceof UniV2Pool) {
        calls.push({ to: p.pair, data: selector('getReserves()') });
        owners.push([p, 0]);
      } else if (p instanceof UniV3Pool) {
        calls.push({ to: p.pool, data: selector('slot0()') });
        owners.push([p, 1]);
        calls.push({ to: p.pool, data: selector('liquidity()') });
        owners.push([p, 2]);
      } else {
        calls.push({ to: ADDRESSES.v4StateView, data: encodeCall('getSlot0(bytes32)', [p.id]) });
        owners.push([p, 3]);
        calls.push({ to: ADDRESSES.v4StateView, data: encodeCall('getLiquidity(bytes32)', [p.id]) });
        owners.push([p, 4]);
      }
    }
    const results = calls.length ? await this.rpc.multicall(calls, { chunk: 120 }) : [];
    const partial = new Map();
    results.forEach((r, i) => {
      const [pool, kind] = owners[i];
      if (!r.success || r.data.length === 0) return;
      if (!partial.has(pool.id)) partial.set(pool.id, {});
      const m = partial.get(pool.id);
      try {
        switch (kind) {
          case 0: {
            const d = abiDecode('uint112,uint112,uint32', r.data);
            m.reserve0 = d[0];
            m.reserve1 = d[1];
            break;
          }
          case 1:
            m.sqrtPriceX96 = abiDecode('uint160', r.data.subarray(0, 32))[0];
            break;
          case 2:
          case 4:
            m.liquidity = abiDecode('uint128', r.data)[0];
            break;
          case 3: {
            const d = abiDecode('uint160,int24,uint24,uint24', r.data);
            m.sqrtPriceX96 = d[0];
            m.lpFee = Number(d[3]);
            break;
          }
        }
      } catch {
        // A pool whose answer does not decode is treated as unknown.
      }
    });
    const out = new Map();
    for (const [id, m] of partial) out.set(id, new UniPoolState(m));
    return out;
  }

  // ------------------------------------------------------------- searches

  async _scan({ key, address, topics, deployBlock, head, seed, seeded, parse, fallback }) {
    const cached = await this._read(key);
    const start = cached ?? (seeded ? { pools: seed(), scannedTo: Math.max(this.knownBlock, deployBlock - 1) } : { pools: [], scannedTo: deployBlock - 1 });
    if (!this._logsWork) return uniquePools([start.pools, await fallback()]);
    if (head - start.scannedTo < this.freshBlocks) return start.pools;
    try {
      // A quote waits for a few requests at most; a longer search goes on in
      // the background and the next quote sees what it found.
      const r = await this._searchLogs({ address, topics, fromBlock: start.scannedTo + 1, toBlock: head, maxRequests: this.interactiveLogRequests });
      const next = merge(start, r.logs, r.scannedTo, address, parse);
      await this._write(key, next);
      if (!r.complete) {
        this._continueInBackground({ key, address, topics, head, parse });
        // Meanwhile the direct lookups, so nothing obvious is missing.
        return uniquePools([next.pools, await fallback()]);
      }
      return next.pools;
    } catch (e) {
      if (!(e instanceof EthRpcError)) throw e;
      if (e.code === 'logs_refused' || e.code === -32601) {
        // The server does not search events (or not over ranges worth
        // searching): lookups for the rest of this session.
        this._logsWork = false;
      }
      // Busy or refused this once: lookups this time, events next time.
      return uniquePools([start.pools, await fallback()]);
    }
  }

  /**
   * The logs of fromBlock…toBlock in windows the server accepts (at most
   * MAX_LOG_RANGE blocks, smaller when it says so), at most maxRequests
   * requests → {logs, scannedTo, complete}. A server that only searches a few
   * blocks at a time cannot cover a useful history: EthRpcError 'logs_refused'.
   */
  async _searchLogs({ address, topics, fromBlock, toBlock, maxRequests }) {
    const logs = [];
    let range = Math.min(this._logRange ?? MAX_LOG_RANGE, MAX_LOG_RANGE);
    let start = fromBlock;
    let requests = 0;
    while (start <= toBlock) {
      if (requests >= maxRequests) return { logs, scannedTo: start - 1, complete: false };
      const end = Math.min(toBlock, start + range - 1);
      requests++;
      try {
        logs.push(...(await this.rpc.getLogs({ address, topics, fromBlock: start, toBlock: end }, { maxRange: range })));
        start = end + 1;
      } catch (e) {
        if (!(e instanceof EthRpcError) || !e.isRangeTooLong) throw e;
        const suggested = e.suggestedRange;
        const next = suggested !== null && suggested < range ? suggested : Math.floor(range / 10);
        if (next < 1000) throw new EthRpcError('logs_refused', t('The server does not search events over useful ranges.'));
        range = next;
        this._logRange = next;
      }
    }
    return { logs, scannedTo: toBlock, complete: true };
  }

  _continueInBackground({ key, address, topics, head, parse }) {
    if (this._background.has(key)) return;
    const run = (async () => {
      try {
        const start = await this._read(key);
        if (!start) return;
        const r = await this._searchLogs({ address, topics, fromBlock: start.scannedTo + 1, toBlock: head, maxRequests: this.maxLogRequests });
        await this._write(key, merge(start, r.logs, r.scannedTo, address, parse));
      } catch {
        // Tried again with the next quote.
      } finally {
        this._background.delete(key);
      }
    })();
    this._background.set(key, run);
  }

  _knownBetween(version, c0, c1) {
    return this.known.filter((p) => p.version === version && p.currency0 === c0 && p.currency1 === c1);
  }

  _knownOf(version, item, side) {
    return this.known.filter((p) => p.version === version && (side === 0 ? p.currency0 : p.currency1) === item);
  }

  async _v2Pair(c0, c1) {
    const key = `v2:${c0}:${c1}`;
    const cached = await this._read(key);
    if (cached) return cached.pools;
    const r = await this.rpc.ethCall({ to: ADDRESSES.v2Factory, data: encodeCall('getPair(address,address)', [c0, c1]) });
    const pair = abiDecode('address', r)[0].toLowerCase();
    const pools = pair === NATIVE_ETH ? [] : [new UniV2Pool({ pair, currency0: c0, currency1: c1 })];
    // "None" is asked again in a later session.
    if (pools.length) await this._write(key, { pools, scannedTo: FOREVER });
    return pools;
  }

  async _probeV3(c0, c1) {
    const results = await this.rpc.multicall(V3_FEE_TICK_SPACING.map(([fee]) => ({ to: ADDRESSES.v3Factory, data: encodeCall('getPool(address,address,uint24)', [c0, c1, fee]) })));
    const out = [];
    results.forEach((r, i) => {
      if (!r.success) return;
      let pool;
      try {
        pool = abiDecode('address', r.data)[0].toLowerCase();
      } catch {
        return;
      }
      if (pool !== NATIVE_ETH) out.push(new UniV3Pool({ pool, currency0: c0, currency1: c1, fee: V3_FEE_TICK_SPACING[i][0], tickSpacing: V3_FEE_TICK_SPACING[i][1] }));
    });
    return out;
  }

  async _probeV4(c0, c1) {
    const candidates = V4_PROBE_KEYS.map((k) => new UniV4Pool({ currency0: c0, currency1: c1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: NATIVE_ETH }));
    const results = await this.rpc.multicall(candidates.map((p) => ({ to: ADDRESSES.v4StateView, data: encodeCall('getSlot0(bytes32)', [p.id]) })));
    return candidates.filter((_, i) => results[i].success && results[i].data.length >= 32 && bytesToBigInt(results[i].data.subarray(0, 32)) > 0n);
  }
}

function merge(start, logs, scannedTo, address, parse) {
  const pools = new Map(start.pools.map((p) => [p.id, p]));
  for (const l of logs) {
    if (l.removed || l.address !== address) continue;
    const p = parse(l);
    if (p && !pools.has(p.id)) pools.set(p.id, p);
  }
  return { pools: [...pools.values()], scannedTo };
}

// -------------------------------------------------------------- parsing
//
// Logs come from a server, so a malformed one is skipped, never trusted:
// each parser returns null for anything that does not fit.

function parseV2(l) {
  try {
    if (l.topics.length < 3 || l.data.length < 32) return null;
    return new UniV2Pool({ pair: abiDecode('address', l.data.subarray(0, 32))[0], currency0: addressOfTopic(l.topics[1]), currency1: addressOfTopic(l.topics[2]) });
  } catch {
    return null;
  }
}

function parseV3(l) {
  try {
    if (l.topics.length < 4 || l.data.length < 64) return null;
    const [tickSpacing, pool] = abiDecode('int24,address', l.data.subarray(0, 64));
    const fee = bytesToBigInt(hexToBytes(l.topics[3]));
    if (fee > 0xffffffn) return null;
    return new UniV3Pool({ pool, currency0: addressOfTopic(l.topics[1]), currency1: addressOfTopic(l.topics[2]), fee: Number(fee), tickSpacing: Number(tickSpacing) });
  } catch {
    return null;
  }
}

function parseV4(l) {
  try {
    if (l.topics.length < 4 || l.data.length < 96) return null;
    const [fee, tickSpacing, hooks] = abiDecode('uint24,int24,address', l.data.subarray(0, 96));
    const pool = new UniV4Pool({ currency0: addressOfTopic(l.topics[2]), currency1: addressOfTopic(l.topics[3]), fee: Number(fee), tickSpacing: Number(tickSpacing), hooks });
    // The event names the pool by its id: a key that hashes to another id is not this pool.
    return pool.id === l.topics[1] ? pool : null;
  } catch {
    return null;
  }
}
