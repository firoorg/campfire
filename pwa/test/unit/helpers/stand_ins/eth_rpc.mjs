// lib/eth/rpc.js's fee read and words, without a server.
export class EthRpcError extends Error {}
export const walletFees = async () => ({ baseFee: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n, maxFeePerGas: 2n * 10n ** 9n });
export function gasWithHeadroom(e) {
  e = BigInt(e);
  const more = (e * 125n) / 100n;
  return more - e < 20000n ? e + 20000n : more;
}
export const isRevert = () => false;
