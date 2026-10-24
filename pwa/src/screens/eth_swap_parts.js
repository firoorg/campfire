/* The Uniswap sheets (over screens/eth_swap.js), ports of the desktop app's
 * lib/pages/eth/uniswap/uniswap_approve_view.dart, uniswap_review_view.dart and
 * uniswap_pools_view.dart.
 *
 * Allow-token sheet
 * Spec: ONE job: let Uniswap's Permit2 move this token, for exactly the amount being swapped,
 *       before the first swap of it.
 *       Primary CTA: "Allow 128.34 USDC" (then Face ID / password); the review follows by itself.
 *       Taps from app open: Ethereum (1) -> Swap (2) -> Swap … (3) -> Allow … (4), once per
 *       token and amount.
 * Exit-intent: "Why another transaction?" answered in one line; "Is this unlimited?" no, the exact
 *   amount is named on the button; USDT's two steps are said before they happen; the fee is shown.
 *   "The server refused it - did it leave?" -> "Not sent yet": most likely not, but it may have been
 *   passed on, so it is not offered to sign again here while it is checked (lib/eth/send.js).
 *
 * Review sheet
 * Spec: ONE job: show exactly what the swap does before anything is signed.
 *       Primary CTA: "Swap 0.01 ETH" (then Face ID / password).
 *       Taps from app open: Ethereum (1) -> Swap (2) -> Swap … (3) -> this button (4).
 * Exit-intent: "Is this a scam?" the contract is Uniswap's Universal Router, named with its address;
 *   "What if the price moves?" the least that arrives is on screen, "Ethereum enforces this";
 *   "What does it cost?" the network fee "about" and "at most". The buttons stay in sight.
 *   "Is my server's price honest?" a second listed server priced the same route: agreed (one line),
 *   more than 2% apart (said with both figures, and a tick before the swap), or not reachable (said).
 *
 * Pools list (beside the form from 900 px, a sheet on a phone) and price protection (a sheet):
 *   read-only and a four-way choice; one tap from the form.
 */
import { h, shorten, oneAtATime } from '../lib/dom.js';
import { openSheet, notice } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { percentText } from '../lib/compact.js';
import { NATIVE_ETH, ADDRESSES } from '../lib/eth/uniswap/constants.js';
import { UniV4Pool } from '../lib/eth/uniswap/models.js';
import { poolDepth } from '../lib/eth/uniswap/quoter.js';
import { SLIPPAGE_CHOICES, PERMIT_LIFE_SECONDS, UniGasChanged, UniRouteChanged } from '../lib/eth/uniswap/service.js';
import { EthRpcError, isRevert } from '../lib/eth/rpc.js';
import { toChecksumAddress } from '../lib/eth/crypto.js';
import { signAndBroadcast, permitSigner, walletAsset, uniswapFor } from '../lib/eth/uniswap_app.js';
import { approvalOnItsWay, approvalPass, followOnce } from '../lib/eth/send.js';
import { shortNow } from '../lib/eth/short_now.js';
import { tokenAllowance } from '../lib/eth/uniswap/permit2.js';
import { openApprovals, updateOutbox } from '../lib/eth/outbox.js';
import { secondOpinionWords, priceAckNeeded } from '../lib/eth/second_opinion.js';
import { ethBadge, receiptsRefusedNotice } from './eth_ui.js';

// ------------------------------------------------------------------ words

export { amt, amtShown, short, ethAbout, ethAtMost, bipsText, feeText, rateText, routeText, routeNote, poolCount } from '../lib/eth/uniswap_words.js';
import { amt, amtShown, ethAbout, ethAtMost, bipsText, feeText, rateText, routeText, routeNote, poolCount } from '../lib/eth/uniswap_words.js';
import { walletPermissionFloor } from '../lib/eth/permission.js';
import { t, tk, tn } from '../lib/i18n.js';

export function kv(label, value, extra = {}, note = null) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value, note ? h('div', { class: 'small', text: note }) : null));
}

/** A token's badge: ETH's diamond, others as letters. */
export function tokenBadge(token, size = '') {
  return ethBadge(walletAsset(token) || { symbol: token.symbol }, size);
}

// ------------------------------------------------------------------ pools

/** Every Uniswap pool between a and b, live first, deepest first → [{pool, state}]. */
export async function loadPools(svc, a, b) {
  const d = svc.discovery;
  const byId = new Map();
  for (const x of a.poolCurrencies) for (const y of b.poolCurrencies) if (x !== y) for (const p of await d.poolsBetween(x, y)) byId.set(p.id, p);
  const states = await d.liveState([...byId.values()]);
  const live = (r) => Boolean(r.state && r.state.isLive);
  const cmp = (x, y) => (x > y ? -1 : x < y ? 1 : 0);
  return [...byId.values()].map((pool) => ({ pool, state: states.get(pool.id) || null })).sort((x, y) => (live(x) === live(y) ? (live(x) ? cmp(poolDepth(x.state), poolDepth(y.state)) : 0) : live(x) ? -1 : 1));
}

function priceOf(r, a, b) {
  const p = r.state && r.state.price0to1;
  if (p == null) return '';
  const aSide = a.poolCurrencies.includes(r.pool.currency0) ? 0 : 1;
  const dec0 = aSide === 0 ? a.decimals : b.decimals;
  const dec1 = aSide === 0 ? b.decimals : a.decimals;
  let whole = p * 10 ** (dec0 - dec1);
  if (aSide === 1) whole = whole === 0 ? 0 : 1 / whole;
  if (!Number.isFinite(whole)) return '';
  const n = whole >= 1000 ? Math.round(whole).toLocaleString('en-US') : whole >= 1 ? whole.toFixed(4) : whole.toPrecision(4);
  return `1 ${a.symbol} = ${n} ${b.symbol}`;
}

