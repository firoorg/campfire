/* Review payment
 * Spec: ONE job: confirm exactly what will happen before any money moves.
 *       Primary CTA: "Send <amount> FIRO" (then Face ID / password).
 *       Taps from app open: 2 (Home -> Send -> Review), then confirm.
 * Exit-intent reasons and answers:
 *   - "What exactly am I sending?" -> amount, receiver (contact name, Spark name or address), the kind
 *     of address, which balance pays, fee and total, in words.
 *   - "Is the fee a surprise?" -> fee and total are on this screen; the engine's figures are checked
 *     again just before sending, and the engine sends only these very figures (audit FE-3: a coin
 *     arriving during Face ID changed them): a change is shown, never sent silently.
 *   - "Who can see this?" -> one line: private or public, as it really is.
 *   - "Can I undo it?" -> said plainly: a payment cannot be taken back once sent.
 *   - "It was stopped, now what?" -> when a server's list of private coins did not check out, the
 *     error says so (the server's fault, nothing left the wallet) with one way on: Try another server.
 *   - "Did it leave? Should I tap again?" -> when the node never answered (audit FM-1), never "not
 *     sent": the payment status screen says it may have left and not to send it again yet, and
 *     follows it; this screen's button is not offered for it again. "Not sent" only when the engine
 *     says so with its code (release re-audit R-2); any other failure cannot be told apart from a
 *     payment that left: it says so, and the one button is "See it in Activity", not Send again.
 *   - "I went back while it was sending: is it gone?" -> one payment at a time (lib/payment_flight.js):
 *     Send and Review offer nothing new until the engine knows what became of it, and say so; a run
 *     whose screen was left before the password never opens it, and one left after it is said in a
 *     short message where the person is, never by taking them to another screen (release
 *     verification 0.1.8). Taps are held for a moment after the screen opens: the second tap of a
 *     double tap on "Review payment" never lands on Send.
 */
import { h, shorten, put } from '../lib/dom.js';
import { screen, primary, secondary, notice, textButton, toast, holdTaps } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { openPaymentsTo } from '../lib/open_payments.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { contactNameFor } from '../lib/contacts.js';
import { ADDRESS_WORDS } from './send.js';
import { sendOutcome, UNSURE_TITLE } from '../lib/send_outcome.js';
import { paymentInFlight, startPayment, onPaymentFlight, IN_FLIGHT_TEXT, IN_FLIGHT_NOTE } from '../lib/payment_flight.js';
import { t } from '../lib/i18n.js';

// A message ends as a sentence: its own full stop (Chinese and Japanese ones too), or a dot.
const sentence = (m) => (m && !/[.!?。！？]$/.test(m) ? `${m}.` : m);

/**
 * What Review says when wallet.send() failed: 'unsure' (with its txid) goes to the status screen;
 * 'not-sent' only when the engine says so with a code (lib/send_outcome.js); anything else may have
 * left (release re-audit R-2: an uncoded error read "not sent" while the engine still held the
 * payment): 'unknown'. -> {kind, txid?, text?}
 */
export function sendFailure(e) {
  const out = sendOutcome(e);
  if (out.kind === 'unsure') return { kind: 'unsure', txid: out.txid };
  const said = sentence(String(e && typeof e === 'object' ? e.message || '' : (e ?? '')).trim());
  if (out.kind === 'not-sent') return { kind: 'not-sent', text: /\b(not sent|nothing was sent)\b/i.test(said) ? said : t('The payment was not sent: {said} Nothing left your wallet.', { said }) };
  return { kind: 'unknown', text: (said ? t('Firo PWA couldn\'t tell whether the payment left: {said} Look in Activity before you send it again.', { said }) : t('Firo PWA couldn\'t tell whether the payment left. Look in Activity before you send it again.')) };
}

/** Who sees what, for a payment from `from` to an address of `kind`. */
export function privacyLine(from, kind) {
  if (from === 'private' && kind === 'spark') return t('Private: the amount, you and the receiver stay hidden on the blockchain.');
  if (from === 'private') return t("Your balance and history stay private; what arrives at the receiver's public address can be seen.");
  return t('Public: the amount and both addresses can be seen on the blockchain.');
}

