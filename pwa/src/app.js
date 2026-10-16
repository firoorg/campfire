// Campfire - app controller: boot, screen routing, lock and auto-lock.
import { applyTheme, readTheme } from './lib/theme.js';
import { h, clear } from './lib/dom.js';
import { getPrefs } from './lib/store.js';
import { listWallets, initialWallet, loadPrefs, savePrefs, scopeTo, forgetStoredBalances, nameOf } from './lib/wallets.js';
import { setScopeOpen } from './lib/wallet_scope.js';
import { wallet } from './lib/wallet.js';
import { backendKind, closeSparkCache } from './lib/chain.js';
import { startOpenWallet, markSetupDone, noteFirstSync } from './lib/session.js';
import { updates, takeJustUpdated } from './lib/update.js';
import { installBack } from './lib/back.js';
import { navHistory } from './lib/nav.js';
import { swSupported, isControlled, clearReloadFlag, installedButBypassed, watchLoader, loaderBehind } from './lib/loader.js';
import { refreshPersistence } from './lib/storage.js';
import { reconcileOwnServer } from './lib/servers.js';
import { BUILT, APP_VERSION } from './lib/version.js';
import { sharedHost } from './lib/shared_host.js';
import { toast, canAutofocus, tabbar } from './lib/ui.js';
import { releasePayments } from './lib/payment_flight.js';
import { oneTab } from './lib/one_tab.js';
import { lockStep, IN_FLIGHT_RETRY_MS, waitForPayment } from './lib/auto_lock.js';

/** Locks the person asked for: they wait for a payment under way (auto-lock has its own wait). */
const WAIT_FOR_PAYMENT = new Set(['manual', 'switch', 'server']);

import welcome from './screens/welcome.js';
import backup from './screens/backup.js';
import confirmWords from './screens/confirm_words.js';
import restore from './screens/restore.js';
import restoreFile from './screens/restore_file.js';
import setPassword from './screens/set_password.js';
import passkeySetup from './screens/passkey_setup.js';
import ipNotice from './screens/ip_notice.js';
import unlock from './screens/unlock.js';
import home from './screens/home.js';
import send from './screens/send.js';
import review from './screens/review.js';
import txStatus from './screens/tx_status.js';
import receive from './screens/receive.js';
import privatize from './screens/privatize.js';
import activity from './screens/activity.js';
import settings from './screens/settings.js';
import servers from './screens/servers.js';
import rescan from './screens/rescan.js';
import viewKey from './screens/view_key.js';
import names from './screens/names.js';
import nameRegister from './screens/name_register.js';
import watch from './screens/watch.js';
import coins from './screens/coins.js';
import masternodes from './screens/masternodes.js';
import bridge from './screens/bridge.js';
import changePassword from './screens/change_password.js';
import about from './screens/about.js';
import deleteWallet from './screens/delete_wallet.js';
import problem from './screens/problem.js';
import install from './screens/install.js';
import contacts from './screens/contacts.js';
import { ETH_SCREENS } from './screens/eth_screens.js';
import { BUY_SCREENS } from './screens/buy_screens.js';
import { SELL_SCREENS } from './screens/sell_screens.js';
import { installPaymentNotices } from './screens/payment_notices.js';
import notifications from './screens/notifications.js';
import walletsScreen from './screens/wallets.js';
import addWallet from './screens/add_wallet.js';
import { otherTab, movedTab } from './screens/one_tab.js';

// Light or dark as chosen in Settings, before anything is drawn (lib/theme.js).
applyTheme(readTheme());

