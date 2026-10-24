// The Uniswap swap, end to end, for one Ethereum wallet. A port of the
// desktop app's lib/wallets/ethereum/uniswap/uniswap_service.dart:
//
//   quote → approvalFor (approve the token to Permit2 for exactly the
//   amount, if needed) → reviewSwap (price again, refuse if it moved past the
//   price protection, measure the gas) → finalizeSwap (sign the Permit2
//   permit through the caller, build the router call, simulate it) → the
//   caller signs and sends → waitForReceipt (what arrived).
//
// Everything goes through the person's chosen server (an EthRpc, injected).
// Nothing here holds a key: transactions come back unsigned, and the one
// signature the swap itself needs, the Permit2 permit, is asked of the
// caller's signPermit(permit), which signs inside withEthKey(). The price
// protection choices and the price-impact thresholds are the desktop app's
// (uniswap_swap_view.dart).

import { encodeCall, abiDecode, selector } from '../abi.js';
import { normAddress } from '../crypto.js';
import { bytesToHex, bytesToBigInt, toBytes } from '../hex.js';
import { EthRpcError, walletFees, gasWithHeadroom, isRevert } from '../rpc.js';
import { ADDRESSES, NATIVE_ETH, WETH, TOPICS, ETH_CHAIN_ID } from './constants.js';
import { ETH_TOKEN, UniToken, UniV4Pool, topicOfAddress } from './models.js';
import { UniswapDiscovery } from './discovery.js';
import { UniswapQuoter } from './quoter.js';
import { buildPlan, needsPermit } from './planner.js';
import { tokenAllowance, permitAllowance, allowanceCovers, buildPermitSingle, checkPermitSignature, approvePermit2Call } from './permit2.js';
import { decidePermission, headNotBefore } from '../permission.js';
import { t } from '../../i18n.js';

/**
 * Whether approve(Permit2, amount) from `owner` goes through at `block` (an eth_call): false only when
 * the token reverts it (USDT over a non-zero allowance). Any other answer, a numbered one included (a
 * server's 429 "too many requests"), throws: "couldn't check", never "the token refuses".
 */
export async function approveGoesThrough(rpc, { owner, token, amount, block = 'latest' }) {
  try {
    await rpc.ethCall({ from: owner, to: token, data: approvePermit2Call(amount) }, block);
    return true;
  } catch (e) {
    if (isRevert(e)) return false;
    throw e;
  }
}

export { gasWithHeadroom };

/** "Price protection" choices in basis points (0.5 %, 1 %, 3 %, 5 %); 1 % unless the person picks another. */
export const SLIPPAGE_CHOICES = Object.freeze([50, 100, 300, 500]);
export const DEFAULT_SLIPPAGE = 100;
/** From this price impact the review warns. */
export const IMPACT_WARNING = 0.03;
/** From this price impact the person must tick a box before the swap is built. */
export const IMPACT_BLOCK = 0.1;
/** A swap must be mined within this long of being built, or the router refuses it. */
export const DEADLINE_SECONDS = 20 * 60;
/** The Permit2 signature is good for this long. */
export const PERMIT_LIFE_SECONDS = 30 * 60;
/** Gas a Permit2 permit adds to the swap (signature check and the allowance it stores), with room to spare. */
export const PERMIT_GAS = 80000n;
/** An approve whose gas could not be measured (USDT's second step, before its reset is mined). */
export const APPROVE_FALLBACK_GAS = 70000n;
/** How often and how long waitForReceipt asks. */
export const RECEIPT_POLL_MS = 4000;
export const RECEIPT_LIMIT_MS = 10 * 60 * 1000;

/** The price moved more than the protection between the quote and the review; `fresh` is the new price. */
export class UniPriceMoved extends Error {
  constructor(moved, fresh) {
    super(t('The price moved {n} %.', { n: (moved * 100).toFixed(2) }));
    this.code = 'price_moved';
    this.moved = moved;
    this.fresh = fresh;
  }
}

/** The built swap needs more gas than the review showed: show the new numbers instead of sending. */
export class UniGasChanged extends Error {
  constructor(gasLimit) {
    super(t('The network fee changed.'));
    this.code = 'gas_changed';
    this.gasLimit = gasLimit;
  }
}

/** The route that was priced would not trade (a v4 pool whose hook quotes one price and swaps another); `quote` is the best price without it. */
export class UniRouteChanged extends Error {
  constructor(quote) {
    super(t('The route changed.'));
    this.code = 'route_changed';
    this.quote = quote;
  }
}

