// The swap service offline, against the pretend chain: exact approvals
// (USDT reset to zero first), the review refusing a price that moved past the
// protection, the price protection choices and the price-impact thresholds,
// the Permit2 permit signed through the caller and checked, the unsigned
// transactions with their gas headroom, deadline and permit life, and what a
// receipt says arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeChain, revert } from './helpers/fake_uniswap.mjs';
import { UniswapService, UniPriceMoved, UniGasChanged, UniRouteChanged, UniSwapRefused, SLIPPAGE_CHOICES, DEFAULT_SLIPPAGE, IMPACT_WARNING, IMPACT_BLOCK, DEADLINE_SECONDS, PERMIT_LIFE_SECONDS, PERMIT_GAS, impactLevel, receivedFromLogs, gasWithHeadroom } from '../../src/lib/eth/uniswap/service.js';
import { UniV2Pool, UniV4Pool, UniToken, ETH_TOKEN, topicOfAddress } from '../../src/lib/eth/uniswap/models.js';
import { ADDRESSES, NATIVE_ETH, WETH, TOPICS, UR_COMMAND } from '../../src/lib/eth/uniswap/constants.js';
import { PermitError } from '../../src/lib/eth/uniswap/permit2.js';
import { signPermitSingle, normalizeTx, signTransaction, parseSignedTransaction } from '../../src/lib/eth/tx.js';
import { privateKeyToAddress } from '../../src/lib/eth/crypto.js';
import { decodeCall, abiDecode, abiEncode, encodeCall } from '../../src/lib/eth/abi.js';
import { hexToBytes, bytesToHex } from '../../src/lib/eth/hex.js';

// An 8-decimal token whose every pool is in the shared list (as rsFIRO's are in the app's).
const TKN = '0xe5acbb03d73267c03349c76ead672ee4d941f499';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const HOOK = '0x0e6690b6bbcc55a8b7c7da2f0ee43e2e2bf840c0';
const tkn = new UniToken({ address: TKN, symbol: 'TKN', decimals: 8 });
const usdt = new UniToken({ address: USDT, symbol: 'USDT', decimals: 6 });
const ETH = 10n ** 18n;
const WB = 10n ** 8n;
// Anvil's well-known key 0 (public by design).
const KEY = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const OWNER = privateKeyToAddress(KEY).toLowerCase();
const NOW_MS = 1791555000000;
const NOW = NOW_MS / 1000;

function setup({ hooked = false } = {}) {
  const chain = new FakeChain({ head: 26000100 });
  const v4 = chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 3000, ts: 60, r0: 100n * ETH, r1: 32000000n * WB });
  const v2 = chain.addV2({ pair: '0xc821395f890913b9ce7415b36db10ddc5281c53a', c0: WETH, c1: TKN, r0: 30n * ETH, r1: 9000000n * WB });
  const usdtPool = chain.addV4({ c0: USDT, c1: TKN, fee: 3000, ts: 60, r0: 1000000n * 10n ** 6n, r1: 100000000n * WB });
  const hook = hooked ? chain.addV4({ c0: NATIVE_ETH, c1: TKN, fee: 500, ts: 10, hooks: HOOK, r0: 100n * ETH, r1: 32000000n * WB }) : null;
  chain.token(TKN, { symbol: 'TKN', decimals: 8 });
  chain.token(USDT, { symbol: 'USDT', decimals: 6, usdtStyle: true });
  chain.ethBalances.set(OWNER, 10n * ETH);
  const known = { block: 26000000, pools: [v4.pool, new UniV2Pool({ pair: v2.pair, currency0: WETH, currency1: TKN }), usdtPool.pool, ...(hook ? [hook.pool] : [])] };
  const svc = new UniswapService({ rpc: chain.rpc, known, fullyListed: [TKN], now: () => NOW_MS, sleep: async () => {} });
  return { chain, svc, v4, v2, hook };
}

const signPermit = async (p) => signPermitSingle(p, KEY);

