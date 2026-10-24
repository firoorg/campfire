// A port of the desktop app's test/eth/uniswap/uniswap_split_test.dart:
// sharing one swap between routes, without a network (the allocator against
// a brute-force search), and what the router commands of a shared swap mean
// (each share's own minimum, ETH wrapped only for the WETH pools, one Permit2
// permit for every share).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestSplit, splitCurve } from '../../src/lib/eth/uniswap/split.js';
import { v2AmountOut } from '../../src/lib/eth/uniswap/quoter.js';
import { buildPlan, PlanError } from '../../src/lib/eth/uniswap/planner.js';
import { UniToken, UniV4Pool, UniV2Pool, UniHop, UniRoute, UniPart, UniQuote, ETH_TOKEN } from '../../src/lib/eth/uniswap/models.js';
import { ADDRESSES, NATIVE_ETH, WETH, UR_COMMAND, V4_ACTION, UR_CONSTANTS } from '../../src/lib/eth/uniswap/constants.js';
import { abiDecode } from '../../src/lib/eth/abi.js';

const tkn = new UniToken({ address: '0xe5acbb03d73267c03349c76ead672ee4d941f499', symbol: 'TKN', decimals: 8 });
const v4EthTkn = new UniV4Pool({ currency0: NATIVE_ETH, currency1: tkn.address, fee: 10000, tickSpacing: 200, hooks: NATIVE_ETH });
const v2WethTkn = new UniV2Pool({ pair: '0xc821395f890913b9ce7415b36db10ddc5281c53a', currency0: WETH, currency1: tkn.address });

/** A constant-product pool's output for `steps` steps of stepIn. */
function curve(steps, stepIn, rIn, rOut) {
  const out = [0n];
  for (let k = 1; k <= steps; k++) out.push(v2AmountOut(stepIn * BigInt(k), rIn, rOut));
  return out;
}

const E = (n, e) => BigInt(n) * 10n ** BigInt(e);
const sum = (a) => a.reduce((x, y) => x + y, 0);

/** The best sharing by trying every one (small cases only). */
function bruteForce(curves, steps, maxParts) {
  let best = null;
  const go = (i, left, parts, total, pools) => {
    if (i === curves.length) {
      if (left === 0 && parts > 0 && (best === null || total > best)) best = total;
      return;
    }
    go(i + 1, left, parts, total, pools);
    const c = curves[i];
    if (parts === maxParts || [...c.pools].some((p) => pools.has(p))) return;
    for (let j = 1; j <= left; j++) {
      const out = c.outs[j];
      if (out === null || out <= 0n) continue;
      go(i + 1, left - j, parts + 1, total + out - c.cost, new Set([...pools, ...c.pools]));
    }
  };
  go(0, steps, 0, 0n, new Set());
  return best;
}

/** A small seeded generator (mulberry32), so the random cases are the same every run. */
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (n) => Math.floor(next() * n), bool: () => next() < 0.5 };
}

test('two equal pools share the swap half and half', () => {
  const c = curve(20, E(1, 18), E(100, 18), E(1, 12));
  const split = bestSplit([splitCurve({ pools: ['a'], outs: c, cost: 0n }), splitCurve({ pools: ['b'], outs: c, cost: 0n })], { steps: 20 });
  assert.deepEqual(split.steps, [10, 10]);
});

test('a pool four times deeper takes about four fifths', () => {
  const split = bestSplit(
    [splitCurve({ pools: ['deep'], outs: curve(20, E(1, 18), E(400, 18), E(4, 12)), cost: 0n }), splitCurve({ pools: ['shallow'], outs: curve(20, E(1, 18), E(100, 18), E(1, 12)), cost: 0n })],
    { steps: 20 },
  );
  assert.deepEqual(split.steps, [16, 4]);
});

test('a second pool is not used when its gas costs more than it saves', () => {
  const c = curve(20, E(1, 15), E(100, 18), E(1, 12));
  // A whole 1 % of the output per extra route: far more than splitting 0.02 ETH between two deep pools saves.
  const cost = c[20] / 100n;
  const split = bestSplit([splitCurve({ pools: ['a'], outs: c, cost }), splitCurve({ pools: ['b'], outs: c, cost })], { steps: 20 });
  assert.equal(split.parts, 1);
  assert.equal(sum(split.steps), 20);
});

