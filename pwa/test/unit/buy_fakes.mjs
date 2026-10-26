// A buyfiro.app stand-in for the Buy FIRO unit tests (and the e2e's route): a
// fetch that answers the buy API v1's five calls in its documented shape, with
// firo_ where the coin is named, records every request, and can fail in each of the ways the real
// one can; and a clock whose timers run when told. Every address here is made up.

export const FIRO_ADDRESS = `a${'1'.repeat(33)}`;
export const FIRO_ADDRESS_2 = `a${'2'.repeat(33)}`;
export const BTC_REFUND = 'bc1qfake0refund0address0for0tests0only00000';
export const ETH_REFUND = '0x1111111111111111111111111111111111111111';
/** A made-up but well-formed Bitcoin address (bech32 of 20 bytes d0…e3): the order's deposit address must be its coin's chain's. */
export const DEPOSIT = 'bc1q6rga95756htd0kxemtdaehw7mlswrchr6zzx2s';
export const BTC = 'coin:btc';
export const ETH = 'coin:eth';
export const USDT_TRON = 'coin:tron-usdt';

export function assetJson(id, symbol, chain, decimals, { contract = null, price = null } = {}) {
  return { asset_id: id, symbol, blockchain: chain, decimals, contract_address: contract, price_usd: price, price_updated_at: null, coingecko_id: null };
}

/** A few of buyfiro.app's coins, deliberately out of order. */
export const ASSETS = [
  assetJson('coin:eth-aave', 'AAVE', 'eth', 18, { contract: '0x7fc6', price: 140 }),
  assetJson('coin:ltc', 'LTC', 'ltc', 8, { price: 63.31 }),
  assetJson(ETH, 'ETH', 'eth', 18, { price: 2476.84 }),
  assetJson(USDT_TRON, 'USDT', 'tron', 6, { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', price: 0.9992 }),
  assetJson('coin:kaia', 'KAIA', 'kaia', 18, { price: 0.12 }),
  assetJson(BTC, 'BTC', 'btc', 8, { price: 82306 }),
  assetJson('coin:zec', 'ZEC', 'zec', 8, { price: 1201.81 }),
];

export function envelope(body) {
  return { ok: true, error: null, api_version: '1.0.0', server_time: 1791576000, ...body };
}

export function errorJson(code, { minimumUsd, orderValueUsd, retryAfter } = {}) {
  const error = { code, message: 'words that change' };
  if (minimumUsd !== undefined) error.minimum_usd = minimumUsd;
  if (orderValueUsd !== undefined) error.order_value_usd = orderValueUsd;
  if (retryAfter !== undefined) error.retry_after = retryAfter;
  return { ok: false, api_version: '1.0.0', server_time: 1791576000, error };
}

export function statusJson(state, { deposit = DEPOSIT, terminal, pollAfter = 15, txId = null } = {}) {
  return coinFields({
    order_id: deposit,
    deposit_address: deposit,
    state,
    state_description: 'words that change',
    terminal: terminal ?? ['delivered', 'refunded', 'expired', 'failed'].includes(state),
    poll_after_seconds: pollAfter,
    firo_txid: txId,
    firo_estimate: 1924.60197756,
    deadline: null,
    raw: { payin_status: 'anything' },
  });
}

/** {status, body, headers} or a JSON object (200) or an Error to throw. */
export function answer(status, body, headers = {}) {
  return { __answer: true, status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } };
}

/** `body` with its firo_ fields, in the envelope around it. */
export function coinFields(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) out[k] = v;
  return envelope(out);
}

export class FakeBuyFiro {
  constructor() {
    this.requests = [];
    this.queued = new Map();
    this.offline = false;
    this.depositAddress = DEPOSIT;
    this.assets = ASSETS; // what /assets lists (a test may add coins)
    this.state = 'awaiting_deposit';
    this.txId = null;
    this.holdQuotes = null; // a promise the next /quote waits for
    // Test mode only: any POST without sandbox=true in its URL AND sandbox: true in its body is
    // refused (HTTP 500) and recorded here. The e2e turns it on; a test then asserts none happened.
    this.sandboxOnly = false;
    // When an order's address stops taking payments (unix seconds): 22:00 on 9 October 2026 for the
    // unit tests' clock; a browser test runs at today's time and sets one ahead of it.
    this.deadline = 1791579600;
    this.violations = [];
    this.fetch = (url, init = {}) => this._handle(url, init);
  }

  queue(path, a) {
    if (!this.queued.has(path)) this.queued.set(path, []);
    this.queued.get(path).push(a);
  }

  count(path) {
    return this.requests.filter((r) => r.path === path || (path.endsWith('/') && r.path.startsWith(path))).length;
  }

