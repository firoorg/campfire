// The Uniswap library (lib/eth/uniswap/) for the app's Ethereum wallet: one
// UniswapService per server, with the shipped pool list and a search cursor
// kept in the app's store (pool lists are public chain data); and the one way
// a swap or an approval leaves this device, the way a payment does
// (lib/eth/send.js): signed inside withEthKey (chain id 1 checked again, the
// nonce from 'pending', the key zeroed), saved to the sealed outbox BEFORE it
// is broadcast, then broadcast. The Permit2 signature is made the same way,
// only after the person confirmed the review.

import { withEthKey } from './vault.js';
import { signPermitSingle } from './tx.js';
import { signAndBroadcastCall } from './send.js';
import { ADDRESSES } from './uniswap/constants.js';
import { walletPermissionFloor } from './permission.js';
import { ETH, TOKENS, RSFIRO } from './tokens.js';
import { UniswapService } from './uniswap/service.js';
import { loadKnownPools, UniswapDiscovery } from './uniswap/discovery.js';
import { UniswapQuoter } from './uniswap/quoter.js';
import { secondOpinion } from './second_opinion.js';
import { CHAINS } from './chains.js';
import { ETH_TOKEN, uniTokenOf } from './uniswap/models.js';
import { store } from '../store.js';

/** ETH and the tokens the wallet knows, as the swap screen offers them. */
export const SWAP_TOKENS = Object.freeze([ETH_TOKEN, ...TOKENS.map(uniTokenOf)]);
/** rsFIRO, FIRO on Ethereum: what the swap offers to receive first (ETH is what is paid). */
export const RSFIRO_TOKEN = SWAP_TOKENS.find((t) => t.address === RSFIRO.address);
export const DEFAULT_RECEIVE = RSFIRO_TOKEN;

/** The tokens.js entry of a UniToken (for balances and badges). */
export function walletAsset(token) {
  return token.isEth ? ETH : TOKENS.find((t) => t.address === token.address) || null;
}

const STORE_PREFIX = 'uniswap-scan:';

/** Where discovery keeps how far each pool search got. */
export const poolStore = Object.freeze({
  read: (key) => store.get(`${STORE_PREFIX}${key}`),
  write: (key, scan) => store.set(`${STORE_PREFIX}${key}`, scan),
});

let known = null;
const services = new Map(); // server id -> UniswapService

function knownPools() {
  if (!known) known = loadKnownPools().catch((e) => {
    known = null;
    throw e;
  });
  return known;
}

/** The Uniswap service for the wallet's chosen server (one per server, so pool rankings are kept between screens). */
export async function uniswapFor(w) {
  const rpc = w.rpc;
  const id = rpc.host.id;
  const hit = services.get(id);
  if (hit && hit.rpc === rpc) return hit;
  // Every rsFIRO pool is in the shipped list (discovery.js), so its searches start at the list's block.
  const svc = new UniswapService({ rpc, known: await knownPools(), store: poolStore, fullyListed: [RSFIRO.address] });
  services.set(id, svc);
  return svc;
}

/** The amount out of `quote`'s route (the same pools, the same shares) as priced on `rpc`. */
export function routeOutOn(rpc, quote, known) {
  return new UniswapQuoter({ rpc, discovery: new UniswapDiscovery({ rpc, known, fullyListed: [RSFIRO.address] }) })
    .requote(quote)
    .then((q) => q.amountOut);
}

/**
 * The reviewed quote's route priced again on another listed Ethereum server (lib/eth/second_opinion.js):
 * only eth_calls of the pools and quoters, nothing about the wallet. Resolves to secondOpinion()'s
 * {status, host, mine, theirs, gap}. makeRpc: for tests.
 */
export async function secondQuote(w, quote, { makeRpc = null } = {}) {
  const known = await knownPools();
  return secondOpinion({ chainKey: 'ethereum', chosenId: w.rpc.host.id, mine: quote.amountOut, quoteOn: (rpc) => routeOutOn(rpc, quote, known), ...(makeRpc ? { makeRpc } : {}) });
}

/** The Permit2 permit signed with the wallet's key: 65 bytes r ‖ s ‖ v. */
export function permitSigner(app, w) {
  return (permit) => withEthKey(app, ({ sk }) => signPermitSingle(permit, sk, CHAINS.ethereum.chainId), w.kv);
}

/**
 * Signs an unsigned transaction from the service, saves it to the outbox, and
 * broadcasts it (lib/eth/send.js signAndBroadcastCall, on Ethereum). meta: {kind: 'swap' |
 * 'approve' | 'approveReset', asset (tokens.js entry of what leaves), amount (bigint), extra
 * (fields kept with the entry)}. Returns broadcast()'s {entry, sent, error}.
 */
export async function signAndBroadcast(app, w, tx, meta) {
  const r = await signAndBroadcastCall(app, w.rpc, tx, meta, { ethId: w.ethId, kv: w.kv });
  await w.reloadOutbox().catch(() => {});
  return r;
}

/**
 * What permission this swap needs now: the one decision (lib/eth/permission.js, through
 * UniswapService.approvalFor), read at one block no older than the one that confirmed (or showed in
 * effect) this wallet's newest permission for that token and Permit2. Every Allow path asks this: the
 * first check behind Swap, the Allow sheet as it opens, after an earlier permission settled, and
 * before every retry. Throws "couldn't check" (a lagging or silent server): nothing is offered then.
 */
export async function approvalNeeded(w, quote, { service = uniswapFor, tries, waitMs } = {}) {
  const svc = await service(w);
  const minBlock = walletPermissionFloor(w, 'ethereum', quote.tokenIn.address, ADDRESSES.permit2);
  return svc.approvalFor(quote, w.state.address, { minBlock, tries, waitMs });
}
