// Every Ethereum and BNB Chain host the app may contact, and nothing else: the one list
// the RPC client, Settings, the server screens and the CSP in tools/headers.mjs read. Ethereum's
// first entry is Stack Wallet's server (the desktop app's default node, and its history index), the
// others are public servers checked from a browser's point of view (below); plus CoinGecko's price
// endpoint (lib/price_host.js, FIRO's price in lib/fiat.js).
//
// Hosts are written without their scheme and joined in originOf(): the
// "no source file reaches out to another origin" check in
// test/unit/config.test.mjs flags literal URLs outside the files it lists,
// and this file joins that list together with the CSP change, so that both
// change in one reviewed step.
//
// Who sees what. The person picks one server per chain (Settings -> Ethereum & BNB -> its server
// screen), and only that one is asked about their address: it sees the IP address together with
// the address, each time a balance is read or a payment sent. There is no silent fallback between
// servers. Three things go elsewhere, each said on the privacy screen:
//   - a swap's price is checked again on a second listed server before its review
//     (second_opinion.js): eth_calls of the quoters that carry no address, so it sees the IP only;
//   - only for a transaction of this wallet stuck "Not sure yet" (its nonce said used, nothing
//     shown), the account's transaction count and that transaction's hash go to the first other
//     listed server that answers, to settle it (send.js closeIfNonceGone, release re-audit R-1):
//     that server then sees the address with the IP. Not with the person's own server on that
//     chain: then no other listed server is asked to settle it (wallet.js otherRpcs);
//   - the server screen checks every listed server of a chain when it opens (newest block, a
//     recent payment's receipt, one eth_call): each sees the IP, never the address.
// Nothing is ever sent through a second server.
//
// The person's own server (lib/evm_server_address.js) is not in these lists: its origin is added
// to the page's policy by the service worker, after the worker checked it (sw.js "set-evm-server").
// It replaces the listed server of its own chain only: the address is the same on both chains, so
// the other chain's server still sees it unless the person adds their own there too. While their own
// Ethereum server is in use, Stack Wallet's history index (below) is not asked (wallet.js evmPrefs).
//
// Stack Wallet's server also keeps an index of each address's history
// (GET /export, the desktop app's lib/services/ethereum/ethereum_api.dart).
// The desktop app always asks it, whichever RPC is picked; the PWA asks it
// only while Settings -> Ethereum & BNB -> "History from Stack Wallet" is on.

const SCHEME = 'https:';

// Measured 2026-10-14 from a probe that behaves like a page at pwa.buyfiro.app (CORS
// preflight and response, eth_chainId, head lag, eth_getTransactionReceipt of a recent
// transaction, eth_call, eth_estimateGas, eth_feeHistory, a batch): every server listed passed all
// of it. Left out for failing some of it: Ethereum - llamarpc, cloudflare-eth, flashbots and 1rpc
// (eth_call fails), merkle, payload, grove and nodies (no CORS preflight), blockpi and ankr (need a
// key), meowrpc, omniatech, onfinality, tatum, lava, therpc; BNB Chain - bsc-rpc.publicnode.com
// (every receipt refused: "Archive requests require a personal token"), bsc.drpc.org (rate-limited).

/**
 * logs: whether eth_getLogs over 5,000 blocks (a token's Transfer events) answered when this list
 * was measured (2026-10-14; at 1,000 and 10,000 blocks too, see each line). Not a promise, and no
 * code relies on it: getLogsChunked() copes with refusals.
 * chain: the chain the server serves (lib/eth/chains.js); a server is only ever
 * asked about its own chain (EthRpc checks eth_chainId before signing).
 * path: the request path when the server has one (1RPC); connect-src then names that exact path.
 */
export const ETH_RPC_HOSTS = Object.freeze(
  [
    { id: 'stackwallet', name: 'Stack Wallet', host: 'eth2.stackwallet.com', logs: true }, // 1k, 5k, 10k
    { id: 'publicnode', name: 'PublicNode', host: 'ethereum-rpc.publicnode.com', logs: true }, // 1k, 5k, 10k
    { id: 'drpc', name: 'dRPC', host: 'eth.drpc.org', logs: false }, // "not supported on free plan"
    { id: 'mevblocker', name: 'MEV Blocker', host: 'rpc.mevblocker.io', logs: true }, // 1k, 5k, 10k
    { id: 'blast', name: 'Blast', host: 'eth-mainnet.public.blastapi.io', logs: false }, // 10 blocks at most
    { id: 'tenderly', name: 'Tenderly', host: 'mainnet.gateway.tenderly.co', logs: true }, // 1k, 5k, 10k
    { id: 'blockrazor', name: 'BlockRazor', host: 'eth.blockrazor.xyz', logs: false }, // 25 blocks at most
  ].map((h) => Object.freeze({ ...h, chain: 'ethereum' })),
);

