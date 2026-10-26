// What the Uniswap fork tests share: a local anvil mainnet fork on
// 127.0.0.1:8545 and nothing else. Before anything is sent, the node must call
// itself anvil and answer chain id 1 (anvilProblem); every request the
// Ethereum client makes goes to that address, whatever host it names.
//
// The fork is shared with the desktop app's fork tests and with
// eth_anvil.test.mjs, so each test takes the same lock
// ($TMPDIR/campfire-eth-fork.lock, an fcntl lock held by a small python3
// child) and puts the fork back with evm_snapshot / evm_revert (withFork).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EthRpc } from '../../src/lib/eth/rpc.js';
import { privateKeyToAddress } from '../../src/lib/eth/crypto.js';
import { signTransaction } from '../../src/lib/eth/tx.js';
import { hexToBytes, bytesToHex } from '../../src/lib/eth/hex.js';
import { parseKnownPools } from '../../src/lib/eth/uniswap/discovery.js';
import { RSFIRO } from '../../src/lib/eth/tokens.js';
import { UniswapService } from '../../src/lib/eth/uniswap/service.js';

export const ANVIL = 'http://127.0.0.1:8545';
/** Anvil's well-known key 0 (0xf39F…2266): a public test key, funded only on the fork. */
export const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const ETH = 10n ** 18n;

export async function raw(method, params = []) {
  const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(600000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Null when 127.0.0.1:8545 is an anvil answering as Ethereum mainnet; else why the tests skip. */
export async function anvilProblem() {
  try {
    const quick = async (method) => {
      const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }), signal: AbortSignal.timeout(3000) });
      return (await r.json()).result;
    };
    if (!/anvil/i.test(String(await quick('web3_clientVersion')))) return 'the node on 8545 is not anvil';
    if ((await quick('eth_chainId')) !== '0x1') return 'the node on 8545 is not chain 1';
    return null;
  } catch {
    return 'no anvil on 127.0.0.1:8545';
  }
}

function takeLock() {
  const file = join(tmpdir(), 'campfire-eth-fork.lock');
  const py = 'import fcntl,sys\nf=open(sys.argv[1],"a+")\nfcntl.lockf(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\nsys.stdin.read()\n';
  const child = spawn('python3', ['-I', '-c', py, file], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(() => child.stdin.end()));
    child.once('exit', (code) => reject(new Error(`lock helper exited ${code}`)));
  });
}

/** Runs fn() with the fork to itself, and leaves the fork as it found it. */
export async function withFork(fn) {
  const release = await takeLock();
  // Checked again under the lock, right before anything is sent.
  const problem = await anvilProblem();
  if (problem) {
    release();
    throw new Error(problem);
  }
  const snapshot = await raw('evm_snapshot');
  try {
    return await fn();
  } finally {
    await raw('evm_revert', [snapshot]).catch(() => {});
    release();
  }
}

/**
 * The app's Ethereum client, pointed at the fork: whichever listed host it
 * names, the request goes to 127.0.0.1:8545. A fork reads each contract's
 * state from its source node the first time, so it is given minutes.
 */
export function forkRpc() {
  return new EthRpc('stackwallet', { fetch: (_url, init) => fetch(ANVIL, init), timeoutMs: 8 * 60 * 1000 });
}

export function knownPools() {
  return parseKnownPools(JSON.parse(readFileSync(new URL('../../src/lib/eth/uniswap/known_pools.json', import.meta.url), 'utf8')));
}

export function service(rpc = forkRpc(), opts = {}) {
  // As the app builds it (lib/eth/uniswap_app.js): every rsFIRO pool is in the shipped list.
  return new UniswapService({ rpc, known: knownPools(), fullyListed: [RSFIRO.address], ...opts });
}

/** A key with `eth` ETH on the fork: anvil's key 0, or a fresh one (never an address with code on mainnet). */
export async function fundedKey({ eth = 10n * ETH, key = null } = {}) {
  let sk;
  if (key) sk = hexToBytes(key);
  else {
    sk = new Uint8Array(32);
    crypto.getRandomValues(sk);
    sk[0] &= 0x7f; // always below the curve order
  }
  const address = privateKeyToAddress(sk).toLowerCase();
  await raw('anvil_setBalance', [address, `0x${eth.toString(16)}`]);
  return { sk, address };
}

/** Signs an unsigned transaction from the service with `sk`, sends it to the fork, and waits for its receipt. */
export async function sendAndWait(rpc, tx, sk) {
  const from = privateKeyToAddress(sk);
  const nonce = await rpc.getTransactionCount(from, 'pending');
  const signed = signTransaction({ ...tx, nonce }, sk);
  const hash = await rpc.sendRawTransaction(signed.raw);
  for (let i = 0; i < 600; i++) {
    const r = await rpc.getTransactionReceipt(hash);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`not mined: ${hash}`);
}

export { bytesToHex };
