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
import { createWallet, waitHome, waitSynced } from './flows.mjs';

const PORT = 8851;
const tid = (id) => `[data-testid="${id}"]`;
const HOSTS = ['electrumx.firo.org', 'electrumx01.firo.org', 'electrumx02.firo.org', 'electrumx03.firo.org'];
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
  await createWallet(page, { password: `nodes-${Math.random().toString(36).slice(2, 12)}` });
  await waitHome(page);
  await waitSynced(page);
  await page.evaluate(() => globalThis.__firoFake.nodeDown('electrumx03.firo.org'));
  await page.click(tid('sync-bars'));
  await waitScreen(page, 'servers');
  assert.equal((await page.textContent('h1')).trim(), 'Firo nodes');
  assert.equal(await page.textContent(tid('servers-mode')), "Firo's public nodes");
  // Your own node: what that means for trust, said before it is chosen (P16).
  assert.match(await page.textContent(tid('own-node-trust')), /^Campfire then believes that node completely: what it says has arrived, been confirmed or left is checked with no other node\./);
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

test('privacy: no host but the origin (the stand-in answers every node check); no page error', async () => {
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(rec.errors, []);
});
