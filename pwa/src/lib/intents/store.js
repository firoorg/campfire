// The NEAR Intents swaps this wallet started, kept on this device: each one's
// whole signed quote (1Click asks integrators to keep it, with its signature,
// to settle any dispute) and where the swap was last seen, so the person can
// come back to a deposit address and see where the swap is after closing the
// app. A port of the desktop app's near_intents_store.dart.
//
// Kept per Firo wallet (walletKey(app, 'near-intents'), removed with the
// wallet) and sealed like the Ethereum wallet's other records
// (lib/eth/sealed.js: AES-256-GCM under a key from the Firo wallet's
// secret, bound to the Ethereum wallet the ETH goes to). Nothing in the
// clear links this wallet to a refund address on another chain.
//
// A record this version cannot read is kept as it was and written back
// unchanged; nothing is ever deleted by the app itself.

import { readQuote, tokenFromJson, tokenToJson, isFinalState, STATES } from './oneclick.js';
import { sealData, openData } from '../eth/sealed.js';
import { walletKey, walletStore } from '../wallet_scope.js';

export const INTENTS_RECORD = 'near-intents';

/**
 * One swap → a frozen object. quote: 1Click's whole answer (raw); origin: the
 * coin paid with; state: 1Click's last word (null before it was asked);
 * outcome: what the status said about the result.
 */
export function makeSwap({ quote, origin, createdAt, state = null, updatedAt = null, outcome = null }) {
  const q = readQuote(quote);
  if (!q.depositAddress) throw new TypeError('swap: no deposit address');
  const coin = origin && origin.chainName ? origin : tokenFromJson(origin);
  if (!coin) throw new TypeError('swap: bad coin');
  if (!Number.isFinite(createdAt)) throw new TypeError('swap: bad createdAt');
  if (state !== null && !STATES.includes(state)) throw new TypeError('swap: bad state');
  const o = outcome || {};
  return Object.freeze({
    quote: q,
    origin: coin,
    createdAt,
    lastState: state,
    updatedAt,
    /** Wei that arrived (SUCCESS). */
    amountOut: typeof o.amountOut === 'bigint' ? o.amountOut : null,
    refunded: typeof o.refunded === 'bigint' ? o.refunded : null,
    refundReason: typeof o.refundReason === 'string' ? o.refundReason : null,
    /** The Ethereum transactions that delivered the ETH. */
    destinationTxs: Array.isArray(o.destinationTxs) ? o.destinationTxs.filter((t) => typeof t === 'string') : [],
    depositAddress: q.depositAddress,
    depositMemo: q.depositMemo,
    isOpen: !isFinalState(state),
  });
}

export function swapToJson(s) {
  const j = { quote: s.quote.raw, origin: tokenToJson(s.origin), createdAt: s.createdAt };
  if (s.lastState) j.state = s.lastState;
  if (s.updatedAt != null) j.updatedAt = s.updatedAt;
  const out = {};
  if (s.amountOut != null) out.amountOut = s.amountOut.toString();
  if (s.refunded != null) out.refunded = s.refunded.toString();
  if (s.refundReason) out.refundReason = s.refundReason;
  if (s.destinationTxs.length) out.destinationTxs = s.destinationTxs;
  if (Object.keys(out).length) j.outcome = out;
  return j;
}

export function swapFromJson(j) {
  if (!j || typeof j !== 'object') throw new TypeError('swap: not a record');
  const o = j.outcome && typeof j.outcome === 'object' ? j.outcome : {};
  const big = (v) => (typeof v === 'string' && /^[0-9]{1,80}$/.test(v) ? BigInt(v) : null);
  return makeSwap({
    quote: j.quote,
    origin: j.origin,
    createdAt: j.createdAt,
    state: typeof j.state === 'string' ? j.state : null,
    updatedAt: Number.isFinite(j.updatedAt) ? j.updatedAt : null,
    outcome: { amountOut: big(o.amountOut), refunded: big(o.refunded), refundReason: o.refundReason, destinationTxs: o.destinationTxs },
  });
}

/** The swap as status `st` (OneClickClient.status) says it is now, at `at` ms. */
export function withStatus(s, st, at) {
  return makeSwap({
    quote: s.quote.raw,
    origin: s.origin,
    createdAt: s.createdAt,
    state: st.state,
    updatedAt: at,
    outcome: {
      amountOut: st.amountOut ?? s.amountOut,
      refunded: st.refunded ?? s.refunded,
      refundReason: st.refundReason ?? s.refundReason,
      destinationTxs: st.destinationTxs.length ? st.destinationTxs : s.destinationTxs,
    },
  });
}

/** Nothing the person could see changed (no write needed). */
export function sameSwap(a, b) {
  return a.depositAddress === b.depositAddress && a.lastState === b.lastState && a.amountOut === b.amountOut && a.refunded === b.refunded && a.refundReason === b.refundReason && a.destinationTxs.join() === b.destinationTxs.join();
}

export function newestFirst(list) {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

/** A store that forgets on reload (tests). */
export function memoryIntentsStore() {
  const byAddress = new Map();
  return {
    writes: [],
    async all() {
      return newestFirst(byAddress.values());
    },
    async get(deposit) {
      return byAddress.get(deposit) || null;
    },
    async save(swap) {
      byAddress.set(swap.depositAddress, swap);
      this.writes.push(swap);
    },
  };
}

/**
 * The swaps of the open wallet's Ethereum wallet `ethId`, sealed in `kv`
 * (bound to this Firo wallet: a write that comes after a switch is refused,
 * never written into another wallet's record).
 */
export function sealedIntentsStore(app, { ethId, kv = null, name = null }) {
  if (!app || !app.record) throw new Error('No wallet is open.');
  const walletId = app.record.id;
  const key = name || walletKey(app, INTENTS_RECORD);
  const store = kv || walletStore(app.record);
  let unreadable = [];
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };
  const mine = () => {
    if (!app.record || app.record.id !== walletId || !app.dbPass) throw new Error('This wallet is locked.');
  };

  async function open() {
    mine();
    const body = await openData(app, key, { ethId, kv: store });
    const swaps = new Map();
    const skipped = [];
    for (const j of Array.isArray(body && body.swaps) ? body.swaps : []) {
      try {
        const s = swapFromJson(j);
        swaps.set(s.depositAddress, s);
      } catch {
        skipped.push(j);
      }
    }
    unreadable = [...skipped, ...(Array.isArray(body && body.unreadable) ? body.unreadable : [])];
    return swaps;
  }

  return {
    async all() {
      return newestFirst((await serial(open)).values());
    },
    async get(deposit) {
      return (await serial(open)).get(deposit) || null;
    },
    save(swap) {
      return serial(async () => {
        const swaps = await open();
        swaps.set(swap.depositAddress, swap);
        mine();
        await sealData(app, key, { swaps: newestFirst(swaps.values()).map(swapToJson), unreadable }, { ethId, kv: store });
      });
    },
  };
}
