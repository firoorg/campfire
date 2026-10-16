/* Send
 * Spec: ONE job: say who gets how much, and from which balance.
 *       Primary CTA: "Review payment" (nothing moves until the next screen is confirmed).
 *       Taps from app open: 1 (Home -> Send), then paste + amount; Review is 2.
 * Exit-intent reasons and answers:
 *   - "Is this address right?" -> checked as you paste, with its kind in words: private (Spark),
 *     public (transparent), an exchange address, or a Spark name and the address it stands for.
 *   - "Will people see this?" -> From says Private (the default) or Public, each with what can be
 *     spent; the hint under the address says who can see what.
 *   - "Why can't I send from Private to this exchange?" -> said under the address, and From moves
 *     to Public by itself (exchanges take public payments only).
 *   - "How much will it cost?" -> the network fee and the total are shown before Review.
 *   - "Max leaves dust / fails" -> Max sends everything, the fee taken out of it.
 *   - "Why is the button grey?" -> the reason is always written next to it.
 *   - "I don't want to paste it again" -> Contacts picks a saved one, Scan reads a QR code; a
 *     checked new address can be saved as a contact. An address that only looks like a contact's
 *     is called out.
 *   - "Can I say what it's for?" -> a memo for a Spark payment, encrypted for the receiver.
 *   - "Is my last payment still going?" -> while one is being sent (Back during "Sending…"), the
 *     button is off and says so; once it has left, a form it came from is cleared, so the same
 *     payment is not offered twice (lib/payment_flight.js, release verification 0.1.8).
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { recipientButtons, contactLine, memoField, scannedAmount } from './send_extras.js';
import { paymentInFlight, onPaymentFlight, IN_FLIGHT_NOTE } from '../lib/payment_flight.js';
import { LOCK } from '../lib/rosen/lock.js';

/** In words, what a kind of address means for privacy. */
let reviewSeq = 0; // the ids Send gives each Review

export const ADDRESS_WORDS = Object.freeze({
  spark: { label: 'Spark address', hint: 'Private: the amount, you and the receiver stay hidden on the blockchain.' },
  transparent: { label: 'Public address', hint: 'Public (transparent): anyone can see what arrives at this address.' },
  exchange: { label: 'Exchange address', hint: 'An exchange address takes payments from your public balance only, so this one goes from Public.' },
});

