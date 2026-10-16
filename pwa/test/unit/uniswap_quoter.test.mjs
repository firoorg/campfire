// The pool search and the quoter, offline, against a pretend chain
// (helpers/fake_uniswap.mjs) whose pools follow v2's formula with their own
// fees, so every price the quoter returns can be checked by hand: the shared
// list first, events after it in bounded windows, lookups when the server
// will not search, routes through a middle token, sharing between pools, and
// the rule for v4 pools with hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeChain, cpOut } from './helpers/fake_uniswap.mjs';
import { UniswapDiscovery, memoryPoolStore, parseKnownPools, loadKnownPools } from '../../src/lib/eth/uniswap/discovery.js';
import { readFileSync } from 'node:fs';
import { UniswapQuoter, UniswapNoRoute, v2AmountOut, RANKING_LIFE_MS } from '../../src/lib/eth/uniswap/quoter.js';
import { UniToken, ETH_TOKEN, UniV4Pool, UniV2Pool, UniV3Pool } from '../../src/lib/eth/uniswap/models.js';
import { NATIVE_ETH, WETH, DEPLOY_BLOCKS } from '../../src/lib/eth/uniswap/constants.js';

// An 8-decimal token whose every pool is in the shared list, as the app's list holds every rsFIRO
// pool (lib/eth/uniswap/discovery.js fullyListed). Its address sorts after WETH, like the vectors'.
const TKN = '0xe5acbb03d73267c03349c76ead672ee4d941f499';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const KAS = '0x112b08621e27e10773ec95d250604a041f36c582';
const HOOK = '0x0e6690b6bbcc55a8b7c7da2f0ee43e2e2bf840c0';
const tkn = new UniToken({ address: TKN, symbol: 'TKN', decimals: 8 });
const usdc = new UniToken({ address: USDC, symbol: 'USDC', decimals: 6 });
const kas = new UniToken({ address: KAS, symbol: 'KAS', decimals: 8 });
const weth = new UniToken({ address: WETH, symbol: 'WETH', decimals: 18 });
const ETH = 10n ** 18n;
const WB = 10n ** 8n;
const KNOWN_BLOCK = 26000000;

/**
 * A chain with TKN pools: a deep v4 ETH pool, and a
 * shallower v2 WETH pair whose price is a little worse (so a small purchase,
 * where the gas of a second pool outweighs anything it saves, has one clear
 * best pool).
 */
function tokenChain({ head = KNOWN_BLOCK + 100, hooked = null } = {}) {
  const chain = new FakeChain({ head });
  const v4 = chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 3000, ts: 60, r0: 100n * ETH, r1: 32000000n * WB });
  const v2 = chain.addV2({ pair: '0xc821395f890913b9ce7415b36db10ddc5281c53a', c0: WETH, c1: TKN, r0: 30n * ETH, r1: 9000000n * WB });
  let hook = null;
  if (hooked) hook = chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 500, ts: 10, hooks: HOOK, r0: 100n * ETH, r1: 32000000n * WB, bonusBips: hooked.bonusBips });
  return { chain, v4, v2, hook };
}

/** The shared list, as the shipped JSON would give it: these pools, up to KNOWN_BLOCK. */
function knownOf(chain, block = KNOWN_BLOCK) {
  const pools = [];
  for (const p of chain.v2.values()) pools.push(new UniV2Pool({ pair: p.pair, currency0: p.c0, currency1: p.c1 }));
  for (const p of chain.v3.values()) pools.push(new UniV3Pool({ pool: p.pool, currency0: p.c0, currency1: p.c1, fee: p.fee, tickSpacing: p.ts }));
  for (const p of chain.v4.values()) pools.push(p.pool);
  return { block, pools };
}

function setup(chain, opts = {}) {
  const discovery = new UniswapDiscovery({ rpc: chain.rpc, known: opts.known ?? knownOf(chain), store: opts.store ?? memoryPoolStore(), fullyListed: opts.fullyListed ?? [TKN] });
  const quoter = new UniswapQuoter({ rpc: chain.rpc, discovery, ...(opts.quoter ?? {}) });
  return { discovery, quoter };
}