const SCREENS = {
  welcome, watch, backup, confirmWords, restore, restoreFile, setPassword, passkeySetup, ipNotice, unlock,
  home, send, review, txStatus, receive, privatize, bridge, activity, settings, servers, rescan, viewKey, names, nameRegister, coins, masternodes, changePassword, about, deleteWallet, problem, install,
  contacts, notifications,
  ...ETH_SCREENS,
  ...BUY_SCREENS,
  ...SELL_SCREENS,
  wallets: walletsScreen,
  addWallet,
  otherTab,
  movedTab,
};
// Which sidebar item a screen sits under (wide screens): Settings' own pages, else My wallet.
const SETTINGS_SCREENS = new Set(['servers', 'rescan', 'viewKey', 'names', 'nameRegister', 'coins', 'masternodes', 'changePassword', 'deleteWallet', 'notifications', 'wallets', 'backup']);
const SECTION_OF = { contacts: 'contacts', about: 'about', activity: 'activity' };
// Screens that need an unlocked, running wallet.
const NEEDS_WALLET = new Set(['wallets', 'home', 'send', 'review', 'txStatus', 'receive', 'privatize', 'bridge', 'activity', 'settings', 'servers', 'rescan', 'viewKey', 'names', 'nameRegister', 'coins', 'masternodes', 'changePassword', 'about', 'contacts', 'notifications', ...Object.keys(ETH_SCREENS), ...Object.keys(BUY_SCREENS), ...Object.keys(SELL_SCREENS)]);

const root = document.getElementById('app');

