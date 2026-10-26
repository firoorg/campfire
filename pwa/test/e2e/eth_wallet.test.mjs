// The Ethereum wallet end-to-end, through the screens: the installed Google
// Chrome (headless), the dev server with the production headers, a throwaway
// Firo wallet on the stand-in engine (lib/backend_fake.js: no network, spends
// nothing), and Ethereum on the local anvil mainnet fork.
//
//   npm run e2e:eth   (builds dist-fake/ with the stand-in engine, runs this file)
//
// The app's Ethereum server is Stack Wallet's, as in production; Playwright
// routes that host to the fork (adding CORS headers) so the CSP and the app
// code are exactly what ships. Every other Ethereum host is refused here, so
// nothing can reach mainnet. Stack Wallet's history index (/export) answers
// with one made-up incoming payment.
//
// Under the shared fork lock, with evm_snapshot / evm_revert: anvil_setBalance,
// rsFIRO taken from the Rosen bridge's lock address by impersonating it, then
// 0.01 ETH and 12.5 rsFIRO sent through Send -> review -> password -> status, with receipts and
// balances checked on the fork. Screenshots of every Ethereum screen at
// 390x844 and 1280x800, light and dark, into $CAMPFIRE_SHOTS. Never a
// screenshot of revealed words. Also a server that says the account's nonce
// moved on: the status screen says "Not sure yet" (never "Replaced") until
// the fork shows the transaction that took the nonce.
//
// Then a wallet imported from a fresh random private key (never printed):
// the one import box tells it is a key, says what is wrong with a bad one,
// shows the address before anything is saved; Home opens that address; the
// Backup shows the key only after the password, and locking leaves it nowhere
// in the page (DOM and JS heap). Those screens at 375 px, light and dark,
// into $CAMPFIRE_ETHKEY_SHOTS, with every key painted over.
import { BSC_RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { join } from 'node:path';
import { startServer, launch, recordedPage, shot, waitScreen, foreignHosts, sleep, SHOTS } from './harness.mjs';
import { createWallet, waitHome, unlockWithPassword } from './flows.mjs';
import { ANVIL, JUNK, ACCOUNT0, raw, anvilProblem, withFork, setBalance, sendAs, erc20Balance, freshAddress, mined } from '../fork/fork_support.mjs';
import { ethKeyFromMnemonic, wipe, toChecksumAddress, privateKeyToAddress } from '../../src/lib/eth/crypto.js';
import { signTransaction } from '../../src/lib/eth/tx.js';
import { bytesToHex, hexToBytes } from '../../src/lib/eth/hex.js';
import { encodeCall } from '../../src/lib/eth/abi.js';
import { ETH_RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import { RSFIRO } from '../../src/lib/eth/tokens.js';

/** The Rosen bridge's lock address on Ethereum: it holds the rsFIRO not yet bridged out. */
const ROSEN_LOCK = '0x451698faa07fc68301af622a3ad42205f13c6e4b';

const PORT = Number(process.env.CAMPFIRE_ETH_PORT || 8840);
const PASSWORD = `eth-${Math.random().toString(36).slice(2, 10)}`;
const BSC_HOSTS = BSC_RPC_HOSTS.map((x) => x.host);
const STACK = 'eth2.stackwallet.com';
const ETHER = 10n ** 18n;
const tid = (id) => `[data-testid="${id}"]`;
const skip = await anvilProblem();
const KEY_SHOTS = process.env.CAMPFIRE_ETHKEY_SHOTS || join(SHOTS, 'ethkey');
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KEY_WARNING = 'This wallet has no recovery words. The private key is the only way back to it: keep it somewhere safe and never share it.';

let srv, browser, ctx, page, rec;
let mode = 'fork'; // 'fork' | 'down' | 'lie' (the account's 'latest' nonce answered one too high)
const rpcMethods = [];
let exportAsks = 0; // GET /export: Stack Wallet's history index asked about the address
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

async function stackRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (mode === 'down') return route.fulfill({ status: 503, headers: { ...cors, 'content-type': 'text/plain' }, body: 'unavailable' });
  if (req.method() === 'GET' && url.pathname === '/export') {
    exportAsks++;
    // The index: one made-up 1 ETH payment in, long ago; no token history (an empty body, as the index answers).
    if (url.searchParams.get('emitter')) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: '' });
    const me = url.searchParams.get('addrs');
    const data = [{ blockHash: `0x${'b1'.repeat(32)}`, blockNumber: 22000000, from: '0x1111111111111111111111111111111111111111', to: me, gas: 21000, gasPrice: 1000000000, gasUsed: 21000, hash: `0x${'e1'.repeat(32)}`, nonce: 3, receipt: { effectiveGasPrice: 1000000000, gasUsed: 21000, logs: [], status: 1 }, timestamp: 1767225600, value: '1000000000000000000' }];
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ data }) });
  }
  if (req.method() !== 'POST') return route.fulfill({ status: 404, headers: cors, body: '' });
  const body = req.postData();
  try {
    const j = JSON.parse(body);
    for (const m of [].concat(j)) rpcMethods.push(m.method);
  } catch {
    /* not JSON: anvil says so */
  }
  const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  let text = await r.text();
  if (mode === 'lie') {
    // A server that says the account's nonce moved on (nothing else changed): the D-04 proof.
    const asked = [].concat(JSON.parse(body));
    const lie = (a) => {
      const c = asked.find((x) => x.id === a.id);
      return c && c.method === 'eth_getTransactionCount' && c.params[1] === 'latest' && a.result ? { ...a, result: `0x${(BigInt(a.result) + 1n).toString(16)}` } : a;
    };
    const answer = JSON.parse(text);
    text = JSON.stringify(Array.isArray(answer) ? answer.map(lie) : lie(answer));
  }
  return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: text });
}