/** What a part should give, worked out from the pools' reserves. */
function expectedOut(chain, part) {
  let a = part.amountIn;
  for (const h of part.route.hops) {
    const p = h.pool;
    if (p instanceof UniV2Pool) {
      const s = chain.v2.get(p.pair);
      a = h.zeroForOne ? v2AmountOut(a, s.r0, s.r1) : v2AmountOut(a, s.r1, s.r0);
    } else if (p instanceof UniV4Pool) {
      const s = chain.v4.get(p.id);
      a = cpOut(a, h.zeroForOne ? s.r0 : s.r1, h.zeroForOne ? s.r1 : s.r0, s.lpFee);
      a = (a * BigInt(10000 + s.bonusBips)) / 10000n;
    } else {
      const s = chain.v3.get(p.pool);
      a = cpOut(a, h.zeroForOne ? s.r0 : s.r1, h.zeroForOne ? s.r1 : s.r0, s.fee);
    }
  }
  return a;
}

test('discovery: the shared list is used as it is while it is recent; no event search', async () => {
  const { chain, v4, v2 } = tokenChain();
  const { discovery } = setup(chain);
  const native = await discovery.poolsBetween(NATIVE_ETH, TKN);
  assert.deepEqual(
    native.map((p) => p.id),
    [v4.pool.id],
  );
  const wrapped = await discovery.poolsBetween(WETH, TKN);
  assert.ok(wrapped.some((p) => p.id === v2.pair));
  assert.equal(chain.asked.getLogs, 0);
  const states = await discovery.liveState([...native, ...wrapped]);
  assert.ok(states.get(v4.pool.id).isLive);
  assert.ok(states.get(v2.pair).isLive);
  assert.equal(states.get(v4.pool.id).lpFee, 3000);
  // The v4 price is raw TKN per wei: 32,000,000 TKN / 100 ETH.
  const price = states.get(v4.pool.id).price0to1;
  assert.ok(Math.abs(price - 32e6 * 1e8 / 100e18) / price < 1e-9);
});

test('discovery: pools created after the list are found from events, and the cursor goes through the store', async () => {
  const { chain } = tokenChain({ head: KNOWN_BLOCK + 2500 });
  const later = chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 500, ts: 10, r0: ETH, r1: 320000n * WB, block: KNOWN_BLOCK + 1200 });
  const writes = [];
  const inner = memoryPoolStore();
  const store = { read: (k) => inner.read(k), write: (k, v) => (writes.push([k, v]), inner.write(k, v)) };
  const { discovery } = setup(chain, { store, known: knownOf({ v2: chain.v2, v3: chain.v3, v4: new Map([...chain.v4].filter(([id]) => id !== later.pool.id)) }) });
  const pools = await discovery.poolsBetween(NATIVE_ETH, TKN);
  assert.ok(pools.some((p) => p.id === later.pool.id), 'the new pool');
  assert.equal(chain.asked.getLogs, 1, 'one window of at most 10,000 blocks');
  const v4write = writes.find(([k]) => k === `v4:${NATIVE_ETH}:${TKN}`);
  assert.equal(v4write[1].to, KNOWN_BLOCK + 2500, 'searched up to the head');
  assert.ok(v4write[1].pools.some((p) => p.v === 'v4' && p.fee === 500), 'stored as plain JSON');
  // Again at the same head: nothing new to search.
  await discovery.poolsBetween(NATIVE_ETH, TKN);
  assert.equal(chain.asked.getLogs, 1);
  // A new discovery with the same store starts where this one stopped.
  const again = new UniswapDiscovery({ rpc: chain.rpc, known: knownOf(chain), store, fullyListed: [TKN] });
  chain.head += 1000;
  await again.poolsBetween(NATIVE_ETH, TKN);
  assert.equal(chain.asked.getLogs, 2);
});

test('discovery: a server with a smaller window is followed, and a long search goes on in the background', async () => {
  const { chain } = tokenChain({ head: KNOWN_BLOCK + 9000 });
  chain.logPolicy = { maxRange: 2000 };
  // A key the direct lookups do not try, so only the event search can find it.
  const late = chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 2500, ts: 50, r0: ETH, r1: 320000n * WB, block: KNOWN_BLOCK + 8500 });
  const store = memoryPoolStore();
  const known = knownOf({ v2: chain.v2, v3: chain.v3, v4: new Map([...chain.v4].filter(([id]) => id !== late.pool.id)) });
  const { discovery } = setup(chain, { store, known });
  const first = await discovery.poolsBetween(NATIVE_ETH, TKN);
  // Three requests at most while a quote waits: refused at 10,000, then 2,000-block windows.
  assert.ok(!first.some((p) => p.id === late.pool.id), 'not reached yet');
  assert.equal(discovery._logRange, 2000);
  await discovery.idle();
  const stored = await store.read(`v4:${NATIVE_ETH}:${TKN}`);
  assert.equal(stored.to, KNOWN_BLOCK + 9000, 'the background search finished');
  const second = await discovery.poolsBetween(NATIVE_ETH, TKN);
  assert.ok(second.some((p) => p.id === late.pool.id));
  assert.equal(discovery.source, 'events');
});

