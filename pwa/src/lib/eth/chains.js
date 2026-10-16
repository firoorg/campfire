// The EVM chains this wallet holds coins on, in one place: Ethereum and BNB Chain. One key, one
// address on both (m/44'/60'/0'/0/0, as every EVM wallet derives it); each chain has its own
// servers (lib/eth/hosts.js), tokens (lib/eth/tokens.js), fee rule, explorer and swap venue.
// Code that differs per chain reads it from here, never from a chain id typed in a screen.
//
// Every value was checked on chain (2026-10-12, read-only): BNB Chain's eth_chainId is 0x38;
// its blocks carry baseFeePerGas 0 (EIP-1559 rules are on, so type-2 transactions are valid);
// eth_gasPrice and eth_maxPriorityFeePerGas answer 0.05 gwei, the price validators take.
//
// Also: chain names people know, by the chain id the swap services use (NEAR Intents' 1Click,
// lib/intents/oneclick.js): "btc" -> "Bitcoin". A copy of the list the Buy screens keep, so the
// EVM and Intents code does not load the Buy code.

const GWEI = 1000000000n;

export const CHAINS = Object.freeze({
  ethereum: Object.freeze({
    key: 'ethereum',
    chainId: 1,
    name: 'Ethereum',
    short: 'Ethereum',
    native: Object.freeze({ symbol: 'ETH', name: 'Ether', decimals: 18, coingecko: 'ethereum' }),
    explorer: Object.freeze({ name: 'Etherscan', host: 'etherscan.io' }),
    // EIP-1559: base fee from eth_feeHistory, a tip of at least 0.01 gwei.
    fees: '1559',
    minTipWei: GWEI / 100n,
    // The most of a tip a server's word can set (the base fee is the chain's, never the server's):
    // a server that inflates it would otherwise take that much more of every fee (audit P6).
    maxTipWei: 3n * GWEI,
    // Stack Wallet keeps an index of each address's history (lib/eth/history.js).
    history: 'stackwallet',
    // Uniswap (lib/eth/uniswap/): rsFIRO/WETH, 0.3%.
    swap: 'uniswap',
    // What NEAR Intents' 1Click calls this chain's coin (checked against /v0/tokens).
    intentsAsset: 'nep141:eth.omft.near',
    rsfiro: '0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2',
    // Rosen's lock address here: rsFIRO sent to it (with a payload) comes out as FIRO.
    rosenLock: '0x451698faa07fc68301af622a3ad42205f13c6e4b',
    // A transaction counts as final after this many confirmations.
    finality: 3,
  }),
  bsc: Object.freeze({
    key: 'bsc',
    chainId: 56,
    name: 'BNB Chain',
    short: 'BNB Chain',
    native: Object.freeze({ symbol: 'BNB', name: 'BNB', decimals: 18, coingecko: 'binancecoin' }),
    explorer: Object.freeze({ name: 'BscScan', host: 'bscscan.com' }),
    // Base fee 0: the gas price the network asks (eth_gasPrice), at least 0.05 gwei, as both caps.
    fees: 'gasPrice',
    minTipWei: GWEI / 20n,
    // The most of a gas price a server's word can set: all of it is paid here (audit P6).
    maxTipWei: 5n * GWEI,
    // No history index for BNB Chain: only what this device sent is listed.
    history: 'none',
    // PancakeSwap v3 (lib/eth/pancake.js): rsFIRO/WBNB, 1%.
    swap: 'pancake',
    intentsAsset: 'nep245:v2_1.omni.hot.tg:56_11111111111111111111',
    rsfiro: '0x13cdb5f7f398f6af2cc3b34eb04476af3488853f',
    rosenLock: '0x34c9f8a268df15fb38811800cb6e7f6a109cd0e7',
    finality: 20,
  }),
});

/** The chains in the order screens list them. */
export const CHAIN_KEYS = Object.freeze(['ethereum', 'bsc']);

/** The chain the Ethereum wallet started on, and the default everywhere. */
export const ETHEREUM = CHAINS.ethereum;
export const BSC = CHAINS.bsc;

/** A chain by its key ('ethereum' | 'bsc') or its chain id (1 | 56 | 1n | 56n); throws for any other. */
export function chainOf(keyOrId) {
  if (typeof keyOrId === 'string' && Object.hasOwn(CHAINS, keyOrId)) return CHAINS[keyOrId];
  const id = typeof keyOrId === 'bigint' ? Number(keyOrId) : keyOrId;
  const c = CHAIN_KEYS.map((k) => CHAINS[k]).find((x) => x.chainId === id);
  if (!c) throw new Error(`Not a chain this wallet holds coins on: ${String(keyOrId)}`);
  return c;
}

/** Whether `k` is a chain key this wallet knows. */
export const isChainKey = (k) => typeof k === 'string' && Object.hasOwn(CHAINS, k);

/** The chain ids a transaction may be signed for. */
export const SIGNABLE_CHAIN_IDS = Object.freeze(CHAIN_KEYS.map((k) => BigInt(CHAINS[k].chainId)));

/** Chain names people know, by the services' chain id. */
export const CHAIN_NAMES = Object.freeze({
  btc: 'Bitcoin',
  bitcoin: 'Bitcoin',
  zec: 'Zcash',
  ltc: 'Litecoin',
  eth: 'Ethereum',
  sol: 'Solana',
  tron: 'Tron',
  bsc: 'BNB Chain',
  xrp: 'XRP Ledger',
  doge: 'Dogecoin',
  ton: 'TON',
  bch: 'Bitcoin Cash',
  dash: 'Dash',
  cardano: 'Cardano',
  sui: 'Sui',
  avax: 'Avalanche',
  pol: 'Polygon',
  near: 'NEAR',
  arb: 'Arbitrum',
  base: 'Base',
  op: 'Optimism',
  gnosis: 'Gnosis',
  stellar: 'Stellar',
  aptos: 'Aptos',
  bera: 'Berachain',
  starknet: 'Starknet',
  scroll: 'Scroll',
  monad: 'Monad',
  xlayer: 'X Layer',
  movement: 'Movement',
  plasma: 'Plasma',
  aleo: 'Aleo',
  hypercore: 'Hyperliquid',
  abs: 'Abstract',
  fogo: 'Fogo',
});

/** Chains whose addresses are Ethereum's (0x and 40 hex digits). */
export const EVM_CHAINS = Object.freeze(new Set(['eth', 'arb', 'base', 'op', 'bsc', 'pol', 'avax', 'gnosis', 'scroll', 'bera', 'monad', 'xlayer', 'plasma', 'abs']));

export function chainName(blockchain) {
  return Object.hasOwn(CHAIN_NAMES, blockchain) ? CHAIN_NAMES[blockchain] : String(blockchain).toUpperCase();
}
