/* Send on Ethereum or BNB Chain
 * Spec: ONE job: say who gets how much of a coin (ETH, BNB) or a token (rsFIRO, USDT…), on which chain.
 *       Primary CTA: "Send <amount> <symbol>" - opens the review sheet; nothing is signed before it.
 *       Taps from app open: 2 (Home -> Ethereum & BNB -> Send), then paste + amount, 3 to the review.
 *       The chain is picked for the person: the one where they hold something (Ethereum first).
 * Exit-intent reasons and answers:
 *   - "Is this address right?" -> checked as it is pasted: format, EIP-55 checksum (a mistyped
 *     character), this wallet's own address, and addresses that would swallow the coins (the zero
 *     address, token contracts) are refused in words.
 *   - "How much is the fee?" -> shown before review, in ETH or BNB, as "about"; the review adds "at most".
 *   - "Max leaves dust or fails" -> Max is the coin's balance less the most the fee can be.
 *   - "Why is the button grey?" -> the reason is always written next to it.
 *   - "Which network?" -> two tabs at the top, Ethereum and BNB Chain; the same address works on
 *     both, and the fee is paid in that chain's coin (ETH or BNB), said under the amount.
 *   - "Did my tap count twice?" -> one review at a time: the button is off from the tap until its
 *     review sheet closes, and a review prepared after the screen was left never opens (it would sign
 *     the same payment again with the next nonce: release verification 0.1.8).
 */
import { buyPayBy } from '../lib/buy/wiring.js';
import { payByState, payByText } from '../lib/pay_by.js';
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { walletFees } from '../lib/eth/rpc.js';
import { parseUnits, toInputString } from '../lib/eth/units.js';
import { tokensFor, nativeFor, tokenBySymbol, isNative } from '../lib/eth/tokens.js';
import { CHAINS, CHAIN_KEYS } from '../lib/eth/chains.js';
import { recipientProblem, prepareSend, SendError, ETH_TRANSFER_GAS } from '../lib/eth/send.js';
import { amountText, coinText, serverProblem, chainTabs, doubtNotice } from './eth_ui.js';
import { inDoubt, isOpen } from '../lib/eth/outbox.js';
import { openEthReview } from './eth_review.js';
import { scanEthAddress } from './scan_sheet.js';

/** What a token transfer usually costs in gas, for the estimate shown before the real one. */
const TYPICAL_TOKEN_GAS = 65000n;

