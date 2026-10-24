// The buyfiro.app sell client over a fake fetch: every error code its v1
// documents, a proxy's HTML page and a dead connection (never "the sell
// failed"), sandbox in the URL of every call and in the order's body, no
// cookies and no referrer, an order answer refused for every way it can differ
// from the question (amount, payout, deposit kind, an address this wallet does
// not read as a Firo address of that kind), every state including each one the
// sandbox can be forced into, and the payout's explorer link only on a known host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SellClient, SellError, ERROR_CODES, underTest, firoNumber, satsOf, exactForApi, payoutChainName, payoutTokenFromJson, parseState, isFinalState, STATES, FORCEABLE, DEFAULT_PAYOUT, USDT_BSC, clean } from '../../src/lib/sell/sellfiro.js';
import { sellApiBase, sellConnectSources, sellSiteUrl, SELL_HOSTS, payoutTxUrl } from '../../src/lib/sell/hosts.js';
import { FakeSellFiro, answer, envelope, sellErrorJson, httpOf, classify, SELL_CODES, PAYOUT, PAYOUT_2, SPARK_DEPOSIT, T_DEPOSIT, NATIVE, TXID } from './sell_fakes.mjs';

const COIN = 100000000n;
const firo = (n) => BigInt(Math.round(n * 1e8));
const payout = (over = {}) => ({ ...DEFAULT_PAYOUT, address: PAYOUT, ...over });
const client = (s, opts = {}) => new SellClient({ fetch: s.fetch, classifyAddress: classify, ...opts });
const order = (c, { amount = 500n * COIN, kind = 'spark', p = payout() } = {}) => c.order({ amount, payout: p, depositKind: kind });

async function error(p) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SellError, `a SellError, not ${e}`);
    return e;
  }
  assert.fail('expected a SellError');
}

test('the API lives under one path of buyfiro.app', () => {
  assert.equal(sellApiBase(), 'https://buyfiro.app/api/v1/sell');
  assert.deepEqual(sellConnectSources(), ['https://buyfiro.app/api/v1/sell/']);
  assert.equal(sellSiteUrl(), 'https://buyfiro.app');
  assert.throws(() => sellApiBase({ host: 'evil.example', path: '/' }), /listed/);
  assert.equal(SELL_HOSTS.length, 1);
});

test('every documented error code is its own typed error, with its HTTP status', async () => {
  assert.deepEqual([...ERROR_CODES].sort(), [...SELL_CODES].sort());
  for (const code of SELL_CODES) {
    const s = new FakeSellFiro();
    s.queue('/quote', answer(httpOf(code), sellErrorJson(code)));
    const e = await error(client(s).quote({ amount: 500n * COIN, payout: payout() }));
    assert.equal(e.code, code);
    assert.equal(e.rawCode, code);
    assert.equal(e.httpStatus, httpOf(code));
  }
  const s = new FakeSellFiro();
  s.queue('/limits', answer(400, sellErrorJson('new_in_v1_9')));
  const e = await error(client(s).limits());
  assert.equal(e.code, 'unknown');
  assert.equal(e.rawCode, 'new_in_v1_9');
});

test('the figures an error carries: the smallest and largest sell, retry_after, the unknown fields', async () => {
  const s = new FakeSellFiro();
  s.queue('/quote', answer(400, sellErrorJson('amount_below_minimum', { minimumFiro: 312.5 })));
  let e = await error(client(s).quote({ amount: 100n * COIN, payout: payout() }));
  assert.equal(e.belowMinimum, true);
  assert.equal(e.minimumFiro, 312.5);
  s.queue('/quote', answer(400, sellErrorJson('amount_above_maximum', { maximumFiro: 9680.54 })));
  e = await error(client(s).quote({ amount: 20000n * COIN, payout: payout() }));
  assert.equal(e.aboveMaximum, true);
  assert.equal(e.maximumFiro, 9680.54);
  s.queue('/order', answer(429, sellErrorJson('rate_limited', { retryAfter: 600 })));
  assert.equal((await error(order(client(s)))).retryAfterMs, 600000);
  s.queue('/limits', answer(503, { ...sellErrorJson('unavailable'), retry_after: 12 }));
  assert.equal((await error(client(s).limits())).retryAfterMs, 12000);
  s.queue('/limits', answer(503, sellErrorJson('price_unavailable'), { 'retry-after': '7' }));
  assert.equal((await error(client(s).limits())).retryAfterMs, 7000);
  // The fake itself refuses an unknown key, as buyfiro.app does: the client never sends one.
  s.queue('/order', answer(400, sellErrorJson('bad_body', { unknownFields: ['extra'] })));
  assert.deepEqual((await error(order(client(s)))).unknownFields, ['extra']);
});