export const app = {
  prefs: null,
  // The selected wallet's record (several wallets: lib/wallets.js) and, while it is unlocked, its
  // secret (the key to its sealed recovery words). Setting the record also points the store's
  // per-wallet keys at that wallet (lib/wallet_scope.js), so nothing can read or write another one.
  _record: null,
  _dbPass: null,
  get record() {
    return this._record;
  },
  set record(r) {
    this._record = r || null;
    scopeTo(this._record);
  },
  get dbPass() {
    return this._dbPass;
  },
  set dbPass(v) {
    this._dbPass = v || null;
    setScopeOpen(Boolean(this._dbPass));
  },
  setup: null,
  current: null,
  currentName: null,
  params: null,
  lastActivity: Date.now(),
  hiddenAt: null,
  wallet,
  updates,
  persisted: null,
  // Run on lock and on the tripwire, to forget what a feature kept in memory (the Ethereum screens add one).
  lockHooks: new Set(),
  // Where Back goes (lib/nav.js); cleared on lock.
  nav: navHistory(),

  runLockHooks() {
    for (const f of this.lockHooks) {
      try {
        f();
      } catch (e) {
        console.error(e);
      }
    }
  },

  /**
   * Opens a screen. The one being left becomes Back's target, unless
   * opts.replace (move on without it) or opts.reset (forget all before).
   */
  go(name, params = {}, opts = {}) {
    if (!SCREENS[name]) throw new Error(`no screen ${name}`);
    // After the tripwire nothing else opens in this page: no unlock, no password field.
    if (this.intrusion) {
      name = 'problem';
      params = { kind: 'tripwire', detail: this.intrusion };
    } else {
      // One tab at a time (lib/one_tab.js): a tab that let the wallet go shows only that, and a tab
      // that never had it only "open in another tab", whatever asks for another screen.
      const tab = oneTab();
      if (tab.spent && name !== 'movedTab') {
        name = 'movedTab';
        params = { how: tab.how };
      } else if (!tab.spent && (tab.state === 'busy' || tab.state === 'asking') && name !== 'otherTab') name = 'otherTab';
    }
    if (NEEDS_WALLET.has(name) && !this.dbPass) name = this.record ? 'unlock' : 'welcome';
    this.nav.move(this.currentName ? { name: this.currentName, params: this.params } : null, { name, params }, opts);
    if (this.current && this.current.destroy) {
      try {
        this.current.destroy();
      } catch (e) {
        console.error(e);
      }
    }
    document.querySelectorAll('.overlay').forEach((o) => {
      o.dispatchEvent(new Event('campfire:dismiss'));
      o.remove();
    });
    clear(root);
    this.currentName = name;
    this.params = params;
    const r = SCREENS[name](this, params) || {};
    this.current = r;
    // Wide screens: every wallet screen keeps Campfire desktop's sidebar (CSS hides it on phones).
    const el = r.el || r;
    if (NEEDS_WALLET.has(name) && el.classList && el.classList.contains('screen') && !el.classList.contains('has-tabs')) {
      el.classList.add('has-tabs');
      el.appendChild(tabbar(this, SECTION_OF[name] || (SETTINGS_SCREENS.has(name) ? 'settings' : 'home')));
    }
    root.appendChild(el);
    root.dataset.screen = name;
    window.scrollTo(0, 0);
    const focus = root.querySelector('[data-autofocus]');
    if (focus && canAutofocus()) focus.focus();
  },

  /** Whether this release has a screen called `name` (a feature built elsewhere may not be here yet). */
  has(name) {
    return Object.prototype.hasOwnProperty.call(SCREENS, name);
  },

  /** Back to the screen the person came from, or to `fallback` when there is none (after a reload or an unlock). */
  back(fallback = 'home', fallbackParams = {}) {
    const t = this.nav.backTarget(fallback, fallbackParams);
    return this.go(t.name, t.params, t.opts);
  },

  /** Saves preferences: the open wallet's own to it, the rest to the app (lib/wallets.js). */
  async setPrefs(patch) {
    this.prefs = await savePrefs(this.record, patch);
    return this.prefs;
  },

  /**
   * The wallet is unlocked (or was just made): start the engine on it and go to Home. Setup ends
   * here, so no setup step is a Back target any more.
   */
  async openWallet({ go = true } = {}) {
    try {
      await startOpenWallet(this);
    } catch (e) {
      // Never a silent failure: back to Unlock, which says what happened and offers a retry.
      console.error('[campfire] start', e);
      this.dbPass = null;
      this.nav.clear();
      this.runLockHooks();
      await wallet.stop().catch(() => {});
      this.go('unlock', { reason: 'failed', error: String((e && e.message) || e) });
      return false;
    }
    if (!this.record.setupDone) await markSetupDone(this);
    if (go) this.go('home', {}, { reset: true });
    return true;
  },

  /**
   * Stops the engine and forgets the wallet's secret. beforeUnlock: runs before the unlock
   * screen opens (a switch selects the next wallet there); params: more for that screen.
   */
  async lock(reason, { beforeUnlock = null, params = {} } = {}) {
    // Asked by the person (Lock, another wallet, another server) while a payment is between being
    // written down and the end of its broadcast: it is let finish first, as auto-lock does, for at most
    // two minutes (audit of 0.1.8: a manual Lock cut it short and it showed "may have left").
    if (WAIT_FOR_PAYMENT.has(reason) && wallet.paymentUnderWay()) {
      if (this._lockWaiting) return this._lockWaiting;
      toast('Your payment is still being sent. Campfire locks as soon as it has left.', 6000);
      this._lockWaiting = waitForPayment(() => wallet.paymentUnderWay());
      try {
        await this._lockWaiting;
      } finally {
        this._lockWaiting = null;
      }
    }
    const wasOpen = Boolean(this.dbPass);
    this.dbPass = null;
    if (this.setup) this.setup = null;
    this.nav.clear();
    this.runLockHooks();
    await wallet.stop();
    // A fresh start after the lock: no payment place held, no prefilled payment or swap that could be
    // sent again, no result toast from before it (audit 0.1.8).
    releasePayments();
    this.sendDraft = null;
    this.uniDraft = null;
    this.bscSwapDraft = null;
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    if (beforeUnlock) await beforeUnlock();
    if (wasOpen || this.currentName !== 'unlock') this.go('unlock', { ...params, reason });
  },

  /**
   * The tripwire (lib/loader.js): the web address now serves code Campfire did not sign. Stop the
   * engine, forget the wallet's secret, and say so. Never reload: a reload would run the new code.
   */
  async intruded(reason) {
    if (this.intrusion) return;
    this.intrusion = reason || 'unsigned code';
    console.warn('[campfire] tripwire:', this.intrusion);
    this.dbPass = null;
    this.setup = null;
    this.nav.clear();
    this.runLockHooks();
    this.go('problem', { kind: 'tripwire', detail: this.intrusion });
    await wallet.stop().catch(() => {});
  },

  /**
   * Another tab asked for the wallet (lib/one_tab.js "take-over"): lock it here. Stopping the engine
   * waits for the sync step under way and closes its store, so what it wrote is complete; the
   * shared Spark cache is closed too. The lock is let go after this.
   */
  async letGoToOtherTab() {
    this.dbPass = null;
    this.setup = null;
    this.nav.clear();
    this.runLockHooks();
    await wallet.stop().catch((e) => console.warn('[campfire] stopping for the other tab', e && e.message));
    await closeSparkCache().catch(() => {});
  },

  /**
   * This tab let the wallet go ('handed'; 'capped' when locking and saving had not finished within
   * the cap, RE1-7), another tab took it while this one was frozen ('stolen'), or this browser
   * cannot say whose it is ('unchecked', lib/one_tab.js RE1-1). 'away': restored from
   * the back/forward cache in a browser without Web Locks (RE1-2): its memory is the old state and
   * another tab may hold the wallet now, so it starts again.
   */
  leftForOtherTab(how) {
    if (how === 'away') return location.reload();
    // A create that finished just before the hand-over may have opened its wallet after the lock
    // ran (lib/session.js): nothing of it stays here.
    this.dbPass = null;
    this.setup = null;
    if (how !== 'handed') {
      // Nothing is written from here any more (the stores refuse): just stop.
      this.nav.clear();
      this.runLockHooks();
      wallet.stop().catch(() => {});
    }
    if (!this.intrusion) this.go('movedTab', { how });
  },

  touch() {
    this.lastActivity = Date.now();
  },

  autoLockMs() {
    return (Number(this.prefs && this.prefs.autoLockMin) || 5) * 60000;
  },
};