/**
 * Reviews whose payment has started (by their params, and the id Send gives each one): Back (or any
 * way back to this very Review) after it went, or while it goes, never offers it again (audit of 0.1.8,
 * X1: a sidebar link during "Sending…", then Back, showed "Send 1 FIRO" ready, and it was sent twice).
 * Given back only when the payment certainly did not leave.
 */
const startedReviews = new WeakSet();
const startedIds = new Set();
let reviewSeq = 0; // ids for a Review opened without one
const reviewStarted = (p) => startedReviews.has(p) || (p.rid != null && startedIds.has(p.rid));
function markStarted(p, on) {
  if (on) {
    startedReviews.add(p);
    if (p.rid != null) startedIds.add(p.rid);
  } else {
    startedReviews.delete(p);
    if (p.rid != null) startedIds.delete(p.rid);
  }
}

export default function review(app, p) {
  if (!p || !p.address || p.amount == null || !p.quote) {
    queueMicrotask(() => app.go('send', {}, { replace: true }));
    return { el: h('div') };
  }
  // Its id travels with it in the history (the history keeps a copy of the params, not this object).
  if (p.rid == null) p.rid = `r${Date.now().toString(36)}-${(reviewSeq += 1)}`;
  if (reviewStarted(p)) {
    // This payment was sent from here, or is being sent: never a second time from the same Review.
    queueMicrotask(() => {
      toast(paymentInFlight() ? t(IN_FLIGHT_NOTE) : t('This payment was already sent from here. It is in Activity.'), 6000);
      app.go(paymentInFlight() ? 'send' : 'activity', {}, { replace: true });
    });
    return { el: h('div') };
  }
  let q = p.quote;
  const to = [{ address: p.address, amount: p.amount, memo: p.memo || '' }];
  // The form this payment came from: cleared once it may have left, unless the person started another.
  const draft = app.sendDraft;
  let alive = true; // false once the screen is left (destroy)
  let running = false; // this screen's Send run, from the tap until its outcome is known
  const msg = h('div', { 'aria-live': 'polite' });
  // Another payment still being sent: said in a sentence too, with what to do (the button alone is not enough).
  const flightNote = h('div', { 'aria-live': 'polite' });
  const card = h('div', { class: 'card' });
  // An earlier payment to this very address not confirmed yet: said, and paying again takes a tap (X2).
  const againBox = h('div', { 'aria-live': 'polite' });
  let againOk = false;
  const earlierTo = () => openPaymentsTo(wallet.state && wallet.state.txs, p.address);
  const gets = () => (p.subtractFee ? q.total - q.fee : p.amount);
  const label = () => t('Send {amount} {UNIT}', { amount: formatAmount(gets()), UNIT });
  // What the one button does: send, or (when a send may have left) look in Activity.
  let onCta = confirm;
  const cta = primary(label(), () => onCta(), { 'data-testid': 'confirm-send' });
  const contact = contactNameFor(p.address);
  const kind = ADDRESS_WORDS[p.kind] || ADDRESS_WORDS.transparent;
  const bigAmount = h('div', { class: 'big-amount', 'data-testid': 'review-amount' });

  const kv = (k, v, testid, cls = '') => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: `v ${cls}`.trim(), 'data-testid': testid, text: v }));
  function render() {
    bigAmount.textContent = `${formatAmount(gets())} ${UNIT}`;
    cta.textContent = label();
    put(
      card,
      p.name
        ? h(
            'div',
            { class: 'kv kv-stack' },
            h('span', { class: 'k', text: t('To') }),
            h(
              'span',
              { class: 'v list' },
              h('span', { 'data-testid': 'review-name', text: `@${p.name}` }),
              // The whole address a name points to: the name alone is only what a server says (audit D-02).
              h('span', { class: 'mono small wrap', 'data-testid': 'review-to', text: p.address }),
              h('span', { class: 'small', 'data-testid': 'review-name-checked', text: p.checked === 'two-servers' ? t('Two Firo nodes agree on this address.') : p.checked === 'own-node' ? t('Checked with your own node.') : t('Only one Firo node could confirm this address.') }),
            ),
          )
        : contact
          ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v list' }, h('span', { 'data-testid': 'review-contact', text: contact }), h('span', { class: 'mono', 'data-testid': 'review-to', text: shorten(p.address, 10, 8) })))
          : kv(t('To'), shorten(p.address, 10, 8), 'review-to', 'mono'),
      kv(t('Address'), kind.label, 'review-kind'),
      kv(t('From'), p.from === 'public' ? t('Your public balance') : t('Your private balance'), 'review-from'),
      kv(t('Network fee'), `${formatAmount(q.fee)} ${UNIT}`, 'review-fee'),
      kv(p.subtractFee ? t('Leaves your wallet') : t('Total'), `${formatAmount(q.total)} ${UNIT}`, 'review-total'),
      p.memo ? kv(t('Memo (encrypted for the receiver)'), p.memo, 'review-memo') : null,
    );
    ctaState();
  }

  /**
   * The button, from what is under way: off during this screen's own run, and while a payment from
   * any screen is still being sent ("Your last payment is still being sent…"). "See it in Activity"
   * is never held back.
   */
  function ctaState() {
    if (!alive) return;
    const sending = onCta === confirm;
    const other = sending && !running && Boolean(paymentInFlight());
    const earlier = sending && !running ? earlierTo() : [];
    const needAgain = earlier.length > 0 && !againOk;
    put(againBox, earlier.length ? againNotice(earlier) : null);
    cta.disabled = running || other || needAgain;
    put(flightNote, other ? h('div', { 'data-testid': 'review-flight-note' }, notice('info', t(IN_FLIGHT_NOTE))) : null);
    if (other) cta.textContent = t(IN_FLIGHT_TEXT);
    else if (sending && !running) cta.textContent = label();
  }

  /** What is said about earlier payments to this address, with the one way to pay it again. */
  function againNotice(earlier) {
    const e = earlier[0];
    const what = `${formatAmount(e.amount)} ${UNIT}`;
    const said = e.unsure
      ? t('A payment of {what} to this address may have left already: Firo PWA is still checking it.', { what })
      : t('You already sent {what} to this address, and it is not confirmed yet.', { what });
    return h(
      'div',
      { 'data-testid': 'review-paid-before' },
      notice('warn', h('strong', { text: t('Paid before? ') }), said, againOk ? t(' You chose to pay it again.') : t(' Look in Activity first. If you mean to pay it again, say so below.')),
      againOk
        ? null
        : h('div', { class: 'row' }, secondary(t('Pay this address again'), () => ((againOk = true), ctaState()), { 'data-testid': 'review-pay-again' }), textButton(t('See Activity'), () => app.go('activity'), { 'data-testid': 'review-see-activity' })),
    );
  }

  /**
   * The Send button: one run at a time, from the first tap (the button is off at once), and none
   * while a payment from another screen is still being sent (release verification 0.1.8).
   */
  async function confirm() {
    if (running || !alive || paymentInFlight()) return;
    // An earlier payment to this address showed up meanwhile: said first (X2).
    if (earlierTo().length && !againOk) return ctaState();
    running = true;
    ctaState();
    try {
      await confirmRun();
    } finally {
      running = false;
      ctaState();
    }
  }

  async function confirmRun() {
    if (!wallet.state.sync.canSend) {
      put(msg, notice('warn', t('{title}. Sending is paused until the wallet is up to date.', { title: wallet.state.sync.title })));
      return;
    }
    put(msg);
    // The engine's figures again, right before sending: a changed fee is shown, never sent silently.
    try {
      const fresh = await wallet.quote({ from: p.from, to, subtractFee: p.subtractFee });
      // Left meanwhile: no password sheet over the next screen, nothing sent.
      if (!alive) return;
      if (fresh.fee !== q.fee || fresh.total !== q.total) {
        q = fresh;
        render();
        put(msg, h('div', { 'data-testid': 'review-fee-changed' }, notice('warn', t('The network fee changed to {amount} {UNIT}. Check the total, then send.', { amount: formatAmount(q.fee), UNIT }))));
        return;
      }
    } catch (e) {
      if (!alive) return;
      put(msg, h('div', { 'data-testid': 'review-error' }, notice('error', t('The payment was not sent: {message} Nothing left your wallet.', { message: e.message }))));
      return;
    }
    const ok = await confirmIdentity(app, { title: t('Confirm the payment'), detail: t('{amount} {UNIT} to {value}', { amount: formatAmount(gets()), UNIT, value: p.name ? `@${p.name}` : shorten(p.address, 10, 8) }), cta: t('Confirm') });
    // Left while the password was asked (or a sheet that outlived its screen): nothing is sent.
    if (!ok || !alive) return;
    // Another payment took the one place meanwhile (a second Review): this one waits for it.
    const release = startPayment('send');
    if (!release) {
      put(msg, h('div', { 'data-testid': 'review-in-flight' }, notice('info', t('Your last payment is still being sent, so this one was not sent. Nothing left your wallet: send it once that one has left.'))));
      return;
    }
    markStarted(p, true);
    paidAs = draft ? { address: draft.address, amount: draft.amount, memo: draft.memo } : null;
    try {
      await sendIt();
    } finally {
      release();
    }
  }

  /**
   * After a payment to @name left (or may have): the address it went to is the one expected next time.
   * Never a reason to say the payment was not sent: a throw of any kind (a wallet already stopped) is
   * swallowed here (audit of 0.1.8, A8d: a synchronous throw read as "not sent").
   */
  async function pinQuietly() {
    try {
      await wallet.pinSparkName(p.name, p.address);
    } catch {
      /* the pin is a convenience: the payment's outcome stands */
    }
  }

  /**
   * Clears the form this payment came from: it may have left (never another form started since, and
   * never one the person changed meanwhile — that is a new payment being typed: audit of 0.1.8, A8c).
   */
  let paidAs = null; // the form's figures as this payment was sent
  function dropDraft() {
    if (app.sendDraft !== draft || !draft) return;
    const same = !paidAs || (draft.address === paidAs.address && String(draft.amount) === String(paidAs.amount) && (draft.memo || '') === (paidAs.memo || ''));
    if (same) app.sendDraft = null;
  }

  /** What became of a payment whose screen was left while it was sent: said where the person is now. */
  function sayLater(text, ms = 8000) {
    toast(text, ms);
  }

  async function sendIt() {
    cta.textContent = t('Sending…');
    // A private payment first checks the network's list of private coins with a second server; the
    // first one from a set can take a while, so say what it waits on.
    let said = false;
    const stop = wallet.onChange((s) => {
      if (said || !s.raw || s.raw.sending !== 'checking-coins') return;
      said = true;
      put(msg, h('div', { 'data-testid': 'review-checking-coins' }, notice('info', t('Checking the list of private coins with a second Firo node, so your payment stays private. The first private payment can take up to a minute.'))));
    });
    try {
      // The figures on this screen, or nothing: the engine refuses another plan (audit FE-3).
      const r = await wallet.send({ from: p.from, to, subtractFee: p.subtractFee, expect: { fee: q.fee, total: q.total } });
      // Paid: this is the address @name is expected to have next time.
      if (p.name) await pinQuietly();
      dropDraft();
      // Its status screen, from this screen only: someone who moved on stays where they are.
      if (alive) app.go('txStatus', { txid: r.txid, amount: gets(), fee: q.fee, address: p.address, name: p.name || null, from: p.from, kind: p.kind }, { replace: true });
      else sayLater(t('Sent {amount} {UNIT} to {value}. It is in Activity.', { amount: formatAmount(gets()), UNIT, value: p.name ? `@${p.name}` : shorten(p.address, 10, 8) }), 6000);
    } catch (e) {
      const f = sendFailure(e);
      // Certainly not sent (refused, or the fee changed before anything was built): this Review may be used again.
      if (f.kind === 'not-sent' || (e && e.code === 'fee-changed')) markStarted(p, false);
      if (f.kind === 'unsure') {
        // No answer from the node after it had the payment (audit FM-1): it may have left. Never
        // offered again from here; the status screen follows it until the engine knows.
        if (p.name) await pinQuietly();
        dropDraft();
        if (alive) app.go('txStatus', { txid: f.txid, unsure: true, amount: gets(), fee: q.fee, address: p.address, name: p.name || null, from: p.from, kind: p.kind }, { replace: true });
        else sayLater(t('{title} Follow it in Activity.', { title: t(UNSURE_TITLE) }));
        return;
      }
      if (!alive) {
        // Nothing to show here any more: what happened, where the person is now.
        if (f.kind === 'unknown') dropDraft();
        sayLater(e && e.code === 'fee-changed' ? t('The network fee changed, so your payment was not sent. Open Send to check the new figures.') : f.text);
        return;
      }
      cta.textContent = label();
      if (said) put(msg, null);
      if (e && e.code === 'fee-changed' && e.fee != null && e.total != null) {
        // Nothing was built: the new figures are shown, and the person sends them or not.
        q = { ...q, fee: e.fee, total: e.total, ...(e.change != null ? { change: e.change } : {}) };
        render();
        put(msg, h('div', { 'data-testid': 'review-fee-changed' }, notice('warn', t('The network fee changed to {amount} {UNIT}. Check the total, then send.', { amount: formatAmount(q.fee), UNIT }))));
        return;
      }
      if (f.kind === 'unknown') {
        // It may have left: not offered again from here; the person looks first (Back brings
        // Review back, ready to send, should Activity not have it).
        onCta = () => app.go('activity');
        cta.textContent = t('See it in Activity');
        put(msg, h('div', { 'data-testid': 'review-error', 'data-kind': 'unknown' }, notice('warn', f.text)));
        return;
      }
      put(
        msg,
        h(
          'div',
          { 'data-testid': 'review-error', 'data-kind': 'not-sent' },
          notice('error', f.text),
          // A server's list of private coins did not check out (audit D-09): fetched again from another.
          e && e.otherServer ? secondary(t('Try another node'), otherServer, { 'data-testid': 'review-other-server' }) : null,
        ),
      );
    } finally {
      stop();
    }
  }

  async function otherServer() {
    put(msg, notice('info', t('Connecting to another Firo node…')));
    try {
      await wallet.useAnotherServer();
      put(msg, h('div', { 'data-testid': 'review-other-server-done' }, notice('info', t('Now on another Firo node. It is sending its list of private coins; send again once your wallet says it is up to date.'))));
    } catch (e) {
      put(msg, h('div', { 'data-testid': 'review-error' }, notice('error', t('Could not move to another node: {value}', { value: e.message || e }))));
    }
  }

  // Another screen's payment ended (or started), or the wallet's payments changed: this button follows.
  const offFlight = onPaymentFlight(ctaState);
  const offWallet = wallet.onChange ? wallet.onChange(() => ctaState()) : () => {};
  render();
  const el = screen(
    { title: t('Review payment'), back: () => app.back('send'), actions: [cta, textButton(t('Change'), () => app.back('send'))] },
    h('p', { class: 'center small', text: p.subtractFee ? t('They get') : t('You send') }),
    bigAmount,
    card,
    againBox,
    h('div', { 'data-testid': 'review-privacy' }, notice(p.from === 'private' && p.kind === 'spark' ? 'success' : 'info', privacyLine(p.from, p.kind))),
    ...q.warnings.map((w) => notice('info', w)),
    flightNote,
    h('p', { class: 'small center', text: t('A payment cannot be taken back once it is sent.') }),
    msg,
  );
  // Send's "Review payment" sits where this screen's Send is: the second tap of a double tap there
  // lands on it the moment the screen opens, and must not start a payment (lib/ui.js holdTaps).
  const hold = holdTaps(el);
  return {
    el,
    destroy: () => {
      alive = false;
      hold.stop();
      offFlight();
      offWallet();
    },
  };
}