/**
 * BNB Chain's public servers, measured as above. BNB Chain's official one is the default: PublicNode,
 * the default before 2026-10-14, answers every receipt with "Archive requests require a personal
 * token" (even for a transaction 3 blocks old), so a payment could never be seen confirmed there; it
 * is left out, and whoever had picked it is moved to the default and told once
 * (lib/eth/server_notes.js). Stack Wallet runs no BNB Chain server.
 */
export const BSC_RPC_HOSTS = Object.freeze(
  [
    { id: 'bsc-bnbchain', name: 'BNB Chain (official)', host: 'bsc-dataseed.bnbchain.org', logs: false }, // "limit exceeded" from 1k
    { id: 'bsc-nodereal', name: 'NodeReal', host: 'bsc.nodereal.io', logs: false }, // "limit exceeded" from 1k
    { id: 'bsc-defibit', name: 'Defibit', host: 'bsc-dataseed1.defibit.io', logs: false }, // "limit exceeded" from 1k
    { id: 'bsc-ninicoin', name: 'Ninicoin', host: 'bsc-dataseed1.ninicoin.io', logs: false }, // "limit exceeded" from 1k
    { id: 'bsc-1rpc', name: '1RPC', host: '1rpc.io', path: '/bnb', logs: false }, // 50 blocks at most
    { id: 'bsc-blast', name: 'Blast', host: 'bsc-mainnet.public.blastapi.io', logs: false }, // rate-limited when asked
    { id: 'bsc-bloxroute', name: 'bloXroute', host: 'bsc.rpc.blxrbdn.com', logs: true }, // 1k, 5k; not 10k (5,000 at most)
    { id: 'bsc-blockrazor', name: 'BlockRazor', host: 'bsc.blockrazor.xyz', logs: false }, // 25 blocks at most
  ].map((h) => Object.freeze({ ...h, chain: 'bsc' })),
);

/** Every server the app may ask, per chain. */
export const RPC_HOSTS = Object.freeze({ ethereum: ETH_RPC_HOSTS, bsc: BSC_RPC_HOSTS });

/** The desktop app's default, and the PWA's. */
export const DEFAULT_ETH_RPC = 'stackwallet';
// BNB Chain's official server (PublicNode's refuses receipts since 2026-10: see BSC_RPC_HOSTS).
export const DEFAULT_BSC_RPC = 'bsc-bnbchain';
export const DEFAULT_RPC = Object.freeze({ ethereum: DEFAULT_ETH_RPC, bsc: DEFAULT_BSC_RPC });
/** The preference each chain's choice is kept under: a listed id, or CUSTOM_RPC. */
export const RPC_PREF = Object.freeze({ ethereum: EVM_SERVER_PREFS.ethereum.pick, bsc: EVM_SERVER_PREFS.bsc.pick });
/** The preference the person's own server's address is kept under, per chain (lib/evm_server_address.js). */
export const RPC_URL_PREF = Object.freeze({ ethereum: EVM_SERVER_PREFS.ethereum.url, bsc: EVM_SERVER_PREFS.bsc.url });
/** RPC_PREF's value while the person's own server is in use. */
export const CUSTOM_RPC = EVM_OWN;

const ALL_HOSTS = Object.freeze([...ETH_RPC_HOSTS, ...BSC_RPC_HOSTS]);

/** CoinGecko's simple/price, asked only after the person allows prices. */
export { PRICE_HOST } from '../price_host.js';
import { PRICE_HOST } from '../price_host.js';
import { chainOf } from './chains.js';
import { normalizeEvmServer, EVM_SERVER_PREFS, EVM_OWN } from '../evm_server_address.js';

export function originOf(entry) {
  return `${SCHEME}//${entry.host}`;
}

/** Where a listed server answers: its origin, and its path when it has one. */
const endpointOf = (entry) => `${originOf(entry)}${entry.path || ''}`;

/** The servers of `chainKey` ('ethereum' | 'bsc'). */
export function rpcHostsFor(chainKey) {
  const list = RPC_HOSTS[chainOf(chainKey).key];
  return list;
}

