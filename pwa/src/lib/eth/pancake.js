// Buying and selling rsFIRO on BNB Chain: PancakeSwap v3, the rsFIRO/WBNB pool at 1%, the one
// pool there is (every other fee tier and PancakeSwap v2 have none). BNB in, rsFIRO out, or back.
//
// Every address below was checked on chain, read-only (2026-10-12):
//   PancakeV3Factory.getPool(rsFIRO, WBNB, 10000) = POOL (100, 500, 2500: none); the pool's
//   fee() = 10000, token0 = rsFIRO, token1 = WBNB, factory() = FACTORY;
//   QuoterV2.factory() = FACTORY, deployer() = DEPLOYER, WETH9() = WBNB;
//   SmartRouter.factory() = FACTORY, deployer() = DEPLOYER, WETH9() = WBNB.
// QuoterV2 answered 0.1 BNB -> 69.857 rsFIRO and 100 rsFIRO -> 0.140 BNB; the BNB -> rsFIRO call
// built by buildSwap() ran in eth_call from an address holding BNB (nothing sent), and
// eth_estimateGas put it at 183,494 gas.
//
// The swap goes through PancakeSwap's SmartRouter, wrapped in multicall(deadline, ...) so it
// cannot be mined after its time:
//   BNB -> rsFIRO   exactInputSingle(WBNB, rsFIRO, 10000, me, amountIn, minOut, 0), msg.value =
//                   amountIn (the router wraps the BNB itself).
//   rsFIRO -> BNB   approve(SmartRouter, exactly amountIn) first; then exactInputSingle(rsFIRO,
//                   WBNB, 10000, router, amountIn, minOut, 0) + unwrapWETH9(minOut, me).
// The calldata is built, then decoded again and compared field by field before anything is
// signed (buildSwap()), so a mistake here cannot send coins elsewhere.
// No PancakeSwap server is asked: only the person's BNB Chain server.

import { encodeCall, decodeCall, abiDecode, selector, eventTopic } from './abi.js';
import { normAddress } from './crypto.js';
import { bytesToHex, toBytes } from './hex.js';
import { RSFIRO_BSC } from './tokens.js';
import { t } from '../i18n.js';

export const PANCAKE = Object.freeze({
  factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
  deployer: '0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9',
  quoterV2: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
  smartRouter: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
  wbnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  /** rsFIRO/WBNB, 1%: token0 rsFIRO, token1 WBNB. */
  pool: '0x24ebd6f2b918437e0353dbb825bf82832b3cad27',
  fee: 10000,
});

/** "The router itself" (SwapRouter02's ADDRESS_THIS): where the WBNB waits to be unwrapped. */
export const ROUTER_ITSELF = '0x0000000000000000000000000000000000000002';
/** Price protection: 1%, as on Ethereum. */
export const DEFAULT_SLIPPAGE_BIPS = 100;
/** How long a signed swap may wait to be mined. */
export const DEADLINE_SEC = 20 * 60;
/** Gas the swap usually takes, for the estimate before the real one (BNB in: 183,494 measured with eth_estimateGas). */
export const TYPICAL_GAS = Object.freeze({ buy: 190000n, sell: 230000n, approve: 60000n });

const SIG = Object.freeze({
  quote: 'quoteExactInputSingle((address,address,uint256,uint24,uint160))',
  exactInputSingle: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  multicall: 'multicall(uint256,bytes[])',
  unwrap: 'unwrapWETH9(uint256,address)',
  approve: 'approve(address,uint256)',
  allowance: 'allowance(address,address)',
});
export const SELECTORS = Object.freeze(Object.fromEntries(Object.entries(SIG).map(([k, v]) => [k, bytesToHex(selector(v))])));
const WITHDRAWAL_TOPIC = eventTopic('Withdrawal(address,uint256)');
const TRANSFER_TOPIC = eventTopic('Transfer(address,address,uint256)');

export class PancakeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'amount' | 'quote' | 'mismatch'
  }
}

