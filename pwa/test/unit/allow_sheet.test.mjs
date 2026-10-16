// The Uniswap "Allow" sheet (screens/eth_swap_parts.js openAllowSheet) driven on a stand-in DOM, its
// signing, asking and chain looks replaced by scripted ones (deps): release audit 0.1.5, verification
// 3. A permission "no longer on its way" re-reads what the swap needs (never "nothing was approved" on
// a guess); an earlier permission settled as the sheet opens has the need read again first, and when
// that read fails the sheet says so, names the next step and offers nothing; transactions loaded out
// of order never put old ones under the button; one run at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { body, one } from './helpers/fake_dom.mjs';
import { RSFIRO } from '../../src/lib/eth/tokens.js';

const { openAllowSheet, permissionGoneWords } = await import('../../src/screens/eth_swap_parts.js');
const { bnbPermissionGoneWords } = await import('../../src/screens/eth_swap_bsc.js');

const ME = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const token = { symbol: 'rsFIRO', address: RSFIRO.address, decimals: 8, isEth: false };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 2000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

/** A wallet stand-in: an outbox, the server's client, the look the sheet takes. */
function wallet(outbox = []) {
  const rpc = { blockNumber: async () => 100, getTransactionCount: async () => 0n };
  return { state: { outbox, address: ME }, rpc, rpcFor: () => rpc, followOpen: async () => {}, followError: () => null, reloadOutbox: async () => {}, ethId: 'e1', kv: {} };
}

/** Transactions for an approval, from a service; `gate(n)` holds load n until released. */
function services() {
  const loads = [];
  const service = async () => ({
    approvalTxs: (approval) =>
      new Promise((resolve, reject) => {
        loads.push({ approval, resolve: () => resolve([{ kind: 'approve', expectedGasCost: 1000n, maxGasCost: 2000n, amount: approval.amount }]), reject });
      }),
  });
  return { service, loads };
}

function sheetDeps(over = {}) {
  const signed = [];
  const deps = {
    confirm: async () => true,
    short: async () => null,
    sign: async (_app, w, tx, meta) => {
      const entry = { hash: `0x${String(signed.length + 1).padStart(64, '0')}`, kind: tx.kind, nonce: '5', amount: String(meta.amount), state: 'pending' };
      // What was signed: the loaded transaction's own amount (the approval it was built for).
      signed.push(tx.amount !== undefined ? tx.amount : meta.amount);
      w.state.outbox.unshift(entry);
      return { sent: true, entry };
    },
    passMs: 1,
    open: undefined,
    ...over,
  };
  if (deps.open === undefined) delete deps.open;
  return { deps, signed };
}

test('"no longer on its way" re-reads what the swap needs: the new need is offered, never "nothing was approved" on a guess', async () => {
  body.replaceChildren();
  const w = wallet();
  const { service, loads } = services();
  let rechecks = 0;
  const { deps, signed } = sheetDeps({ service, onItsWay: async () => true, pass: async () => ({ kind: 'gone', state: 'used' }) });
  const done = openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 100n }, recheck: async () => (rechecks++, { kind: 'approve', token, amount: 150n }), deps });
  await until(() => loads.length === 1, 'the first load');
  loads[0].resolve();
  await until(() => !one('uni-approve-cta').disabled, 'Allow enabled');
  const run1 = one('uni-approve-cta').click();
  await until(() => rechecks === 1, 'the need read again');
  await until(() => loads.length === 2, 'the new transactions asked for');
  loads[1].resolve();
  await until(() => /Allow 0\.0000015 rsFIRO/.test(one('uni-approve-cta').textContent) && !one('uni-approve-cta').disabled, 'Allow for the new need');
  assert.deepEqual(signed, [100n], 'one permission sent so far');
  assert.ok(!one('uni-approve-failed'), 'no "didn\'t go through"');
  assert.match(body.textContent, /no longer on its way: its place in this wallet's queue is used/);
  await run1;
  // The next tap sends the freshly decided need only.
  const run2 = one('uni-approve-cta').click();
  await until(() => signed.length === 2, 'the second permission');
  assert.equal(signed[1], 150n);
  void run2;
  void done;
});

test('the balance read again after the password: short, nothing is signed and it says why; the need is decided again', async () => {
  body.replaceChildren();
  const w = wallet();
  const { service, loads } = services();
  let rechecks = 0;
  const asked = [];
  let shortWords = 'Not enough rsFIRO for this swap: 0 can be used now, and it needs 0.000001.';
  const { deps, signed } = sheetDeps({ service, onItsWay: async () => true, pass: async () => ({ kind: 'effect' }), short: async (_w, chainKey, need) => (asked.push({ chainKey, ...need }), shortWords) });
  const result = openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 100n }, recheck: async () => (rechecks++, { kind: 'approve', token, amount: 100n }), swapFee: 500n, deps });
  await until(() => loads.length === 1, 'the first load');
  loads[0].resolve();
  await until(() => !one('uni-approve-cta').disabled, 'Allow enabled');
  await one('uni-approve-cta').click();
  await until(() => /Nothing was sent\. Not enough rsFIRO for this swap/.test(body.textContent), 'the shortage said');
  assert.deepEqual(signed, [], 'nothing signed');
  assert.equal(asked[0].chainKey, 'ethereum');
  assert.equal(asked[0].amount, 100n, 'what the swap takes of the token');
  assert.equal(asked[0].fees, 2500n, 'the permission\'s fee at most, and the swap\'s own');
  await until(() => rechecks === 1, 'the need decided again');
  await until(() => loads.length === 2, 'its transactions asked for');
  loads[1].resolve();
  await until(() => !one('uni-approve-cta').disabled, 'Allow offered again');
  shortWords = null;
  await one('uni-approve-cta').click();
  await until(() => signed.length === 1, 'enough now: signed');
  assert.equal(await result, true);
});