/** Whether `entry` is one of the listed servers (not the person's own). */
export const isListed = (entry) => ALL_HOSTS.includes(entry);

/** The RPC entry for `id`, on any chain; throws for anything not in the lists. */
export function ethRpcHost(id) {
  const h = ALL_HOSTS.find((x) => x.id === id);
  if (!h) throw new Error(`Unknown server: ${id}`);
  return h;
}

/**
 * The URL JSON-RPC requests go to. Only a listed host, or the person's own server as
 * ownServerEntry() made it (its address checked by lib/evm_server_address.js), can produce one.
 */
export function rpcUrl(entry) {
  if (ALL_HOSTS.includes(entry)) return endpointOf(entry);
  if (OWN_ENTRIES.has(entry)) return entry.url;
  throw new Error('Not one of the listed servers.');
}

const OWN_ENTRIES = new WeakSet();
const OWN_BY_URL = new Map(); // "chain url" -> the entry, so one address keeps one entry (and one client)

/**
 * The person's own server for `chainKey`, as an entry the RPC client takes (id CUSTOM_RPC,
 * custom: true, named by its host), or null when `address` is not one (lib/evm_server_address.js
 * refuses it). Its requests reach it only once the page's policy names its origin (sw.js
 * "set-evm-server").
 */
export function ownServerEntry(chainKey, address) {
  const n = normalizeEvmServer(address);
  if (!n.ok) return null;
  const chain = chainOf(chainKey).key;
  const key = `${chain} ${n.url}`;
  if (OWN_BY_URL.has(key)) return OWN_BY_URL.get(key);
  const name = n.port ? `${n.host}:${n.port}` : n.host;
  const e = Object.freeze({ id: CUSTOM_RPC, name, host: n.host, url: n.url, origin: n.origin, local: n.local, chain, custom: true, logs: null });
  OWN_ENTRIES.add(e);
  OWN_BY_URL.set(key, e);
  return e;
}

/** The simple/price URL for CoinGecko ids, priced in USD. */
export function priceUrl(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => !/^[a-z0-9-]+$/.test(i))) throw new Error('bad price ids');
  return `${originOf(PRICE_HOST)}${PRICE_HOST.path}?ids=${ids.join(',')}&vs_currencies=usd`;
}

/**
 * Where an Ethereum address's history is indexed: Stack Wallet's own server (the
 * desktop app's EthereumAPI.stackBaseServer, the same host as its default node).
 * BNB Chain has no such index here.
 */
export const HISTORY_HOST = ETH_RPC_HOSTS[0];

/**
 * GET /export: the transactions to and from `address` (firstBlock onwards), or
 * with `emitter` the logs that token contract emitted about the address.
 * `address` and `emitter` must already be checked 0x addresses.
 */
export function historyUrl(address, { firstBlock = 0, emitter = null } = {}) {
  const hex = /^0x[0-9a-fA-F]{40}$/;
  if (!hex.test(address) || (emitter && !hex.test(emitter)) || !Number.isSafeInteger(firstBlock) || firstBlock < 0) throw new Error('bad history query');
  const q = emitter ? `addrs=${address.toLowerCase()}&emitter=${emitter.toLowerCase()}&logs=true` : `addrs=${address.toLowerCase()}&firstBlock=${firstBlock}&unripe=true`;
  return `${originOf(HISTORY_HOST)}/export?${q}`;
}

/**
 * The block explorer the person may open with a tap to see a transaction.
 * Never fetched by the app (it is not in connect-src): a link only.
 */
export const TX_EXPLORER = Object.freeze({ id: 'etherscan', name: 'Etherscan', host: 'etherscan.io' });

/** The explorer page of transaction `hash` on `chainKey` (Etherscan, BscScan). */
export function txExplorerUrl(hash, chainKey = 'ethereum') {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('not a transaction hash');
  return `${SCHEME}//${chainOf(chainKey).explorer.host}/tx/${hash.toLowerCase()}`;
}

/**
 * What `connect-src` must list for these hosts: every chain's listed servers (a server with a path,
 * that exact path), and the price entry's exact path. Never the person's own server: the service
 * worker adds that one (sw.js, lib/evm_server_address.js cspWithEvmServers).
 */
export function connectSources() {
  return [...ALL_HOSTS.map(endpointOf), `${originOf(PRICE_HOST)}${PRICE_HOST.path}`];
}