// One tab at a time (lib/one_tab.js): asked by another tab, this one locks, saves and lets go.
oneTab().onLetGo(() => app.letGoToOtherTab());
oneTab().onLeft((how) => app.leftForOtherTab(how));

// A banner (and, when allowed, a system notification) when a payment arrives while the app is open.
installPaymentNotices(app);

// A wallet made on this device remembers the block it first was in step at (lib/session.js).
wallet.onChange((s) => {
  if (app.dbPass && app.record && app.record.newWallet && app.record.birthday == null && s.sync.state === 'synced' && wallet.run && wallet.run.walletId === app.record.id) noteFirstSync(app, s.sync.height).catch(() => {});
});

// Auto-lock: after the chosen minutes without use while on screen, and after as long out of sight
// (another tab, another app, the screen off). Out of sight it locks there and then, not on the way
// back: a tab left in the background on a computer must not keep the wallet's secret, the words the
// engine was opened with and the running engine in memory for days. A browser slows timers in a
// background tab (Chrome: about once a minute), so the lock may come a little late; a phone that
// froze the page locks it the moment it comes back. A due lock waits for a payment going out (its
// record and broadcast: audit FE-4), at most two minutes (release re-audit R1-5, lib/auto_lock.js).
window.addEventListener('pointerdown', () => app.touch(), { passive: true });
window.addEventListener('keydown', () => app.touch(), { passive: true });
let hiddenLock = null;
// When a due lock started waiting for a payment going out.
let waitingSince = null;
// Coming back after the auto-lock time away while a payment was going out: the lock is owed, and
// coming back (which counts as use) does not cancel it.
let lockOwed = false;
const lockIfIdle = () => {
  if (!app.dbPass) {
    waitingSince = null;
    lockOwed = false;
    return;
  }
  const now = Date.now();
  const since = document.visibilityState === 'visible' ? app.lastActivity : app.hiddenAt || app.lastActivity;
  const step = lockStep({ due: lockOwed || now - since >= app.autoLockMs(), inFlight: wallet.paymentUnderWay(), waitingSince, now });
  if (step === 'wait') {
    // Looked at again in a few seconds: locked once the payment is written down and sent, or at the cap.
    if (waitingSince === null) waitingSince = now;
    clearTimeout(hiddenLock);
    hiddenLock = setTimeout(lockIfIdle, IN_FLIGHT_RETRY_MS);
    return;
  }
  waitingSince = null;
  if (step === 'lock') {
    lockOwed = false;
    app.lock('timeout');
  }
};
document.addEventListener('visibilitychange', () => {
  clearTimeout(hiddenLock);
  hiddenLock = null;
  if (document.visibilityState === 'hidden') {
    app.hiddenAt = Date.now();
    hiddenLock = setTimeout(lockIfIdle, app.autoLockMs() + 50);
  } else {
    // Back in sight: how long it was away counts (coming back is use). With a payment going out
    // the lock is owed, not dropped (R1-5): it comes once the payment is through, or at the cap.
    if (app.hiddenAt && app.dbPass && Date.now() - app.hiddenAt >= app.autoLockMs()) {
      lockOwed = true;
      lockIfIdle();
    }
    app.hiddenAt = null;
    app.touch();
  }
});
setInterval(lockIfIdle, 15000);

