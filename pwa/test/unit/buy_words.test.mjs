// What the Buy FIRO screens say: dollars, FIRO, the usual wait, the smallest
// buy in the coin paid with, every refusal in words with its one fix, and a
// buy's four steps. Also the shared "rounded down to what people read" format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usd, firoText, firoShort, sats, etaText, minimumAmount, problemText, stateLine, buySteps } from '../../src/lib/buy/words.js';
import { BuyError, BuyAmount, ERROR_CODES, assetFromJson } from '../../src/lib/buy/buyfiro.js';
import { compactUnits, compactRatio, exactUnits, percentText } from '../../src/lib/compact.js';
import { ASSETS, BTC, ETH, USDT_TRON } from './buy_fakes.mjs';

const coin = (id) => assetFromJson(ASSETS.find((a) => a.asset_id === id));

test('dollars as people read them', () => {
  assert.equal(usd(1000), '$1,000');
  assert.equal(usd(497.27), '$497.27');
  assert.equal(usd(1497.27), '$1,497');
  assert.equal(usd(5), '$5');
  assert.equal(usd(12.5), '$12.50');
  assert.equal(usd(1234.56), '$1,235');
});

test('FIRO rounded down to what people read', () => {
  assert.equal(firoText(16688869123456n), '166,888.69 FIRO');
  assert.equal(firoText(123456789n), '1.2345 FIRO');
  assert.equal(firoText(1234n), '0.00001234 FIRO');
  assert.equal(firoShort(111326.9), '111,326 FIRO');
  assert.equal(firoShort(12.3456789), '12.3456 FIRO');
  assert.equal(sats(1.5), 150000000n);
  assert.equal(compactUnits(25670000000n, 8), '256.7');
  assert.equal(compactUnits(0n, 18), '0');
  assert.equal(compactRatio(1n, 10n ** 20n), '< 0.000000000001');
  assert.equal(exactUnits(1234000001000000000000n, 18), '1,234.000001');
  assert.equal(percentText(0.0313), '3.13%');
  assert.equal(percentText(0.123), '12.3%');
  assert.equal(percentText(0.00001), '< 0.01%');
});

test('how long a buy usually takes', () => {
  assert.equal(etaText(100), 'Usually done in a few minutes');
  assert.equal(etaText(810), 'Usually done in about 14 minutes');
  assert.equal(etaText(4 * 3600), 'Usually done in about 4 hours');
});

test('the smallest buy in the coin: a little over, three significant digits, exact for buyfiro.app', () => {
  const btc = coin(BTC);
  const m = minimumAmount(1000, btc);
  assert.equal(m, '0.0123');
  assert.ok(Number(m) * btc.priceUsd >= 1000);
  assert.equal(BuyAmount.parse(m, 8).amount.exact, true);
  assert.equal(minimumAmount(1000, coin(USDT_TRON)), '1006');
  const eth = minimumAmount(1000, coin(ETH));
  assert.ok(BuyAmount.parse(eth, 18).amount.exact);
  assert.equal(minimumAmount(1000, { ...btc, priceUsd: null }), null);
  assert.equal(minimumAmount(1000, { ...btc, priceUsd: null }, { priceUsd: 50000 }), '0.0201');
});

test('every refusal has a title, never blames the person, and offers one fix', () => {
  const btc = coin(BTC);
  for (const code of [...ERROR_CODES, 'blocked', 'network', 'unexpected_answer', 'wrong_deposit_address', 'unknown']) {
    const p = problemText(new BuyError(code), { coin: btc });
    assert.ok(p.title, code);
    assert.ok(p.fix && p.fixLabel, code);
    assert.doesNotMatch(`${p.title} ${p.detail}`, /your fault|you did wrong|invalid input/i, code);
  }
  // The route's floor, from buyfiro.app's answer (error.minimum_usd), said as a plain minimum.
  const below = problemText(new BuyError('amount_below_upstream_minimum', { minimumUsd: 1005 }), { coin: btc, minimum: '0.0123' });
  assert.equal(below.title, 'This route starts at about $1,005');
  assert.match(below.detail, /That is about 0\.0123 BTC\. Nothing was sent\./);
  assert.equal(below.fix, 'useMinimum');
  assert.equal(below.fixLabel, 'Use 0.0123 BTC');
  assert.equal(below.smaller, true, 'the form also offers the way for smaller amounts');
  assert.equal(problemText(new BuyError('amount_below_upstream_minimum', { minimumUsd: 2000 }), { coin: btc }).title, 'This route starts at about $2,000', 'never a number of the app');
  assert.equal(problemText(new BuyError('amount_below_our_minimum', { minimumUsd: 5 }), { coin: btc }).smaller, undefined);
  assert.match(problemText(new BuyError('firo_wallet_is_evm'), { coin: btc }).title, /FIRO address/);
  const noMin = problemText(new BuyError('amount_below_our_minimum', { minimumUsd: 5 }), { coin: btc });
  assert.equal(noMin.title, 'Buy at least $5 of BTC');
  assert.equal(noMin.fix, 'editAmount');
  assert.match(problemText(new BuyError('quote_failed', { retryAfterMs: 30000 }), { coin: btc }).detail, /Try again in 30 seconds\./);
  assert.match(problemText(new BuyError('network', { httpStatus: 502 }), { coin: btc }).detail, /check that your Bitcoin address is right/);
  assert.equal(problemText(new BuyError('order_not_found'), { coin: btc }).serious, true);
});

test('a buy in one line, and its four steps', () => {
  assert.equal(stateLine({ lastState: null }), 'Waiting for your payment');
  assert.equal(stateLine({ lastState: 'swapping' }), 'Buying your FIRO');
  assert.equal(stateLine({ lastState: 'delivered' }), 'FIRO sent to your wallet');
  const marks = (s, o) => buySteps(s, o).map((x) => x.mark).join(' ');
  assert.equal(marks('awaiting_deposit'), 'active waiting waiting waiting');
  assert.equal(marks('deposit_detected'), 'done active waiting waiting');
  assert.equal(buySteps('deposit_detected')[0].note, 'being confirmed');
  assert.equal(marks('sending'), 'done done active waiting');
  assert.equal(marks('delivered'), 'done done done active');
  assert.equal(buySteps('delivered')[3].label, 'Arriving in your public balance');
  assert.equal(buySteps('delivered', { arrived: true })[3].label, 'Arrived in your public balance');
  for (const code of ['firo_wallet_invalid', 'firo_wallet_too_short']) assert.match(problemText(new BuyError(code), { coin: coin(BTC) }).title, /FIRO address/);
  assert.equal(marks('delivered', { arrived: true }), 'done done done done');
  assert.equal(marks('refunded'), 'done failed waiting waiting');
  assert.equal(marks('expired'), 'failed waiting waiting waiting');
  assert.equal(buySteps('in_progress').length, 4);
});