test("a proxy's HTML 403 or plain-text 502 is 'blocked'; no connection or no answer is 'network'; JSON without ok is unexpected", async () => {
  const s = new FakeSellFiro();
  s.queue('/order', answer(403, '<!DOCTYPE html><html><body>Blocked</body></html>', { 'content-type': 'text/html' }));
  let e = await error(order(client(s)));
  assert.equal(e.code, 'blocked');
  assert.equal(e.unreachable, true);
  assert.equal(e.httpStatus, 403);
  s.queue('/limits', answer(502, 'Bad gateway', { 'content-type': 'text/plain' }));
  assert.equal((await error(client(s).limits())).code, 'blocked');
  const off = new FakeSellFiro();
  off.offline = true;
  e = await error(client(off).payoutChains());
  assert.equal(e.code, 'network');
  assert.equal(e.unreachable, true);
  const never = new FakeSellFiro();
  never.queue('/limits', { __never: true });
  assert.equal((await error(client(never, { timeoutMs: 50 }).limits())).code, 'network');
  const odd = new FakeSellFiro();
  odd.queue('/limits', { hello: 1 });
  assert.equal((await error(client(odd).limits())).code, 'unexpected_answer');
  // FastAPI's own validation answer (not the envelope): unexpected, not a refusal.
  odd.queue('/quote', answer(422, { detail: [{ type: 'float_parsing' }] }));
  assert.equal((await error(client(odd).quote({ amount: 500n * COIN, payout: payout() }))).code, 'unexpected_answer');
});

test('sandbox: ?sandbox=true in the URL of every call; the order body says it too; its keys are exactly the documented ones', async () => {
  const s = new FakeSellFiro();
  const c = client(s, { sandbox: true });
  await c.health();
  await c.payoutChains();
  await c.payoutTokens(56, { symbol: 'USDT' });
  await c.limits(payout());
  await c.quote({ amount: 500n * COIN, payout: payout() });
  const o = await order(c);
  assert.match(o.orderId, /^sbx_/);
  assert.equal(o.payable, false, 'a sandbox order is never payable');
  assert.equal(o.depositAddress, 'sbx_not_payable');
  await c.status(o.orderId);
  await c.status(o.orderId, { forceState: 'refused' });
  assert.equal(s.requests.length, 8);
  for (const r of s.requests) assert.equal(r.url.searchParams.get('sandbox'), 'true', String(r.url));
  const post = s.posts()[0];
  assert.equal(post.url.pathname, '/api/v1/sell/order');
  assert.equal(post.url.search, '?sandbox=true', 'the payout address is never in the URL');
  assert.deepEqual(Object.keys(post.body).sort(), ['amount_firo', 'deposit_kind', 'order_type', 'payout_address', 'payout_chain_id', 'payout_token', 'sandbox']);
  assert.deepEqual(post.body, { amount_firo: 500, payout_chain_id: 56, payout_token: USDT_BSC, payout_address: PAYOUT, deposit_kind: 'spark', order_type: 'market', sandbox: true });
  assert.equal(s.requests.at(-1).url.pathname, `/api/v1/sell/order/${o.orderId}%3Arefused`);
  assert.equal(new SellClient({ fetch: s.fetch, sandbox: 'yes' }).sandbox, false, 'only an exact true turns it on');
  // Without sandbox no call carries it.
  const live = new FakeSellFiro();
  await client(live).limits();
  await order(client(live));
  for (const r of live.requests) assert.equal(r.url.searchParams.has('sandbox'), false);
  assert.equal('sandbox' in live.posts()[0].body, false);
});