test('discovery: a server that will not search events gets direct lookups instead', async () => {
  for (const policy of [{ maxRange: 100 }, { missing: true }]) {
    const chain = new FakeChain({ head: 26200000 });
    // KAS is not in the shared list: everything must come from the server.
    const v4 = chain.addV4({ c0: NATIVE_ETH, c1: KAS, fee: 3000, ts: 60, r0: ETH, r1: 1000n * WB });
    const hooked = chain.addV4({ c0: NATIVE_ETH, c1: KAS, fee: 3000, ts: 60, hooks: HOOK, r0: ETH, r1: 1000n * WB });
    const v3 = chain.addV3({ pool: '0x00000000000000000000000000000000000000a3', c0: KAS, c1: WETH, fee: 3000, ts: 60, r0: 1000n * WB, r1: ETH });
    chain.logPolicy = policy;
    const { discovery } = setup(chain, { known: { block: KNOWN_BLOCK, pools: [] } });
    const native = await discovery.poolsBetween(NATIVE_ETH, KAS);
    assert.deepEqual(
      native.map((p) => p.id),
      [v4.pool.id],
      'the plain v4 pool by its key; a hooked one cannot be guessed',
    );
    assert.ok(!native.some((p) => p.id === hooked.pool.id));
    const wrapped = await discovery.poolsBetween(WETH, KAS);
    assert.ok(wrapped.some((p) => p.id === v3.pool), 'the v3 pool by fee tier');
    assert.equal(discovery.source, 'lookups');
    const asked = chain.asked.getLogs;
    await discovery.poolsBetween(USDC, KAS);
    assert.equal(chain.asked.getLogs, asked, 'no more event searches this session');
    await discovery.idle();
  }
});

test('discovery: a busy server gets lookups this time and events the next', async () => {
  const chain = new FakeChain({ head: KNOWN_BLOCK + 1000 });
  chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 3000, ts: 60, r0: ETH, r1: 1000n * WB, block: KNOWN_BLOCK + 10 });
  chain.logPolicy = { maxRange: 10000, busyOnce: true };
  const { discovery } = setup(chain, { known: { block: KNOWN_BLOCK, pools: [] } });
  const first = await discovery.poolsBetween(NATIVE_ETH, TKN);
  assert.equal(first.length, 1, 'found by the lookup');
  assert.equal(discovery.source, 'events');
  const second = await discovery.poolsBetween(NATIVE_ETH, TKN);
  assert.equal(second.length, 1, 'found by the event search');
  assert.equal(chain.asked.getLogs, 2);
});

test('discovery: removed, foreign and malformed logs are skipped; a broken store is only a cache', async () => {
  const chain = new FakeChain({ head: KNOWN_BLOCK + 1000 });
  const good = chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 3000, ts: 60, r0: ETH, r1: 1000n * WB, block: KNOWN_BLOCK + 5 });
  const base = chain.logs[chain.logs.length - 1];
  // The same event with another pool's id, a removed one, a short one, and one from another contract.
  chain.logs.push({ ...base, topics: [base.topics[0], `0x${'11'.repeat(32)}`, base.topics[2], base.topics[3]] });
  chain.logs.push({ ...base, removed: true, data: base.data.slice(), topics: [...base.topics.slice(0, 1), new UniV4Pool({ currency0: NATIVE_ETH, currency1: TKN, fee: 3000, ts: 60, tickSpacing: 61, hooks: NATIVE_ETH }).id, ...base.topics.slice(2)] });
  chain.logs.push({ ...base, data: base.data.slice(0, 40) });
  const broken = { read: async () => ({ to: 'soon', pools: 'many' }), write: async () => Promise.reject(new Error('quota')) };
  const { discovery } = setup(chain, { store: broken, known: { block: KNOWN_BLOCK, pools: [] } });
  const pools = await discovery.poolsBetween(NATIVE_ETH, TKN);
  assert.deepEqual(
    pools.map((p) => p.id),
    [good.pool.id],
  );
});

