// Checking an Ethereum / BNB Chain server (lib/evm_server_check.js), and what the server screen says
// about it (lib/eth/server_words.js), against fake servers: the right chain, a fresh block, a
// recent payment's receipt, one contract call; reached the way a page reaches it. The same check
// runs in the service worker before a person's own server is saved (test/unit/evm_own_server_sw).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEvmServer, rpcCaller, FRESH_SECONDS, RECEIPT_LOOKBACK } from '../../src/lib/evm_server_check.js';
import { checkLine, bestHead, lagOf, ownServerProblem, checkListedServers, speedText, ageText, BEHIND_BLOCKS } from '../../src/lib/eth/server_words.js';
import { BSC_RPC_HOSTS, ETH_RPC_HOSTS, rpcUrl } from '../../src/lib/eth/hosts.js';

const NOW = 1_800_000_000_000; // ms
const hex = (n) => `0x${n.toString(16)}`;
const TX = (b) => `0x${b.toString(16).padStart(64, 'a')}`;

/**
 * A fake JSON-RPC server, as fetch(url, init). Options: chainId; head; age (s) of the newest block;
 * empty (block numbers with no transactions); receipt: 'ok' | 'refused' | 'null' | 'error' | 'other';
 * call: 'ok' | 'error' | 'far'; down (fetch throws); status (HTTP status); notJson; slowMs.
 */
function fakeEvm({ chainId = 1, head = 1000, age = 12, empty = new Set(), receipt = 'ok', call = 'ok', down = false, status = 200, notJson = false, slowMs = 0 } = {}) {
  const seen = [];
  const answer = (m) => {
    switch (m.method) {
      case 'eth_chainId':
        return { result: hex(chainId) };
      case 'eth_getBlockByNumber': {
        const n = m.params[0] === 'latest' ? head : Number(BigInt(m.params[0]));
        return { result: { number: hex(n), timestamp: hex(Math.floor(NOW / 1000) - age - (head - n) * 12), transactions: empty.has(n) ? [] : [TX(n), TX(n + 1)] } };
      }
      case 'eth_getTransactionReceipt':
        if (receipt === 'refused') return { error: { code: -32602, message: 'Archive requests require a personal token. Get one at: allnodes' } };
        if (receipt === 'error') return { error: { code: -32000, message: 'header not found' } };
        if (receipt === 'null') return { result: null };
        if (receipt === 'other') return { result: { transactionHash: TX(1), status: '0x1' } };
        return { result: { transactionHash: m.params[0], status: '0x1', blockNumber: hex(head - 2) } };
      case 'eth_call':
        if (call === 'error') return { error: { code: -32000, message: 'execution reverted' } };
        return { result: `0x${(call === 'far' ? head - 50000 : head).toString(16).padStart(64, '0')}` };
      default:
        return { error: { code: -32601, message: 'method not found' } };
    }
  };
  const fetch = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    if (slowMs) await new Promise((r, j) => {
      const t = setTimeout(r, slowMs);
      init.signal.addEventListener('abort', () => {
        clearTimeout(t);
        j(new DOMException('aborted', 'AbortError'));
      });
    });
    if (down) throw new TypeError('Failed to fetch');
    if (status !== 200) return new Response('slow down', { status });
    if (notJson) return new Response('<html>parked</html>', { status: 200 });
    const m = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...answer(m) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

const check = (server, chainId = 1, opts = {}) => checkEvmServer(rpcCaller(server.fetch, 'https://rpc.example.com/', opts), { chainId, now: () => NOW });

test('a server that answers everything: ok, its newest block, how old, how fast; four kinds of question and no address in any', async () => {
  const s = fakeEvm({ head: 26191781 });
  const r = await check(s);
  assert.equal(r.ok, true);
  assert.equal(r.problem, null);
  assert.equal(r.chainId, 1);
  assert.equal(r.head, 26191781);
  assert.equal(r.headAge, 12);
  assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
  assert.equal(r.receipts, 'yes');
  assert.equal(r.call, 'yes');
  assert.deepEqual([...new Set(s.seen.map((x) => x.body.method))], ['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_call']);
  // Asked as a page asks: no cookies, no cache, no redirects, no referrer, CORS, JSON.
  for (const { init } of s.seen) {
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.mode, 'cors');
    assert.equal(init.headers['content-type'], 'application/json');
  }
  // Nothing about a wallet: no address-shaped value (20 bytes) in any question.
  assert.ok(!s.seen.some((x) => /0x[0-9a-f]{40}(?![0-9a-f])/i.test(JSON.stringify(x.body.params).replace(/0xca11bde05977b3631167028862be2a173976ca11/i, ''))), 'only Multicall3, never an account');
  // The receipt asked about is a transaction a few blocks below the newest.
  const rc = s.seen.find((x) => x.body.method === 'eth_getTransactionReceipt');
  assert.equal(rc.body.params[0], TX(26191779));
});

