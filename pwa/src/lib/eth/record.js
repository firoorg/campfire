// Where the Ethereum wallet's records live in the app's own store
// ("campfire-firo-app"), readable without loading any Ethereum code: Home,
// Settings and the delete screen only need to know whether there is one,
// and whether words or a private key bring it back.
// Both records are per Firo wallet (lib/wallet_scope.js WALLET_KEYS), so
// deleting that wallet removes them together with it.

import { store } from '../store.js';

/** The sealed key and what the person wrote down (lib/eth/vault.js). */
export const ETH_RECORD_KEY = 'eth';
/** What this device sent, sealed (lib/eth/outbox.js). */
export const ETH_OUTBOX_KEY = 'eth-outbox';

export async function hasEthWallet(kv = store) {
  return Boolean(await kv.get(ETH_RECORD_KEY));
}

/** What brings an Ethereum wallet back. */
export const ETH_KINDS = Object.freeze(['words', 'key']);

/**
 * 'words' or 'key' for a stored record (records from before private-key
 * import have no kind: they are words), or null for an unknown kind.
 */
export function ethRecordKind(record) {
  if (!record) return null;
  if (record.kind === undefined) return 'words';
  return ETH_KINDS.includes(record.kind) ? record.kind : null;
}

/** The kind of the Ethereum wallet on this device, or null when there is none. */
export async function ethWalletKind(kv = store) {
  return ethRecordKind(await kv.get(ETH_RECORD_KEY));
}
