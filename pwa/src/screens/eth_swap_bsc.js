/* Buy rsFIRO on BNB Chain (Ethereum & BNB Home -> Buy rsFIRO, when the BNB is there; or the
 * Uniswap swap's "BNB Chain" tab)
 * Spec: ONE job: swap BNB for rsFIRO (or rsFIRO back to BNB) on PancakeSwap, from this wallet,
 *       directly on PancakeSwap's own contracts (the rsFIRO/WBNB pool, 1%).
 *       Primary CTA: the outcome, "Swap 0.1 BNB for ≈69.8 rsFIRO"; selling rsFIRO first shows
 *       "Allow 100 rsFIRO" (exactly that amount, once); then the review sheet and Face ID / password.
 *       Taps from app open: Ethereum & BNB (1) -> Buy rsFIRO (2) -> type an amount -> the button (3).
 * Exit-intent reasons and answers:
 *   - "Why is the button grey?" -> the reason is written right above it (no amount, not enough,
 *     not enough BNB for the network fee, still pricing).
 *   - "Will I get a bad price?" -> the rate, the price change from the swap (amber from 3%, refused
 *     from 10%), and "at least …" under the 1% price protection, before anything is signed. The
 *     price is asked again of a second listed BNB Chain server before the review: agreed (one
 *     line), more than 2% apart (both figures, and a tick before the swap), or not reachable (said).
 *   - "What does it cost?" -> the pool's 1% fee is in the price; the network fee is shown in BNB.
 *   - "Is rsFIRO my private FIRO?" -> no, and said under the form: it is FIRO on BNB Chain, public.
 *   - "I want it on Ethereum" -> the Ethereum tab at the top opens the Uniswap swap.
 *   - "The server refused it - did it leave?" -> "Not sent yet": most likely not, but the server may
 *     have passed it on, so it is followed (the swap on its status screen, the permission here) and
 *     checked for half an hour before it counts as not sent (lib/eth/send.js).
 *   - "Did my tap count twice?" -> one run at a time: the button is off from the tap until its
 *     password or review sheet is answered, the review cannot be closed while it swaps, and a swap
 *     (a buy too) still on its way holds the next one (release verification 0.1.8).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, openSheet } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { parseUnits } from '../lib/eth/units.js';
import { compactUnits, exactUnits } from '../lib/compact.js';
import { BNB, RSFIRO_BSC } from '../lib/eth/tokens.js';
import { walletFees, EthRpcError } from '../lib/eth/rpc.js';
import { prepareCall, signAndBroadcastCall, followOnce, approvalOnItsWay, approvalPass, SendError } from '../lib/eth/send.js';
import { shortNow } from '../lib/eth/short_now.js';
import { quoteSwap, buildSwap, minOut, routerAllowance, approveTx, DEFAULT_SLIPPAGE_BIPS, DEADLINE_SEC, TYPICAL_GAS, PancakeError, PANCAKE } from '../lib/eth/pancake.js';
import { secondOpinion, secondOpinionWords, priceAckNeeded } from '../lib/eth/second_opinion.js';
import { ethBadge, coinText, coinMaxText, serverProblem, chainTabs, doubtNotice, receiptsRefusedNotice, swapOnItsWayNotice } from './eth_ui.js';
import { inDoubt, openApprovals, updateOutbox, isOpen, entryChain } from '../lib/eth/outbox.js';
import { decidePermission, walletPermissionFloor } from '../lib/eth/permission.js';

// Less than this left of a reviewed swap's deadline when the password is given: not signed (XS).
const DEADLINE_MARGIN_SEC = 2 * 60;
const QUOTE_DELAY_MS = 500;
/** How often a permission being followed is looked at. */
const PASS_MS = 3000;
const IMPACT_WARN = 0.03;
const IMPACT_BLOCK = 0.1;
const FRESH_MS = 30000;

const amt = (v, t) => `${exactUnits(v, t.decimals)} ${t.symbol}`;
const short = (v, t) => `${compactUnits(v, t.decimals)} ${t.symbol}`;
const fee = (wei) => coinText(wei, 'bsc');

/** A permission the BNB Chain server refused: most likely not sent, but it may have passed it on. */
const refusedPermission = (entry) => {
  const n = notice('warn', h('strong', { text: 'Not sent yet. ' }), `Don't allow it again yet. Your BNB Chain server refused this permission, so it has most likely not left, but it may have passed it on before refusing. Campfire keeps checking it, and offering the same one (never a second), for half an hour; this updates by itself.${entry.error ? ` The server said: ${entry.error}` : ''}`);
  n.dataset.testid = 'pcs-approve-refused';
  return n;
};

function kv(label, value, extra = {}, note = null) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: label }), h('span', { class: 'v', ...extra }, value, note ? h('div', { class: 'small', text: note }) : null));
}

/**
 * A followed BNB Chain permission that will not take effect, in words: [title, text]. What is known,
 * never more (release audit 0.1.5); the next step from the allowance as just read: enough, Swap;
 * otherwise Allow again.
 */