test('no test reaches buyfiro.app for real: under a test runner every request through the real network is refused unless in sandbox mode', async () => {
  assert.equal(underTest(), true, 'node --test marks its test processes');
  assert.equal(underTest({}), false);
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
    return new Response(JSON.stringify({ ok: true, error: null, healthy: true, spark_deposits: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const prod = new SellClient();
    assert.equal(prod.realNetwork, true);
    assert.equal((await error(prod.health())).code, 'sandbox_required', 'a GET too');
    assert.equal((await error(order(prod))).code, 'sandbox_required');
    assert.equal(seen.length, 0, 'nothing left the process');
    const sbx = new SellClient({ sandbox: true });
    await sbx.health();
    assert.equal(seen.length, 1);
    assert.equal(new URL(seen[0].url).searchParams.get('sandbox'), 'true');
  } finally {
    globalThis.fetch = real;
  }
  const { sellSandbox, devSandbox, SANDBOX_KEY } = await import('../../src/lib/sell/wiring.js');
  const set = { getItem: (k) => (k === SANDBOX_KEY ? '1' : null) };
  assert.equal(devSandbox({ hostname: 'localhost' }, set), true);
  assert.equal(devSandbox({ hostname: 'pwa.example.org' }, set), false);
  assert.equal(devSandbox({ hostname: 'localhost' }, { getItem: () => { throw new Error('blocked'); } }), false);
  assert.equal(sellSandbox({ hostname: 'pwa.example.org' }, { getItem: () => null }, {}), false, 'a real address, no runner: the real API');
  assert.equal(sellSandbox({ hostname: 'pwa.example.org' }, { getItem: () => null }), true, 'under node --test: always sandbox');
});

test('no test file reaches buyfiro.app for real: every SellClient is handed a fetch or is in sandbox mode', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  for (const dir of ['unit', 'e2e', 'fork', 'live']) {
    let names = [];
    try {
      names = readdirSync(new URL(`${dir}/`, root));
    } catch {
      continue;
    }
    for (const n of names.filter((x) => /\.m?js$/.test(x))) {
      const src = readFileSync(new URL(`${dir}/${n}`, root), 'utf8');
      for (const m of src.matchAll(/new SellClient\(([^)]*)\)/g)) {
        if (`${dir}/${n}` === 'unit/sellfiro_client.test.mjs' && /^\)?$|sandbox: true|sandbox: 'yes'/.test(m[1])) continue; // the guard test above
        assert.match(m[1], dir === 'live' ? /sandbox: true/ : /fetch:|sandbox: true/, `${dir}/${n}: ${m[0]} would use the real network`);
      }
    }
  }
});

test('no cookies, no referrer, JSON asked for; a GET carries nothing that makes the browser ask first', async () => {
  const s = new FakeSellFiro();
  await order(client(s));
  const r = s.requests[0];
  assert.equal(r.init.credentials, 'omit');
  assert.equal(r.init.referrerPolicy, 'no-referrer');
  assert.equal(r.init.redirect, 'error');
  assert.equal(r.headers.accept, 'application/json');
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.url.href.includes(PAYOUT), false);
  assert.equal(r.url.origin, 'https://buyfiro.app');
  const get = new FakeSellFiro();
  await client(get).limits();
  assert.deepEqual(Object.keys(get.requests[0].headers), ['accept']);
});

test('payout chains and tokens: BNB Chain by its name, unreadable entries skipped, a creator\'s text cleaned', async () => {
  const s = new FakeSellFiro();
  const { chains, recommended } = await client(s).payoutChains();
  assert.equal(chains.find((c) => c.chainId === 56).name, 'BNB Chain');
  assert.equal(chains.find((c) => c.chainId === 8453).name, 'Base');
  assert.deepEqual(recommended, { chainId: 56, token: USDT_BSC, symbol: 'USDT' });
  const usdt = await client(s).payoutTokens(56, { symbol: 'usdt' });
  assert.deepEqual(usdt.tokens.map((t) => t.symbol), ['USDT', 'USDT']);
  assert.equal(s.requests.at(-1).url.searchParams.get('symbol'), 'usdt');
  const all = await client(s).payoutTokens(56);
  assert.equal(all.tokens[0].isNative, true);
  assert.equal(all.tokens[0].token, NATIVE);
  s.queue('/payout-tokens', envelope({ chain_id: 56, tokens: [{ token: 'nope', symbol: 'X' }, { token: USDT_BSC, symbol: '' }, { token: USDT_BSC, symbol: 'U‮SDT', name: 'x'.repeat(99), decimals: 99 }] }));
  const odd = await client(s).payoutTokens(56);
  assert.equal(odd.tokens.length, 1);
  assert.equal(odd.tokens[0].symbol, 'USDT', 'no direction characters');
  assert.equal(odd.tokens[0].name.length, 40);
  assert.equal(odd.tokens[0].decimals, null);
  s.queue('/payout-tokens', envelope({ chain_id: 1, tokens: [] }));
  assert.equal((await error(client(s).payoutTokens(56))).code, 'unexpected_answer', 'tokens of another chain');
  assert.equal(payoutChainName(999, 'HyperEVM'), 'HyperEVM');
  assert.equal(payoutChainName(7), 'Chain 7');
  assert.equal(payoutTokenFromJson({ token: NATIVE, symbol: 'ETH' }, 1).isNative, true);
  assert.equal(clean('a\u0000b⁦c'), 'abc');
});

