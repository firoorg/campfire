// Notifications, end to end, all on the device: the installed Google Chrome (headless), its own
// build and port, the stand-in engine (lib/backend_fake.js: no network, no real funds).
//
//   npm run e2e:notify   (own build folder and port 8826)
//
// Payments arrive through the stand-in's test controls (globalThis.__firoFake.credit: a payment
// seen waiting for its confirmation, confirmed in the next fake block about 3 s later, or at once
// with __firoFake.mine()); payments leave through the wallet's own send and privatize. The app's
// switch, banner, system notifications, badge, the summary after an unlock and the service
// worker's reminders are the real code. The page's system notifications are recorded
// (registration.showNotification stubbed in the page); the service worker's are real.
// "Out of front" is the page hidden (visibilitychange) or its window without focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced, unlockWithPassword, lock } from './flows.mjs';

const PORT = Number(process.env.CAMPFIRE_NOTIFY_PORT || 8826);
const tid = (id) => `[data-testid="${id}"]`;
const PASSWORD = `notify-${Math.random().toString(36).slice(2, 10)}`;

let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-notify-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(['notifications'], { origin: srv.url });
  await ctx.addInitScript(() => {
    window.__shown = [];
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts) {
      window.__shown.push({ title, body: opts && opts.body, url: opts && opts.data && opts.data.url, tag: opts && opts.tag });
      return Promise.resolve();
    };
    window.__badge = null;
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: (n) => ((window.__badge = n), Promise.resolve()) });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: () => ((window.__badge = 0), Promise.resolve()) });
    window.__front = true;
    document.hasFocus = () => window.__front;
    window.__setHidden = (hidden) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  ({ page, rec } = await recordedPage(ctx, { label: 'notify' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.afterEach(async () => {
  if (page) await page.evaluate(() => {
    window.__front = true;
    if (document.visibilityState !== 'visible') window.__setHidden(false);
  }).catch(() => {});
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function both(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** A payment to this wallet ('private' or 'public', sats as a string); its txid. Confirmed ~3 s later, or now with mine. */
const credit = (to, amount, { memo = null, mine = false } = {}) =>
  page.evaluate(([t, a, m, now]) => {
    const id = window.__firoFake.credit({ to: t, amount: a, memo: m });
    if (now) window.__firoFake.mine();
    return id;
  }, [to, amount, memo, mine]);

/** The wallet's own send (private, to a Spark name the stand-in knows); its txid. */
const sendOut = (sats) =>
  page.evaluate(async (v) => {
    const { wallet } = await import('./lib/wallet.js');
    return (await wallet.send({ from: 'private', to: [{ address: '@satoshi', amount: BigInt(v) }] })).txid;
  }, sats);

/** Privatize the whole public balance; its txid. */
const privatizeAll = () =>
  page.evaluate(async () => {
    const { wallet } = await import('./lib/wallet.js');
    return (await wallet.privatize('all')).txid;
  });

const shown = () => page.evaluate(() => window.__shown.map((n) => n.title));

/** Polls fn in the page until it returns true (page.waitForFunction takes an async function's promise as a yes). */
async function until(fn, arg = null, { timeout = 20000, label = 'condition' } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate(fn, arg)) return;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function reminders() {
  return page.evaluate(async () => {
    const { rawStore } = await import('./lib/store.js');
    const keys = (await rawStore.keys('w:')).filter((k) => k.endsWith(':notify-reminders'));
    const out = [];
    for (const k of keys) out.push(...((await rawStore.get(k)) || []));
    return out;
  });
}

test('a new wallet, synced; Settings → Notifications: off, asked only from the switch, then on', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await waitSynced(page);
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  assert.equal(await page.textContent(tid('notify-row-sub')), 'Off');
  await page.click(tid('notify-row'));
  await waitScreen(page, 'notifications');
  assert.match(await page.textContent(tid('notify-sub')), /^Off/);
  assert.match(await page.textContent(tid('notify-note')), /in the background until it locks itself/);
  assert.equal(await page.isVisible(tid('notify-kinds')), false, 'what to be told about shows once they are on');
  assert.equal(await page.isVisible(tid('notify-test')), false);
  // The switch is on screen on a 375 x 667 phone without scrolling.
  await page.setViewportSize({ width: 375, height: 667 });
  const box = await page.locator(tid('notify-switch')).boundingBox();
  assert.ok(box && box.y + box.height <= 667, 'the switch fits a small phone');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click(tid('notify-switch'));
  await page.waitForFunction(() => /^On/.test(document.querySelector('[data-testid="notify-sub"]').textContent));
  for (const k of ['in', 'out', 'moves']) assert.equal(await page.isChecked(tid(`notify-kind-${k}`)), true, k);
  assert.equal(await page.isChecked(tid('notify-amounts')), false, 'no amounts on the lock screen unless asked (audit A-8)');
  // Reminders while the app is closed (Chrome's Periodic Background Sync): off unless turned on.
  assert.equal(await page.isVisible(tid('notify-wakeups')), true, 'offered in Chrome');
  assert.equal(await page.isChecked(tid('notify-wakeups')), false, 'off by default');
  assert.match(await page.textContent(tid('notify-wakeups-sub')), /with no Campfire screen open to warn you/);
  await page.click(tid('notify-test'));
  await page.waitForFunction(() => window.__shown.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__shown[0]), { title: 'Campfire notifications are on', body: 'A payment will be told like this.', url: '#open=notifications', tag: 'campfire-test' });
  await both('notify-01-settings');
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  assert.equal(await page.textContent(tid('notify-row-sub')), 'On');
});

test('in front: a banner for money on its way, then received; out of front: notifications and the badge', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  // The run counts as caught up 10 s after it was Synced; what turns up before is history.
  await sleep(12000);
  await page.evaluate(() => (window.__shown = []));
  await credit('private', '50000000', { memo: 'Thanks' });
  await page.waitForSelector(tid('pay-banner'));
  assert.equal(await page.textContent(tid('pay-banner-title')), '0.5 FIRO is on its way to you', 'in the open app: with the amount');
  await page.waitForFunction(() => document.querySelector('[data-testid="pay-banner-title"]')?.textContent === 'Received 0.5 FIRO', null, { timeout: 15000 });
  assert.match(await page.textContent(tid('pay-banner')), /arrived privately/);
  assert.deepEqual(await shown(), [], 'in front: the banner says it');
  await both('notify-02-banner');
  await page.click(tid('pay-banner-close'));

  // Another window in front (a computer): the page is visible but not focused.
  await page.evaluate(() => (window.__front = false));
  const id = await credit('public', '25000000');
  await page.waitForFunction(() => window.__shown.length >= 2, null, { timeout: 15000 });
  assert.deepEqual(await shown(), ['A payment is on its way to you', 'Payment received'], 'the lock screen: no amount by default');
  const n = await page.evaluate(() => window.__shown.map((x) => [x.url, x.tag, x.body]));
  assert.equal(n[1][0], `#open=activity&tx=${id}`);
  assert.equal(n[0][1], n[1][1], 'received replaces "on its way" in the notification list');
  assert.match(n[1][2], /arrived publicly/);
  assert.equal(await page.evaluate(() => window.__badge), 2);
  await page.evaluate(() => (window.__front = true));
});

test('leaving the app: nothing to say about payments (they need no app); changes while away notified; back: badge cleared', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(() => {
    window.__shown = [];
    window.__front = false;
    window.__setHidden(true);
  });
  await sleep(1500);
  assert.deepEqual(await shown(), [], 'a Firo payment is on the network once sent: nothing is said on leaving');
  await until(async () => {
    const { rawStore } = await import('./lib/store.js');
    return (await rawStore.keys('w:')).some((k) => k.endsWith(':notify-snapshot'));
  }, null, { label: 'the states saved on leaving' });
  // Sealed (audit A-1): which txids are this wallet's is its private history.
  const stored = await page.evaluate(async () => {
    const { rawStore } = await import('./lib/store.js');
    const k = (await rawStore.keys('w:')).find((x) => x.endsWith(':notify-snapshot'));
    return JSON.stringify(await rawStore.get(k));
  });
  const txids = await page.evaluate(() => window.__campfire.txs().map((t) => t.txid));
  assert.ok(txids.length > 0);
  for (const id of txids) assert.ok(!stored.includes(id.slice(0, 16)), 'no txid in the stored snapshot');
  // While away: a payment sent, the public balance privatized; both confirm in the next fake block.
  const sent = await sendOut('20000000');
  const priv = await privatizeAll();
  await page.waitForFunction(() => window.__shown.length >= 2, null, { timeout: 20000 });
  const titles = await shown();
  assert.ok(titles.includes('Payment sent'), titles.join(' | '));
  assert.ok(titles.includes('Your funds are now private'), titles.join(' | '));
  const urls = await page.evaluate(() => window.__shown.map((x) => x.url));
  assert.ok(urls.includes(`#open=activity&tx=${sent}`) && urls.includes(`#open=activity&tx=${priv}`));
  assert.equal(await page.evaluate(() => window.__badge), 4, 'the four changes since the person last came back (coming back clears it)');
  // Back: the badge is cleared; no reminders are kept for payments.
  await page.evaluate(() => {
    window.__front = true;
    window.__setHidden(false);
  });
  await page.waitForFunction(() => window.__badge === 0);
  await sleep(500);
  assert.deepEqual(await reminders(), []);
});

test('the person chooses: amounts on the lock screen only once turned on; a kind turned off is not told', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('notifications'));
  await waitScreen(page, 'notifications');
  await page.click(tid('notify-amounts'));
  await page.click(tid('notify-kind-out'));
  await until(async () => {
    const { getPrefs } = await import('./lib/store.js');
    const p = await getPrefs();
    return Boolean(p.notify && p.notify.amounts === true && p.notify.kinds.out === false);
  }, null, { label: 'the choices saved' });
  await page.evaluate(() => {
    window.__shown = [];
    window.__front = false;
  });
  await credit('private', '70000000');
  await sendOut('1000000');
  await page.waitForFunction(() => window.__shown.length >= 2, null, { timeout: 15000 });
  await sleep(1500);
  assert.deepEqual(await shown(), ['0.7 FIRO is on its way to you', 'Received 0.7 FIRO'], 'with the amount, as asked; the confirmed send (Money out, off) not told');
  await page.click(tid('notify-amounts'));
  await page.click(tid('notify-kind-out'));
  await page.evaluate(() => (window.__front = true));
});

