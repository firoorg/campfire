// D-06: a swap's minimum must not rest on one server's word. The chosen server's quote sets the
// least the router accepts; a server that quotes low makes that minimum low. Before the review the
// same swap is priced on a second listed server of the chain, and two prices more than 2% apart
// are said, with a tick to swap anyway. Fake servers only (lib/eth/pancake.js asks ethCall and
// blockNumber of one); the Uniswap route's second pricing is on the fork (test/fork/uniswap_quote).
import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteSwap, minOut, PANCAKE, DEFAULT_SLIPPAGE_BIPS } from '../../src/lib/eth/pancake.js';
import { secondOpinion, secondOpinionWords, priceAckNeeded, compareOut, otherServers, PRICE_GAP, SECOND_TRIES } from '../../src/lib/eth/second_opinion.js';
import { abiEncode, decodeCall } from '../../src/lib/eth/abi.js';
import { toBytes } from '../../src/lib/eth/hex.js';
import { BSC_RPC_HOSTS, ETH_RPC_HOSTS, ownServerEntry } from '../../src/lib/eth/hosts.js';

const BNB = 10n ** 18n;
/** What the rsFIRO/WBNB pool honestly gives for 0.1 BNB at this made-up price (8 decimals). */
const HONEST_OUT = 6985700000n;
// slot0: sqrtPriceX96 for about 0.00142 WBNB per rsFIRO in raw units (WBNB 18, rsFIRO 8 decimals).
const SQRT_PRICE = BigInt(Math.floor(Math.sqrt(0.00142 * 1e10) * 2 ** 96));

/** A BNB Chain server whose QuoterV2 answers `factor` x the honest price (1 = honest). Counts what it is asked. */
function server(factor = 1, { down = false } = {}) {
  const s = {
    asked: 0,
    ethCall: async ({ to, data }) => {
      s.asked++;
      if (down) throw Object.assign(new Error('could not be reached'), { code: 'network' });
      if (to === PANCAKE.quoterV2) {
        const [[, , amountIn]] = decodeCall('quoteExactInputSingle((address,address,uint256,uint24,uint160))', data);
        const out = (HONEST_OUT * amountIn * BigInt(Math.round(factor * 1000))) / (BNB / 10n) / 1000n;
        return toBytes(abiEncode('uint256,uint160,uint32,uint256', [out, 0n, 0n, 120000n]));
      }
      if (to === PANCAKE.pool) return toBytes(abiEncode('uint160,int24,uint16,uint16,uint16,uint32,bool', [SQRT_PRICE, 0n, 0n, 0n, 0n, 0n, true]));
      throw new Error(`unexpected call to ${to}`);
    },
    blockNumber: async () => 60000000,
  };
  return s;
}

const buy = (rpc) => quoteSwap(rpc, { side: 'buy', amountIn: BNB / 10n });

test('D-06 reproduced: the router minimum is whatever the chosen server quotes, less 1%', async () => {
  const honest = await buy(server(1));
  const lying = await buy(server(0.8));
  assert.equal(honest.amountOut, HONEST_OUT);
  assert.equal(minOut(lying.amountOut, DEFAULT_SLIPPAGE_BIPS), (HONEST_OUT * 8n / 10n) * 99n / 100n, 'a 20% low quote is a 20.8% low minimum');
});

test('a second listed server prices the same swap: agree within 2%, differ beyond, said both ways', async () => {
  const servers = new Map(BSC_RPC_HOSTS.map((h) => [h.id, server(1)]));
  const chosen = 'bsc-nodereal';
  const lying = await buy(server(0.8));
  const check = await secondOpinion({ chainKey: 'bsc', chosenId: chosen, mine: lying.amountOut, quoteOn: (rpc) => buy(rpc).then((q) => q.amountOut), makeRpc: (h) => servers.get(h.id) });
  assert.equal(check.status, 'differ');
  assert.equal(check.host.id, 'bsc-bnbchain', 'the first other server of the list');
  assert.equal(check.theirs, HONEST_OUT);
  assert.equal(check.gap, -0.2, "the chosen server's price is 20% under the other's");
  assert.equal(servers.get(chosen).asked, 0, 'the chosen server is never its own second opinion');
  const words = secondOpinionWords(check, { server: 'NodeReal', amount: (v) => `${Number(v) / 1e8} rsFIRO` });
  assert.equal(words.kind, 'warn');
  assert.match(words.text, /^Your server \(NodeReal\) prices this swap 20% lower than BNB Chain \(official\) does: 55\.8856 rsFIRO against 69\.857 rsFIRO\./);
  assert.equal(words.ack, "Swap anyway at NodeReal's price");
  // Too high is said too (the swap would be refused, only the fee spent).
  const high = await secondOpinion({ chainKey: 'bsc', chosenId: chosen, mine: (HONEST_OUT * 105n) / 100n, quoteOn: (rpc) => buy(rpc).then((q) => q.amountOut), makeRpc: (h) => servers.get(h.id) });
  assert.equal(high.status, 'differ');
  assert.match(secondOpinionWords(high, { server: 'NodeReal', amount: String }).text, /5% higher than/);
  // Honest, or a block apart (under 2%): one quiet line.
  const fair = await secondOpinion({ chainKey: 'bsc', chosenId: chosen, mine: (await buy(server(0.99))).amountOut, quoteOn: (rpc) => buy(rpc).then((q) => q.amountOut), makeRpc: (h) => servers.get(h.id) });
  assert.equal(fair.status, 'agree');
  assert.deepEqual(secondOpinionWords(fair, { server: 'NodeReal', amount: String }), { kind: 'ok', text: 'Price checked with a second server (BNB Chain (official)).', ack: null });
});

