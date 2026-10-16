// Turns a quote (one route, or a swap shared between several) into one
// Universal Router execute(commands, inputs, deadline) call. A port of the
// desktop app's lib/wallets/ethereum/uniswap/uniswap_planner.dart, and byte
// for byte the same: test/unit/uniswap_planner.test.mjs checks it against
// calldata the Dart planner wrote for fixed quotes.
//
// The router runs a list of commands. The amount in is made ready first:
// paying with ETH, the part bound for WETH pools is wrapped (the exact
// amount, so the rest stays ETH for v4 pools); paying with a token, the
// signed Permit2 permit lets the router take the whole amount, a share at a
// time. Then each share runs on its own, pool by pool, keeping track of where
// its coins are (still in the wallet, or in the router between two pools)
// and in which form (ETH or WETH):
//
// * a v2 or v3 swap command per v2 or v3 pool;
// * one v4 command per run of v4 pools, inside it: pay the first pool
//   (SETTLE), swap through each pool (SWAP_EXACT_IN_SINGLE with "whatever is
//   owed", so the pools chain), and take the result (TAKE / TAKE_ALL);
// * WRAP_ETH / UNWRAP_WETH where one pool holds ETH and the next WETH.
//
// Each share's last pool carries that share's minimum, checked by the router
// on that pool, and pays the person directly when it gives the token wanted
// in the right form. A share that ends in WETH when ETH is wanted (or the
// other way round) leaves it in the router, which converts it and pays it out
// at the end, checking those shares' minimums once more.
//
// If any pool's price moves past the price protection before the
// transaction is mined, the whole transaction fails and nothing is swapped
// (only the network fee is spent).

import { abiEncode, encodeCall } from '../abi.js';
import { bytesToHex } from '../hex.js';
import { ADDRESSES, NATIVE_ETH, WETH, UR_COMMAND, V4_ACTION, UR_CONSTANTS } from './constants.js';
import { UniV2Pool, UniV3Pool, UniV4Pool, v3Path } from './models.js';
import { permitRouterInput } from './permit2.js';

const EMPTY = new Uint8Array(0);
const V4_SWAP_PARAMS = '((address,address,uint24,int24,address),bool,uint128,uint128,bytes)';

export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.code = 'plan';
  }
}

/** One execute(commands, inputs, deadline) call and the ETH it carries. */
export class UniSwapPlan {
  constructor({ commands, inputs, deadline, value, minimumOut }) {
    this.commands = commands;
    this.inputs = Object.freeze(inputs);
    this.deadline = deadline;
    /** ETH sent with the transaction (the amount in, when paying with ETH). */
    this.value = value;
    /** The least the person receives, checked by the router. */
    this.minimumOut = minimumOut;
    this.to = ADDRESSES.universalRouter;
    Object.freeze(this);
  }

  get calldata() {
    return encodeCall('execute(bytes,bytes[],uint256)', [this.commands, [...this.inputs], this.deadline]);
  }

  get calldataHex() {
    return bytesToHex(this.calldata);
  }
}

/** Whether `quote` takes a token from the wallet (so it needs Permit2). */
export function needsPermit(quote) {
  return !quote.tokenIn.isEth;
}

/**
 * The router call for `quote`, each share paying out at least its quote
 * less slippageBips, before `deadline` (unix seconds, bigint). `permit`
 * ({permit, signature}) is required when the amount in is a token and Permit2
 * does not already allow the router to take it.
 */