test('back after a lock: Home says what happened meanwhile, once', { timeout: 5 * 60000 }, async () => {
  await page.evaluate(() => (window.__shown = []));
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  // Leaving saves what the wallet looked like; then the app locks.
  await page.evaluate(() => window.__setHidden(true));
  await sleep(1000);
  await page.evaluate(() => window.__setHidden(false));
  await lock(page);
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await waitSynced(page);
  // Found right after the unlock, before the run caught up: money that came while the app was locked.
  await credit('private', '12000000', { mine: true });
  await page.waitForSelector(tid('home-away'), { timeout: 60000 });
  assert.equal(await page.textContent(tid('home-away-text')), 'While you were away: received a payment (0.12 FIRO).');
  assert.deepEqual(await shown(), [], 'history, not news: no notification for it');
  assert.equal(await page.locator(tid('pay-banner')).count(), 0, 'and no banner');
  await both('notify-03-away');
  await page.click(tid('home-away-close'));
  assert.equal(await page.isVisible(tid('home-away')), false);
  await page.evaluate(() => window.__campfire.go('activity'));
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await sleep(500);
  assert.equal(await page.isVisible(tid('home-away')), false, 'once');
});

test('a tap on a notification opens what it was about; a link to anything else is ignored', { timeout: 3 * 60000 }, async () => {
  const tap = (url) => page.evaluate((u) => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'campfire-open', url: u } })), url);
  const received = await page.evaluate(() => window.__campfire.txs().find((t) => t.direction === 'in').txid);
  await tap(`#open=activity&tx=${received}`);
  await waitScreen(page, 'activity');
  await page.waitForFunction(() => document.querySelector('[data-testid="tx-detail-title"]')?.textContent === 'Received');
  await page.click('.sheet button:text-is("Close")');
  await tap('https://evil.example/#open=home');
  await tap('#open=../../x');
  await sleep(500);
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'activity');
  // Locked: it opens right after the unlock, and the unlock screen says so.
  await page.evaluate(() => window.__campfire.go('home'));
  await lock(page);
  await tap('#open=notifications');
  await page.waitForSelector(tid('unlock-follow'));
  assert.match(await page.textContent(tid('unlock-follow')), /Unlock to see what the notification was about/);
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'notifications', 60000);
});