test('each problem, in the order asked: unreachable, timeout, busy, not JSON-RPC, wrong chain', async () => {
  assert.equal((await check(fakeEvm({ down: true }))).problem, 'unreachable');
  assert.equal((await check(fakeEvm({ slowMs: 200 }), 1, { timeoutMs: 20 })).problem, 'timeout');
  assert.equal((await check(fakeEvm({ status: 429 }))).problem, 'busy');
  assert.equal((await check(fakeEvm({ notJson: true }))).problem, 'bad_answer');
  const wrong = await check(fakeEvm({ chainId: 56 }), 1);
  assert.equal(wrong.problem, 'wrong_chain');
  assert.equal(wrong.chainId, 56);
  assert.equal(wrong.ok, false);
  assert.equal((await check(fakeEvm({ chainId: 56 }), 56)).ok, true, 'BNB Chain is 56');
});

test('behind (its newest block too old), receipts for paying users only, no receipt, no recent payment, no contract call', async () => {
  const stale = await check(fakeEvm({ age: FRESH_SECONDS + 1 }));
  assert.equal(stale.problem, 'stale');
  assert.equal(stale.headAge, FRESH_SECONDS + 1);
  assert.equal((await check(fakeEvm({ age: FRESH_SECONDS }))).ok, true, 'on the line: fresh');
  const refused = await check(fakeEvm({ receipt: 'refused' }), 1);
  assert.equal(refused.problem, 'receipts_refused');
  assert.equal(refused.receipts, 'refused');
  assert.match(refused.detail, /personal token/, "the server's own words kept for whoever debugs it");
  assert.equal((await check(fakeEvm({ receipt: 'null' }))).problem, 'receipts_missing');
  assert.equal((await check(fakeEvm({ receipt: 'error' }))).problem, 'receipts_error');
  assert.equal((await check(fakeEvm({ receipt: 'other' }))).problem, 'receipts_error', 'a receipt for another transaction is no answer');
  const head = 500;
  const empty = new Set(Array.from({ length: RECEIPT_LOOKBACK + 2 }, (_, i) => head - i));
  assert.equal((await check(fakeEvm({ head, empty }))).problem, 'no_transactions');
  // Empty blocks right below the newest are passed over for the next one with a payment.
  const some = await check(fakeEvm({ head, empty: new Set([head - 2, head - 3]) }));
  assert.equal(some.ok, true);
  assert.equal((await check(fakeEvm({ call: 'error' }))).problem, 'call_failed');
  const far = await check(fakeEvm({ call: 'far' }));
  assert.equal(far.problem, 'call_failed');
  assert.equal(far.call, 'wrong', 'answered from state far from the newest block');
});

test('one line per server: block, speed, confirms payments; behind the best one seen; each problem in words, no jargon', () => {
  const ok = (head, ms = 120) => ({ ok: true, problem: null, chainId: 1, head, headAge: 10, ms, receipts: 'yes', call: 'yes' });
  const best = bestHead([ok(100), ok(108), { ok: false, problem: 'wrong_chain', chainId: 5, head: 999 }, { state: 'checking' }, null]);
  assert.equal(best, 108, 'a server on another chain does not set the pace');
  assert.equal(lagOf(ok(100), best), 8);
  assert.deepEqual(checkLine(ok(108), { chain: 'ethereum', best }), { cls: 'ok', text: 'Block 108 · 120 ms · confirms payments', usable: true });
  assert.deepEqual(checkLine(ok(100), { chain: 'ethereum', best }), { cls: 'bad', text: 'Behind by 8 blocks · 120 ms', usable: false });
  assert.equal(checkLine(ok(100), { chain: 'bsc', best }).cls, 'ok', 'BNB Chain blocks come 16 times as often: 8 is not behind there');
  assert.equal(BEHIND_BLOCKS.ethereum, 5);
  assert.equal(BEHIND_BLOCKS.bsc, 40);
  assert.deepEqual(checkLine(null, { chain: 'ethereum' }), { cls: 'wait', text: 'Not checked yet', usable: true });
  assert.deepEqual(checkLine({ state: 'checking' }, { chain: 'ethereum' }), { cls: 'wait', text: 'Checking…', usable: true });
  const words = Object.fromEntries(
    ['unreachable', 'timeout', 'busy', 'bad_answer', 'wrong_chain', 'receipts_refused', 'receipts_missing', 'no_transactions', 'call_failed'].map((p) => [p, checkLine({ ok: false, problem: p }, { chain: 'bsc' })]),
  );
  assert.equal(words.unreachable.text, 'Not answering');
  assert.equal(words.wrong_chain.text, 'Not a BNB Chain server');
  assert.equal(words.receipts_refused.text, "Doesn't say whether payments went through");
  assert.equal(words.call_failed.text, "Can't read token balances or prices");
  for (const [p, w] of Object.entries(words)) {
    assert.equal(w.cls, 'bad', p);
    assert.equal(w.usable, false, `${p}: no "Use this one"`);
    assert.ok(!/rpc|eth_|cors|json|receipt\b/i.test(w.text), `${p}: no jargon (${w.text})`);
  }
  assert.equal(checkLine({ ok: false, problem: 'stale', headAge: 3 * 3600 }, { chain: 'ethereum' }).text, 'Behind: its newest block is 3 h old');
  assert.equal(speedText(85), '85 ms');
  assert.equal(speedText(1450), '1.4 s');
  assert.equal(ageText(30), '30 s');
  assert.equal(ageText(600), '10 min');
  assert.equal(ageText(86400 * 3), '3 days');
});

