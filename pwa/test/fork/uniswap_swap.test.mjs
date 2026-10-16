// Uniswap swaps for real on a local anvil mainnet fork (127.0.0.1:8545 only,
// under the fork lock, put back with evm_revert after each test): the
// library quotes, reviews and builds; the test signs with tx.js, as the app
// does inside withEthKey, and sends to the fork. Every swap checks what
// arrived, read from the receipt, against the quote and the minimum the
// router enforced.
//
//   node --test --test-concurrency=1 test/fork/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { anvilProblem, withFork, forkRpc, service, fundedKey, sendAndWait, ANVIL_KEY_0, ETH } from './uniswap_support.mjs';
import { ADDRESSES, UR_COMMAND, V4_ACTION } from '../../src/lib/eth/uniswap/constants.js';
import { ETH_TOKEN, UniToken } from '../../src/lib/eth/uniswap/models.js';
import { UniPriceMoved } from '../../src/lib/eth/uniswap/service.js';
import { tokenAllowance, permitAllowance } from '../../src/lib/eth/uniswap/permit2.js';
import { decodeCall, abiDecode } from '../../src/lib/eth/abi.js';
import { signPermitSingle } from '../../src/lib/eth/tx.js';
import { RSFIRO as RSFIRO_ENTRY, TOKENS } from '../../src/lib/eth/tokens.js';

const skip = await anvilProblem();
const rsfiro = new UniToken(RSFIRO_ENTRY);
// rsFIRO trades through one pool (it holds all the liquidity), so a split route is shown with
// USDC, which the wallet also offers and whose 2 ETH trade splits on the pinned fork.
const usdc = new UniToken(TOKENS.find((t) => t.symbol === 'USDC'));
const T = { skip: skip || false, timeout: 15 * 60 * 1000 };
const V4_SWAP_PARAMS = '((address,address,uint24,int24,address),bool,uint128,uint128,bytes)';

/**
 * The minimums the router will enforce, read back from the calldata: each
 * share's last pool (v2/v3 amountOutMinimum, v4 TAKE_ALL), and the payouts
 * at the end (UNWRAP_WETH / SWEEP).
 */
function minimaOf(data) {
  const [commands, inputs] = decodeCall('execute(bytes,bytes[],uint256)', data);
  const out = [];
  [...commands].forEach((c, i) => {
    if (c === UR_COMMAND.v2SwapExactIn) {
      const [to, , min] = abiDecode('address,uint256,uint256,address[],bool', inputs[i]);
      if (to.toLowerCase() === '0x0000000000000000000000000000000000000001') out.push(min);
    } else if (c === UR_COMMAND.v3SwapExactIn) {
      const [to, , min] = abiDecode('address,uint256,uint256,bytes,bool', inputs[i]);
      if (to.toLowerCase() === '0x0000000000000000000000000000000000000001') out.push(min);
    } else if (c === UR_COMMAND.v4Swap) {
      const [actions, params] = abiDecode('bytes,bytes[]', inputs[i]);
      [...actions].forEach((a, j) => {
        if (a === V4_ACTION.takeAll) out.push(abiDecode('address,uint256', params[j])[1]);
        if (a === V4_ACTION.swapExactInSingle) abiDecode(V4_SWAP_PARAMS, params[j]);
      });
    } else if (c === UR_COMMAND.unwrapWeth) {
      const [to, min] = abiDecode('address,uint256', inputs[i]);
      if (to.toLowerCase() === '0x0000000000000000000000000000000000000001') out.push(min);
    } else if (c === UR_COMMAND.sweep) out.push(abiDecode('address,address,uint256', inputs[i])[2]);
  });
  return out;
}