test('other parts tell through the same notifier: on screen a banner that opens its screen; out of front a notification', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.evaluate(() => (window.__shown = []));
  // Through the app object the screens use.
  const tellVia = (opts) => page.evaluate(async (o) => {
    const { tellOther, notifyApp } = await import('./lib/notify.js');
    return tellOther(notifyApp(), o);
  }, opts);
  await tellVia({ kind: 'moves', title: 'Your swap is done', body: '0.01 ETH arrived in your Ethereum wallet.', plainBody: 'It arrived in your Ethereum wallet.', tag: 'near-1', url: '#open=settings', banner: true });
  await page.waitForSelector(tid('pay-banner'));
  assert.equal(await page.textContent(tid('pay-banner-title')), 'Your swap is done');
  assert.deepEqual(await shown(), [], 'in front');
  await page.click(tid('pay-banner-open'));
  await waitScreen(page, 'settings');
  await page.evaluate(() => (window.__front = false));
  await tellVia({ kind: 'moves', title: 'Send your BTC in the next 30 minutes', body: 'The deposit address for your swap stops taking coins then.', tag: 'near-2', url: '#open=nearIntents' });
  assert.deepEqual(await page.evaluate(() => window.__shown.map((n) => [n.title, n.url])), [['Send your BTC in the next 30 minutes', '#open=nearIntents']]);
  await page.evaluate(() => window.__campfire.go('home'));
});