/**
 * The pools list. state: {rows, error, a, b, quote}. Read-only: the swap is
 * shared between the pools that, together, give the most; the ones it uses say
 * how much of it each takes.
 */
export function poolsList({ rows, error, a, b, quote, retry }) {
  const intro = h('p', { class: 'small', text: t('Every Uniswap pool between {symbol} and {symbol2}, from Uniswap\'s own records (v2, v3 and v4).', { symbol: a.symbol, symbol2: b.symbol }) });
  if (error) return [intro, notice('error', h('strong', { text: t("Couldn't read the pools. ") }), t('Your Ethereum server did not answer. Nothing was sent.'), retry ? h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', onclick: retry }, t('Try again'))) : null)];
  if (!rows) return [intro, h('p', { class: 'small', 'data-testid': 'uni-pools-loading', text: t('Looking at every Uniswap pool between {symbol} and {symbol2}…', { symbol: a.symbol, symbol2: b.symbol }) }), h('div', { class: 'progress indeterminate' }, h('div'))];
  if (!rows.length) return [intro, notice('info', t('No pool between {symbol} and {symbol2}. The swap can still go through another token (ETH, USDC, USDT, DAI or WBTC) when both sides trade with it.', { symbol: a.symbol, symbol2: b.symbol }))];
  const samePair = quote && quote.tokenIn.sameAsset(a) && quote.tokenOut.sameAsset(b);
  const live = rows.filter((r) => r.state && r.state.isLive);
  const deepest = live.length ? poolDepth(live[0].state) : 0n;
  const shareOf = (pool) => {
    if (!samePair) return null;
    const part = quote.parts.find((p) => p.route.isDirect && p.route.hops[0].pool.id === pool.id);
    return part ? `${Math.max(1, Math.round(quote.shareOf(part) * 100))}%` : null;
  };
  const via = samePair ? quote.parts.filter((p) => !p.route.isDirect) : [];
  const viaShare = via.reduce((s, p) => s + quote.shareOf(p), 0);
  return [
    intro,
    h('p', { class: 'small', 'data-testid': 'uni-pools-summary', text: tn({ one: '{live} of {n} pool can trade now. Your swap is shared between the pools that, together, give you the most, so no one pool moves far.', other: '{live} of {n} pools can trade now. Your swap is shared between the pools that, together, give you the most, so no one pool moves far.' }, rows.length, { live: live.length }) }),
    via.length ? h('p', { class: 'small', 'data-testid': 'uni-pools-via', text: t('Another {value}% of your swap goes through a second token, on pools not listed here.', { value: Math.max(1, Math.round(viaShare * 100)) }) }) : null,
    h(
      'div',
      { class: 'pool-list' },
      ...rows.slice(0, 40).map((r) => {
        const isLive = Boolean(r.state && r.state.isLive);
        const used = shareOf(r.pool);
        const bar = h('div', { class: 'depth' }, h('div'));
        if (isLive && deepest > 0n) bar.firstChild.style.setProperty('width', `${Math.max(2, Math.min(100, Number((poolDepth(r.state) * 1000n) / deepest) / 10))}%`);
        const hooks = r.pool instanceof UniV4Pool && r.pool.hasHooks;
        const weth = r.pool.version === 'v4' && r.pool.currency0 !== NATIVE_ETH && (a.isEthLike || b.isEthLike);
        return h(
          'div',
          { class: `card flat pool-row${used ? ' used' : ''}`, 'data-testid': 'uni-pool', 'data-pool': r.pool.id, 'data-share': used || '' },
          h('div', { class: 'banner' }, h('strong', { text: t('Uniswap {version}', { version: r.pool.version }) }), h('span', { class: 'small grow', text: [t('{fee} fee', { fee: feeText(r.pool.fee) }), hooks ? t('hook') : null, weth ? 'WETH' : null].filter(Boolean).join(' · ') }), used ? h('span', { class: 'share', text: t('{used} of your swap', { used }) }) : isLive ? null : h('span', { class: 'small', text: 'empty' })),
          isLive ? h('div', { class: 'small', text: priceOf(r, a, b) }) : null,
          isLive ? bar : null,
        );
      }),
      rows.length > 40 ? h('p', { class: 'small', text: t('…and {n} more without liquidity.', { n: rows.length - 40 }) }) : null,
    ),
  ];
}

// ------------------------------------------------------------------ price protection

const SLIPPAGE_WORDS = {
  50: tk('0.5%: strict; fails more often when others trade'),
  100: tk('1%: a good default'),
  300: tk('3%: for small pools that move a lot'),
  500: tk('5%: only for very thin pools'),
};

/** The price protection choices → the bips chosen, or undefined. */
export function pickSlippage(current) {
  return new Promise((resolve) => {
    openSheet(
      (close) => [
        h('h2', { text: t('Price protection') }),
        h('p', { class: 'lead', text: t('If the price moves against you by more than this before your swap is mined, Ethereum cancels the swap and you keep your coins (only the network fee is spent). Also called slippage.') }),
        h(
          'div',
          { class: 'card list' },
          ...SLIPPAGE_CHOICES.map((b) =>
            h('button', { class: `row${b === current ? ' on' : ''}`, role: 'radio', 'aria-checked': String(b === current), 'data-testid': `uni-slippage-${b}`, onclick: () => close(b) }, h('span', { class: `radio${b === current ? ' on' : ''}` }), h('span', { class: 'main' }, h('div', { class: 't', text: t(SLIPPAGE_WORDS[b]) }))),
          ),
        ),
        h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close')),
      ],
      { label: t('Price protection') },
    ).then(resolve);
  });
}

// ------------------------------------------------------------------ allow

/** An Ethereum permission that will not take effect, in words: what is known, never more (release audit 0.1.5). */
export function permissionGoneWords(state, who = t('The permission')) {
  if (state === 'failed') return t('{who} was refused by Ethereum, so nothing was approved by it; its network fee was spent.', { who });
  if (state === 'replaced') return t('{who} did not go through: another transaction from this wallet took its place, so nothing was approved by it.', { who });
  if (state === 'rejected') return t('{who} was refused by your Ethereum server for half an hour and never shown, so it most likely never left and nothing was spent.', { who });
  return t('{who} is no longer on its way: its place in this wallet\'s queue is used. It went through and was used up by a swap since, or Ethereum refused it (its fee spent), or another transaction took its place.', { who });
}

/**
 * The allow-token sheet: Permit2 may move exactly approval.amount of the
 * token, before the first swap of it. One extra step, once per token and
 * amount. Resolves true once Ethereum has confirmed the approval.
 *
 * A permission already on its way (sent from here earlier, still signed or pending in the outbox)
 * is followed instead of offering another (release audit 0.1.5, S1: closing the sheet and tapping
 * Swap again offered "Allow" a second time, for a second fee). It is followed on the outbox and the
 * token's allowance as read from the server in use now, whichever answers first, so picking another
 * server for a refused receipt takes effect at once (S2). recheck(): the approval this swap needs
 * now, once an earlier permission settled (it may already cover it).
 */
export function openAllowSheet(app, { w, approval: first, recheck = null, swapFee = 0n, deps = {} }) {
  // The steps that sign, ask and wait, replaceable by the unit tests (test/unit/allow_sheet.test.mjs).
  const { confirm = confirmIdentity, sign = signAndBroadcast, short = shortNow, service = uniswapFor, passMs = 3000, followMs = 10 * 60000, open = openSheet, pass = approvalPass, onItsWay = approvalOnItsWay, settleEntry = null } = deps;
  let approval = first;
  const token2 = approval.token;
  const asset = walletAsset(token2);
  let txs = null;
  let phase = 'choose'; // choose | sending | waiting | unconfirmed | failed | refused
  let error = null;
  let errorTitle = null; // the heading over `error`: what failed, and whether anything was sent
  let note = null; // a line about an earlier permission that did not go through
  let txsSeq = 0; // the newest transaction load: an older one's answer (or error) is dropped (S3)
  // The approval and its transactions come from a fresh decision (lib/eth/permission.js, through
  // recheck) taken after the last thing that could change what is needed: an earlier permission
  // settling, a run of this sheet. "Allow" is enabled ONLY while this is so (release audit 0.1.5, final).
  let decided = true; // the swap's own check, just taken (eth_swap.js approvalNeeded)
  let step = 0; // the transaction of txs under way (0-based), for "Step 2 of 2"
  let following = null; // a permission sent earlier and still on its way (found as the sheet opens)
  let checking = true; // looking for one, by the chain's word
  let receiptsRefused = false;
  let balanceCheck = false; // the balance read again just before a step is signed (its words on the button)
  let stopped = null; // the permission whose ten minutes of following here are over (nothing updates by itself any more)
  let sheet = null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const twoSteps = () => (txs ? txs.length > 1 : approval.kind === 'resetThenApprove');

  /** The outbox brought up to date for an entry the chain says is done (as far as the server in use lets). */
  async function settle(entry) {
    if (settleEntry) return settleEntry(entry);
    await followOnce(app, w.rpcFor('ethereum'), entry, { ethId: w.ethId, kv: w.kv, others: () => w.otherRpcs('ethereum') }).catch(() => null);
    await w.reloadOutbox().catch(() => {});
  }

  /**
   * Follows a sent permission (an outbox entry) until Ethereum has it, or its place is taken without
   * it: {success} / {success: false, state}, or null when the sheet was closed or ten minutes passed.
   * A server's trouble on the way is said ("Sent, not confirmed yet"), never taken for "nothing was
   * approved": it was sent, and may go through (S5). Each pass is approvalPass's (lib/eth/send.js):
   * its receipt, then the chain's word at one block, on the server in use now.
   */
  async function followApproval(entry0, rerender) {
    const { hash } = entry0;
    const started = Date.now();
    while (sheet && !sheet.closed && Date.now() - started < followMs) {
      const rpc = w.rpcFor('ethereum');
      const owner = w.state.address;
      const r = await pass({
        rpc,
        entry: w.state.outbox.find((x) => x.hash === hash) || entry0,
        owner,
        allowance: (b) => tokenAllowance(rpc, token2.address, owner, b),
        follow: async () => {
          await w.followOpen();
          const err = w.followError(hash);
          if (err) throw err;
          return w.state.outbox.find((x) => x.hash === hash) || null;
        },
        settle: (e) => settle(e),
        current: () => w.state.outbox.find((x) => x.hash === hash) || null,
        // Seen in effect without a receipt: kept with the entry, so later decisions wait for that block.
        remember: (b) => (w.kv ? updateOutbox(app, hash, { seenInEffectAt: b }, { ethId: w.ethId, kv: w.kv }) : Promise.resolve()).then(() => w.reloadOutbox()).catch(() => {}),
      });
      if (sheet.closed) return null;
      receiptsRefused = Boolean(r.receiptsRefused);
      if (r.kind === 'effect') return { success: true };
      if (r.kind === 'gone') return { success: false, state: r.state };
      if (phase === 'waiting' && (r.receiptsRefused || Date.now() - started > 60000)) {
        phase = 'unconfirmed';
        rerender();
      } else if (phase === 'unconfirmed') rerender();
      await sleep(passMs);
    }
    return null;
  }

  /** An earlier permission settled (or is no longer on its way): the approval this swap needs now (none: done). */
  async function afterEarlier(done, close, rerender) {
    following = null;
    if (done && !done.success) note = goneWords(done.state, t('The earlier permission'));
    // The one decision again: in effect and enough, the sheet closes and the review opens.
    await redecide(close, rerender);
  }

  const goneWords = permissionGoneWords;

  /**
   * The decision taken again (recheck: lib/eth/uniswap_app.js approvalNeeded), and its transactions:
   * true when a fresh need is offered, false when nothing is needed any more (the sheet closes: the
   * swap goes on) or it could not be read ("Couldn't check the permission… Nothing was sent", and
   * "Allow" stays off: every path that re-decides goes through here).
   */
  async function redecide(close, rerender) {
    decided = false;
    rerender();
    if (!recheck) return false;
    try {
      const next = await recheck();
      if (next.kind === 'none') {
        close(true);
        return false;
      }
      approval = next;
      step = 0;
      txs = null;
      phase = 'choose';
      error = null;
      errorTitle = null;
      loadTxs();
      decided = true;
      rerender();
      return true;
    } catch (e) {
      phase = 'failed';
      errorTitle = t("Couldn't check the permission. ");
      error = t('{message} Nothing was sent. Close this and tap Swap again.', { message: e.message });
      rerender();
      return false;
    }
  }

  /** This swap's permission transactions, from the service of the server in use now; only the newest load counts (S3). */
  function loadTxs() {
    const seq = ++txsSeq;
    Promise.resolve()
      .then(() => service(w))
      .then((s2) => s2.approvalTxs(approval, w.state.address))
      .then((list) => {
        if (seq !== txsSeq) return;
        txs = list;
        if (sheet && !sheet.closed) sheet.rerender();
      })
      .catch((e) => {
        if (seq !== txsSeq) return;
        phase = 'failed';
        errorTitle = t("Couldn't prepare the permission. ");
        error = t('{message} Nothing was sent. Close this and tap Swap again.', { message: e.message });
        if (sheet && !sheet.closed) sheet.rerender();
      });
  }

  /**
   * The Allow button: one run at a time (a second tap while the first asks for the password or sends
   * starts nothing), and only on a fresh decision, which the run uses up: whatever the run ends in,
   * what is needed is decided again before "Allow" comes back, so a step already confirmed (USDT's
   * reset to 0) or a permission already in effect is never sent again (release audit 0.1.5).
   */
  const allow = oneAtATime(async () => {
    const busy = phase === 'sending' || phase === 'waiting';
    if (!decided || busy || !txs || checking || following || phase === 'unconfirmed' || phase === 'refused') return;
    sheet.rerender(); // the button shows "Checking…", disabled, for the whole run
    try {
      await allowRun();
    } finally {
      // Redrawn once the run has ended (after oneAtATime lets go), so the button is usable again.
      setTimeout(() => !sheet.closed && sheet.rerender(), 0);
    }
  });

  /**
   * A permission for this token on its way, by the chain's word, other than the ones this run sent
   * (`mine`, hashes): the outbox read again first. null when there is none (no server is asked then).
   */
  async function approvalElsewhere(mine) {
    await w.reloadOutbox().catch(() => {});
    const owner = w.state.address;
    for (const e of openApprovals(w.state.outbox, { chain: 'ethereum', token: token2.address, spender: ADDRESSES.permit2 })) {
      if (mine.has(e.hash)) continue;
      const rpc = w.rpcFor('ethereum');
      if (await onItsWay(rpc, e, { owner, allowance: (b) => tokenAllowance(rpc, token2.address, owner, b) })) return e;
    }
    return null;
  }

  async function allowRun() {
    const close = sheet.close;
    const rerender = sheet.rerender;
    const sentHere = new Set(); // the steps this run signed
    const ok = await confirm(app, { title: t('Allow {symbol}', { symbol: token2.symbol }), detail: t('Uniswap may move exactly {amount}', { amount: amt(approval.amount, token2) }), cta: t('Confirm') });
    if (!ok || sheet.closed) return; // nothing sent: the decision stands
    decided = false; // this run uses it up
    error = null;
    errorTitle = null;
    note = null;
    for (let i = 0; i < txs.length; i++) {
      const tx = txs[i];
      step = i;
      phase = 'sending'; // each step: "Sending…", never the last step's words (N6)
      rerender();
      // What this step and the swap need, read again now (after the password): a permission for a
      // swap that can no longer happen would pay its fee for nothing (lib/eth/short_now.js).
      // This step's fee and every step's after it, and the swap's own (release audit 0.1.7, S5).
      const fees = txs.slice(i).reduce((sum, x) => sum + BigInt(x.maxGasCost ?? 0n), 0n) + BigInt(swapFee ?? 0n);
      balanceCheck = true;
      rerender();
      const why = await short(w, 'ethereum', { asset, amount: approval.amount, fees, feeName: t("the permission's and the swap's network fees") }).catch((e) => t('Couldn\'t read your balance just before signing: {message}. Try again in a moment.', { message: e.message }));
      balanceCheck = false;
      if (sheet.closed) return;
      if (why) {
        phase = 'failed';
        errorTitle = i ? t('The new permission was not sent. ') : t('Nothing was sent. ');
        error = why;
        rerender();
        return decideAgainAfter();
      }
      // A permission for this token sent meanwhile from elsewhere in this page (another Allow sheet, a
      // swap screen opened again): followed, never a second one, read right before signing (release
      // verification 0.1.8). This run's own earlier step is not "elsewhere".
      const elsewhere = await approvalElsewhere(sentHere);
      if (sheet.closed) return;
      if (elsewhere) {
        following = elsewhere;
        phase = 'waiting';
        rerender();
        const done = await followApproval(elsewhere, rerender);
        if (sheet.closed) return;
        if (!done) {
          phase = 'unconfirmed';
          stopped = elsewhere;
          return rerender();
        }
        return afterEarlier(done, close, rerender);
      }
      let r;
      try {
        r = await sign(app, w, tx, { kind: tx.kind, asset, amount: tx.kind === 'approveReset' ? 0n : approval.amount, extra: { spender: ADDRESSES.permit2 } });
      } catch (e) {
        // Before anything was sent (the password, the network check, a transaction in doubt):
        // a broadcast that went through never ends here (lib/eth/send.js broadcast, N7).
        phase = 'failed';
        errorTitle = i ? t('The new permission was not sent. ') : t('Nothing was sent. ');
        error = e instanceof EthRpcError ? t('Your Ethereum server said: "{message}".', { message: e.message }) : e.message;
        rerender();
        return decideAgainAfter();
      }
      sentHere.add(r.entry.hash);
      if (!r.sent && (r.entry.refusedAt || r.entry.state === 'rejected')) {
        // Refused: most likely not sent, but the server may have passed it on (lib/eth/send.js
        // keeps checking it), so not "didn't go through", and not offered to sign again here.
        phase = 'refused';
        error = r.error && r.error.message;
        return rerender();
      }
      phase = 'waiting';
      rerender();
      const done = await followApproval(r.entry, rerender);
      if (sheet.closed) return;
      if (!done) {
        phase = 'unconfirmed';
        stopped = r.entry;
        return rerender();
      }
      if (!done.success) {
        if (done.state === 'used') {
          // Its place is used without the permission in effect, by the chain's word: what the swap
          // needs now is decided again, never "nothing was approved" on a guess.
          note = goneWords('used', t('This permission'));
          await redecide(close, rerender);
          return;
        }
        phase = 'failed';
        errorTitle = t("The permission didn't go through. ");
        error = goneWords(done.state, t('It'));
        rerender();
        return decideAgainAfter();
      }
    }
    close(true);
  }

  /** After a run that ended without the permission: decided again (in the background), keeping what it said. */
  function decideAgainAfter() {
    const said = { phase, error, errorTitle };
    redecide(sheet.close, sheet.rerender).then((fresh) => {
      if (!fresh || sheet.closed) return;
      // The fresh need is offered under what the run said (it stays on screen until the next run).
      ({ phase, error, errorTitle } = said);
      sheet.rerender();
    });
  }

  return new Promise((resolve) => {
    sheet = open(
      (close, rerender) => {
        const busy = phase === 'sending' || phase === 'waiting';
        const likely = txs ? txs.reduce((s, x) => s + x.expectedGasCost, 0n) : null;
        const most = txs ? txs.reduce((s, x) => s + x.maxGasCost, 0n) : null;
        const steps = txs ? txs.length : twoSteps() ? 2 : 1;
        const stepWords = steps > 1 ? (txs && txs[step] && txs[step].kind === 'approveReset' ? t('Step {n} of {steps}: the old permission to 0. ', { n: step + 1, steps }) : t('Step {n} of {steps}: the new permission. ', { n: step + 1, steps })) : '';
        return [
          h('h2', { text: t('Allow {symbol}', { symbol: token2.symbol }) }),
          h('p', { class: 'lead', text: t('Before {symbol} can be swapped, Ethereum needs your permission for Uniswap to move it. This is its own transaction; nothing is swapped yet, and the swap comes right after.', { symbol: token2.symbol }) }),
          h('p', { class: 'small', 'data-testid': 'uni-approve-explain', text: t('Exactly what this swap uses: {amount}. The next swap of {symbol} asks again.', { amount: amt(approval.amount, token2), symbol: token2.symbol }) }),
          twoSteps() ? notice('info', h('strong', { text: t('{symbol} takes two steps. ', { symbol: token2.symbol }) }), t('{symbol} only changes a permission from zero, so Firo PWA first sets the old one to 0, then to the new amount: two transactions, one confirmation.', { symbol: token2.symbol })) : null,
          h(
            'div',
            { class: 'card flat swap-details' },
            kv(t('Token'), h('span', {}, `${token2.symbol} `, h('span', { class: 'mono nowrap', text: `(${shorten(toChecksumAddress(token2.address), 6, 4)})` }))),
            kv(t('Allowed to move it'), h('span', {}, t('Uniswap Permit2 '), h('span', { class: 'mono nowrap', text: `(${shorten(toChecksumAddress(ADDRESSES.permit2), 6, 4)})` }))),
            kv(t('Network fee'), likely === null ? '…' : t('about {amount}', { amount: ethAbout(likely) }), { 'data-testid': 'uni-approve-fee' }, most === null ? null : t('at most {amount}', { amount: ethAtMost(most) })),
          ),
          following
            ? (() => {
                const n = notice('info', h('strong', { text: t('A permission for {symbol} is already on its way. ', { symbol: token2.symbol }) }), stopped ? t('Sent earlier from this device and not confirmed yet. A second one would cost a second network fee.') : t('Sent earlier from this device and not confirmed yet: Firo PWA follows it instead of asking for a second one (that would cost a second network fee). The swap review opens by itself once Ethereum has it.'));
                n.dataset.testid = 'uni-approve-following';
                return n;
              })()
            : null,
          note ? notice('info', note) : null,
          phase === 'waiting' && !following ? notice('info', h('strong', { text: t('{stepWords}Waiting for Ethereum to confirm… ', { stepWords }) }), t('Usually under a minute. The swap review opens by itself.')) : null,
          phase === 'unconfirmed' ? (() => {
            const n = notice(
              'warn',
              h('strong', { text: t('{value}Sent, not confirmed yet. ', { value: following ? '' : stepWords }) }),
              stopped
                ? t("Don't allow it again: this permission may still go through, and a second one would cost a second network fee. Firo PWA stopped watching it here after ten minutes: see it to follow it, and once it is confirmed, tap Swap again.")
                : t("Don't allow it again: this permission may still go through, and a second one would cost a second network fee. Firo PWA keeps following it here and in your Ethereum activity; the swap review opens by itself once Ethereum has it."),
              stopped
                ? h(
                    'div',
                    { class: 'btn-row prompt-actions' },
                    h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'uni-approve-see', onclick: () => (close(false), app.go('ethSwapTx', { hash: stopped.hash })) }, t('See it')),
                  )
                : null,
            );
            n.dataset.testid = 'uni-approve-unconfirmed';
            n.dataset.stopped = stopped ? 'true' : 'false';
            return n;
          })() : null,
          (phase === 'unconfirmed' || phase === 'waiting') && receiptsRefused ? receiptsRefusedNotice(app, 'ethereum', { what: 'permission', testid: 'uni-approve-receipts-refused', onSwitched: () => rerender() }) : null,
          phase === 'failed' && error ? (() => {
            const n = notice('error', h('strong', { text: errorTitle || t("The permission didn't go through. ") }), error);
            n.dataset.testid = 'uni-approve-failed';
            return n;
          })() : null,
          phase === 'refused' ? (() => {
            const n = notice('warn', h('strong', { text: t('Not sent yet. ') }), t('Don\'t allow it again yet. Your Ethereum server refused this permission, so it has most likely not left, but it may have passed it on before refusing. Firo PWA keeps checking it for half an hour; it shows in your Ethereum activity.{value}', { value: error ? t(' The server said: {error}', { error }) : '' }));
            n.dataset.testid = 'uni-approve-refused';
            return n;
          })() : null,
          h(
            'div',
            { class: 'sheet-actions' },
            h('button', { class: 'btn btn-primary', onclick: allow, disabled: !decided || allow.running || busy || !txs || checking || Boolean(following) || phase === 'refused' || phase === 'unconfirmed', 'data-testid': 'uni-approve-cta' }, phase === 'sending' ? (balanceCheck ? t('Checking your balance…') : t('Sending…')) : stopped ? t('Not confirmed yet') : phase === 'waiting' || phase === 'unconfirmed' || following ? t('Waiting for Ethereum…') : checking || allow.running ? t('Checking…') : t('Allow {amount}', { amount: amt(approval.amount, token2) })),
            h('button', { class: 'btn btn-text sheet-out', onclick: () => close(false), disabled: phase === 'sending', 'data-testid': 'uni-approve-cancel' }, phase === 'refused' || phase === 'unconfirmed' || phase === 'waiting' || following ? t('Close') : t('Not now')),
          ),
        ];
      },
      { label: t('Allow {symbol}', { symbol: token2.symbol }), dismissable: false },
    );
    sheet.then((v) => resolve(v === true));
    loadTxs();
    // A permission sent earlier and, by the chain's word, still on its way (S1): followed. One the
    // chain says is mined, used or replaced is settled in the outbox and not waited for.
    (async () => {
      const owner = w.state.address;
      let settled = false;
      for (const e of openApprovals(w.state.outbox, { chain: 'ethereum', token: token2.address, spender: ADDRESSES.permit2 })) {
        const rpc = w.rpcFor('ethereum');
        if (await onItsWay(rpc, e, { owner, allowance: (b) => tokenAllowance(rpc, token2.address, owner, b) })) {
          following = e;
          break;
        }
        await settle(e);
        settled = true;
      }
      if (sheet.closed) return;
      if (!following && settled) {
        // One settled just now may be in effect: what the swap needs is decided again before anything
        // is offered. Done (the swap goes on), or the check failed: said, with the next step, and
        // "Allow" stays off; never "Checking…" for ever (S4).
        checking = false;
        await redecide(sheet.close, sheet.rerender);
        return;
      }
      checking = false;
      if (sheet.closed) return;
      if (!following) return sheet.rerender();
      phase = 'waiting';
      sheet.rerender();
      const done = await followApproval(following, sheet.rerender);
      if (sheet.closed) return;
      if (!done) {
        phase = 'unconfirmed';
        stopped = following;
        return sheet.rerender();
      }
      afterEarlier(done, sheet.close, sheet.rerender);
    })();
  });
}

