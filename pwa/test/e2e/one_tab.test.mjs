// One tab at a time, end to end: the installed Google Chrome (headless), two pages of the SAME
// browser context (one origin, one IndexedDB), the stand-in Firo engine (no network, no money),
// throwaway wallets only.
//
//   node --test --test-concurrency=1 test/e2e/one_tab.test.mjs
//   (its own build in a temp folder, port 8992; CAMPFIRE_ONETAB_PORT to change it)
//
// Two tabs on one wallet ran two engines over its one store (cursors, coins, spent marks, sends)
// and both wrote the shared Spark cache and the app's records.
//
// What it proves:
//   1. Tab 2 shows "open in another tab": no IndexedDB opened, no node contacted, and no way into a
//      wallet (asking for Welcome or the words lands on the same screen).
//   2. "Use it here instead": tab 1 locks (its engine stops and closes its store) and says "moved";
//      tab 2 unlocks wallet A, which has its addresses and its history.
//   3. Tab 2 creates wallet B. Every write tab 1 tries (the app store, a wallet's engine store) is
//      refused, and both wallets' records and engine data are exactly as tab 2 left them.
//   4. A holder that does not answer (its page paused in the debugger: Chrome does not freeze a
//      visible page, and a paused page runs no task, as a frozen one): "Take over anyway" after the
//      wait; once it runs again it says it moved, has stopped, and writes nothing; both wallets open.
//   5. The holder closes: a tab showing "open in another tab" goes on by itself to Unlock.
//   Both screens at 390 px, light and dark; the primary button fits a 375 x 667 phone.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PWA, startServer, launch, recordedPage, waitScreen, shot, sleep, SHOTS } from './harness.mjs';
import { createWallet, finishProtect, waitSynced, unlockWithPassword } from './flows.mjs';

const PORT = Number(process.env.CAMPFIRE_ONETAB_PORT || 8992);
const tid = (id) => `[data-testid="${id}"]`;
const pw = (tag) => `${tag}-${randomBytes(6).toString('hex')}`;
const PA = pw('ot-a');
const PB = pw('ot-b');

let tmp, srv, browser, ctx, p1, p2, rec2;
const W = {};

const screenOf = (p) => p.evaluate(() => document.getElementById('app').dataset.screen);
const tabState = (p) => p.evaluate(() => window.__campfire.oneTab());

/** Every key of an IndexedDB database's "kv" store with a hash of its value (read directly). */
function dump(p, name) {
  return p.evaluate(
    (n) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open(n);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.close();
            return resolve({});
          }
          const t = db.transaction('kv', 'readonly');
          const s = t.objectStore('kv');
          const keys = s.getAllKeys();
          const vals = s.getAll();
          t.oncomplete = async () => {
            db.close();
            const out = {};
            for (let i = 0; i < keys.result.length; i++) {
              const text = JSON.stringify(vals.result[i], (_, v) => (typeof v === 'bigint' ? `${v}n` : ArrayBuffer.isView(v) ? Array.from(v) : v));
              const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text || '')));
              out[String(keys.result[i])] = Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
            }
            resolve(out);
          };
        };
      }),
    name,
  );
}
const engineDbs = (p) => p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('campfire-firo-w-')).sort());

/** The app store and every wallet's engine database. */
async function everything(p) {
  const out = { app: await dump(p, 'campfire-firo-app') };
  for (const n of await engineDbs(p)) out[n] = await dump(p, n);
  return out;
}