test('app closed: a wake-up shows nothing until "Reminders when Campfire is closed" is on; then the due reminders', { timeout: 3 * 60000 }, async () => {
  // Two reminders left for later: one due now, one not.
  await page.evaluate(async () => {
    const { rawStore } = await import('./lib/store.js');
    const { walletKey } = await import('./lib/wallet_scope.js');
    const { listWallets } = await import('./lib/wallets.js');
    const w = (await listWallets())[0];
    const now = Date.now();
    await rawStore.set(walletKey({ record: w }, 'notify-reminders'), [
      { id: 'rem-near-due', wallet: w.id, kind: 'moves', at: now - 1000, title: 'Send your BTC in the next 30 minutes', body: 'The deposit address for your swap stops taking coins then.', url: '#open=nearIntents' },
      { id: 'rem-near-later', wallet: w.id, kind: 'moves', at: now + 86400000, title: 'Later', body: 'Later', url: 'https://evil.example/' },
    ]);
  });
  const cdp = await ctx.newCDPSession(page);
  const regs = new Map();
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => registrations.forEach((r) => regs.set(r.registrationId, r)));
  await cdp.send('ServiceWorker.enable');
  await sleep(1000);
  const reg = [...regs.values()].find((r) => r.scopeURL.startsWith(srv.url) && !r.isDeleted);
  assert.ok(reg, 'the app has a service worker');
  const wake = () => cdp.send('ServiceWorker.dispatchPeriodicSyncEvent', { origin: new URL(srv.url).origin, registrationId: reg.registrationId, tag: 'campfire-reminders' });
  const swShown = () => page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration()).getNotifications()).map((n) => n.title));
  // Off (the default): the wake-up shows nothing, keeps the reminders, and asks for no more wake-ups.
  await wake();
  await sleep(3000);
  assert.deepEqual((await reminders()).map((r) => r.id).sort(), ['rem-near-due', 'rem-near-later']);
  assert.ok(!(await swShown()).includes('Send your BTC in the next 30 minutes'), 'nothing shown while the switch is off');
  assert.deepEqual(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration()).periodicSync.getTags())), [], 'no wake-ups asked for');
  // Turned on in Settings -> Notifications.
  await page.evaluate(() => window.__campfire.go('notifications'));
  await waitScreen(page, 'notifications');
  await page.click(tid('notify-wakeups'));
  await until(async () => (await (await import('./lib/store.js')).rawStore.get('prefs')).notify.wakeUps === true, null, { label: 'the switch saved' });
  await page.evaluate(() => document.querySelector('[data-testid="notify-wakeups"]').scrollIntoView({ block: 'center' }));
  await both('notify-05-wakeups-on');
  await page.evaluate(() => window.__campfire.go('home'));
  await wake();
  await until(async () => {
    const { rawStore } = await import('./lib/store.js');
    const keys = (await rawStore.keys('w:')).filter((k) => k.endsWith(':notify-reminders'));
    const all = [];
    for (const k of keys) all.push(...((await rawStore.get(k)) || []));
    return all.length === 1 && all[0].id === 'rem-near-later';
  }, null, { timeout: 30000, label: 'the due reminder shown and forgotten' });
  const real = await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration()).getNotifications()).map((n) => ({ title: n.title, url: n.data && n.data.url })));
  console.log(`# service worker notifications: ${JSON.stringify(real)}`);
  assert.deepEqual(real.filter((n) => n.title === 'Send your BTC in the next 30 minutes'), [{ title: 'Send your BTC in the next 30 minutes', url: '#open=nearIntents' }]);
  await cdp.detach();
});

test('a page left in the background locks after the auto-lock time, while still out of sight (audit A-7)', { timeout: 3 * 60000 }, async () => {
  const autoLock = (min) => page.evaluate(async (m) => {
    const { notifyApp } = await import('./lib/notify.js');
    await notifyApp().setPrefs({ autoLockMin: m });
  }, min);
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await autoLock(0.05); // 3 seconds, for the test (Settings offers 1, 5 and 15 minutes)
  await page.evaluate(() => window.__setHidden(true));
  await page.waitForFunction(() => window.__campfire.screen() === 'unlock' && !window.__campfire.running(), null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => document.visibilityState), 'hidden', 'locked out of sight, not on the way back');
  assert.equal(await page.textContent(tid('locked-notice')), 'Locked after 0.05 minutes without use.');
  await page.evaluate(() => window.__setHidden(false));
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await autoLock(5);
});

test('privacy: nothing leaves the device for notifications; no host but the origin (the stand-in reaches no server); no CSP violation; no page error', async () => {
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