test('an earlier permission settled as the sheet opens: the need is read again first; in effect, the sheet closes and the swap goes on', async () => {
  body.replaceChildren();
  const earlier = { hash: `0x${'aa'.repeat(32)}`, kind: 'approve', token: token.address, spender: '0x000000000022d473030f116ddee9f6b43ac78ba3', nonce: '4', amount: '100', state: 'pending', chain: 'ethereum' };
  const w = wallet([earlier]);
  const { service, loads } = services();
  let settled = 0;
  const { deps, signed } = sheetDeps({ service, onItsWay: async () => false, settleEntry: async () => settled++ });
  const result = openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 100n }, recheck: async () => ({ kind: 'none', token, amount: 100n, current: 100n }), deps });
  assert.equal(await result, true, 'nothing to allow: the review opens');
  assert.equal(settled, 1);
  assert.deepEqual(signed, []);
  void loads;
});

test('S4: when that read fails, the sheet says so with the next step, stops "Checking…", and offers nothing', async () => {
  body.replaceChildren();
  const earlier = { hash: `0x${'ab'.repeat(32)}`, kind: 'approve', token: token.address, spender: '0x000000000022d473030f116ddee9f6b43ac78ba3', nonce: '4', amount: '100', state: 'pending', chain: 'ethereum' };
  const w = wallet([earlier]);
  const { service, loads } = services();
  const { deps, signed } = sheetDeps({ service, onItsWay: async () => false, settleEntry: async () => {} });
  openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 100n }, recheck: async () => { throw new Error('Stack Wallet could not be reached.'); }, deps });
  await until(() => loads.length >= 1, 'a load');
  loads[0].resolve();
  await until(() => one('uni-approve-failed'), 'the failure said');
  const failed = one('uni-approve-failed').textContent;
  assert.match(failed, /^Couldn't check the permission\. Stack Wallet could not be reached\. Nothing was sent\. Close this and tap Swap again\.$/);
  assert.doesNotMatch(failed, /didn't go through/, 'the earlier permission may be in effect: never "didn\'t go through"');
  const cta = one('uni-approve-cta');
  assert.equal(cta.disabled, true, 'nothing offered');
  assert.doesNotMatch(cta.textContent, /Checking/, 'not "Checking…" for ever');
  await cta.click();
  assert.deepEqual(signed, []);
  assert.equal(one('uni-approve-cancel').disabled, false, 'Close works');
});

test('S3: transactions loaded out of order: the older load\'s answer, or its error, never lands under the button', async () => {
  for (const lateOutcome of ['answer', 'error']) {
    body.replaceChildren();
    const earlier = { hash: `0x${'ac'.repeat(32)}`, kind: 'approve', token: token.address, spender: '0x000000000022d473030f116ddee9f6b43ac78ba3', nonce: '4', amount: '100', state: 'pending', chain: 'ethereum' };
    const w = wallet([earlier]);
    const { service, loads } = services();
    const { deps, signed } = sheetDeps({ service, onItsWay: async () => false, settleEntry: async () => {}, pass: async () => ({ kind: 'effect' }) });
    const result = openAllowSheet({}, { w, approval: { kind: 'resetThenApprove', token, amount: 100n }, recheck: async () => ({ kind: 'approve', token, amount: 150n }), deps });
    // The opening load (the old approval) is still out when the re-read asks for the new one.
    await until(() => loads.length === 2, 'both loads');
    loads[1].resolve();
    await until(() => /Allow 0\.0000015 rsFIRO/.test(one('uni-approve-cta').textContent), 'the new need on the button');
    if (lateOutcome === 'answer') loads[0].resolve();
    else loads[0].reject(new Error('late'));
    await tick(20);
    assert.ok(!one('uni-approve-failed'), `the late ${lateOutcome} is dropped`);
    one('uni-approve-cta').click();
    await until(() => signed.length === 1, 'sent');
    assert.equal(signed[0], 150n, 'the new transactions were sent, not the old ones');
    assert.equal(await result, true);
  }
});

test('one run at a time: a second tap while the first asks for the password starts nothing', async () => {
  body.replaceChildren();
  const w = wallet();
  const { service, loads } = services();
  let asked = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps, signed } = sheetDeps({ service, onItsWay: async () => true, confirm: async () => (asked++, gate), pass: async () => ({ kind: 'effect' }) });
  const result = openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 100n }, recheck: async () => ({ kind: 'approve', token, amount: 100n }), deps });
  await until(() => loads.length === 1, 'the load');
  loads[0].resolve();
  await until(() => !one('uni-approve-cta').disabled, 'Allow enabled');
  const first = one('uni-approve-cta').click();
  await tick();
  assert.equal(one('uni-approve-cta').disabled, true, 'disabled while the run is under way');
  one('uni-approve-cta').listeners.get('click').forEach((fn) => fn({ type: 'click' })); // a tap on the disabled button's handler itself
  await tick();
  assert.equal(asked, 1, 'one password prompt');
  release(true);
  await first;
  assert.equal(await result, true);
  assert.deepEqual(signed, [100n], 'one permission');
});

