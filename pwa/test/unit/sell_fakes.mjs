// A buyfiro.app stand-in for the Sell FIRO unit tests (and the e2e's route): a
// fetch that answers the sell API v1's calls in its documented shape (and the
// shape its sandbox answers with, measured 2026-10-12), records every request,
// and can fail in each of the ways the real one can; plus the stand-in
// engine's address classifier. Every address here is made up, except
// Hardhat's well-known first test address (holds nothing that matters).

import { answer, envelope } from './buy_fakes.mjs';

export { answer, envelope };
export { FakeClock, drain } from './buy_fakes.mjs';

/** A payout address: Hardhat's first test account, checksummed. */
export const PAYOUT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const PAYOUT_2 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
export const USDC_BSC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
export const NATIVE = '0x0000000000000000000000000000000000000000';
const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
/** Firo deposit addresses in the stand-in engine's shapes (lib/backend_fake.js): Spark "sm1…", transparent "a…". */
export const SPARK_DEPOSIT = `sm1${BECH.repeat(4).slice(0, 110)}`;
export const SPARK_DEPOSIT_2 = `sm1${BECH.split('').reverse().join('').repeat(4).slice(0, 110)}`;
export const T_DEPOSIT = `aSe11DepositAddressForTests${'1'.repeat(7)}`;
export const T_DEPOSIT_2 = `aSe11DepositAddressForTests${'2'.repeat(7)}`;
export const TXID = `0x${'c8'.repeat(32)}`;

/** The stand-in engine's classifier, for tests that run without it. */
export function classify(text) {
  const t = String(text ?? '').trim();
  if (/^sm1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{60,}$/.test(t)) return { kind: 'spark', address: t };
  if (/^EX[1-9A-HJ-NP-Za-km-z]{30,40}$/.test(t)) return { kind: 'exchange', address: t };
  if (/^[aZ][1-9A-HJ-NP-Za-km-z]{33}$/.test(t)) return { kind: 'transparent', address: t };
  return { kind: 'invalid' };
}

export function sellErrorJson(code, { minimumFiro, maximumFiro, retryAfter, unknownFields } = {}) {
  const error = { code, message: 'words that change' };
  if (minimumFiro !== undefined) error.minimum_firo = minimumFiro;
  if (maximumFiro !== undefined) error.maximum_firo = maximumFiro;
  if (retryAfter !== undefined) error.retry_after = retryAfter;
  if (unknownFields !== undefined) error.unknown_fields = unknownFields;
  return { ok: false, api_version: '1.0.0', server_time: 1791814644, error };
}

/** Every code the sell API documents. */
export const SELL_CODES = ['bad_body', 'bad_amount', 'amount_below_minimum', 'amount_above_maximum', 'payout_address_invalid', 'payout_token_invalid', 'payout_chain_unsupported', 'bad_deposit_kind', 'bad_order_type', 'bad_limit_price', 'bad_limit_duration', 'spark_unavailable', 'rate_limited', 'price_unavailable', 'unavailable', 'order_not_found'];
const HTTP = { rate_limited: 429, price_unavailable: 503, unavailable: 503, order_not_found: 404 };
export const httpOf = (code) => HTTP[code] || 400;