/** One screen, four ways: phone and desktop, light and dark. */
async function shots4(name) {
  // A toast from the step before would cover what is being looked at.
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  for (const scheme of ['light', 'dark']) {
    for (const [w, hh] of [[390, 844], [1280, 800]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: w, height: hh });
      await sleep(120);
      await shot(page, `eth-${name}-${w}-${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
}

/**
 * One state at 375 px, light and dark, into KEY_SHOTS. `masks`: selectors of
 * anything that shows a key (typed or revealed), painted over in the picture.
 * `focus`: scrolled into view first.
 */
async function keyShots(name, { masks = [], focus = null } = {}) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(KEY_SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 375, height: 812 });
    if (focus) await page.locator(focus).first().scrollIntoViewIfNeeded();
    await sleep(150);
    await page.screenshot({ path: join(KEY_SHOTS, `ethkey-${name}-375-${scheme}.png`), mask: masks.map((m) => page.locator(m)), maskColor: '#8a8f98' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
}

/** A random valid secp256k1 key, 64 lowercase hex: only ever typed into the page, never printed. */
function randomKeyHex() {
  for (;;) {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const hex = bytesToHex(b, false);
    wipe(b);
    const k = BigInt(`0x${hex}`);
    if (k > 0n && k < SECP_N) return hex;
  }
}

/**
 * How many of `needles` occur in the page's JS heap, after a full garbage
 * collection. A string built with += is a "(concatenated string)" in a heap
 * snapshot, its text only in the pieces, so those are joined again from their
 * first/second edges; a sliced string counts as its whole parent.
 */
async function inHeap(needles) {
  const cdp = await page.context().newCDPSession(page);
  let snap;
  try {
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const chunks = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    snap = JSON.parse(chunks.join(''));
  } finally {
    await cdp.detach().catch(() => {});
  }
  const { meta } = snap.snapshot;
  const NF = meta.node_fields.length;
  const EF = meta.edge_fields.length;
  const [nType, nName, nEdges] = ['type', 'name', 'edge_count'].map((f) => meta.node_fields.indexOf(f));
  const [eType, eName, eTo] = ['type', 'name_or_index', 'to_node'].map((f) => meta.edge_fields.indexOf(f));
  const types = meta.node_types[0];
  const edgeTypes = meta.edge_types[0];
  const { nodes, edges, strings } = snap;
  const count = nodes.length / NF;
  const firstEdge = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) firstEdge[i + 1] = firstEdge[i] + nodes[i * NF + nEdges] * EF;
  const memo = new Map();
  const CAP = 4096;
  const text = (i, depth = 0) => {
    if (memo.has(i)) return memo.get(i);
    const type = types[nodes[i * NF + nType]];
    let out = '';
    if (type === 'string') out = strings[nodes[i * NF + nName]];
    else if ((type === 'concatenated string' || type === 'sliced string') && depth < 4000) {
      const parts = {};
      for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
        if (edgeTypes[edges[e + eType]] !== 'internal') continue;
        parts[strings[edges[e + eName]]] = edges[e + eTo] / NF;
      }
      if (type === 'sliced string') out = parts.parent !== undefined ? text(parts.parent, depth + 1) : '';
      else out = `${parts.first !== undefined ? text(parts.first, depth + 1) : ''}${parts.second !== undefined ? text(parts.second, depth + 1) : ''}`;
    }
    out = out.length > CAP ? out.slice(0, CAP) : out;
    memo.set(i, out);
    return out;
  };
  const found = new Set();
  for (let i = 0; i < count && found.size < needles.length; i++) {
    const type = types[nodes[i * NF + nType]];
    if (type !== 'string' && type !== 'concatenated string' && type !== 'sliced string') continue;
    const t = text(i);
    needles.forEach((n, j) => t.includes(n) && found.add(j));
  }
  return found.size;
}

async function ethHomeReady() {
  await waitScreen(page, 'ethHome');
  await page.waitForSelector(`${tid('eth-status')}[data-state="ok"]`, { timeout: 60000 });
}

before(async () => {
  srv = await startServer({ root: 'dist-fake', port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route((u) => u.hostname === STACK, stackRoute);
  // Nothing may reach a real Ethereum server.
  await ctx.route((u) => ETH_RPC_HOSTS.some((x) => x.host === u.hostname && x.host !== STACK) || u.hostname === 'api.coingecko.com', (r) => r.abort());
  // Nor a real BNB Chain server: the EVM wallet shows both chains, so it asks the chosen BSC one too.
  await ctx.route((u) => BSC_HOSTS.includes(u.hostname), (r) => r.abort());
  ({ page, rec } = await recordedPage(ctx, { label: 'eth' }));
  console.log(`# screenshots: ${SHOTS}`);
});

after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
});

test('a Firo wallet; no Ethereum code is loaded until Ethereum is opened', { skip: skip || false, timeout: 10 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await page.waitForSelector(tid('chain-firo'));
  await page.waitForSelector(tid('chain-eth'));
  // Only lib/eth/record.js (whether there is an Ethereum wallet: a store key, no crypto) and the lazy
  // registry. (vendor/noble's BIP39 is the Firo wallet's own now: its words are made with it.)
  const loaded = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /\/lib\/eth\/(?!record\.js)|\/vendor\/noble\/noble-curves\/|\/screens\/eth_(?!screens)/.test(e.name)).map((e) => e.name));
  assert.deepEqual(loaded, [], 'first paint carries no Ethereum code');
  await shots4('00-firo-home-switcher');
});

let createdAddress = null;

