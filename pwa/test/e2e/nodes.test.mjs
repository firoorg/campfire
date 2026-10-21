// Firo nodes (owner, 2026-10-12): the sync status lists Firo's public nodes, each checked when the
// screen opens (newest block, answer time, or not answering), with "Use this one" in case the one in
// use is dead; Home offers the way there when the node is down. Nodes only serve public chain data,
// and a person's own node is never cross-checked with a public one (the engine's unit tests).
//
//   npm run e2e:nodes   (stand-in engine, own build folder and port 8851; no network at all)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced, unlockWithPassword } from './flows.mjs';

const PORT = 8851;
const tid = (id) => `[data-testid="${id}"]`;
const HOSTS = ['electrumx.firo.org', 'electrumx01.firo.org', 'electrumx02.firo.org', 'electrumx03.firo.org'];
const PASSWORD = `nodes-${Math.random().toString(36).slice(2, 12)}`;
let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-nodes-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  ({ page, rec } = await recordedPage(ctx, { label: 'nodes' }));
  console.log(`# screenshots: ${SHOTS}`);
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

const stateOf = (host) => page.textContent(tid(`node-${host}-state`));

test('the signal bars open Firo nodes: all four public nodes, the one in use, the others checked; a dead one says so', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await waitSynced(page);
  await page.evaluate(() => globalThis.__firoFake.nodeDown('electrumx03.firo.org'));
  await page.click(tid('sync-bars'));
  await waitScreen(page, 'servers');
  assert.equal((await page.textContent('h1')).trim(), 'Firo nodes');
  assert.equal(await page.textContent(tid('servers-mode')), "Firo's public nodes");
  // Your own node: what that means for trust, said before it is chosen (P16).
  assert.match(await page.textContent(tid('own-node-trust')), /^Firo PWA then believes that node completely: what it says has arrived, been confirmed or left is checked with no other node\./);
  for (const host of HOSTS) await page.waitForSelector(tid(`node-${host}`));
  const inUse = (await page.textContent(tid('servers-connected'))).trim();
  assert.ok(HOSTS.includes(inUse), `connected to one of Firo's public nodes: ${inUse}`);
  await page.waitForFunction((hosts) => hosts.every((h) => !/Checking|Not checked/.test(document.querySelector(`[data-testid="node-${h}-state"]`)?.textContent || 'x')), HOSTS, { timeout: 15000 });
  assert.match(await stateOf(inUse), /^In use · block [\d,]+$/);
  assert.equal(await page.locator(tid(`node-${inUse}-use`)).count(), 0, 'no "Use this one" on the node in use');
  for (const host of HOSTS.filter((x) => x !== inUse && x !== 'electrumx03.firo.org')) assert.match(await stateOf(host), /^Block\u00a0[\d,]+ · (\d+\u00a0ms|\d+\.\d\u00a0s)$/);
  if (inUse !== 'electrumx03.firo.org') {
    assert.equal(await stateOf('electrumx03.firo.org'), 'Not answering');
    assert.equal(await page.locator(tid('node-electrumx03.firo.org-use')).count(), 0, 'a node that does not answer is not offered');
  }
  assert.match(await page.textContent(tid('public-nodes')), /They only serve public chain data: your keys, signing and private proofs stay on this device\./);
  // Nothing of a node's line is cut off beside its button (a real node can take 900+ ms).
  const cut = await page.$$eval('[data-testid$="-state"]', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.dataset.testid));
  assert.deepEqual(cut, []);
  await both('nodes-01-list');
});

test('"Use this one": the wallet moves to that node now, and the others stay behind it', { timeout: 3 * 60000 }, async () => {
  let target = null;
  for (const h of HOSTS) if (!target && h !== 'electrumx03.firo.org' && (await page.locator(tid(`node-${h}-use`)).count())) target = h;
  assert.ok(target, 'a node to move to');
  await page.click(tid(`node-${target}-use`));
  await page.waitForFunction((h) => (document.querySelector('[data-testid="servers-connected"]')?.textContent || '').trim() === h, target, { timeout: 30000 });
  await page.waitForFunction((h) => /^In use/.test(document.querySelector(`[data-testid="node-${h}-state"]`)?.textContent || ''), target, { timeout: 30000 });
  // Still the one in use after leaving the screen and coming back (the order is unit-tested).
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('sync-bars'));
  await waitScreen(page, 'servers');
  assert.equal((await page.textContent(tid('servers-connected'))).trim(), target);
  await both('nodes-02-moved');
});

test('"Use this one" mid-sync: a tap held as long as a finger holds it lands, and says "Connecting…" at once, under the list', { timeout: 3 * 60000 }, async () => {
  // A syncing wallet renders this screen several times a second (owner, 2026-10-21: "I click on it.
  // Nothing happens"): the rows were built again between finger down and up, so the tap fell on none.
  await page.evaluate(async () => {
    const { wallet } = await import('./lib/wallet.js');
    globalThis.__emitter = setInterval(() => wallet.emit(), 40);
  });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid$="-use"]')].some((b) => !b.disabled), null, { timeout: 15000 });
  const from = (await page.textContent(tid('servers-connected'))).trim();
  const target = await page.evaluate(() => [...document.querySelectorAll('[data-testid$="-use"]')].find((b) => !b.disabled).dataset.testid.replace(/^node-|-use$/g, ''));
  await page.evaluate(() => globalThis.__firoFake.slowSwitch(1500));
  await page.click(tid(`node-${target}-use`), { delay: 250 });
  // At once: the row says it, its button can't be tapped twice, and the message is in sight.
  await page.waitForFunction((h) => document.querySelector(`[data-testid="node-${h}-state"]`)?.textContent === 'Connecting…', target, { timeout: 2000 });
  assert.equal(await page.isDisabled(tid(`node-${target}-use`)), true);
  assert.match(await page.textContent(tid('node-msg')), new RegExp(`^Connecting to ${target.replace(/\./g, '\\.')}… Your coins and history stay as they are\.$`));
  const box = await page.locator(tid('node-msg')).boundingBox();
  assert.ok(box && box.y + box.height <= 844, `the message is in sight (${JSON.stringify(box)})`);
  await both('nodes-04-connecting');
  await page.waitForFunction((h) => (document.querySelector('[data-testid="servers-connected"]')?.textContent || '').trim() === h, target, { timeout: 30000 });
  assert.notEqual(target, from);
  await page.evaluate(() => clearInterval(globalThis.__emitter));
});

