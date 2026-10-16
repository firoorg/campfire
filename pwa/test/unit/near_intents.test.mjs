// Buying rsFIRO with any coin (NEAR Intents' 1Click): the signature check on
// real answers (the two the desktop app's tests use, 2026-10-09, and a BTC
// quote of 2026-10-11 that 1Click answered with its newer coin id), the
// client over a fake fetch (what it asks, what it refuses), the coin list,
// the swaps kept sealed per wallet, and every sentence the screens say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OneClickClient,
  OneClickError,
  verifyQuote,
  quoteHash,
  signedJson,
  stableJson,
  readQuote,
  readStatus,
  tokenFromJson,
  payableTokens,
  sortTokens,
  isPopular,
  sameOriginAsset,
  minimumFromMessage,
  usdMinimumFromMessage,
  unitsAboveUsd,
  isFinalState,
  ETH_ON_ETHEREUM,
  MANAGER_KEY,
  QUOTE_MAX_AGE_MS,
} from '../../src/lib/intents/oneclick.js';
import { makeSwap, swapToJson, swapFromJson, withStatus, sameSwap, sealedIntentsStore, memoryIntentsStore, INTENTS_RECORD } from '../../src/lib/intents/store.js';
import { durationText, feeText, problemWords, statusWords, swapSteps, stateLine, sendText, swapSpend, KEEP_FOR_GAS, isWaiting, isExpired, untilText, whoSees } from '../../src/lib/intents/words.js';
import { isLive, UNPAID_GRACE_MS } from '../../src/lib/intents/wiring.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => JSON.parse(readFileSync(join(here, 'fixtures', 'intents', n), 'utf8'));
const copy = (o) => JSON.parse(JSON.stringify(o));

