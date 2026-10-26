// lib/buy/wiring.js for a screen test: the buys controller is the one the test puts in
// globalThis.__buyController; no buy has reached this wallet yet.
export const buyFiro = () => globalThis.__buyController;
export const receivedInWallet = () => false;
