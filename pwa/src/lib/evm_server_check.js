// Is this an Ethereum / BNB Chain server the wallet can rely on? The same questions for a listed
// server (the server screen, from the page) and for the person's own server before it is saved
// (from the service worker, whose own policy may reach any https address: the page's may not reach
// an address it does not name yet). The build inlines this file into sw.js, so it imports nothing
// and holds no words for the screen (lib/eth/server_words.js has those).
//
// The questions, in order, each a plain JSON-RPC request with no address in it (the server sees
// the IP address and these questions, never which wallet asks):
//   1. eth_chainId: the chain the person added it for (1 Ethereum, 56 BNB Chain).
//   2. eth_getBlockByNumber('latest'): its newest block and that block's time: fresh when it is
//      at most FRESH_SECONDS old by this device's clock (generous for a clock that is off); how
//      long this answer took is the speed shown.
//   3. a receipt of a recent transaction: the first transaction of a block a few below the newest
//      (eth_getBlockByNumber, then eth_getTransactionReceipt). A server that keeps receipts for
//      paying users only ("Archive requests require a personal token") can never show a payment
//      confirmed: refused.
//   4. eth_call: Multicall3's getBlockNumber() (the same contract address on both chains), which
//      must be near the newest block: it runs contract code against current state, as balances
//      and swap prices do.
// Reaching it at all also proves CORS: requests go as a web page's (mode cors, a JSON content
// type, so the browser asks first), and a server that does not allow pages fails like one that is
// down: the browser does not tell the two apart.

export const EVM_CHECK_TIMEOUT_MS = 10000;
/** The newest block may be this old (seconds) by this device's clock before the server counts as behind. */
export const FRESH_SECONDS = 600;
/** How many blocks below the newest are looked at for a transaction to ask the receipt of. */
export const RECEIPT_LOOKBACK = 6;
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const GET_BLOCK_NUMBER = '0x42cbb15c'; // getBlockNumber()
const PAYING_USERS_ONLY = /archive requests require|personal token|api key|upgrade your plan|paid plan/i;
/** The only requests a check sends (release audit 0.1.5, N1: the worker is no relay for other requests). */
export const CHECK_METHODS = Object.freeze(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_call']);
/** The most one answer of a check may be: a block's transaction hashes, a receipt (N5). */
export const MAX_CHECK_ANSWER_BYTES = 4 * 1024 * 1024;

/** A response's body as text, refused past `max` bytes (announced or read). */
async function readCheckBody(res, max) {
  const announced = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(announced) && announced > max) return null;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return t.length > max ? null : t;
  }
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