/** approve (if needed) → review → finalize → sign → send → what arrived. */
async function swap(t, svc, rpc, who, quote, { slippageBips = 100, acceptImpact = false } = {}) {
  const approval = await svc.approvalFor(quote, who.address);
  for (const tx of await svc.approvalTxs(approval, who.address)) {
    const r = await sendAndWait(rpc, tx, who.sk);
    assert.equal(r.status, 1, `${tx.kind} mined`);
  }
  const review = await svc.reviewSwap({ quote, slippageBips, owner: who.address });
  const done = await svc.finalizeSwap({ review, acceptImpact, signPermit: async (p) => signPermitSingle(p, who.sk) });
  assert.equal(done.permitSigned, !quote.tokenIn.isEth);
  // The minimums in the transaction are the review's, share by share.
  assert.equal(
    minimaOf(done.tx.data).reduce((s, m) => s + m, 0n),
    review.minimumOut,
  );
  assert.equal(await svc.simulateTx(done.tx, who.address), true, 'the exact transaction goes through as an eth_call');
  const ethBefore = await rpc.getBalance(who.address);
  const receipt = await sendAndWait(rpc, done.tx, who.sk);
  assert.equal(receipt.status, 1, 'swap mined');
  assert.ok(receipt.gasUsed <= done.tx.gasLimit);
  const out = await svc.readReceipt(receipt, { owner: who.address, tokenOut: quote.tokenOut });
  t.diagnostic(`${quote.tokenIn} → ${quote.tokenOut}: in ${quote.amountIn}, quoted ${done.quote.amountOut}, minimum ${done.minimumOut}, received ${out.received}, gas ${receipt.gasUsed} (${done.quote.parts.length} share(s)), tx ${receipt.transactionHash}`);
  assert.ok(out.received >= done.minimumOut, 'at least the minimum');
  // Nothing else trades on the fork, so the swap gets its fresh quote exactly.
  assert.equal(out.received, done.quote.amountOut);
  const ethAfter = await rpc.getBalance(who.address);
  if (quote.tokenIn.isEth) assert.equal(ethBefore - ethAfter, quote.amountIn + out.gasCost, 'the amount and the network fee, nothing else');
  return { done, receipt, out, review };
}

test('fork: ETH → rsFIRO with anvil key 0: the minimum is in the transaction and what arrived is the quote', T, async (t) => {
  await withFork(async () => {
    const rpc = forkRpc();
    await rpc.assertMainnet();
    const svc = service(rpc);
    const who = await fundedKey({ key: ANVIL_KEY_0, eth: 10n * ETH });
    assert.equal(who.address, '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
    const before = await svc.balanceOf(rsfiro, who.address);
    const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: rsfiro, amountIn: ETH / 100n, owner: who.address });
    assert.equal((await svc.approvalFor(q, who.address)).kind, 'none');
    assert.ok(q.priceImpact !== null && q.priceImpact < 0.05);
    const { out } = await swap(t, svc, rpc, who, q);
    assert.equal((await svc.balanceOf(rsfiro, who.address)) - before, out.received, 'the Transfer logs to the owner are the balance change');
  });
});

test('fork: rsFIRO → ETH: an exact approval to Permit2, one PermitSingle signed r ‖ s ‖ v, ETH arrives', T, async (t) => {
  await withFork(async () => {
    const rpc = forkRpc();
    const svc = service(rpc);
    // A fresh key: anvil's key 0 carries EIP-7702 code on mainnet, so Permit2
    // would ask that code to check the signature instead of ecrecover.
    const who = await fundedKey();
    assert.equal((await rpc.getCode(who.address)).length, 0);
    await swap(t, svc, rpc, who, await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: rsfiro, amountIn: ETH / 50n }));
    const have = await svc.balanceOf(rsfiro, who.address);
    assert.ok(have > 0n);

    const sell = await svc.quote({ tokenIn: rsfiro, tokenOut: ETH_TOKEN, amountIn: have });
    const approval = await svc.approvalFor(sell, who.address);
    assert.equal(approval.kind, 'approve');
    const [approve] = await svc.approvalTxs(approval, who.address);
    assert.equal(decodeCall('approve(address,uint256)', approve.data)[1], have, 'exactly the amount');
    assert.equal((await sendAndWait(rpc, approve, who.sk)).status, 1);
    assert.equal(await tokenAllowance(rpc, rsfiro.address, who.address), have);
    const nonceBefore = (await permitAllowance(rpc, rsfiro.address, who.address)).nonce;

    const { done, out } = await swap(t, svc, rpc, who, sell);
    assert.equal(decodeCall('execute(bytes,bytes[],uint256)', done.tx.data)[0][0], UR_COMMAND.permit2Permit);
    assert.ok(out.received > 0n);
    assert.equal(await svc.balanceOf(rsfiro, who.address), 0n, 'all of it was sold');
    assert.equal(await tokenAllowance(rpc, rsfiro.address, who.address), 0n, 'the approval was used up exactly');
    const after = await permitAllowance(rpc, rsfiro.address, who.address);
    assert.equal(after.nonce, nonceBefore + 1, 'the permit was spent');
    assert.equal(after.amount, 0n);
  });
});