test('words for a permission that will not take effect: what is known, never more; the next step from the allowance', () => {
  assert.match(permissionGoneWords('used'), /its place in this wallet's queue is used\. It went through and was used up by a swap since, or Ethereum refused it \(its fee spent\), or another transaction took its place\./);
  assert.match(permissionGoneWords('rejected', 'It'), /most likely never left and nothing was spent/);
  assert.match(permissionGoneWords('failed'), /refused by Ethereum, so nothing was approved by it; its network fee was spent/);
  const [title, text] = bnbPermissionGoneWords('used', { enough: false });
  assert.equal(title, 'The permission is no longer on its way. ');
  assert.match(text, /went through and was used up by a swap since, or BNB Chain refused it \(its fee spent\), or another transaction took its place\. Nothing was swapped; allow again to sell\.$/);
  assert.match(bnbPermissionGoneWords('failed', { enough: true })[1], /PancakeSwap may already move this rsFIRO: tap Swap\.$/, 'the allowance already covers: Swap, not "allow again" (N3)');
  assert.match(bnbPermissionGoneWords('rejected')[1], /most likely never left and nothing was spent/, 'the same hedge on both chains (N4)');
});

// ---------------------------------------------------------------- one decision (final verification)

const { approvalNeeded } = await import('../../src/lib/eth/uniswap_app.js');
const { UniswapService, approveGoesThrough } = await import('../../src/lib/eth/uniswap/service.js');
const { bigIntToBytes } = await import('../../src/lib/eth/hex.js');
const { selector } = await import('../../src/lib/eth/abi.js');
const { EthRpcError } = await import('../../src/lib/eth/rpc.js');
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const { bytesToHex: hexOf } = await import('../../src/lib/eth/hex.js');
const ALLOWANCE = hexOf(selector('allowance(address,address)'));

/**
 * An Ethereum server for one token: the allowance by block ({block: value}, from that block on), its
 * newest block `head` (a backend behind the block that confirmed the permission has a lower head),
 * and USDT's rule (an approve from a non-zero allowance reverts) when `usdt`.
 */
function tokenServer({ head, allowanceFrom, usdt = false, name = 'PublicNode' }) {
  const at = (n) => [...allowanceFrom].reverse().find(([b]) => b <= n)[1];
  const blockOf = (b) => {
    if (b === 'latest' || b === undefined) return head;
    if (b > head) throw new EthRpcError(-32000, 'header not found');
    return b;
  };
  const probes = [];
  return {
    host: { name },
    probes,
    blockNumber: async () => head,
    getTransactionCount: async () => 6n,
    ethCall: async (call, b) => {
      const n = blockOf(b);
      const data = typeof call.data === 'string' ? call.data : hexOf(call.data);
      if (data.startsWith(ALLOWANCE)) return bigIntToBytes(at(n), 32);
      probes.push(b);
      if (usdt && at(n) > 0n) throw new EthRpcError(3, 'execution reverted');
      return new Uint8Array(32);
    },
    // A reset to 0 always estimates; an approve to a non-zero amount reverts here (as USDT's over a
    // non-zero allowance, or any token refusing it).
    estimateGas: async (call) => {
      const data = typeof call.data === 'string' ? call.data : hexOf(call.data);
      if (BigInt(`0x${data.slice(-64)}`) === 0n) return 46000n;
      throw new EthRpcError(3, 'execution reverted');
    },
  };
}

/** A wallet whose newest permission for rsFIRO to Permit2 was confirmed in block 11. */
function walletAt(rpc, { open = true } = {}) {
  const confirmed = { hash: `0x${'c0'.repeat(32)}`, kind: 'approve', token: token.address, spender: PERMIT2, nonce: '5', amount: '100', state: 'confirmed', chain: 'ethereum', receipt: { blockNumber: 11, status: 1 } };
  const pending = { hash: `0x${'c1'.repeat(32)}`, kind: 'approve', token: token.address, spender: PERMIT2, nonce: '6', amount: '100', state: 'pending', chain: 'ethereum' };
  const other = { hash: `0x${'c2'.repeat(32)}`, kind: 'approve', token: '0x1111111111111111111111111111111111111111', spender: PERMIT2, nonce: '9', amount: '1', state: 'confirmed', chain: 'ethereum', receipt: { blockNumber: 99, status: 1 } };
  return { state: { outbox: open ? [pending, confirmed, other] : [confirmed, other], address: ME }, rpc, rpcFor: () => rpc, followOpen: async () => {}, followError: () => null, reloadOutbox: async () => {}, ethId: 'e1', kv: null };
}
const realService = (w) => async () => Object.assign(Object.create(UniswapService.prototype), { rpc: w.rpc });

test('one decision: read at one block no older than the newest permission; a backend behind it is waited for, then refused, naming the server', async () => {
  const q = { tokenIn: token, amountIn: 100n };
  const behind = walletAt(tokenServer({ head: 10, allowanceFrom: [[0, 0n], [11, 100n]] }));
  await assert.rejects(approvalNeeded(behind, q, { service: realService(behind), tries: 2, waitMs: 1 }), (e) => e.code === 'behind' && /^PublicNode is behind the block that confirmed your permission\.$/.test(e.message));
  const fresh = walletAt(tokenServer({ head: 11, allowanceFrom: [[0, 0n], [11, 100n]] }));
  const d = await approvalNeeded(fresh, q, { service: realService(fresh), tries: 2, waitMs: 1 });
  assert.deepEqual([d.kind, d.current, d.block], ['none', 100n, 11], 'in effect, read at block 11 (another token\'s block 99 does not hold it up)');
});

test("S2 (final): USDT's \"from non-zero?\" probe runs at the decision's block, never 'latest'; a non-zero allowance short of the need is reset first", async () => {
  // Allowance 40 from block 11; the need is 100. A backend whose 'latest' is older would show 0 and "approve".
  const rpc = tokenServer({ head: 12, allowanceFrom: [[0, 0n], [11, 40n]], usdt: true });
  const w = walletAt(rpc, { open: false });
  const d = await approvalNeeded(w, { tokenIn: token, amountIn: 100n }, { service: realService(w), tries: 2, waitMs: 1 });
  assert.deepEqual([d.kind, d.current, d.block], ['resetThenApprove', 40n, 12]);
  assert.deepEqual(rpc.probes, [12], 'the probe asked at block 12, the same as the allowance');
  assert.equal(await approveGoesThrough(rpc, { owner: ME, token: token.address, amount: 100n, block: 12 }), false);
  // A server that cannot answer the probe: "couldn't check", never a guess.
  const down = { ...rpc, ethCall: async (call, b) => (String(call.data).startsWith(ALLOWANCE) ? bigIntToBytes(40n, 32) : Promise.reject(new EthRpcError('network', 'down'))) };
  await assert.rejects(approvalNeeded({ ...w, rpc: down, rpcFor: () => down }, { tokenIn: token, amountIn: 100n }, { service: async () => Object.assign(Object.create(UniswapService.prototype), { rpc: down }), tries: 2, waitMs: 1 }));
});

test('an approve whose gas estimate reverts is never built: over a non-zero allowance it becomes reset-then-approve; from zero, refused', async () => {
  const rpc = tokenServer({ head: 12, allowanceFrom: [[0, 0n]] });
  const svc = Object.assign(Object.create(UniswapService.prototype), { rpc, fees: async () => ({ baseFee: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 3n }) });
  const txs = await svc.approvalTxs({ kind: 'approve', token, amount: 100n, current: 40n }, ME);
  assert.deepEqual(txs.map((x) => x.kind), ['approveReset', 'approve'], 'a token that refuses a change from non-zero: set to 0 first');
  await assert.rejects(svc.approvalTxs({ kind: 'approve', token, amount: 100n, current: 0n }, ME), (e) => e instanceof EthRpcError, 'from zero: refused, never signed on a fallback gas');
  const [reset, after] = await svc.approvalTxs({ kind: 'resetThenApprove', token, amount: 100n, current: 40n }, ME);
  assert.equal(reset.kind, 'approveReset');
  assert.equal(after.kind, 'approve', 'only the approve after a reset gets the fallback gas (it must revert until the reset is mined)');
  // A reset step whose estimate reverts is refused too.
  const stubborn = Object.assign(Object.create(UniswapService.prototype), { rpc: { ...rpc, estimateGas: async () => Promise.reject(new EthRpcError(3, 'execution reverted')) }, fees: svc.fees });
  await assert.rejects(stubborn.approvalTxs({ kind: 'resetThenApprove', token, amount: 100n, current: 40n }, ME));
});

test('B1 (final): after a followed earlier permission settles and the need cannot be read again, "Allow" stays off and a tap signs nothing', async () => {
  body.replaceChildren();
  // The earlier permission (for less than this swap needs) is followed; it confirms; the re-read fails.
  const earlier = { hash: `0x${'b1'.repeat(32)}`, kind: 'approve', token: token.address, spender: PERMIT2, nonce: '4', amount: '50', state: 'pending', chain: 'ethereum' };
  const w = wallet([earlier]);
  const { service, loads } = services();
  let rechecks = 0;
  const { deps, signed } = sheetDeps({ service, onItsWay: async () => true, pass: async () => ({ kind: 'effect' }) });
  openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 150n }, recheck: async () => { rechecks++; throw new EthRpcError('behind', 'PublicNode is behind the block that confirmed your permission.'); }, deps });
  await until(() => loads.length >= 1, 'a load');
  loads[0].resolve();
  await until(() => one('uni-approve-failed'), 'the failure said');
  assert.match(one('uni-approve-failed').textContent, /^Couldn't check the permission\. PublicNode is behind the block that confirmed your permission\. Nothing was sent\. Close this and tap Swap again\.$/);
  assert.equal(rechecks, 1);
  assert.equal(one('uni-approve-cta').disabled, true, '"Allow" is enabled only on a fresh decision');
  await one('uni-approve-cta').click();
  one('uni-approve-cta').listeners.get('click').forEach((fn) => fn({ type: 'click' })); // the handler itself, past the disabled button
  await tick(20);
  assert.deepEqual(signed, [], 'the transactions built before the earlier permission took effect are never signed');
});