test('limits for a payout, and health', async () => {
  const s = new FakeSellFiro();
  const l = await client(s).limits(payout());
  assert.deepEqual({ ...l }, { minimumFiro: 300, maximumFiro: 9691.8, route: 'direct' });
  assert.deepEqual(Object.fromEntries(s.requests[0].url.searchParams), { payout_chain_id: '56', payout_token: USDT_BSC });
  s.sparkOff = true;
  assert.deepEqual({ ...(await client(s).health()) }, { healthy: true, sparkDeposits: false });
});

test('quote: the answer is about this amount; its own limits refuse an amount outside them (the sandbox only names them)', async () => {
  const s = new FakeSellFiro();
  const q = await client(s).quote({ amount: 500n * COIN, payout: payout() });
  assert.equal(q.receiveUsd, 480);
  assert.equal(q.route, 'direct');
  assert.equal(q.amount, 500n * COIN);
  assert.deepEqual(Object.fromEntries(s.requests[0].url.searchParams), { amount_firo: '500', payout_chain_id: '56', payout_token: USDT_BSC });
  for (const body of [{ amount_firo: 501, receive_usd_estimate: 1 }, { amount_firo: 500 }, { amount_firo: 500, receive_usd_estimate: -1 }, { amount_firo: 500, receive_usd_estimate: 1, payout_chain_id: 1 }, { amount_firo: 500, receive_usd_estimate: 1, payout_token: NATIVE }]) {
    s.queue('/quote', envelope(body));
    assert.equal((await error(client(s).quote({ amount: 500n * COIN, payout: payout() }))).code, 'unexpected_answer', JSON.stringify(body));
  }
  const sbx = new FakeSellFiro();
  sbx.refuseOutOfLimits = false;
  const low = await error(client(sbx, { sandbox: true }).quote({ amount: 100n * COIN, payout: payout() }));
  assert.equal(low.code, 'amount_below_minimum');
  assert.equal(low.minimumFiro, 300);
  const high = await error(client(sbx, { sandbox: true }).quote({ amount: 20000n * COIN, payout: payout() }));
  assert.equal(high.code, 'amount_above_maximum');
  assert.equal(high.maximumFiro, 9691.8);
  assert.equal((await client(sbx, { sandbox: true }).quote({ amount: firo(300), payout: payout() })).receiveUsd, 288, 'exactly the smallest sell is a sell');
});

test('amounts: satoshi to the JSON number and back, exactly', () => {
  assert.equal(firoNumber(50012345678n), 500.12345678);
  assert.equal(satsOf(500.12345678), 50012345678n);
  assert.equal(satsOf('500.0'), 50000000000n);
  assert.equal(satsOf(-1), null);
  assert.equal(satsOf('abc'), null);
  for (const s of [1n, 30000000000n, 968054000000n, 999999999999n, 123456789012n]) assert.equal(exactForApi(s), true, String(s));
  assert.equal(exactForApi(0n), false);
  assert.equal(exactForApi(500), false, 'satoshi as BigInt only');
});

test('order: Spark (private) deposits come with both addresses, each read by the wallet as its kind; the order is exactly the one asked for', async () => {
  const s = new FakeSellFiro();
  const o = await order(client(s));
  assert.match(o.orderId, /^sell_/);
  assert.equal(o.payable, true);
  assert.equal(o.depositKind, 'spark');
  assert.equal(o.sparkDepositAddress, SPARK_DEPOSIT);
  assert.equal(o.depositAddress, T_DEPOSIT);
  assert.equal(o.receiveUsd, 480);
  assert.equal(o.expiresInMs, 24 * 3600 * 1000);
  assert.equal(o.reused, false);
  const t = await order(client(new FakeSellFiro()), { kind: 'firo' });
  assert.equal(t.sparkDepositAddress, null);
  assert.equal(t.depositAddress, T_DEPOSIT);
  // Asked again for the same payout before it is paid: the same order, reused.
  const again = await order(client(s));
  assert.equal(again.orderId, o.orderId);
  assert.equal(again.reused, true);
});