const BTC = tokenFromJson({ assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 82967 });
const ZEC = tokenFromJson({ assetId: 'nep141:zec.omft.near', decimals: 8, blockchain: 'zec', symbol: 'ZEC', price: 1224.93 });
const USDT_ETH = tokenFromJson({ assetId: 'nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDT', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', price: 1 });

// ------------------------------------------------------------------ signatures

test('real 1Click answers verify: a price-only BTC quote, a ZEC quote with its deposit address, a BTC quote under its newer id', async () => {
  assert.equal(await verifyQuote(fixture('quote_dry_btc.json')), true);
  const zec = fixture('quote_zec.json');
  assert.equal(await verifyQuote(zec), true);
  assert.match(readQuote(zec).depositAddress, /^t1/);
  const btc = fixture('quote_btc_real.json');
  assert.equal(btc.quoteRequest.originAsset, '1cs_v1:btc:native:coin', 'asked as nep141:btc.omft.near, signed under its newer id');
  assert.equal(await verifyQuote(btc), true);
  assert.match(readQuote(btc).depositAddress, /^bc1q/);
});

test('any change to a signed field fails: the deposit address, amounts, recipient, refund address, timestamp, signature', async () => {
  for (const name of ['quote_zec.json', 'quote_btc_real.json']) {
    const base = fixture(name);
    const cases = [
      (m) => (m.quote.depositAddress = `${m.quote.depositAddress.slice(0, -1)}${m.quote.depositAddress.endsWith('q') ? 'p' : 'q'}`),
      (m) => (m.quote.amountOut = '1'),
      (m) => (m.quote.minAmountOut = '1'),
      (m) => (m.quote.deadline = '2030-01-01T00:00:00.000Z'),
      (m) => (m.quoteRequest.recipient = '0x1111111111111111111111111111111111111111'),
      (m) => (m.quoteRequest.refundTo = 't1aaaa'),
      (m) => (m.quoteRequest.amount = '1'),
      (m) => (m.quoteRequest.originAsset = 'nep141:ltc.omft.near'),
      (m) => (m.timestamp = '2026-10-09T00:00:00.000Z'),
      (m) => (m.signature = 'ed25519:1111'),
      (m) => delete m.signature,
    ];
    for (const [i, change] of cases.entries()) {
      const m = copy(base);
      change(m);
      assert.equal(await verifyQuote(m), false, `${name} case ${i}`);
    }
    // Fields 1Click does not sign may change (it adds new ones over time).
    const m = copy(base);
    m.quoteRequest.sessionId = 'x';
    m.quoteRequest.appFees = [];
    m.correlationId = 'another';
    assert.equal(await verifyQuote(m), true, `${name}: unsigned fields`);
  }
});

test('another key does not verify 1Click quotes; the key is the one its SDK 0.1.26 pins', async () => {
  assert.equal(MANAGER_KEY, 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc');
  assert.equal(await verifyQuote(fixture('quote_dry_btc.json'), 'ed25519:4g54YR6MS9nHvDYR37N4xoUuu7N2ubPDA789sN18PYY3'), false);
});

test('what is signed: the SDK\'s fields only, a dry quote without its deposit fields, the quote\'s deadline over the request\'s', async () => {
  const dry = fixture('quote_dry_btc.json');
  const d = JSON.parse(signedJson(dry));
  assert.ok(!('depositAddress' in d) && !('timeEstimate' in d));
  assert.equal(d.timestamp, dry.timestamp);
  const real = fixture('quote_btc_real.json');
  const r = JSON.parse(signedJson(real));
  assert.equal(r.depositAddress, real.quote.depositAddress);
  assert.equal(r.deadline, real.quote.deadline, 'the quote\'s deadline wins (object spread, as the SDK)');
  for (const k of ['appFees', 'depositMode', 'confidentiality', 'insured', 'correlationId', 'quoteWaitingTimeMs']) assert.ok(!(k in r), k);
  assert.match(await quoteHash(real), /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});

test('stable JSON sorts keys at every level and leaves out undefined, like json-stable-stringify', () => {
  assert.equal(stableJson({ b: 1, a: [{ y: true, x: 'é' }], c: null, d: undefined }), '{"a":[{"x":"é","y":true}],"b":1,"c":null}');
  assert.equal(stableJson('a"b'), '"a\\"b"');
});

// ------------------------------------------------------------------ coins

test('coins: BTC, ZEC and LTC first, then the main coins; ETH on Ethereum (what arrives) is never offered; unreadable entries dropped', () => {
  const raw = [
    { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 5.2, contractAddress: 'wrap.near' },
    { assetId: ETH_ON_ETHEREUM, decimals: 18, blockchain: 'eth', symbol: 'ETH', price: 2499 },
    { assetId: 'nep141:ltc.omft.near', decimals: 8, blockchain: 'ltc', symbol: 'LTC', price: 63.7 },
    { assetId: 'nep141:zec.omft.near', decimals: 8, blockchain: 'zec', symbol: 'ZEC', price: 1224 },
    { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 82967 },
    { assetId: 'x:obscure', decimals: 6, blockchain: 'aptos', symbol: 'ABC', contractAddress: '0xabc' },
    { assetId: 'x:apt', decimals: 8, blockchain: 'aptos', symbol: 'APT' },
    { assetId: 7, decimals: 8, blockchain: 'btc', symbol: 'BAD' },
    { assetId: 'x:bad', decimals: 99, blockchain: 'btc', symbol: 'BAD' },
  ];
  const list = raw.map(tokenFromJson).filter(Boolean);
  assert.equal(list.length, 7);
  const shown = payableTokens(list);
  assert.deepEqual(shown.map((t) => t.symbol), ['BTC', 'ZEC', 'LTC', 'wNEAR', 'APT', 'ABC']);
  assert.ok(!shown.some((t) => t.assetId === ETH_ON_ETHEREUM));
  assert.equal(shown[0].chainName, 'Bitcoin');
  assert.equal(shown[0].isNative, true);
  assert.equal(shown.find((t) => t.symbol === 'ABC').isNative, false);
  assert.ok(isPopular(BTC) && isPopular(ZEC) && !isPopular(shown.find((t) => t.symbol === 'ABC')));
  assert.equal(USDT_ETH.isEvm, true);
  assert.deepEqual(sortTokens([]), []);
});

test('the coin 1Click echoes: itself, or its newer id on the same chain and for the same coin, nothing else', () => {
  assert.ok(sameOriginAsset(BTC, 'nep141:btc.omft.near'));
  assert.ok(sameOriginAsset(BTC, '1cs_v1:btc:native:coin'));
  assert.ok(!sameOriginAsset(BTC, '1cs_v1:ltc:native:coin'));
  assert.ok(!sameOriginAsset(BTC, '1cs_v1:btc:erc20:0xabc'));
  assert.ok(!sameOriginAsset(BTC, 'nep141:ltc.omft.near'));
  assert.ok(sameOriginAsset(USDT_ETH, '1cs_v1:eth:erc20:0xDAC17F958D2EE523A2206206994597C13D831EC7'));
  assert.ok(!sameOriginAsset(USDT_ETH, '1cs_v1:eth:erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'));
  assert.ok(!sameOriginAsset(USDT_ETH, '1cs_v1:eth:native:coin'));
  assert.ok(!sameOriginAsset(USDT_ETH, '1cs_v1:bsc:erc20:0xdac17f958d2ee523a2206206994597c13d831ec7'));
  assert.ok(!sameOriginAsset(BTC, null));
});

// ------------------------------------------------------------------ the client

/** A fetch that answers with `respond(url, init)` → {status, body (object or text)}; every call is kept. */
function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const r = await respond(url, init);
    if (r instanceof Error) throw r;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: r.status ?? 200, text: async () => text, headers: { get: () => null } };
  };
  f.calls = calls;
  return f;
}

/** A client whose quotes come from `fixtureName`, asked as that fixture's own request. */
function fixtureClient(name, mutate = (j) => j, verify = undefined) {
  const j = fixture(name);
  const f = fakeFetch(() => ({ status: 201, body: mutate(copy(j)) }));
  const c = new OneClickClient({ fetch: f, now: () => Date.parse(j.quoteRequest.deadline) - 3600000, ...(verify ? { verify } : {}) });
  return { c, f, j };
}

const askOf = (j, origin) => ({ origin, amountIn: BigInt(j.quoteRequest.amount), recipient: j.quoteRequest.recipient, refundTo: j.quoteRequest.refundTo, dry: j.quoteRequest.dry });

test('quote: asks 1Click exactly what the desktop app asks, to its API path, without cookies or a referrer', async () => {
  const { c, f, j } = fixtureClient('quote_btc_real.json');
  const q = await c.quote(askOf(j, BTC));
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://1click.chaindefuser.com/v0/quote');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['x-api-key'], undefined, 'no partner key');
  assert.deepEqual(Object.keys(body), ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline']);
  assert.equal(body.destinationAsset, ETH_ON_ETHEREUM);
  assert.equal(body.swapType, 'EXACT_INPUT');
  assert.equal(body.slippageTolerance, 100);
  assert.equal(body.originAsset, 'nep141:btc.omft.near');
  assert.equal(body.deadline, new Date(Date.parse(j.quoteRequest.deadline)).toISOString(), 'an hour from now');
  assert.ok(!JSON.stringify(body).match(/[0-9a-f]{64}/i), 'nothing that looks like a key');
  assert.equal(q.amountIn, 12000n);
  assert.equal(q.depositAddress, j.quote.depositAddress);
  assert.equal(q.sendBefore, Date.parse(j.quoteRequest.deadline), 'the time asked for comes before 1Click\'s three days');
  assert.ok(q.deadline > q.sendBefore);
  assert.equal(q.timeEstimate, j.quote.timeEstimate);
});

test('a deposit address is refused unless signed by 1Click and exactly what was asked', async () => {
  // Unsigned: a changed address.
  const t1 = fixtureClient('quote_btc_real.json', (m) => ((m.quote.depositAddress = 'bc1qattacker0000000000000000000000000000000'), m));
  await assert.rejects(t1.c.quote(askOf(t1.j, BTC)), (e) => e instanceof OneClickError && e.code === 'unsigned');
  // Signed (verification stubbed) but for another refund address, recipient, amount, coin or destination.
  const asks = [
    (a) => ({ ...a, refundTo: 'bc1qsomeoneelse' }),
    (a) => ({ ...a, recipient: '0x1111111111111111111111111111111111111111' }),
    (a) => ({ ...a, amountIn: 12001n }),
    (a) => ({ ...a, origin: ZEC }),
  ];
  for (const change of asks) {
    const t = fixtureClient('quote_btc_real.json', undefined, async () => true);
    await assert.rejects(t.c.quote(change(askOf(t.j, BTC))), (e) => e.code === 'mismatch');
  }
  const dest = fixtureClient('quote_btc_real.json', (m) => ((m.quoteRequest.destinationAsset = 'nep141:base.omft.near'), m), async () => true);
  await assert.rejects(dest.c.quote(askOf(dest.j, BTC)), (e) => e.code === 'mismatch');
  // The recipient is compared without its letter case (Ethereum checksums).
  const t2 = fixtureClient('quote_btc_real.json');
  const a = askOf(t2.j, BTC);
  await t2.c.quote({ ...a, recipient: a.recipient.toUpperCase().replace('0X', '0x') });
  // No address in a real quote.
  const t3 = fixtureClient('quote_btc_real.json', (m) => (delete m.quote.depositAddress, m), async () => true);
  await assert.rejects(t3.c.quote(askOf(t3.j, BTC)), (e) => e.code === 'no_address');
  // A price-only quote is not checked for a signature (it carries no address), but still for what was asked.
  const t4 = fixtureClient('quote_dry_btc.json');
  const q = await t4.c.quote(askOf(t4.j, BTC));
  assert.equal(q.dry, true);
  assert.equal(q.depositAddress, null);
});

test('D-14: a signed quote for another deadline, or an old one, is refused: no deposit address from it', async () => {
  // 1Click's signature covers the deadline asked for and the time it quoted; both are checked against this request.
  const signedByOneClick = async () => true;
  const later = fixtureClient('quote_btc_real.json', (m) => ((m.quoteRequest.deadline = new Date(Date.parse(m.quoteRequest.deadline) + 60000).toISOString()), m), signedByOneClick);
  await assert.rejects(later.c.quote(askOf(later.j, BTC)), (e) => e instanceof OneClickError && e.code === 'mismatch', 'a quote made for another request');
  const none = fixtureClient('quote_btc_real.json', (m) => (delete m.quoteRequest.deadline, m), signedByOneClick);
  await assert.rejects(none.c.quote(askOf(none.j, BTC)), (e) => e.code === 'mismatch');
  // The same instant written another way is the same deadline.
  const plain = fixtureClient('quote_btc_real.json', (m) => ((m.quoteRequest.deadline = m.quoteRequest.deadline.replace('Z', '+00:00')), m), signedByOneClick);
  assert.equal((await plain.c.quote(askOf(plain.j, BTC))).depositAddress, plain.j.quote.depositAddress);
  // A quote timestamped long before this request (replayed, or held back on the way): stale, said as such.
  const old = fixtureClient('quote_btc_real.json', (m) => ((m.timestamp = new Date(Date.parse(m.quoteRequest.deadline) - 3600000 - QUOTE_MAX_AGE_MS - 1000).toISOString()), m), signedByOneClick);
  const e = await old.c.quote(askOf(old.j, BTC)).catch((x) => x);
  assert.ok(e instanceof OneClickError && e.code === 'stale', String(e));
  assert.match(problemWords(e, { coin: BTC }).title, /old price/);
  assert.equal(problemWords(e, { coin: BTC }).fix, 'tryAgain');
  const dryOld = fixtureClient('quote_dry_btc.json', (m) => ((m.timestamp = new Date(Date.parse(m.quoteRequest.deadline) - 3600000 - QUOTE_MAX_AGE_MS - 1000).toISOString()), m));
  await assert.rejects(dryOld.c.quote(askOf(dryOld.j, BTC)), (x) => x.code === 'stale', 'a price-only quote too');
  const noTime = fixtureClient('quote_btc_real.json', (m) => ((m.timestamp = 'yesterday'), m), signedByOneClick);
  await assert.rejects(noTime.c.quote(askOf(noTime.j, BTC)), (x) => x.code === 'stale' || x.code === 'unexpected');
  // A few minutes of clock difference either way is not stale.
  const skewed = fixtureClient('quote_btc_real.json', (m) => ((m.timestamp = new Date(Date.parse(m.quoteRequest.deadline) - 3600000 + 4 * 60000).toISOString()), m), signedByOneClick);
  assert.ok((await skewed.c.quote(askOf(skewed.j, BTC))).depositAddress);
});

test('every way of not getting an answer has its own code; 1Click\'s own words are kept', async () => {
  const cases = [
    [{ status: 400, body: { message: 'No liquidity available', correlationId: 'x' } }, 'refused', 'No liquidity available'],
    [{ status: 400, body: { message: 'refundTo is not valid' } }, 'refused', 'refundTo is not valid'],
    [{ status: 401, body: { message: 'Unauthorized' } }, 'refused', 'Unauthorized'],
    [{ status: 429, body: { message: 'Too many requests' } }, 'busy', null],
    [{ status: 502, body: '<html>Bad gateway</html>' }, 'blocked', null],
    [{ status: 200, body: '<html>a captive portal</html>' }, 'blocked', null],
    [new TypeError('Failed to fetch'), 'network', null],
  ];
  for (const [answer, code, said] of cases) {
    const c = new OneClickClient({ fetch: fakeFetch(() => answer) });
    await assert.rejects(c.quote({ origin: BTC, amountIn: 1000n, recipient: '0x2222222222222222222222222222222222222222', refundTo: 'bc1q', dry: true }), (e) => e instanceof OneClickError && e.code === code && e.said === said, code);
  }
  const slow = new OneClickClient({ fetch: () => new Promise(() => {}), timeoutMs: 20 });
  await assert.rejects(slow.tokens(), (e) => e.code === 'network' && e.cause === 'timeout' && e.unreachable);
  const gone = new OneClickClient({ fetch: fakeFetch(() => ({ status: 404, body: { message: 'Deposit address not found' } })) });
  await assert.rejects(gone.status('bc1qx'), (e) => e.code === 'not_found');
  await assert.rejects(new OneClickClient().quote({ origin: BTC, amountIn: 0n }), TypeError);
});

test('status: asked by deposit address (and memo); a state it does not know is refused; only SUCCESS says what arrived', async () => {
  const pending = fixture('status_pending.json');
  const f = fakeFetch(() => ({ status: 200, body: pending }));
  const c = new OneClickClient({ fetch: f });
  const s = await c.status('bc1q xyz', { memo: '12 3' });
  assert.equal(f.calls[0].url, 'https://1click.chaindefuser.com/v0/status?depositAddress=bc1q+xyz&depositMemo=12+3');
  assert.equal(f.calls[0].init.method, 'GET');
  assert.equal(s.state, 'PENDING_DEPOSIT');
  assert.equal(s.amountOut, null);
  assert.equal(s.refunded, null, '"0" refunded is no refund');
  const done = readStatus({ status: 'SUCCESS', swapDetails: { amountOut: '3939712647623936', destinationChainTxHashes: [{ hash: `0x${'ab'.repeat(32)}`, explorerUrl: 'x' }, { nope: 1 }] } });
  assert.equal(done.amountOut, 3939712647623936n);
  assert.deepEqual(done.destinationTxs, [`0x${'ab'.repeat(32)}`]);
  const back = readStatus({ status: 'REFUNDED', swapDetails: { refundedAmount: '10100', refundReason: 'Deposit too late' } });
  assert.equal(back.refunded, 10100n);
  assert.equal(back.refundReason, 'Deposit too late');
  assert.throws(() => readStatus({ status: 'EXPLODED' }), (e) => e.code === 'unexpected');
  assert.ok(isFinalState('SUCCESS') && isFinalState('REFUNDED') && isFinalState('FAILED'));
  assert.ok(!isFinalState('PROCESSING') && !isFinalState('INCOMPLETE_DEPOSIT') && !isFinalState('PENDING_DEPOSIT'));
});

test('the smallest amount, when 1Click names one', () => {
  assert.equal(minimumFromMessage('Amount is too low for bridge, try at least 8516'), 8516n);
  assert.equal(minimumFromMessage('No liquidity available'), null);
  assert.equal(minimumFromMessage(null), null);
});

// ------------------------------------------------------------------ swaps on this device

const swapOf = (name = 'quote_btc_real.json', extra = {}) => makeSwap({ quote: fixture(name), origin: name.includes('zec') ? ZEC : BTC, createdAt: 1760000000000, ...extra });

test('a swap round-trips through its stored form, the signed quote kept as 1Click sent it', () => {
  const s = swapOf();
  const j = JSON.parse(JSON.stringify(swapToJson(s)));
  assert.deepEqual(j.quote, fixture('quote_btc_real.json'));
  const back = swapFromJson(j);
  assert.equal(back.depositAddress, s.depositAddress);
  assert.equal(back.origin.chainName, 'Bitcoin');
  assert.equal(back.isOpen, true);
  const done = withStatus(s, readStatus({ status: 'SUCCESS', swapDetails: { amountOut: '3900000000000000', destinationChainTxHashes: [{ hash: '0xabc' }] } }), 1760000100000);
  assert.equal(done.isOpen, false);
  const again = swapFromJson(JSON.parse(JSON.stringify(swapToJson(done))));
  assert.equal(again.amountOut, 3900000000000000n);
  assert.deepEqual(again.destinationTxs, ['0xabc']);
  assert.equal(again.lastState, 'SUCCESS');
  assert.ok(sameSwap(done, again) && !sameSwap(s, done));
  assert.throws(() => makeSwap({ quote: fixture('quote_dry_btc.json'), origin: BTC, createdAt: 1 }), /no deposit address/);
  assert.throws(() => makeSwap({ quote: fixture('quote_btc_real.json'), origin: BTC, createdAt: 1, state: 'WHO_KNOWS' }), /bad state/);
});

test('swaps under way: open, and not an address nobody paid before it stopped working', () => {
  const s = swapOf();
  assert.ok(isLive(s, s.quote.sendBefore - 1));
  assert.ok(isLive(s, s.quote.sendBefore + 1), 'just past the hour asked for: a deposit may be on its way');
  assert.ok(!isLive(s, s.quote.sendBefore + UNPAID_GRACE_MS + 1), 'nobody paid it in time');
  assert.ok(!isLive(s, s.quote.deadline + 1));
  const seen = withStatus(s, readStatus({ status: 'KNOWN_DEPOSIT_TX' }), 1);
  assert.ok(isLive(seen, s.quote.deadline + 1), 'paid: followed until it ends');
  assert.ok(!isLive(withStatus(s, readStatus({ status: 'REFUNDED' }), 1)));
});

function sealingApp(id = '0123456789abcdef') {
  const hex = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
  return { record: { id, imported: false }, dbPass: hex };
}
function memoryKv() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), del: async (k) => void m.delete(k) };
}

