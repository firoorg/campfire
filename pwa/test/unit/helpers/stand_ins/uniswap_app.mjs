// lib/eth/uniswap_app.js for a screen test: the service is globalThis.__svc, the permission a swap
// needs is globalThis.__approval (default none), and every signature is recorded in globalThis.__eth.
import { ETH_TOKEN, UniToken } from '../../../../src/lib/eth/uniswap/models.js';

export const RSFIRO_TOKEN = new UniToken({ address: `0x${'11'.repeat(20)}`, symbol: 'rsFIRO', decimals: 8 });
export const SWAP_TOKENS = Object.freeze([ETH_TOKEN, RSFIRO_TOKEN]);
export const DEFAULT_RECEIVE = RSFIRO_TOKEN;
export const uniswapFor = async () => globalThis.__svc;
export const walletAsset = () => null;
export const secondQuote = async () => null;
export const approvalNeeded = async () => globalThis.__approval || { kind: 'none' };
export const permitSigner = () => async () => '0x';
export async function signAndBroadcast(_app, _w, tx, meta) {
  const e = (globalThis.__eth ||= { signed: [] });
  e.signed.push({ tx, meta });
  await new Promise((r) => setTimeout(r, e.signMs || 0));
  return { entry: { hash: `0x${String(e.signed.length).repeat(64).slice(0, 64)}` }, sent: true };
}