// ------------------------------------------------------------------ review

/**
 * What a second server said about the price (lib/eth/second_opinion.js), for a review sheet:
 * [line or notice, the tick when the two differ]. ack/onAck: whether the tick is ticked.
 */
export function secondOpinionBlock(check, { server, amount, ack, onAck, testid = 'second-opinion' }) {
  const words = secondOpinionWords(check, { server, amount });
  if (words.kind === 'ok') return [h('p', { class: 'small', 'data-testid': testid, 'data-status': check.status, text: words.text })];
  const n = notice(words.kind === 'warn' ? 'warn' : 'info', words.text);
  n.dataset.testid = testid;
  n.dataset.status = check ? check.status : 'unchecked';
  if (!words.ack) return [n];
  const box = h('input', { type: 'checkbox', 'data-testid': `${testid}-ack`, checked: ack });
  box.addEventListener('change', () => onAck(box.checked));
  return [n, h('label', { class: 'check-row' }, box, h('span', { text: words.ack }))];
}

/** The price-change warning from 3 %, and from 10 % the box to tick before the swap can be sent. */
export function impactBlock(q, block, ack, onAck) {
  const warn = notice(block ? 'error' : 'warn', h('strong', { text: t('This swap moves the price {amount}. ', { amount: percentText(q.priceImpact) }) }), t('The pools are small for this amount, so you get noticeably less than the current rate. A smaller amount gets a better price.'));
  warn.dataset.testid = 'uni-impact-warning';
  if (!block) return [warn];
  const box = h('input', { type: 'checkbox', 'data-testid': 'uni-impact-ack', checked: ack });
  box.addEventListener('change', () => onAck(box.checked));
  return [warn, h('label', { class: 'check-row' }, box, h('span', { text: t('I accept getting {amount} less', { amount: percentText(q.priceImpact) }) }))];
}