test('swaps are sealed per wallet: under its own key, nothing readable in the clear, refused for another wallet or once locked', async () => {
  const app = sealingApp();
  const kv = memoryKv();
  const store = sealedIntentsStore(app, { ethId: 'eth-1', kv });
  assert.deepEqual(await store.all(), []);
  const a = swapOf();
  const b = makeSwap({ quote: fixture('quote_zec.json'), origin: ZEC, createdAt: 1760000500000 });
  await store.save(a);
  await store.save(b);
  assert.deepEqual([...kv.m.keys()], [`w:${app.record.id}:${INTENTS_RECORD}`]);
  const raw = JSON.stringify([...kv.m.values()]);
  for (const secret of [a.depositAddress, a.quote.refundTo, a.quote.recipient, b.depositAddress]) assert.ok(!raw.includes(secret), 'sealed');
  const list = await store.all();
  assert.deepEqual(list.map((s) => s.origin.symbol), ['ZEC', 'BTC'], 'newest first');
  assert.equal((await store.get(a.depositAddress)).quote.raw.signature, fixture('quote_btc_real.json').signature);
  // Updating one keeps the other.
  await store.save(withStatus(a, readStatus({ status: 'PROCESSING' }), 2));
  assert.equal((await store.get(a.depositAddress)).lastState, 'PROCESSING');
  assert.equal((await store.all()).length, 2);
  // Another Ethereum wallet of the same Firo wallet sees none of them.
  assert.deepEqual(await sealedIntentsStore(app, { ethId: 'eth-2', kv }).all(), []);
  // Another password does not open them.
  await assert.rejects(sealedIntentsStore({ ...app, dbPass: sealingApp().dbPass }, { ethId: 'eth-1', kv }).all());
  // A store bound to this wallet refuses to write once another wallet is open, or it is locked.
  app.record = { id: 'fedcba9876543210', imported: false };
  await assert.rejects(store.save(a), /locked/);
  app.record = { id: '0123456789abcdef', imported: false };
  app.dbPass = null;
  await assert.rejects(store.save(a), /locked/);
  const mem = memoryIntentsStore();
  await mem.save(a);
  assert.equal((await mem.get(a.depositAddress)).depositAddress, a.depositAddress);
});