test('fork: a price that moved past the protection: the review refuses, and a swap built before the move is refused by Ethereum', T, async (t) => {
  await withFork(async () => {
    const rpc = forkRpc();
    const svc = service(rpc);
    const who = await fundedKey();
    const whale = await fundedKey({ eth: 1000n * ETH });
    const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: rsfiro, amountIn: ETH / 100n });
    const review = await svc.reviewSwap({ quote: q, slippageBips: 50, owner: who.address });
    const ready = await svc.finalizeSwap({ review });

    // Someone buys a lot of rsFIRO first, through the same pools.
    const big = await svc.quoter.requote(q, { amountIn: 2n * ETH });
    await swap(t, svc, rpc, whale, big, { slippageBips: 500, acceptImpact: true });

    await assert.rejects(svc.reviewSwap({ quote: q, slippageBips: 50, owner: who.address }), (e) => {
      assert.ok(e instanceof UniPriceMoved);
      t.diagnostic(`the price moved ${(e.moved * 100).toFixed(2)} %: ${q.amountOut} → ${e.fresh.amountOut}`);
      return e.moved > 0.005;
    });

    // The transaction built before the move still carries the old minimum.
    assert.equal(await svc.simulateTx(ready.tx, who.address), false);
    const rsBefore = await svc.balanceOf(rsfiro, who.address);
    const ethBefore = await rpc.getBalance(who.address);
    const receipt = await sendAndWait(rpc, ready.tx, who.sk);
    assert.equal(receipt.status, 0, 'Ethereum refused it');
    const out = await svc.readReceipt(receipt, { owner: who.address, tokenOut: rsfiro });
    assert.equal(out.success, false);
    assert.equal(await svc.balanceOf(rsfiro, who.address), rsBefore, 'nothing was swapped');
    assert.equal(ethBefore - (await rpc.getBalance(who.address)), out.gasCost, 'only the network fee was spent');
    t.diagnostic(`refused swap ${receipt.transactionHash}: fee ${out.gasCost} wei, gas ${receipt.gasUsed}`);
  });
});

test('fork: 2 ETH → USDC shared between pools, each share with its own minimum; sold back with one permit', T, async (t) => {
  await withFork(async () => {
    const rpc = forkRpc();
    const svc = service(rpc);
    const who = await fundedKey({ eth: 5n * ETH });
    const q = await svc.quote({ tokenIn: ETH_TOKEN, tokenOut: usdc, amountIn: 2n * ETH });
    assert.ok(q.isSplit, `one route: ${q.route.id}`);
    const ids = q.pools.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'a pool used twice');
    assert.notEqual((await svc.reviewSwap({ quote: q, owner: who.address })).impact, 'block');
    const { done } = await swap(t, svc, rpc, who, q, { acceptImpact: true });
    assert.equal(minimaOf(done.tx.data).length, done.quote.parts.length, 'one minimum per share');
    const commands = [...decodeCall('execute(bytes,bytes[],uint256)', done.tx.data)[0]];
    t.diagnostic(`commands ${commands.map((c) => c.toString(16).padStart(2, '0')).join(' ')}`);
    const have = await svc.balanceOf(usdc, who.address);
    assert.equal(have, done.quote.amountOut);

    const sell = await svc.quote({ tokenIn: usdc, tokenOut: ETH_TOKEN, amountIn: have });
    await swap(t, svc, rpc, who, sell, { acceptImpact: true });
    assert.equal(await svc.balanceOf(usdc, who.address), 0n);
  });
});