test('the desktop app\'s choices: price protection 0.5/1/3/5 %, 1 % by default; impact warns from 3 %, needs a tick from 10 %', () => {
  assert.deepEqual([...SLIPPAGE_CHOICES], [50, 100, 300, 500]);
  assert.equal(DEFAULT_SLIPPAGE, 100);
  assert.equal(IMPACT_WARNING, 0.03);
  assert.equal(IMPACT_BLOCK, 0.1);
  assert.equal(impactLevel(null), 'none');
  assert.equal(impactLevel(0.0299), 'none');
  assert.equal(impactLevel(0.03), 'warn');
  assert.equal(impactLevel(0.0999), 'warn');
  assert.equal(impactLevel(0.1), 'block');
  assert.equal(DEADLINE_SECONDS, 1200);
  assert.equal(PERMIT_LIFE_SECONDS, 1800);
  assert.equal(PERMIT_GAS, 80000n);
});

test('gas headroom: a quarter more, and at least 20,000 more', () => {
  assert.equal(gasWithHeadroom(21000n), 41000n);
  assert.equal(gasWithHeadroom(80000n), 100000n);
  assert.equal(gasWithHeadroom(80001n), 100001n);
  assert.equal(gasWithHeadroom(200000n), 250000n);
});

test('ETH → TKN: no approval, a review with the gas measured, an unsigned transaction carrying the ETH', async () => {
  const { chain, svc } = setup();
  const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 100n, owner: OWNER });
  assert.equal((await svc.approvalFor(q, OWNER)).kind, 'none');
  assert.deepEqual(await svc.approvalTxs(await svc.approvalFor(q, OWNER), OWNER), []);
  chain.gasOf = () => 180000n;
  const review = await svc.reviewSwap({ quote: q, slippageBips: 100, owner: OWNER });
  assert.equal(review.needsPermit, false);
  assert.equal(review.gasLimit, 225000n);
  assert.equal(review.deadline, BigInt(NOW + 1200));
  assert.equal(review.minimumOut, (review.quote.amountOut * 99n) / 100n);
  assert.equal(review.impact, 'none');
  assert.equal(review.fees.baseFee, chain.baseFee);
  assert.equal(review.fees.maxFeePerGas, 2n * chain.baseFee + chain.tip);
  assert.equal(review.maxGasCost, 225000n * review.fees.maxFeePerGas);

  let routed = null;
  chain.router = (call) => (routed = call);
  const done = await svc.finalizeSwap({ review });
  assert.equal(done.permitSigned, false);
  const tx = done.tx;
  assert.equal(tx.kind, 'swap');
  assert.equal(tx.to, ADDRESSES.universalRouter);
  assert.equal(tx.value, ETH / 100n);
  assert.equal(tx.gasLimit, review.gasLimit);
  assert.equal(tx.chainId, 1n);
  assert.equal(routed.from, OWNER, 'simulated from the wallet');
  const [commands, , deadline] = decodeCall('execute(bytes,bytes[],uint256)', tx.data);
  assert.equal(deadline, BigInt(NOW + 1200));
  assert.ok(commands.includes(UR_COMMAND.v4Swap));
  // The caller signs it with withEthKey: tx.js takes it as it is, plus the nonce.
  const signed = signTransaction({ ...tx, nonce: 7n }, KEY);
  const parsed = parseSignedTransaction(signed.raw);
  assert.equal(parsed.from.toLowerCase(), OWNER);
  assert.equal(parsed.tx.data, tx.data);
  assert.equal(parsed.tx.value, tx.value);
  assert.equal(normalizeTx({ ...tx, nonce: 0n }).maxFeePerGas, review.fees.maxFeePerGas);
});

