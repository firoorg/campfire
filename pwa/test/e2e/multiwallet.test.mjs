// Several Firo wallets on one device, end to end: the installed Google Chrome (headless), the
// stand-in Firo engine (no network, no money), throwaway wallets only.
//
//   npm run e2e:multiwallet   (its own build in a temp folder, port 8940)
//
// What it proves:
//   1. Wallet A is created (24 words, Face ID); B is added by restoring 12 words (the stand-in's
//      sample wallet: it has history); C by restoring 24 new words with a BIP39 passphrase. Each
//      has its own record, its own sealed words, its own engine database and its own addresses.
//   2. Switching: Home's wallet name -> a wallet -> its own unlock. Another wallet's password is
//      refused; on the lock screen the picker shows names, no amounts.
//   3. Settings -> Wallets lists them, marks the open one, renames; the primary button fits 375 x 667.
//   4. A reload keeps all three, the last opened first.
//   5. Deleting B (not open) leaves A and C exactly as they were; its engine database is gone.
//   6. Deleting the open wallet brings another up locked, and it opens.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PWA, startServer, launch, recordedPage, addVirtualAuthenticator, waitScreen, shot, sleep, foreignHosts, SHOTS } from './harness.mjs';
import { createWallet, restoreWallet, waitSynced, unlockWithPassword, SAMPLE_WORDS } from './flows.mjs';

const PORT = Number(process.env.CAMPFIRE_MULTIWALLET_PORT || 8940);
const tid = (id) => `[data-testid="${id}"]`;
const pw = (tag) => `${tag}-${randomBytes(6).toString('hex')}`;
const PA = pw('mw-a');
const PB = pw('mw-b');
const PC = pw('mw-c');

let tmp, srv, browser, ctx, page, rec, auth;
const W = {}; // name -> {id, receive}

const wallets = () => page.evaluate(() => window.__campfire.wallets());
const receive = () => page.evaluate(() => window.__campfire.receive());
const engineDbs = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('campfire-firo-w-')).sort());

/** The app's own store ("campfire-firo-app"): every key and value. */
function kvDump() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('campfire-firo-app');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const t = db.transaction('kv', 'readonly');
          const s = t.objectStore('kv');
          const keys = s.getAllKeys();
          const vals = s.getAll();
          t.oncomplete = () => {
            db.close();
            const out = {};
            keys.result.forEach((k, i) => (out[String(k)] = JSON.stringify(vals.result[i])));
            resolve(out);
          };
        };
      }),
  );
}

async function both(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function fitsSmallPhone(selector, label) {
  const size = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 667 });
  await sleep(250);
  const box = await page.locator(selector).first().boundingBox();
  await page.setViewportSize(size);
  assert.ok(box && box.y >= 0 && box.y + box.height <= 667, `${label}: the primary button is visible at 375 x 667 (${JSON.stringify(box)})`);
}

async function openSwitcher() {
  await page.click(tid('wallet-chip'));
  await page.waitForSelector(tid('switcher'));
}

async function startAdd(expectName) {
  await openSwitcher();
  await page.click(tid('switch-add'));
  await waitScreen(page, 'addWallet');
  await page.waitForFunction((n) => document.querySelector('[data-testid="add-name"]').value === n, expectName, { timeout: 30000 });
}

