// Scanning (lib/qr_scan.js, lib/qr_worker.js): what a scanned text fills in, the
// camera's errors in words, and the vendored jsQR is the published file, makes no
// requests, and reads the QR codes Campfire itself draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseScanned, cameraProblem, cameraSupported } from '../../src/lib/qr_scan.js';
import { encodeQr, qrToRgba } from '../../src/lib/qr.js';

import { SPARK, TRANSPARENT, EXCHANGE } from './helpers/firo_samples.mjs';

const pwa = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADDR = TRANSPARENT;

test('a plain address, a firo: link with an amount and a memo, the first line only', () => {
  assert.deepEqual(parseScanned(` ${ADDR} `), { address: ADDR });
  assert.deepEqual(parseScanned(SPARK.toUpperCase()), { address: SPARK });
  assert.deepEqual(parseScanned(EXCHANGE), { address: EXCHANGE });
  assert.deepEqual(parseScanned(`firo:${ADDR}?amount=1.5`), { address: ADDR, amount: 150000000n });
  assert.deepEqual(parseScanned(`FIRO://${ADDR}?amount=0.00000001&label=x`), { address: ADDR, amount: 1n });
  assert.deepEqual(parseScanned(`firo:${ADDR}?amount=-3`), { address: ADDR }, 'a bad amount is left out, the address kept');
  assert.deepEqual(parseScanned(`firo:${ADDR}?amount=1.123456789`), { address: ADDR });
  assert.deepEqual(parseScanned(`firo:${SPARK}?amount=2&memo=Rent`), { address: SPARK, amount: 200000000n, memo: 'Rent' });
  assert.deepEqual(parseScanned(`${ADDR}\nsecond line`), { address: ADDR });
  assert.deepEqual(parseScanned('@alice'), { address: '@alice' }, 'a Spark name goes to the field like a typed one');
  assert.equal(parseScanned('https://example.com/pay'), null, 'a web link is not an address');
  assert.equal(parseScanned('bitcoin:bc1qxyz'), null);
  assert.equal(parseScanned('firo:nothing'), null);
  assert.equal(parseScanned('3f25d94eac4a95f4ff2b764f844aa588254982c6bcc83e02f157218d698c9df9477'), null, 'not a Firo address');
  assert.equal(parseScanned(''), null);
  assert.equal(parseScanned('<script>'), null);
});

test('camera problems in words, never blaming the person, always with Paste as the way out', () => {
  for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'unsupported', 'Weird']) {
    const p = cameraProblem({ name });
    assert.ok(p.text.length > 20);
    assert.match(p.text, /paste/i, name);
  }
  assert.equal(cameraProblem({ name: 'NotAllowedError' }).code, 'denied');
  assert.equal(cameraSupported({}), false);
  assert.equal(cameraSupported({ mediaDevices: { getUserMedia() {} } }), true);
});

test('the vendored jsQR is jsqr@1.4.0 dist/jsQR.js byte for byte, with its licence, and makes no requests', () => {
  const vendor = JSON.parse(readFileSync(join(pwa, 'src', 'vendor', 'jsqr', 'VENDOR.json'), 'utf8'));
  assert.equal(vendor.version, '1.4.0');
  const lock = JSON.parse(readFileSync(join(pwa, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/jsqr'].integrity, vendor.integrity, 'the same release the tests use');
  for (const f of vendor.files) {
    const b = readFileSync(join(pwa, 'src', 'vendor', 'jsqr', f.path));
    assert.equal(createHash('sha256').update(b).digest('hex'), f.sha256, f.path);
    assert.equal(b.length, f.size);
  }
  const js = readFileSync(join(pwa, 'src', 'vendor', 'jsqr', 'jsQR.js'), 'utf8');
  assert.ok(!/\b(fetch\(|XMLHttpRequest|WebSocket|importScripts|sendBeacon|EventSource|eval\(|new Function)/.test(js));
  try {
    const up = readFileSync(join(pwa, 'node_modules', 'jsqr', 'dist', 'jsQR.js'));
    assert.equal(createHash('sha256').update(up).digest('hex'), vendor.files[0].sha256, 'same as the installed package');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
});

test('the worker script, run as a classic worker would, reads a QR code Campfire draws (normal and inverted)', () => {
  // A worker's global object is `self`: the context's own global, with its own built-ins.
  const posted = [];
  const self = vm.createContext({});
  self.self = self;
  self.postMessage = (m) => posted.push(JSON.parse(JSON.stringify(m)));
  self.importScripts = (rel) => vm.runInContext(readFileSync(join(pwa, 'src', 'lib', rel), 'utf8'), self, { filename: rel });
  vm.runInContext(readFileSync(join(pwa, 'src', 'lib', 'qr_worker.js'), 'utf8'), self);
  assert.equal(typeof self.onmessage, 'function');
  const text = `firo:${ADDR}?amount=2`;
  const img = qrToRgba(encodeQr(text, { ecl: 'M' }), { scale: 4, border: 4 });
  self.onmessage({ data: { id: 1, data: new Uint8ClampedArray(img.data).buffer, width: img.width, height: img.height } });
  assert.deepEqual(posted.at(-1), { id: 1, text });
  const inv = new Uint8ClampedArray(img.data);
  for (let i = 0; i < inv.length; i += 4) for (let c = 0; c < 3; c++) inv[i + c] = 255 - inv[i + c];
  self.onmessage({ data: { id: 2, data: inv.buffer, width: img.width, height: img.height, thorough: true } });
  assert.deepEqual(posted.at(-1), { id: 2, text });
  self.onmessage({ data: { id: 3, data: new Uint8ClampedArray(16 * 16 * 4).fill(255).buffer, width: 16, height: 16 } });
  assert.deepEqual(posted.at(-1), { id: 3, text: null });
  self.onmessage({ data: { id: 4 } });
  assert.deepEqual(posted.at(-1), { id: 4, text: null });
});