/** What this browser must have to run the wallet: WebCrypto, IndexedDB, WebSockets, BigInt. */
export function browserSupport(g = globalThis) {
  const problems = [];
  if (!g.crypto || !g.crypto.subtle) problems.push('WebCrypto (a secure https:// page)');
  if (!g.indexedDB) problems.push('IndexedDB storage');
  if (typeof g.WebSocket !== 'function') problems.push('WebSockets');
  if (typeof g.BigInt !== 'function') problems.push('BigInt');
  return { ok: problems.length === 0, problems };
}

async function boot() {
  if (BUILT && sharedHost(location.hostname)) return app.go('problem', { kind: 'shared-host' });
  // A published copy runs only from the checked copy its loader keeps. A browser without service
  // workers (some private windows, an app's built-in browser) ran it straight from the web address,
  // unchecked (public audit, P14): it stops here and says where to open it instead.
  if (BUILT && !swSupported()) return app.go('problem', { kind: 'no-loader' });
  if (BUILT && swSupported()) {
    if (isControlled()) {
      clearReloadFlag();
      // Watches for code Campfire did not sign. Nothing here contacts the web address.
      // After an Update that brought a new loader, the page reloads under it as soon
      // as it has taken over, when nothing is unlocked; otherwise Home offers it.
      watchLoader({ onIntrusion: (why) => app.intruded(why), onMoved: () => (app.dbPass ? app.updates.emit() : location.reload()) }).catch((e) => console.warn('[campfire] loader watch', e.message));
    } else if (!(await installedButBypassed())) {
      // First open on this device (or the browser cleared it): set up the verified copy, with progress.
      return app.go('install');
    }
  }
  return app.continueBoot();
}

/** Everything after the verified copy is in place. No update check, no request to the web address. */
app.continueBoot = async function continueBoot() {
  const sup = browserSupport();
  if (!sup.ok) {
    if (BUILT && swSupported() && !isControlled()) {
      const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
      if (reg && reg.active) return app.go('problem', { kind: 'bypassed' });
    }
    return app.go('problem', { kind: 'unsupported', detail: sup.problems });
  }
  // One tab at a time (lib/one_tab.js), before the app's store, the engine or a wallet is opened.
  const tab = await oneTab().claim();
  if (tab === 'busy') return app.go('otherTab');
  if (tab === 'gone') return app.go('movedTab', { how: oneTab().how });
  app.prefs = await getPrefs();
  // The person's own server must be in this page's policy before the engine can reach it.
  if (BUILT && (await reconcileOwnServer(app))) return;
  // Several wallets: the one last opened comes first.
  app.record = initialWallet(await listWallets(), app.prefs);
  app.prefs = await loadPrefs(app.record);
  forgetStoredBalances().catch(() => {});
  refreshPersistence(app, { request: Boolean(app.record) });
  backendKind().then((k) => k === 'fake' && console.info('[campfire] engine: the stand-in (lib/backend_fake.js); no network, no real funds'));

  // Once, after an Update: which version, and whether it came from another copy of the app.
  const updated = takeJustUpdated(APP_VERSION);
  app.go(app.record ? 'unlock' : 'welcome', updated ? { updated } : {});
  if (updated && !app.record) toast(updated, 6000);
};

/**
 * Once: BNB Chain's server changed under someone who used it (lib/eth/server_notes.js). Shown over
 * whichever Ethereum & BNB screen opens the wallet first (lib/eth/wallet.js asks), and BNB Chain's
 * requests wait for it where the person had picked the server that went away. Loaded only then.
 */