test('TKN → ETH: exactly the amount approved to Permit2, then one permit signed for 30 minutes', async () => {
  const { chain, svc } = setup();
  const q = await svc.quote({ tokenIn: tkn, tokenOut: ETH_TOKEN, amountIn: 50000n * WB });
  const approval = await svc.approvalFor(q, OWNER);
  assert.equal(approval.kind, 'approve');
  const [approve] = await svc.approvalTxs(approval, OWNER);
  assert.equal(approve.kind, 'approve');
  assert.equal(approve.to, TKN);
  assert.equal(decodeCall('approve(address,uint256)', approve.data)[0].toLowerCase(), ADDRESSES.permit2);
  assert.equal(decodeCall('approve(address,uint256)', approve.data)[1], q.amountIn, 'exactly the amount, never unlimited');
  assert.equal(approve.value, 0n);

  // Once the approval is mined, Permit2 holds nothing for the router yet: a permit is needed.
  chain.tokens.get(TKN).allowances.set(`${OWNER}|${ADDRESSES.permit2}`, q.amountIn);
  chain.permits.set(`${OWNER}|${TKN}|${ADDRESSES.universalRouter}`, { amount: 0n, expiration: 0, nonce: 5 });
  assert.equal((await svc.approvalFor(q, OWNER)).kind, 'none');
  const review = await svc.reviewSwap({ quote: q, owner: OWNER });
  assert.equal(review.slippageBips, 100, 'the default protection');
  assert.equal(review.needsPermit, true);
  assert.equal(review.gasLimit, gasWithHeadroom(review.quote.gasEstimate + PERMIT_GAS));
  let asked = null;
  const done = await svc.finalizeSwap({ review, signPermit: async (p) => ((asked = p), signPermit(p)) });
  assert.equal(done.permitSigned, true);
  assert.equal(asked.token, TKN);
  assert.equal(asked.amount, q.amountIn);
  assert.equal(asked.nonce, 5, "Permit2's current nonce");
  assert.equal(asked.spender, ADDRESSES.universalRouter);
  assert.equal(asked.expiration, NOW + 1800);
  assert.equal(asked.sigDeadline, BigInt(NOW + 1800));
  const [commands, inputs] = decodeCall('execute(bytes,bytes[],uint256)', done.tx.data);
  assert.equal(commands[0], UR_COMMAND.permit2Permit);
  const [permit, sig] = abiDecode('((address,uint160,uint48,uint48),address,uint256),bytes', inputs[0]);
  assert.equal(permit[0][1], q.amountIn);
  assert.equal(sig[64] === 27 || sig[64] === 28, true, 'r ‖ s ‖ v');
  assert.equal(done.tx.value, 0n);

  // A signature from another key never reaches a transaction.
  const other = hexToBytes('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  await assert.rejects(svc.finalizeSwap({ review, signPermit: async (p) => signPermitSingle(p, other) }), PermitError);
  await assert.rejects(svc.finalizeSwap({ review }), (e) => e instanceof UniSwapRefused && e.code === 'permit');
});

test('a Permit2 allowance that still covers the swap needs no new permit', async () => {
  const { chain, svc } = setup();
  const q = await svc.quote({ tokenIn: tkn, tokenOut: ETH_TOKEN, amountIn: 1000n * WB });
  chain.permits.set(`${OWNER}|${TKN}|${ADDRESSES.universalRouter}`, { amount: q.amountIn, expiration: NOW + 900, nonce: 6 });
  const review = await svc.reviewSwap({ quote: q, owner: OWNER, slippageBips: 50 });
  assert.equal(review.needsPermit, false);
  const done = await svc.finalizeSwap({ review });
  assert.equal(done.permitSigned, false);
  assert.notEqual(decodeCall('execute(bytes,bytes[],uint256)', done.tx.data)[0][0], UR_COMMAND.permit2Permit);
  // About to run out: a new permit.
  chain.permits.set(`${OWNER}|${TKN}|${ADDRESSES.universalRouter}`, { amount: q.amountIn, expiration: NOW + 60, nonce: 6 });
  assert.equal((await svc.reviewSwap({ quote: q, owner: OWNER })).needsPermit, true);
});

test('S2: Permit2\'s figures come from a block no older than this wallet\'s last swap of that token; a server behind it is refused, nothing built', async () => {
  const { chain, svc } = setup();
  const q = await svc.quote({ tokenIn: tkn, tokenOut: ETH_TOKEN, amountIn: 1000n * WB });
  chain.permits.set(`${OWNER}|${TKN}|${ADDRESSES.universalRouter}`, { amount: q.amountIn, expiration: NOW + 900, nonce: 6 });
  // The floor at the server's newest block: read there.
  assert.equal((await svc.reviewSwap({ quote: q, owner: OWNER, slippageBips: 50, permitMinBlock: chain.head })).needsPermit, false);
  // The server behind the floor (a backend that has not seen the last swap yet): refused, never an older figure.
  await assert.rejects(
    svc.reviewSwap({ quote: q, owner: OWNER, slippageBips: 50, permitMinBlock: chain.head + 3 }),
    (e) => e.code === 'behind',
  );
});

test('USDT: a non-zero allowance is reset to zero first, then set to exactly the amount', async () => {
  const { chain, svc } = setup();
  chain.tokens.get(USDT).allowances.set(`${OWNER}|${ADDRESSES.permit2}`, 1n);
  const q = await svc.quote({ tokenIn: usdt, tokenOut: tkn, amountIn: 100n * 10n ** 6n });
  const approval = await svc.approvalFor(q, OWNER);
  assert.equal(approval.kind, 'resetThenApprove');
  assert.equal(approval.current, 1n);
  const txs = await svc.approvalTxs(approval, OWNER);
  assert.deepEqual(
    txs.map((t) => t.kind),
    ['approveReset', 'approve'],
  );
  assert.equal(decodeCall('approve(address,uint256)', txs[0].data)[1], 0n);
  assert.equal(decodeCall('approve(address,uint256)', txs[1].data)[1], q.amountIn);
  // The second cannot be measured before the reset is mined: a fixed limit, with headroom.
  assert.equal(txs[1].gasLimit, gasWithHeadroom(70000n));
  // A token that takes a change from non-zero needs one transaction.
  chain.tokens.get(TKN).allowances.set(`${OWNER}|${ADDRESSES.permit2}`, 1n);
  const sell = await svc.quote({ tokenIn: tkn, tokenOut: ETH_TOKEN, amountIn: 10n * WB });
  assert.equal((await svc.approvalFor(sell, OWNER)).kind, 'approve');
});

test('the review refuses a price that moved more than the protection, and gives the new price', async () => {
  const { chain, svc, v4 } = setup();
  const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 10n });
  // Someone buys a lot first, in the same pool.
  chain.trade(v4, NATIVE_ETH, ETH);
  await assert.rejects(svc.reviewSwap({ quote: q, owner: OWNER, slippageBips: 50 }), (e) => {
    assert.ok(e instanceof UniPriceMoved);
    assert.ok(e.moved > 0.005);
    assert.ok(e.fresh.amountOut < q.amountOut);
    return true;
  });
  // With 5 % protection the same move is accepted, and the minimum follows the new price.
  const r = await svc.reviewSwap({ quote: q, owner: OWNER, slippageBips: 500 });
  assert.ok(r.priceMoved > 0.005 && r.priceMoved < 0.05);
  assert.equal(r.minimumOut, (r.quote.amountOut * 95n) / 100n);
  // Anything but the four choices is refused.
  for (const bips of [0, 25, 1000, 5000, 100.5]) await assert.rejects(svc.reviewSwap({ quote: q, owner: OWNER, slippageBips: bips }), (e) => e.code === 'slippage');
});

