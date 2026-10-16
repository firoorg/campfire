// One planner, two apps: the JS port of the Uniswap planner (and the split,
// pool ids, v2 formula and Permit2 digest beside it) against what the
// desktop app's Dart code produced for the same inputs. The vectors
// (fixtures/uniswap/planner_vectors.json) were written once by a small Dart
// program that ran that planner on these inputs; nothing here is hand-copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, needsPermit, PlanError } from '../../src/lib/eth/uniswap/planner.js';
import { bestSplit, splitCurve } from '../../src/lib/eth/uniswap/split.js';
import { v2AmountOut } from '../../src/lib/eth/uniswap/quoter.js';
import { UniToken, UniHop, UniRoute, UniPart, UniQuote, poolFromJson, v3Path } from '../../src/lib/eth/uniswap/models.js';
import { permitSingleDigest } from '../../src/lib/eth/tx.js';
import { decodeCall } from '../../src/lib/eth/abi.js';
import { bytesToHex } from '../../src/lib/eth/hex.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/uniswap/planner_vectors.json', import.meta.url), 'utf8'));

function token(j) {
  return new UniToken({ address: j.address, symbol: j.symbol, decimals: j.decimals });
}

function quoteOf(j) {
  const parts = j.parts.map(
    (p) =>
      new UniPart({
        route: new UniRoute(p.hops.map((h) => new UniHop(poolFromJson(h.pool), h.in, h.out))),
        amountIn: BigInt(p.amountIn),
        amountOut: BigInt(p.amountOut),
        hopOutputs: p.hopOutputs.map(BigInt),
        gas: BigInt(p.gas),
      }),
  );
  return new UniQuote({ tokenIn: token(j.tokenIn), tokenOut: token(j.tokenOut), amountIn: BigInt(j.amountIn), parts, gasEstimate: BigInt(j.gasEstimate), block: 1 });
}

function permitOf(j) {
  if (!j) return null;
  return { permit: { token: j.token, amount: BigInt(j.amount), expiration: j.expiration, nonce: j.nonce, spender: j.spender, sigDeadline: BigInt(j.sigDeadline) }, signature: j.signature };
}

test('planner vectors: there are cases for every shape the desktop test suite exercises', () => {
  const names = V.plans.map((c) => c.name);
  assert.ok(names.length >= 16, `${names.length} cases`);
  // Every command the planner can emit appears in some case.
  const seen = new Set(V.plans.flatMap((c) => (c.expect.commands ? [...c.expect.commands.slice(2).matchAll(/../g)].map((m) => m[0]) : [])));
  for (const c of ['00', '02', '04', '08', '0a', '0b', '0c', '10']) assert.ok(seen.has(c), `command 0x${c} covered`);
});

for (const c of V.plans) {
  test(`planner, same bytes as the desktop app: ${c.name}`, () => {
    const quote = quoteOf(c.quote);
    // The parts arrive in the order the Dart quote sorted them; the JS quote keeps it.
    assert.deepEqual(
      quote.parts.map((p) => String(p.amountIn)),
      c.quote.parts.map((p) => p.amountIn),
    );
    const args = { quote, slippageBips: c.slippageBips, deadline: BigInt(c.deadline), permit: permitOf(c.permit) };
    if (c.expect.error) {
      assert.throws(() => buildPlan(args), (e) => e instanceof PlanError && e.message === c.expect.error);
      return;
    }
    const plan = buildPlan(args);
    assert.equal(bytesToHex(plan.commands), c.expect.commands);
    assert.equal(String(plan.value), c.expect.value);
    assert.equal(String(plan.minimumOut), c.expect.minimumOut);
    assert.equal(plan.to, c.expect.to);
    const got = plan.calldataHex;
    if (got !== c.expect.calldata) {
      // Say which input differs before failing on the whole call.
      const [, mine] = decodeCall('execute(bytes,bytes[],uint256)', got);
      const [, theirs] = decodeCall('execute(bytes,bytes[],uint256)', c.expect.calldata);
      mine.forEach((m, i) => assert.equal(bytesToHex(m), bytesToHex(theirs[i]), `input ${i}`));
    }
    assert.equal(got, c.expect.calldata);
    assert.equal(needsPermit(quote), !quote.tokenIn.isEth);
  });
}

test('split: the same sharing as the desktop app on 40 random cases', () => {
  for (const [i, s] of V.splits.entries()) {
    const stepIn = BigInt(s.stepIn);
    const curves = s.curves.map((c) => {
      const outs = [0n];
      for (let k = 1; k <= s.steps; k++) outs.push(v2AmountOut(stepIn * BigInt(k), BigInt(c.rIn), BigInt(c.rOut)));
      return splitCurve({ pools: c.pools, outs, cost: BigInt(c.cost) });
    });
    const got = bestSplit(curves, { steps: s.steps, maxParts: s.maxParts });
    if (s.expect === null) assert.equal(got, null, `case ${i}`);
    else {
      assert.deepEqual(got.steps, s.expect.steps, `case ${i}`);
      assert.equal(String(got.net), s.expect.net, `case ${i}`);
    }
  }
});

test('v4 pool ids, v2 amounts, a v3 path and Permit2 digests match the desktop app', () => {
  for (const { pool, id } of V.poolIds) assert.equal(poolFromJson(pool).id, id);
  for (const v of V.v2AmountOut) assert.equal(String(v2AmountOut(BigInt(v.amountIn), BigInt(v.reserveIn), BigInt(v.reserveOut))), v.out);
  assert.equal(bytesToHex(v3Path(['0xe5acbb03d73267c03349c76ead672ee4d941f499', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'], [3000, 500])), V.v3Path);
  for (const p of V.permits) {
    assert.equal(bytesToHex(permitSingleDigest({ token: p.token, amount: BigInt(p.amount), expiration: p.expiration, nonce: p.nonce, spender: p.spender, sigDeadline: BigInt(p.sigDeadline) })), p.digest);
  }
});