test('routes through the same pool are never used together', () => {
  const c = curve(10, E(1, 18), E(50, 18), E(5, 11));
  const split = bestSplit([splitCurve({ pools: ['x', 'y'], outs: c, cost: 0n }), splitCurve({ pools: ['x', 'z'], outs: c, cost: 0n }), splitCurve({ pools: ['w'], outs: c, cost: 0n })], { steps: 10 });
  assert.equal(split.steps[0] > 0 && split.steps[1] > 0, false);
  assert.equal(split.parts, 2);
});

test('many routes through one first pool: still never two of them', () => {
  // Every way on from one pool: twelve routes, all sharing 'first'.
  const curves = [];
  for (let i = 0; i < 12; i++) curves.push(splitCurve({ pools: ['first', `second${i}`], outs: curve(20, E(1, 17), E(10 + i, 17), E(10 + i, 10)), cost: 0n }));
  curves.push(splitCurve({ pools: ['other'], outs: curve(20, E(1, 17), E(20, 17), E(20, 10)), cost: 0n }));
  const split = bestSplit(curves, { steps: 20 });
  const usingFirst = split.steps.slice(0, 12).filter((s) => s > 0);
  assert.ok(usingFirst.length <= 1, String(usingFirst));
  assert.equal(sum(split.steps), 20);
});

test('matches a brute-force search on random pools', () => {
  const r = rng(7);
  const names = ['p', 'q', 'r', 's'];
  for (let round = 0; round < 200; round++) {
    const steps = 8;
    const n = 2 + r.int(3);
    const curves = [];
    for (let i = 0; i < n; i++) {
      const pools = [names[r.int(4)]];
      if (r.bool()) pools.push(names[r.int(4)]);
      curves.push(splitCurve({ pools, outs: curve(steps, E(1, 17), E(1 + r.int(40), 17), E(1 + r.int(40), 10)), cost: E(r.int(3), 7) }));
    }
    const maxParts = 1 + r.int(3);
    const got = bestSplit(curves, { steps, maxParts });
    const want = bruteForce(curves, steps, maxParts);
    assert.equal(got?.net ?? null, want, `round ${round}`);
    if (got) {
      assert.equal(sum(got.steps), steps);
      assert.ok(got.parts <= maxParts);
      const used = curves.filter((_, i) => got.steps[i] > 0).map((c) => c.pools);
      for (let i = 0; i < used.length; i++) for (let j = i + 1; j < used.length; j++) assert.ok(![...used[i]].some((p) => used[j].has(p)), `round ${round}: a pool used twice`);
    }
  }
});

test('a route that does not quote at some size is never given that size', () => {
  const c = curve(4, E(1, 17), E(10, 17), E(10, 10));
  const broken = [0n, c[1], null, null, null];
  const split = bestSplit([splitCurve({ pools: ['a'], outs: broken, cost: 0n }), splitCurve({ pools: ['b'], outs: c, cost: 0n })], { steps: 4 });
  assert.ok(split.steps[0] <= 1);
  assert.equal(bestSplit([splitCurve({ pools: ['a'], outs: broken, cost: 0n })], { steps: 4 }), null);
});

// ------------------------------------------------------- the router call for a shared swap

const deadline = 1791557000n;
const eth = 10n ** 18n;
const part = (hop, amountIn, amountOut) => new UniPart({ route: new UniRoute([hop]), amountIn, amountOut, hopOutputs: [amountOut], gas: 100000n });
const V4_SWAP_PARAMS = '((address,address,uint24,int24,address),bool,uint128,uint128,bytes)';