test('an order answer that differs from the question is refused, and nothing in it is used', async () => {
  const good = { order_id: 'sell_1_ok', payable: true, deposit_address: T_DEPOSIT, spark_deposit_address: SPARK_DEPOSIT, deposit_kind: 'spark', amount_firo: 500, receive_usd_estimate: 480, payout: { chain_id: 56, token: USDT_BSC.toLowerCase(), symbol: 'USDT', address: PAYOUT.toLowerCase() }, order_type: 'market', expires_in_h: 24, reused: false };
  const cases = {
    'no order id': { ...good, order_id: '' },
    'an order id with a path in it': { ...good, order_id: '../x' },
    'another amount': { ...good, amount_firo: 500.00000001 },
    'no amount': { ...good, amount_firo: undefined },
    'another deposit kind': { ...good, deposit_kind: 'firo' },
    'a limit order': { ...good, order_type: 'limit' },
    'another payout address': { ...good, payout: { ...good.payout, address: PAYOUT_2 } },
    'another payout chain': { ...good, payout: { ...good.payout, chain_id: 1 } },
    'another payout token': { ...good, payout: { ...good.payout, token: NATIVE } },
    'no payout echo (live)': { ...good, payout: undefined },
    'not payable': { ...good, payable: false },
    'a deposit address the wallet does not read': { ...good, deposit_address: 'bc1qnotfiro' },
    'a Spark address as the transparent one': { ...good, deposit_address: SPARK_DEPOSIT },
    'a transparent address as the Spark one': { ...good, spark_deposit_address: T_DEPOSIT },
    'no Spark address for a Spark deposit': { ...good, spark_deposit_address: null },
    'an exchange address': { ...good, deposit_address: `EX${'1'.repeat(34)}` },
    'a Spark name': { ...good, spark_deposit_address: '@buyfiro' },
  };
  for (const [what, body] of Object.entries(cases)) {
    const s = new FakeSellFiro();
    s.queue('/order', envelope(body));
    assert.equal((await error(order(client(s)))).code, 'unexpected_answer', what);
  }
  // Without the wallet's classifier nothing is payable.
  const s = new FakeSellFiro();
  assert.equal((await error(new SellClient({ fetch: s.fetch }).order({ amount: 500n * COIN, payout: payout(), depositKind: 'spark' }))).code, 'unexpected_answer');
  // The open sell buyfiro.app keeps for this payout, for another amount: said as such.
  s.queue('/order', envelope({ ...good, amount_firo: 750, reused: true }));
  const e = await error(order(client(s)));
  assert.equal(e.code, 'order_exists');
  assert.equal(e.orderId, 'sell_1_ok');
  assert.equal(e.amountFiro, 750);
  // Asking for something the API would not take never leaves the device.
  const c = new FakeSellFiro();
  assert.equal((await error(order(client(c), { p: payout({ address: 'nope' }) }))).code, 'payout_address_invalid');
  assert.equal((await error(order(client(c), { amount: 0n }))).code, 'bad_amount');
  await assert.rejects(order(client(c), { kind: 'lelantus' }), TypeError);
  assert.equal(c.requests.length, 0);
});

test('sandbox orders: a placeholder address and not payable is fine; a real-looking id is not', async () => {
  const s = new FakeSellFiro();
  const o = await order(client(s, { sandbox: true }));
  assert.equal(o.payable, false);
  assert.equal(o.sparkDepositAddress, 'sbx_not_payable');
  s.queue('/order', envelope({ order_id: 'sell_1_real', payable: false, deposit_address: 'sbx_not_payable', spark_deposit_address: 'sbx_not_payable', deposit_kind: 'spark', amount_firo: 500 }));
  assert.equal((await error(order(client(s, { sandbox: true })))).code, 'unexpected_answer', 'a real order while testing is never used');
  // A payable sandbox answer (the e2e's stand-in) is still checked like a real one.
  const p = new FakeSellFiro();
  p.payableSandbox = true;
  const paid = await order(client(p, { sandbox: true }));
  assert.equal(paid.payable, true);
  assert.equal(paid.sparkDepositAddress, SPARK_DEPOSIT);
  p.sparkDeposit = 'not-an-address';
  assert.equal((await error(order(client(p, { sandbox: true }), { p: payout({ address: PAYOUT_2 }) }))).code, 'unexpected_answer');
});