/** Something the person must choose or confirm first (price protection, a high price impact). */
export class UniSwapRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 'none' below 3 %, 'warn' from 3 %, 'block' from 10 % (an unknown impact counts as none, as on the desktop). */
export function impactLevel(priceImpact) {
  const i = priceImpact ?? 0;
  if (i >= IMPACT_BLOCK) return 'block';
  if (i >= IMPACT_WARNING) return 'warn';
  return 'none';
}

export function checkSlippage(bips) {
  if (!SLIPPAGE_CHOICES.includes(bips)) throw new UniSwapRefused('slippage', t('Choose a price protection of 0.5 %, 1 %, 3 % or 5 %.'));
  return bips;
}

/** A transaction ready to sign: tx.js signTransaction({...tx, nonce}, sk). */
function unsignedTx({ kind, to, data, value, gasLimit, fees }) {
  return Object.freeze({
    kind,
    chainId: BigInt(ETH_CHAIN_ID),
    to,
    data: bytesToHex(toBytes(data)),
    value,
    gasLimit,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    /** The most it can cost (limit × max fee). */
    maxGasCost: gasLimit * fees.maxFeePerGas,
    /** What it will most likely cost; the real cost uses the gas actually burnt, usually less. */
    expectedGasCost: gasLimit * (fees.baseFee + fees.maxPriorityFeePerGas),
  });
}

/** A `string` return value (or a bytes32 one, as old tokens like MKR return), or null. */
function decodeString(r) {
  if (!r.success || r.data.length === 0) return null;
  if (r.data.length >= 64) {
    try {
      const s = String(abiDecode('string', r.data)[0]).trim();
      return s || null;
    } catch {
      // Not an ABI string; maybe bytes32.
    }
  }
  if (r.data.length === 32) {
    const end = r.data.indexOf(0);
    const s = new TextDecoder().decode(end < 0 ? r.data : r.data.subarray(0, end)).trim();
    return s || null;
  }
  return null;
}