test('create an Ethereum wallet: 12 new words, 3 checked, the privacy notice, then its Home', { skip: skip || false, timeout: 3 * 60000 }, async () => {
  await page.click(tid('chain-eth'));
  await waitScreen(page, 'ethStart');
  await page.waitForSelector(tid('eth-create'));
  await shots4('01-start');
  await page.click(tid('eth-create'));
  await waitScreen(page, 'ethWords');
  await page.waitForSelector('[data-testid="words"] .word');
  assert.match(await page.textContent('.step'), /Step 1 of 3/);
  await shots4('02-words-hidden'); // blurred: no picture of words, ever
  await page.click(tid('reveal'));
  const words = await page.$$eval('[data-testid="words"] .word span:last-child', (els) => els.map((e) => e.textContent));
  assert.equal(words.length, 12);
  await page.click(tid('eth-wrote-down'));
  await waitScreen(page, 'ethConfirm');
  await page.waitForSelector('[data-position]');
  assert.match(await page.textContent('.step'), /Step 2 of 3/);
  await shots4('03-confirm');
  const positions = await page.$$eval('[data-position]', (els) => els.map((e) => Number(e.dataset.position)));
  assert.equal(positions.length, 3);
  // One wrong pick first: the screen says which word, and blames nobody.
  const wrongWord = await page.$eval(`[data-position="${positions[0]}"]`, (el, right) => [...el.querySelectorAll('[data-word]')].map((b) => b.dataset.word).find((w) => w !== right), words[positions[0] - 1]);
  await page.click(`[data-position="${positions[0]}"] [data-word="${wrongWord}"]`);
  for (const pos of positions.slice(1)) await page.click(`[data-position="${pos}"] [data-word="${words[pos - 1]}"]`);
  await page.click(tid('eth-confirm-words'));
  await page.waitForSelector('.notice.error');
  assert.match(await page.textContent('.notice.error'), new RegExp(`not word #${positions[0]}`));
  await shots4('04-confirm-wrong');
  await page.click(`[data-position="${positions[0]}"] [data-word="${words[positions[0] - 1]}"]`);
  await page.click(tid('eth-confirm-words'));
  await waitScreen(page, 'ethPrivacy');
  await page.waitForSelector(tid('eth-connect'));
  assert.match(await page.textContent('.step'), /Step 3 of 3/);
  assert.match(await page.textContent(tid('eth-privacy-text')), /Stack Wallet's.*sees your IP address together with your Ethereum address/);
  // The BNB Chain server is asked about the same address: named too (release audit 0.1.5, K1).
  assert.match(await page.textContent(tid('eth-privacy-bsc')), /^So does the BNB Chain server, BNB Chain \(official\): your address is the same on BNB Chain/);
  await shots4('05-privacy');
  await page.click(tid('eth-ip-how'));
  await page.click(`${tid('eth-privacy-more')} summary`);
  await shots4('06-privacy-details');
  const requestsBefore = rpcMethods.length;
  assert.equal(requestsBefore, 0, 'nothing asked of any Ethereum server before Connect');
  await page.click(tid('eth-connect'));
  await ethHomeReady();
  const { sk, address } = await ethKeyFromMnemonic(words.join(' '));
  wipe(sk);
  createdAddress = address;
  assert.equal(await page.getAttribute(tid('eth-address'), 'data-address'), address, 'the address of the 12 words (m/44\'/60\'/0\'/0/0)');
  assert.equal(await page.getAttribute(tid('eth-balance'), 'data-wei'), '0');
  // The words are not stored; the address is not in the clear either.
  const stored = await page.evaluate(async () => {
    const { store } = await import('./lib/store.js');
    return JSON.stringify(await store.get('eth'));
  });
  // Values only: key names such as "path" and "kind" are BIP39 words too.
  const values = [];
  JSON.parse(stored, (k, v) => (typeof v === 'string' && values.push(v), v));
  for (const w of new Set(words)) assert.ok(!values.includes(w), 'no word in storage');
  assert.ok(!stored.includes(words.join(' ')), 'nor the phrase');
  assert.ok(!stored.toLowerCase().includes(address.slice(2).toLowerCase()), 'the address only inside the sealed envelope');
  await page.waitForSelector(tid('eth-activity'));
  await shots4('07-home-empty');
  assert.equal(await page.textContent(`${tid('eth-receive')}`), 'Receive ETH or BNB', 'nothing to send: Receive is the primary');
});

test('receive: the address and a QR code that decodes to it', { skip: skip || false, timeout: 60000 }, async () => {
  await page.click(tid('eth-receive'));
  await waitScreen(page, 'ethReceive');
  await page.waitForSelector('.qr svg');
  assert.equal(await page.getAttribute(tid('eth-receive-address'), 'data-address'), createdAddress);
  const img = await page.evaluate(async () => {
    const svgEl = document.querySelector('.qr svg');
    const blob = new Blob([new XMLSerializer().serializeToString(svgEl)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const im = new Image();
    await new Promise((r, j) => ((im.onload = r), (im.onerror = j), (im.src = url)));
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 400;
    c.getContext('2d').drawImage(im, 0, 0, 400, 400);
    return Array.from(c.getContext('2d').getImageData(0, 0, 400, 400).data);
  });
  assert.equal(jsQR(Uint8ClampedArray.from(img), 400, 400).data, createdAddress);
  await shots4('08-receive');
});

test('Backup says the Ethereum & BNB wallet is not in the Firo words or file, with the way to its own backup (P11)', { skip: skip || false, timeout: 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('backup'));
  await waitScreen(page, 'backup');
  await page.waitForSelector(tid('eth-not-included'));
  assert.match(await page.textContent(tid('eth-not-included')), /^Your Ethereum & BNB wallet is not in these words or the file\. It has its own words or private key: back it up in its settings too/);
  await shots4('05-backup-eth-not-included');
  await page.click(tid('eth-backup-go'));
  await waitScreen(page, 'ethSettings');
  await page.evaluate(() => window.__campfire.go('ethHome'));
});

test('Settings -> Ethereum & BNB; Delete says both sets of words; Remove asks for the password', { skip: skip || false, timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('eth-settings-row'));
  await waitScreen(page, 'ethSettings');
  await page.waitForSelector(tid('eth-backup'));
  // One server row per chain, each naming the server in use (the defaults here).
  assert.equal(await page.getAttribute(tid('eth-server-row'), 'data-server'), 'stackwallet', "Stack Wallet's server by default");
  assert.match(await page.textContent(tid('eth-server-row')), /Ethereum server.*Stack Wallet/);
  assert.equal(await page.getAttribute(tid('bsc-server-row'), 'data-server'), 'bsc-bnbchain', "BNB Chain's official server by default");
  assert.match(await page.textContent(tid('bsc-server-row')), /BNB Chain server.*BNB Chain \(official\)/);
  assert.equal(await page.isChecked(tid('eth-history-switch')), true, 'history on by default');
  assert.match(await page.textContent(tid('eth-backup')), /Your Ethereum words are your backup.*12 words/);
  await shots4('09-settings');
  await page.click(tid('eth-privacy-row'));
  await waitScreen(page, 'ethPrivacy');
  await page.waitForSelector(tid('eth-privacy-done'));
  await shots4('10-privacy-from-settings');
  await page.click(tid('eth-privacy-done'));
  await waitScreen(page, 'ethSettings');

  await page.evaluate(() => window.__campfire.go('deleteWallet'));
  await page.waitForSelector(tid('delete-eth-words'));
  assert.match(await page.textContent(tid('delete-eth-words')), /Ethereum wallet is removed too.*both sets of words/);
  await shots4('11-delete-both-words');

  await page.evaluate(() => window.__campfire.go('ethSettings'));
  await page.waitForSelector(tid('eth-remove'));
  await page.click(tid('eth-remove'));
  await page.waitForSelector(tid('eth-remove-confirm'));
  await shots4('12-remove-sheet');
  await page.click(tid('eth-remove-confirm'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), 'not the password');
  await page.click(tid('auth-submit'));
  await page.waitForSelector('.sheet .notice.error');
  assert.ok(await page.evaluate(async () => Boolean(await (await import('./lib/store.js')).store.get('eth'))), 'a wrong password removes nothing');
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await waitScreen(page, 'settings');
  assert.equal(await page.evaluate(async () => (await (await import('./lib/store.js')).store.get('eth')) ?? null), null, 'the sealed key is gone');
});

test('import "test test ... junk": 12 words checked as typed, privacy, Home with its address', { skip: skip || false, timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('chain-eth'));
  await waitScreen(page, 'ethStart');
  await page.click(tid('eth-import'));
  await waitScreen(page, 'ethImport');
  await page.waitForSelector(tid('eth-words-input'));
  assert.match(await page.textContent('.step'), /Step 1 of 2/);
  await shots4('13-import-empty');
  await page.fill(tid('eth-words-input'), 'test test test test test test test test test test test jnuk');
  assert.match(await page.textContent(tid('eth-words-hint')), /Word #12 isn't one of the words/);
  await page.fill(tid('eth-words-input'), 'junk test test test test test test test test test test test');
  assert.match(await page.textContent(tid('eth-words-hint')), /don't fit together/);
  assert.equal(await page.isDisabled(tid('eth-import-submit')), true);
  await shots4('14-import-checksum');
  await page.fill(tid('eth-words-input'), `  ${JUNK.toUpperCase()}  `);
  assert.match(await page.textContent(tid('eth-words-hint')), /12 words\. They check out\./);
  await page.click(`${tid('eth-advanced')} summary`);
  await shots4('15-import-ready-advanced');
  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.waitForSelector(tid('eth-connect'));
  assert.match(await page.textContent('.step'), /Step 2 of 2/);
  await page.click(tid('eth-connect'));
  await ethHomeReady();
  assert.equal(await page.getAttribute(tid('eth-address'), 'data-address'), ACCOUNT0);
});

test('on the fork: 0.01 ETH and 12.5 rsFIRO sent through the screens; receipts and balances exact', { skip: skip || false, timeout: 6 * 60000 }, () =>
  withFork(async () => {
    const to = toChecksumAddress(freshAddress());
    await setBalance(ACCOUNT0, 5n * ETHER);
    await sendAs(ROSEN_LOCK, RSFIRO.address, encodeCall('transfer(address,uint256)', [ACCOUNT0, 100n * 10n ** 8n]));
    const rs0 = await erc20Balance(RSFIRO.address, ACCOUNT0);

    await page.evaluate(() => window.__campfire.go('ethHome'));
    await ethHomeReady();
    await page.waitForSelector(`${tid('eth-balance')}[data-wei="${5n * ETHER}"]`, { timeout: 30000 });
    await page.waitForSelector(`${tid('eth-token-row')}[data-symbol="rsFIRO"]`);
    assert.equal(await page.getAttribute(`${tid('eth-token-row')}[data-symbol="rsFIRO"] ${tid('eth-token-balance')}`, 'data-units'), String(rs0));
    await page.waitForSelector(`${tid('eth-activity-row')}[data-hash="0x${'e1'.repeat(32)}"]`);
    await shots4('16-home-funded');
    // With ETH, getting rsFIRO (FIRO on Ethereum) is the one primary button.
    assert.equal(await page.textContent(tid('eth-buy-rsfiro')), 'Buy rsFIRO');
    assert.match(await page.getAttribute(tid('eth-buy-rsfiro'), 'class'), /btn-primary/);
    assert.equal(await page.locator('.eth-actions .btn-primary').count(), 1);

    // Send: refusals in words first.
    await page.click(tid('eth-send'));
    await waitScreen(page, 'ethSend');
    await page.waitForSelector(tid('eth-send-to'));
    await page.waitForFunction(() => !/Checking/.test(document.querySelector('[data-testid="eth-send-fee"]').textContent), null, { timeout: 30000 });
    const typo = to.replace(/[a-f]/, (c) => c.toUpperCase());
    await page.fill(tid('eth-send-to'), typo === to ? to.replace(/[A-F]/, (c) => c.toLowerCase()) : typo);
    await page.waitForFunction(() => /doesn't add up/.test(document.querySelector('[data-testid="eth-to-hint"]').textContent));
    await shots4('17-send-checksum');
    await page.fill(tid('eth-send-to'), RSFIRO.address);
    await page.waitForFunction(() => /token's own contract/.test(document.querySelector('[data-testid="eth-to-hint"]').textContent));
    await page.fill(tid('eth-send-to'), to);
    await page.fill(tid('eth-send-amount'), '0.01');
    await page.waitForFunction(() => document.querySelector('[data-testid="eth-send-review"]').textContent === 'Send 0.01 ETH');
    await shots4('18-send-filled');
    await page.click(tid('eth-send-review'));
    await page.waitForSelector(tid('eth-review-send'));
    assert.equal(await page.textContent(tid('eth-review-amount')), '0.01 ETH');
    assert.equal(await page.getAttribute(tid('eth-review-to'), 'data-address'), to);
    assert.match(await page.textContent(tid('eth-review-fee')), /^about [0-9.]+ ETH$/);
    assert.match(await page.textContent(tid('eth-review-fee-max')), /^at most [0-9.]+ ETH$/);
    assert.equal(await page.textContent(tid('eth-review-send')), 'Send 0.01 ETH');
    await shots4('19-review');
    const sendsBefore = rpcMethods.filter((m) => m === 'eth_sendRawTransaction').length;
    await page.click(tid('eth-review-send'));
    await page.waitForSelector(tid('auth-pw'));
    await shots4('20-review-password');
    await page.fill(tid('auth-pw'), PASSWORD);
    await page.click(tid('auth-submit'));
    await waitScreen(page, 'ethTx');
    await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 60000 });
    assert.equal(rpcMethods.filter((m) => m === 'eth_sendRawTransaction').length, sendsBefore + 1, 'one broadcast');
    const hash = await page.getAttribute(tid('eth-tx-hash'), 'data-hash');
    const receipt = await mined(hash);
    assert.equal(receipt.status, '0x1');
    const fee = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    assert.equal(await page.getAttribute(tid('eth-tx-fee'), 'data-wei'), String(fee), 'the fee shown is the fee paid');
    assert.equal(BigInt(await raw('eth_getBalance', [to, 'latest'])), 10n ** 16n);
    assert.equal(BigInt(await raw('eth_getBalance', [ACCOUNT0, 'latest'])), 5n * ETHER - 10n ** 16n - fee);
    assert.equal(await page.getAttribute(tid('eth-tx-explorer'), 'href'), `https://etherscan.io/tx/${hash}`);
    await shots4('21-tx-confirmed');

    // rsFIRO
    await page.click(tid('eth-tx-done'));
    await ethHomeReady();
    await page.waitForSelector(`${tid('eth-activity-row')}[data-hash="${hash}"][data-state="confirmed"]`);
    await page.click(tid('eth-send'));
    await waitScreen(page, 'ethSend');
    await page.waitForSelector(`${tid('eth-send-asset')} option[value="rsFIRO"]`, { state: 'attached' });
    await page.selectOption(tid('eth-send-asset'), 'rsFIRO');
    await page.fill(tid('eth-send-to'), to.toLowerCase());
    await page.fill(tid('eth-send-amount'), '12.5');
    await page.waitForFunction(() => document.querySelector('[data-testid="eth-send-review"]').textContent === 'Send 12.5 rsFIRO');
    await page.click(tid('eth-send-review'));
    await page.waitForSelector(tid('eth-review-send'));
    assert.equal(await page.textContent(tid('eth-review-amount')), '12.5 rsFIRO');
    assert.match(await page.textContent(tid('eth-review-total')), /^12\.5 rsFIRO \+ about [0-9.]+ ETH$/);
    await shots4('22-review-token');
    await page.click(tid('eth-review-send'));
    await page.waitForSelector(tid('auth-pw'));
    await page.fill(tid('auth-pw'), PASSWORD);
    await page.click(tid('auth-submit'));
    await waitScreen(page, 'ethTx');
    await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 60000 });
    const hash2 = await page.getAttribute(tid('eth-tx-hash'), 'data-hash');
    assert.equal((await mined(hash2)).status, '0x1');
    assert.equal(await erc20Balance(RSFIRO.address, to), 1250000000n);
    assert.equal(await erc20Balance(RSFIRO.address, ACCOUNT0), rs0 - 1250000000n);
    await page.click(tid('eth-tx-done'));
    await ethHomeReady();
    await page.waitForSelector(`${tid('eth-activity-row')}[data-hash="${hash2}"]`);
    await page.waitForSelector(`${tid('eth-token-row')}[data-symbol="rsFIRO"] ${tid('eth-token-balance')}[data-units="${rs0 - 1250000000n}"]`, { timeout: 40000 });
    await shots4('23-home-after');

    // The server stops answering: who failed, and two ways out; nothing switches by itself.
    mode = 'down';
    await page.click(tid('eth-receive'));
    await waitScreen(page, 'ethReceive');
    await page.evaluate(() => window.__campfire.go('ethHome'));
    await page.waitForSelector(tid('eth-server-problem'), { timeout: 60000 });
    assert.match(await page.textContent(tid('eth-server-problem')), /Stack Wallet's Ethereum server didn't answer/);
    assert.match(await page.textContent(tid('eth-use-other')), /Use PublicNode instead/);
    await shots4('24-home-server-down');
    mode = 'fork';
    await page.click(tid('eth-retry'));
    await page.waitForSelector(`${tid('eth-status')}[data-state="ok"]`, { timeout: 60000 });
    // The Ethereum server's problem is gone (BNB Chain's servers are refused in this test, and may still be named).
    const left = (await page.isVisible(tid('eth-server-problem'))) ? await page.textContent(tid('eth-server-problem')) : '';
    assert.ok(!/Ethereum server/.test(left), left);
  }));