test('quoter: a small purchase stays in the deep pool, and gives exactly what the pool gives', async () => {
  const { chain, v4 } = tokenChain();
  const { quoter } = setup(chain);
  const q = await quoter.bestQuote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 100n, gasPriceWei: 20n * 10n ** 9n });
  assert.equal(q.parts.length, 1);
  assert.equal(q.route.hops[0].pool.id, v4.pool.id);
  assert.equal(q.amountOut, expectedOut(chain, q.parts[0]));
  assert.equal(q.amountIn, ETH / 100n);
  assert.equal(q.block, chain.head);
  assert.ok(q.priceImpact !== null && q.priceImpact < 0.001, String(q.priceImpact));
  assert.equal(q.minimumOut(100), (q.amountOut * 99n) / 100n);
});

test('quoter: a large purchase is shared between pools, in twentieths, each pool once, and beats any one pool', async () => {
  const { chain, v4, v2 } = tokenChain();
  const { quoter } = setup(chain);
  const amountIn = 20n * ETH;
  const q = await quoter.bestQuote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn, gasPriceWei: 10n ** 9n });
  assert.ok(q.isSplit);
  const ids = q.pools.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'a pool used twice');
  assert.deepEqual(new Set(ids), new Set([v4.pool.id, v2.pair]));
  assert.equal(
    q.parts.reduce((s, p) => s + p.amountIn, 0n),
    amountIn,
  );
  for (const p of q.parts) {
    assert.equal(p.amountOut, expectedOut(chain, p), 'each share priced at its own size');
    assert.equal((p.amountIn * 20n) % amountIn, 0n, 'whole twentieths');
  }
  const alone = cpOut(amountIn, 100n * ETH, 32000000n * WB, 3000);
  assert.ok(q.amountOut > alone, 'more than the deepest pool alone');
  const single = await new UniswapQuoter({ rpc: chain.rpc, discovery: quoter.discovery, maxParts: 1 }).bestQuote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn, gasPriceWei: 10n ** 9n });
  assert.equal(single.parts.length, 1);
  assert.ok(q.amountOut > single.amountOut);
  assert.ok(q.priceImpact < single.priceImpact);
});

test('quoter: a token only reachable through a route base (USDC) is quoted over two pools', async () => {
  const { chain } = tokenChain();
  const ethUsdc = chain.addV4({ c0: NATIVE_ETH, c1: USDC, fee: 3000, ts: 60, r0: 100n * ETH, r1: 250000n * 10n ** 6n });
  const kasPool = chain.addV4({ c0: KAS, c1: USDC, fee: 10000, ts: 200, r0: 100000n * WB, r1: 20000n * 10n ** 6n });
  const { quoter, discovery } = setup(chain, { fullyListed: [TKN, KAS] });
  const q = await quoter.bestQuote({ tokenIn: ETH_TOKEN, tokenOut: kas, amountIn: ETH / 1000n, gasPriceWei: 10n ** 9n });
  assert.equal(q.route.hops.length, 2);
  assert.equal(q.route.hops[0].pool.id, ethUsdc.pool.id);
  assert.equal(q.route.hops[0].currencyOut, USDC);
  assert.equal(q.route.hops[1].pool.id, kasPool.pool.id);
  assert.equal(q.amountOut, expectedOut(chain, q.parts[0]));
  assert.equal(q.parts[0].hopOutputs.length, 2);
  await discovery.idle();
});

test('quoter: a hooked pool that quotes far above the rest is left out unless its swap is simulated', async () => {
  const { chain, v4, hook } = tokenChain({ hooked: { bonusBips: 2000 } });
  const { quoter } = setup(chain);
  const args = { tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 10n, gasPriceWei: 10n ** 9n };
  const plain = await quoter.bestQuote(args);
  assert.ok(!plain.pools.some((p) => p.id === hook.pool.id), 'not believed unverified');
  assert.ok(plain.pools.some((p) => p.id === v4.pool.id));

  // The simulation says its swap goes through: it is used.
  const trusted = await quoter.bestQuote({ ...args, simulate: async () => true });
  assert.ok(trusted.pools.some((p) => p.id === hook.pool.id));
  assert.ok(trusted.amountOut > plain.amountOut);

  // The simulation says it reverts: left out for the session.
  const seen = [];
  const refused = await quoter.bestQuote({ ...args, simulate: async (q) => (seen.push(q), !q.pools.some((p) => p.id === hook.pool.id)) });
  assert.ok(!refused.pools.some((p) => p.id === hook.pool.id));
  assert.ok(quoter.distrusted.has(hook.pool.id));
  assert.ok(seen.length >= 1);
  const later = await quoter.bestQuote({ ...args, simulate: async () => true });
  assert.ok(!later.pools.some((p) => p.id === hook.pool.id), 'still distrusted');
});