// ------------------------------------------------------------------ words

test('durations, the fee line, and what NEAR Intents sees', () => {
  assert.equal(durationText(52), '52 seconds');
  assert.equal(durationText(812), '14 minutes');
  assert.equal(durationText(7200), '2.0 hours');
  const q = readQuote(fixture('quote_btc_real.json'));
  assert.match(feeText(q), /^about \$0\.\d\d \(\d\.\d%\)$/);
  assert.equal(feeText({ amountInUsd: 10, amountOutUsd: 9.999 }), 'less than $0.01');
  assert.equal(feeText({ amountInUsd: null, amountOutUsd: 1 }), null);
  const who = whoSees('1click.chaindefuser.com');
  for (const w of ['IP address', 'amount', 'refund address', 'address on Ethereum and BNB Chain', 'never a key']) assert.ok(who.includes(w), w);
});

test('refusals in plain words, each with its one fix; nothing blames the person', () => {
  const refused = (said) => new OneClickError('refused', said, { status: 400 });
  const cases = [
    [refused('No liquidity available'), 'tryAgain', /can't swap BTC into ETH right now/],
    [refused('refundTo is not valid'), 'editRefund', /isn't a Bitcoin address/],
    [refused('Failed to get quote'), 'editAmount', /can't price 0\.00005 BTC/],
    [refused('Amount is too low for bridge, try at least 8516'), 'useMinimum', /Send at least 0\.00008516 BTC/],
    [refused('Something new'), 'editAmount', /would not price this/],
    [new OneClickError('network'), 'tryAgain', /Couldn't reach NEAR Intents/],
    [new OneClickError('busy'), 'tryAgain', /busy/],
    [new OneClickError('unsigned'), 'tryAgain', /didn't check out/],
    [new OneClickError('mismatch'), 'tryAgain', /didn't check out/],
    [new OneClickError('cannot_verify'), 'tryAgain', /can't check NEAR Intents' signature/],
  ];
  for (const [e, fix, title] of cases) {
    const p = problemWords(e, { coin: BTC, amountText: '0.00005 BTC' });
    assert.equal(p.fix, fix, e.message);
    assert.match(p.title, title);
    assert.match(`${p.title} ${p.detail}`, /[Nn]othing was sent|no deposit address is shown|Nothing was sent/);
    assert.ok(!/your fault|you did wrong|invalid input/i.test(`${p.title} ${p.detail}`));
    assert.ok(p.fixLabel);
  }
  assert.equal(problemWords(refused('try at least 8516'), { coin: BTC }).minimum, 8516n);
  assert.match(problemWords(refused('Something new'), { coin: BTC }).detail, /It said: "Something new"/);
});

test("NEAR Intents' minimum in dollars ($1,000 since 2026-10): named, with an amount just above it", () => {
  const refused = (m) => new OneClickError('refused', m, { status: 400 });
  const said = 'Temporary swap limits: minimum swap amount is $1,000';
  assert.equal(usdMinimumFromMessage(said), 1000);
  assert.equal(usdMinimumFromMessage('minimum swap amount is $12.50'), 12.5);
  assert.equal(usdMinimumFromMessage('try at least 8516'), null);
  const USDC = { symbol: 'USDC', chainName: 'Arbitrum', decimals: 6, priceUsd: 0.9998 };
  const units = unitsAboveUsd(1000, USDC);
  assert.ok(units * 9998n >= 1020n * 10n ** 6n * 10000n - 10n ** 6n, 'at least 2% above $1,000');
  assert.ok(units < 1021n * 10n ** 6n);
  const w = problemWords(refused(said), { coin: USDC });
  assert.equal(w.fix, 'useMinimum');
  assert.match(w.title, /NEAR Intents swaps \$1,000 or more right now\./);
  assert.match(w.fixLabel, /^Use 1,020\.\d+ USDC$/);
  assert.equal(w.minimum, units);
  assert.doesNotMatch(`${w.title} ${w.detail}`, /refund address/);
  const noPrice = problemWords(refused(said), { coin: { ...USDC, priceUsd: null } });
  assert.equal(noPrice.fix, 'editAmount');
  assert.match(noPrice.detail, /at least \$1,000 worth of USDC/);
});

test('where a swap is: its line, its notice and its three steps', () => {
  const s = swapOf();
  assert.equal(sendText(s), '0.00012 BTC');
  // A fixed clock before the recorded quote's deadline (the real one passes, a few days after recording).
  const before = s.quote.sendBefore - 60000;
  assert.equal(stateLine(s, before), 'Waiting for your 0.00012 BTC');
  assert.equal(stateLine(s, s.quote.sendBefore + 60000), 'No BTC arrived in time');
  const at = (state, out) => withStatus(s, readStatus({ status: state, swapDetails: out ? { amountOut: out } : {} }), 1);
  assert.equal(stateLine(at('PROCESSING')), 'Swapping your 0.00012 BTC into ETH…');
  assert.equal(stateLine(at('INCOMPLETE_DEPOSIT')), 'Less than 0.00012 BTC arrived');
  assert.equal(statusWords(s, { now: before }).key, 'waiting');
  assert.equal(statusWords(at('KNOWN_DEPOSIT_TX')).key, 'seen');
  assert.equal(statusWords(at('PROCESSING')).key, 'processing');
  assert.equal(statusWords(at('SUCCESS', '1000'), { got: 1000n, ethText: (w) => `${w} wei` }).title, '1000 wei arrived in this wallet.');
  assert.match(statusWords(at('REFUNDED')).title, /Sent back to your Bitcoin address/);
  assert.equal(statusWords(at('FAILED')).kind, 'error');
  assert.equal(statusWords(at('INCOMPLETE_DEPOSIT')).kind, 'warn');
  const marks = (st) => swapSteps(st).map((x) => x.mark).join(' ');
  assert.equal(marks(null), 'active waiting waiting');
  assert.equal(marks('KNOWN_DEPOSIT_TX'), 'done active waiting');
  assert.equal(marks('PROCESSING'), 'done active waiting');
  assert.equal(marks('SUCCESS'), 'done done done');
  assert.equal(marks('REFUNDED'), 'done failed waiting');
  assert.equal(marks('INCOMPLETE_DEPOSIT'), 'active waiting waiting');
  assert.equal(swapSteps('INCOMPLETE_DEPOSIT')[0].label, 'Part of your deposit arrived');
  assert.ok(swapSteps('SUCCESS').length <= 4);
  assert.ok(isWaiting(null) && isWaiting('PENDING_DEPOSIT') && isWaiting('INCOMPLETE_DEPOSIT') && !isWaiting('PROCESSING'));
});

test('past the time asked for, an unpaid swap says so: no more deposits, start a new one', () => {
  const s = swapOf();
  const late = s.quote.sendBefore + 1;
  assert.ok(!isExpired(s, s.quote.sendBefore - 1) && isExpired(s, late));
  assert.equal(stateLine(s, late), 'No BTC arrived in time');
  const w = statusWords(s, { now: late });
  assert.equal(w.key, 'expired');
  assert.match(w.detail, /Don't send to this address any more/);
  assert.deepEqual(swapSteps(null, { expired: true }).map((x) => x.mark), ['failed', 'waiting', 'waiting']);
  // Paid, even late: followed as usual.
  assert.ok(!isExpired(withStatus(s, readStatus({ status: 'KNOWN_DEPOSIT_TX' }), 1), late));
});

test('the ETH that arrived is swapped to rsFIRO, keeping 0.0005 ETH for that swap\'s network fee (half of a small amount)', () => {
  const ETHER = 10n ** 18n;
  assert.equal(KEEP_FOR_GAS, 5n * 10n ** 14n);
  assert.equal(swapSpend(ETHER / 100n), ETHER / 100n - KEEP_FOR_GAS);
  assert.equal(swapSpend(8n * 10n ** 14n), 4n * 10n ** 14n);
  assert.equal(swapSpend(0n), 0n);
  assert.equal(swapSpend(null), 0n);
});

test('"send before" says the day when it is not today', () => {
  const now = new Date(2026, 9, 11, 9, 0).getTime();
  assert.equal(untilText(new Date(2026, 9, 11, 10, 22).getTime(), now), '10:22 today');
  assert.equal(untilText(new Date(2026, 9, 14, 9, 5).getTime(), now), '09:05 on 14 Oct');
});
