// Buy FIRO for the unlocked wallet: one controller per wallet (buys sealed in
// the app's store, requests to buyfiro.app), a new transparent address of this
// wallet for each buy, and whether the FIRO a buy delivered is in the wallet yet.
//
// buyfiro.app pays to transparent addresses only, so a buy arrives in the
// public balance; Home then offers Privatize, and so does the buy's own screen.
//
// Open buys are followed only while the wallet is unlocked and the page is
// visible: hiding the page pauses the controller, locking disposes of it and
// forgets the key the buys are sealed with.

import { BuyClient } from './buyfiro.js';
import { BuyController } from './controller.js';
import { sealedBuyStore, forgetBuyKeys, hasBuys } from './store.js';
import { store } from '../store.js';
import { walletStore } from '../wallet_scope.js';
import { wallet, isPendingTx } from '../wallet.js';

/** Thrown by buyAddress() while the wallet is not running yet. */
export class WalletNotReady extends Error {
  constructor() {
    super('The wallet is still starting.');
    this.code = 'wallet_not_ready';
  }
}

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The local switch for buyfiro.app's test mode (e2e, development): honoured on this device's own addresses only. */
export const SANDBOX_KEY = 'campfire-buy-sandbox';

/** Test mode (nothing payable, nothing bought) only on localhost with the switch set; never on a real address. */
export function devSandbox(loc = globalThis.location, storage = globalThis.localStorage) {
  try {
    return Boolean(loc && DEV_HOSTS.has(loc.hostname) && storage && storage.getItem(SANDBOX_KEY) === '1');
  } catch {
    return false;
  }
}

let current = null; // {walletId, controller}
let hooked = false;

function stop() {
  if (current) current.controller.dispose();
  current = null;
  forgetBuyKeys();
}

/** The buy controller of the unlocked wallet, created (and its open buys followed) on first use. */
export function buyFiro(app) {
  if (!app || !app.dbPass || !app.record) throw new Error('Unlock the wallet first.');
  if (current && current.walletId === app.record.id) return current.controller;
  stop();
  // Bound to this wallet: a buy's update that lands after a switch still goes to its own buys.
  const controller = new BuyController({ client: new BuyClient({ sandbox: devSandbox() }), store: sealedBuyStore(app, { kv: walletStore(app.record) }) });
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

/**
 * The deadline of this wallet's buy paying into `address`, as Ethereum Send needs it ({address,
 * deadline}), or null: from the buys already followed only (nothing is loaded or asked for this).
 * Second audit of 0.1.8, N11: a deposit address pasted by hand was never checked against its deadline.
 */
export function buyPayBy(app, address) {
  const a = String(address || '').trim().toLowerCase();
  if (!a || !current || !app?.record || current.walletId !== app.record.id) return null;
  const o = current.controller.orders(app.record.id).find((x) => String(x.depositAddress || '').toLowerCase() === a);
  return o && o.deadline != null ? { address: o.depositAddress, deadline: o.deadline } : null;
}

/** Follows this wallet's open buys when it keeps any (Home calls it: one store read when there are none). */
export async function followBuys(app) {
  try {
    if (await hasBuys(store)) buyFiro(app);
  } catch {
    // Following is a convenience: the buy's own screen asks again.
  }
}

/**
 * A new transparent address of this wallet for one buy (buyfiro.app pays to
 * transparent addresses only); the wallet's current one when it cannot make another.
 */
export async function buyAddress(w = wallet) {
  if (!w.session) throw new WalletNotReady();
  let addr = null;
  if (typeof w.newTransparentAddress === 'function') addr = await w.newTransparentAddress();
  if (!addr) addr = w.state.receive && w.state.receive.transparent;
  if (typeof addr !== 'string' || !addr) throw new Error('The wallet did not make an address.');
  return addr;
}

/** Whether this wallet has received the FIRO transaction txid, confirmed. */
export function receivedInWallet(txid, w = wallet) {
  if (!txid) return false;
  return w.state.txs.some((t) => t.txid === txid && t.direction === 'in' && !isPendingTx(t));
}