test('a second server that does not answer: the next one; none at all is "unchecked", and said', async () => {
  const down = server(1, { down: true });
  const up = server(1);
  const byId = { 'bsc-bnbchain': down, 'bsc-nodereal': up };
  const one = await secondOpinion({ chainKey: 'bsc', chosenId: 'bsc-ninicoin', mine: HONEST_OUT, quoteOn: (rpc) => buy(rpc).then((q) => q.amountOut), makeRpc: (h) => byId[h.id] });
  assert.equal(one.status, 'agree');
  assert.equal(one.host.id, 'bsc-nodereal');
  const none = await secondOpinion({ chainKey: 'ethereum', chosenId: 'stackwallet', mine: 5n, quoteOn: async () => { throw new Error('refused'); }, makeRpc: () => ({}) });
  assert.equal(none.status, 'unchecked');
  assert.equal(none.host, null);
  const words = secondOpinionWords(none, { server: 'Stack Wallet', amount: String });
  // The minimum then rests on one server's price: a tick first, as when two disagree (P13).
  assert.equal(words.kind, 'warn');
  assert.match(words.text, /^Only your server \(Stack Wallet\) priced this swap: no second server answered/);
  assert.equal(words.ack, "Swap at Stack Wallet's price alone");
  assert.equal(priceAckNeeded(none), true);
  assert.equal(priceAckNeeded(null), true);
  // A server that never answers is given up on after the time allowed, and the next one asked.
  const hung = await secondOpinion({ chainKey: 'bsc', chosenId: 'bsc-ninicoin', mine: HONEST_OUT, timeoutMs: 50, quoteOn: (rpc) => (rpc === down ? new Promise(() => {}) : buy(rpc).then((q) => q.amountOut)), makeRpc: (h) => byId[h.id] });
  assert.equal(hung.status, 'agree');
  assert.equal(hung.host.id, 'bsc-nodereal');
  // At most SECOND_TRIES servers are asked, never the chosen one.
  const asked = [];
  await secondOpinion({ chainKey: 'ethereum', chosenId: 'publicnode', mine: 5n, quoteOn: async (rpc) => { asked.push(rpc.id); throw new Error('no'); }, makeRpc: (h) => ({ id: h.id }) });
  assert.deepEqual(asked, otherServers('ethereum', 'publicnode').slice(0, SECOND_TRIES).map((h) => h.id));
  assert.equal(asked.length, 2);
  assert.ok(!asked.includes('publicnode'));
  assert.deepEqual(otherServers('ethereum', 'stackwallet').map((h) => h.id), ETH_RPC_HOSTS.slice(1).map((h) => h.id));
});

test("with the person's own server in use, the second opinion is a listed server (the first SECOND_TRIES of the list), never their own", async () => {
  const mine = ownServerEntry('bsc', 'https://my-node.example.com:8545/rpc');
  assert.ok(mine && mine.custom && mine.id === 'custom');
  assert.deepEqual(otherServers('bsc', mine.id).map((h) => h.id), BSC_RPC_HOSTS.map((h) => h.id), 'every listed server is a candidate');
  const asked = [];
  const check = await secondOpinion({ chainKey: 'bsc', chosenId: mine.id, mine: HONEST_OUT, quoteOn: (rpc) => { asked.push(rpc.id); return Promise.resolve(HONEST_OUT); }, makeRpc: (h) => ({ id: h.id }) });
  assert.equal(check.status, 'agree');
  assert.equal(check.host.id, BSC_RPC_HOSTS[0].id);
  assert.ok(!check.host.custom);
  assert.deepEqual(asked, [BSC_RPC_HOSTS[0].id], 'one server, when it answers');
  // The longer lists: still at most SECOND_TRIES (2) servers asked, in list order.
  const tried = [];
  const none = await secondOpinion({ chainKey: 'bsc', chosenId: mine.id, mine: HONEST_OUT, quoteOn: async (rpc) => { tried.push(rpc.id); throw new Error('no'); }, makeRpc: (h) => ({ id: h.id }) });
  assert.equal(none.status, 'unchecked');
  assert.equal(SECOND_TRIES, 2);
  assert.deepEqual(tried, BSC_RPC_HOSTS.slice(0, 2).map((h) => h.id));
  assert.ok(BSC_RPC_HOSTS.length >= 8 && ETH_RPC_HOSTS.length >= 7);
});

test('the comparison is exact in integers and symmetric about the 2% line', () => {
  assert.equal(PRICE_GAP, 0.02);
  assert.deepEqual(compareOut(1000n, 1000n), { gap: 0, agree: true });
  assert.deepEqual(compareOut(1020n, 1000n), { gap: 0.02, agree: true });
  assert.deepEqual(compareOut(1021n, 1000n), { gap: 0.021, agree: false });
  assert.deepEqual(compareOut(980n, 1000n), { gap: -0.02, agree: true });
  assert.deepEqual(compareOut(979n, 1000n), { gap: -0.021, agree: false });
  assert.deepEqual(compareOut(0n, 5n), { gap: null, agree: false });
  // Amounts far past 2^53 (18-decimal tokens) are compared exactly.
  assert.equal(compareOut(10n ** 30n + 10n ** 28n, 10n ** 30n).gap, 0.01);
});