test('a price impact of 10 % or more is only built when the person accepted it', async () => {
  const { svc } = setup();
  const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: 40n * ETH });
  assert.ok(q.priceImpact >= 0.1, String(q.priceImpact));
  const review = await svc.reviewSwap({ quote: q, owner: OWNER, slippageBips: 500 });
  assert.equal(review.impact, 'block');
  await assert.rejects(svc.finalizeSwap({ review }), (e) => e instanceof UniSwapRefused && e.code === 'impact');
  const done = await svc.finalizeSwap({ review, acceptImpact: true });
  assert.equal(done.tx.value, 40n * ETH);
});

test('more gas than the review showed: the new limit comes back instead of a transaction', async () => {
  const { chain, svc } = setup();
  const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 100n });
  chain.gasOf = () => 150000n;
  const review = await svc.reviewSwap({ quote: q, owner: OWNER });
  chain.gasOf = () => review.gasLimit + 1n;
  await assert.rejects(svc.finalizeSwap({ review }), (e) => e instanceof UniGasChanged && e.gasLimit === gasWithHeadroom(review.gasLimit + 1n));
});

test('a hooked pool whose real swap reverts is dropped and the route changes', async () => {
  const { chain, svc, hook } = setup({ hooked: true });
  // The hooked pool charges less, so it is the best route; its swap reverts.
  const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 10n });
  assert.ok(q.pools.some((p) => p.id === hook.pool.id));
  const hookedRoute = (call) => {
    const [, inputs] = decodeCall('execute(bytes,bytes[],uint256)', call.data);
    if (inputs.some((i) => bytesToHex(i).includes(HOOK.slice(2)))) throw revert();
  };
  chain.router = hookedRoute;
  await assert.rejects(svc.reviewSwap({ quote: q, owner: OWNER }), (e) => {
    assert.ok(e instanceof UniRouteChanged);
    assert.ok(!e.quote.pools.some((p) => p.id === hook.pool.id));
    return true;
  });
  assert.ok(svc.quoter.distrusted.has(hook.pool.id));
  // With the owner given, the quote simulates the hooked route itself and avoids it.
  const { chain: c2, svc: s2, hook: h2 } = setup({ hooked: true });
  c2.router = hookedRoute;
  const q2 = await s2.quote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 10n, owner: OWNER });
  assert.ok(!q2.pools.some((p) => p.id === h2.pool.id));
  // A plain route that reverts is the server's answer, not a route change.
  const { chain: c3, svc: s3 } = setup();
  const q3 = await s3.quote({ tokenIn: ETH_TOKEN, tokenOut: tkn, amountIn: ETH / 10n });
  c3.router = () => {
    throw revert();
  };
  await assert.rejects(s3.reviewSwap({ quote: q3, owner: OWNER }), (e) => e.code === 3);
  assert.equal(await s3.simulateTx({ to: ADDRESSES.universalRouter, data: encodeCall('execute(bytes,bytes[],uint256)', [new Uint8Array(0), [], 1n]), value: 0n }, OWNER), false);
});