/** Sends `amount` ETH to `to` through Send -> review -> password; resolves on the status screen with its hash. */
async function sendThroughScreens(to, amount) {
  await page.evaluate(() => window.__campfire.go('ethHome'));
  await ethHomeReady();
  await page.click(tid('eth-send'));
  await waitScreen(page, 'ethSend');
  await page.waitForSelector(tid('eth-send-fee'));
  await page.waitForFunction(() => !/Checking/.test(document.querySelector('[data-testid="eth-send-fee"]').textContent), null, { timeout: 30000 });
  await page.fill(tid('eth-send-to'), to);
  await page.fill(tid('eth-send-amount'), amount);
  await page.waitForFunction((a) => document.querySelector('[data-testid="eth-send-review"]').textContent === `Send ${a} ETH`, amount);
  await page.click(tid('eth-send-review'));
  await page.waitForSelector(tid('eth-review-send'));
  await page.click(tid('eth-review-send'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await waitScreen(page, 'ethTx');
  await page.waitForSelector(`${tid('eth-tx-title')}[data-state="pending"]`, { timeout: 60000 });
  return page.getAttribute(tid('eth-tx-hash'), 'data-hash');
}

test('D-04: a server saying the nonce moved on is "Not sure yet", never "Replaced"; "Replaced" needs the transaction that took it', { skip: skip || false, timeout: 6 * 60000 }, () =>
  withFork(async () => {
    await setBalance(ACCOUNT0, 5n * ETHER);
    await raw('evm_setAutomine', [false]);
    try {
      // 1. The server lies about the nonce while the payment waits: the screen says not to send it again.
      const hash = await sendThroughScreens(toChecksumAddress(freshAddress()), '0.001');
      // While it waits, removing the wallet says what that forgets, and needs a tick (second audit, XR).
      await page.evaluate(() => window.__campfire.go('ethSettings'));
      await page.click(tid('eth-remove'));
      await page.waitForSelector(tid('eth-remove-open'));
      assert.match(await page.textContent(tid('eth-remove-open')), /Firo PWA is still following a transaction from this wallet: the payment of 0\.001 ETH on Ethereum\. Removing the wallet forgets it: if you then send it again, it may go through twice\./);
      assert.equal(await page.isDisabled(tid('eth-remove-confirm')), true, 'off until ticked');
      await page.check(tid('eth-remove-understood'));
      assert.equal(await page.isDisabled(tid('eth-remove-confirm')), false);
      await shots4('24-remove-while-open');
      await page.click('.sheet .btn-text'); // Keep it
      await page.evaluate((h) => window.__campfire.go('ethTx', { hash: h }), hash);
      await page.waitForSelector(`${tid('eth-tx-title')}[data-state="pending"]`, { timeout: 60000 });
      mode = 'lie';
      await page.waitForSelector(`${tid('eth-tx-title')}[data-unsure="true"]`, { timeout: 60000 });
      assert.equal(await page.getAttribute(tid('eth-tx-title'), 'data-state'), 'pending');
      assert.equal(await page.textContent(tid('eth-tx-title')), 'Not sure yet');
      assert.match(await page.textContent('.notice.warn'), /^Don't send it again yet\. Your Ethereum server says another transaction from this wallet took this payment's place, but it can't show that transaction/);
      await shots4('25-tx-not-sure');
      await sleep(9000); // two more looks of the status screen: still not "Replaced"
      assert.equal(await page.getAttribute(tid('eth-tx-title'), 'data-state'), 'pending');
      // It was out there all along: mined, and that is what the screen ends on.
      mode = 'fork';
      await raw('evm_mine');
      await page.waitForSelector(`${tid('eth-tx-title')}[data-state="confirmed"]`, { timeout: 60000 });
      assert.equal(await page.getAttribute(tid('eth-tx-title'), 'data-unsure'), null);
      assert.equal((await mined(hash)).status, '0x1');

      // 2. Another transaction from this wallet takes the nonce (another device): shown, checked, named.
      const second = await sendThroughScreens(toChecksumAddress(freshAddress()), '0.002');
      const sent = await raw('eth_getTransactionByHash', [second]);
      await raw('anvil_dropTransaction', [second]);
      const { sk } = await ethKeyFromMnemonic(JUNK);
      const other = signTransaction({ nonce: BigInt(sent.nonce), to: ACCOUNT0, value: 0n, gasLimit: 21000n, maxFeePerGas: BigInt(sent.maxFeePerGas) * 2n, maxPriorityFeePerGas: BigInt(sent.maxPriorityFeePerGas) * 2n }, sk);
      wipe(sk);
      await raw('eth_sendRawTransaction', [other.raw]);
      await raw('evm_mine');
      await page.waitForSelector(`${tid('eth-tx-title')}[data-state="replaced"]`, { timeout: 60000 });
      assert.equal(await page.getAttribute(tid('eth-tx-replaced-by'), 'data-hash'), other.hash);
      await shots4('26-tx-replaced');
      await page.click(tid('eth-tx-done'));
      await ethHomeReady();
    } finally {
      mode = 'fork';
      await raw('evm_setAutomine', [true]);
      // The next test starts from Ethereum Home.
      await page.evaluate(() => window.__campfire.go('ethHome')).catch(() => {});
    }
  }));

/**
 * A payment mined a few blocks below the newest one, then two empty blocks: what a server check asks
 * a receipt of. The fork's clock is set to now first: anvil dates a fork's new blocks from the pinned
 * block's time (days ago), and a server whose newest block is that old is rightly called behind
 * (lib/evm_server_check.js FRESH_SECONDS), so the check would refuse the fork, not the app.
 */
async function recentPayment() {
  await raw('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
  await sendAs(freshAddress(), freshAddress(), '0x'); // a stranger's payment: this wallet's nonce stays as it is
  await raw('evm_mine');
  await raw('evm_mine');
}

test('each chain has its server screen: every listed server checked as it opens (newest block, speed, confirms payments); "In use"; dead ones not offered; it says each check shows your IP', { skip: skip || false, timeout: 4 * 60000 }, () =>
  withFork(async () => {
    await recentPayment();
    await page.evaluate(() => window.__campfire.go('ethSettings'));
    await waitScreen(page, 'ethSettings');
    await page.click(tid('eth-server-row'));
    await waitScreen(page, 'ethServers');
    // Stack Wallet's server is the fork here; every other listed Ethereum server is refused by this test.
    await page.waitForSelector(`${tid('evm-server-stackwallet')}[data-state="ok"]`, { timeout: 60000 });
    assert.equal(await page.getAttribute(tid('evm-server-stackwallet'), 'data-in-use'), 'true');
    assert.match(await page.textContent(tid('evm-server-stackwallet-state')), /^Block\s[\d,]+ · \d+(\.\d)?\s(ms|s) · confirms payments$/);
    assert.equal(await page.isVisible(tid('evm-server-stackwallet-use')), false, 'the one in use has no "Use this one"');
    for (const x of ETH_RPC_HOSTS.filter((h) => h.id !== 'stackwallet')) {
      await page.waitForSelector(`${tid(`evm-server-${x.id}`)}[data-state="bad"]`, { timeout: 60000 });
      assert.equal(await page.textContent(tid(`evm-server-${x.id}-state`)), 'Not answering');
      assert.equal(await page.isVisible(tid(`evm-server-${x.id}-use`)), false, `${x.id}: a dead server is not offered`);
    }
    assert.match(await page.textContent(tid('evm-check-privacy')), /each one sees your IP address \(never your wallet's address\)/);
    assert.equal(await page.isDisabled(tid('evm-use-own')), true, 'the one primary button waits for an address');
    await shots4('25-servers-ethereum');
    // BNB Chain's tab: its own list, BNB Chain official in use (every BNB Chain server is refused by this test).
    await page.click(tid('servers-chain-bsc'));
    await page.waitForSelector(`${tid('evm-server-bsc-bnbchain')}[data-in-use="true"]`);
    assert.equal(await page.$$eval('[data-testid^="evm-server-bsc-"][data-in-use], [data-testid^="evm-server-bsc-"][data-state]', (els) => new Set(els.map((e) => e.dataset.testid)).size), 8);
    await page.waitForSelector(`${tid('evm-server-bsc-1rpc')}[data-state="bad"]`, { timeout: 60000 });
    await shots4('26-servers-bsc');
    // Back on Ethereum: a server that answers can be picked with one tap, and back again.
    await page.click(tid('servers-chain-ethereum'));
    await page.waitForSelector(`${tid('evm-server-stackwallet')}[data-state="ok"]`, { timeout: 60000 });
  }));

test('your own server: a node on this device (anvil, http://127.0.0.1:8545) is checked by the service worker first, then used after one reopen; wrong chain refused with the reason; back to Stack Wallet in one tap', { skip: skip || false, timeout: 6 * 60000 }, () =>
  withFork(async () => {
    await recentPayment();
    await page.evaluate(() => window.__campfire.go('ethServers', { chain: 'bsc' }));
    await waitScreen(page, 'ethServers');
    await page.waitForSelector(tid('evm-own-server'));
    // Refused as typed, before anything is asked: plain http to another host, a user name.
    await page.fill(tid('evm-own-server'), 'http://bsc.example.com:8545');
    assert.match(await page.textContent(tid('evm-own-hint')), /Only a node on this device/);
    assert.equal(await page.isDisabled(tid('evm-use-own')), true);
    await page.fill(tid('evm-own-server'), 'https://me:pw@bsc.example.com');
    assert.match(await page.textContent(tid('evm-own-hint')), /user name and password/);
    // anvil is an Ethereum fork: as BNB Chain's server it is refused, with the reason, and nothing changes.
    await page.fill(tid('evm-own-server'), 'http://127.0.0.1:8545');
    assert.match(await page.textContent(tid('evm-own-hint')), /checks 127\.0\.0\.1:8545 before using it/);
    await page.click(tid('evm-use-own'));
    await page.waitForSelector(`${tid('evm-own-refused')}[data-problem="wrong_chain"]`, { timeout: 60000 });
    assert.match(await page.textContent(tid('evm-own-refused')), /not a BNB Chain server: it answered for chain 1, and BNB Chain is chain 56.*keeps using BNB Chain \(official\)/);
    await shots4('27-own-server-wrong-chain');
    // As Ethereum's server: checked from the service worker (this page may not reach it yet), then saved;
    // the app reopens once so its policy names it, and unlock says where it goes.
    await page.click(tid('servers-chain-ethereum'));
    await page.waitForSelector(tid('evm-own-server'));
    await page.fill(tid('evm-own-server'), 'http://127.0.0.1:8545');
    const reopened = page.waitForEvent('load', { timeout: 90000 });
    // What it says before the app reopens (read while it can be: the reload may come at once).
    const okText = page.waitForSelector(tid('evm-own-ok'), { timeout: 60000 }).then((el) => el.textContent()).catch(() => null);
    // Refused instead: say why at once, rather than wait for a reopen that will not come.
    const refusedText = page.waitForSelector(tid('evm-own-refused'), { timeout: 90000 }).then(async (el) => `${await el.getAttribute('data-problem')}: ${await el.textContent()}`).catch(() => null);
    await page.click(tid('evm-use-own'));
    await Promise.race([reopened, refusedText.then((t) => t && Promise.reject(new Error(`the check refused anvil: ${t}`)))]);
    const said = await okText;
    if (said !== null) assert.match(said, /127\.0\.0\.1:8545 checked\. Block [\d,]+ · .* · confirms payments\..*reopens once/);
    await waitScreen(page, 'unlock', 60000);
    assert.match(await page.textContent(tid('evm-switched-note')), /Unlock to use your own Ethereum server, 127\.0\.0\.1:8545\./);
    await shots4('28-own-server-unlock');
    await unlockWithPassword(page, PASSWORD);
    await waitScreen(page, 'home', 60000);
    const before = rpcMethods.length;
    const exportsBefore = exportAsks;
    await page.click(tid('chain-eth'));
    await page.waitForSelector(`${tid('eth-status')}[data-state="ok"]`, { timeout: 60000 });
    assert.match(await page.textContent(tid('eth-status')), /^127\.0\.0\.1:8545 · block [\d,]+$/);
    await page.waitForSelector(tid('eth-history-off'), { timeout: 30000 });
    await sleep(1500);
    assert.equal(rpcMethods.length, before, "no request to Stack Wallet's server");
    // Release audit 0.1.5, B1: Stack Wallet's history index is a listed server too: not asked while
    // the own Ethereum server is in use (History stays on, held), and Home says why.
    assert.equal(exportAsks, exportsBefore, "Stack Wallet's history index was not asked about the address");
    assert.match(await page.textContent(tid('eth-history-off')), /not asked while your own Ethereum server is in use/);
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), [], 'its origin is in this page\'s policy');
    // Its screen: it is in use and checked from the page; the listed servers only on a tap.
    await page.evaluate(() => window.__campfire.go('ethServers', { chain: 'ethereum' }));
    await page.waitForSelector(`${tid('evm-own-row')}[data-state="ok"]`, { timeout: 60000 });
    assert.equal(await page.textContent(tid('evm-server-stackwallet-state')), 'Not checked yet');
    assert.equal(await page.isVisible(tid('evm-check-listed')), true);
    assert.match(await page.textContent(tid('evm-own-card')), /could show wrong balances.*can never move your coins: payments are signed on this device/);
    // Exact about chains (B1): the address is the same on BNB Chain, whose server still sees it.
    assert.match(await page.textContent(tid('evm-own-what')), /only server asked about your address on Ethereum: no listed server is, and Stack Wallet's history index is not asked either\. Your address is the same on BNB Chain: BNB Chain \(official\) is still asked there, unless you add your own for BNB Chain too\./);
    assert.match(await page.textContent(tid('evm-use-default')), /^Use Stack Wallet$/);
    await shots4('29-own-server-in-use');
    // Settings names it; the privacy screen says what it sees.
    await page.evaluate(() => window.__campfire.go('ethSettings'));
    await page.waitForSelector(tid('eth-server-row'));
    assert.match(await page.textContent(tid('eth-server-row')), /Your own: 127\.0\.0\.1:8545/);
    await page.evaluate(() => window.__campfire.go('ethPrivacy'));
    assert.match(await page.textContent(tid('eth-privacy-text')), /\(your own, 127\.0\.0\.1:8545\) sees your IP address/);
    // Back to Stack Wallet's: one tap, no reopen.
    await page.evaluate(() => window.__campfire.go('ethServers', { chain: 'ethereum' }));
    await page.click(tid('evm-use-default'));
    await page.waitForSelector(`${tid('evm-server-stackwallet')}[data-in-use="true"]`, { timeout: 60000 });
    await page.evaluate(() => window.__campfire.go('ethHome'));
    await page.waitForSelector(`${tid('eth-status')}[data-state="ok"]`, { timeout: 60000 });
    assert.match(await page.textContent(tid('eth-status')), /^Stack Wallet · block/);
  }));

test('told once: someone who had picked PublicNode for BNB Chain (no longer listed: it refuses receipts) is moved to BNB Chain official and told on Home, once', { skip: skip || false, timeout: 3 * 60000 }, async () => {
  // As a 0.1.4 install left it: PublicNode picked, never told.
  await page.evaluate(async () => {
    const { rawStore } = await import('./lib/store.js');
    const p = (await rawStore.get('prefs')) || {};
    delete p.bscServerNote;
    p.bscRpc = 'bsc-publicnode';
    await rawStore.set('prefs', p);
  });
  await page.reload();
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await page.click(tid('chain-eth'));
  await page.waitForSelector(tid('bsc-server-note'), { timeout: 60000 });
  assert.equal(await page.getAttribute(tid('bsc-server-note'), 'data-picked'), 'true');
  assert.match(await page.textContent(tid('bsc-server-note')), /BNB Chain server changed\. BNB Chain now goes through BNB Chain \(official\)\. PublicNode, the server you had picked, stopped saying whether payments went through/);
  await shots4('30-bsc-server-note');
  const prefs = await page.evaluate(async () => (await (await import('./lib/store.js')).rawStore.get('prefs')));
  assert.equal(prefs.bscRpc, 'bsc-bnbchain', 'moved off PublicNode');
  assert.equal(prefs.bscServerNote, 1);
  await page.click(tid('bsc-server-note-ok'));
  assert.equal(await page.isVisible(tid('bsc-server-note')), false);
  // Once: not again.
  await page.evaluate(() => window.__campfire.go('ethReceive'));
  await page.evaluate(() => window.__campfire.go('ethHome'));
  await ethHomeReady();
  assert.equal(await page.isVisible(tid('bsc-server-note')), false, 'told once');
});

test('lock forgets the Ethereum wallet; unlocking opens it again', { skip: skip || false, timeout: 2 * 60000 }, async () => {
  await page.click(tid('lock'));
  await waitScreen(page, 'unlock');
  await page.evaluate(() => window.__campfire.go('ethHome'));
  await waitScreen(page, 'unlock'); // locked: no Ethereum screen opens
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await page.click(tid('chain-eth'));
  await ethHomeReady();
  assert.equal(await page.getAttribute(tid('eth-address'), 'data-address'), ACCOUNT0);
});

test('a words wallet: "Show private key" in Backup, behind the password', { skip: skip || false, timeout: 2 * 60000 }, async () => {
  const junk = await ethKeyFromMnemonic(JUNK);
  const junkHex = bytesToHex(junk.sk, false);
  wipe(junk.sk);
  await page.evaluate(() => window.__campfire.go('ethSettings'));
  await waitScreen(page, 'ethSettings');
  await page.waitForSelector(tid('eth-show-key'));
  assert.equal(await page.getAttribute(tid('eth-backup'), 'data-kind'), 'words');
  assert.match(await page.textContent(tid('eth-backup')), /Your Ethereum words are your backup/, 'the words backup is unchanged');
  await keyShots('01-words-backup', { focus: tid('eth-show-key') });
  await page.click(tid('eth-show-key'));
  await page.waitForSelector(tid('auth-pw'));
  assert.match(await page.textContent('.sheet h2'), /Show the private key/);
  await page.click(tid('auth-cancel'));
  assert.equal(await page.$(tid('eth-key-text')), null, 'cancelled: nothing opened');
  await page.click(tid('eth-show-key'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(`${tid('eth-key-box')}[data-state="shown"]`);
  assert.equal(await page.textContent(tid('eth-key-text')), junkHex, 'the key of the words (m/44\'/60\'/0\'/0/0)');
  assert.match(await page.textContent(tid('eth-key-card')), /never share it/);
  await keyShots('02-words-show-private-key', { masks: [tid('eth-key-text')], focus: tid('eth-key-card') });
  await page.click(tid('eth-key-hide'));
  await page.waitForSelector(tid('eth-show-key'));
  assert.equal(await page.$(tid('eth-key-text')), null, 'hidden again');
});

test('import by private key: one box knows it is a key, shows the address first; Backup shows it behind the password; lock wipes it', { skip: skip || false, timeout: 5 * 60000 }, async () => {
  const key = randomKeyHex();
  const keyBytes = hexToBytes(key);
  const address = privateKeyToAddress(keyBytes);
  wipe(keyBytes);
  const box = tid('eth-words-input');
  const hint = tid('eth-words-hint');

  // The words wallet goes first: one Ethereum wallet per device.
  await page.click(tid('eth-remove'));
  await page.click(tid('eth-remove-confirm'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await waitScreen(page, 'settings');

  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('chain-eth'));
  await waitScreen(page, 'ethStart');
  assert.equal(await page.textContent(tid('eth-import')), 'Import words or private key');
  await page.click(tid('eth-import'));
  await waitScreen(page, 'ethImport');
  await page.waitForSelector(box);
  assert.equal(await page.getAttribute(box, 'aria-label'), 'Recovery words or private key');
  assert.match(await page.textContent('label.field .banner'), /Recovery words or private key/);
  await keyShots('03-import-empty');

  // Still typing is not an error; a wrong character or length is, in words.
  await page.fill(box, `0x${key.slice(0, 63)}`);
  assert.equal(await page.textContent(hint), '63 of 64 characters so far.');
  assert.equal(await page.getAttribute(hint, 'class'), 'hint');
  assert.equal(await page.getAttribute(hint, 'data-kind'), 'key');
  assert.equal(await page.isDisabled(tid('eth-import-submit')), true);
  assert.equal(await page.isVisible(tid('eth-advanced')), false, 'no passphrase for a key');
  await keyShots('04-import-key-typing', { masks: [box] });
  await page.fill(box, `0x${key.slice(0, 63)}g`);
  assert.equal(await page.textContent(hint), "That isn't a private key: it needs 64 characters, 0–9 and a–f.");
  assert.equal(await page.getAttribute(hint, 'class'), 'hint bad');
  await keyShots('05-import-key-invalid', { masks: [box] });
  await page.fill(box, `${key}0`);
  assert.equal(await page.textContent(hint), "That isn't a private key: it needs 64 characters, 0–9 and a–f.", '65 characters');
  await page.fill(box, `0x${'0'.repeat(64)}`);
  assert.equal(await page.textContent(hint), 'That private key is not valid. Copy it again from the wallet it came from.');
  await keyShots('06-import-key-zero', { masks: [box] });
  await page.fill(box, SECP_N.toString(16));
  assert.match(await page.textContent(hint), /not valid/, 'n itself');
  assert.equal(await page.isDisabled(tid('eth-import-submit')), true);
  // Words still go the words way.
  await page.fill(box, 'abandon add face');
  assert.equal(await page.getAttribute(hint, 'data-kind'), 'words');
  assert.equal(await page.textContent(hint), '3 of 12 words so far.');
  assert.equal(await page.isVisible(tid('eth-advanced')), true);

  // Pasted as people paste: 0X, capitals, spaces around. The address it opens, before anything is saved.
  await page.fill(box, `  0X${key.toUpperCase()}\n`);
  assert.equal(await page.textContent(hint), `This opens ${address.slice(0, 6)}…${address.slice(-4)}. Check it's the account you expect.`);
  assert.equal(await page.getAttribute(hint, 'class'), 'hint good');
  assert.equal(await page.getAttribute(hint, 'data-address'), address);
  assert.equal(await page.isDisabled(tid('eth-import-submit')), false);
  assert.equal(await page.textContent(tid('eth-import-submit')), 'Import Ethereum wallet');
  assert.equal(await page.evaluate(async () => (await (await import('./lib/store.js')).store.get('eth')) ?? null), null, 'nothing saved yet');
  await keyShots('07-import-address-check', { masks: [box] });

  await page.click(tid('eth-import-submit'));
  await waitScreen(page, 'ethPrivacy');
  await page.waitForSelector(tid('eth-connect'));
  assert.match(await page.textContent('.step'), /Step 2 of 2/);
  await page.click(tid('eth-connect'));
  await ethHomeReady();
  assert.equal(await page.getAttribute(tid('eth-address'), 'data-address'), address, 'Home opens the address of the key');
  const stored = await page.evaluate(async () => JSON.stringify(await (await import('./lib/store.js')).store.get('eth')));
  const rec = JSON.parse(stored);
  assert.equal(rec.kind, 'key');
  assert.deepEqual(Object.keys(rec).sort(), ['createdAt', 'envelope', 'id', 'kind', 'v']);
  assert.ok(!stored.toLowerCase().includes(key), 'the key only inside the sealed envelope');
  assert.ok(!stored.toLowerCase().includes(address.slice(2).toLowerCase()), 'the address too');

  // Backup: the key, blurred dots until the password; then Copy and Hide.
  await page.evaluate(() => window.__campfire.go('ethSettings'));
  await waitScreen(page, 'ethSettings');
  await page.waitForSelector(tid('eth-key-reveal'));
  assert.equal(await page.getAttribute(tid('eth-backup'), 'data-kind'), 'key');
  assert.ok((await page.textContent(tid('eth-backup'))).includes(KEY_WARNING));
  assert.equal(await page.getAttribute(tid('eth-key-box'), 'data-state'), 'masked');
  assert.match(await page.textContent(tid('eth-key-text')), /^•{64}$/, 'dots under the blur, not the key');
  assert.equal(await page.$(tid('eth-show-key')), null, 'the backup is the key itself');
  await keyShots('08-key-backup-masked', { focus: tid('eth-backup') });
  await page.click(tid('eth-key-reveal'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), 'not the password');
  await page.click(tid('auth-submit'));
  await page.waitForSelector('.sheet .notice.error');
  assert.equal(await page.getAttribute(tid('eth-key-box'), 'data-state'), 'masked', 'a wrong password shows nothing');
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(`${tid('eth-key-box')}[data-state="shown"]`);
  assert.equal(await page.textContent(tid('eth-key-text')), key);
  await keyShots('09-key-backup-shown', { masks: [tid('eth-key-text')], focus: tid('eth-backup') });
  // Copy, without touching this machine's clipboard.
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (t) => {
      window.__copied = t;
    };
  });
  await page.click(tid('eth-key-copy'));
  assert.equal(await page.evaluate(() => window.__copied === undefined ? 'none' : 'copied'), 'copied');
  assert.equal(await page.evaluate((k) => window.__copied === k, key), true, 'Copy gives the key');
  await page.evaluate(() => delete window.__copied);
  await page.waitForSelector('.toast');
  assert.match(await page.textContent('.toast'), /^Private key copied\. Firo PWA empties the clipboard in 1 minute/, 'the clipboard does not keep it (audit A-6)');
  await page.click(tid('eth-key-hide'));
  assert.equal(await page.getAttribute(tid('eth-key-box'), 'data-state'), 'masked');
  assert.match(await page.textContent(tid('eth-key-text')), /^•{64}$/);

  // Remove and Delete name the key, not words.
  await page.click(tid('eth-remove'));
  await page.waitForSelector(tid('eth-remove-confirm'));
  assert.match(await page.textContent('.sheet'), /Only its private key can bring it back/);
  await keyShots('10-key-remove-sheet');
  await page.click('.sheet .btn-text');
  await page.evaluate(() => window.__campfire.go('deleteWallet'));
  await page.waitForSelector(`${tid('delete-eth-words')}[data-kind="key"]`);
  assert.match(await page.textContent(tid('delete-eth-words')), /Its private key brings it back/);
  await keyShots('11-key-delete-wallet', { focus: tid('delete-eth-words') });

  // Shown at lock time: afterwards it is nowhere in the page.
  await page.evaluate(() => window.__campfire.go('ethSettings'));
  await page.waitForSelector(tid('eth-key-reveal'));
  await page.click(tid('eth-key-reveal'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(`${tid('eth-key-box')}[data-state="shown"]`);
  assert.equal(await inHeap([key]), 1, 'the heap search finds the key while it is shown (so its "0" below means something)');
  await page.evaluate(() => window.__campfire.go('settings'));
  await page.click(tid('lock-now'));
  await waitScreen(page, 'unlock');
  assert.equal(await page.evaluate(() => window.__copied), '', 'the lock emptied the clipboard the key was copied to');
  assert.equal(await page.evaluate((k) => document.documentElement.outerHTML.toLowerCase().includes(k), key), false, 'not in the DOM');
  assert.equal(await inHeap([key, key.toUpperCase(), `0x${key}`]), 0, 'not in the JS heap');

  // Unlocking opens the same wallet; the key is blurred again.
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'home', 60000);
  await page.click(tid('chain-eth'));
  await ethHomeReady();
  assert.equal(await page.getAttribute(tid('eth-address'), 'data-address'), address);
  await page.evaluate(() => window.__campfire.go('ethSettings'));
  await page.waitForSelector(tid('eth-key-reveal'));
  assert.equal(await page.getAttribute(tid('eth-key-box'), 'data-state'), 'masked');
});

test('IP privacy: only this origin and the chosen Ethereum server (and, on the server screens, the listed servers and the own one); no CSP violation', { skip: skip || false }, async () => {
  const foreign = foreignHosts(rec, srv.url);
  assert.ok(foreign.includes(`https://${STACK}`), 'the chosen Ethereum server');
  // The listed servers were checked by the server screen (no address in those questions), and the
  // person's own server (anvil) was used: nothing else.
  const listed = new Set([...ETH_RPC_HOSTS.map((x) => x.host), ...BSC_HOSTS]);
  assert.deepEqual(foreign.filter((o) => o !== `https://${STACK}` && !listed.has(new URL(o).hostname) && o !== ANVIL), [], 'nothing but the listed Ethereum and BNB Chain servers and the own one');
  assert.deepEqual(rec.csp, []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
  assert.ok(rpcMethods.includes('eth_sendRawTransaction'));
});
