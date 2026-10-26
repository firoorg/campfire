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
import { t, tk, lazyWords, asSentence } from '../lib/i18n.js';

/** In words, what a kind of address means for privacy. */
let reviewSeq = 0; // the ids Send gives each Review

export const ADDRESS_WORDS = Object.freeze({
  spark: lazyWords({ label: tk('Spark address'), hint: tk('Private: the amount, you and the receiver stay hidden on the blockchain.') }),
  transparent: lazyWords({ label: tk('Public address'), hint: tk('Public (transparent): anyone can see what arrives at this address.') }),
  exchange: lazyWords({ label: tk('Exchange address'), hint: tk('An exchange address takes payments from your public balance only, so this one goes from Public.') }),
});

export default function send(app) {
  const draft = (app.sendDraft = app.sendDraft || { address: '', amount: '', memo: '', from: 'private', subtractFee: false });
  if (draft.from !== 'public') draft.from = 'private';
  let check = { state: 'empty' }; // empty | checking | ok | bad ; ok: {kind, address, name?}
  let checkSeq = 0;
  let quote = null; // {fee, total, change, warnings} for the current form
  let quoteErr = null;
  let quoteSeq = 0;

  const addr = h('textarea', { class: 'input mono', rows: 3, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: t('Paste a Firo address, or a Spark name like @alice'), 'aria-label': t('Address or Spark name'), 'data-testid': 'send-address' });
  addr.value = draft.address;
  const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'paste' }, icon('paste'), t('Paste'));
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

  const fromBox = h('div', { class: 'segmented from-pick', role: 'radiogroup', 'aria-label': t('Pay from') });
  const fromNote = h('div');
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t('Amount'), 'data-testid': 'send-amount' });
  amount.value = draft.amount;
  const maxBtn = h('button', { class: 'btn btn-secondary btn-small inside', type: 'button', 'data-testid': 'max' }, t('Max'));
  const amountHint = h('p', { class: 'hint' });
  const feeBox = h('div', { class: 'card flat' });
  const warnBox = h('div');
  const syncMsg = h('div');
  const cta = primary(t('Review payment'), review, { disabled: true, 'data-testid': 'review' });

  // What the From picker last showed: built again only when that changes (a tap must not land on a
  // button replaced under it while the wallet syncs).
  let fromShown = '';

  function renderFrom() {
    const b = wallet.state.balance;
    const checking = b.private.checking ?? 0n;
    const pp = wallet.state.privateProof;
    const pct = pp ? Math.min(99, Math.floor((pp.done / pp.total) * 100)) : null;
    // Home counts private FIRO one node showed (owner, 2026-10-21); it is sent only once a second node
    // confirmed it: said here, so the smaller figure is not a surprise.
    put(
      fromNote,
      draft.from === 'private' && checking > 0n
        ? h('p', { class: 'hint', 'data-testid': 'from-checking', text: (pct != null ? t('{amount} FIRO more can be sent once a second Firo node has checked it ({pct}% done).', { amount: formatAmount(checking), pct }) : t('{amount} FIRO more can be sent once a second Firo node has checked it.', { amount: formatAmount(checking) })) })
        : null,
    );
    const key = JSON.stringify([draft.from, String(b.private.available), String(b.public.available), check.kind === 'exchange']);
    if (key === fromShown) return;
    fromShown = key;
    const opt = (id, label, avail) =>
      h(
        'button',
        { type: 'button', class: `seg${draft.from === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(draft.from === id), 'data-testid': `from-${id}`, disabled: check.kind === 'exchange' && id === 'private', onclick: () => setFrom(id) },
        h('span', { class: 'seg-t' }, icon(id === 'private' ? 'spark' : 'eye'), label),
        h('span', { class: 'seg-s', text: `${formatAmount(avail)} ${UNIT}` }),
      );
    put(fromBox, opt('private', t('Private'), b.private.available), opt('public', t('Public'), b.public.available));
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
      setHint(t("This isn't a Firo address or a Spark name. Copy it again from the person you're paying."), 'bad');
      return evaluate();
    }
    if (c.kind === 'spark-name') {
      check = { state: 'checking' };
      setHint(t('Looking up @{name}…', { name: c.name }));
      evaluate();
      try {
        // Checked with a second server, and against the address this wallet paid the name before.
        const r = await wallet.resolveSparkNameForPayment(c.name, { acceptChange: acceptNameChange === c.name.toUpperCase() });
        if (seq !== checkSeq) return;
        if (r) {
          check = { state: 'ok', kind: 'spark', address: r.address, name: c.name, checked: r.checked };
          setHint((r.checked === 'one-server' ? t('@{name} is a Spark name for {address} (only one Firo node could confirm it). {hint}', { name: c.name, address: shorten(r.address, 10, 8), hint: t(ADDRESS_WORDS.spark.hint) }) : t('@{name} is a Spark name for {address}. {hint}', { name: c.name, address: shorten(r.address, 10, 8), hint: t(ADDRESS_WORDS.spark.hint) })), r.checked === 'one-server' ? '' : 'good');
        } else {
          check = { state: 'bad' };
          setHint(t('No one has the Spark name @{name}. Check the spelling, or ask for their address.', { name: c.name }), 'bad');
        }
      } catch (e) {
        if (seq !== checkSeq) return;
        check = { state: 'bad' };
        if (e && e.code === 'name-changed') {
          setHint(t('@{name} now points to a different address than the one you paid before. Names can be re-registered after they expire, or a server can lie: check with the person before paying.', { name: c.name }), 'bad');
          put(
            nameBox,
            h(
              'div',
              { class: 'card', 'data-testid': 'name-changed' },
              h('p', { class: 'small', text: t('Before') }),
              h('p', { class: 'mono small wrap', 'data-testid': 'name-before', text: e.before }),
              h('p', { class: 'small', text: t('Now') }),
              h('p', { class: 'mono small wrap', 'data-testid': 'name-now', text: e.now }),
              h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'name-accept-new', onclick: () => ((acceptNameChange = c.name.toUpperCase()), validate()) }, t('They confirmed it: pay the new address')),
            ),
          );
        } else if (e && e.code === 'name-conflict') {
          setHint(e.message, 'bad');
        } else {
          setHint(t('Couldn\'t look up @{name}: {message} Type it again to retry.', { name: c.name, message: e.message }), 'bad');
        }
      }
      return evaluate();
    }
    // Rosen's lock: FIRO paid to it without the bridge's details is lost (public audit, P12).
    if ((c.address || a) === LOCK.firo) {
      check = { state: 'bad' };
      setHint(t("This is Rosen Bridge's lock address. FIRO sent to it by a plain payment, without the bridge's details, is lost. To move FIRO to Ethereum or BNB Chain, use Bridge."), 'bad');
      return evaluate();
    }
    check = { state: 'ok', kind: c.kind, address: c.address || a };
    const own = a === wallet.state.receive.spark || a === wallet.state.receive.transparent;
    if (c.kind === 'exchange' && draft.from !== 'public') {
      draft.from = 'public';
      draft.subtractFee = false;
    }
    setHint(`${ADDRESS_WORDS[c.kind].label}. ${ADDRESS_WORDS[c.kind].hint}${own ? t(' It is one of your own addresses.') : ''}`, 'good');
    evaluate();
  }

  function amountValue() {
    if (!amount.value.trim()) return { amt: null, err: null };
    try {
      const amt = parseAmount(amount.value);
      return amt <= 0n ? { amt: null, err: t('The amount must be more than zero.') } : { amt, err: null };
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
    // Home's private figure also counts FIRO one node showed (0.1.11): this is what can be sent now.
    if (!amtErr && amt != null && amt > avail) amtErr = (draft.from === 'private' ? t('That\'s more than can be sent privately now ({amount} {UNIT}).', { amount: formatAmount(avail), UNIT }) : t('That\'s more than can be sent publicly now ({amount} {UNIT}).', { amount: formatAmount(avail), UNIT }));
    if (!amtErr && quoteErr && ['insufficient', 'dust'].includes(quoteErr.code)) amtErr = quoteErr.message;
    amountHint.textContent = amtErr || (draft.subtractFee ? (draft.from === 'private' ? t('Everything in your private balance; the network fee comes out of it.') : t('Everything in your public balance; the network fee comes out of it.')) : (draft.from === 'private' ? t('Available: {amount} {UNIT} (private)', { amount: formatAmount(avail), UNIT }) : t('Available: {amount} {UNIT} (public)', { amount: formatAmount(avail), UNIT })));
    amountHint.className = 'hint' + (amtErr ? ' bad' : '');
    amount.classList.toggle('bad', Boolean(amtErr));

    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    if (quote && !amtErr) put(feeBox, kv(t('Network fee'), `${formatAmount(quote.fee)} ${UNIT}`, 'fee'), kv(draft.subtractFee ? t('They get') : t('Total'), `${formatAmount(draft.subtractFee ? quote.total - quote.fee : quote.total)} ${UNIT}`, 'send-total'));
    else put(feeBox, kv(t('Network fee'), check.state === 'ok' && amt != null && !amtErr ? t('Working it out…') : t('Shown once the address and amount are in'), 'fee'));
    put(warnBox, ...(quote && !amtErr ? quote.warnings.map((w) => notice('info', w)) : []), quoteErr && !amtErr && !['insufficient', 'dust'].includes(quoteErr.code) ? h('div', { 'data-testid': 'send-quote-error' }, notice('warn', quoteErr.message)) : null);

    const sync = wallet.state.sync;
    // A payment from Review still being sent (Back during "Sending…"): nothing new until it has left.
    const flying = Boolean(paymentInFlight());
    put(syncMsg, sync.canSend ? (flying ? h('div', { 'data-testid': 'send-in-flight' }, notice('info', t(IN_FLIGHT_NOTE))) : null) : notice('warn', `${asSentence(sync.title)}${sync.detail}`));
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

  let timer = null;
  addr.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(validate, 350);
  });
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      addr.value = text.trim();
      validate();
    } catch {
      setHint(t('Press and hold in the box, then tap Paste.'));
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
      title: t('Send'),
      back: () => {
        app.sendDraft = null;
        app.back('home');
      },
      actions: [cta],
      // Review payment stays on screen on a small phone, under the fields (visual check of 0.1.8, V1).
      cls: 'plain sticky-actions',
    },
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: t('To') }), ...pickBtns, pasteBtn), addr),
    addrHint,
    nameBox,
    contactInfo.el,
    h('div', { class: 'field' }, h('span', { text: t('From') }), fromBox, fromNote),
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: t('Amount') }), h('span', { class: 'small', text: UNIT })), h('div', { class: 'input-wrap' }, amount, maxBtn)),
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
      clearTimeout(timer);
    },
  };
}