export default function ethSend(app, params = {}) {
  const draft = (app.ethSendDraft = app.ethSendDraft || { to: '', amount: '', symbol: null, chain: null });
  if (params.chain && CHAINS[params.chain]) draft.chain = params.chain;
  const chainKey = () => draft.chain || 'ethereum';
  const chain = () => CHAINS[chainKey()];
  let w = null;
  let fees = null; // walletFees(), for the fee shown before review
  let preparing = false;
  let reviewing = false; // the review sheet is open: the button stays off until it closes
  let alive = true; // false once the screen is left (destroy)

  const addr = h('textarea', { class: 'input mono', rows: 2, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'Paste the 0x… address', 'aria-label': 'Address (0x…)', 'data-testid': 'eth-send-to' });
  addr.value = draft.to;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'eth-paste-to' }, icon('paste'), 'Paste');
  const scanBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'eth-scan-to', 'aria-label': 'Scan a QR code' }, icon('scan'), 'Scan');
  const addrHint = h('p', { class: 'hint', 'data-testid': 'eth-to-hint' });
  const assetSel = h('select', { class: 'input', 'aria-label': 'What to send', 'data-testid': 'eth-send-asset' });
  const assetField = h('label', { class: 'field hidden' }, 'What to send', assetSel);
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount', 'data-testid': 'eth-send-amount' });
  amount.value = draft.amount;
  const unitLabel = h('span', { class: 'small' });
  const maxBtn = h('button', { class: 'btn btn-secondary btn-small inside', type: 'button', 'data-testid': 'eth-max' }, 'Max');
  const amountHint = h('p', { class: 'hint', 'data-testid': 'eth-amount-hint' });
  const feeLine = h('div', { class: 'kv' });
  const msg = h('div', { 'aria-live': 'polite' });
  const lateMsg = h('div', { 'data-testid': 'eth-send-pay-by', 'aria-live': 'polite' });
  /** The deadline of the address paid: the one Buy filled in with, or, typed or pasted, a followed buy's (N11). */
  const payByFor = (to) => {
    const d = draft.payBy;
    if (d && String(d.address || '').toLowerCase() === String(to || '').trim().toLowerCase()) return d;
    return buyPayBy(app, to);
  };
  let shownLate = null;
  const doubtBox = h('div');
  const cta = primary('Send', review, { disabled: true, 'data-testid': 'eth-send-review' });

  const coin = () => nativeFor(chainKey());
  const asset = () => tokenBySymbol(draft.symbol, chainKey()) || coin();
  // What a payment may use: the balance less what transactions still on their way hold (release
  // audit 0.1.6: one built on money already promised fails on chain, its fee lost).
  const balanceOf = (a) => (w ? w.spendableOf(chainKey(), a) : null);
  const heldOf = (a) => (w ? w.heldOf(chainKey(), a) : 0n);
  const heldNote = (a) => (heldOf(a) > 0n ? ` ${amountText(heldOf(a), a)} more is held for a transaction still on its way.` : '');
  const typicalUpTo = (a) => (fees ? (isNative(a) ? ETH_TRANSFER_GAS : TYPICAL_TOKEN_GAS) * fees.maxFeePerGas : null);
  const typicalLikely = (a) => (fees ? (isNative(a) ? ETH_TRANSFER_GAS : TYPICAL_TOKEN_GAS) * (fees.baseFee + fees.maxPriorityFeePerGas) : null);
  const fee = (wei) => coinText(wei, chainKey());

  const tabsBox = h('div');
  function fillTabs() {
    put(tabsBox, chainTabs(chainKey(), (k) => pickChain(k), { testid: 'eth-send-chain' }));
  }

  function fillAssets() {
    // The coin, the tokens held, and a token asked for on purpose (a buy's deposit in USDT) even
    // while its balance is not read yet: falling back to the coin would turn "0.5 USDT" into
    // "0.5 ETH". Only a symbol that is not a token on this chain falls back.
    const list = [coin(), ...tokensFor(chainKey()).filter((t) => (balanceOf(t) ?? 0n) > 0n || t.symbol === draft.symbol)];
    put(assetSel, ...list.map((a) => h('option', { value: a.symbol, text: balanceOf(a) == null ? `${a.symbol} (balance not read yet)` : `${a.symbol} (${amountText(balanceOf(a), a)} available)` })));
    if (!list.some((a) => a.symbol === draft.symbol)) draft.symbol = coin().symbol;
    assetSel.value = draft.symbol;
    assetField.classList.toggle('hidden', list.length < 2);
  }

  /** Another chain: its coin, its balances, its fees. */
  async function pickChain(k) {
    draft.chain = k;
    draft.symbol = null;
    fees = null;
    put(msg);
    fillTabs();
    titleEl.textContent = `Send on ${chain().name}`;
    fillAssets();
    evaluate();
    if (w && w.chain(k).checkedAt == null) await w.refreshChain(k).catch(() => {});
    if (draft.chain !== k) return;
    fillAssets();
    await loadFees();
    evaluate();
  }

  async function loadFees() {
    const k = chainKey();
    try {
      const f = await walletFees(w.rpcFor(k));
      if (draft.chain === k || (!draft.chain && k === 'ethereum')) fees = f;
    } catch (e) {
      put(msg, serverProblem(app, e, { chain: k, retry: () => app.go('ethSend', { chain: k }), switched: () => app.go('ethSend', { chain: k }) }));
    }
  }

  /** An earlier transaction on this chain in doubt: nothing new is signed here until it settles (audit BM-1). */
  function doubtful() {
    const d = w ? inDoubt(w.state.outbox, chainKey())[0] || null : null;
    if ((d && d.hash) !== (doubtBox.dataset.hash || null)) {
      put(doubtBox, d ? doubtNotice(app, d) : null);
      if (d) doubtBox.dataset.hash = d.hash;
      else delete doubtBox.dataset.hash;
    }
    return d;
  }

  function evaluate() {
    const doubt = doubtful();
    const a = asset();
    unitLabel.textContent = a.symbol;
    const like = typicalLikely(a);
    put(feeLine, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v', 'data-testid': 'eth-send-fee', text: like == null ? 'Checking…' : `about ${fee(like)}` }));
    const prob = recipientProblem(addr.value, { own: w && w.state.address });
    addrHint.textContent = prob ? prob.message : addr.value.trim() ? `A 0x… address: the payment goes to it on ${chain().name}. Check the first and last characters with the receiver.` : '';
    addrHint.className = `hint${prob && prob.code !== 'empty' ? ' bad' : !prob ? ' good' : ''}`;
    addr.classList.toggle('bad', Boolean(prob && prob.code !== 'empty'));
    addr.classList.toggle('good', !prob);

    const have = balanceOf(a);
    let amt = null;
    let err = null;
    if (amount.value.trim()) {
      try {
        amt = parseUnits(amount.value, a.decimals, { symbol: a.symbol });
        if (amt <= 0n) err = 'The amount must be more than zero.';
      } catch (e) {
        err = e.message;
      }
    }
    const upTo = typicalUpTo(a);
    if (amt != null && !err && have != null) {
      const coinFree = w.spendableOf(chainKey(), coin()) ?? 0n;
      if (amt > have) err = heldOf(a) > 0n ? `That's more than you can send now (${amountText(have, a)} free).${heldNote(a)}` : `That's more than you have (${amountText(have, a)}).`;
      else if (isNative(a) && upTo != null && amt + upTo > have) err = `With the network fee that's more than you ${heldOf(a) > 0n ? 'can send now' : 'have'}. Up to ${fee(have > upTo ? have - upTo : 0n)} after the fee.${heldNote(a)}`;
      else if (!isNative(a) && upTo != null && coinFree < upTo) err = `The network fee is paid in ${coin().symbol} (about ${fee(typicalLikely(a))}), and this wallet has ${fee(coinFree)}${heldOf(coin()) > 0n ? ' free' : ''} on ${chain().name}.${heldNote(coin())}`;
    }
    amountHint.textContent = err || (have == null ? 'Checking the balance…' : `Available: ${amountText(have, a)}${heldOf(a) > 0n ? `.${heldNote(a)}` : ''}`);
    amountHint.className = `hint${err ? ' bad' : ''}`;
    amount.classList.toggle('bad', Boolean(err));
    // A Buy's address past (or near) its deadline: never paid from here (XB).
    const late = payByState(payByFor(addr.value), addr.value);
    if (late !== shownLate) {
      shownLate = late;
      put(lateMsg, late ? notice('warn', payByText(late).replace(', so nothing was sent', '')) : null);
    }
    const ok = w && !doubt && !prob && !late && amt != null && !err && have != null && !preparing && !reviewing;
    cta.disabled = !ok;
    cta.textContent = preparing ? `Checking with ${chain().name}…` : ok ? `Send ${amountText(amt, a, { approx: false })}` : 'Send';
    return ok ? { asset: a, amount: amt } : null;
  }

  async function review() {
    if (preparing || reviewing || !alive) return;
    const ok = evaluate();
    if (!ok) return;
    preparing = true;
    put(msg);
    evaluate();
    try {
      const prepared = await prepareSend(w.rpcFor(chainKey()), { from: w.state.address, asset: ok.asset, recipient: addr.value.trim(), amount: ok.amount, balances: w.spendable(chainKey()) });
      preparing = false;
      // Left while it was prepared: no review over the next screen (it would sign this payment again).
      if (!alive) return;
      reviewing = true;
      evaluate();
      openEthReview(app, w, prepared, { payBy: payByFor(prepared.recipient) }).then(() => {
        reviewing = false;
        if (alive) evaluate();
      });
    } catch (e) {
      preparing = false;
      // The review could not open (a throw on the way): Send comes back (A8b).
      reviewing = false;
      if (!alive) return;
      evaluate();
      if (e instanceof SendError) put(msg, notice('error', e.message));
      else put(msg, serverProblem(app, e, { chain: chainKey(), retry: review, switched: () => review() }));
    }
  }

  let t = null;
  addr.addEventListener('input', () => {
    draft.to = addr.value.trim();
    clearTimeout(t);
    t = setTimeout(evaluate, 200);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      addr.value = (await navigator.clipboard.readText()).trim();
      draft.to = addr.value;
      evaluate();
    } catch {
      addrHint.textContent = 'Press and hold in the box, then tap Paste.';
      addr.focus();
    }
  });
  scanBtn.addEventListener('click', async () => {
    const r = await scanEthAddress();
    if (!r) return;
    if (r.paste) return pasteBtn.click();
    addr.value = draft.to = r.to;
    const t = r.token ? tokensFor(chainKey()).find((x) => x.address === r.token.toLowerCase()) : null;
    if (t) {
      draft.symbol = t.symbol;
      assetSel.value = t.symbol;
    }
    if (r.valueWei && !r.token) {
      draft.symbol = coin().symbol;
      assetSel.value = coin().symbol;
      amount.value = draft.amount = toInputString(BigInt(r.valueWei), 18);
    }
    evaluate();
  });
  amount.addEventListener('input', () => {
    draft.amount = amount.value;
    evaluate();
  });
  assetSel.addEventListener('change', () => {
    draft.symbol = assetSel.value;
    evaluate();
  });
  maxBtn.addEventListener('click', () => {
    const a = asset();
    const have = balanceOf(a) ?? 0n;
    const upTo = isNative(a) ? typicalUpTo(a) ?? 0n : 0n;
    amount.value = toInputString(have > upTo ? have - upTo : 0n, a.decimals);
    draft.amount = amount.value;
    evaluate();
  });

  (async () => {
    w = await ethWallet(app).catch(() => null);
    if (!w) return app.go('ethHome');
    if (CHAIN_KEYS.some((k) => w.chain(k).checkedAt == null)) await w.refresh().catch(() => {});
    if (!draft.chain) {
      // The chain where there is something to send: Ethereum first.
      const holds = (k) => (w.chain(k).native ?? 0n) > 0n || [...w.chain(k).tokens.values()].some((v) => (v ?? 0n) > 0n);
      draft.chain = CHAIN_KEYS.find(holds) || 'ethereum';
      fillTabs();
      titleEl.textContent = `Send on ${chain().name}`;
    }
    fillAssets();
    evaluate();
    await loadFees();
    evaluate();
    // Balances read before a swap or a payment can be out of date: this chain is read once more, so a
    // token bought a moment ago can be sent at once (live test 2026-10-14: rsFIRO just bought on
    // Uniswap was not offered until the next refresh).
    const k = chainKey();
    await w.refreshChain(k).catch(() => {});
    // What transactions still on their way hold is taken off what can be sent: those mined since the
    // last look are settled first, so a payment already in the balance is not taken off twice.
    if (w.state.outbox.some(isOpen)) await w.followOpen().catch(() => {});
    if (draft.chain === k) {
      fillAssets();
      evaluate();
    }
  })();
  fillTabs();
  evaluate();

  const el = screen(
    {
      title: `Send on ${chain().name}`,
      back: () => {
        app.ethSendDraft = null;
        app.back('ethHome');
      },
      actions: [cta],
      cls: 'sticky-actions', // the button on screen on a small phone (V1)
    },
    tabsBox,
    doubtBox,
    assetField,
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'To' }), scanBtn, pasteBtn), addr),
    addrHint,
    lateMsg,
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Amount' }), unitLabel), h('div', { class: 'input-wrap' }, amount, maxBtn)),
    amountHint,
    h('div', { class: 'card flat' }, feeLine),
    msg,
  );
  const titleEl = el.querySelector('.topbar h1');
  return {
    el,
    destroy: () => {
      alive = false;
      clearTimeout(t);
    },
  };
}

