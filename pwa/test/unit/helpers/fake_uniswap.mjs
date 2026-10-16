// A pretend Ethereum with Uniswap on it, for the offline Uniswap tests: it
// answers the contract calls the quoter, discovery and service make
// (factories, StateView, the v3 and v4 quoters, pairs, ERC-20s, Permit2,
// the router) from constant-product pools held in memory, and keeps count of
// what it was asked. Prices follow v2's formula with each pool's own fee, so
// a test can work out what any swap should give.
import { abiDecode, abiEncode, selectorHex } from '../../../src/lib/eth/abi.js';
import { EthRpcError } from '../../../src/lib/eth/rpc.js';
import { bytesToHex, toBytes } from '../../../src/lib/eth/hex.js';
import { ADDRESSES, NATIVE_ETH, TOPICS } from '../../../src/lib/eth/uniswap/constants.js';
import { UniV4Pool, topicOfAddress } from '../../../src/lib/eth/uniswap/models.js';

const SEL = (sig) => selectorHex(sig);
const S = {
  getReserves: SEL('getReserves()'),
  slot0: SEL('slot0()'),
  liquidity: SEL('liquidity()'),
  getSlot0: SEL('getSlot0(bytes32)'),
  getLiquidity: SEL('getLiquidity(bytes32)'),
  getPair: SEL('getPair(address,address)'),
  getPool: SEL('getPool(address,address,uint24)'),
  v3Quote: SEL('quoteExactInputSingle((address,address,uint256,uint24,uint160))'),
  v4Quote: SEL('quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))'),
  allowance2: SEL('allowance(address,address)'),
  allowance3: SEL('allowance(address,address,address)'),
  approve: SEL('approve(address,uint256)'),
  balanceOf: SEL('balanceOf(address)'),
  symbol: SEL('symbol()'),
  decimals: SEL('decimals()'),
  name: SEL('name()'),
  execute: SEL('execute(bytes,bytes[],uint256)'),
};

export const revert = (why = 'execution reverted') => new EthRpcError(3, why);

