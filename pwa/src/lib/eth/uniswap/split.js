// How to share one swap between several routes. A port of the desktop app's
// lib/wallets/ethereum/uniswap/uniswap_split.dart.
//
// The amount is cut into equal steps (twentieths). Each route has been
// priced at every number of steps; giving a route k steps yields its price at
// k steps, less what using the route at all costs in gas. The best sharing is
// found exactly by dynamic programming over the routes (a knapsack: 20 steps,
// at most maxParts routes), which is cheap.
//
// Two routes that go through the same pool were priced as if each had the
// pool to itself, so they are never used together: when the best sharing
// uses both, it is worked out again without one, then without the other, and
// the better of the two is kept. Many routes can share one pool (every way on
// from the same first pool), so that search is capped; past the cap, the
// route with the smaller share is dropped until no two share a pool. A
// sharing that uses one pool twice is never returned.

/**
 * One route's prices.
 * pools: Set of the ids of the pools it goes through;
 * outs[k]: what k steps of the amount give (outs[0] is 0n; null where the route would not quote);
 * cost: using the route at all, in the token received (its gas), bigint.
 */
export function splitCurve({ pools, outs, cost }) {
  return { pools: pools instanceof Set ? pools : new Set(pools), outs, cost };
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * The best way to give all `steps` steps to `curves`, using at most maxParts
 * of them and never two that share a pool → {steps: [per curve], net, parts},
 * or null when no sharing is possible.
 */
export function bestSplit(curves, { steps, maxParts = 6 }) {
  const clash = (split) => {
    const used = [];
    for (let i = 0; i < curves.length; i++) if (split.steps[i] > 0) used.push(i);
    for (let a = 0; a < used.length; a++) {
      for (let b = a + 1; b < used.length; b++) {
        if (intersects(curves[used[a]].pools, curves[used[b]].pools)) return [used[a], used[b]];
      }
    }
    return null;
  };

  // Past the cap: drop the smaller of each clashing pair until none clash.
  const repair = (excluded) => {
    const out = new Set(excluded);
    for (;;) {
      const split = knapsack(curves, out, steps, maxParts);
      if (split === null) return null;
      const c = clash(split);
      if (c === null) return split;
      out.add(split.steps[c[0]] < split.steps[c[1]] ? c[0] : c[1]);
    }
  };

  const memo = new Map();
  let evaluations = 0;
  const solve = (excluded) => {
    const key = [...excluded].sort((a, b) => a - b).join(',');
    if (memo.has(key)) return memo.get(key);
    if (++evaluations > 64) {
      const r = repair(excluded);
      memo.set(key, r);
      return r;
    }
    const split = knapsack(curves, excluded, steps, maxParts);
    const c = split === null ? null : clash(split);
    if (c === null) {
      memo.set(key, split);
      return split;
    }
    const withoutI = solve(new Set([...excluded, c[0]]));
    const withoutJ = solve(new Set([...excluded, c[1]]));
    let best;
    if (withoutI === null) best = withoutJ;
    else if (withoutJ === null) best = withoutI;
    else best = withoutI.net >= withoutJ.net ? withoutI : withoutJ;
    memo.set(key, best);
    return best;
  };

  return solve(new Set());
}

function knapsack(curves, excluded, steps, maxParts) {
  // best[k][p]: the most k steps give over the routes so far, using p of them; null when impossible.
  let best = Array.from({ length: steps + 1 }, () => new Array(maxParts + 1).fill(null));
  best[0][0] = 0n;
  // took[i][k][p]: the steps route i took in best[k][p] after route i.
  const took = [];

  for (let i = 0; i < curves.length; i++) {
    const c = curves[i];
    const next = best.map((row) => [...row]);
    const choice = Array.from({ length: steps + 1 }, () => new Array(maxParts + 1).fill(0));
    if (!excluded.has(i)) {
      for (let k = 1; k <= steps; k++) {
        for (let p = 1; p <= maxParts; p++) {
          for (let j = 1; j <= k && j < c.outs.length; j++) {
            const out = c.outs[j];
            const before = best[k - j][p - 1];
            if (out === null || out === undefined || before === null || out <= 0n) continue;
            const v = before + out - c.cost;
            const cur = next[k][p];
            if (cur === null || v > cur) {
              next[k][p] = v;
              choice[k][p] = j;
            }
          }
        }
      }
    }
    took.push(choice);
    best = next;
  }

  let bestP = -1;
  let bestV = null;
  for (let p = 1; p <= maxParts; p++) {
    const v = best[steps][p];
    if (v !== null && (bestV === null || v > bestV)) {
      bestV = v;
      bestP = p;
    }
  }
  if (bestV === null) return null;

  const out = new Array(curves.length).fill(0);
  let k = steps;
  let p = bestP;
  for (let i = curves.length - 1; i >= 0; i--) {
    const j = took[i][k][p];
    if (j > 0) {
      out[i] = j;
      k -= j;
      p -= 1;
    }
  }
  return { steps: out, net: bestV, parts: out.filter((s) => s > 0).length };
}
