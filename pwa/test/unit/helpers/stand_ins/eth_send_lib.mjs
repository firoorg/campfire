// lib/eth/send.js for a screen test: preparing takes as long as globalThis.__eth.prepareMs, signing
// as long as signMs; every preparation and signature is recorded in globalThis.__eth. A contract
// call's preparation reverts from preparation number revertFrom on, and needs gasNow gas when set.
export class SendError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const ETH_TRANSFER_GAS = 21000n;
const eth = () => (globalThis.__eth ||= { prepares: 0, signed: [], prepareMs: 0, signMs: 0 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function recipientProblem(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim()) ? null : { code: 'empty', message: 'Paste the 0x… address.' };
}

export async function prepareSend(_rpc, args) {
  eth().prepares++;
  await sleep(eth().prepareMs);
  return { ...args, tx: { gasLimit: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }, fees: { likely: 1n, upTo: 2n }, preparedAt: Date.now() };
}

export const costRose = () => false;

export async function signAndSend(_app, _rpc, prepared) {
  eth().signed.push(prepared);
  await sleep(eth().signMs);
  return { entry: { hash: `0x${String(eth().signed.length).repeat(64).slice(0, 64)}` }, sent: true };
}

// Contract calls (a swap, a permission), as the swap screens use them.
export async function prepareCall(_rpc, { to, data = '0x', value = 0n }) {
  eth().prepares++;
  await sleep(eth().prepareMs);
  if (eth().revertFrom != null && eth().prepares >= eth().revertFrom) throw new SendError('would_fail', 'BNB Chain says this would fail. Nothing was sent.');
  return { tx: { to, value, data, gasLimit: 200000n, maxFeePerGas: 3n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }, gas: eth().gasNow ?? 160000n, fees: { likely: 10n ** 14n, upTo: 6n * 10n ** 14n } };
}

export async function signAndBroadcastCall(_app, _rpc, tx, meta) {
  eth().signed.push({ tx, meta });
  await sleep(eth().signMs);
  return { entry: { hash: `0x${String(eth().signed.length).repeat(64).slice(0, 64)}`, kind: meta.kind, state: 'pending' }, sent: true };
}

export const followOnce = async (_app, _rpc, e) => e;
// A permission on its way, by the chain's word, while the test says so (globalThis.__onItsWay).
export const approvalOnItsWay = async () => globalThis.__onItsWay === true;
export const approvalPass = async () => ({ kind: 'waiting' });