class CheckError extends Error {
  constructor(code, message, rpcCode = null) {
    super(message);
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/**
 * call(method, params) -> the result, over fetchImpl, as EthRpc sends requests (no cookies, no
 * cache, no redirects, no referrer, a timeout). Errors carry a code: 'unreachable' (no answer, or
 * not allowed by CORS), 'timeout', 'busy' (429), 'http' (not JSON-RPC), 'rpc' (an error answer,
 * rpcCode and its message).
 */
export function rpcCaller(fetchImpl, url, { timeoutMs = EVM_CHECK_TIMEOUT_MS } = {}) {
  let id = 0;
  return async function call(method, params = []) {
    if (!CHECK_METHODS.includes(method)) throw new CheckError('bad_answer', `not a check request: ${String(method).slice(0, 40)}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          signal: ctl.signal,
        });
      } catch {
        throw new CheckError(ctl.signal.aborted ? 'timeout' : 'unreachable', ctl.signal.aborted ? 'no answer in time' : 'not reachable');
      }
      if (res.status === 429) throw new CheckError('busy', 'too many requests');
      let text;
      try {
        text = await readCheckBody(res, MAX_CHECK_ANSWER_BYTES);
      } catch {
        throw new CheckError(ctl.signal.aborted ? 'timeout' : 'unreachable', 'stopped answering');
      }
      if (text === null) throw new CheckError('http', 'an answer far larger than any check needs');
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new CheckError('http', `not a JSON-RPC answer (HTTP ${res.status})`);
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new CheckError('http', 'not a JSON-RPC answer');
      if (j.error) {
        const e = j.error;
        throw new CheckError('rpc', typeof e.message === 'string' ? e.message.slice(0, 200) : 'error', typeof e.code === 'number' ? e.code : null);
      }
      if (!('result' in j)) throw new CheckError('http', 'an answer without a result');
      return j.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

const hexNumber = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? Number(BigInt(v)) : NaN);
const isHash = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Asks one server the four questions. call: rpcCaller(...) or a stand-in; chainId: what it must
 * be on; now(): this device's clock (ms). Never throws. Returns a plain object (it crosses from the
 * service worker to the page):
 *   {ok, problem, chainId, head, headAge (s), ms, receipts, call, detail}
 * ok: every answer as it must be. problem: the first that was not, in the order asked:
 *   'unreachable' | 'timeout' | 'busy' | 'bad_answer' | 'wrong_chain' | 'stale' | 'receipts_refused'
 *   | 'receipts_missing' | 'no_transactions' | 'receipts_error' | 'call_failed' | null.
 * receipts: 'yes' | 'refused' | 'missing' (a mined transaction without one) | 'none' (no
 * transaction near the newest block to ask about) | 'error' | null (not asked).
 * call: 'yes' | 'wrong' (answered, far from the newest block) | 'error' | null.
 * detail: the server's own words for the problem, for whoever debugs it (never shown as the reason).
 */
export async function checkEvmServer(call, { chainId, now = () => Date.now() } = {}) {
  const r = { ok: false, problem: null, chainId: null, head: null, headAge: null, ms: null, receipts: null, call: null, detail: null };
  const stop = (problem, e = null) => {
    r.problem = problem;
    if (e && e.message) r.detail = String(e.message).slice(0, 200);
    return r;
  };
  const transport = (e) => (e && (e.code === 'unreachable' || e.code === 'timeout' || e.code === 'busy') ? e.code : 'bad_answer');
  try {
    r.chainId = hexNumber(await call('eth_chainId', []));
  } catch (e) {
    return stop(transport(e), e);
  }
  if (!Number.isSafeInteger(r.chainId)) return stop('bad_answer');
  if (r.chainId !== chainId) return stop('wrong_chain');
  let latest;
  const t0 = now();
  try {
    latest = await call('eth_getBlockByNumber', ['latest', false]);
  } catch (e) {
    return stop(transport(e), e);
  }
  r.ms = Math.max(0, Math.round(now() - t0));
  const head = latest && typeof latest === 'object' ? hexNumber(latest.number) : NaN;
  const time = latest && typeof latest === 'object' ? hexNumber(latest.timestamp) : NaN;
  if (!Number.isSafeInteger(head) || !Number.isSafeInteger(time)) return stop('bad_answer');
  r.head = head;
  r.headAge = Math.round(now() / 1000 - time);
  // The receipt of a recent transaction (a few blocks below the newest: not every server has the newest one's yet).
  try {
    let hash = null;
    for (let b = head - 2, i = 0; b >= 0 && i < RECEIPT_LOOKBACK && !hash; b--, i++) {
      const blk = await call('eth_getBlockByNumber', [`0x${b.toString(16)}`, false]);
      const txs = blk && Array.isArray(blk.transactions) ? blk.transactions : [];
      const first = txs.length ? txs[0] : null;
      hash = isHash(first) ? first.toLowerCase() : first && isHash(first.hash) ? first.hash.toLowerCase() : null;
    }
    if (!hash) r.receipts = 'none';
    else {
      try {
        const rc = await call('eth_getTransactionReceipt', [hash]);
        if (rc === null) r.receipts = 'missing';
        else r.receipts = rc && typeof rc === 'object' && String(rc.transactionHash).toLowerCase() === hash && /^0x[01]$/.test(String(rc.status)) ? 'yes' : 'error';
      } catch (e) {
        r.receipts = e && PAYING_USERS_ONLY.test(e.message) ? 'refused' : 'error';
        if (!r.detail && e && e.message) r.detail = String(e.message).slice(0, 200);
      }
    }
  } catch (e) {
    r.receipts = 'error';
    if (!r.detail && e && e.message) r.detail = String(e.message).slice(0, 200);
  }
  try {
    const out = await call('eth_call', [{ to: MULTICALL3, data: GET_BLOCK_NUMBER }, 'latest']);
    const n = typeof out === 'string' && /^0x[0-9a-fA-F]{64}$/.test(out) ? Number(BigInt(out)) : NaN;
    r.call = Number.isSafeInteger(n) && Math.abs(n - head) <= 1000 ? 'yes' : 'wrong';
  } catch (e) {
    r.call = 'error';
    if (!r.detail && e && e.message) r.detail = String(e.message).slice(0, 200);
  }
  if (r.headAge > FRESH_SECONDS) return stop('stale');
  if (r.receipts === 'refused') return stop('receipts_refused');
  if (r.receipts === 'missing') return stop('receipts_missing');
  if (r.receipts === 'none') return stop('no_transactions');
  if (r.receipts !== 'yes') return stop('receipts_error');
  if (r.call !== 'yes') return stop('call_failed');
  r.ok = true;
  r.detail = null;
  return r;
}
