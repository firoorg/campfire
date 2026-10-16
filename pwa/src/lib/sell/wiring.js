// Sell FIRO for the unlocked wallet: one controller per wallet (sells sealed in
// the app's store under the wallet's own key, requests to buyfiro.app, deposit
// addresses checked with this wallet's own address classifier), this wallet's
// Ethereum & BNB address as the default payout, and whether this wallet has
// paid a sell.
//
// Open sells are followed only while the wallet is unlocked and the page is
// visible: hiding the page pauses the controller, locking disposes of it and
// forgets the key the sells are sealed with.
//
// buyfiro.app's test mode (nothing payable, nothing sold) is on only on this
// device's own addresses with the switch set (devSandbox), and always under a
// test runner (underTest): no test can reach the real sell API.

import { SellClient, underTest } from './sellfiro.js';
import { SellController } from './controller.js';
import { sealedSellStore, forgetSellKeys, hasSells, sellRecordKey } from './store.js';
import { rawStore } from '../store.js';
import { wallet } from '../wallet.js';
import { backendKind } from '../chain.js';

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The local switch for buyfiro.app's test mode (e2e, development): honoured on this device's own addresses only. */
export const SANDBOX_KEY = 'campfire-sell-sandbox';

/** Test mode only on localhost with the switch set; never on a real address. */
export function devSandbox(loc = globalThis.location, storage = globalThis.localStorage) {
  try {
    return Boolean(loc && DEV_HOSTS.has(loc.hostname) && storage && storage.getItem(SANDBOX_KEY) === '1');
  } catch {
    return false;
  }
}

/** Whether sells go to buyfiro.app's test mode here: the dev switch, or any test runner. */
export function sellSandbox(loc = globalThis.location, storage = globalThis.localStorage, env = undefined) {
  return devSandbox(loc, storage) || underTest(env);
}

let current = null; // {walletId, controller}
let hooked = false;

function stop() {
  if (current) current.controller.dispose();
  current = null;
  forgetSellKeys();
}

/** The sell controller of the unlocked wallet, created (and its open sells followed) on first use. */
export function sellFiro(app) {
  if (!app || !app.dbPass || !app.record) throw new Error('Unlock the wallet first.');
  if (current && current.walletId === app.record.id) return current.controller;
  stop();
  // Bound to this wallet: a sell's update that lands after a switch still goes to its own sells.
  const client = new SellClient({ sandbox: sellSandbox(), classifyAddress: (text) => wallet.classifyAddress(text) });
  const controller = new SellController({ client, store: sealedSellStore(app, { kv: rawStore }) });
  current = { walletId: app.record.id, controller };
  if (!hooked) {
    hooked = true;
    app.lockHooks.add(stop);
    document.addEventListener('visibilitychange', () => {
      if (!current) return;
      if (document.visibilityState === 'visible') current.controller.resume();
      else current.controller.pause();
    });
  }
  if (document.visibilityState !== 'visible') controller.pause();
  controller.resumeAll();
  return controller;
}

/** Follows this wallet's open sells when it keeps any (Home calls it: one store read when there are none). */
export async function followSells(app) {
  try {
    if (await hasSells(rawStore, sellRecordKey(app))) sellFiro(app);
  } catch {
    // Following is a convenience: the sell's own screen asks again.
  }
}

/**
 * This wallet's Ethereum & BNB address ('0x…', checksummed): the default payout. Null when there
 * is no such wallet. Reading it contacts no server.
 */
export async function ownPayoutAddress(app) {
  try {
    const { hasEthWallet } = await import('../eth/record.js');
    if (!(await hasEthWallet())) return null;
    const [{ evmAddress }, { forgetEthWallet }] = await Promise.all([import('../eth/send_raw.js'), import('../eth/wallet.js')]);
    // Locking forgets the opened Ethereum wallet, as every other screen that opens it does.
    app.lockHooks.add(forgetEthWallet);
    return await evmAddress(app);
  } catch {
    return null;
  }
}

/**
 * A payout address typed or pasted: {ok, address (checksummed), problem}. EIP-55 checked (a
 * mixed-case address must match its checksum; all lower or all upper case carries none).
 */
export async function checkPayoutAddress(text, { token = null } = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, address: null, problem: null };
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return { ok: false, address: null, problem: 'An Ethereum or BNB Chain address starts with 0x and has 42 characters.' };
  const { isAddress, toChecksumAddress } = await import('../eth/crypto.js');
  if (!isAddress(t)) return { ok: false, address: null, problem: 'This address has a typo: its capital letters do not match its checksum. Copy it again.' };
  if (/^0x0{40}$/i.test(t)) return { ok: false, address: null, problem: 'That is the empty address: nobody can spend what is sent there.' };
  if (token && t.toLowerCase() === String(token).toLowerCase()) return { ok: false, address: null, problem: "That is the token's own contract, not a wallet. Paste your wallet's address." };
  return { ok: true, address: toChecksumAddress(t), problem: null };
}

/**
 * This wallet's payment of `order` in its history (a send to one of its deposit addresses), or
 * null. A payment the network does not have (Tx.dropped: it did not go through) is not one.
 */
export function paymentInWallet(order, w = wallet) {
  if (!order) return null;
  const to = [order.sparkDepositAddress, order.depositAddress].filter(Boolean);
  if (order.sentTxid) {
    const t = w.state.txs.find((x) => x.txid === order.sentTxid);
    if (t) return t.dropped ? null : t;
  }
  return w.state.txs.find((x) => x.direction === 'out' && !x.dropped && x.counterparty && to.includes(x.counterparty)) || null;
}

/**
 * Whether this page may pay `order` with real FIRO. A test-mode order is paid only by the
 * stand-in engine (lib/backend_fake.js), never with real coins: its address is buyfiro.app's
 * sandbox's, which never sells anything.
 */
export async function mayPay(order) {
  if (!order || !order.payable) return false;
  if (!order.sandbox) return true;
  return (await backendKind().catch(() => 'real')) === 'fake';
}