/** 'buy': BNB -> rsFIRO; 'sell': rsFIRO -> BNB. */
function sides(side) {
  if (side === 'buy') return { tokenIn: PANCAKE.wbnb, tokenOut: RSFIRO_BSC.address, decimalsIn: 18, decimalsOut: 8 };
  if (side === 'sell') return { tokenIn: RSFIRO_BSC.address, tokenOut: PANCAKE.wbnb, decimalsIn: 8, decimalsOut: 18 };
  throw new PancakeError('amount', t('Swap BNB for rsFIRO, or rsFIRO for BNB.'));
}

/** amountOut less the price protection (rounded down): the least the swap may give. */
export function minOut(amountOut, slippageBips = DEFAULT_SLIPPAGE_BIPS) {
  return (BigInt(amountOut) * BigInt(10000 - slippageBips)) / 10000n;
}

/**
 * What `amountIn` buys now: {side, amountIn, amountOut, gasEstimate, priceImpact, block}.
 * priceImpact: how much worse than the pool's current price (after its 1% fee), 0..1.
 */
export async function quoteSwap(rpc, { side, amountIn }) {
  const s = sides(side);
  if (typeof amountIn !== 'bigint' || amountIn <= 0n) throw new PancakeError('amount', t('Enter an amount to swap.'));
  const [q, slot0, block] = await Promise.all([
    rpc.ethCall({ to: PANCAKE.quoterV2, data: encodeCall(SIG.quote, [[s.tokenIn, s.tokenOut, amountIn, PANCAKE.fee, 0n]]) }),
    rpc.ethCall({ to: PANCAKE.pool, data: selector('slot0()') }),
    rpc.blockNumber(),
  ]);
  if (q.length < 128) throw new PancakeError('quote', t('PancakeSwap gave no price.'));
  const [amountOut, , , gasEstimate] = abiDecode('uint256,uint160,uint32,uint256', q.subarray(0, 128));
  if (amountOut <= 0n) throw new PancakeError('quote', t('The pool has nothing to give for that amount.'));
  const sqrtPriceX96 = abiDecode('uint160', slot0.subarray(0, 32))[0];
  return { side, amountIn, amountOut, gasEstimate, priceImpact: priceImpact({ side, amountIn, amountOut, sqrtPriceX96 }), block };
}

/** 1 - (what the swap gives) / (what the pool's price less its fee would give). */
export function priceImpact({ side, amountIn, amountOut, sqrtPriceX96 }) {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const wbnbPerRs = r * r; // raw token1 (WBNB) per raw token0 (rsFIRO)
  if (!(wbnbPerRs > 0)) return null;
  const ideal = (side === 'buy' ? Number(amountIn) / wbnbPerRs : Number(amountIn) * wbnbPerRs) * (1 - PANCAKE.fee / 1e6);
  if (!(ideal > 0)) return null;
  return Math.max(0, 1 - Number(amountOut) / ideal);
}

/** {to, data, value} of the swap, for `recipient` (this wallet's address). */
export function buildSwap({ side, amountIn, minAmountOut, recipient, deadline }) {
  const s = sides(side);
  const me = normAddress(recipient);
  if (typeof amountIn !== 'bigint' || amountIn <= 0n || typeof minAmountOut !== 'bigint' || minAmountOut <= 0n) throw new PancakeError('amount', t('The swap has no amount.'));
  const inner =
    side === 'buy'
      ? [encodeCall(SIG.exactInputSingle, [[s.tokenIn, s.tokenOut, PANCAKE.fee, me, amountIn, minAmountOut, 0n]])]
      : [encodeCall(SIG.exactInputSingle, [[s.tokenIn, s.tokenOut, PANCAKE.fee, ROUTER_ITSELF, amountIn, minAmountOut, 0n]]), encodeCall(SIG.unwrap, [minAmountOut, me])];
  const tx = { to: PANCAKE.smartRouter, data: bytesToHex(encodeCall(SIG.multicall, [BigInt(deadline), inner])), value: side === 'buy' ? amountIn : 0n };
  // Decoded again and compared: what is signed is exactly what was asked for.
  const back = readSwap(tx);
  if (back.side !== side || back.amountIn !== amountIn || back.minAmountOut !== minAmountOut || back.recipient !== me || back.deadline !== BigInt(deadline)) throw new PancakeError('mismatch', t('The swap could not be built as asked. Nothing was signed.'));
  return tx;
}