export function bnbPermissionGoneWords(state, { enough = false } = {}) {
  const next = enough ? 'PancakeSwap may already move this rsFIRO: tap Swap.' : 'Nothing was swapped; allow again to sell.';
  return (
    {
      failed: ['The permission did not go through. ', `BNB Chain refused it, so nothing was approved by it and only its network fee was spent. ${next}`],
      replaced: ['The permission did not go through. ', `Another transaction from this wallet took its place, so nothing was approved by it. ${next}`],
      rejected: ['The permission was not sent. ', `Your BNB Chain server refused it for half an hour and never showed it, so it most likely never left and nothing was spent. ${next}`],
      used: ['The permission is no longer on its way. ', `Its place in this wallet's queue is used: it went through and was used up by a swap since, or BNB Chain refused it (its fee spent), or another transaction took its place. ${next}`],
    }[state] || ['The permission did not go through. ', next]
  );
}

/** deps (tests only): wallet(app), the wallet opened; quote(rpc, args), PancakeSwap's price. */
export default function ethSwapBsc(app, params = {}, deps = {}) {
  const openWallet = deps.wallet || ethWallet;
  const quoteOf = deps.quote || quoteSwap;
  const draft = (app.bscSwapDraft = app.bscSwapDraft || { side: 'buy', amount: '' });
  if (params.side === 'buy' || params.side === 'sell') draft.side = params.side;
  if (typeof params.amount === 'string') draft.amount = params.amount;
  let w = null;
  let rpc = null;
  let fees = null;
  let quote = null;
  let quotedAt = 0;
  let quoting = false;
  let problem = null;
  let allowance = null;
  let busy = null;
  let running = false; // an Allow or Swap run, from the tap until its password / review sheet is answered
  let seq = 0;
  let timer = null;
  let alive = true;
  let approving = null; // the approval's outbox entry while it is mined
  let waiting = false; // waitApproval() is following it

  const pay = () => (draft.side === 'buy' ? BNB : RSFIRO_BSC);
  const receive = () => (draft.side === 'buy' ? RSFIRO_BSC : BNB);
  const payInput = h('input', { class: 'swap-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount to pay', 'data-testid': 'pcs-pay-amount' });
  payInput.value = draft.amount;
  const payTag = h('span', { class: 'asset-pick static' });
  const getTag = h('span', { class: 'asset-pick static' });
  const getAmount = h('div', { class: 'swap-out', 'data-testid': 'pcs-receive-amount' });
  const paySub = h('div', { class: 'swap-sub' });
  const flipBtn = h('button', { class: 'swap-flip', type: 'button', 'aria-label': 'Swap the two tokens', 'data-testid': 'pcs-flip', onclick: flip }, icon('swap'));
  const notesBox = h('div', { class: 'swap-notes' });
  const reason = h('p', { class: 'hint center', 'data-testid': 'pcs-reason', 'aria-live': 'polite' });
  const cta = primary('Swap', act, { disabled: true, class: 'btn btn-primary wrap', 'data-testid': 'pcs-swap-cta' });
  const msg = h('div', { 'aria-live': 'polite' });

  function amountState() {
    const t = payInput.value.trim();
    if (!t) return { value: null, error: null };
    try {
      const v = parseUnits(t, pay().decimals, { symbol: pay().symbol });
      return v > 0n ? { value: v, error: null } : { value: null, error: 'The amount must be more than zero.' };
    } catch (e) {
      return { value: null, error: e.message };
    }
  }

  const bnb = () => (w ? w.chain('bsc').native : null);
  const balanceOf = (t) => (!w ? null : t === BNB ? bnb() : w.chain('bsc').tokens.get(t.symbol) ?? null);
  // What a swap may use: the balance less what transactions still on their way hold (release audit
  // 0.1.6: one built on money already promised fails on BNB Chain, its fee lost).
  const heldOf = (t) => (w ? w.heldOf('bsc', t) : 0n);
  const freeOf = (t) => {
    const v = balanceOf(t);
    if (v == null) return v;
    return v > heldOf(t) ? v - heldOf(t) : 0n;
  };
  const heldNote = (t) => (heldOf(t) > 0n ? ` ${short(heldOf(t), t)} more is held for a transaction still on its way.` : '');
  /**
   * A swap of what is paid still on its way holds the next: a sale of rsFIRO (both would count on the
   * same permission), and a buy with BNB too (release verification 0.1.8: a review closed while it
   * swapped offered the same buy again, and both went through).
   */
  const openSale = () => (w ? w.openSwap('bsc', draft.side === 'sell' ? RSFIRO_BSC.address : null) : null);
  const gasFor = (k) => (fees ? TYPICAL_GAS[k] * fees.maxFeePerGas : null);
  const needsApproval = (a) => draft.side === 'sell' && a != null && allowance != null && allowance < a;

  function ctaState() {
    const a = amountState();
    if (busy) return { off: busy };
    // Its own password or review sheet is open: Enter or Space behind it starts nothing.
    if (running) return { off: '' };
    if (!w) return { off: 'Opening your wallet…' };
    if (openSale()) return { off: `Your last swap of ${pay().symbol} is still on its way.` };
    if (a.error) return { off: a.error };
    if (a.value == null) return { off: `Enter how much ${pay().symbol} to swap.` };
    const have = freeOf(pay());
    if (have != null && a.value > have) return { off: heldOf(pay()) > 0n ? `Not enough ${pay().symbol} free: you can swap ${short(have, pay())}.${heldNote(pay())}` : `Not enough ${pay().symbol}. You have ${short(have, pay())}.` };
    // A permission matters for selling only: buying (BNB) is never held up by one (release audit 0.1.5).
    if (approving && draft.side === 'sell') return { off: `Waiting for BNB Chain to confirm the ${RSFIRO_BSC.symbol} permission…` };
    // Selling: whether PancakeSwap may already move this rsFIRO is not known yet (its read failed,
    // or is under way). Never taken for "no permission needed": that offered "Swap", whose
    // preparation then failed (e2e 2026-10-14). The price's read asks again.
    if (draft.side === 'sell' && allowance == null) return { off: problem ? '' : `Checking the ${RSFIRO_BSC.symbol} permission…` };
    // An earlier transaction in doubt: nothing new is signed on BNB Chain until it settles (audit BM-1).
    if (doubtful()) return { off: 'An earlier BNB Chain transaction is not settled yet (above).' };
    if (problem) return { off: '' };
    if (quoting || !quote) return { off: 'Getting the price from PancakeSwap…' };
    // A permission first: its fee and the sale's after it, so a permission is never paid for a sale
    // whose own fee is then missing (release audit 0.1.7, S5).
    const g = needsApproval(a.value) ? (gasFor('approve') != null ? gasFor('approve') + gasFor('sell') : null) : gasFor(draft.side);
    const have0 = freeOf(BNB);
    if (g != null && have0 != null) {
      const need = (draft.side === 'buy' ? a.value : 0n) + g;
      if (need > have0) return { off: (draft.side === 'buy' ? `Not enough BNB. You need about ${fee(need)} with the network fee.` : `You need about ${fee(g)} for the network fee. You have ${fee(have0)}${heldOf(BNB) > 0n ? ' free' : ''}.`) + heldNote(BNB) };
    }
    if ((quote.priceImpact ?? 0) >= IMPACT_BLOCK) return { off: `This swap would move the price ${(quote.priceImpact * 100).toFixed(1)}%. Try a smaller amount.` };
    return { off: null, approve: needsApproval(a.value) };
  }

  /** An earlier BNB Chain transaction of this wallet in doubt (not the permission being followed here: that has its own words). */
  function doubtful() {
    return w && !(approving && draft.side === 'sell') ? inDoubt(w.state.outbox, 'bsc')[0] || null : null;
  }

  function render() {
    if (!alive) return;
    const p = pay();
    const r = receive();
    put(payTag, ethBadge(p, 'small'), h('span', { text: p.symbol }));
    put(getTag, ethBadge(r, 'small'), h('span', { text: r.symbol }));
    const have = balanceOf(p);
    put(paySub, have == null ? 'Checking the balance…' : `You have ${short(have, p)}${heldOf(p) > 0n ? ` · ${short(heldOf(p), p)} held for a transaction not confirmed yet` : ''}`);
    const a = amountState();
    getAmount.textContent = quote ? `≈ ${compactUnits(quote.amountOut, r.decimals)}` : quoting ? '…' : '0';
    getAmount.title = quote ? amt(quote.amountOut, r) : '';
    const notes = [];
    if (quote) {
      const rate = draft.side === 'buy' ? Number(quote.amountOut) / 1e8 / (Number(quote.amountIn) / 1e18) : Number(quote.amountOut) / 1e18 / (Number(quote.amountIn) / 1e8);
      notes.push(kv('Rate', `1 ${p.symbol} ≈ ${rate.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${r.symbol}`, { 'data-testid': 'pcs-rate' }));
      notes.push(kv('You get at least', short(minOut(quote.amountOut, DEFAULT_SLIPPAGE_BIPS), r), { 'data-testid': 'pcs-min' }, '1% price protection: a worse price cancels the swap'));
      const imp = quote.priceImpact;
      if (imp != null) notes.push(kv('Price change from this swap', `${(imp * 100).toFixed(imp < 0.01 ? 2 : 1)}%`, { 'data-testid': 'pcs-impact', class: imp >= IMPACT_WARN ? 'v warn-text' : 'v' }));
      notes.push(kv('Route', 'PancakeSwap v3 · rsFIRO/WBNB · 1% pool fee'));
    }
    const permitFirst = a.value != null && needsApproval(a.value);
    const g = a.value != null ? gasFor(permitFirst ? 'approve' : draft.side) : null;
    // A permission first: both fees, as the button asks for both (release audit 0.1.7).
    if (g != null) notes.push(kv(permitFirst ? 'Network fees' : 'Network fee', permitFirst && gasFor('sell') != null ? `about ${fee(g)} for the permission, then about ${fee(gasFor('sell'))} for the sale` : `about ${fee(g)}`, { 'data-testid': 'pcs-fee' }));
    const doubt = doubtful();
    const sale = doubt ? null : openSale();
    put(notesBox, doubt ? doubtNotice(app, doubt, { testid: 'pcs-in-doubt' }) : null, sale ? swapOnItsWayNotice(app, w, sale, pay().symbol, { testid: 'pcs-swap-on-its-way', rerender: render }) : null, ...notes, problem ? h('div', { 'data-testid': 'pcs-problem' }, problem) : null);
    const st = ctaState();
    reason.textContent = st.off || '';
    cta.disabled = st.off !== null;
    cta.textContent = st.off === null ? (st.approve ? `Allow ${short(a.value, p)}` : `Swap ${short(a.value, p)} for ≈${short(quote.amountOut, r)}`) : 'Swap';
    if (st.approve) cta.dataset.step = 'approve';
    else delete cta.dataset.step;
  }

  function requoteSoon() {
    clearTimeout(timer);
    quote = null;
    problem = null;
    const a = amountState();
    quoting = Boolean(rpc && a.value != null);
    render();
    if (quoting) timer = setTimeout(requote, QUOTE_DELAY_MS);
  }

  async function requote() {
    const a = amountState();
    if (!rpc || a.value == null) return;
    const mine = ++seq;
    quoting = true;
    render();
    try {
      const q = await quoteOf(rpc, { side: draft.side, amountIn: a.value });
      // The permission's first read failed (the screen's opening): asked again with the price.
      const allowed = draft.side === 'sell' && allowance == null ? await freshAllowance() : null;
      if (!alive || mine !== seq) return;
      if (allowed != null) allowance = allowed;
      quote = q;
      quotedAt = Date.now();
      problem = null;
    } catch (e) {
      if (!alive || mine !== seq) return;
      quote = null;
      problem = e instanceof PancakeError ? notice('warn', e.message) : serverProblem(app, e, { chain: 'bsc', retry: requoteSoon, switched: () => app.go('ethSwapBsc', {}, { replace: true }) });
    }
    quoting = false;
    render();
  }

  function flip() {
    draft.side = draft.side === 'buy' ? 'sell' : 'buy';
    const title = el && el.querySelector('.topbar h1');
    if (title) title.textContent = draft.side === 'sell' ? 'Sell rsFIRO' : 'Buy rsFIRO';
    payInput.value = draft.amount = '';
    requoteSoon();
    followEarlier();
  }

  /** The button: one run at a time, from the tap until its password or review sheet is answered (the button stays off). */
  async function act() {
    const st = ctaState();
    if (running || st.off !== null) return;
    running = true;
    try {
      if (st.approve) await approve();
      else await review();
    } finally {
      running = false;
      if (alive) render();
    }
  }

  /** A permission for rsFIRO already on its way (sent earlier, still signed or pending): followed, never sent twice (S1). */
  async function earlierApproval() {
    if (!w) return null;
    const owner = w.state.address;
    const r = w.rpcFor('bsc');
    let settled = false;
    for (const e of openApprovals(w.state.outbox, { chain: 'bsc', token: RSFIRO_BSC.address })) {
      // On its way by the chain's word (its nonce unused, the allowance not yet what it sets), not
      // the outbox's: one mined, used or replaced is settled there and not waited for (S1).
      if (await approvalOnItsWay(r, e, { owner, allowance: (b) => routerAllowance(r, owner, b) })) return e;
      await settleEntry(e);
      settled = true;
    }
    // One settled just now may be in effect: the allowance read again, so "Allow" is offered only if needed.
    if (settled) allowance = await freshAllowance().catch(() => null);
    return null;
  }

  /**
   * The router's allowance now, read at a block no older than the one that confirmed this wallet's
   * newest rsFIRO permission: a backend of a load-balanced server still behind it is waited for, never
   * taken at its word (it would show the permission missing and offer a second one: release audit
   * 0.1.5, S1).
   */
  async function freshAllowance() {
    return (await decision(0n)).current;
  }

  /**
   * The one decision (lib/eth/permission.js): what permission selling `need` rsFIRO needs now, the
   * router's allowance read at one block no older than the one that confirmed (or showed in effect)
   * this wallet's newest rsFIRO permission. Throws "couldn't check": nothing is offered then.
   */
  function decision(need, r = w.rpcFor('bsc')) {
    const owner = w.state.address;
    return decidePermission(r, { minBlock: walletPermissionFloor(w, 'bsc', RSFIRO_BSC.address), need, allowance: (b) => routerAllowance(r, owner, b) });
  }

  /** The outbox brought up to date for an entry the chain says is done (as far as the server in use lets). */
  async function settleEntry(e) {
    await followOnce(app, w.rpcFor('bsc'), e, { ethId: w.ethId, kv: w.kv, others: () => w.otherRpcs('bsc') }).catch(() => null);
    await w.reloadOutbox().catch(() => {});
  }

  /** Selling: follows a permission still on its way, if there is one. */
  async function followEarlier() {
    if (draft.side !== 'sell' || approving) return;
    const earlier = await earlierApproval();
    if (!alive || !earlier || approving || draft.side !== 'sell') return;
    approving = earlier;
    render();
    waitApproval();
  }

  /** Exactly the amount to swap, for the SmartRouter; never "unlimited". */
  async function approve() {
    const a = amountState().value;
    put(msg);
    busy = 'Checking with BNB Chain…';
    render();
    const earlier = await earlierApproval();
    busy = null;
    if (!alive) return;
    if (earlier) {
      approving = earlier;
      render();
      waitApproval();
      return;
    }
    // The one decision, right before anything is signed: "Allow" only on a fresh need (an earlier
    // permission in effect needs no second one; a lagging or silent server: nothing is offered).
    // One server for the check, the preparation and the signature: the one in use now.
    rpc = w.rpcFor('bsc');
    const r0 = rpc;
    busy = 'Checking with BNB Chain…';
    render();
    let d;
    try {
      d = await decision(a, r0);
    } catch (e) {
      busy = null;
      put(msg, notice('warn', h('strong', { text: "Couldn't check the permission. " }), `${e.message || 'BNB Chain did not answer.'} Nothing was sent. Try again in a moment.`));
      // The last figure is kept, so "Allow" can run the check again; none known yet (an earlier
      // permission settled and its read failed too): read again with the price, never left waiting.
      if (allowance == null && alive) return requoteSoon();
      return render();
    }
    busy = null;
    if (!alive) return;
    allowance = d.current;
    if (d.kind === 'none') return render();
    busy = 'Checking with BNB Chain…';
    render();
    try {
      const prepared = await prepareCall(r0, { from: w.state.address, ...approveTx(a) });
      busy = null;
      render();
      const ok = await confirmIdentity(app, { title: `Allow ${short(a, RSFIRO_BSC)}`, detail: `PancakeSwap may then move exactly ${amt(a, RSFIRO_BSC)} for your swap, nothing more. Network fee about ${fee(prepared.fees.likely)}.`, cta: 'Allow' });
      // Left while it was asked: nothing is sent.
      if (!ok || !alive) return render();
      busy = 'Checking your balance…';
      render();
      // What the permission and the swap need, read again now (after the password): a permission for
      // a swap that can no longer happen would pay its fee for nothing (lib/eth/short_now.js).
      const why = await shortNow(w, 'bsc', { asset: RSFIRO_BSC, amount: a, fees: BigInt(prepared.tx.gasLimit) * BigInt(prepared.tx.maxFeePerGas) + (gasFor('sell') ?? 0n), feeName: "the permission's and the sale's network fees" });
      if (!alive) return;
      if (why) {
        busy = null;
        put(msg, notice('error', `Nothing was sent. ${why}`));
        return render();
      }
      // A permission sent meanwhile (the outbox read again, right before signing): followed, never a
      // second one paid for; one already in effect needs none (second audit, XP, as on Ethereum).
      busy = 'Checking with BNB Chain…';
      render();
      await w.reloadOutbox().catch(() => {});
      const meanwhile = await earlierApproval();
      if (!alive) return;
      if (meanwhile) {
        busy = null;
        approving = meanwhile;
        render();
        waitApproval();
        return;
      }
      const again = await decision(a, r0);
      if (!alive) return;
      allowance = again.current;
      if (again.kind === 'none') {
        busy = null;
        return render();
      }
      busy = 'Sending the permission…';
      render();
      const r = await signAndBroadcastCall(app, r0, prepared.tx, { kind: 'approve', asset: RSFIRO_BSC, amount: a, extra: { spender: PANCAKE.smartRouter } }, { ethId: w.ethId, kv: w.kv });
      await w.reloadOutbox().catch(() => {});
      busy = null;
      // Refused or not, it is followed below: a refusing server may have passed it on first.
      approving = r.entry;
      if (r.entry.refusedAt) put(msg, refusedPermission(r.entry));
      render();
      waitApproval();
    } catch (e) {
      busy = null;
      put(msg, notice('error', `Nothing was sent. ${e instanceof SendError ? e.message : e.message || e}`));
      render();
    }
  }

  async function waitApproval() {
    if (waiting) return;
    waiting = true;
    try {
      await followApprovalLoop();
    } finally {
      waiting = false;
    }
  }

  /**
   * A followed permission that will not take effect, in words, from its settled state (release audit
   * 0.1.5): what is known, never more; and the next step from the allowance as just read (Swap when
   * PancakeSwap may already move this amount, Allow again otherwise).
   */
  function permissionGone(state) {
    const a = amountState().value;
    const words = bnbPermissionGoneWords(state, { enough: a != null && allowance != null && allowance >= a });
    const n = notice(state === 'used' ? 'warn' : 'error', h('strong', { text: words[0] }), words[1]);
    n.dataset.testid = 'pcs-approve-gone';
    n.dataset.state = state;
    return n;
  }

  async function followApprovalLoop() {
    while (alive && approving) {
      await new Promise((r) => setTimeout(r, PASS_MS));
      if (!alive || !app.dbPass || !approving) return;
      // The server in use now: one picked from the notice below takes effect at once (S2).
      rpc = w.rpcFor('bsc');
      const r1 = rpc;
      const owner = w.state.address;
      const hash = approving.hash;
      // Its receipt first (refused by BNB Chain, replaced, never sent: each said as it is), then the
      // chain's own word at one block (lib/eth/send.js approvalPass, lookAtApproval).
      const r = await approvalPass({
        rpc: r1,
        entry: approving,
        owner,
        allowance: (b) => routerAllowance(r1, owner, b),
        follow: async (e) => {
          const x = await followOnce(app, r1, e, { ethId: w.ethId, kv: w.kv, others: () => w.otherRpcs('bsc') });
          await w.reloadOutbox().catch(() => {});
          return x;
        },
        settle: (e) => settleEntry(e),
        current: () => w.state.outbox.find((x) => x.hash === hash) || null,
        // Seen in effect without a receipt: kept with the entry, so later decisions wait for that block.
        remember: (b) => updateOutbox(app, hash, { seenInEffectAt: b }, { ethId: w.ethId, kv: w.kv }).then(() => w.reloadOutbox()).catch(() => {}),
      });
      if (!alive) return;
      if (r.kind === 'effect') {
        if (r.allowance != null) allowance = r.allowance;
        approving = null;
        put(msg);
        render();
        return;
      }
      if (r.kind === 'gone') {
        approving = null;
        if (r.allowance != null) allowance = r.allowance;
        put(msg, permissionGone(r.state));
        render();
        return;
      }
      approving = r.entry || approving;
      if (r.kind === 'waiting') {
        if (r.receiptsRefused)
          put(
            msg,
            receiptsRefusedNotice(app, 'bsc', {
              what: 'the permission',
              testid: 'pcs-approve-receipts-refused',
              onSwitched: () => {
                rpc = w.rpcFor('bsc');
              },
            }),
          );
        else if (r.unsure)
          // Its server says its place was taken but shows nothing: it may still go through, and stays
          // followed (one rule: "used" is never concluded while this is so).
          put(msg, notice('warn', "Don't allow it again yet. Your BNB Chain server says another transaction from this wallet took this permission's place, but it can't show that transaction, so the permission may still go through. This updates by itself."));
        else if (approving.state === 'signed' && approving.refusedAt) put(msg, refusedPermission(approving));
        else put(msg); // on its way: no doubt left to show
      }
      render();
    }
  }

  async function review() {
    put(msg);
    busy = 'Checking the price again…';
    render();
    let q = quote;
    let prepared;
    let tx;
    let deadline;
    try {
      if (Date.now() - quotedAt > FRESH_MS) {
        q = await quoteSwap(rpc, { side: draft.side, amountIn: q.amountIn });
        quote = q;
        quotedAt = Date.now();
      }
      const minimum = minOut(q.amountOut, DEFAULT_SLIPPAGE_BIPS);
      deadline = Math.floor(Date.now() / 1000) + DEADLINE_SEC;
      tx = buildSwap({ side: draft.side, amountIn: q.amountIn, minAmountOut: minimum, recipient: w.state.address, deadline });
      prepared = await prepareCall(rpc, { from: w.state.address, ...tx });
    } catch (e) {
      busy = null;
      put(msg, e instanceof SendError || e instanceof PancakeError ? notice('error', e.message) : e instanceof EthRpcError ? serverProblem(app, e, { chain: 'bsc', retry: review, switched: () => review() }) : notice('error', `Couldn't build the swap: ${e.message} Nothing was sent.`));
      return render();
    }
    // The minimum comes from this one server's price: asked again of another listed server first.
    busy = 'Checking the price with a second server…';
    render();
    const side = draft.side;
    const check = await secondOpinion({ chainKey: 'bsc', chosenId: rpc.host.id, mine: q.amountOut, quoteOn: (other) => quoteSwap(other, { side, amountIn: q.amountIn }).then((x) => x.amountOut) });
    if (!alive) return;
    busy = null;
    render();
    const hash = await reviewSheet(q, prepared, check, deadline);
    // Its status screen, from this screen only: someone who moved on stays where they are.
    if (hash && alive) {
      app.bscSwapDraft = null;
      app.go('ethTx', { hash, chain: 'bsc', justSent: true }, { replace: true });
    }
  }

  /**
   * Why a reviewed swap would fail if signed now, or null: less than DEADLINE_MARGIN_SEC of its
   * deadline left, or a fresh simulation that reverts or needs more gas than it carries (XS).
   */
  async function staleSwap(prepared, deadline) {
    if (deadline != null && deadline - Date.now() / 1000 < DEADLINE_MARGIN_SEC) return 'This review waited too long: BNB Chain would cancel the swap and keep its network fee.';
    try {
      const fresh = await prepareCall(rpc, { from: w.state.address, to: prepared.tx.to, data: prepared.tx.data, value: prepared.tx.value });
      if (fresh.gas > BigInt(prepared.tx.gasLimit)) return 'The swap now needs more network fee than this review showed.';
      return null;
    } catch (e) {
      if (e instanceof SendError && e.code === 'would_fail') return 'BNB Chain would refuse this swap now, most often because the price moved past your protection since this review.';
      if (e instanceof SendError) return e.message;
      return `Couldn't check the swap again just before signing: ${e.message || 'BNB Chain did not answer.'}`;
    }
  }

  /** What leaves, what comes, the network fee; then Face ID / password, sign, send. Resolves to the hash or null. */
  function reviewSheet(q, prepared, check = null, deadline = null) {
    const p = pay();
    const r = receive();
    const minimum = minOut(q.amountOut, DEFAULT_SLIPPAGE_BIPS);
    let error = null;
    let sending = false;
    let asking = false; // the password is being asked
    // Two servers more than 2% apart on the price, or no second server to compare with: the swap waits for the person's tick (P13).
    let gapAck = !priceAckNeeded(check);
    const second = secondOpinionWords(check, { server: rpc.host.name, amount: (v) => short(v, r) });
    return new Promise((resolve) => {
      const sheet = openSheet((close, rerender) => {
        const secondView = () => {
          const status = check ? check.status : 'unchecked';
          if (second.kind === 'ok') return [h('p', { class: 'small', 'data-testid': 'pcs-review-second', 'data-status': status, text: second.text })];
          const n = notice(second.kind === 'warn' ? 'warn' : 'info', second.text);
          n.dataset.testid = 'pcs-review-second';
          n.dataset.status = status;
          if (!second.ack) return [n];
          const box = h('input', { type: 'checkbox', 'data-testid': 'pcs-review-second-ack', checked: gapAck });
          box.addEventListener('change', () => {
            gapAck = box.checked;
            rerender();
          });
          return [n, h('label', { class: 'check-row' }, box, h('span', { text: second.ack }))];
        };
        const go = async () => {
          // One swap from one review: taken from the first tap, before the password (two taps
          // opened two password sheets, and two swaps went: release verification 0.1.8).
          if (sending || asking || !gapAck) return;
          asking = true;
          rerender();
          const ok = await confirmIdentity(app, { title: 'Confirm the swap', detail: `${amt(q.amountIn, p)} for at least ${short(minimum, r)}`, cta: 'Confirm' });
          asking = false;
          if (sheet.closed) return;
          if (!ok) return rerender();
          sending = true;
          error = null;
          rerender();
          // Built when this review opened: it may have waited near its deadline, or the price moved
          // past its minimum since. Either way BNB Chain would cancel it and keep its fee: its deadline
          // is checked and it is simulated again now, and nothing is signed if it would fail (second
          // audit, XS).
          const stale = await staleSwap(prepared, deadline);
          if (sheet.closed) return;
          if (stale) {
            sending = false;
            error = `Nothing was sent. ${stale} Tap Change for a fresh price.`;
            return rerender();
          }
          try {
            const res = await signAndBroadcastCall(app, rpc, prepared.tx, { kind: 'swap', asset: p, amount: q.amountIn, extra: { tokenOut: r.address, tokenOutSymbol: r.symbol, quotedOut: String(q.amountOut), minimumOut: String(minimum), venue: 'pancakeswap' } }, { ethId: w.ethId, kv: w.kv });
            await w.reloadOutbox().catch(() => {});
            // Sent, or refused by a server that may have passed it on first: the status screen follows
            // it either way and says which ("Not sent yet" until it knows), never "nothing was sent" too soon.
            close(res.entry.hash);
          } catch (e) {
            sending = false;
            error = `Nothing was sent. ${e.message}`;
            rerender();
          }
        };
        return [
          h('h2', { text: 'Check before swapping' }),
          h(
            'div',
            { class: 'card review-amounts' },
            h('div', { class: 'review-line' }, ethBadge(p), h('div', { class: 'grow' }, h('div', { class: 'small', text: 'You pay' }), h('div', { class: 'big', 'data-testid': 'pcs-review-pay', text: amt(q.amountIn, p) }), h('div', { class: 'small', text: `+ the network fee, about ${fee(prepared.fees.likely)} (at most ${coinMaxText(prepared.fees.upTo, 'bsc')})` }))),
            h('div', { class: 'review-line' }, ethBadge(r), h('div', { class: 'grow' }, h('div', { class: 'small', text: 'You receive about' }), h('div', { class: 'big', 'data-testid': 'pcs-review-receive', text: short(q.amountOut, r) }))),
            notice('success', h('strong', { 'data-testid': 'pcs-review-minimum', text: `You receive at least ${short(minimum, r)}. BNB Chain enforces this. ` }), 'If the price moves more than 1% first, the swap is cancelled and only the network fee is spent.'),
          ),
          h('div', { class: 'card' }, kv('Network', 'BNB Chain'), kv('Where', 'PancakeSwap v3, rsFIRO/WBNB pool (1% fee)'), kv('Goes to', 'This wallet')),
          ...secondView(),
          r === RSFIRO_BSC ? notice('info', 'rsFIRO is FIRO on BNB Chain: public like everything there, not your private FIRO balance.') : null,
          error ? notice('error', error) : null,
          h('button', { class: 'btn btn-primary', onclick: go, disabled: sending || asking || !gapAck, 'data-testid': 'pcs-review-swap' }, sending ? 'Swapping…' : `Swap ${short(q.amountIn, p)}`),
          h('button', { class: 'btn btn-text', onclick: () => close(null), disabled: sending || asking, 'data-testid': 'pcs-review-change' }, 'Change'),
        ];
        // Never closed by a tap beside it: while it swaps, that offered the same swap again.
      }, { label: 'Check before swapping', dismissable: false });
      sheet.then((v) => resolve(typeof v === 'string' ? v : null));
    });
  }

  payInput.addEventListener('input', () => {
    draft.amount = payInput.value;
    requoteSoon();
  });

  const tabs = chainTabs('bsc', (k) => k === 'ethereum' && app.go('ethSwap', { pay: 'ETH', receive: 'rsFIRO' }, { replace: true }), { testid: 'swap-chain' });
  const rsNote = h('p', { class: 'small', 'data-testid': 'pcs-rsfiro-note', text: 'rsFIRO is FIRO on BNB Chain, carried there by the Rosen bridge: public like everything on BNB Chain, not your private FIRO balance.' });
  const el = screen(
    {
      title: draft.side === 'sell' ? 'Sell rsFIRO' : 'Buy rsFIRO',
      back: () => {
        app.bscSwapDraft = null;
        app.back('ethHome');
      },
      cls: 'swap sticky-actions',
    },
    params.step2 ? h('p', { class: 'step', 'data-testid': 'swap-step2', text: 'Step 2 of 2 · BNB to rsFIRO' }) : null,
    tabs,
    h('p', { class: 'small', text: "Straight to PancakeSwap's own contracts on BNB Chain, priced through your BNB Chain server. No middleman." }),
    h(
      'div',
      { class: 'swap-pair' },
      h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: 'You pay' }), h('div', { class: 'swap-line' }, payInput, payTag), paySub),
      flipBtn,
      h('div', { class: 'card swap-box' }, h('div', { class: 'swap-label', text: 'You receive' }), h('div', { class: 'swap-line' }, getAmount, getTag)),
    ),
    notesBox,
    rsNote,
    msg,
    h('div', { class: 'actions' }, reason, cta),
  );

  (async () => {
    try {
      w = await openWallet(app);
    } catch (e) {
      put(msg, notice('error', `The wallet could not be opened: ${e.message}`));
      return;
    }
    if (!alive) return;
    if (!w) return app.go('ethStart');
    rpc = w.rpcFor('bsc');
    // Read the balances again on every visit (as the Uniswap swap does): BNB that arrived since the
    // last read would otherwise show as "Not enough BNB" until the app is reloaded. The last known
    // figures show meanwhile.
    if (w.chain('bsc').checkedAt != null) render();
    await w.refreshChain('bsc', { fresh: true }).catch(() => {});
    // What transactions still on their way hold is taken off (and a sale of rsFIRO holds the next):
    // those mined since the last look are settled first, never taken off twice.
    if (w.state.outbox.some((e) => isOpen(e) && entryChain(e) === 'bsc')) await w.followOpen().catch(() => {});
    if (!alive) return;
    render();
    try {
      // The allowance as the one decision reads it (never a lagging backend's figure: a brief wrong
      // "Allow"); when it cannot be read yet, "Checking the rsFIRO permission…" and the price's read asks again.
      [fees, allowance] = await Promise.all([walletFees(rpc), freshAllowance().catch(() => null)]);
    } catch (e) {
      problem = serverProblem(app, e, { chain: 'bsc', retry: () => app.go('ethSwapBsc', {}, { replace: true }), switched: () => app.go('ethSwapBsc', {}, { replace: true }) });
    }
    // A permission sent earlier and still on its way (this screen left and opened again): followed
    // here when selling, and "Allow" is not offered a second time (release audit 0.1.5, S1).
    await followEarlier();
    if (!alive) return;
    if (amountState().value != null) requoteSoon();
    else render();
  })();
  render();

  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(timer);
    },
  };
}

