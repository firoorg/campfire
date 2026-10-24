// QR encoder checked against an independent decoder (jsQR, dev-only).
import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { encodeQr, qrToRgba, qrSvgPath } from '../../src/lib/qr.js';
import { SPARK } from './helpers/firo_samples.mjs';

function roundTrip(text, opts) {
  const qr = encodeQr(text, opts);
  const img = qrToRgba(qr, { scale: 4, border: 4 });
  const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  assert.ok(res, `jsQR could not read version ${qr.version} (${text.length} chars)`);
  assert.equal(res.data, text);
  return qr;
}

test('short text decodes', () => {
  const qr = roundTrip('hello');
  assert.equal(qr.version, 1);
});

test('a Spark address (144 characters) and a firo: link to it with an amount and a memo decode', () => {
  const qr = roundTrip(SPARK);
  assert.ok(qr.version >= 5 && qr.version <= 10, `version ${qr.version}`);
  roundTrip(`firo:${SPARK}?amount=12.5&memo=Rent%20share`);
  roundTrip('aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7');
});

test('every ECC level and many versions decode', () => {
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    for (const len of [1, 17, 50, 100, 200, 300, 500, 800]) {
      const text = 'x'.repeat(len).replace(/x/g, (_, i) => String.fromCharCode(33 + ((i * 7) % 90)));
      roundTrip(text, { ecl, boostEcl: false });
    }
  }
});

test('versions 1..40 each decode at their own capacity edge', () => {
  for (let v = 1; v <= 40; v += 1) {
    const qr = encodeQr('a', { minVersion: v, maxVersion: v, boostEcl: false });
    assert.equal(qr.version, v);
    const img = qrToRgba(qr, { scale: v > 30 ? 3 : 4 });
    const res = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    assert.ok(res && res.data === 'a', `version ${v} not readable`);
  }
});

test('UTF-8 text decodes', () => {
  roundTrip('Campfire — приватность ✓');
});

test('too much data is refused', () => {
  assert.throws(() => encodeQr('x'.repeat(3000), { ecl: 'H' }), RangeError);
});

test('svg path has one square per dark module', () => {
  const qr = encodeQr('firo');
  let dark = 0;
  for (const row of qr.modules) for (const c of row) if (c) dark++;
  assert.equal((qrSvgPath(qr).match(/M/g) || []).length, dark);
});