/** What a swap transaction built by buildSwap() does: {side, amountIn, minAmountOut, recipient, deadline}; throws for anything else. */
export function readSwap(tx) {
  if (normAddress(tx.to) !== PANCAKE.smartRouter) throw new PancakeError('mismatch', t('Not a PancakeSwap SmartRouter call.'));
  const [deadline, calls] = decodeCall(SIG.multicall, tx.data);
  const first = decodeCall(SIG.exactInputSingle, calls[0])[0];
  const [tokenIn, tokenOut, fee, to, amountIn, minAmountOut, limit] = first;
  const pair = `${tokenIn.toLowerCase()}>${tokenOut.toLowerCase()}`;
  if (Number(fee) !== PANCAKE.fee || limit !== 0n) throw new PancakeError('mismatch', t('Not the rsFIRO/WBNB 1% pool.'));
  if (pair === `${PANCAKE.wbnb}>${RSFIRO_BSC.address}`) {
    if (calls.length !== 1 || BigInt(tx.value) !== amountIn) throw new PancakeError('mismatch', t('A BNB -> rsFIRO swap pays exactly its amount in BNB.'));
    return { side: 'buy', amountIn, minAmountOut, recipient: to.toLowerCase(), deadline };
  }
  if (pair === `${RSFIRO_BSC.address}>${PANCAKE.wbnb}`) {
    if (calls.length !== 2 || BigInt(tx.value) !== 0n || to.toLowerCase() !== ROUTER_ITSELF) throw new PancakeError('mismatch', t('An rsFIRO -> BNB swap unwraps its WBNB to the wallet.'));
    const [unwrapMin, recipient] = decodeCall(SIG.unwrap, calls[1]);
    if (unwrapMin !== minAmountOut) throw new PancakeError('mismatch', t('The unwrap does not match the swap.'));
    return { side: 'sell', amountIn, minAmountOut, recipient: recipient.toLowerCase(), deadline };
  }
  throw new PancakeError('mismatch', t('Not an rsFIRO swap.'));
}

/** rsFIRO the SmartRouter may move for `owner` now (or at `block`, a number: a server without that block refuses). */
export async function routerAllowance(rpc, owner, block = 'latest') {
  const r = await rpc.ethCall({ to: RSFIRO_BSC.address, data: encodeCall(SIG.allowance, [owner, PANCAKE.smartRouter]) }, block);
  return abiDecode('uint256', r.subarray(0, 32))[0];
}

/** {to, data, value} letting the SmartRouter move exactly `amount` rsFIRO (never "unlimited"). */
export function approveTx(amount) {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new PancakeError('amount', t('Approve a positive amount.'));
  return { to: RSFIRO_BSC.address, data: bytesToHex(encodeCall(SIG.approve, [PANCAKE.smartRouter, amount])), value: 0n };
}

/**
 * What arrived, from the receipt: rsFIRO Transfer logs to `owner` (buy), or WBNB unwrapped by
 * the router for it (sell: the Withdrawal event). null when the receipt does not say.
 */
export function receivedFromReceipt(receipt, owner, side) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const me = owner.toLowerCase();
  let sum = 0n;
  let seen = false;
  for (const l of receipt.logs) {
    if (l.removed) continue;
    const topics = (l.topics || []).map((item) => String(item).toLowerCase());
    const addr = String(l.address).toLowerCase();
    const data = toBytes(l.data);
    if (side === 'buy' && addr === RSFIRO_BSC.address && topics[0] === TRANSFER_TOPIC && topics[2] && `0x${topics[2].slice(26)}` === me && data.length >= 32) {
      sum += abiDecode('uint256', data.subarray(0, 32))[0];
      seen = true;
    }
    if (side === 'sell' && addr === PANCAKE.wbnb && topics[0] === WITHDRAWAL_TOPIC && topics[1] && `0x${topics[1].slice(26)}` === PANCAKE.smartRouter && data.length >= 32) {
      sum += abiDecode('uint256', data.subarray(0, 32))[0];
      seen = true;
    }
  }
  return seen ? sum : null;
}