function isqrt(n) {
  if (n <= 1n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** What a constant-product pool with `feePpm` gives for amountIn. */
export function cpOut(amountIn, rIn, rOut, feePpm) {
  const inAfterFee = (amountIn * BigInt(1000000 - feePpm)) / 1000000n;
  return (inAfterFee * rOut) / (rIn + inAfterFee);
}

const lower = (a) => String(a).toLowerCase();

export class FakeChain {
  constructor({ head = 26200000, now = () => 1791555000000 } = {}) {
    this.head = head;
    this.v2 = new Map();
    this.v3 = new Map();
    this.v4 = new Map();
    this.logs = [];
    this.tokens = new Map();
    this.ethBalances = new Map();
    this.permits = new Map();
    this.asked = { multicall: 0, getLogs: 0, ethCall: 0, estimateGas: 0, blockNumber: 0, calls: 0 };
    /** (call) => void or throw: what the router does with an execute call. */
    this.router = () => {};
    /** (call) => gas or throw. */
    this.gasOf = () => 210000n;
    /** How the server treats eth_getLogs: maxRange (it refuses wider windows with a message naming it), or 'missing' / 'busyOnce' / 'tiny'. */
    this.logPolicy = { maxRange: 10000 };
    this.baseFee = 20000000000n;
    this.tip = 1000000000n;
    this.receipts = new Map();
    this._now = now;
    this.rpc = this._makeRpc();
  }

  token(address, { symbol = 'TKN', decimals = 18, name = null, usdtStyle = false, bytes32Symbol = false } = {}) {
    const t = { address: lower(address), symbol, decimals, name: name ?? symbol, usdtStyle, bytes32Symbol, balances: new Map(), allowances: new Map() };
    this.tokens.set(t.address, t);
    return t;
  }

  addV2({ pair, c0, c1, r0, r1, block = 1 }) {
    const p = { pair: lower(pair), c0: lower(c0), c1: lower(c1), r0, r1 };
    this.v2.set(p.pair, p);
    this.logs.push({ address: ADDRESSES.v2Factory, topics: [TOPICS.v2PairCreated, topicOfAddress(p.c0), topicOfAddress(p.c1)], data: abiEncode('address,uint256', [p.pair, 1n]), blockNumber: block, removed: false });
    return p;
  }

  addV3({ pool, c0, c1, fee, ts, r0, r1, block = 1 }) {
    const p = { pool: lower(pool), c0: lower(c0), c1: lower(c1), fee, ts, r0, r1 };
    this.v3.set(p.pool, p);
    this.logs.push({ address: ADDRESSES.v3Factory, topics: [TOPICS.v3PoolCreated, topicOfAddress(p.c0), topicOfAddress(p.c1), bytesToHex(abiEncode('uint24', [fee]))], data: abiEncode('int24,address', [ts, p.pool]), blockNumber: block, removed: false });
    return p;
  }

  /** bonusBips: what a lying hook adds to its quotes (its real swap reverts). */
  addV4({ c0, c1, fee, ts, hooks = NATIVE_ETH, r0, r1, lpFee = null, bonusBips = 0, block = 1 }) {
    const pool = new UniV4Pool({ currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks });
    const p = { pool, r0, r1, lpFee: lpFee ?? (pool.fee ?? 3000), bonusBips };
    this.v4.set(pool.id, p);
    this.logs.push({ address: ADDRESSES.v4PoolManager, topics: [TOPICS.v4Initialize, pool.id, topicOfAddress(pool.currency0), topicOfAddress(pool.currency1)], data: abiEncode('uint24,int24,address,uint160,int24', [fee, ts, pool.hooks, 1n << 96n, 0n]), blockNumber: block, removed: false });
    return p;
  }

  static sqrtPrice(r0, r1) {
    return isqrt((r1 << 192n) / r0);
  }

  /** A v2-formula swap through the pool holding `inC`, changing its reserves (for "the price moved"). */
  trade(poolRef, inC, amountIn) {
    const p = poolRef;
    const zeroForOne = lower(inC) === (p.c0 ?? p.pool.currency0);
    const fee = p.pair ? 3000 : p.fee ?? p.lpFee;
    const [rIn, rOut] = zeroForOne ? [p.r0, p.r1] : [p.r1, p.r0];
    const out = cpOut(amountIn, rIn, rOut, fee);
    if (zeroForOne) {
      p.r0 += amountIn;
      p.r1 -= out;
    } else {
      p.r1 += amountIn;
      p.r0 -= out;
    }
    return out;
  }

  /** One eth_call → bytes, or throws EthRpcError (a revert). */
  call({ to, data, from = null, value = 0n }) {
    this.asked.calls++;
    const t = lower(to);
    const d = toBytes(data);
    const sel = bytesToHex(d.subarray(0, 4));
    const args = d.subarray(4);
    if (this.v2.has(t) && sel === S.getReserves) {
      const p = this.v2.get(t);
      return abiEncode('uint112,uint112,uint32', [p.r0, p.r1, 1]);
    }
    if (this.v3.has(t)) {
      const p = this.v3.get(t);
      if (sel === S.slot0) return abiEncode('uint160,int24,uint16,uint16,uint16,uint8,bool', [FakeChain.sqrtPrice(p.r0, p.r1), 0n, 0, 0, 0, 0, true]);
      if (sel === S.liquidity) return abiEncode('uint128', [isqrt(p.r0 * p.r1)]);
    }
    if (t === ADDRESSES.v4StateView) {
      const [id] = abiDecode('bytes32', args);
      const p = this.v4.get(bytesToHex(id));
      if (sel === S.getSlot0) return p ? abiEncode('uint160,int24,uint24,uint24', [FakeChain.sqrtPrice(p.r0, p.r1), 0n, 0, p.lpFee]) : abiEncode('uint160,int24,uint24,uint24', [0n, 0n, 0, 0]);
      if (sel === S.getLiquidity) return abiEncode('uint128', [p ? isqrt(p.r0 * p.r1) : 0n]);
    }
    if (t === ADDRESSES.v2Factory && sel === S.getPair) {
      const [a, b] = abiDecode('address,address', args).map(lower);
      const p = [...this.v2.values()].find((x) => (x.c0 === a && x.c1 === b) || (x.c0 === b && x.c1 === a));
      return abiEncode('address', [p ? p.pair : NATIVE_ETH]);
    }
    if (t === ADDRESSES.v3Factory && sel === S.getPool) {
      const [a, b, fee] = abiDecode('address,address,uint24', args);
      const p = [...this.v3.values()].find((x) => x.fee === Number(fee) && ((x.c0 === lower(a) && x.c1 === lower(b)) || (x.c0 === lower(b) && x.c1 === lower(a))));
      return abiEncode('address', [p ? p.pool : NATIVE_ETH]);
    }
    if (t === ADDRESSES.v3QuoterV2 && sel === S.v3Quote) {
      const [[tin, tout, amount, fee]] = abiDecode('(address,address,uint256,uint24,uint160)', args);
      const p = [...this.v3.values()].find((x) => x.fee === Number(fee) && new Set([x.c0, x.c1]).has(lower(tin)) && new Set([x.c0, x.c1]).has(lower(tout)));
      if (!p) throw revert();
      const zeroForOne = lower(tin) === p.c0;
      const out = cpOut(amount, zeroForOne ? p.r0 : p.r1, zeroForOne ? p.r1 : p.r0, p.fee);
      return abiEncode('uint256,uint160,uint32,uint256', [out, 0n, 1, 120000n]);
    }
    if (t === ADDRESSES.v4Quoter && sel === S.v4Quote) {
      const [[key, zeroForOne, amount]] = abiDecode('((address,address,uint24,int24,address),bool,uint128,bytes)', args);
      const pool = new UniV4Pool({ currency0: key[0], currency1: key[1], fee: Number(key[2]), tickSpacing: Number(key[3]), hooks: key[4] });
      const p = this.v4.get(pool.id);
      if (!p) throw revert();
      let out = cpOut(amount, zeroForOne ? p.r0 : p.r1, zeroForOne ? p.r1 : p.r0, p.lpFee);
      out = (out * BigInt(10000 + p.bonusBips)) / 10000n;
      return abiEncode('uint256,uint256', [out, 110000n]);
    }
    if (t === ADDRESSES.permit2 && sel === S.allowance3) {
      const [owner, token, spender] = abiDecode('address,address,address', args).map(lower);
      const a = this.permits.get(`${owner}|${token}|${spender}`) ?? { amount: 0n, expiration: 0, nonce: 0 };
      return abiEncode('uint160,uint48,uint48', [a.amount, a.expiration, a.nonce]);
    }
    if (t === ADDRESSES.universalRouter && sel === S.execute) {
      this.router({ to: t, data: d, from, value });
      return new Uint8Array(0);
    }
    const tok = this.tokens.get(t);
    if (tok) {
      if (sel === S.allowance2) {
        const [owner, spender] = abiDecode('address,address', args).map(lower);
        return abiEncode('uint256', [tok.allowances.get(`${owner}|${spender}`) ?? 0n]);
      }
      if (sel === S.approve) {
        const [spender, amount] = abiDecode('address,uint256', args);
        const cur = tok.allowances.get(`${lower(from)}|${lower(spender)}`) ?? 0n;
        if (tok.usdtStyle && cur !== 0n && amount !== 0n) throw revert();
        return abiEncode('bool', [true]);
      }
      if (sel === S.balanceOf) return abiEncode('uint256', [tok.balances.get(lower(abiDecode('address', args)[0])) ?? 0n]);
      if (sel === S.symbol) {
        if (tok.bytes32Symbol) {
          const b = new Uint8Array(32);
          b.set(new TextEncoder().encode(tok.symbol));
          return b;
        }
        return abiEncode('string', [tok.symbol]);
      }
      if (sel === S.decimals) return abiEncode('uint8', [tok.decimals]);
      if (sel === S.name) return abiEncode('string', [tok.name]);
    }
    throw revert();
  }

  _makeRpc() {
    const chain = this;
    return {
      async blockNumber() {
        chain.asked.blockNumber++;
        return chain.head;
      },
      async chainId() {
        return 1n;
      },
      async assertMainnet() {},
      async ethCall(call) {
        chain.asked.ethCall++;
        return chain.call(call);
      },
      async estimateGas(call) {
        chain.asked.estimateGas++;
        chain.call(call);
        return chain.gasOf(call);
      },
      async multicall(calls) {
        chain.asked.multicall++;
        return calls.map((c) => {
          try {
            return { success: true, data: chain.call(c) };
          } catch {
            return { success: false, data: new Uint8Array(0) };
          }
        });
      },
      async getLogs({ address, topics, fromBlock, toBlock }, { maxRange = 10000 } = {}) {
        chain.asked.getLogs++;
        const policy = chain.logPolicy;
        if (toBlock - fromBlock + 1 > maxRange) throw new EthRpcError('range', `A log search covers at most ${maxRange} blocks.`);
        if (policy.missing) throw new EthRpcError(-32601, 'the method eth_getLogs does not exist/is not available');
        if (policy.busyOnce) {
          policy.busyOnce = false;
          throw new EthRpcError('busy', 'busy (too many requests).');
        }
        if (policy.maxRange && toBlock - fromBlock + 1 > policy.maxRange) throw new EthRpcError(-32005, `block range is too wide, max block range ${policy.maxRange}`);
        return chain.logs
          .filter((l) => l.address === lower(address) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
          .filter((l) => topics.every((t, i) => t === null || t === undefined || l.topics[i] === t))
          .map((l) => ({ ...l, data: toBytes(l.data) }));
      },
      async getBalance(address, block = 'latest') {
        const v = chain.ethBalances.get(lower(address)) ?? 0n;
        return typeof v === 'function' ? v(block) : v;
      },
      async getTransactionReceipt(hash) {
        const r = chain.receipts.get(hash);
        return typeof r === 'function' ? r() : (r ?? null);
      },
      async feeHistory() {
        const b = `0x${chain.baseFee.toString(16)}`;
        const t = `0x${chain.tip.toString(16)}`;
        return { baseFeePerGas: [b, b, b, b, b, b], reward: [[t], [t], [t], [t], [t]] };
      },
    };
  }
}