test("why an own server was not used: one plain sentence per problem, never the person's fault", () => {
  assert.equal(ownServerProblem({ ok: true }, 'ethereum'), null);
  for (const problem of ['unreachable', 'timeout', 'busy', 'bad_answer', 'wrong_chain', 'stale', 'receipts_refused', 'receipts_missing', 'receipts_error', 'no_transactions', 'call_failed', 'something_new']) {
    const t = ownServerProblem({ ok: false, problem, chainId: 5, headAge: 7200 }, 'bsc');
    assert.ok(typeof t === 'string' && t.length > 30, problem);
    assert.ok(!/you (typed|entered|made)|your fault|invalid input/i.test(t), `${problem}: never blames`);
  }
  assert.match(ownServerProblem({ ok: false, problem: 'wrong_chain', chainId: 1 }, 'bsc'), /not a BNB Chain server: it answered for chain 1, and BNB Chain is chain 56/);
  assert.match(ownServerProblem({ ok: false, problem: 'unreachable' }, 'ethereum'), /CORS/, 'the one setting a node runner needs named');
  assert.match(ownServerProblem({ ok: false, problem: 'receipts_refused' }, 'ethereum'), /never show your payments confirmed/);
  assert.match(ownServerProblem(null, 'ethereum'), /could not check it/);
});

test("the server screen's check: every listed server of the chain at once, each answer as it comes, at the listed URL (1RPC at its path)", async () => {
  const servers = new Map(BSC_RPC_HOSTS.map((h, i) => [rpcUrl(h), fakeEvm({ chainId: 56, head: 127622568 + i, receipt: h.id === 'bsc-blast' ? 'refused' : 'ok', down: h.id === 'bsc-ninicoin' })]));
  const order = [];
  const results = new Map();
  await checkListedServers('bsc', {
    fetch: (url, init) => servers.get(url).fetch(url, init),
    onResult: (h, r) => {
      order.push(h.id);
      results.set(h.id, r);
    },
  });
  assert.equal(results.size, BSC_RPC_HOSTS.length);
  assert.deepEqual(new Set(order), new Set(BSC_RPC_HOSTS.map((h) => h.id)));
  assert.equal(results.get('bsc-blast').problem, 'receipts_refused');
  assert.equal(results.get('bsc-ninicoin').problem, 'unreachable');
  assert.equal(results.get('bsc-bnbchain').ok, true);
  assert.ok(servers.get('https://1rpc.io/bnb').seen.length > 0, '1RPC is asked at /bnb');
  const best = bestHead([...results.values()]);
  assert.equal(best, 127622568 + BSC_RPC_HOSTS.length - 1);
  assert.equal(checkLine(results.get('bsc-bnbchain'), { chain: 'bsc', best }).cls, 'ok', 'a few blocks apart is not behind');
  // Ethereum's list: a server on another chain is said so.
  const eth = new Map(ETH_RPC_HOSTS.map((h) => [rpcUrl(h), fakeEvm({ chainId: h.id === 'drpc' ? 56 : 1 })]));
  const er = new Map();
  await checkListedServers('ethereum', { fetch: (url, init) => eth.get(url).fetch(url, init), onResult: (h, r) => er.set(h.id, r) });
  assert.equal(er.get('drpc').problem, 'wrong_chain');
  assert.equal(er.get('stackwallet').ok, true);
});

test('N1/N5: the check sends only its own requests, and refuses an answer far larger than any check needs', async () => {
  const { CHECK_METHODS, MAX_CHECK_ANSWER_BYTES } = await import('../../src/lib/evm_server_check.js');
  assert.deepEqual([...CHECK_METHODS], ['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_call']);
  const s = fakeEvm();
  const call = rpcCaller(s.fetch, 'https://rpc.example.com/');
  for (const m of ['eth_sendRawTransaction', 'eth_getBalance', 'personal_sign', 'eth_getLogs']) await assert.rejects(call(m, []), (e) => e.code === 'bad_answer', m);
  assert.equal(s.seen.length, 0, 'none of them was sent');
  // A huge answer (streamed, no length announced) is cut off, not read whole.
  const big = async () => new Response(new ReadableStream({ start(c) { const chunk = new Uint8Array(1024 * 1024).fill(32); for (let i = 0; i < 6; i++) c.enqueue(chunk); c.close(); } }), { status: 200 });
  await assert.rejects(rpcCaller(big, 'https://rpc.example.com/')('eth_chainId', []), (e) => e.code === 'http' && /far larger/.test(e.message));
  assert.ok(MAX_CHECK_ANSWER_BYTES <= 4 * 1024 * 1024);
  // An announced one is refused before reading.
  const announced = async () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_CHECK_ANSWER_BYTES + 1) } });
  await assert.rejects(rpcCaller(announced, 'https://rpc.example.com/')('eth_chainId', []), (e) => e.code === 'http');
});
