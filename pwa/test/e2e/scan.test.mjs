// Scan a QR code and land where it belongs: Home's Scan, and the scanners of Send and Ethereum Send
// naming a code of another kind. The installed Google Chrome (headless), its own build and port, the
// stand-in engine (lib/backend_fake.js: no network), a new wallet that holds nothing; nothing is
// signed or sent.
//
//   npm run e2e:scan   (own build folder and port 8831)
//
// The first scan is Chrome's fake camera playing a picture of a QR code (the real getUserMedia ->
// worker -> jsQR path); the others are photos ("Use a photo"), BMP pictures made here with
// Campfire's own QR encoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { startServer, recordedPage, waitScreen, shot, sleep, PWA, CHROME, foreignHosts, SHOTS } from './harness.mjs';
import { createWallet, waitHome } from './flows.mjs';
import { encodeQr } from '../../src/lib/qr.js';

const PORT = 8831;
const tid = (id) => `[data-testid="${id}"]`;
import { SPARK, TRANSPARENT, ETH_ADDR } from '../unit/helpers/firo_samples.mjs';

/** Grey levels of a QR code picture: n x n modules, 8 px each, a 4-module border. */
function qrPixels(text) {
  const qr = encodeQr(text, { ecl: 'M' });
  const border = 4;
  const scale = 8;
  const side = (qr.size + border * 2) * scale;
  const px = new Uint8Array(side * side).fill(255);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - border;
      const my = Math.floor(y / scale) - border;
      if (mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.modules[my][mx]) px[y * side + x] = 0;
    }
  return { side, px };
}

/** A 24-bit BMP of the code (rows bottom up, padded to 4 bytes). */
function qrBmp(text, file) {
  const { side, px } = qrPixels(text);
  const row = Math.ceil((side * 3) / 4) * 4;
  const data = Buffer.alloc(row * side);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const v = px[y * side + x];
      const o = (side - 1 - y) * row + x * 3;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  const head = Buffer.alloc(54);
  head.write('BM', 0);
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(side, 18);
  head.writeInt32LE(side, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

/** The fake camera's picture: one frame (looped), the code in the middle of 640x480. */
function qrY4m(text, file) {
  const W = 640;
  const H = 480;
  const { side, px } = qrPixels(text);
  const Y = Buffer.alloc(W * H, 235);
  const x0 = Math.floor((W - side) / 2);
  const y0 = Math.floor((H - side) / 2);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) if (px[y * side + x] === 0) Y[(y0 + y) * W + x0 + x] = 16;
  const UV = Buffer.alloc((W / 2) * (H / 2), 128);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\nFRAME\n`), Y, UV, UV]));
}

let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-scan-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  qrY4m(`firo:${SPARK}?amount=0.5&memo=Coffee`, join(tmp, 'qr.y4m'));
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: process.env.HEADED ? false : true,
    args: ['--disable-features=AutofillServerCommunication', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${join(tmp, 'qr.y4m')}`],
  });
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(['camera'], { origin: srv.url });
  ({ page, rec } = await recordedPage(ctx, { label: 'scan' }));
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

/** From here on the camera refuses (as when the person said no), so only the photo is read. */
const cameraRefuses = () =>
  page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('refused'), { name: 'NotAllowedError' }));
  });

/** Home -> Scan -> a photo of `text`. */
async function scanPhoto(text, name) {
  await cameraRefuses();
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('home-scan'));
  await page.waitForSelector(tid('scan-photo-input'), { state: 'attached' });
  await page.setInputFiles(tid('scan-photo-input'), qrBmp(text, join(tmp, `${name}.bmp`)));
}

test('Home -> Scan with the camera: a firo: payment link opens Send with the address, amount and memo filled', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: `scan-${Math.random().toString(36).slice(2, 10)}` });
  await waitHome(page);
  assert.equal(await page.getAttribute(tid('home-scan'), 'aria-label'), 'Scan a QR code');
  await page.click(tid('home-scan'));
  await page.waitForSelector(tid('scan-video'));
  await both('scan-01-camera');
  await waitScreen(page, 'send', 30000);
  assert.equal(await page.inputValue(tid('send-address')), SPARK);
  assert.equal(await page.inputValue(tid('send-amount')), '0.5');
  assert.equal(await page.inputValue(tid('send-memo')), 'Coffee', 'a Spark memo from the link');
  assert.equal(await page.locator('.overlay').count(), 0, 'the scanner closed itself');
  await both('scan-02-send-filled');
  // A memo counts in bytes, as the Spark library does (PN): 31 Cyrillic letters are too long, and
  // what will be sent is said.
  await page.fill(tid('send-memo'), 'Оплата за квартиру в марте!!!!');
  await page.waitForFunction(() => document.querySelector('[data-testid="send-memo-hint"]').className === 'hint bad');
  assert.match(await page.textContent(tid('send-memo-hint')), /^Too long for a memo: it will be cut to "Оплата за кварти"\.$/);
  await both('scan-03-send-memo-bytes');
  await page.fill(tid('send-memo'), 'Coffee');
  // On a small phone (375 x 667) Review payment is on screen without scrolling (visual check, V1).
  const size = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 667 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
  const box = await page.locator(tid('review')).boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 667, `Review payment on screen: ${JSON.stringify(box)}`);
  await shot(page, 'scan-04-send-small-phone');
  await page.setViewportSize(size);
});