async function homeOf(name) {
  await waitScreen(page, 'home', 60000);
  await page.waitForFunction((n) => document.querySelector('[data-testid="wallet-name"]')?.textContent === n, name, { timeout: 30000 });
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-multiwallet-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  ({ page, rec } = await recordedPage(ctx, { label: 'mw' }));
  auth = await addVirtualAuthenticator(page);
  console.log(`# screenshots: ${SHOTS}`);
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('1. A created (24 words, Face ID); B restored (12 words); C restored with a passphrase; each its own', { timeout: 10 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PA, passkey: true, shots: 'mw-a' });
  await homeOf('Wallet 1');
  await waitSynced(page);
  W.A = { id: (await wallets())[0].id, receive: await receive() };
  assert.equal((await page.evaluate(() => window.__campfire.record())).words, 24);
  // Face ID is on, yet showing the words takes the password: never Face ID alone (public audit, P2).
  await page.evaluate(() => window.__campfire.go('backup'));
  await waitScreen(page, 'backup');
  await page.click(tid('show-words'));
  await page.waitForSelector(tid('auth-pw'));
  assert.equal(await page.locator(tid('auth-passkey')).count(), 0, 'no Face ID for the words');
  assert.match(await page.textContent(tid('auth-password-only')), /This needs your password: Face ID cannot do it\./);
  await both('mw-a-words-password-only');
  await page.click(tid('auth-cancel'));
  await page.evaluate(() => window.__campfire.go('home'));
  await homeOf('Wallet 1');

  await startAdd('Wallet 2');
  await page.fill(tid('add-name'), 'Savings');
  await page.click(tid('add-restore'));
  await waitScreen(page, 'restore');
  await page.fill(tid('word-1'), SAMPLE_WORDS.join(' '));
  await page.waitForFunction(() => !document.querySelector('[data-testid="restore-submit"]').disabled);
  await page.click(tid('restore-submit'));
  await waitScreen(page, 'setPassword');
  // Never offered to the browser's password manager, and the screen says why (audit A-4).
  for (const f of ['pw1', 'pw2']) assert.equal(await page.getAttribute(tid(f), 'autocomplete'), 'off', f);
  assert.match(await page.textContent(tid('pw-not-saved')), /choose Never: there it would sit next to the wallet it opens/);
  // Long enough and not a first guess, named as it is typed (audit A-3); the old rule took both.
  for (const [weak, state] of [['Password2024!', 'common'], ['qwertyuiop1', 'run']]) {
    await page.fill(tid('pw1'), weak);
    await page.fill(tid('pw2'), weak);
    await page.waitForFunction((st) => document.querySelector('[data-testid="pw-hint"]').dataset.state === st, state);
    assert.equal(await page.isDisabled(tid('save-password')), true, weak);
  }
  await page.fill(tid('pw2'), '');
  await page.fill(tid('pw1'), 'k7#vQ2!x');
  assert.equal(await page.getAttribute(tid('pw-hint'), 'data-state'), 'short', '8 characters are not enough any more');
  await page.fill(tid('pw1'), PB);
  await page.fill(tid('pw2'), PB);
  await page.click(tid('save-password'));
  await page.waitForFunction(() => ['passkeySetup', 'home'].includes(document.getElementById('app').dataset.screen));
  if ((await page.evaluate(() => document.getElementById('app').dataset.screen)) === 'passkeySetup') await page.click(tid('passkey-skip'));
  await homeOf('Savings');
  await waitSynced(page);
  const b = await page.evaluate(() => window.__campfire.balance());
  assert.equal(b.private.available, '309980000', "the sample wallet's history came back");
  W.B = { id: (await wallets()).find((x) => x.name === 'Savings').id, receive: await receive() };

  await startAdd('Wallet 3');
  await page.click(tid('add-create'));
  await waitScreen(page, 'backup');
  await page.click('[data-testid="advanced"] summary');
  await page.fill(tid('passphrase'), 'extra word');
  await page.click(tid('reveal'));
  const words = await page.$$eval('[data-testid="words"] .word span:last-child', (els) => els.map((e) => e.textContent));
  // Typed twice, and it can be shown (public audit, P10): a typo is caught before the wallet is made.
  await page.fill(tid('passphrase2'), 'extra wrod');
  assert.equal(await page.isDisabled(tid('wrote-down')), true, 'two different passphrases: not yet');
  assert.equal(await page.textContent(tid('passphrase-hint')), 'The two passphrases are not the same yet.');
  await page.check(tid('passphrase-show'));
  assert.equal(await page.getAttribute(tid('passphrase'), 'type'), 'text');
  // Only the passphrase section: never a picture of the words, not even a throwaway wallet's.
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await page.locator(tid('advanced')).screenshot({ path: join(SHOTS, `mw-c-passphrase-twice-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.fill(tid('passphrase2'), 'extra word');
  assert.equal(await page.isDisabled(tid('wrote-down')), false);
  await page.click(tid('wrote-down'));
  for (const pos of await page.$$eval('[data-position]', (els) => els.map((e) => Number(e.dataset.position)))) await page.click(`[data-position="${pos}"] [data-word="${words[pos - 1]}"]`);
  await page.click(tid('confirm-words'));
  await waitScreen(page, 'setPassword');
  await page.fill(tid('pw1'), PC);
  await page.fill(tid('pw2'), PC);
  await page.click(tid('save-password'));
  await page.waitForFunction(() => ['passkeySetup', 'home'].includes(document.getElementById('app').dataset.screen));
  if ((await page.evaluate(() => document.getElementById('app').dataset.screen)) === 'passkeySetup') await page.click(tid('passkey-skip'));
  await homeOf('Wallet 3');
  await waitSynced(page);
  assert.equal((await page.evaluate(() => window.__campfire.record())).passphrase, true);
  W.C = { id: (await wallets()).find((x) => x.name === 'Wallet 3').id, receive: await receive() };

  assert.equal(new Set([W.A.receive.spark, W.B.receive.spark, W.C.receive.spark]).size, 3, 'three wallets, three addresses');

  // B's words once more: already here, said before any password, and no fourth wallet (PN).
  await startAdd('Wallet 4');
  await page.click(tid('add-restore'));
  await waitScreen(page, 'restore');
  await page.fill(tid('word-1'), SAMPLE_WORDS.join(' '));
  await page.waitForFunction(() => !document.querySelector('[data-testid="restore-submit"]').disabled);
  await page.click(tid('restore-submit'));
  await page.waitForSelector(tid('restore-same-words'));
  assert.match(await page.textContent(tid('restore-same-words')), /^These words are already on this device as "Savings"\. Open that wallet instead/);
  assert.equal(await page.evaluate(() => document.getElementById('app').dataset.screen), 'restore', 'no password asked');
  assert.equal((await wallets()).length, 3);
  await page.evaluate(() => {
    for (const i of document.querySelectorAll('[data-testid^="word-"]')) i.value = '';
    window.__campfire.go('home');
  });
  await homeOf('Wallet 3');
  assert.deepEqual(await engineDbs(), [W.A.id, W.B.id, W.C.id].map((id) => `campfire-firo-w-${id}`).sort(), 'one engine database each');
  const dump = await kvDump();
  for (const v of Object.values(dump)) for (const word of words) assert.ok(!v.includes(`"${word} `) && !v.includes(` ${word} `), 'no recovery word stored in the clear');
  // No balance kept for the switcher (audit A-1): the sample history's 3.0998 FIRO is nowhere.
  assert.deepEqual(Object.keys(dump).filter((k) => k.endsWith(':balance')), []);
  for (const v of Object.values(dump)) assert.ok(!v.includes('309980000'), 'no balance stored in the clear');
  await both('mw-01-home-wallet3');
});

test("2. switching: Home's name -> a wallet -> its own unlock; another wallet's password refused", { timeout: 5 * 60000 }, async () => {
  await openSwitcher();
  const rows = await page.$$eval('[data-testid="switch-row"]', (els) => els.map((e) => e.dataset.name));
  assert.deepEqual(rows, ['Savings', 'Wallet 1', 'Wallet 3']);
  assert.equal(await page.textContent('[data-testid="switch-row"][data-name="Savings"] .s'), 'Locked', 'another wallet: no amount kept for it');
  await both('mw-02-switcher');
  await page.click('[data-testid="switch-row"][data-name="Savings"]');
  await waitScreen(page, 'unlock');
  assert.match(await page.textContent(tid('unlock-lead')), /Unlock Savings/);
  assert.equal(await page.getAttribute(tid('unlock-pw'), 'autocomplete'), 'off');
  assert.ok(await page.isVisible(tid('pw-not-saved')), 'the line under the field says why the browser should not keep it');
  await page.fill(tid('unlock-pw'), PC);
  await page.click(tid('unlock-submit'));
  await page.waitForSelector('[data-testid="unlock-submit"]:not([disabled])');
  assert.match(await page.textContent('#app'), /didn't open the wallet/);
  await unlockWithPassword(page, PB);
  await homeOf('Savings');
  assert.equal((await receive()).spark, W.B.receive.spark);
  // The lock screen's picker: names only.
  await page.click(tid('lock'));
  await waitScreen(page, 'unlock');
  await page.click(tid('unlock-wallet-pick'));
  await page.waitForSelector(tid('switcher'));
  const text = await page.textContent(tid('switcher'));
  assert.ok(!/FIRO/.test(text), 'no amounts on the lock screen');
  await page.click('[data-testid="switch-row"][data-name="Wallet 1"]');
  await waitScreen(page, 'unlock');
  // Wallet 1 has Face ID: it opens with it.
  await page.click(tid('unlock-passkey'));
  await homeOf('Wallet 1');
});

test('3. Settings -> Wallets: the list, the open one marked, rename', { timeout: 5 * 60000 }, async () => {
  await page.click(tid('menu'));
  await waitScreen(page, 'settings');
  await page.click(tid('wallets-row'));
  await waitScreen(page, 'wallets');
  await page.waitForSelector('[data-testid="wallet-row"][data-open="true"]');
  assert.equal(await page.getAttribute('[data-testid="wallet-row"][data-open="true"]', 'data-name'), 'Wallet 1');
  await fitsSmallPhone(tid('wallets-add'), 'Wallets');
  await both('mw-03-wallets');
  await page.click('[data-testid="wallet-row"][data-name="Wallet 1"]');
  await page.click(tid('wallet-rename'));
  await page.fill(tid('rename-input'), 'Everyday');
  await page.click(tid('rename-save'));
  await page.waitForSelector('[data-testid="wallet-row"][data-name="Everyday"]');
  await page.click('[data-testid="wallet-row"][data-name="Wallet 3"]');
  await page.click(tid('wallet-rename'));
  await page.fill(tid('rename-input'), 'everyday');
  await page.click(tid('rename-save'));
  await page.waitForSelector('.sheet .notice');
  assert.match(await page.textContent('.sheet'), /already have a wallet named/);
  await page.click('.sheet >> text=Cancel');
});

test('4. a reload keeps all three; the last opened comes first', { timeout: 5 * 60000 }, async () => {
  await page.reload();
  await waitScreen(page, 'unlock', 60000);
  assert.match(await page.textContent(tid('unlock-lead')), /Unlock Everyday/);
  assert.equal((await wallets()).length, 3);
  await unlockWithPassword(page, PA);
  await homeOf('Everyday');
  assert.equal((await receive()).spark, W.A.receive.spark);
});

test('5. deleting B (not open) leaves A and C exactly as they were; its engine database goes', { timeout: 5 * 60000 }, async () => {
  const before = await kvDump();
  await page.evaluate(() => window.__campfire.go('wallets'));
  await page.click('[data-testid="wallet-row"][data-name="Savings"]');
  await page.click(tid('wallet-delete'));
  await waitScreen(page, 'deleteWallet');
  assert.match(await page.textContent(tid('delete-others')), /Only Savings is deleted/);
  await page.fill(tid('delete-confirm'), 'DELETE');
  await page.click(tid('delete-submit'));
  await waitScreen(page, 'wallets');
  const after = await kvDump();
  for (const [k, v] of Object.entries(before)) {
    if (k.startsWith(`w:${W.B.id}:`)) continue;
    if (k === 'prefs') continue;
    assert.equal(after[k], v, `${k} is untouched`);
  }
  assert.ok(!Object.keys(after).some((k) => k.startsWith(`w:${W.B.id}:`)), "nothing of B's is left");
  assert.deepEqual(await engineDbs(), [W.A.id, W.C.id].map((id) => `campfire-firo-w-${id}`).sort());
});

test('6. deleting the open wallet brings the other up locked, and it opens', { timeout: 5 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('deleteWallet'));
  await waitScreen(page, 'deleteWallet');
  // It has Face ID: where its passkey is, and that Campfire asks the password manager to forget it (audit A-9).
  await page.waitForSelector(tid('delete-passkey'));
  assert.match(await page.textContent(tid('delete-passkey')), new RegExp(`BEAM Campfire wallet ${W.A.id.slice(0, 6)}.*Campfire asks it to forget the key`));
  assert.equal(await page.locator(tid('delete-traces')).count(), 0, 'not the last wallet: clearing site data would take the others');
  const before = (await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId })).credentials.length;
  await page.fill(tid('delete-confirm'), 'DELETE');
  await page.click(tid('delete-submit'));
  await waitScreen(page, 'unlock');
  const after = (await auth.cdp.send('WebAuthn.getCredentials', { authenticatorId: auth.authenticatorId })).credentials.length;
  assert.deepEqual([before, after], [1, 0], 'the password manager was told the passkey is gone (WebAuthn signalUnknownCredential), and dropped it');
  assert.match(await page.textContent(tid('deleted-notice')), /Everyday was deleted/);
  await unlockWithPassword(page, PC);
  await homeOf('Wallet 3');
  assert.equal((await receive()).spark, W.C.receive.spark);
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});

