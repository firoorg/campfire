// NEAR Intents for the unlocked wallet: one 1Click client, its
// coin list (asked once per ten minutes, and only once a NEAR Intents screen
// is open), and the sealed swaps of this wallet's Ethereum wallet. Nothing
// here runs by itself: the screens call it while they are open.

import { OneClickClient, payableTokens } from './oneclick.js';
import { sealedIntentsStore } from './store.js';
import { ethWallet } from '../eth/wallet.js';

const TOKENS_TTL_MS = 10 * 60 * 1000;

let client = null;
let tokens = null; // {at, list} | {at, pending}: every coin 1Click takes

export function intentsClient() {
  if (!client) client = new OneClickClient();
  return client;
}

/**
 * Every coin NEAR Intents takes except the one it delivers (ETH on Ethereum for 'ethereum', BNB on
 * BNB Chain for 'bsc'), in picker order (the list is cached ten minutes).
 */
export async function intentsTokens({ refresh = false, destination = 'ethereum' } = {}) {
  const now = Date.now();
  if (!refresh && tokens && now - tokens.at < TOKENS_TTL_MS) return payableTokens(tokens.list || (await tokens.pending), destination);
  const pending = intentsClient()
    .tokens()
    .then((all) => {
      tokens = { at: Date.now(), list: all };
      return all;
    })
    .catch((e) => {
      tokens = null;
      throw e;
    });
  tokens = { at: now, pending };
  return payableTokens(await pending, destination);
}

/**
 * The open wallet's Ethereum wallet and its NEAR Intents swaps:
 * {w, address, store}; null when the wallet has no Ethereum wallet.
 */
export async function intentsFor(app) {
  const w = await ethWallet(app);
  if (!w) return null;
  return { w, address: w.state.address, store: sealedIntentsStore(app, { ethId: w.ethId }) };
}

/** The swaps still under way or waiting for a deposit, newest first (none when it cannot be read). */
export async function openSwaps(store, now = Date.now()) {
  try {
    return (await store.all()).filter((s) => isLive(s, now));
  } catch {
    return [];
  }
}

/** How long an unpaid swap stays listed after its time ran out: a deposit sent just in time may not be seen yet. */
export const UNPAID_GRACE_MS = 2 * 60 * 60 * 1000;

/** Open, and not an address nobody paid in time (listed a while longer, in case a deposit is on its way). */
export function isLive(s, now = Date.now()) {
  if (!s.isOpen) return false;
  const unpaid = s.lastState == null || s.lastState === 'PENDING_DEPOSIT';
  if (!unpaid) return true;
  const ends = [s.quote.sendBefore != null ? s.quote.sendBefore + UNPAID_GRACE_MS : null, s.quote.deadline].filter((t) => t != null);
  return !ends.length || now <= Math.min(...ends);
}