  async _handle(url, init) {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace('/api/v1/buy', ''));
    const req = { url: u, path, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null, init };
    this.requests.push(req);
    if (this.offline) throw new TypeError('Failed to fetch');
    req.sandbox = u.searchParams.get('sandbox') === 'true';
    if (req.method !== 'GET' && this.sandboxOnly && !(req.sandbox && req.body && req.body.sandbox === true)) {
      this.violations.push(`${req.method} ${u.pathname}${u.search}`);
      return new Response(JSON.stringify(errorJson('not_sandbox')), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    const q = this.queued.get(path);
    let a;
    if (q && q.length) a = q.shift();
    else {
      if (path === '/quote' && this.holdQuotes) await this.holdQuotes;
      a = this._default(req);
    }
    if (a instanceof Error) throw a;
    if (a && a.__never) return new Promise(() => {});
    const r = a && a.__answer ? a : answer(200, a);
    return new Response(r.body, { status: r.status, headers: r.headers });
  }

  _default(req) {
    const { path, url } = req;
    if (path === '/assets') return envelope({ count: this.assets.length, blockchains: ['btc', 'eth', 'ltc', 'tron', 'zec', 'kaia'], cache_age_s: 0, assets: this.assets });
    if (path === '/limits') return envelope({ our_minimum_usd: 5.0, maximum_usd: null, upstream_observed_minimum_usd: 1000.0, upstream_observed_at: 1791576000 });
    if (path === '/quote') {
      const id = url.searchParams.get('asset_id');
      const amount = Number(url.searchParams.get('amount'));
      const asset = this.assets.find((x) => x.asset_id === id);
      const usd = amount * (asset.price_usd ?? 1);
      if (usd < 1000) return answer(400, errorJson('amount_below_upstream_minimum', { minimumUsd: 1000 }));
      const raw = BigInt(Math.round(amount * Number(`1e${asset.decimals}`)));
      return coinFields({
        asset_id: id,
        symbol: asset.symbol,
        blockchain: asset.blockchain,
        decimals: asset.decimals,
        send_amount: amount,
        send_amount_raw: raw.toString(),
        order_value_usd: usd,
        firo_estimate: usd * 0.95,
        firo_estimate_raw: BigInt(Math.round(usd * 0.95 * 1e8)).toString(),
        eta_seconds: 810,
        deadline: null,
      });
    }
    if (path === '/order') {
      const b = req.body;
      const asset = this.assets.find((x) => x.asset_id === b.asset_id);
      // As buyfiro.app's sandbox answers: no raw figure, never payable.
      const sbx = req.sandbox ? { payable: false, sandbox: true } : { send_amount_raw: BigInt(Math.round(b.amount * Number(`1e${asset.decimals}`))).toString() };
      return coinFields({
        order_id: this.depositAddress,
        deposit_address: this.depositAddress,
        asset_id: b.asset_id,
        symbol: asset.symbol,
        blockchain: asset.blockchain,
        send_amount: b.amount,
        firo_wallet: b.firo_wallet,
        firo_estimate: 1924.60197756,
        order_value_usd: 1012.36,
        deadline: this.deadline,
        eta_seconds: 810,
        payable: true,
        created: true,
        ...sbx,
      });
    }
    if (path.startsWith('/order/')) {
      // A sandbox id may carry ':<state>' to force that state, as buyfiro.app's sandbox does.
      const [id, forced] = path.slice('/order/'.length).split(':');
      if (id !== this.depositAddress) return answer(404, errorJson('order_not_found'));
      const state = forced && id.startsWith('sbx_') ? forced : this.state;
      const txId = this.txId ?? (state === 'delivered' && id.startsWith('sbx_') ? 'sbx_delivery_txid' : null);
      return statusJson(state, { deposit: this.depositAddress, txId, pollAfter: id.startsWith('sbx_') ? 5 : 15 });
    }
    return answer(404, errorJson('not_found'));
  }
}

/** A clock that stands still until advance()d; timers fire in order. */
export class FakeClock {
  constructor(start = Date.UTC(2026, 9, 9, 12)) {
    this.t = start;
    this.timers = [];
  }

  now() {
    return this.t;
  }

  schedule(ms, fn) {
    const timer = { at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((x) => x !== timer);
    };
  }

  get pending() {
    return this.timers.length;
  }

  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await drain();
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at);
      if (!due.length) break;
      const x = due[0];
      this.timers = this.timers.filter((y) => y !== x);
      if (x.at > this.t) this.t = x.at;
      x.fn();
    }
    this.t = end;
    await drain();
  }
}

export async function drain() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}
