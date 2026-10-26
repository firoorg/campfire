// Firo addresses and "firo:" links by their shape (lib/firo_uri.js): what Send, Scan and the
// address book take before the engine checks an address for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressShape, normalizeAddress, sparkNameOf, parseFiroUri, firoUri } from '../../src/lib/firo_uri.js';
import { SPARK, TRANSPARENT, EXCHANGE, ETH_ADDR } from './helpers/firo_samples.mjs';

test('shapes: Spark, transparent, exchange, Spark name; nothing else', () => {
  assert.equal(addressShape(SPARK), 'spark');
  assert.equal(addressShape(SPARK.toUpperCase()), 'spark', 'bech32 in capitals (some QR encoders)');
  assert.equal(addressShape(`${SPARK.slice(0, 70)}\n${SPARK.slice(70)}`), 'spark', 'a paste split across lines');
  assert.equal(addressShape(TRANSPARENT), 'transparent');
  assert.equal(addressShape(EXCHANGE), 'exchange');
  assert.equal(addressShape('@alice'), 'spark-name');
  assert.equal(addressShape('@a.b-c'), 'spark-name');
  for (const bad of ['', 'alice', '@', '@-x', `@${'x'.repeat(21)}`, `st1${SPARK.slice(3)}`, 'sm1short', `b${TRANSPARENT.slice(1)}`, TRANSPARENT.slice(0, 33), ETH_ADDR, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', `${TRANSPARENT}0`]) {
    assert.equal(addressShape(bad), null, bad);
  }
  assert.equal(normalizeAddress(SPARK.toUpperCase()), SPARK);
  assert.equal(normalizeAddress(` ${TRANSPARENT} `), TRANSPARENT);
  assert.equal(sparkNameOf('@Alice'), 'alice');
  assert.equal(sparkNameOf('alice'), null);
});

test('a firo: link: address, amount (sats), label, message, memo; a bad amount is left out', () => {
  assert.deepEqual(parseFiroUri(`firo:${TRANSPARENT}?amount=1.5&label=Shop`), { address: TRANSPARENT, shape: 'transparent', amount: 150000000n, label: 'Shop', message: '', memo: '' });
  assert.equal(parseFiroUri(`FIRO://${TRANSPARENT}?amount=0.00000001`).amount, 1n);
  for (const a of ['-1', '1.123456789', 'abc', '0', '1e3']) assert.equal(parseFiroUri(`firo:${TRANSPARENT}?amount=${a}`).amount, null, a);
  assert.equal(parseFiroUri('bitcoin:bc1q'), null);
  assert.equal(parseFiroUri('firo:nonsense').address, '');
});

test('Spark memo: memo=, or message= when there is none (as firo-qt); never for a public address', () => {
  assert.equal(parseFiroUri(`firo:${SPARK}?memo=Order%2042`).memo, 'Order 42');
  assert.equal(parseFiroUri(`firo:${SPARK}?message=For+lunch`).memo, 'For lunch');
  assert.equal(parseFiroUri(`firo:${SPARK}?message=a&memo=b`).memo, 'b');
  assert.equal(parseFiroUri(`firo:${TRANSPARENT}?memo=hi`).memo, '');
  assert.equal(parseFiroUri(`firo:${SPARK}?memo=a%0Ab%00c`).memo, 'a b c', 'control characters become spaces');
});

test('the link Receive shows: the plain address, or firo: with the amount asked for', () => {
  assert.equal(firoUri({ address: SPARK }), SPARK);
  assert.equal(firoUri({ address: TRANSPARENT, amount: 150000000n }), `firo:${TRANSPARENT}?amount=1.5`);
  assert.equal(firoUri({ address: SPARK, amount: 1n, memo: 'Rent' }), `firo:${SPARK}?amount=0.00000001&memo=Rent`);
  assert.throws(() => firoUri({ address: '@alice' }));
  assert.throws(() => firoUri({ address: 'nope' }));
  const back = parseFiroUri(firoUri({ address: SPARK, amount: 250000000n, memo: 'Thanks' }));
  assert.deepEqual([back.address, back.amount, back.memo], [SPARK, 250000000n, 'Thanks']);
});

test('PN: a link with a "req-" parameter this wallet does not know is refused, never paid without it (BIP21)', () => {
  const u = parseFiroUri(`firo:${TRANSPARENT}?amount=1&req-escrow=1`);
  assert.deepEqual(u.required, ['req-escrow']);
  assert.equal(u.address, '');
  assert.equal(u.amount, null);
  // Without one, as before; a "1,000" amount is left out, never read as 1.
  assert.equal(parseFiroUri(`firo:${TRANSPARENT}?amount=1,000`).amount, null);
  assert.equal(parseFiroUri(`firo:${TRANSPARENT}?amount=1.5&x-other=1`).amount, 150000000n, 'an optional unknown parameter is fine');
});