export function buildPlan({ quote, slippageBips, deadline, permit = null }) {
  const commands = [];
  const inputs = [];
  const add = (command, input) => {
    commands.push(command);
    inputs.push(input);
  };

  const tokenIn = quote.tokenIn;
  const wanted = quote.tokenOut.address; // native for ETH, else the token
  const parts = quote.parts;
  const total = parts.reduce((s, p) => s + p.amountIn, 0n);
  if (total !== quote.amountIn) throw new PlanError(`shares add up to ${total}, not ${quote.amountIn}`);

  if (permit) add(UR_COMMAND.permit2Permit, permitRouterInput(permit.permit, permit.signature));

  // The amount in, ready for each share's first pool.
  const startingIn = (currency) => parts.filter((p) => p.route.hops[0].currencyIn === currency).reduce((s, p) => s + p.amountIn, 0n);
  if (tokenIn.isEth) {
    const weth = startingIn(WETH);
    if (weth > 0n) add(UR_COMMAND.wrapEth, abiEncode('address,uint256', [UR_CONSTANTS.addressThis, weth]));
  } else if (tokenIn.isWeth) {
    const native = startingIn(NATIVE_ETH);
    if (native > 0n) {
      add(UR_COMMAND.permit2TransferFrom, abiEncode('address,address,uint160', [WETH, UR_CONSTANTS.addressThis, native]));
      add(UR_COMMAND.unwrapWeth, abiEncode('address,uint256', [UR_CONSTANTS.addressThis, native]));
    }
  }

  // Shares whose result waits in the router, per form, with their minimums added up.
  const waiting = new Map();
  const wait = (form, minimum) => waiting.set(form, (waiting.get(form) ?? 0n) + minimum);

  for (const part of parts) {
    const hops = part.route.hops;
    const minimum = part.minimumOut(slippageBips);
    let form = hops[0].currencyIn;
    let holder = tokenIn.isEth || (tokenIn.isWeth && form === NATIVE_ETH) ? 'router' : 'user';
    // The share's own amount for its first pool; after that, whatever the previous pool gave.
    let first = true;

    // Moves the coins into the form the next pool holds (between two pools, so they are in the router).
    const convertTo = (currency) => {
      if (form === currency) return;
      if (form === NATIVE_ETH && currency === WETH) {
        add(UR_COMMAND.wrapEth, abiEncode('address,uint256', [UR_CONSTANTS.addressThis, UR_CONSTANTS.contractBalance]));
      } else if (form === WETH && currency === NATIVE_ETH) {
        add(UR_COMMAND.unwrapWeth, abiEncode('address,uint256', [UR_CONSTANTS.addressThis, 0n]));
      } else {
        throw new PlanError(`cannot turn ${form} into ${currency}`);
      }
      holder = 'router';
      form = currency;
    };

    let i = 0;
    while (i < hops.length) {
      const hop = hops[i];
      convertTo(hop.currencyIn);
      const payerIsUser = holder === 'user';
      const amountIn = first ? part.amountIn : UR_CONSTANTS.contractBalance;
      first = false;

      if (hop.pool instanceof UniV4Pool) {
        // A run of v4 pools that hand over the same currency.
        let j = i;
        while (j + 1 < hops.length && hops[j + 1].pool instanceof UniV4Pool && hops[j + 1].currencyIn === hops[j].currencyOut) j++;
        const last = hops[j];
        const ends = j === hops.length - 1;
        const toUser = ends && last.currencyOut === wanted;
        const actions = [V4_ACTION.settle];
        const params = [abiEncode('address,uint256,bool', [hop.currencyIn, amountIn, payerIsUser])];
        for (let k = i; k <= j; k++) {
          const h = hops[k];
          actions.push(V4_ACTION.swapExactInSingle);
          params.push(abiEncode(V4_SWAP_PARAMS, [[h.pool.key, h.zeroForOne, UR_CONSTANTS.openDelta, ends && k === j ? minimum : 0n, EMPTY]]));
        }
        if (toUser) {
          actions.push(V4_ACTION.takeAll);
          params.push(abiEncode('address,uint256', [last.currencyOut, minimum]));
        } else {
          actions.push(V4_ACTION.take);
          params.push(abiEncode('address,address,uint256', [last.currencyOut, UR_CONSTANTS.addressThis, UR_CONSTANTS.openDelta]));
          holder = 'router';
        }
        add(UR_COMMAND.v4Swap, abiEncode('bytes,bytes[]', [Uint8Array.from(actions), params]));
        form = last.currencyOut;
        if (ends && !toUser) wait(form, minimum);
        i = j + 1;
        continue;
      }

      const ends = i === hops.length - 1;
      const toUser = ends && hop.currencyOut === wanted;
      const recipient = toUser ? UR_CONSTANTS.msgSender : UR_CONSTANTS.addressThis;
      const minOut = ends ? minimum : 0n;
      if (hop.pool instanceof UniV2Pool) {
        add(UR_COMMAND.v2SwapExactIn, abiEncode('address,uint256,uint256,address[],bool', [recipient, amountIn, minOut, [hop.currencyIn, hop.currencyOut], payerIsUser]));
      } else if (hop.pool instanceof UniV3Pool) {
        add(UR_COMMAND.v3SwapExactIn, abiEncode('address,uint256,uint256,bytes,bool', [recipient, amountIn, minOut, v3Path([hop.currencyIn, hop.currencyOut], [hop.pool.fee]), payerIsUser]));
      } else {
        throw new PlanError('unknown pool');
      }
      holder = 'router';
      form = hop.currencyOut;
      if (ends && !toUser) wait(form, minimum);
      i++;
    }
  }

  // What waits in the router, converted and paid out.
  for (const [form, minimum] of waiting) {
    if (wanted === NATIVE_ETH && form === WETH) {
      add(UR_COMMAND.unwrapWeth, abiEncode('address,uint256', [UR_CONSTANTS.msgSender, minimum]));
    } else if (wanted === WETH && form === NATIVE_ETH) {
      add(UR_COMMAND.wrapEth, abiEncode('address,uint256', [UR_CONSTANTS.addressThis, UR_CONSTANTS.contractBalance]));
      add(UR_COMMAND.sweep, abiEncode('address,address,uint256', [wanted, UR_CONSTANTS.msgSender, minimum]));
    } else {
      throw new PlanError(`route ends in ${form}, not ${wanted}`);
    }
  }

  return new UniSwapPlan({
    commands: Uint8Array.from(commands),
    inputs,
    deadline: BigInt(deadline),
    value: tokenIn.isEth ? quote.amountIn : 0n,
    minimumOut: quote.minimumOut(slippageBips),
  });
}