test('Home: when the node stops answering, "Choose another Firo node" is right under the status', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  assert.equal(await page.locator(tid('sync-choose-node')).count(), 0, 'not while synced');
  await page.evaluate(() => globalThis.__firoFake.offline(true));
  await page.waitForSelector(tid('sync-choose-node'), { timeout: 60000 });
  await both('nodes-03-home-offline');
  await page.click(tid('sync-choose-node'));
  await waitScreen(page, 'servers');
  await page.evaluate(() => globalThis.__firoFake.offline(false));
});

test('Home: private FIRO one node showed counts in the balance, said as such; the second node\'s check is shown with how far it is; Send says it waits for it', { timeout: 2 * 60000 }, async () => {
  // Owner, 2026-10-21: "Private balance 0, +3500 private, shown by the Firo node. Why 0?", then "Can you
  // show the private balance that confirmed by the first node? ... show as well the status of the second node".
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.evaluate(() => globalThis.__firoFake.proving(350000000000n, 136000, 341167));
  await page.waitForSelector(tid('private-proof'));
  assert.equal(await page.textContent(tid('balance-private')), '3,500 FIRO');
  assert.equal(await page.textContent(tid('balance-checking')), 'Private includes 3,500 FIRO shown by one Firo node, not sendable until a second one confirms it (39% checked)');
  assert.equal(await page.locator(tid('balance-pending')).count(), 0, 'not said a second time as arriving');
  assert.equal(
    await page.textContent(tid('private-proof')),
    'Second Firo node check: 39%. 3,500 FIRO can be sent once it is done. The first check can take about half an hour, and runs only while Firo PWA is open and unlocked.Stay unlocked until it is done',
  );
  await both('nodes-05-home-proving');
  // A node whose lists do not add up: the coins it showed leave the figure and wait, as before (P4).
  await page.evaluate(() => globalThis.__firoFake.privateCheck('set-mismatch'));
  await page.waitForSelector(tid('private-check'));
  assert.equal(await page.textContent(tid('balance-private')), '0 FIRO');
  assert.equal(await page.locator(tid('balance-checking')).count(), 0);
  assert.match(await page.textContent(tid('balance-pending')), /^\+3,500 private, shown by the Firo node, being checked with a second one$/);
  await page.evaluate(() => globalThis.__firoFake.privateCheck(null));
  await page.waitForSelector(tid('balance-checking'));
  // Send: the private side offers what can be sent now, and says what waits for the check.
  await page.click(tid('send'));
  await waitScreen(page, 'send');
  await page.waitForSelector(tid('from-checking'));
  assert.equal(await page.textContent(tid('from-checking')), '3,500 FIRO more can be sent once a second Firo node has checked it (39% done).');
  await shot(page, 'nodes-07-send-checking');
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.waitForSelector(tid('private-proof'));
  // The auto-lock (and a dark screen) stopped the check long before it was done: on a tap, the wallet
  // stays unlocked while it runs in sight. Auto-lock at 3 s for the test; it looks every 15 s.
  const autoLock = (m) => page.evaluate(async (x) => (await import('./lib/notify.js')).notifyApp().setPrefs({ autoLockMin: x }), m);
  await autoLock(0.05);
  await page.click(tid('private-proof-awake'), { delay: 150 });
  await page.waitForSelector(tid('private-proof-awake-stop'));
  assert.match(await page.textContent(tid('private-proof')), /^Second Firo node check: 39%\. Firo PWA stays unlocked until it is done, for about an hour at most(, with the screen kept on)?\. Hiding or closing Firo PWA, or Lock, ends this\.Stop: lock as usual$/);
  await both('nodes-06-home-awake');
  await sleep(20000);
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'home', 'still unlocked after 20 s without a touch');
  assert.ok(await page.evaluate(() => window.__campfire.running()));
  // Stop: the usual rules at once.
  await page.click(tid('private-proof-awake-stop'));
  await page.waitForFunction(() => window.__campfire.screen() === 'unlock', null, { timeout: 30000 });
  await autoLock(5);
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  // The check done: the note goes, and so would the waiting auto-lock.
  await page.evaluate(() => globalThis.__firoFake.proving(350000000000n, 341167, 341167));
  await page.waitForSelector(tid('private-proof'));
  await page.evaluate(() => globalThis.__firoFake.proving(0));
  await page.waitForSelector(tid('private-proof'), { state: 'detached' });
});

test('privacy: no host but the origin (the stand-in answers every node check); no page error', async () => {
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(rec.errors, []);
});