export const CHAINS = [
  { chain_id: 1, name: 'Ethereum' },
  { chain_id: 10, name: 'Optimism' },
  { chain_id: 56, name: 'BSC' },
  { chain_id: 8453, name: 'Base' },
  { chain_id: 4663, name: 'Robinhood' },
];
export const TOKENS = {
  56: [
    { token: NATIVE, symbol: 'BNB', name: 'BNB', decimals: 18 },
    { token: USDT_BSC.toLowerCase(), symbol: 'USDT', name: 'Tether USD', decimals: 18 },
    { token: USDC_BSC, symbol: 'USDC', name: 'USD Coin', decimals: 18 },
    { token: '0x524bc91dc82d6b90ef29f76a3ecaabafffd490bc', symbol: 'USDT', name: 'Wormhole Bridged USDT (Sui)', decimals: 6 },
  ],
  1: [
    { token: NATIVE, symbol: 'ETH', name: 'Ether', decimals: 18 },
    { token: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  ],
  8453: [{ token: '0x833589fcd6edb3aa4a1e45c0f6e5e5ec3c2c2f3d', symbol: 'USDC', name: 'USD Coin', decimals: 6 }],
};
const ACCEPTED = ['amount_firo', 'deposit_kind', 'limit_duration_h', 'limit_price', 'order_type', 'payout_address', 'payout_chain_id', 'payout_token', 'sandbox'];
const FINAL = ['delivered', 'expired', 'refused'];

export class FakeSellFiro {
  constructor() {
    this.requests = [];
    this.queued = new Map();
    this.offline = false;
    this.state = 'awaiting_deposit'; // what /order/{id} says (unless forced or set per order)
    this.states = new Map(); // order id -> state
    this.payoutTxid = null;
    this.payoutExplorer = null;
    this.receivedFiro = null;
    this.proceedsUsd = null;
    this.sparkOff = false;
    this.minimumFiro = 300;
    this.maximumFiro = 9691.8;
    this.priceUsd = 0.96; // what one FIRO brings, in dollars
    // As live: an amount outside the limits is refused. buyfiro.app's sandbox only names them (false).
    this.refuseOutOfLimits = true;
    // The real sandbox's order is never payable ('sbx_not_payable'); the e2e pays the stand-in engine
    // to these addresses instead (true), with sandbox=true still in every request.
    this.payableSandbox = false;
    this.sparkDeposit = SPARK_DEPOSIT;
    this.transparentDeposit = T_DEPOSIT;
    this.orders = new Map(); // id -> {body, sandbox}
    this.nextId = 1;
    this.holdQuotes = null; // a promise the next /quote waits for
    // Test mode only: any request without sandbox=true in its URL (and, for a POST, sandbox: true in
    // its body) is refused (HTTP 500) and recorded here. The e2e turns it on and asserts none happened.
    this.sandboxOnly = false;
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

  posts() {
    return this.requests.filter((r) => r.method === 'POST' && r.path === '/order');
  }

  async _handle(url, init) {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace('/api/v1/sell', ''));
    const req = { url: u, path, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null, init };
    this.requests.push(req);
    if (this.offline) throw new TypeError('Failed to fetch');
    req.sandbox = u.searchParams.get('sandbox') === 'true';
    if (this.sandboxOnly && (!req.sandbox || (req.method !== 'GET' && !(req.body && req.body.sandbox === true)))) {
      this.violations.push(`${req.method} ${u.pathname}${u.search}`);
      return new Response(JSON.stringify(sellErrorJson('not_sandbox')), { status: 500, headers: { 'content-type': 'application/json' } });
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

  _refuse(code, extra) {
    return answer(httpOf(code), sellErrorJson(code, extra));
  }

  _token(chainId, token) {
    return (TOKENS[chainId] || []).find((t) => t.token.toLowerCase() === String(token).toLowerCase()) || null;
  }

  _limitsCheck(amount) {
    if (!(Number.isFinite(amount) && amount > 0)) return this._refuse('bad_amount');
    if (this.refuseOutOfLimits && amount < this.minimumFiro) return this._refuse('amount_below_minimum', { minimumFiro: this.minimumFiro });
    if (this.refuseOutOfLimits && amount > this.maximumFiro) return this._refuse('amount_above_maximum', { maximumFiro: this.maximumFiro });
    return null;
  }

  _default(req) {
    const { path, url } = req;
    const sbx = req.sandbox ? { sandbox: true } : {};
    if (path === '/health') return envelope({ healthy: true, spark_deposits: !this.sparkOff, sandbox_available: true });
    if (path === '/payout-chains') return envelope({ chains: CHAINS, recommended: { chain_id: 56, token: USDT_BSC, symbol: 'USDT', why: 'words that change' } });
    if (path === '/payout-tokens') {
      const chain = Number(url.searchParams.get('chain_id'));
      if (!CHAINS.some((c) => c.chain_id === chain)) return this._refuse('payout_chain_unsupported');
      const symbol = url.searchParams.get('symbol');
      const tokens = (TOKENS[chain] || []).filter((t) => !symbol || t.symbol.toLowerCase() === symbol.toLowerCase());
      return envelope({ chain_id: chain, count: tokens.length, tokens, truncated: false });
    }
    if (path === '/limits') return envelope({ payout_route: 'direct', minimum_firo: this.minimumFiro, maximum_firo: this.maximumFiro, note: 'words that change' });
    if (path === '/quote') {
      const amount = Number(url.searchParams.get('amount_firo'));
      const chain = Number(url.searchParams.get('payout_chain_id'));
      if (!CHAINS.some((c) => c.chain_id === chain)) return this._refuse('payout_chain_unsupported');
      if (!this._token(chain, url.searchParams.get('payout_token'))) return this._refuse('payout_token_invalid');
      const refused = this._limitsCheck(amount);
      if (refused) return refused;
      const direct = chain === 56 && url.searchParams.get('payout_token').toLowerCase() === USDT_BSC.toLowerCase();
      return envelope({ ...sbx, amount_firo: amount, receive_usd_estimate: Math.round(amount * this.priceUsd * 100) / 100, payout_route: direct ? 'direct' : 'debridge', minimum_firo: this.minimumFiro, maximum_firo: this.maximumFiro });
    }
    if (path === '/order' && req.method === 'POST') return this._order(req);
    if (path.startsWith('/order/')) {
      // A sandbox id may carry ':<state>' to force that state, as buyfiro.app's sandbox does.
      const asked = path.slice('/order/'.length);
      const [id, forced] = asked.split(':');
      const o = this.orders.get(id);
      if (!o) return this._refuse('order_not_found');
      const state = forced && id.startsWith('sbx_') ? forced : this.states.get(id) || this.state;
      const delivered = state === 'delivered';
      const txid = delivered ? this.payoutTxid ?? (id.startsWith('sbx_') ? '0xsbx_payout_txid' : null) : null;
      const b = o.body;
      return envelope({
        ...(o.sandbox ? { sandbox: true } : {}),
        order_id: asked,
        state,
        state_description: 'words that change',
        terminal: FINAL.includes(state),
        poll_after_seconds: FINAL.includes(state) ? 0 : id.startsWith('sbx_') ? 5 : 15,
        received_firo: this.receivedFiro,
        proceeds_usd: delivered ? this.proceedsUsd : null,
        payout: o.sandbox ? undefined : { chain_id: b.payout_chain_id, chain: 'BSC', token: b.payout_token, symbol: 'USDT', address: b.payout_address },
        payout_txid: txid,
        payout_explorer: delivered ? this.payoutExplorer : null,
      });
    }
    return answer(404, sellErrorJson('not_found'));
  }

  _order(req) {
    const b = req.body;
    if (!b || typeof b !== 'object') return this._refuse('bad_body');
    const unknown = Object.keys(b).filter((k) => !ACCEPTED.includes(k));
    if (unknown.length) return this._refuse('bad_body', { unknownFields: unknown });
    const chain = b.payout_chain_id;
    if (!CHAINS.some((c) => c.chain_id === chain)) return this._refuse('payout_chain_unsupported');
    if (!this._token(chain, b.payout_token)) return this._refuse('payout_token_invalid');
    if (typeof b.payout_address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.payout_address)) return this._refuse('payout_address_invalid');
    if (!['firo', 'spark'].includes(b.deposit_kind)) return this._refuse('bad_deposit_kind');
    if (!['market', 'limit'].includes(b.order_type)) return this._refuse('bad_order_type');
    const refused = this._limitsCheck(b.amount_firo);
    if (refused) return refused;
    if (b.deposit_kind === 'spark' && this.sparkOff) return this._refuse('spark_unavailable');
    const sandbox = req.sandbox || b.sandbox === true;
    const same = (o) => o.body.payout_chain_id === chain && o.body.payout_token.toLowerCase() === b.payout_token.toLowerCase() && o.body.payout_address.toLowerCase() === b.payout_address.toLowerCase() && (this.states.get(o.id) || 'awaiting_deposit') === 'awaiting_deposit';
    // One open order per payout destination (live only: the sandbox creates nothing).
    const open = sandbox ? null : [...this.orders.values()].find(same);
    const o = open || { id: sandbox ? `sbx_s1791814662_${String(this.nextId++).padStart(10, '0')}` : `sell_1791813677_X5n${this.nextId++}`, body: b, sandbox };
    this.orders.set(o.id, o);
    const payable = !sandbox || this.payableSandbox;
    const spark = o.body.deposit_kind === 'spark';
    return envelope({
      ...(sandbox ? { sandbox: true } : {}),
      order_id: o.id,
      payable: !sandbox,
      ...(payable && sandbox ? { payable: true } : {}),
      deposit_address: payable ? this.transparentDeposit : 'sbx_not_payable',
      spark_deposit_address: spark ? (payable ? this.sparkDeposit : 'sbx_not_payable') : null,
      deposit_kind: o.body.deposit_kind,
      amount_firo: o.body.amount_firo,
      receive_usd_estimate: Math.round(o.body.amount_firo * this.priceUsd * 100) / 100,
      ...(sandbox ? {} : { payout: { chain_id: o.body.payout_chain_id, chain: 'BSC', token: o.body.payout_token, symbol: 'USDT', address: o.body.payout_address } }),
      order_type: o.body.order_type,
      expires_in_h: 24,
      reused: Boolean(open),
    });
  }
}
