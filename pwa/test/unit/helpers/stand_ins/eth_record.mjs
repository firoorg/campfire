// lib/eth/record.js for a screen test: whether this wallet has an Ethereum & BNB side (globalThis.__hasEth, default yes).
export const hasEthWallet = async () => globalThis.__hasEth !== false;