test('ETH → TKN: wraps only the v2 share, each pool its own minimum', () => {
  const q = new UniQuote({
    tokenIn: ETH_TOKEN,
    tokenOut: tkn,
    amountIn: eth,
    parts: [part(new UniHop(v4EthTkn, NATIVE_ETH, tkn.address), (eth * 7n) / 10n, E(220000, 8)), part(new UniHop(v2WethTkn, WETH, tkn.address), (eth * 3n) / 10n, E(93000, 8))],
    gasEstimate: 280000n,
    block: 1,
  });
  const plan = buildPlan({ quote: q, slippageBips: 50, deadline });
  assert.deepEqual([...plan.commands], [UR_COMMAND.wrapEth, UR_COMMAND.v4Swap, UR_COMMAND.v2SwapExactIn]);
  assert.equal(plan.value, eth);
  const minV4 = (E(220000, 8) * 9950n) / 10000n;
  const minV2 = (E(93000, 8) * 9950n) / 10000n;
  assert.equal(plan.minimumOut, minV4 + minV2);

  // Exactly the v2 share is wrapped; the rest stays ETH for v4.
  assert.equal(abiDecode('address,uint256', plan.inputs[0])[1], (eth * 3n) / 10n);

  const [actions, params] = abiDecode('bytes,bytes[]', plan.inputs[1]);
  assert.deepEqual([...actions], [V4_ACTION.settle, V4_ACTION.swapExactInSingle, V4_ACTION.takeAll]);
  const settle = abiDecode('address,uint256,bool', params[0]);
  assert.equal(settle[1], (eth * 7n) / 10n);
  assert.equal(settle[2], false, 'paid from the ETH sent with the call');
  assert.equal(abiDecode(V4_SWAP_PARAMS, params[1])[0][3], minV4);
  assert.equal(abiDecode('address,uint256', params[2])[1], minV4);

  const v2 = abiDecode('address,uint256,uint256,address[],bool', plan.inputs[2]);
  assert.equal(v2[0].toLowerCase(), UR_CONSTANTS.msgSender);
  assert.equal(v2[1], (eth * 3n) / 10n);
  assert.equal(v2[2], minV2);
  assert.equal(v2[4], false);
});

test('TKN → ETH: one permit pays both shares; the WETH share is unwrapped at the end', () => {
  const amount = E(300000, 8);
  const q = new UniQuote({
    tokenIn: tkn,
    tokenOut: ETH_TOKEN,
    amountIn: amount,
    parts: [part(new UniHop(v4EthTkn, tkn.address, NATIVE_ETH), E(180000, 8), E(55, 16)), part(new UniHop(v2WethTkn, tkn.address, WETH), E(120000, 8), E(36, 16))],
    gasEstimate: 280000n,
    block: 1,
  });
  const permit = { permit: { token: tkn.address, amount, expiration: 1791557000, nonce: 0, spender: ADDRESSES.universalRouter, sigDeadline: deadline }, signature: new Uint8Array(65) };
  const plan = buildPlan({ quote: q, slippageBips: 100, deadline, permit });
  assert.deepEqual([...plan.commands], [UR_COMMAND.permit2Permit, UR_COMMAND.v4Swap, UR_COMMAND.v2SwapExactIn, UR_COMMAND.unwrapWeth]);
  assert.equal(plan.value, 0n);
  const [, params] = abiDecode('bytes,bytes[]', plan.inputs[1]);
  const settle = abiDecode('address,uint256,bool', params[0]);
  assert.equal(settle[1], E(180000, 8));
  assert.equal(settle[2], true, 'taken from the wallet through Permit2');
  const v2 = abiDecode('address,uint256,uint256,address[],bool', plan.inputs[2]);
  assert.equal(v2[0].toLowerCase(), UR_CONSTANTS.addressThis);
  assert.equal(v2[1], E(120000, 8));
  assert.equal(v2[2], (E(36, 16) * 99n) / 100n);
  assert.equal(v2[4], true);
  const unwrap = abiDecode('address,uint256', plan.inputs[3]);
  assert.equal(unwrap[0].toLowerCase(), UR_CONSTANTS.msgSender);
  assert.equal(unwrap[1], (E(36, 16) * 99n) / 100n);
});

test('shares that do not add up to the amount are refused', () => {
  const q = new UniQuote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: eth, parts: [part(new UniHop(v4EthTkn, NATIVE_ETH, tkn.address), eth / 2n, 1n)], gasEstimate: 1n, block: 1 });
  assert.throws(() => buildPlan({ quote: q, slippageBips: 50, deadline }), PlanError);
});
