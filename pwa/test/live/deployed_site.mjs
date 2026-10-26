// After every deploy: the DEPLOYED app, real engine, Firo mainnet, headless Chrome, a throwaway wallet
// that holds nothing (nothing is spent, no order is made). Checks the version, no test hooks, Home's
// four tiles, sync (a second node agrees), the sealed engine database, Sell's chooser and form with
// buyfiro.app's live minimum (a quote only), Buy's chooser, Firo nodes (all four public nodes checked
// live), lock and unlock; then page errors, CSP violations and every host contacted.
//
//   node test/live/deployed_site.mjs [url] [version]
//     defaults: https://pwa.buyfiro.app/ and the version in package.json
import { readFileSync } from 'node:fs';
const P = new URL('../../', import.meta.url).pathname;
const { launch, recordedPage, foreignHosts, shot, SHOTS, sleep } = await import(P + 'test/e2e/harness.mjs');
const { createWallet, waitHome, lock, unlockWithPassword } = await import(P + 'test/e2e/flows.mjs');
const SITE = process.argv[2] || 'https://pwa.buyfiro.app/';
const VERSION = process.argv[3] || JSON.parse(readFileSync(P + 'package.json', 'utf8')).version;
const tid = (x) => `[data-testid="${x}"]`;
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const { page, rec } = await recordedPage(ctx, { label: 'deployed' });
const t0 = Date.now();
const ok = (c, m) => console.log(c ? 'PASS' : 'FAIL', m);
try {
  await page.goto(SITE);
  const PW = `live-${Math.random().toString(36).slice(2, 12)}`;
  await createWallet(page, { password: PW });
  await waitHome(page, { timeout: 120000 });
  console.log('home after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  ok((await page.evaluate(async () => (await import('./lib/version.js')).APP_VERSION)) === VERSION, `version ${VERSION}`);
  ok(await page.evaluate(() => typeof window.__campfire === 'undefined'), 'no test hooks in the release');
  for (const t of ['sc-buy', 'sc-sell', 'sc-bridge', 'sc-names']) ok(await page.isVisible(tid(t)), `Home tile ${t}`);
  let st = null;
  for (let i = 0; i < 180; i++) {
    st = await page.evaluate(async () => (await import('./lib/wallet.js')).wallet.state?.sync ?? null).catch(() => null);
    if (st && (st.state === 'synced' || st.state === 'error' || st.state === 'disagree')) break;
    await sleep(1000);
  }
  console.log('sync', JSON.stringify(st).slice(0, 300), 'after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  ok(st && st.state === 'synced', 'synced (a second Firo node agrees on the chain)');
  await shot(page, 'deployed-home');
  const raw = await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => /^campfire-firo-w-/.test(n));
    const out = [];
    for (const name of names) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const s of db.objectStoreNames) {
        const rows = await new Promise((res) => { const t = db.transaction(s).objectStore(s); const k = t.getAllKeys(); const v = t.getAll(); v.onsuccess = () => res(k.result.map((x, i) => [x, v.result[i]])); });
        for (const [k, v] of rows) out.push({ k: String(k), sealed: Boolean(v && v.$sealed === 1), header: k === '__seal' });
      }
      db.close();
    }
    return out;
  });
  ok(raw.length > 0 && raw.every((r) => r.sealed || r.header), `engine database: ${raw.length} rows, all sealed`);
  // Sell: the chooser, then FIRO, the form with a live price.
  await page.click(tid('sc-sell'));
  await page.waitForSelector(tid('sell-choose-firo')).catch(() => null);
  await shot(page, 'deployed-sell-chooser');
  const chooser = await page.$$eval('[data-testid^="sell-choose"]', (els) => els.map((e) => e.dataset.testid));
  console.log('sell chooser', chooser.join(','));
  await page.click(tid(chooser.find((x) => /firo$/.test(x)) || 'sell-choose-firo'));
  await page.waitForTimeout(6000);
  const body = (await page.textContent('main')).replace(/\s+/g, ' ');
  console.log('sell form:', body.slice(0, 400));
  ok(/Smallest sell right now: [\d,]+ FIRO/.test(body), 'Sell form shows buyfiro.app\'s live minimum');
  await shot(page, 'deployed-sell-form');
  await page.goBack().catch(() => {});
  await waitHome(page, { timeout: 30000 }).catch(() => page.goto(SITE));
  await waitHome(page, { timeout: 60000 });
  await page.click(tid('sc-buy'));
  await page.waitForSelector(tid('buy-chooser-title'));
  await shot(page, 'deployed-buy-chooser');
  await page.click(tid('buy-chooser-close'));
  // Firo nodes: the four public nodes, checked live from this browser.
  await page.click(tid('sync-bars'));
  await page.waitForSelector(tid('public-nodes'));
  const hosts = ['electrumx.firo.org', 'electrumx01.firo.org', 'electrumx02.firo.org', 'electrumx03.firo.org'];
  await page.waitForFunction((hs) => hs.every((h) => !/Checking|Not checked/.test(document.querySelector(`[data-testid="node-${h}-state"]`)?.textContent || 'x')), hosts, { timeout: 30000 }).catch(() => {});
  for (const h of hosts) console.log('node', h, '|', (await page.textContent(tid(`node-${h}-state`))).trim());
  ok((await page.textContent('h1')).trim() === 'Firo nodes', 'the signal bars open Firo nodes');
  await shot(page, 'deployed-nodes');
  await page.goBack().catch(() => {});
  await lock(page);
  await unlockWithPassword(page, PW);
  await waitHome(page, { timeout: 120000 });
  ok(true, 'lock + unlock with the password');
  console.log('shots in', SHOTS);
} catch (e) {
  console.log('FAILED', e.message.split('\n')[0]);
  await shot(page, 'deployed-failed').catch(() => {});
} finally {
  console.log('page errors', JSON.stringify(rec.errors).slice(0, 600));
  console.log('csp', JSON.stringify(await page.evaluate(() => window.__cspViolations).catch(() => 'n/a')).slice(0, 400));
  console.log('foreign hosts', JSON.stringify(foreignHosts(rec, SITE)));
  await browser.close();
}
