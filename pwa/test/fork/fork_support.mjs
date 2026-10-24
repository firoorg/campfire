// The local anvil mainnet fork the Ethereum tests share with the desktop
// app's fork tests: what answers on 127.0.0.1:8545, the shared lock
// ($TMPDIR/campfire-eth-fork.lock, an fcntl lock held by a small python3
// child, the same lock fork_support.dart takes), and helpers that change the
// fork's state. Every test that changes state takes the lock and puts the
// fork back with evm_snapshot / evm_revert.
import { spawn } from 'node:child_process';
import { EthRpc } from '../../src/lib/eth/rpc.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ANVIL = 'http://127.0.0.1:8545';

/**
 * The block the shared fork starts from, so the suites see the same chain every run (Uniswap's
 * rsFIRO pools change: by 2026-10-12 one pool held all the liquidity and no trade split). Start it
 * with an archive-capable server (publicnode refuses state older than a few minutes):
 *   anvil --fork-url https://eth2.stackwallet.com --fork-block-number 26155400 --port 8545
 */
export const FORK_BLOCK = 26155400;
export const JUNK = 'test test test test test test test test test test test junk';
/**
 * anvil's account 0 (from JUNK): a public test key. On mainnet it (like the
 * other anvil accounts) carries an EIP-7702 delegation set by a sweeper, so
 * ETH sent to it runs code: tests pay to fresh addresses (freshAddress()).
 */
export const ACCOUNT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** A random address nobody holds a key for: no code, no balance, on mainnet or the fork. */
export function freshAddress() {
  const b = new Uint8Array(20);
  globalThis.crypto.getRandomValues(b);
  return `0x${Buffer.from(b).toString('hex')}`;
}

export async function raw(method, params = []) {
  const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Why the fork cannot be used, or null. */
export async function anvilProblem() {
  try {
    if ((await raw('eth_chainId')) !== '0x1') return 'the node on 8545 is not chain 1';
    if (!/anvil/i.test(await raw('web3_clientVersion'))) return 'the node on 8545 is not anvil';
    return null;
  } catch {
    return 'no anvil on 127.0.0.1:8545';
  }
}

/** Waits for the shared fork lock; resolves to its release function. */
export function takeLock() {
  const file = join(tmpdir(), 'campfire-eth-fork.lock');
  const py = 'import fcntl,sys\nf=open(sys.argv[1],"a+")\nfcntl.lockf(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\nsys.stdin.read()\n';
  const child = spawn('python3', ['-I', '-c', py, file], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(() => child.stdin.end()));
    child.once('exit', (code) => reject(new Error(`lock helper exited ${code}`)));
  });
}

/** Runs fn under the lock with the fork snapshotted, and puts the fork back afterwards. */
export async function withFork(fn) {
  const release = await takeLock();
  const snapshot = await raw('evm_snapshot');
  try {
    return await fn();
  } finally {
    await raw('evm_revert', [snapshot]).catch(() => {});
    release();
  }
}

const hex = (n) => `0x${BigInt(n).toString(16)}`;

export async function setBalance(address, wei) {
  await raw('anvil_setBalance', [address, hex(wei)]);
}

/** Sends a transaction from `from` (impersonated, given ETH for gas) and waits for status 1. */
export async function sendAs(from, to, data) {
  if (data instanceof Uint8Array) data = `0x${Buffer.from(data).toString('hex')}`;
  await raw('anvil_impersonateAccount', [from]);
  await raw('anvil_setBalance', [from, hex(10n ** 19n)]);
  const hash = await raw('eth_sendTransaction', [{ from, to, data, gas: '0x7a120' }]);
  await raw('anvil_stopImpersonatingAccount', [from]).catch(() => {});
  const r = await mined(hash);
  if (r.status !== '0x1') throw new Error(`impersonated call reverted: ${hash}`);
  return r;
}

export async function mined(hash, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const r = await raw('eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`not mined: ${hash}`);
}

export async function erc20Balance(token, who) {
  const data = `0x70a08231${who.slice(2).toLowerCase().padStart(64, '0')}`;
  return BigInt(await raw('eth_call', [{ to: token, data }, 'latest']));
}

/**
 * Points an EthWallet at the fork: Ethereum through `rpc`, BNB Chain at a server that refuses
 * every request (a fork test never reaches a real server). The wallet asks rpcFor(chain) for
 * each chain it refreshes.
 */
export function walletOnFork(w, rpc) {
  const refused = new EthRpc('bsc-bnbchain', { fetch: async () => { throw new TypeError('no BNB Chain server in a fork test'); } });
  w.rpcFor = (chainKey = 'ethereum') => (chainKey === 'ethereum' ? rpc : refused);
  return w;
}