/** The page out of sight (the app switcher, another app) and back, as the browser tells it. */
async function hiddenAndBack() {
  await page.evaluate(() => {
    const set = (hidden) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    set(true);
    set(false);
  });
}

test('7. secrets leave the screen when the app does: the words, the Spark view key, the xpub (audit A-5)', { timeout: 5 * 60000 }, async () => {
  // Settings -> Backup -> Show my recovery words: the sheet closes; Face ID or the password shows them again.
  await page.evaluate(() => window.__campfire.go('backup'));
  await waitScreen(page, 'backup');
  await page.click(tid('show-words'));
  await page.fill(tid('auth-pw'), PC);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(tid('words-done'));
  await page.click(tid('reveal'));
  assert.equal(await page.locator('[data-testid="words"] .word').count(), 24);
  assert.equal(await page.textContent(tid('words-passphrase-text')), 'extra word', 'the passphrase is shown with the words (P10)');
  await hiddenAndBack();
  assert.equal(await page.locator(tid('words-done')).count(), 0, 'the words sheet is gone');
  assert.equal(await page.locator('[data-testid="words"]').count(), 0, 'no word left on the page');
  assert.equal(await page.locator(tid('words-passphrase-text')).count(), 0, 'nor the passphrase');

  // The Spark view key and the xpub: gone, the button back to "Show my view key". (The stand-in
  // engine has no keys to export: these stand in for them.)
  await page.evaluate(async () => {
    const { wallet } = await import('./lib/wallet.js');
    wallet.exportSparkViewKey = async () => 'ab'.repeat(64);
    wallet.exportXpub = async () => 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz';
  });
  await page.evaluate(() => window.__campfire.go('viewKey'));
  await waitScreen(page, 'viewKey');
  await page.click(tid('view-key-show'));
  await page.fill(tid('auth-pw'), PC);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(tid('view-key'));
  await page.click(tid('xpub-show'));
  await page.fill(tid('auth-pw'), PC);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(tid('xpub'));
  await hiddenAndBack();
  assert.equal(await page.locator(tid('view-key')).count(), 0, 'the view key is gone');
  assert.equal(await page.locator(tid('xpub')).count(), 0, 'the xpub is gone');
  assert.equal(await page.textContent(tid('view-key-show')), 'Show my view key');
  assert.ok(await page.isVisible(tid('xpub-show')));

  // A new wallet's words (create, step 1): blurred again; a tap shows them again.
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await openSwitcher();
  await page.click(tid('switch-add'));
  await waitScreen(page, 'addWallet');
  await page.click(tid('add-create'));
  await waitScreen(page, 'backup');
  await page.waitForSelector('[data-testid="words"] .word');
  await page.click(tid('reveal'));
  assert.equal(await page.getAttribute(tid('words'), 'class'), 'words');
  await hiddenAndBack();
  assert.match(await page.getAttribute(tid('words'), 'class'), /hidden-words/, 'blurred again');
  assert.ok(await page.isVisible(tid('reveal')), 'with the tap to show them');
  await page.click(tid('reveal'));
  assert.equal(await page.isDisabled(tid('wrote-down')), false);
  assert.deepEqual(rec.errors, []);
});