test('a Spark name and a transparent address open Send with them; nothing is paid by itself', { timeout: 3 * 60000 }, async () => {
  await scanPhoto('@Alice', 'name');
  await waitScreen(page, 'send', 30000);
  assert.equal(await page.inputValue(tid('send-address')), '@alice');
  await scanPhoto(`firo:${TRANSPARENT}?amount=1.25`, 'transparent');
  await waitScreen(page, 'send', 30000);
  assert.equal(await page.inputValue(tid('send-address')), TRANSPARENT);
  assert.equal(await page.inputValue(tid('send-amount')), '1.25');
  assert.equal((await page.evaluate(() => window.__campfire.txs())).length, 0, 'nothing is sent by itself');
  // Rosen's lock: FIRO paid to it without the bridge's details is lost; Send says so and offers no review (P12).
  await scanPhoto('firo:aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y?amount=1', 'transparent');
  await waitScreen(page, 'send', 30000);
  await page.waitForFunction(() => /Rosen Bridge's lock address/.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''));
  assert.match(await page.textContent(tid('address-hint')), /FIRO sent to it by a plain payment, without the bridge's details, is lost\. To move FIRO to Ethereum or BNB Chain, use Bridge\./);
  assert.equal(await page.isDisabled(tid('review')), true, 'no review of a payment to the lock');
});

test('an Ethereum address with no Ethereum wallet: says so, with the way to add one', { timeout: 2 * 60000 }, async () => {
  await scanPhoto(`ethereum:${ETH_ADDR}?value=1e16`, 'eth');
  await page.waitForSelector(tid('scan-no-eth'));
  assert.equal(await page.isVisible(tid('scan-add-eth')), true);
  await both('scan-03-no-eth');
  await page.click('.sheet button:text-is("Not now")');
  await page.waitForSelector('.sheet', { state: 'detached' });
});

test('a web link, BNB Chain, another coin, plain text: shown, never opened', { timeout: 2 * 60000 }, async () => {
  for (const [text, words] of [
    ['https://example.com/pay?x=1', /web link\. Firo PWA does not open links from codes/],
    [`ethereum:${ETH_ADDR}@56?value=1`, /BNB Chain\. Firo PWA doesn't have a BNB Chain wallet yet/],
    ['bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', /another coin/],
    ['hello world', /does not know what this is/],
  ]) {
    await scanPhoto(text, `said-${text.length}`);
    await page.waitForSelector(tid('scan-said'));
    assert.match(await page.textContent(tid('scan-said')), words);
    assert.equal(await page.textContent(tid('scan-text')), text);
    assert.equal(await page.evaluate(() => window.__campfire.screen()), 'home', 'nothing opened');
    if (text.startsWith('https')) await both('scan-04-link');
    await page.click('.sheet button:text-is("Close")');
    await page.waitForSelector('.sheet', { state: 'detached' });
  }
});

test("Send's own scanner names a code of another kind and keeps looking", { timeout: 2 * 60000 }, async () => {
  await cameraRefuses();
  await page.evaluate(() => window.__campfire.go('send'));
  await waitScreen(page, 'send');
  await page.click(tid('send-scan'));
  await page.waitForSelector(tid('scan-photo-input'), { state: 'attached' });
  await page.setInputFiles(tid('scan-photo-input'), qrBmp(ETH_ADDR, join(tmp, 'eth-in-send.bmp')));
  await page.waitForFunction(() => /That's an Ethereum address/.test(document.querySelector('[data-testid="scan-status"]')?.textContent || ''));
  assert.equal(await page.locator('.sheet').count(), 1, 'still open');
  await page.click(tid('scan-cancel'));
});

test('privacy: the pictures stay here; no host but the origin (the stand-in engine reaches no server); no CSP violation; no page error', async () => {
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