async function both(p, name) {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(p, `${name}-${scheme}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
}

async function fitsSmallPhone(p, selector, label) {
  const size = p.viewportSize();
  await p.setViewportSize({ width: 375, height: 667 });
  await sleep(250);
  const box = await p.locator(selector).first().boundingBox();
  await p.setViewportSize(size);
  assert.ok(box && box.y >= 0 && box.y + box.height <= 667, `${label}: the primary button is visible at 375 x 667 (${JSON.stringify(box)})`);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-onetab-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  ({ page: p1 } = await recordedPage(ctx, { label: 'tab1' }));
  console.log(`# screenshots: ${SHOTS}`);
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('1. a second tab shows "open in another tab": no IndexedDB, no node, no way into a wallet', { timeout: 5 * 60000 }, async () => {
  await p1.goto(srv.url);
  await createWallet(p1, { password: PA });
  await waitSynced(p1);
  W.A = { id: (await p1.evaluate(() => window.__campfire.wallets()))[0].id, receive: await p1.evaluate(() => window.__campfire.receive()) };
  const t1 = await tabState(p1);
  assert.equal(t1.state, 'held');
  assert.equal(t1.mode, 'locks');
  assert.ok(t1.clientId);

  ({ page: p2, rec: rec2 } = await recordedPage(ctx, { label: 'tab2' }));
  await p2.addInitScript(() => {
    window.__idbUsed = [];
    const f = window.indexedDB;
    const open = f.open.bind(f);
    const del = f.deleteDatabase.bind(f);
    const where = () => String(new Error().stack).split('\n').slice(2, 6).join(' | ');
    f.open = (n, v) => (window.__idbUsed.push(`${n} <- ${where()}`), v === undefined ? open(n) : open(n, v));
    f.deleteDatabase = (n) => (window.__idbUsed.push(`delete ${n} <- ${where()}`), del(n));
  });
  await p2.goto(srv.url);
  await waitScreen(p2, 'otherTab', 60000);
  await sleep(1500);
  assert.equal((await tabState(p2)).state, 'busy');
  assert.deepEqual(await p2.evaluate(() => window.__idbUsed), [], 'tab 2 opened no IndexedDB database (no app store, no wallet store, no Spark cache)');
  assert.deepEqual(rec2.websockets, [], 'no node contacted');
  assert.equal(await p2.textContent('.one-tab h1'), 'Firo PWA is open in another tab');
  assert.equal(await p2.textContent('.one-tab .hero p'), 'It works in one tab at a time, so your wallet data stays intact.');
  assert.equal(await p2.textContent(tid('one-tab-use-here')), 'Use it here instead');
  for (const s of ['welcome', 'backup', 'restore', 'unlock', 'home']) {
    await p2.evaluate((n) => window.__campfire.go(n), s);
    assert.equal(await screenOf(p2), 'otherTab', `asking for ${s} in tab 2`);
  }
  assert.deepEqual(await p2.evaluate(() => window.__idbUsed), []);
  await both(p2, 'onetab-01-other-tab');
  await fitsSmallPhone(p2, tid('one-tab-use-here'), 'open in another tab');
  assert.equal(await screenOf(p1), 'home', 'tab 1 carries on');
});

test('2. "Use it here instead": tab 1 locks, stops its engine and says it moved; tab 2 opens wallet A as it was', { timeout: 5 * 60000 }, async () => {
  const txsA = await p1.evaluate(() => window.__campfire.txs().length);
  await p2.click(tid('one-tab-use-here'));
  await waitScreen(p1, 'movedTab', 60000);
  const t1 = await tabState(p1);
  assert.equal(t1.state, 'gone');
  assert.equal(t1.how, 'handed');
  assert.equal(await p1.evaluate(() => window.__campfire.running()), false, "tab 1's engine stopped");
  assert.equal(await p1.textContent('.one-tab h1'), 'Firo PWA moved to another tab');
  assert.equal(await p1.textContent('.one-tab .hero p'), 'It works in one tab at a time. Your wallet was locked and saved here before it moved.');
  await both(p1, 'onetab-02-moved');
  await fitsSmallPhone(p1, tid('one-tab-use-here'), 'moved to another tab');
  for (const s of ['unlock', 'welcome', 'home']) {
    await p1.evaluate((n) => window.__campfire.go(n), s);
    assert.equal(await screenOf(p1), 'movedTab', `asking for ${s} in tab 1`);
  }

  await waitScreen(p2, 'unlock', 60000);
  assert.equal((await tabState(p2)).state, 'held');
  await unlockWithPassword(p2, PA);
  await waitScreen(p2, 'home', 60000);
  await waitSynced(p2);
  assert.deepEqual(await p2.evaluate(() => window.__campfire.receive()), W.A.receive, "wallet A's addresses in tab 2");
  assert.equal(await p2.evaluate(() => window.__campfire.txs().length), txsA);
});

let kept;
test('3. the reported case: tab 2 creates wallet B; nothing tab 1 tries is written, nothing is deleted or reverted', { timeout: 5 * 60000 }, async () => {
  await p2.click(tid('wallet-chip'));
  await p2.waitForSelector(tid('switcher'));
  await p2.click(tid('switch-add'));
  await waitScreen(p2, 'addWallet');
  await p2.click(tid('add-create'));
  await waitScreen(p2, 'backup');
  await p2.waitForSelector('[data-testid="words"] .word');
  await p2.click(tid('reveal'));
  const words = await p2.$$eval('[data-testid="words"] .word span:last-child', (els) => els.map((e) => e.textContent));
  await p2.click(tid('wrote-down'));
  await waitScreen(p2, 'confirmWords');
  for (const pos of await p2.$$eval('[data-position]', (els) => els.map((e) => Number(e.dataset.position)))) await p2.click(`[data-position="${pos}"] [data-word="${words[pos - 1]}"]`);
  words.fill('');
  await p2.click(tid('confirm-words'));
  await finishProtect(p2, { password: PB, passkey: false });
  await waitScreen(p2, 'home', 60000);
  await p2.waitForFunction(() => document.querySelector('[data-testid="wallet-name"]')?.textContent === 'Wallet 2', null, { timeout: 30000 });
  await waitSynced(p2);
  const list = await p2.evaluate(() => window.__campfire.wallets());
  assert.deepEqual(list.map((w) => w.name).sort(), ['Wallet 1', 'Wallet 2']);
  W.B = { id: list.find((w) => w.name === 'Wallet 2').id };
  // Wallet B stays open in tab 2; its engine may still be writing: wait until nothing changes.
  let before = await everything(p2);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const now = await everything(p2);
    if (JSON.stringify(now) === JSON.stringify(before)) break;
    before = now;
  }
  assert.ok(before[`campfire-firo-w-${W.A.id}`] && before[`campfire-firo-w-${W.B.id}`], 'both wallets have engine data');

  // Tab 1 tries to write through each path: the app store (records, prefs) and each wallet's engine store.
  assert.deepEqual(await p1.evaluate((id) => window.__campfire.writeProbe(id), W.A.id), { app: 'other_tab', engine: 'other_tab' });
  assert.deepEqual(await p1.evaluate((id) => window.__campfire.writeProbe(id), W.B.id), { app: 'other_tab', engine: 'other_tab' });
  const after = await everything(p2);
  assert.deepEqual(after[`campfire-firo-w-${W.A.id}`], before[`campfire-firo-w-${W.A.id}`], "wallet A's engine data is exactly as it was");
  assert.deepEqual(after.app, before.app, 'the records, envelopes and prefs are exactly as they were');
  // The holder writes as before.
  assert.deepEqual(await p2.evaluate((id) => window.__campfire.writeProbe(id), W.B.id), { app: 'ok', engine: 'ok' });
  kept = Object.keys(await everything(p2)).sort();
});

test('4. a holder that does not answer: "Take over anyway"; once it runs again it says it moved, has stopped, and writes nothing; both wallets open', { timeout: 5 * 60000 }, async () => {
  const cdp2 = await ctx.newCDPSession(p2);
  await cdp2.send('Debugger.enable');
  await cdp2.send('Debugger.pause');
  try {
    await p1.click(tid('one-tab-use-here'));
    await p1.waitForSelector(tid('one-tab-status'));
    assert.match(await p1.textContent(tid('one-tab-status')), /Waiting for the other tab to lock your wallet and save it/);
    await shot(p1, 'onetab-03-waiting-light');
    const t0 = Date.now();
    await p1.waitForSelector(tid('one-tab-steal'), { timeout: 30000 });
    const waited = Date.now() - t0;
    assert.ok(waited >= 8000, `"Take over anyway" came after the wait (${waited} ms)`);
    assert.match(await p1.textContent(tid('one-tab-note')), /The other tab isn't answering\. It may be asleep in the background\./);
    assert.equal(await p1.textContent(tid('one-tab-steal')), 'Take over anyway');
    await both(p1, 'onetab-04-not-answering');
    await fitsSmallPhone(p1, tid('one-tab-steal'), 'not answering');
    await p1.click(tid('one-tab-steal'));
    await waitScreen(p1, 'unlock', 60000);
    assert.equal((await tabState(p1)).state, 'held');
    assert.equal((await tabState(p1)).spent, false);
  } finally {
    await cdp2.send('Debugger.resume');
    await cdp2.send('Debugger.disable').catch(() => {});
  }
  await waitScreen(p2, 'movedTab', 60000);
  assert.equal((await tabState(p2)).how, 'stolen');
  assert.equal(await p2.textContent('.one-tab .hero p'), 'It works in one tab at a time. Another tab took it over, so your wallet is locked here.');
  await p2.waitForFunction(() => !window.__campfire.running(), null, { timeout: 60000 });
  assert.deepEqual(await p2.evaluate((id) => window.__campfire.writeProbe(id), W.B.id), { app: 'other_tab', engine: 'other_tab' }, 'the tab whose lock was taken writes nothing');
  await both(p2, 'onetab-05-moved-stolen');
  assert.deepEqual(Object.keys(await everything(p1)).sort(), kept, 'both wallets are still stored');

  // Both wallets open in tab 1: the last opened (B) first, then A from the switcher.
  await unlockWithPassword(p1, PB);
  await waitScreen(p1, 'home', 60000);
  await p1.waitForFunction(() => document.querySelector('[data-testid="wallet-name"]')?.textContent === 'Wallet 2', null, { timeout: 30000 });
  await waitSynced(p1);
  await p1.click(tid('wallet-chip'));
  await p1.click('[data-testid="switch-row"][data-name="Wallet 1"]');
  await unlockWithPassword(p1, PA);
  await waitScreen(p1, 'home', 60000);
  await waitSynced(p1);
  assert.deepEqual(await p1.evaluate(() => window.__campfire.receive()), W.A.receive, 'wallet A opens with its addresses');
});

test('5. the tab holding the wallet closes: a tab showing "open in another tab" goes on by itself (to Unlock)', { timeout: 3 * 60000 }, async () => {
  const { page: p3 } = await recordedPage(ctx, { label: 'tab3' });
  await p3.goto(srv.url);
  await waitScreen(p3, 'otherTab', 60000);
  await p1.close();
  // A free lock is taken only with ifAvailable (never a place in a queue), checked every 2 s.
  await waitScreen(p3, 'unlock', 30000);
  assert.equal((await tabState(p3)).state, 'held');
  assert.equal(await screenOf(p2), 'movedTab', 'the tab that lost the wallet earlier stays as it is (it reloads only when asked)');
});