test('every state; every state the sandbox can be forced into; an unknown one is "in progress", never an ending', async () => {
  const s = new FakeSellFiro();
  const o = await order(client(s));
  for (const st of STATES) {
    s.state = st;
    const r = await client(s).status(o.orderId);
    assert.equal(r.state, st);
    assert.equal(r.terminal, isFinalState(st), st);
  }
  assert.deepEqual(['delivered', 'expired', 'refused'].filter(isFinalState), ['delivered', 'expired', 'refused']);
  assert.equal(isFinalState('attention'), false, 'attention: held for review, still followed');
  const sb = new FakeSellFiro();
  const so = await order(client(sb, { sandbox: true }));
  for (const st of FORCEABLE) {
    const r = await client(sb, { sandbox: true }).status(so.orderId, { forceState: st });
    assert.equal(r.state, st);
    assert.equal(r.orderId, so.orderId, 'the echo is the order, not the forced id');
    assert.equal(sb.requests.at(-1).url.pathname, `/api/v1/sell/order/${so.orderId}%3A${st}`);
  }
  // Outside the sandbox a forced state is never asked for.
  await client(sb).status(so.orderId, { forceState: 'delivered' });
  assert.equal(sb.requests.at(-1).url.pathname, `/api/v1/sell/order/${so.orderId}`);
  s.queue(`/order/${o.orderId}`, envelope({ order_id: o.orderId, state: 'teleporting', terminal: true }));
  const odd = await client(s).status(o.orderId);
  assert.equal(odd.state, 'in_progress');
  assert.equal(odd.rawState, 'teleporting');
  assert.equal(odd.terminal, false);
  assert.equal(parseState('toString'), 'in_progress');
  s.queue(`/order/${o.orderId}`, envelope({ order_id: 'someone_else', state: 'delivered', terminal: true }));
  assert.equal((await error(client(s).status(o.orderId))).code, 'unexpected_answer');
  assert.equal((await error(client(s).status('sell_nope'))).code, 'order_not_found');
});

test('delivered: the payout transaction, what came in and went out, buyfiro.app\'s link as sent', async () => {
  const s = new FakeSellFiro();
  const o = await order(client(s));
  s.state = 'delivered';
  s.payoutTxid = TXID;
  s.payoutExplorer = `https://bscscan.com/tx/${TXID}`;
  s.receivedFiro = 499.99996776;
  s.proceedsUsd = 479.51;
  const r = await client(s).status(o.orderId);
  assert.equal(r.terminal, true);
  assert.equal(r.pollAfterMs, null);
  assert.equal(r.payoutTxid, TXID);
  assert.equal(r.payoutExplorer, `https://bscscan.com/tx/${TXID}`);
  assert.equal(r.receivedFiro, 499.99996776);
  assert.equal(r.proceedsUsd, 479.51);
  assert.equal(r.payout.address, PAYOUT);
  s.payoutTxid = '<script>';
  assert.equal((await client(s).status(o.orderId)).payoutTxid, null, 'a txid that is not one is not shown');
});

test("the payout's explorer link: https, a known explorer of its chain, about that transaction; else none", () => {
  const ok = `https://bscscan.com/tx/${TXID}`;
  assert.equal(payoutTxUrl(ok, { chainId: 56, txid: TXID }), ok);
  assert.equal(payoutTxUrl(`https://www.bscscan.com/tx/${TXID}`, { chainId: 56, txid: TXID }), `https://www.bscscan.com/tx/${TXID}`);
  assert.equal(payoutTxUrl(`https://etherscan.io/tx/${TXID}`, { chainId: 1, txid: TXID }), `https://etherscan.io/tx/${TXID}`);
  for (const [link, chainId, txid] of [
    [`http://bscscan.com/tx/${TXID}`, 56, TXID],
    [`https://bscscan.com.evil.example/tx/${TXID}`, 56, TXID],
    [`https://evil.example/bscscan.com/tx/${TXID}`, 56, TXID],
    [`https://etherscan.io/tx/${TXID}`, 56, TXID],
    [`https://bscscan.com:8443/tx/${TXID}`, 56, TXID],
    [`https://user:pw@bscscan.com/tx/${TXID}`, 56, TXID],
    [`https://bscscan.com/tx/0x${'00'.repeat(32)}`, 56, TXID],
    [`https://bscscan.com/tx/${TXID}`, 4663, TXID],
    [`https://bscscan.com/tx/0xsbx_payout_txid`, 56, '0xsbx_payout_txid'],
    ['javascript:alert(1)', 56, TXID],
    [null, 56, TXID],
  ]) assert.equal(payoutTxUrl(link, { chainId, txid }), null, String(link));
});