test('the sheet over a lagging backend: "Couldn\'t check the permission… Nothing was sent", nothing signed; caught up, the swap goes on', async () => {
  const q = { tokenIn: token, amountIn: 100n };
  body.replaceChildren();
  const behind = walletAt(tokenServer({ head: 10, allowanceFrom: [[0, 0n], [11, 100n]] }));
  const { service: txService, loads } = services();
  const { deps, signed } = sheetDeps({ service: txService, onItsWay: async () => false, settleEntry: async () => {} });
  openAllowSheet({}, { w: behind, approval: { kind: 'approve', token, amount: 100n }, recheck: () => approvalNeeded(behind, q, { service: realService(behind), tries: 2, waitMs: 1 }), deps });
  await until(() => loads.length >= 1, 'a load');
  loads[0].resolve();
  await until(() => one('uni-approve-failed'), 'the failure said');
  assert.match(one('uni-approve-failed').textContent, /^Couldn't check the permission\. PublicNode is behind the block that confirmed your permission\. Nothing was sent\. Close this and tap Swap again\.$/);
  assert.equal(one('uni-approve-cta').disabled, true);
  await one('uni-approve-cta').click();
  assert.deepEqual(signed, []);
  body.replaceChildren();
  const fresh = walletAt(tokenServer({ head: 11, allowanceFrom: [[0, 0n], [11, 100n]] }));
  const t2 = services();
  const d2 = sheetDeps({ service: t2.service, onItsWay: async () => false, settleEntry: async () => {} });
  const result = openAllowSheet({}, { w: fresh, approval: { kind: 'approve', token, amount: 100n }, recheck: () => approvalNeeded(fresh, q, { service: realService(fresh), tries: 2, waitMs: 1 }), deps: d2.deps });
  assert.equal(await result, true);
  assert.deepEqual(d2.signed, []);
});

// ------------------------------------------------- verification of 47ff0d81c (two SHOULD-FIX, nits)

const { APPROVE_FALLBACK_GAS, gasWithHeadroom } = await import('../../src/lib/eth/uniswap/service.js');
const FEES = async () => ({ baseFee: 1n, maxPriorityFeePerGas: 1n, maxFeePerGas: 3n });

test('a server\'s 429 is never "the token refuses a change from non-zero": the decision and the transactions say "couldn\'t check", never reset-then-approve', async () => {
  // BlockRazor answers a burst with {"code":429,"message":"too many requests"}: a numbered error, not a revert.
  const busy = new EthRpcError(429, 'too many requests');
  const base = tokenServer({ head: 12, allowanceFrom: [[0, 0n], [11, 40n]] }); // USDC-like: no USDT rule
  const rpc = { ...base, ethCall: async (call, b) => ((typeof call.data === 'string' ? call.data : hexOf(call.data)).startsWith(ALLOWANCE) ? base.ethCall(call, b) : Promise.reject(busy)) };
  await assert.rejects(approveGoesThrough(rpc, { owner: ME, token: token.address, amount: 100n, block: 12 }), (e) => e === busy, 'the probe throws; only a revert is "refuses"');
  const w = walletAt(rpc, { open: false });
  await assert.rejects(
    approvalNeeded(w, { tokenIn: token, amountIn: 100n }, { service: async () => Object.assign(Object.create(UniswapService.prototype), { rpc }), tries: 2, waitMs: 1 }),
    (e) => e === busy,
    "the decision: couldn't check (never resetThenApprove)",
  );
  // The approve's own estimate answered 429 over a non-zero allowance: thrown, never turned into a reset.
  const est429 = Object.assign(Object.create(UniswapService.prototype), { rpc: { ...base, estimateGas: async () => Promise.reject(busy) }, fees: FEES });
  await assert.rejects(est429.approvalTxs({ kind: 'approve', token, amount: 100n, current: 40n }, ME), (e) => e === busy);
  // After a reset, only a revert earns the fallback gas: a 429 on step 2's estimate throws.
  const step2busy = Object.assign(Object.create(UniswapService.prototype), {
    rpc: { ...base, estimateGas: async (call) => (BigInt(`0x${(typeof call.data === 'string' ? call.data : hexOf(call.data)).slice(-64)}`) === 0n ? 46000n : Promise.reject(busy)) },
    fees: FEES,
  });
  await assert.rejects(step2busy.approvalTxs({ kind: 'resetThenApprove', token, amount: 100n, current: 40n }, ME), (e) => e === busy);
  // A real revert still makes it two steps (USDT).
  const usdt = Object.assign(Object.create(UniswapService.prototype), { rpc: base, fees: FEES });
  assert.deepEqual((await usdt.approvalTxs({ kind: 'approve', token, amount: 100n, current: 40n }, ME)).map((x) => x.kind), ['approveReset', 'approve']);
});

test('after a reset, the approve gets at least the fallback gas (its estimate is over the old allowance, cheaper than from zero)', async () => {
  const base = tokenServer({ head: 12, allowanceFrom: [[0, 0n]] });
  const withEstimate = (gas) => Object.assign(Object.create(UniswapService.prototype), { rpc: { ...base, estimateGas: async () => gas }, fees: FEES });
  const [, low] = await withEstimate(30000n).approvalTxs({ kind: 'resetThenApprove', token, amount: 100n, current: 40n }, ME);
  assert.equal(low.gasLimit, gasWithHeadroom(APPROVE_FALLBACK_GAS));
  const [reset, high] = await withEstimate(90000n).approvalTxs({ kind: 'resetThenApprove', token, amount: 100n, current: 40n }, ME);
  assert.equal(high.gasLimit, gasWithHeadroom(90000n), 'a higher estimate is kept');
  assert.equal(reset.gasLimit, gasWithHeadroom(90000n), 'the reset step: its own estimate');
  const [one1] = await withEstimate(30000n).approvalTxs({ kind: 'approve', token, amount: 100n, current: 0n }, ME);
  assert.equal(one1.gasLimit, gasWithHeadroom(30000n), 'a single approve: its estimate, no floor');
});

// The BNB Chain swap screen (screens/eth_swap_bsc.js) on the stand-in DOM: its wallet and price scripted.
const ethSwapBsc = (await import('../../src/screens/eth_swap_bsc.js')).default;
const { RSFIRO_BSC } = await import('../../src/lib/eth/tokens.js');
const { PANCAKE } = await import('../../src/lib/eth/pancake.js');
const { chainOf } = await import('../../src/lib/eth/chains.js');
const { EthWallet } = await import('../../src/lib/eth/wallet.js');

/** A BNB Chain server: the router's allowance (the next `failAllowance` reads answer 429), estimates that revert. */
function bscServer() {
  const s = { allowance: 40n, failAllowance: 0, allowanceReads: 0, estimates: 0 };
  s.rpc = {
    host: { name: 'BNB Chain', id: 'bsc-bnbchain', chain: 'bsc' },
    chain: chainOf('bsc'),
    blockNumber: async () => 100,
    getTransactionCount: async () => 9n,
    call: async (m) => (m === 'eth_gasPrice' ? '0x3b9aca00' : Promise.reject(new EthRpcError(-32601, `${m} not here`))),
    ethCall: async () => {
      s.allowanceReads++;
      if (s.failAllowance > 0) {
        s.failAllowance--;
        throw new EthRpcError(429, 'too many requests');
      }
      return bigIntToBytes(s.allowance, 32);
    },
    estimateGas: async () => {
      s.estimates++;
      throw new EthRpcError(3, 'execution reverted');
    },
  };
  return s;
}
/** The real wallet's figures (balances, held, spendable) over a scripted state; its server and its looks scripted. */
function bscWallet(rpc, outbox = [], { bnb = 10n ** 18n, rsfiro = 10n ** 10n } = {}) {
  const w = Object.create(EthWallet.prototype);
  w.follows = 0;
  return Object.assign(w, {
    state: { outbox, address: ME, chains: { bsc: { native: bnb, tokens: new Map([['rsFIRO', rsfiro]]), checkedAt: 1 }, ethereum: { native: 0n, tokens: new Map(), checkedAt: 1 } } },
    rpcFor: () => rpc,
    otherRpcs: () => [],
    refreshChain: async () => {},
    reloadOutbox: async () => {},
    followOpen: async () => {
      w.follows++;
      return false;
    },
    ethId: 'e1',
    kv: {},
  });
}
const bscQuote = async (_rpc, { side, amountIn }) => ({ side, amountIn, amountOut: 10n ** 15n, priceImpact: 0.001 });
const bscApp = () => ({ go() {}, back() {}, dbPass: null });
function openBsc(w) {
  body.replaceChildren();
  const app = bscApp();
  app.bscSwapDraft = null;
  const view = ethSwapBsc(app, { side: 'sell', amount: '1' }, { wallet: async () => w, quote: bscQuote });
  body.appendChild(view.el);
  return view;
}
const allowOffered = () => one('pcs-swap-cta').dataset.step === 'approve' && !one('pcs-swap-cta').disabled;

test('BNB Chain: a check that fails before signing keeps the last figure, so "Allow" runs the check again (never "Checking…" with nothing checking)', async () => {
  const s = bscServer();
  const view = openBsc(bscWallet(s.rpc));
  await until(allowOffered, '"Allow" offered', 4000);
  s.failAllowance = 1;
  one('pcs-swap-cta').click();
  await until(() => /Couldn't check the permission\. too many requests Nothing was sent\. Try again in a moment\./.test(view.el.textContent), 'the failure said');
  assert.ok(allowOffered(), '"Allow" is there to try again');
  assert.doesNotMatch(one('pcs-reason').textContent, /Checking the rsFIRO permission/);
  const reads = s.allowanceReads;
  one('pcs-swap-cta').click();
  await until(() => s.estimates === 1, 'checked again, then prepared');
  assert.ok(s.allowanceReads > reads, 'the tap ran the check again before preparing');
  view.destroy();
});

test('BNB Chain: none known (an earlier permission settled and its re-read failed too): read again with the price, then "Allow"', async () => {
  const s = bscServer();
  // A permission sent earlier for less, its nonce now used (settled as the tap looks at it).
  const earlier = { hash: `0x${'d1'.repeat(32)}`, kind: 'approve', token: RSFIRO_BSC.address, spender: PANCAKE.smartRouter, nonce: '3', amount: '10', state: 'pending', sentAt: 1, chain: 'bsc' };
  const view = openBsc(bscWallet(s.rpc, [earlier]));
  await until(allowOffered, '"Allow" offered', 4000);
  s.failAllowance = 2; // the re-read after settling, and the decision
  one('pcs-swap-cta').click();
  await until(() => /Couldn't check the permission\./.test(view.el.textContent), 'the failure said');
  await until(allowOffered, 'read again with the price: "Allow" offered again', 4000);
  assert.equal(s.failAllowance, 0);
  view.destroy();
});

// ------------------------------------------------------------- release audit 0.1.6 (BEAM port's audit)

test('MEV Blocker behind: {"code":3,"message":"Unknown block"} on the USDT probe or the estimate is "couldn\'t check", never reset-then-approve (a needless fee)', async () => {
  const unknown = new EthRpcError(3, 'Unknown block');
  const base = tokenServer({ head: 12, allowanceFrom: [[0, 0n], [11, 40n]], usdt: true, name: 'MEV Blocker' });
  const data = (call) => (typeof call.data === 'string' ? call.data : hexOf(call.data));
  // The allowance is read; the probe at that block lands on a backend that lacks it.
  const rpc = { ...base, ethCall: async (call, b) => (data(call).startsWith(ALLOWANCE) ? base.ethCall(call, b) : Promise.reject(unknown)) };
  await assert.rejects(approveGoesThrough(rpc, { owner: ME, token: token.address, amount: 100n, block: 12 }), (e) => e === unknown);
  const w = walletAt(rpc, { open: false });
  await assert.rejects(approvalNeeded(w, { tokenIn: token, amountIn: 100n }, { service: async () => Object.assign(Object.create(UniswapService.prototype), { rpc }), tries: 2, waitMs: 1 }), (e) => e === unknown);
  // The approve's estimate over a non-zero allowance, answered "Unknown block": thrown, never two steps.
  const svc = Object.assign(Object.create(UniswapService.prototype), { rpc: { ...base, estimateGas: async () => Promise.reject(unknown) }, fees: FEES });
  await assert.rejects(svc.approvalTxs({ kind: 'approve', token, amount: 100n, current: 40n }, ME), (e) => e === unknown);
  // And after a reset, "Unknown block" on step 2 is not the revert that earns the fallback gas.
  const step2 = Object.assign(Object.create(UniswapService.prototype), { rpc: { ...base, estimateGas: async (call) => (BigInt(`0x${data(call).slice(-64)}`) === 0n ? 46000n : Promise.reject(unknown)) }, fees: FEES });
  await assert.rejects(step2.approvalTxs({ kind: 'resetThenApprove', token, amount: 100n, current: 40n }, ME), (e) => e === unknown);
  // The real USDT revert ("execution reverted") is still told apart: two steps.
  const usdt = walletAt(base, { open: false });
  assert.equal((await approvalNeeded(usdt, { tokenIn: token, amountIn: 100n }, { service: realService(usdt), tries: 2, waitMs: 1 })).kind, 'resetThenApprove');
});

test('BNB Chain: a sale of rsFIRO still on its way holds the next (both would count on the same permission); "Check again" looks, and once it is confirmed the swap goes on', async () => {
  const s = bscServer();
  const sale = { hash: `0x${'5a'.repeat(32)}`, kind: 'swap', asset: 'rsFIRO', token: RSFIRO_BSC.address, amount: '100000000', nonce: '7', gasLimit: '230000', maxFeePerGas: '1000000000', state: 'pending', sentAt: 1, chain: 'bsc' };
  const w = bscWallet(s.rpc, [sale]);
  const view = openBsc(w);
  await until(() => one('pcs-swap-on-its-way'), 'the hold said', 4000);
  assert.equal(one('pcs-swap-cta').disabled, true, 'nothing new is built');
  assert.equal(one('pcs-reason').textContent, 'Your last swap of rsFIRO is still on its way.');
  assert.match(one('pcs-swap-on-its-way').textContent, /^Your last swap of rsFIRO is still on its way\. Swap rsFIRO again once BNB Chain confirms it: a second swap now would count on the same rsFIRO and fail on BNB Chain, its network fee lost\./);
  const looks = w.follows;
  assert.ok(looks >= 1, 'open transactions looked at as the screen opens');
  sale.state = 'confirmed'; // what the next look finds
  sale.receipt = { blockNumber: 100, status: 1 };
  await one('pcs-swap-on-its-way-check').click();
  assert.equal(w.follows, looks + 1);
  await until(allowOffered, 'the swap goes on: "Allow" offered', 4000);
  assert.equal(one('pcs-swap-on-its-way'), null);
  view.destroy();
});

test('BNB Chain: buying with BNB a payment on its way already holds: refused before anything is built, and said as held', async () => {
  const s = bscServer();
  const payment = { hash: `0x${'5b'.repeat(32)}`, asset: 'BNB', token: null, amount: String(9n * 10n ** 17n), nonce: '8', gasLimit: '21000', maxFeePerGas: '1000000000', state: 'pending', sentAt: 1, chain: 'bsc' };
  const w = bscWallet(s.rpc, [payment]);
  body.replaceChildren();
  const app = bscApp();
  const view = ethSwapBsc(app, { side: 'buy', amount: '0.2' }, { wallet: async () => w, quote: bscQuote });
  body.appendChild(view.el);
  await until(() => /held for a transaction still on its way/.test(one('pcs-reason').textContent), 'the hold said', 4000);
  assert.match(one('pcs-reason').textContent, /^Not enough BNB free: you can swap 0\.0999\d* BNB\. 0\.9\d* BNB more is held for a transaction still on its way\.$/);
  assert.match(view.el.textContent, /You have 1 BNB · 0\.9\d* BNB held for a transaction not confirmed yet/, 'the balance, and what of it is held (never read as money coming in)');
  assert.equal(one('pcs-swap-cta').disabled, true);
  view.destroy();
});

test('the Allow sheet after its ten minutes of following: says Campfire stopped watching it, and what to do (see it, then Swap again)', async () => {
  body.replaceChildren();
  const w = wallet();
  const { service, loads } = services();
  const { deps } = sheetDeps({ service, pass: async () => ({ kind: 'waiting' }), followMs: 30 });
  openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 100n }, recheck: async () => ({ kind: 'approve', token, amount: 100n }), deps });
  await until(() => loads.length >= 1, 'a load');
  loads[0].resolve();
  await until(() => !one('uni-approve-cta').disabled, 'Allow enabled');
  one('uni-approve-cta').click();
  await until(() => one('uni-approve-unconfirmed') && one('uni-approve-unconfirmed').dataset.stopped === 'true', 'the follow ended', 3000);
  const words = one('uni-approve-unconfirmed').textContent;
  assert.match(words, /Firo PWA stopped watching it here after ten minutes: see it to follow it, and once it is confirmed, tap Swap again\./);
  assert.doesNotMatch(words, /opens by itself|keeps following/, 'nothing promised that no longer happens');
  assert.ok(one('uni-approve-see'), 'See it');
  assert.equal(one('uni-approve-cta').textContent, 'Not confirmed yet');
  assert.equal(one('uni-approve-cta').disabled, true);
});

