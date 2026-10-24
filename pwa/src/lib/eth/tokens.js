// The EVM assets the wallet knows by address, per chain (lib/eth/chains.js): rsFIRO (FIRO on
// Ethereum and on BNB Chain, carried there by the Rosen bridge), and the well-known stablecoins
// and wrapped bitcoin. Anyone can deploy a token called "USDT" or "FIRO"; only these addresses
// are shown as the real thing. (A legacy BEP-20 "FIRO" on BNB Chain, 0xd5d0…3aed, is NOT
// rsFIRO; no list has it.)
//
// Every address, symbol and decimals value here was read on chain with eth_call (2026-10-12):
// rsFIRO is 8 decimals on both chains (21,400,000 minted: FIRO's supply cap); USDT and USDC are
// 6 decimals on Ethereum but 18 on BNB Chain.
//
// Addresses are lowercase; show them with toChecksumAddress() from crypto.js. coingecko: the
// CoinGecko id, for a value in the person's currency once prices are allowed (the same
// simple/price path lib/fiat.js asks for FIRO, id "zcoin").
//
// TODO(rsFIRO <-> FIRO): bringing rsFIRO home as private FIRO goes through the Rosen bridge
// (lib/rosen/, its own stream) using lib/eth/send_raw.js for the EVM side.
import { t, tk } from '../i18n.js';

const native = (chain, symbol, name, coingecko) => Object.freeze({ address: null, symbol, name, decimals: 18, coingecko, chain });

/** The native coins: what pays each chain's network fees. */
export const ETH = native('ethereum', 'ETH', tk('Ether'), 'ethereum');
export const BNB = native('bsc', 'BNB', 'BNB', 'binancecoin');

const token = (chain, item) => Object.freeze({ ...item, chain });

/** rsFIRO on Ethereum. */
export const RSFIRO = token('ethereum', { address: '0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2', symbol: 'rsFIRO', name: 'rsFIRO', decimals: 8, coingecko: 'rsfiro', firo: true });
/** rsFIRO on BNB Chain. */
export const RSFIRO_BSC = token('bsc', { address: '0x13cdb5f7f398f6af2cc3b34eb04476af3488853f', symbol: 'rsFIRO', name: 'rsFIRO', decimals: 8, coingecko: 'rsfiro', firo: true });

/** Ethereum's tokens. */
export const TOKENS = Object.freeze([
  RSFIRO,
  token('ethereum', { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', name: 'Tether', decimals: 6, coingecko: 'tether' }),
  token('ethereum', { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin', decimals: 6, coingecko: 'usd-coin' }),
  token('ethereum', { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, coingecko: 'wrapped-bitcoin' }),
  token('ethereum', { address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', name: 'Dai', decimals: 18, coingecko: 'dai' }),
]);

/** BNB Chain's tokens. */
export const BSC_TOKENS = Object.freeze([
  RSFIRO_BSC,
  token('bsc', { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', name: 'Tether', decimals: 18, coingecko: 'tether' }),
  token('bsc', { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18, coingecko: 'usd-coin' }),
]);

const BY_CHAIN = Object.freeze({ ethereum: Object.freeze({ native: ETH, tokens: TOKENS }), bsc: Object.freeze({ native: BNB, tokens: BSC_TOKENS }) });

/** Every token on every chain. */
export const ALL_TOKENS = Object.freeze([...TOKENS, ...BSC_TOKENS]);

/** The tokens of `chainKey`. */
export function tokensFor(chainKey = 'ethereum') {
  const c = BY_CHAIN[chainKey];
  if (!c) throw new Error(t('Not a chain this wallet holds coins on: {chainKey}', { chainKey }));
  return c.tokens;
}

/** The native coin of `chainKey` (ETH, BNB). */
export function nativeFor(chainKey = 'ethereum') {
  const c = BY_CHAIN[chainKey];
  if (!c) throw new Error(t('Not a chain this wallet holds coins on: {chainKey}', { chainKey }));
  return c.native;
}

/** rsFIRO on `chainKey`. */
export function rsfiroOn(chainKey = 'ethereum') {
  return tokensFor(chainKey).find((item) => item.firo) || null;
}

/** Whether `asset` is a chain's native coin. */
export const isNative = (asset) => Boolean(asset) && asset.address == null;

/** The known token at `address` (any case) on `chainKey`, or null. */
export function tokenByAddress(address, chainKey = 'ethereum') {
  if (typeof address !== 'string') return null;
  const a = address.toLowerCase();
  return tokensFor(chainKey).find((token) => token.address === a) || null;
}

/** The native coin or the token called `symbol` on `chainKey`, or null. */
export function tokenBySymbol(symbol, chainKey = 'ethereum') {
  const n = nativeFor(chainKey);
  return symbol === n.symbol ? n : tokensFor(chainKey).find((token) => token.symbol === symbol) || null;
}