test('quoter: a hooked pool priced like the others is used without a simulation', async () => {
  const { chain, hook } = tokenChain({ hooked: { bonusBips: 0 } });
  const { quoter } = setup(chain);
  // The hooked pool charges 0.05 % and the plain one 0.3 %: a little better, well within 1 %.
  const q = await quoter.bestQuote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 10n, gasPriceWei: 10n ** 9n });
  assert.ok(q.pools.some((p) => p.id === hook.pool.id));
});

test('quoter: no pool, nothing back, and the same asset are told apart', async () => {
  const { chain } = tokenChain();
  const { quoter, discovery } = setup(chain);
  const nowhere = new UniToken({ address: '0x00000000000000000000000000000000000000ff', symbol: 'NONE', decimals: 18 });
  // Pools into TKN exist, but none on to the token: no route, not "too small".
  await assert.rejects(quoter.bestQuote({ tokenIn: ETH_TOKEN, tokenOut: nowhere, amountIn: ETH }), (e) => e instanceof UniswapNoRoute && e.reason === 'noPool');
  await assert.rejects(quoter.bestQuote({ tokenIn: nowhere, tokenOut: kas, amountIn: ETH }), (e) => e.reason === 'noPool');
  await assert.rejects(quoter.bestQuote({ tokenIn: ETH_TOKEN, tokenOut: weth, amountIn: ETH }), (e) => e.reason === 'sameAsset');
  await assert.rejects(quoter.bestQuote({ tokenIn: tkn, tokenOut: ETH_TOKEN, amountIn: 0n }), (e) => e.reason === 'tooSmall');
  await assert.rejects(quoter.bestQuote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: 1n }), (e) => e.reason === 'tooSmall');
  await discovery.idle();
});

test('quoter: rankings are kept five minutes; requote prices the same routes again', async () => {
  const { chain, v4 } = tokenChain();
  let now = 1000000;
  const discovery = new UniswapDiscovery({ rpc: chain.rpc, known: knownOf(chain), fullyListed: [TKN] });
  let searches = 0;
  const between = discovery.poolsBetween.bind(discovery);
  discovery.poolsBetween = (...a) => (searches++, between(...a));
  const quoter = new UniswapQuoter({ rpc: chain.rpc, discovery, now: () => now });
  const args = { tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 100n, gasPriceWei: 10n ** 9n };
  const q = await quoter.bestQuote(args);
  const first = searches;
  await quoter.bestQuote(args);
  assert.equal(searches, first, 'ranked pools reused');
  now += RANKING_LIFE_MS + 1;
  await quoter.bestQuote(args);
  assert.equal(searches, 2 * first, 'read again after five minutes');

  const same = await quoter.requote(q);
  assert.equal(same.amountOut, q.amountOut);
  // Someone buys first: the same route now gives less.
  chain.trade(v4, NATIVE_ETH, 10n * ETH);
  const moved = await quoter.requote(q);
  assert.ok(moved.amountOut < q.amountOut);
  assert.equal(moved.route.id, q.route.id);
  const double = await quoter.requote(q, { amountIn: 2n * q.amountIn });
  assert.equal(double.amountIn, 2n * q.amountIn);
});

test('the shared list parses, and discovery needs it', () => {
  assert.throws(() => new UniswapDiscovery({ rpc: {} }), /known pools/);
  const known = parseKnownPools({ format: 1, block: 7, currencies: [NATIVE_ETH, TKN], hooks: [NATIVE_ETH], pools: [[4, 0, 1, 10000, 200, 0]] });
  assert.equal(known.pools[0].id, '0xce7ff1b044aaee5bf9e632a3b537e10fbca0222004ee50348d492c1e5b54419c');
  assert.ok(DEPLOY_BLOCKS.v4PoolManager < KNOWN_BLOCK);
});

test('the shipped list loads from beside the module, from the app\'s own origin', async () => {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push([url, init]);
    return new Response(readFileSync(url, 'utf8'), { status: 200 });
  };
  const known = await loadKnownPools(fetch);
  assert.equal(known.pools.length, 1253);
  assert.equal(known.block, 26155432);
  assert.equal(asked.length, 1);
  assert.ok(String(asked[0][0]).endsWith('/src/lib/eth/uniswap/known_pools.json'));
  assert.equal(asked[0][1].credentials, 'omit');
  await assert.rejects(loadKnownPools(async () => new Response('', { status: 404 })), /could not be loaded/);
});
