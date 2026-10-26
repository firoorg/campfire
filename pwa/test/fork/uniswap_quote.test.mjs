// The Uniswap quote against a local anvil mainnet fork: the contracts are
// where the constants say, the rsFIRO pools are found, and every price the
// quoter gives for ETH → rsFIRO is what Uniswap's own quoter contracts (and
// the v2 router) answer when asked directly, one call each, outside
// Multicall3. Read-only; still under the fork lock, so no other test moves a
// pool half-way.
//
//   node --test --test-concurrency=1 test/fork/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { anvilProblem, withFork, forkRpc, service, knownPools, ETH, ANVIL } from './uniswap_support.mjs';
import { EthRpc } from '../../src/lib/eth/rpc.js';
import { routeOutOn } from '../../src/lib/eth/uniswap_app.js';
import { secondOpinion } from '../../src/lib/eth/second_opinion.js';
import { ADDRESSES, NATIVE_ETH, WETH } from '../../src/lib/eth/uniswap/constants.js';
import { ETH_TOKEN, UniToken, UniV2Pool, UniV3Pool, UniV4Pool } from '../../src/lib/eth/uniswap/models.js';
import { encodeCall, abiDecode, selector } from '../../src/lib/eth/abi.js';
import { permit2DomainSeparator } from '../../src/lib/eth/tx.js';
import { tokenByAddress, RSFIRO as RSFIRO_ENTRY } from '../../src/lib/eth/tokens.js';
import { bytesToHex } from '../../src/lib/eth/hex.js';

const skip = await anvilProblem();
const rsfiro = new UniToken(RSFIRO_ENTRY);
/** Uniswap's V2 Router02, asked only by this test (the app prices v2 from reserves). */
const V2_ROUTER = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
/** rsFIRO/WETH on Uniswap v3: 0.3% (the deep one) and 1%. */
const RSFIRO_WETH_V3 = '0x385cd0e67ceae18d38c415bb01df62bace0c25ba';
const RSFIRO_WETH_V3_1PC = '0x191789cc84a14f5eefae1ecaa7addd6a9cf4f259';
const T = { skip: skip || false, timeout: 15 * 60 * 1000 };

/** What Uniswap's own contracts say one hop gives, asked with one plain eth_call. */
async function onChainHop(rpc, hop, amountIn) {
  const p = hop.pool;
  if (p instanceof UniV2Pool) {
    const r = await rpc.ethCall({ to: V2_ROUTER, data: encodeCall('getAmountsOut(uint256,address[])', [amountIn, [hop.currencyIn, hop.currencyOut]]) });
    const [amounts] = abiDecode('uint256[]', r);
    return amounts[1];
  }
  if (p instanceof UniV3Pool) {
    const r = await rpc.ethCall({ to: ADDRESSES.v3QuoterV2, data: encodeCall('quoteExactInputSingle((address,address,uint256,uint24,uint160))', [[hop.currencyIn, hop.currencyOut, amountIn, p.fee, 0n]]) });
    return abiDecode('uint256,uint160,uint32,uint256', r)[0];
  }
  const r = await rpc.ethCall({ to: ADDRESSES.v4Quoter, data: encodeCall('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))', [[p.key, hop.zeroForOne, amountIn, new Uint8Array(0)]]) });
  return abiDecode('uint256,uint256', r)[0];
}

async function onChainPart(rpc, part, amountIn) {
  const outs = [];
  let a = amountIn;
  for (const h of part.route.hops) {
    a = await onChainHop(rpc, h, a);
    outs.push(a);
  }
  return outs;
}

function describe(q) {
  return q.parts.map((p) => `${(Number((p.amountIn * 10000n) / q.amountIn) / 100).toFixed(2)}% ${p.route.hops.map((h) => `${h.pool.version}/${h.pool.fee ?? 'dyn'}${h.pool instanceof UniV4Pool && h.pool.hasHooks ? '+hook' : ''}`).join('>')} → ${p.amountOut}`).join('; ');
}

test('fork: the Uniswap contracts are where the constants say', T, async () => {
  await withFork(async () => {
    const rpc = forkRpc();
    await rpc.assertMainnet();
    for (const [name, address] of Object.entries(ADDRESSES)) {
      if (address === NATIVE_ETH) continue;
      assert.ok((await rpc.getCode(address)).length > 0, `${name} has code`);
    }
    const addr = async (to, sig) => abiDecode('address', await rpc.ethCall({ to, data: selector(sig) }))[0].toLowerCase();
    assert.equal(await addr(ADDRESSES.v4StateView, 'poolManager()'), ADDRESSES.v4PoolManager);
    assert.equal(await addr(ADDRESSES.v3QuoterV2, 'factory()'), ADDRESSES.v3Factory);
    assert.equal(await addr(ADDRESSES.v3QuoterV2, 'WETH9()'), WETH);
    assert.equal(bytesToHex(await rpc.ethCall({ to: ADDRESSES.permit2, data: selector('DOMAIN_SEPARATOR()') })), bytesToHex(permit2DomainSeparator()));
    assert.ok(tokenByAddress(rsfiro.address));
  });
});

