// lib/eth/wallet.js for a screen test: the Ethereum & BNB wallet is the one the test puts in
// globalThis.__ethWallet (ethWallet and openWallet both answer it).
export const ethWallet = async () => globalThis.__ethWallet;
export const openWallet = async () => globalThis.__ethWallet;
export const evmPrefs = () => ({});

/** A wallet holding 1 ETH / 1 BNB and nothing else, synced, with nothing on its way. */
export function plainEthWallet(over = {}) {
  const E = 10n ** 18n;
  return {
    ethId: 'e1',
    kv: null,
    state: { address: `0x${'22'.repeat(20)}`, outbox: [], eth: E, tokens: new Map() },
    chain: () => ({ checkedAt: 1, native: E, tokens: new Map(), block: 100, minedNonce: 0 }),
    refresh: async () => {},
    refreshChain: async () => ({}),
    followOpen: async () => {},
    reloadOutbox: async () => [],
    rpcFor: () => ({ host: { id: 'x', name: 'Test server' } }),
    otherRpcs: () => [],
    spendable: () => ({ eth: E }),
    spendableOf: () => E,
    heldOf: () => 0n,
    openSwap: () => null,
    ...over,
  };
}