export default function send(app) {
  const draft = (app.sendDraft = app.sendDraft || { address: '', amount: '', memo: '', from: 'private', subtractFee: false });
  if (draft.from !== 'public') draft.from = 'private';
  let check = { state: 'empty' }; // empty | checking | ok | bad ; ok: {kind, address, name?}
  let checkSeq = 0;
  let quote = null; // {fee, total, change, warnings} for the current form
  let quoteErr = null;
  let quoteSeq = 0;

  const addr = h('textarea', { class: 'input mono', rows: 3, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'Paste a Firo address, or a Spark name like @alice', 'aria-label': 'Address or Spark name', 'data-testid': 'send-address' });
  addr.value = draft.address;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'paste' }, icon('paste'), 'Paste');
  const addrHint = h('p', { class: 'hint', 'data-testid': 'address-hint' });
  // A Spark name that points somewhere new: both addresses, and paying the new one is a choice.
  const nameBox = h('div', { 'aria-live': 'polite' });
  let acceptNameChange = null; // the NAME whose new address the person accepted
  const contactInfo = contactLine(app);
  const memo = memoField(draft);
  const pickBtns = recipientButtons(app, {
    fill: (r) => {
      draft.address = r.address;
      const a = scannedAmount(r);
      if (a) {
        amount.value = draft.amount = a;
        draft.subtractFee = false;
      }
      if (r.memo) draft.memo = String(r.memo);
      app.go('send', {}, { replace: true });
    },
    paste: () => pasteBtn.click(),
  });

  const fromBox = h('div', { class: 'segmented from-pick', role: 'radiogroup', 'aria-label': 'Pay from' });
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount', 'data-testid': 'send-amount' });
  amount.value = draft.amount;
  const maxBtn = h('button', { class: 'btn btn-secondary btn-small inside', type: 'button', 'data-testid': 'max' }, 'Max');
  const amountHint = h('p', { class: 'hint' });
  const feeBox = h('div', { class: 'card flat' });
  const warnBox = h('div');
  const syncMsg = h('div');
  const cta = primary('Review payment', review, { disabled: true, 'data-testid': 'review' });

  function renderFrom() {
    const b = wallet.state.balance;
    const opt = (id, label, avail) =>
      h(
        'button',
        { type: 'button', class: `seg${draft.from === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(draft.from === id), 'data-testid': `from-${id}`, disabled: check.kind === 'exchange' && id === 'private', onclick: () => setFrom(id) },
        h('span', { class: 'seg-t' }, icon(id === 'private' ? 'spark' : 'eye'), label),
        h('span', { class: 'seg-s', text: `${formatAmount(avail)} ${UNIT}` }),
      );
    put(fromBox, opt('private', 'Private', b.private.available), opt('public', 'Public', b.public.available));
  }

  function setFrom(id) {
    if (draft.from === id) return;
    draft.from = id;
    draft.subtractFee = false;
    renderFrom();
    evaluate();
  }

  function setHint(text, cls = '') {
    addrHint.textContent = text;
    addrHint.className = `hint${cls ? ` ${cls}` : ''}`;
    addr.classList.toggle('bad', cls === 'bad');
    addr.classList.toggle('good', cls === 'good');
  }

  /** The address field, checked by the engine; a Spark name is looked up. */
  async function validate() {
    const a = addr.value.trim();
    draft.address = a;
    const seq = ++checkSeq;
    put(nameBox);
    if (!a) {
      check = { state: 'empty' };
      setHint('');
      memo.setAllowed(true);
      return evaluate();
    }
    const c = wallet.classifyAddress(a);
    if (c.kind === 'invalid') {
      check = { state: 'bad' };
      setHint("This isn't a Firo address or a Spark name. Copy it again from the person you're paying.", 'bad');
      return evaluate();
    }
    if (c.kind === 'spark-name') {
      check = { state: 'checking' };
      setHint(`Looking up @${c.name}…`);
      evaluate();
      try {
        // Checked with a second server, and against the address this wallet paid the name before.
        const r = await wallet.resolveSparkNameForPayment(c.name, { acceptChange: acceptNameChange === c.name.toUpperCase() });
        if (seq !== checkSeq) return;
        if (r) {
          check = { state: 'ok', kind: 'spark', address: r.address, name: c.name, checked: r.checked };
          setHint(`@${c.name} is a Spark name for ${shorten(r.address, 10, 8)}${r.checked === 'one-server' ? ' (only one Firo node could confirm it)' : ''}. ${ADDRESS_WORDS.spark.hint}`, r.checked === 'one-server' ? '' : 'good');
        } else {
          check = { state: 'bad' };
          setHint(`No one has the Spark name @${c.name}. Check the spelling, or ask for their address.`, 'bad');
        }
      } catch (e) {
        if (seq !== checkSeq) return;
        check = { state: 'bad' };
        if (e && e.code === 'name-changed') {
          setHint(`@${c.name} now points to a different address than the one you paid before. Names can be re-registered after they expire, or a server can lie: check with the person before paying.`, 'bad');
          put(
            nameBox,
            h(
              'div',
              { class: 'card', 'data-testid': 'name-changed' },
              h('p', { class: 'small', text: 'Before' }),
              h('p', { class: 'mono small wrap', 'data-testid': 'name-before', text: e.before }),
              h('p', { class: 'small', text: 'Now' }),
              h('p', { class: 'mono small wrap', 'data-testid': 'name-now', text: e.now }),
              h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'name-accept-new', onclick: () => ((acceptNameChange = c.name.toUpperCase()), validate()) }, 'They confirmed it: pay the new address'),
            ),
          );
        } else if (e && e.code === 'name-conflict') {
          setHint(e.message, 'bad');
        } else {
          setHint(`Couldn't look up @${c.name}: ${e.message} Type it again to retry.`, 'bad');
        }
      }
      return evaluate();
    }
    // Rosen's lock: FIRO paid to it without the bridge's details is lost (public audit, P12).
    if ((c.address || a) === LOCK.firo) {
      check = { state: 'bad' };
      setHint("This is Rosen Bridge's lock address. FIRO sent to it by a plain payment, without the bridge's details, is lost. To move FIRO to Ethereum or BNB Chain, use Bridge.", 'bad');
      return evaluate();
    }
    check = { state: 'ok', kind: c.kind, address: c.address || a };
    const own = a === wallet.state.receive.spark || a === wallet.state.receive.transparent;
    if (c.kind === 'exchange' && draft.from !== 'public') {
      draft.from = 'public';
      draft.subtractFee = false;
    }
    setHint(`${ADDRESS_WORDS[c.kind].label}. ${ADDRESS_WORDS[c.kind].hint}${own ? ' It is one of your own addresses.' : ''}`, 'good');
    evaluate();
  }

  function amountValue() {
    if (!amount.value.trim()) return { amt: null, err: null };
    try {
      const amt = parseAmount(amount.value);
      return amt <= 0n ? { amt: null, err: 'The amount must be more than zero.' } : { amt, err: null };
    } catch (e) {
      return { amt: null, err: e.message };
    }
  }

  /** Asks the engine for the fee once the form is complete (debounced); stale answers are dropped. */
  let quoteTimer = null;
  function requestQuote() {
    clearTimeout(quoteTimer);
    const { amt } = amountValue();
    const seq = ++quoteSeq;
    quote = null;
    quoteErr = null;
    if (check.state !== 'ok' || amt == null || !wallet.state.sync.canSend) return;
    quoteTimer = setTimeout(async () => {
      try {
        const q = await wallet.quote({ from: draft.from, to: [{ address: check.address, amount: amt, memo: check.kind === 'spark' ? memo.value() : '' }], subtractFee: draft.subtractFee });
        if (seq !== quoteSeq) return;
        quote = q;
      } catch (e) {
        if (seq !== quoteSeq) return;
        quoteErr = e;
      }
      render();
    }, 250);
  }

  function render() {
    const { amt, err } = amountValue();
    const avail = wallet.available(draft.from);
    let amtErr = err;
    if (!amtErr && amt != null && amt > avail) amtErr = `That's more than your ${draft.from} balance (${formatAmount(avail)} ${UNIT}).`;
    if (!amtErr && quoteErr && ['insufficient', 'dust'].includes(quoteErr.code)) amtErr = quoteErr.message;
    amountHint.textContent = amtErr || (draft.subtractFee ? `Everything in your ${draft.from} balance; the network fee comes out of it.` : `Available: ${formatAmount(avail)} ${UNIT} (${draft.from})`);
    amountHint.className = 'hint' + (amtErr ? ' bad' : '');
    amount.classList.toggle('bad', Boolean(amtErr));

    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    if (quote && !amtErr) put(feeBox, kv('Network fee', `${formatAmount(quote.fee)} ${UNIT}`, 'fee'), kv(draft.subtractFee ? 'They get' : 'Total', `${formatAmount(draft.subtractFee ? quote.total - quote.fee : quote.total)} ${UNIT}`, 'send-total'));
    else put(feeBox, kv('Network fee', check.state === 'ok' && amt != null && !amtErr ? 'Working it out…' : 'Shown once the address and amount are in', 'fee'));
    put(warnBox, ...(quote && !amtErr ? quote.warnings.map((w) => notice('info', w)) : []), quoteErr && !amtErr && !['insufficient', 'dust'].includes(quoteErr.code) ? h('div', { 'data-testid': 'send-quote-error' }, notice('warn', quoteErr.message)) : null);

    const sync = wallet.state.sync;
    // A payment from Review still being sent (Back during "Sending…"): nothing new until it has left.
    const flying = Boolean(paymentInFlight());
    put(syncMsg, sync.canSend ? (flying ? h('div', { 'data-testid': 'send-in-flight' }, notice('info', IN_FLIGHT_NOTE)) : null) : notice('warn', `${sync.title}. ${sync.detail}`));
    contactInfo.update(check.state === 'ok' && !check.name ? check.address : addr.value.trim(), { ok: check.state === 'ok' && !check.name });
    memo.setAllowed(check.state !== 'ok' || check.kind === 'spark');
    const ok = check.state === 'ok' && amt != null && !amtErr && sync.canSend && Boolean(quote) && !flying;
    cta.disabled = !ok;
    return ok ? { amount: amt } : null;
  }

  function evaluate() {
    renderFrom();
    requestQuote();
    render();
  }

  let t = null;
  addr.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(validate, 350);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      addr.value = text.trim();
      validate();
    } catch {
      setHint('Press and hold in the box, then tap Paste.');
      addr.focus();
    }
  });
  amount.addEventListener('input', () => {
    draft.amount = amount.value;
    draft.subtractFee = false;
    evaluate();
  });
  maxBtn.addEventListener('click', () => {
    const avail = wallet.available(draft.from);
    amount.value = toInputString(avail);
    draft.amount = amount.value;
    draft.subtractFee = avail > 0n;
    evaluate();
  });
  memo.el.addEventListener('input', () => requestQuote());

  function review() {
    const ok = render();
    if (!ok || !quote) return;
    // Each Review its own id: one whose payment started is never offered again (review.js).
    app.go('review', { rid: `${Date.now().toString(36)}-${(reviewSeq += 1)}`, address: check.address, name: check.name || null, checked: check.checked || null, kind: check.kind, from: draft.from, amount: ok.amount, subtractFee: draft.subtractFee, memo: check.kind === 'spark' ? memo.value() : '', quote });
  }

  // The fee is asked for only while sending is possible: once the wallet is up to date again (after
  // a sync, another node), it is asked for then, or the form waited on "Working it out…" for good.
  let couldSend = wallet.state.sync.canSend;
  const off = wallet.onChange(() => {
    renderFrom();
    const can = wallet.state.sync.canSend;
    if (can && !couldSend && !quote) requestQuote();
    couldSend = can;
    render();
  });
  // A payment started from this form ended while the form was open again: once it may have left,
  // Review cleared the form (app.sendDraft), and a fresh one is shown; otherwise the button follows.
  const offFlight = onPaymentFlight(() => {
    if (!paymentInFlight() && app.sendDraft !== draft && app.currentName === 'send') return app.go('send', {}, { replace: true });
    render();
  });
  if (draft.address) validate();
  else evaluate();

  const el = screen(
    {
      title: 'Send',
      back: () => {
        app.sendDraft = null;
        app.back('home');
      },
      actions: [cta],
      // Review payment stays on screen on a small phone, under the fields (visual check of 0.1.8, V1).
      cls: 'plain sticky-actions',
    },
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'To' }), ...pickBtns, pasteBtn), addr),
    addrHint,
    nameBox,
    contactInfo.el,
    h('div', { class: 'field' }, h('span', { text: 'From' }), fromBox),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Amount' }), h('span', { class: 'small', text: UNIT })), h('div', { class: 'input-wrap' }, amount, maxBtn)),
    amountHint,
    feeBox,
    warnBox,
    memo.el,
    syncMsg,
  );
  return {
    el,
    destroy: () => {
      off();
      offFlight();
      clearTimeout(quoteTimer);
      clearTimeout(t);
    },
  };
}