test('fork: the rsFIRO pools are found on v3, and are live', T, async () => {
  await withFork(async () => {
    const svc = service();
    const wrapped = await svc.discovery.poolsBetween(WETH, rsfiro.address);
    assert.ok(wrapped.some((p) => p instanceof UniV3Pool && p.pool === RSFIRO_WETH_V3 && p.fee === 3000));
    assert.ok(wrapped.some((p) => p instanceof UniV3Pool && p.pool === RSFIRO_WETH_V3_1PC && p.fee === 10000));
    const states = await svc.discovery.liveState(wrapped);
    assert.ok(states.get(RSFIRO_WETH_V3).isLive);
  });
});

for (const [label, amountIn] of [
  ['0.01 ETH', ETH / 100n],
  ['2 ETH', 2n * ETH],
]) {
  test(`fork: ETH → rsFIRO, ${label}: every share is what Uniswap's quoters answer directly`, T, async (t) => {
    await withFork(async () => {
      const rpc = forkRpc();
      const svc = service(rpc);
      const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: rsfiro, amountIn });
      t.diagnostic(`quote: ${q.amountOut} raw rsFIRO for ${label} at block ${q.block}, impact ${(q.priceImpact * 100).toFixed(3)} %: ${describe(q)}`);
      assert.ok(q.amountOut > 0n);
      assert.equal(
        q.parts.reduce((s, p) => s + p.amountIn, 0n),
        amountIn,
      );
      const ids = q.pools.map((p) => p.id);
      assert.equal(new Set(ids).size, ids.length, 'no pool twice');
      // The same routes priced again at each share's exact amount.
      const fresh = await svc.quoter.requote(q);
      let total = 0n;
      for (const [i, part] of q.parts.entries()) {
        const outs = await onChainPart(rpc, part, part.amountIn);
        t.diagnostic(`share ${i}: in ${part.amountIn}; on-chain quoters ${outs.join(' → ')}; quoter ${fresh.parts[i].hopOutputs.join(' → ')}`);
        assert.deepEqual(fresh.parts[i].hopOutputs, outs, `share ${i}, hop by hop`);
        total += outs[outs.length - 1];
        // The quote itself prices the largest share at its whole twentieths; it may
        // carry a few raw units more than it was priced at, never fewer.
        assert.ok(part.amountOut <= outs[outs.length - 1]);
        assert.ok(outs[outs.length - 1] - part.amountOut <= outs[outs.length - 1] / 10n ** 9n + 1n);
      }
      assert.equal(fresh.amountOut, total);
      if (amountIn === ETH / 100n) assert.equal(q.amountOut, total, 'a single share is priced exactly');
    });
  });
}

test('fork (D-06): the reviewed route priced again on a second listed server: the same figure; a quote 5% low is caught', T, async () => {
  await withFork(async () => {
    const svc = service(forkRpc());
    const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: rsfiro, amountIn: ETH / 10n });
    const asked = [];
    // Each listed server, pointed at the fork: the second opinion is a real Uniswap pricing of the same pools.
    const makeRpc = (h) => {
      asked.push(h.id);
      return new EthRpc(h, { fetch: (_u, init) => fetch(ANVIL, init), timeoutMs: 8 * 60 * 1000 });
    };
    const quoteOn = (rpc) => routeOutOn(rpc, q, knownPools());
    const same = await secondOpinion({ chainKey: 'ethereum', chosenId: 'stackwallet', mine: q.amountOut, quoteOn, makeRpc });
    assert.equal(same.status, 'agree');
    assert.equal(same.host.id, 'publicnode');
    assert.equal(same.theirs, q.amountOut, 'the same block, the same pools: the same amount');
    assert.deepEqual(asked, ['publicnode'], 'one other server, not the chosen one');
    const low = await secondOpinion({ chainKey: 'ethereum', chosenId: 'stackwallet', mine: (q.amountOut * 95n) / 100n, quoteOn, makeRpc });
    assert.equal(low.status, 'differ');
    assert.ok(Math.abs(low.gap + 0.05) < 0.0001, String(low.gap));
  });
});