test('a receipt: tokens that arrived from their Transfer logs to the owner; ETH from the balance change', async () => {
  const { chain, svc } = setup();
  const me = topicOfAddress(OWNER);
  const someone = topicOfAddress('0x00000000000000000000000000000000000000aa');
  const log = (address, to, amount, extra = {}) => ({ address, topics: [TOPICS.erc20Transfer, topicOfAddress(ADDRESSES.universalRouter), to], data: abiEncode('uint256', [amount]), removed: false, ...extra });
  const receipt = {
    transactionHash: '0x' + 'ab'.repeat(32),
    status: 1,
    blockNumber: 500,
    gasUsed: 150000n,
    effectiveGasPrice: 3n * 10n ** 9n,
    logs: [log(TKN, me, 100n), log(TKN, me, 23n), log(TKN, someone, 999n), log(USDT, me, 5n), log(TKN, me, 1000n, { removed: true })],
  };
  assert.equal(receivedFromLogs(receipt, OWNER, TKN), 123n);
  const out = await svc.readReceipt(receipt, { owner: OWNER, tokenOut: tkn });
  assert.equal(out.success, true);
  assert.equal(out.received, 123n);
  assert.equal(out.gasCost, 150000n * 3n * 10n ** 9n);
  // ETH: after − before + the gas it paid.
  chain.ethBalances.set(OWNER, (block) => (block === 499 ? 5n * ETH : 6n * ETH - out.gasCost));
  assert.equal((await svc.readReceipt(receipt, { owner: OWNER, tokenOut: ETH_TOKEN })).received, ETH);
  // A failed swap received nothing.
  assert.equal((await svc.readReceipt({ ...receipt, status: 0 }, { owner: OWNER, tokenOut: tkn })).received, null);

  // Waiting: asked until mined, or null when it is not mined in time.
  let polls = 0;
  chain.receipts.set(receipt.transactionHash, () => (++polls < 3 ? null : receipt));
  const waited = await svc.waitForReceipt(receipt.transactionHash, { owner: OWNER, tokenOut: tkn });
  assert.equal(waited.received, 123n);
  assert.equal(polls, 3);
  let t = 0;
  const slow = new UniswapService({ rpc: chain.rpc, discovery: svc.discovery, now: () => t, sleep: async (ms) => (t += ms) });
  assert.equal(await slow.waitForReceipt('0x' + 'cd'.repeat(32), { every: 4000, limit: 10 * 60 * 1000 }), null);
  assert.equal(t, 10 * 60 * 1000);
});

test('token facts in one request, including a bytes32 symbol; partners of TKN', async () => {
  const { chain, svc } = setup();
  chain.token('0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', { symbol: 'MKR', decimals: 18, bytes32Symbol: true });
  chain.token('0x00000000000000000000000000000000000000bb', { symbol: 'BIG', decimals: 77 });
  const info = await svc.tokenInfo(['0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', TKN, '0x00000000000000000000000000000000000000bb', '0x00000000000000000000000000000000000000cc']);
  assert.deepEqual(
    info.map((t) => [t.symbol, t.decimals]),
    [
      ['MKR', 18],
      ['TKN', 8],
    ],
  );
  const partners = await svc.partnersOf(tkn);
  assert.deepEqual(new Set(partners), new Set([NATIVE_ETH, USDT]), 'WETH counts as ETH');
  await svc.discovery.idle();
});