export class UniswapService {
  /**
   * rpc: EthRpc. known: parseKnownPools(known_pools.json) (or pass a
   * discovery). store: where discovery keeps its search cursor. fullyListed:
   * tokens whose every pool is in `known` (discovery.js). now: () => ms,
   * sleep: (ms) => Promise (tests).
   */
  constructor({ rpc, known = null, store, discovery = null, quoter = null, fullyListed = [], now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.rpc = rpc;
    this.discovery = discovery ?? new UniswapDiscovery({ rpc, known, fullyListed, ...(store ? { store } : {}) });
    this.quoter = quoter ?? new UniswapQuoter({ rpc, discovery: this.discovery, now });
    this._nowMs = now;
    this._sleep = sleep;
  }

  /** Unix seconds. */
  get now() {
    return Math.floor(this._nowMs() / 1000);
  }

  // ---------------------------------------------------------------- price

  /**
   * The best price. With `owner` and ETH paid, a route through a v4 pool with
   * a hook is only chosen after its real swap was simulated from the wallet.
   */
  quote({ tokenIn, tokenOut, amountIn, owner = null }) {
    // Read alongside the pools. Without it the price is still right; only how
    // many routes are worth their gas is guessed.
    const gasPrice = this.fees()
      .then((f) => f.baseFee + f.maxPriorityFeePerGas)
      .catch(() => null);
    return this.quoter.bestQuote({ tokenIn, tokenOut, amountIn, gasPrice, simulate: owner && tokenIn.isEth ? (q) => this.simulates(q, owner) : null });
  }

  /**
   * Whether the router transaction for q goes through when owner sends it
   * now (an eth_call; nothing is signed or sent) → true / false, or null
   * when it cannot tell. Paying with ETH only: a token would need its
   * approval in place first.
   */
  async simulates(q, owner) {
    try {
      // Without the ETH, the call fails for that reason, not the pool's.
      if ((await this.balanceOf(ETH_TOKEN, owner)) < q.amountIn) return null;
    } catch {
      return null;
    }
    const plan = buildPlan({ quote: q, slippageBips: DEFAULT_SLIPPAGE, deadline: BigInt(this.now + DEADLINE_SECONDS) });
    return this._callWorks({ from: owner, to: plan.to, data: plan.calldata, value: plan.value });
  }

  /** The exact transaction as an eth_call from `from` → true (it goes through), false (it reverts), null (the server did not say). */
  async simulateTx(tx, from) {
    return this._callWorks({ from, to: tx.to, data: tx.data, value: tx.value });
  }

  async _callWorks({ from, to, data, value }) {
    try {
      await this.rpc.ethCall({ from, to, data, value });
      return true;
    } catch (e) {
      // "execution reverted" is the contract's answer; anything else is the server's.
      return isRevert(e) ? false : null;
    }
  }

  /** The quote's route would not go through: if it uses hooked v4 pools, they are left out from now on and the best other price is returned; else null. */
  async _rerouteAround(quote, owner) {
    const hooked = quote.pools.filter((p) => p instanceof UniV4Pool && p.hasHooks).map((p) => p.id);
    if (!hooked.length) return null;
    for (const id of hooked) this.quoter.distrusted.add(id);
    return this.quote({ tokenIn: quote.tokenIn, tokenOut: quote.tokenOut, amountIn: quote.amountIn, owner });
  }

  /** EIP-1559 fees from the server's own fee history (rpc.js walletFees). */
  fees() {
    return walletFees(this.rpc);
  }

  // ------------------------------------------------------------- approval

  /**
   * Whether paying `quote` needs an approval transaction first →
   * {kind: 'none' | 'approve' | 'resetThenApprove', token, amount, current}.
   * Tokens like USDT refuse to change an allowance that is not zero; for
   * those it is set to zero first, then to the amount.
   */
  async approvalFor(quote, owner, { minBlock = 0, tries, waitMs } = {}) {
    const token = quote.tokenIn;
    if (token.isEth) return { kind: 'none', token, amount: quote.amountIn, current: 0n, block: null };
    // The one decision (lib/eth/permission.js): the allowance and USDT's "from non-zero?" probe read
    // at one block, no older than `minBlock` (the newest permission's); a throw is "couldn't check".
    const rpc = this.rpc;
    const d = await decidePermission(rpc, {
      minBlock,
      tries,
      waitMs,
      need: quote.amountIn,
      allowance: (b) => tokenAllowance(rpc, token.address, owner, b),
      probe: (b) => approveGoesThrough(rpc, { owner, token: token.address, amount: quote.amountIn, block: b }),
    });
    return { kind: d.kind, token, amount: quote.amountIn, current: d.current, block: d.block };
  }

  /**
   * approve(Permit2, amount), unsigned (amount 0 for the reset step). A transaction whose gas estimate
   * reverts is never built (the token would refuse it, and its fee be spent), but for the approve
   * that follows a reset: estimated before the reset is mined, it reverts as it must, and gets
   * APPROVE_FALLBACK_GAS (afterReset); one that estimates is measured over the old allowance, cheaper
   * than from zero, so it gets at least the fallback. A server's other errors throw.
   */
  async approvalTx({ token, amount, owner, fees = null, afterReset = false }) {
    const data = approvePermit2Call(amount);
    const f = fees ?? (await this.fees());
    let gas;
    try {
      gas = await this.rpc.estimateGas({ from: owner, to: token.address, data });
      if (afterReset && gas < APPROVE_FALLBACK_GAS) gas = APPROVE_FALLBACK_GAS;
    } catch (e) {
      if (!afterReset || !isRevert(e)) throw e;
      gas = APPROVE_FALLBACK_GAS;
    }
    return unsignedTx({ kind: amount === 0n ? 'approveReset' : 'approve', to: token.address, data, value: 0n, gasLimit: gasWithHeadroom(gas), fees: f });
  }

  /**
   * The transactions an approval needs, in the order they must be mined (the reset first). Empty for
   * 'none'. An approve over a non-zero allowance whose estimate reverts is a token that refuses a
   * change from non-zero (USDT): it becomes a reset to 0, then the approve (release audit 0.1.5).
   * Only a revert: a server's other numbered errors (BlockRazor's 429 on a burst) throw.
   */
  async approvalTxs(approval, owner, { fees = null } = {}) {
    if (approval.kind === 'none') return [];
    const f = fees ?? (await this.fees());
    const both = async () => [await this.approvalTx({ token: approval.token, amount: 0n, owner, fees: f }), await this.approvalTx({ token: approval.token, amount: approval.amount, owner, fees: f, afterReset: true })];
    if (approval.kind === 'resetThenApprove') return both();
    try {
      return [await this.approvalTx({ token: approval.token, amount: approval.amount, owner, fees: f })];
    } catch (e) {
      if (isRevert(e) && (approval.current ?? 0n) > 0n) return both();
      throw e;
    }
  }

  // ----------------------------------------------------------------- swap

  /**
   * Everything the review shows, without signing anything: prices the route
   * again, refuses (UniPriceMoved) if the price moved more than
   * slippageBips against `quote`, and measures the gas. When the router will
   * need a Permit2 signature, the gas is the quoters' estimate plus the
   * permit's cost (the real measure needs the signature: finalizeSwap).
   */
  async reviewSwap({ quote, slippageBips = DEFAULT_SLIPPAGE, owner, fees = null, permitMinBlock = 0 }) {
    checkSlippage(slippageBips);
    const fresh = await this.quoter.requote(quote);
    const moved = fresh.amountOut >= quote.amountOut ? 0 : Number(quote.amountOut - fresh.amountOut) / Number(quote.amountOut);
    if (moved * 10000 > slippageBips) throw new UniPriceMoved(moved, fresh);

    let permitNeeded = false;
    if (needsPermit(fresh)) {
      // At a block no older than this wallet's last swap or permission of that token: a backend
      // behind it would show an allowance already used (release audit 0.1.6, S2).
      const at = await headNotBefore(this.rpc, permitMinBlock || 0);
      const allowance = await permitAllowance(this.rpc, fresh.tokenIn.address, owner, undefined, at);
      permitNeeded = !allowanceCovers(allowance, fresh.amountIn, this.now);
    }
    const minimumOut = fresh.minimumOut(slippageBips);
    const deadline = BigInt(this.now + DEADLINE_SECONDS);
    const f = fees ?? (await this.fees());
    let gas;
    if (permitNeeded) {
      gas = fresh.gasEstimate + PERMIT_GAS;
    } else {
      const plan = buildPlan({ quote: fresh, slippageBips, deadline });
      try {
        gas = await this.rpc.estimateGas({ from: owner, to: plan.to, data: plan.calldata, value: plan.value });
      } catch (e) {
        // Only the route's own refusal looks for another; a server's trouble is said as it is.
        if (!isRevert(e)) throw e;
        const other = await this._rerouteAround(fresh, owner);
        if (!other) throw e;
        throw new UniRouteChanged(other);
      }
    }
    const gasLimit = gasWithHeadroom(gas);
    return Object.freeze({
      quote: fresh,
      owner: normAddress(owner),
      slippageBips,
      minimumOut,
      deadline,
      needsPermit: permitNeeded,
      gasLimit,
      fees: f,
      priceMoved: moved,
      impact: impactLevel(fresh.priceImpact),
      maxGasCost: gasLimit * f.maxFeePerGas,
      expectedGasCost: gasLimit * (f.baseFee + f.maxPriorityFeePerGas),
    });
  }

  /**
   * After the person confirmed `review`: has the Permit2 permit signed if one
   * is needed (signPermit(permit) → 65 bytes r ‖ s ‖ v, inside the caller's
   * withEthKey), builds the router call with the reviewed minimum and
   * deadline, simulates the exact transaction (eth_call and
   * eth_estimateGas), and checks its gas fits the limit the person saw (else
   * UniGasChanged: show the review again). A price impact from 10 % needs
   * acceptImpact. Returns the unsigned transaction; nothing is sent.
   */
  async finalizeSwap({ review, signPermit = null, acceptImpact = false, permitMinBlock = 0 }) {
    const q = review.quote;
    const owner = review.owner;
    if (review.impact === 'block' && !acceptImpact) throw new UniSwapRefused('impact', t('This swap moves the price by 10 % or more; confirm it first.'));
    if (typeof this.rpc.assertMainnet === 'function') await this.rpc.assertMainnet();
    let permit = null;
    if (review.needsPermit) {
      if (typeof signPermit !== 'function') throw new UniSwapRefused('permit', t('This swap needs a Permit2 signature.'));
      // Permit2's number at a block no older than this wallet's last swap of that token: an older one
      // signs a permit the router refuses, and the swap's fee is lost (release audit 0.1.6, S2).
      const at = await headNotBefore(this.rpc, permitMinBlock || 0);
      const allowance = await permitAllowance(this.rpc, q.tokenIn.address, owner, undefined, at);
      const p = buildPermitSingle({ token: q.tokenIn.address, amount: q.amountIn, nonce: allowance.nonce, now: this.now, life: PERMIT_LIFE_SECONDS });
      permit = { permit: p, signature: checkPermitSignature(p, await signPermit(p), owner) };
    }
    const plan = buildPlan({ quote: q, slippageBips: review.slippageBips, deadline: review.deadline, permit });
    const call = { from: owner, to: plan.to, data: plan.calldata, value: plan.value };
    let gas;
    try {
      await this.rpc.ethCall(call);
      gas = await this.rpc.estimateGas(call);
    } catch (e) {
      if (!isRevert(e)) throw e;
      const other = await this._rerouteAround(q, owner);
      if (!other) throw e;
      throw new UniRouteChanged(other);
    }
    if (gas > review.gasLimit) throw new UniGasChanged(gasWithHeadroom(gas));
    return Object.freeze({
      quote: q,
      plan,
      tx: unsignedTx({ kind: 'swap', to: plan.to, data: plan.calldata, value: plan.value, gasLimit: review.gasLimit, fees: review.fees }),
      minimumOut: plan.minimumOut,
      slippageBips: review.slippageBips,
      priceMoved: review.priceMoved,
      permitSigned: permit !== null,
      gasEstimate: gas,
    });
  }

  // -------------------------------------------------------------- receipt

  /**
   * How a mined transaction ended → {hash, success, blockNumber, gasUsed,
   * effectiveGasPrice, gasCost, received}. received: for a token, the sum of
   * its Transfer logs to owner in the receipt; for ETH, owner's balance
   * change over the block plus the gas it paid; null when it could not be
   * read (or the swap failed).
   */
  async readReceipt(receipt, { owner = null, tokenOut = null } = {}) {
    const gasCost = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    let received = null;
    if (receipt.status === 1 && owner && tokenOut) {
      if (!tokenOut.isEth) received = receivedFromLogs(receipt, owner, tokenOut.address);
      else {
        try {
          const before = await this.rpc.getBalance(owner, receipt.blockNumber - 1);
          const after = await this.rpc.getBalance(owner, receipt.blockNumber);
          received = after - before + gasCost;
        } catch {
          received = null;
        }
      }
    }
    return Object.freeze({
      hash: receipt.transactionHash,
      success: receipt.status === 1,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice ?? 0n,
      gasCost,
      received,
    });
  }

  /** Waits for `hash` to be mined (asking every `every` ms, up to `limit`). Null if it was not mined in time (it may still be). */
  async waitForReceipt(hash, { owner = null, tokenOut = null, every = RECEIPT_POLL_MS, limit = RECEIPT_LIMIT_MS } = {}) {
    const end = this._nowMs() + limit;
    for (;;) {
      const r = await this.rpc.getTransactionReceipt(hash);
      if (r && r.blockNumber !== null && r.blockNumber !== undefined) return this.readReceipt(r, { owner, tokenOut });
      if (this._nowMs() >= end) return null;
      await this._sleep(every);
    }
  }

  // --------------------------------------------------------------- tokens

  /** Balance of `token` held by owner. */
  async balanceOf(token, owner) {
    if (token.isEth) return this.rpc.getBalance(owner);
    const r = await this.rpc.ethCall({ to: token.address, data: encodeCall('balanceOf(address)', [normAddress(owner)]) });
    return abiDecode('uint256', r)[0];
  }

  /** Symbol, decimals and name of ERC-20 `addresses` (one request); a token that does not answer is left out. */
  async tokenInfo(addresses) {
    const list = addresses.map(normAddress);
    const calls = list.flatMap((a) => [
      { to: a, data: selector('symbol()') },
      { to: a, data: selector('decimals()') },
      { to: a, data: selector('name()') },
    ]);
    const r = calls.length ? await this.rpc.multicall(calls, { chunk: 150 }) : [];
    const out = [];
    list.forEach((address, i) => {
      const symbol = decodeString(r[i * 3]);
      const dec = r[i * 3 + 1];
      if (symbol === null || !dec.success || dec.data.length < 32) return;
      const decimals = bytesToBigInt(dec.data.subarray(0, 32));
      if (decimals > 36n) return;
      out.push(new UniToken({ address, symbol, decimals: Number(decimals), name: decodeString(r[i * 3 + 2]) }));
    });
    return out;
  }

  /** Tokens with a live Uniswap pool against `token` (every version); WETH is reported as ETH. */
  async partnersOf(token) {
    const pools = [];
    for (const c of token.poolCurrencies) pools.push(...(await this.discovery.poolsOf(c)));
    const states = await this.discovery.liveState(pools);
    const mine = new Set(token.poolCurrencies);
    const partners = new Set();
    for (const p of pools) {
      if (!(states.get(p.id)?.isLive ?? false)) continue;
      const other = mine.has(p.currency0) ? p.currency1 : p.currency0;
      partners.add(other === WETH ? NATIVE_ETH : other);
    }
    for (const m of mine) partners.delete(m);
    return [...partners];
  }
}

/** The sum of `token`'s Transfer logs to `owner` in a receipt (rpc.js getTransactionReceipt form). */
export function receivedFromLogs(receipt, owner, token) {
  const me = topicOfAddress(owner);
  const item = normAddress(token);
  let sum = 0n;
  for (const l of receipt.logs) {
    if (l.removed || l.address !== item || l.topics.length !== 3 || l.topics[0] !== TOPICS.erc20Transfer || l.topics[2] !== me) continue;
    if (l.data.length !== 32) continue;
    sum += bytesToBigInt(l.data);
  }
  return sum;
}
