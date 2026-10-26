// Uniswap on Ethereum mainnet: the contracts the swap talks to, and the
// numbers their calls use. Ported from the Dart Uniswap library of the
// Campfire fork this web wallet grew out of (uniswap_constants.dart);
// test/unit/uniswap_constants.test.mjs checks what can be checked offline
// (topics and selectors are the keccak of their signatures).
//
// Addresses are lowercase. Every one is from Uniswap's
// deployment pages and was checked on chain: SwapRouter02's factory(),
// factoryV2() and WETH9() and QuoterV2's factory() name the factories and
// WETH, StateView's poolManager() names the PoolManager. The command and
// action numbers are from Universal Router 2.0.0 (Commands.sol) and the
// v4-periphery it pins (Actions.sol, ActionConstants.sol).

export const ETH_CHAIN_ID = 1;

export const ADDRESSES = Object.freeze({
  /** Wrapped ether: what v2 and v3 pools hold instead of ETH. */
  weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  v2Factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
  v3Factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
  v3QuoterV2: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e',
  v4PoolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
  v4Quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
  v4StateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  /** Universal Router 2.0: swaps on v2, v3 and v4 in one transaction. */
  universalRouter: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af',
  /** Permit2: the one contract a token is approved to; the router then takes exactly what was signed for. */
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
  /** Multicall3: many read-only calls in one request. */
  multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
  /** What v4 and the router call native ETH. */
  nativeEth: '0x0000000000000000000000000000000000000000',
});

export const NATIVE_ETH = ADDRESSES.nativeEth;
export const WETH = ADDRESSES.weth;

/** Blocks before which a factory has no pools (its deployment block). */
export const DEPLOY_BLOCKS = Object.freeze({
  v2Factory: 10000835,
  v3Factory: 12369621,
  v4PoolManager: 21688329,
});

/** Event topics (keccak256 of the event signature). */
export const TOPICS = Object.freeze({
  /** UniswapV2Factory PairCreated(address indexed token0, address indexed token1, address pair, uint256). */
  v2PairCreated: '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
  /** UniswapV3Factory PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool). */
  v3PoolCreated: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  /** PoolManager Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick). */
  v4Initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  /** ERC-20 Transfer(address indexed from, address indexed to, uint256 value). */
  erc20Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
});

/**
 * The fee tiers the v3 factory has enabled (fee in hundredths of a bip →
 * tick spacing). Used only when the server will not search events.
 */
export const V3_FEE_TICK_SPACING = Object.freeze([
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
]);

/**
 * v4 pools without hooks that are commonly created, tried when the server
 * will not search the PoolManager's events. The event search finds the rest.
 */
export const V4_PROBE_KEYS = Object.freeze(
  [
    { fee: 100, tickSpacing: 1 },
    { fee: 500, tickSpacing: 10 },
    { fee: 3000, tickSpacing: 60 },
    { fee: 10000, tickSpacing: 200 },
    { fee: 9000, tickSpacing: 90 },
    { fee: 10000, tickSpacing: 100 },
  ].map((k) => Object.freeze(k)),
);

/** v4 fees with this bit set are set by the pool's hook on every swap. */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;

/** Universal Router commands (Commands.sol). */
export const UR_COMMAND = Object.freeze({
  v3SwapExactIn: 0x00,
  permit2TransferFrom: 0x02,
  sweep: 0x04,
  v2SwapExactIn: 0x08,
  permit2Permit: 0x0a,
  wrapEth: 0x0b,
  unwrapWeth: 0x0c,
  v4Swap: 0x10,
});

/** v4 router actions (Actions.sol). */
export const V4_ACTION = Object.freeze({
  swapExactInSingle: 0x06,
  settle: 0x0b,
  settleAll: 0x0c,
  take: 0x0e,
  takeAll: 0x0f,
});

/** Special values the router understands (ActionConstants.sol). */
export const UR_CONSTANTS = Object.freeze({
  /** "Whoever called execute". */
  msgSender: '0x0000000000000000000000000000000000000001',
  /** "The router itself" (holds coins between two pools). */
  addressThis: '0x0000000000000000000000000000000000000002',
  /** "Everything the router holds of this token." */
  contractBalance: 1n << 255n,
  /** "Whatever this swap owes or is owed" inside v4. */
  openDelta: 0n,
});

/**
 * The tokens the swap may route through (two-pool routes): ETH and the tokens the wallet knows
 * (lib/eth/tokens.js). The shipped pool list (known_pools.json) holds every pool between two of them.
 */
export const ROUTE_BASES = Object.freeze([
  NATIVE_ETH,
  WETH,
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
]);
