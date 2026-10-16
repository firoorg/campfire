/* Get a Spark name (Spark names -> Get a Spark name; or Renew on one of yours)
 * Spec: ONE job: make @yourname point to your private address (or keep it yours longer).
 *       Primary CTA: "Get @name for N FIRO" / "Renew @name for N FIRO" (then Face ID / password).
 *       Taps from app open: 3 (☰ -> Spark names -> Get a Spark name), then type, then confirm.
 * Exit-intent reasons and answers:
 *   - "Is it taken?" -> checked as you type against the full list of names (no question about the
 *     name you type goes to the server).
 *   - "What does it cost?" -> the price by length and years, before anything moves; it is paid
 *     from the private balance to Firo's community fund, plus the network fee.
 *   - "Who can see it?" -> said plainly: a name is public, anyone can look up the address it points
 *     to (not your balance or payments).
 *   - "I don't have enough private FIRO" -> says how much is needed, with Privatize.
 *   - "I went back while it was registering" -> one payment at a time (lib/payment_flight.js): the
 *     button is off until the engine knows what became of it, and a registration of the same name
 *     still on its way is said and not paid for again; a run left before the password never opens
 *     it, and one left after it is said where the person is (release verification 0.1.8).
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, textButton, toast, holdTaps } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet, isPendingTx } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { isNotYet } from '../lib/chain.js';
import { UNSURE_TITLE, sendOutcome } from '../lib/send_outcome.js';
import { paymentInFlight, startPayment, onPaymentFlight, IN_FLIGHT_TEXT, IN_FLIGHT_NOTE } from '../lib/payment_flight.js';

const NAME_RE = /^[a-zA-Z0-9.-]{1,20}$/;
const SAT = 100000000n;

/**
 * This wallet's registration (or renewal) of `name` still on its way: sent, not in a block yet, and
 * not known to have failed. The full list of names has it only once it is mined, so until then
 * "@name is free" would offer to pay for it again.
 */
export function pendingRegistration(name, txs) {
  const n = `@${String(name).toLowerCase()}`;
  return (txs || []).find((t) => t && t.kind === 'spark-name' && !t.dropped && isPendingTx(t) && String(t.counterparty || '').toLowerCase() === n) || null;
}

