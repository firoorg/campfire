// lib/eth/short_now.js for a screen test: nothing is short; what can be spent now is the wallet's own figure.
export const shortNow = async () => null;
export const freeNow = async (w, chainKey) => w.spendable(chainKey);