test('BNB Chain: a sale mined but still open (its server keeps receipts to itself, so the entry never closes) holds nothing; one truly on its way still does', async () => {
  const sale = () => ({ hash: `0x${'5c'.repeat(32)}`, kind: 'swap', asset: 'rsFIRO', token: RSFIRO_BSC.address, amount: '100000000', nonce: '7', gasLimit: '230000', maxFeePerGas: '1000000000', state: 'pending', sentAt: 1, chain: 'bsc' });
  // Mined: the account's mined count (read with the balances) is past its nonce.
  const minedW = bscWallet(bscServer().rpc, [sale()]);
  minedW.state.chains.bsc.minedNonce = 8n;
  const v1 = openBsc(minedW);
  await until(allowOffered, '"Allow" offered: no hold', 4000);
  assert.equal(one('pcs-swap-on-its-way'), null);
  assert.doesNotMatch(v1.el.textContent, /on its way|held for a transaction/, 'nothing held next to the balance either');
  v1.destroy();
  // On its way: the count is its own nonce.
  const pendingW = bscWallet(bscServer().rpc, [sale()]);
  pendingW.state.chains.bsc.minedNonce = 7n;
  const v2 = openBsc(pendingW);
  await until(() => one('pcs-swap-on-its-way'), 'held', 4000);
  assert.equal(one('pcs-swap-cta').disabled, true);
  v2.destroy();
});