test('8. deleting the last wallet also takes Campfire\'s settings in this browser (audit A-9)', { timeout: 5 * 60000 }, async () => {
  await page.evaluate(() => {
    localStorage.setItem('campfire-theme', 'dark');
    localStorage.setItem('campfire-update-source', JSON.stringify('https://mirror.example/campfire/'));
    localStorage.setItem('not-campfire', 'stays');
  });
  await page.evaluate(() => window.__campfire.go('deleteWallet'));
  await waitScreen(page, 'deleteWallet');
  await page.waitForSelector(tid('delete-traces'));
  assert.match(await page.textContent(tid('delete-traces')), /clear this site's data in the browser's settings/);
  assert.equal(await page.locator(tid('delete-passkey')).count(), 0, 'no Face ID on this one');
  await page.fill(tid('delete-confirm'), 'DELETE');
  await page.click(tid('delete-submit'));
  await waitScreen(page, 'welcome');
  const left = await page.evaluate(() => Object.keys(localStorage).sort());
  assert.deepEqual(left, ['not-campfire']);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme || null), null, 'the theme follows the device again');
  assert.deepEqual(await engineDbs(), []);
  assert.deepEqual(await kvDump(), {});
  assert.ok(!(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).includes('campfire-firo-spark-cache'));
  assert.deepEqual(rec.errors, []);
});