export default function nameRegister(app, params = {}) {
  const renewing = typeof params.renew === 'string' ? params.renew : null;
  let busy = false;
  let alive = true; // false once the screen is left (destroy)
  let checkSeq = 0;
  let free = renewing ? true : null; // null: not checked yet
  const msg = h('div', { 'aria-live': 'polite' });
  const status = h('p', { class: 'small', 'data-testid': 'name-status', 'aria-live': 'polite' });
  const input = h('input', { class: 'input', type: 'text', placeholder: 'alice', maxlength: '20', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', 'data-testid': 'name-input', value: renewing ?? '', disabled: Boolean(renewing) });
  const years = h('select', { class: 'input', 'data-testid': 'name-years' }, ...Array.from({ length: 10 }, (_, i) => h('option', { value: String(i + 1), text: i === 0 ? '1 year' : `${i + 1} years` })));
  const info = h('textarea', { class: 'input', rows: '2', maxlength: '1024', placeholder: 'Optional: a short public note shown with your name', 'data-testid': 'name-info' });
  const price = h('div', { class: 'stack', 'data-testid': 'name-price' });
  const cta = primary(renewing ? 'Renew' : 'Get name', go, { disabled: true, 'data-testid': 'name-confirm' });

  const name = () => input.value.trim().replace(/^@/, '');
  const yearCount = () => Number(years.value) || 1;
  /** The fields of a registration under way are off: what was confirmed is what is paid. */
  const lockFields = (on) => {
    input.disabled = on;
    years.disabled = on;
    info.disabled = on;
  };
  const priceSats = () => BigInt(wallet.nameFeeFiro(name(), yearCount())) * SAT;
  // The network fee, worked out for exactly this name, these years and this note, shown and pinned
  // at payment (audit L7: it was never shown, and whatever it came out at was paid).
  const quoteKey = (n, y, note) => `${renewing ? 'renew' : 'new'}|${n.toLowerCase()}|${y}|${note}`;
  const quotes = new Map(); // key -> {fee, total} (BigInt), as shown
  let quoteFailed = null; // key whose quote failed
  let quoteShort = null; // key whose quote said the private balance cannot pay it with its fee (N9)
  let quoteSeq = 0;
  let quoteTimer = null;
  let asking = null; // the key a quote is being asked for
  const quoteFor = (k) => quotes.get(k) || null;
  function askQuote(k, n, y, note) {
    clearTimeout(quoteTimer);
    const seq = ++quoteSeq;
    asking = k;
    quoteTimer = setTimeout(async () => {
      try {
        const q = await wallet.quoteName({ name: n, years: y, additionalInfo: note, renew: Boolean(renewing) });
        quotes.set(k, q);
        if (seq === quoteSeq) quoteFailed = null;
      } catch (e) {
        if (seq === quoteSeq) {
          if (e && e.code === 'insufficient') quoteShort = { k, have: wallet.state.balance.private.available };
          else quoteFailed = k;
        }
      }
      if (seq === quoteSeq) {
        asking = null;
        render();
      }
    }, 0); // the name is checked 300 ms after typing, the note rendered 300 ms after it: already settled
  }

  function render() {
    if (!alive) return;
    const n = name();
    const valid = NAME_RE.test(n);
    // Another payment still being sent, or this very name's registration on its way: not paid again.
    const other = !busy && Boolean(paymentInFlight());
    const onItsWay = !busy && valid ? pendingRegistration(n, wallet.state.txs) : null;
    const kv = (k, v, t) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': t, text: v }));
    if (!n) status.textContent = 'Letters, digits, dots and dashes; up to 20.';
    else if (!valid) status.textContent = 'Only letters, digits, dots and dashes, up to 20.';
    else if (free === null) status.textContent = 'Checking…';
    // Its registration on its way: the names list does not have it yet, but it is not "free" to this wallet.
    else status.textContent = renewing ? `@${n} is yours.` : onItsWay ? `@${n} is being registered for you.` : free ? `@${n} is free.` : `@${n} is taken. Try another.`;
    status.className = `small ${valid && free === false ? 'error-text' : ''}`;
    const ok = valid && free === true;
    if (ok) {
      const cost = priceSats();
      const yearly = wallet.nameFeeFiro(n, 1);
      const k = quoteKey(n, yearCount(), info.value.trim());
      // The price alone, or with its network fee (second audit N9: affordable without the fee, the
      // quote failed and the screen said only that the fee could not be worked out).
      // Short with the fee at this balance; the balance changed, it is asked again.
      if (quoteShort && quoteShort.have !== wallet.state.balance.private.available) quoteShort = null;
      const enough = wallet.state.balance.private.available >= cost && !(quoteShort && quoteShort.k === k);
      const q = quoteFor(k);
      if (!q && enough && !busy && quoteFailed !== k && asking !== k) askQuote(k, n, yearCount(), info.value.trim());
      const feeText = q ? `${formatAmount(q.fee)} ${UNIT}` : quoteFailed === k ? "Couldn't be worked out just now" : enough ? 'Working it out…' : '—';
      put(
        price,
        // What is under way first: the price no longer matters while it is (and its link stays in view).
        onItsWay ? h('div', { 'data-testid': 'name-on-its-way' }, notice('info', `Your ${renewing ? 'renewal' : 'registration'} of @${n} is on its way: it shows here once it is in a block, usually within minutes. Paying again now would pay twice.`), textButton('See it in Activity', () => app.go('activity', { txid: onItsWay.txid }))) : null,
        other && !onItsWay ? h('div', { 'data-testid': 'name-in-flight' }, notice('info', IN_FLIGHT_NOTE)) : null,
        h('div', { class: 'card' }, kv('Price', `${formatAmount(BigInt(yearly) * SAT)} ${UNIT} a year`, 'name-yearly'), kv('Network fee', feeText, 'name-fee'), kv('Total', q ? `${formatAmount(q.total)} ${UNIT}` : `${formatAmount(cost)} ${UNIT} + network fee`, 'name-total'), kv('Paid to', "Firo's community fund", 'name-to'), kv('From', 'Your private balance', 'name-from')),
        enough ? null : h('div', { 'data-testid': 'name-short' }, notice('warn', `You need ${formatAmount(cost)} ${UNIT} plus the network fee in your private balance; you have ${formatAmount(wallet.state.balance.private.available)} ${UNIT}.`), wallet.state.balance.public.available > 0n ? textButton('Privatize your public FIRO', () => app.go('privatize')) : null),
      );
      // Off while it is on its way: the button says so, never offers the payment it holds back.
      cta.textContent = other ? IN_FLIGHT_TEXT : onItsWay ? `${renewing ? 'Renewing' : 'Registering'} @${n}…` : `${renewing ? 'Renew' : 'Get'} @${n} for ${formatAmount(cost)} ${UNIT}`;
      cta.disabled = busy || other || Boolean(onItsWay) || !enough || !wallet.state.sync.canSend || (!q && quoteFailed !== k);
    } else {
      put(price);
      cta.textContent = renewing ? 'Renew' : 'Get name';
      cta.disabled = true;
    }
  }

  async function check() {
    if (renewing) return render();
    const n = name();
    free = null;
    render();
    if (!NAME_RE.test(n)) return;
    const seq = ++checkSeq;
    try {
      const r = await wallet.nameIsFree(n);
      if (seq === checkSeq) free = r;
    } catch (e) {
      if (seq === checkSeq) {
        free = null;
        put(msg, notice('error', `Could not check the name: ${e.message}`));
      }
    }
    if (seq === checkSeq) render();
  }

  let t = null;
  input.addEventListener('input', () => {
    put(msg);
    // The last answer was about another name: until this one is checked, it is unknown.
    if (!renewing) {
      free = null;
      checkSeq++;
    }
    clearTimeout(t);
    t = setTimeout(check, 300);
    render();
  });
  years.addEventListener('change', render);
  info.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(render, 300);
  });

  async function go() {
    const n = name();
    if (busy || !NAME_RE.test(n) || free !== true || paymentInFlight() || pendingRegistration(n, wallet.state.txs)) return;
    // What is confirmed is what is paid: the years and the note as they are now (the fields are off
    // from here; a list behind the password sheet changed meanwhile pays nothing more — audit X).
    const y = yearCount();
    const note = info.value.trim();
    const cost = BigInt(wallet.nameFeeFiro(n, y)) * SAT;
    // Only what was shown, network fee included: none worked out yet (or it failed), it is asked now.
    const shown = quoteFor(quoteKey(n, y, note));
    if (!shown) {
      quoteFailed = null;
      askQuote(quoteKey(n, y, note), n, y, note);
      return put(msg, h('div', { 'data-testid': 'name-error' }, notice('info', 'Working out the network fee first. Check it, then confirm.')));
    }
    busy = true;
    lockFields(true);
    cta.disabled = true;
    put(msg);
    if (!renewing) {
      // Still free right now, by a fresh look: the answer on screen may be old (a registration of it,
      // this wallet's own included, may have been mined since) — audit of 0.1.8, X8.
      let still;
      try {
        still = await wallet.nameIsFree(n);
      } catch (e) {
        if (!alive) return;
        busy = false;
        lockFields(false);
        render();
        return put(msg, h('div', { 'data-testid': 'name-error' }, notice('error', `Could not check @${n} just now: ${e.message || e} Nothing was paid.`)));
      }
      if (!alive) return;
      if (still !== true) {
        free = still;
        busy = false;
        lockFields(false);
        render();
        return put(msg, h('div', { 'data-testid': 'name-error' }, notice('info', `@${n} is taken now, so nothing was paid.`)));
      }
    }
    const ok = await confirmIdentity(app, { title: renewing ? `Renew @${n}` : `Get @${n}`, detail: `${formatAmount(cost)} ${UNIT} from your private balance to Firo's community fund, plus a network fee of ${formatAmount(shown.fee)} ${UNIT}. Anyone can look up which address @${n} points to.`, cta: 'Confirm' });
    // Left while the password was asked: nothing is paid.
    if (!alive) return;
    if (!ok) {
      busy = false;
      lockFields(false);
      return render();
    }
    if (yearCount() !== y || info.value.trim() !== note) {
      busy = false;
      lockFields(false);
      render();
      return put(msg, h('div', { 'data-testid': 'name-error' }, notice('info', 'The years or the note changed after you confirmed, so nothing was paid. Check them, then confirm again.')));
    }
    // Another payment took the one place meanwhile: this one waits for it (release verification 0.1.8).
    const release = startPayment('name');
    if (!release) {
      busy = false;
      lockFields(false);
      render();
      put(msg, h('div', { 'data-testid': 'name-error' }, notice('info', 'Your last payment is still being sent, so nothing was paid. Try again once it has left.')));
      return;
    }
    cta.textContent = renewing ? 'Renewing…' : 'Registering…';
    const status = (txid, extra = {}) => ({ txid, kind: 'spark-name', name: n, renew: Boolean(renewing), amount: cost, fee: 0n, from: 'private', ...extra });
    try {
      const expect = { fee: shown.fee, total: shown.total };
      const r = renewing ? await wallet.renewName({ name: n, years: y, expect }) : await wallet.registerName({ name: n, years: y, additionalInfo: note, expect });
      // Its status screen, from this screen only: someone who moved on stays where they are.
      if (alive) app.go('txStatus', status(r.txid), { replace: true });
      else toast(`${renewing ? 'Renewing' : 'Registering'} @${n}: it shows in Activity.`, 6000);
    } catch (e) {
      if (e && e.code === 'unsure' && e.txid) {
        // It may have left (audit FM-1): never "Nothing was paid"; followed on the status screen.
        if (alive) app.go('txStatus', status(e.txid, { unsure: true }), { replace: true });
        else toast(`${UNSURE_TITLE} Follow it in Activity.`, 8000);
        return;
      }
      // "Nothing was paid" only when the engine says so with its code (lib/send_outcome.js, R-2).
      const words = isNotYet(e) ? 'Registering names is not in this version yet.' : sendOutcome(e).kind === 'not-sent' ? `Nothing was paid: ${e.message || e}` : `Firo PWA couldn't tell whether it was paid: ${e.message || e} Look in Activity before you try again.`;
      if (!alive) return toast(words, 8000);
      busy = false;
      lockFields(false);
      // Another fee than the one shown: the new figures are shown, nothing was paid (L7).
      if (e && e.code === 'fee-changed' && e.fee != null && e.total != null) quotes.set(quoteKey(n, y, note), { fee: BigInt(e.fee), total: BigInt(e.total) });
      render();
      put(msg, h('div', { 'data-testid': 'name-error' }, notice(isNotYet(e) ? 'info' : 'error', words)));
    } finally {
      release();
    }
  }

  // The wallet changed (a new block, a registration mined): the "free" answer is asked again, at most
  // every 30 seconds, so a name this wallet just got is never offered again (X8).
  let lastLook = Date.now();
  const off = wallet.onChange(() => {
    if (busy) return;
    if (!renewing && free === true && Date.now() - lastLook > 30000) {
      lastLook = Date.now();
      check();
    } else render();
  });
  const offFlight = onPaymentFlight(() => !busy && render());
  const el = screen(
    { title: renewing ? `Renew @${renewing}` : 'Get a Spark name', back: () => app.back('names'), actions: [cta], cls: 'sticky-actions' },
    h('p', { class: 'small', text: 'People can pay @yourname instead of a long address. The name points to your private address.' }),
    h('label', { class: 'field' }, h('span', { class: 'label', text: 'Name' }), h('div', { class: 'input-prefix' }, h('span', { text: '@' }), input)),
    status,
    h('label', { class: 'field' }, h('span', { class: 'label', text: 'For' }), years),
    renewing ? null : h('label', { class: 'field' }, h('span', { class: 'label', text: 'Note (optional, public)' }), info),
    price,
    notice('info', 'A name is public: anyone can look up which address it points to. Your balance and payments stay private.'),
    msg,
  );
  render();
  if (renewing) check();
  // Renew on a name opens this ready to pay: the second tap of a double tap there is held.
  const hold = holdTaps(el);
  return {
    el,
    destroy() {
      alive = false;
      hold.stop();
      off();
      offFlight();
      clearTimeout(t);
      clearTimeout(quoteTimer);
    },
  };
}