test('release verification 0.1.8: a permission for this token sent from elsewhere while the password was asked is read right before signing: followed, never sent a second time', async () => {
  body.replaceChildren();
  const w = wallet();
  const { service, loads } = services();
  let release;
  const gate = new Promise((r) => (release = r));
  const other = { hash: `0x${'ad'.repeat(32)}`, kind: 'approve', token: token.address, spender: '0x000000000022d473030f116ddee9f6b43ac78ba3', nonce: '4', amount: '100', state: 'pending', chain: 'ethereum' };
  const looked = [];
  const { deps, signed } = sheetDeps({ service, onItsWay: async (_rpc, e) => (looked.push(e.hash), true), confirm: async () => gate, pass: async () => ({ kind: 'effect' }) });
  const result = openAllowSheet({}, { w, approval: { kind: 'approve', token, amount: 100n }, recheck: async () => ({ kind: 'none', token, amount: 100n, current: 100n }), deps });
  await until(() => loads.length === 1, 'the load');
  loads[0].resolve();
  await until(() => !one('uni-approve-cta').disabled, 'Allow enabled');
  one('uni-approve-cta').click();
  await tick();
  w.state.outbox.unshift(other); // another Allow sheet of this page sent one meanwhile
  release(true);
  assert.equal(await result, true, 'it took effect: the swap goes on');
  assert.deepEqual(signed, [], 'no second permission');
  assert.ok(looked.includes(other.hash), 'the one on its way was looked at before signing');
});