/**
 * The review sheet: exactly what the swap does before anything is signed.
 * After the person confirms: the Permit2 signature (for a token), the router
 * call built and simulated, then signed, saved and broadcast. Resolves the
 * transaction hash once it has left (or may have), null when the person went
 * back without swapping.
 */
export function openReviewSheet(app, { w, svc, review: first, acceptImpact, check = null }) {
  let review = first;
  let busy = false;
  let asking = false; // the password is being asked (the button is off from the first tap)
  let error = null;
  let ack = Boolean(acceptImpact);
  // Two servers more than 2% apart on the price, or no second server to compare with: the swap waits for the person's tick (P13).
  let gapAck = !priceAckNeeded(check);
  const blocked = () => (review.impact === 'block' && !ack) || !gapAck;
  return new Promise((resolve) => {
    const sheet = openSheet(
      (close, rerender) => {
        const q = review.quote;
        const swap = async () => {
          // One swap from one review: taken from the first tap, before the password (two taps
          // opened two password sheets, and two swaps went: release verification 0.1.8).
          if (busy || asking || blocked()) return;
          asking = true;
          rerender();
          const ok = await confirmIdentity(app, { title: t('Confirm the swap'), detail: t('{amountIn} for at least {minimumOut}', { amountIn: amtShown(q.amountIn, q.tokenIn), minimumOut: amtShown(review.minimumOut, q.tokenOut, { floor: true }) }), cta: t('Confirm') });
          asking = false;
          if (busy || sheet.closed) return;
          if (!ok) return rerender();
          busy = true;
          error = null;
          rerender();
          let prepared;
          try {
            prepared = await svc.finalizeSwap({ review, signPermit: permitSigner(app, w), acceptImpact: ack, permitMinBlock: walletPermissionFloor(w, 'ethereum', review.quote.tokenIn.address) });
          } catch (e) {
            busy = false;
            if (e instanceof UniGasChanged) {
              review = Object.freeze({ ...review, gasLimit: e.gasLimit, maxGasCost: e.gasLimit * review.fees.maxFeePerGas, expectedGasCost: e.gasLimit * (review.fees.baseFee + review.fees.maxPriorityFeePerGas) });
              error = t('The swap needs a little more gas than first measured. The network fee below is updated; nothing was sent.');
            } else if (e instanceof UniRouteChanged) error = t('One of the pools on this route would not actually trade, so Firo PWA left it out. Go back for the next best price.');
            else if (isRevert(e)) error = t('Ethereum would refuse this swap now, most often because the price moved past your protection since this review. Nothing was sent. Tap Change for a new price.');
            else if (e instanceof EthRpcError) error = t('Your Ethereum server would not build it: "{message}". Nothing was sent.', { message: e.message });
            else error = t('Couldn\'t build the swap: {message} Nothing was sent.', { message: e.message });
            return rerender();
          }
          // Closed while it was built (another screen opened): nothing is signed (audit of 0.1.8, X5).
          if (sheet.closed) {
            busy = false;
            return;
          }
          try {
            const r = await signAndBroadcast(app, w, prepared.tx, {
              kind: 'swap',
              asset: walletAsset(q.tokenIn),
              amount: q.amountIn,
              extra: { tokenOut: q.tokenOut.isEth ? null : q.tokenOut.address, tokenOutSymbol: q.tokenOut.symbol, quotedOut: String(q.amountOut), minimumOut: String(prepared.minimumOut), pools: poolCount(q) },
            });
            // Sent, or refused by a server that may have passed it on first: the status screen follows
            // it either way and says which ("Not sent yet" until it knows), never "nothing was sent" too soon.
            close(r.entry.hash);
          } catch (e) {
            busy = false;
            error = t('Nothing was sent. {message}', { message: e.message });
            rerender();
          }
        };
        const hooked = q.pools.some((p) => p instanceof UniV4Pool && p.hasHooks);
        return [
          h('h2', { text: t('Check before swapping') }),
          h(
            'div',
            { class: 'card review-amounts' },
            h('div', { class: 'review-line' }, tokenBadge(q.tokenIn), h('div', { class: 'grow' }, h('div', { class: 'small', text: t('You pay') }), h('div', { class: 'big', 'data-testid': 'uni-review-pay', title: amt(q.amountIn, q.tokenIn), text: amtShown(q.amountIn, q.tokenIn) }), h('div', { class: 'small', 'data-testid': 'uni-review-total', text: t('+ the network fee, about {amount}', { amount: ethAbout(review.expectedGasCost) }) }))),
            h('div', { class: 'review-line' }, tokenBadge(q.tokenOut), h('div', { class: 'grow' }, h('div', { class: 'small', text: t('You receive about') }), h('div', { class: 'big', 'data-testid': 'uni-review-receive', title: amt(q.amountOut, q.tokenOut), text: amtShown(q.amountOut, q.tokenOut) }))),
            notice('success', h('strong', { 'data-testid': 'uni-review-minimum', text: t('You receive at least {minimumOut}. Ethereum enforces this. ', { minimumOut: amtShown(review.minimumOut, q.tokenOut, { floor: true }) }) }), t('If the price moves more than {amount} first, Ethereum cancels the swap and only the network fee is spent.', { amount: bipsText(review.slippageBips) })),
          ),
          h(
            'div',
            { class: 'card flat swap-details' },
            kv(t('Rate'), rateText(q)),
            kv(t('Route'), routeText(q), {}, routeNote(q)),
            kv(t('Price change from your swap'), q.priceImpact == null ? t('Unknown') : percentText(q.priceImpact), { class: `v${review.impact === 'none' ? '' : ' bad'}` }),
            h(
              'button',
              {
                class: 'kv kv-tap',
                type: 'button',
                title: t('Also called slippage tolerance'),
                'data-testid': 'uni-review-protection',
                disabled: busy,
                onclick: async () => {
                  const b = await pickSlippage(review.slippageBips);
                  if (!b || b === review.slippageBips || sheet.closed) return;
                  // Only the minimum changes: the gas and the route are the same.
                  review = Object.freeze({ ...review, slippageBips: b, minimumOut: review.quote.minimumOut(b) });
                  rerender();
                },
              },
              h('span', { class: 'k', text: t('Price protection') }),
              h('span', { class: 'v' }, bipsText(review.slippageBips), h('div', { class: 'small', text: t('Tap to change') })),
            ),
            kv(t('Network fee'), t('about {amount}', { amount: ethAbout(review.expectedGasCost) }), { 'data-testid': 'uni-review-fee' }, t('at most {amount}', { amount: ethAtMost(review.maxGasCost) })),
            h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('Sent to') }), h('span', { class: 'v', 'data-testid': 'uni-review-router' }, t('Uniswap Universal Router '), h('span', { class: 'mono nowrap', text: `(${shorten(toChecksumAddress(ADDRESSES.universalRouter), 6, 4)})` }))),
            review.needsPermit ? kv(t('You also sign'), t('Uniswap may take exactly {amountIn}, for {n} minutes', { amountIn: amt(q.amountIn, q.tokenIn), n: PERMIT_LIFE_SECONDS / 60 }), { 'data-testid': 'uni-review-permit' }) : null,
          ),
          ...(review.impact === 'none' ? [] : impactBlock(q, review.impact === 'block', ack, (v) => {
            ack = v;
            rerender();
          })),
          ...secondOpinionBlock(check, {
            server: w.rpc.host.name,
            amount: (v) => amtShown(v, q.tokenOut),
            ack: gapAck,
            onAck: (v) => {
              gapAck = v;
              rerender();
            },
            testid: 'uni-review-second',
          }),
          hooked ? notice('warn', h('strong', { text: t('This route uses a pool with a hook. ') }), t('A hook is extra code its creator added to the pool. Your minimum above is still enforced by Uniswap.')) : null,
          h('p', { class: 'small', text: t('Ethereum swaps cannot be undone once sent, and anyone can see them.') }),
          error ? (() => {
            const n = notice('warn', error);
            n.dataset.testid = 'uni-review-error';
            return n;
          })() : null,
          h(
            'div',
            { class: 'sheet-actions' },
            h('button', { class: 'btn btn-primary', onclick: swap, disabled: busy || asking || blocked(), 'data-testid': 'uni-review-cta' }, busy ? t('Signing and sending…') : t('Swap {amountIn}', { amountIn: amtShown(q.amountIn, q.tokenIn) })),
            h('button', { class: 'btn btn-text sheet-out', onclick: () => close(null), disabled: busy || asking, 'data-testid': 'uni-review-change' }, t('Change')),
          ),
        ];
      },
      { label: t('Check before swapping'), dismissable: false },
    );
    sheet.then((v) => resolve(typeof v === 'string' ? v : null));
  });
}

