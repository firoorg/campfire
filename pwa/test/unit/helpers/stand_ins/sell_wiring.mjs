// lib/sell/wiring.js for a screen test: the sells controller is the one the test puts in
// globalThis.__sellController; nothing is paid from elsewhere, every deposit address is payable.
export const sellFiro = () => globalThis.__sellController;
export const paymentInWallet = () => null;
export const mayPay = async () => true;