app.bscNote = function bscNote() {
  if (app.bscNoteOpening || app.bscNoteShown) return;
  app.bscNoteOpening = import('./screens/eth_server_note.js')
    .then((m) => m.showBscServerNote(app))
    .catch((e) => console.warn('[campfire] BNB Chain server note', e && e.message))
    .finally(() => {
      app.bscNoteOpening = null;
    });
};

installBack(app);

boot().catch((e) => {
  console.error(e);
  clear(root);
  root.appendChild(h('main', { class: 'screen' }, h('div', { class: 'content' }, h('h2', { class: 'title', text: 'Campfire could not start' }), h('p', { class: 'lead', text: String(e && e.message) }), h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload'))));
});

// <test-hooks> Read-only view for the e2e harness. No secrets on it. tools/build.mjs leaves this
// block out of builds with the real engine (--test-hooks keeps it, for local checks only).
window.__campfire = Object.freeze({
  screen: () => app.currentName,
  // Back's targets, screen names only, oldest first.
  backStack: () => app.nav.names(),
  sync: () => wallet.state.sync,
  height: () => (wallet.state.tip ? wallet.state.tip.height : null),
  connected: () => wallet.state.connected,
  server: () => wallet.state.server,
  balance: () => ({ private: { available: String(wallet.state.balance.private.available), pending: String(wallet.state.balance.private.pending) }, public: { available: String(wallet.state.balance.public.available), pending: String(wallet.state.balance.public.pending) } }),
  txs: () => wallet.state.txs.map((t) => ({ txid: t.txid, kind: t.kind, direction: t.direction, amount: String(t.amount), fee: String(t.fee), confirmations: t.confirmations, memo: t.memo })),
  receive: () => ({ ...wallet.state.receive }),
  engine: () => backendKind(),
  version: () => (updates.available ? { available: updates.available.version } : null),
  // One tab at a time (lib/one_tab.js): this tab's state.
  oneTab: () => ({ state: oneTab().state, how: oneTab().how, mode: oneTab().mode, spent: oneTab().spent, clientId: oneTab().clientId }),
  // One write through each guarded path (the app store, a wallet's engine store), each putting back
  // a value it just read (nothing changes when it goes through): 'ok', or the refusal's code.
  writeProbe: async (walletId) => {
    const { rawStore } = await import('./lib/store.js');
    const { openWalletStore } = await import('./lib/wallet_store.js');
    const tryIt = (f) => f().then(() => 'ok', (e) => (e && e.code) || String(e));
    const ws = openWalletStore(walletId);
    const key = (await ws.keys(''))[0];
    const out = { app: await tryIt(async () => rawStore.set('prefs', await rawStore.get('prefs'))), engine: await tryIt(async () => ws.put(key, await ws.get(key))) };
    await ws.close();
    return out;
  },
  intrusion: () => app.intrusion || null,
  running: () => Boolean(wallet.session),
  persisted: () => app.persisted,
  loaderBehind: () => loaderBehind(),
  go: (name, params) => app.go(name, params),
  classify: (text) => wallet.classifyAddress(text),
  // Every wallet on this device: names and flags, never an envelope or sealed words.
  wallets: async () => (await listWallets()).map((r) => ({ id: r.id, name: nameOf(r), slot0: Boolean(r.slot0), selected: Boolean(app.record && app.record.id === r.id), open: Boolean(app.dbPass && app.record && app.record.id === r.id), running: Boolean(wallet.run && wallet.run.walletId === r.id), restored: Boolean(r.restored), words: r.words, passkey: Boolean(r.envelopes && r.envelopes.passkey) })),
  record: () => (app.record ? { restored: Boolean(app.record.restored), words: app.record.words, passphrase: Boolean(app.record.passphrase), birthday: app.record.birthday, setupDone: Boolean(app.record.setupDone), passkey: Boolean(app.record.envelopes && app.record.envelopes.passkey) } : null),
});
// </test-hooks>
