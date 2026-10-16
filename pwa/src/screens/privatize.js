/* Privatize
 * Spec: ONE job: move the public (transparent) balance into the private (Spark) one.
 *       Primary CTA: "Privatize <amount> FIRO" (then Face ID / password).
 *       Taps from app open: 1 (Home's "Privatize" on the public line), 2 to confirm.
 * Exit-intent reasons and answers:
 *   - "What does it do?" -> one sentence: it moves your public FIRO into your private balance,
 *     where nobody can follow it.
 *   - "What does it cost?" -> the network fee, as the wallet works it out, before anything moves.
 *   - "Can I choose how much?" -> all of it, as Campfire does: coins left public stay traceable.
 *   - "Nothing to privatize?" -> says so, with the way back.
 *   - "The connection dropped: did it go?" -> never "nothing was moved" then (audit FM-1): the
 *     status screen says it may have left and follows it.
 *   - "I went back while it was privatizing" -> one payment at a time (lib/payment_flight.js): opened
 *     again meanwhile, it says the last payment is still being sent and offers nothing; a run left
 *     before the password never opens it; one left after it is said where the person is, never by
 *     taking them to its status screen (release verification 0.1.8).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, textButton, toast, holdTaps } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { sendOutcome, UNSURE_TITLE } from '../lib/send_outcome.js';
import { paymentInFlight, startPayment, onPaymentFlight, IN_FLIGHT_TEXT, IN_FLIGHT_NOTE } from '../lib/payment_flight.js';

export default function privatize(app) {
  const body = h('div', { class: 'stack' }); // spaced as Review's content: the notices never touch
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary('Privatize', go, { disabled: true, 'data-testid': 'privatize-confirm' });
  const actions = h('div', { class: 'actions' });
  let fee = null;
  let feeFor = null;
  let feeFailed = false; // the last estimate failed: asked again on a tap, not in a loop (audit L1)
  let quoted = null; // {amount, fee, total} as shown: exactly what is moved
  let busy = false;
  let alive = true; // false once the screen is left (destroy)

  /** The fee, estimated as a payment of the whole public balance to this wallet's Spark address. */
  async function estimate(amount) {
    if (feeFor === amount || !wallet.state.receive.spark || !wallet.state.sync.canSend) return;
    feeFor = amount;
    try {
      const q = await wallet.quote({ from: 'public', to: [{ address: wallet.state.receive.spark, amount }], subtractFee: true });
      if (feeFor === amount) {
        fee = q.fee;
        quoted = { amount, fee: q.fee, total: q.total };
      }
    } catch {
      if (feeFor === amount) {
        fee = null;
        quoted = null;
        // Asked again on the next tap (audit L1: every tap after one failure said "working out the
        // fee" and asked nothing, until the screen was opened again).
        feeFor = null;
        feeFailed = true;
      }
    }
    render();
  }

  function render() {
    if (!alive) return;
    // A payment from another screen (or this one, opened again) still being sent: nothing new until it has left.
    const other = !busy && Boolean(paymentInFlight());
    const pub = wallet.state.balance.public;
    const avail = pub.available;
    const sync = wallet.state.sync;
    if (avail <= 0n) {
      put(body, h('div', { class: 'card empty', 'data-testid': 'privatize-empty' }, icon('privatize'), h('p', { text: pub.pending > 0n ? `${formatAmount(pub.pending)} ${UNIT} is arriving publicly. You can privatize it once it is confirmed.` : 'Your public balance is empty: there is nothing to privatize.' })));
      put(actions, primary('Back to Home', () => app.go('home'), { 'data-testid': 'privatize-home' }));
      return;
    }
    if (fee == null && !feeFailed) estimate(avail);
    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    put(
      body,
      h('p', { class: 'center small', text: 'Move from public to private' }),
      h('div', { class: 'big-amount', 'data-testid': 'privatize-amount', text: `${formatAmount(avail)} ${UNIT}` }),
      h(
        'div',
        { class: 'card' },
        kv('From', 'Your public balance', 'privatize-from'),
        kv('To', 'Your private balance', 'privatize-to'),
        kv('Network fee', fee != null ? `${formatAmount(fee)} ${UNIT}, taken from the amount` : 'Taken from the amount', 'privatize-fee'),
        fee != null ? kv('Arrives privately', `${formatAmount(avail - fee)} ${UNIT}`, 'privatize-gets') : null,
      ),
      notice('success', 'Public FIRO can be followed on the blockchain by anyone. Once private, nobody can see how much you have or where it goes.'),
      sync.canSend ? null : notice('warn', `${sync.title}. ${sync.detail}`),
      other ? h('div', { 'data-testid': 'privatize-in-flight' }, notice('info', IN_FLIGHT_NOTE)) : null,
      feeFailed && fee == null ? h('div', { 'data-testid': 'privatize-fee-failed' }, notice('warn', "The network fee couldn't be worked out just now. Tap Privatize to try again.")) : null,
      msg,
    );
    cta.textContent = other ? IN_FLIGHT_TEXT : `Privatize ${formatAmount(avail)} ${UNIT}`;
    cta.disabled = busy || other || !sync.canSend;
    put(actions, cta, textButton('Not now', () => app.back('home'), { 'data-testid': 'privatize-cancel' }));
  }

  async function go() {
    const avail = wallet.state.balance.public.available;
    if (avail <= 0n || busy || paymentInFlight()) return;
    // Only what was shown, with its fee: no fee worked out yet (or for another amount), nothing is moved.
    if (!quoted || quoted.amount !== avail) {
      feeFailed = false;
      estimate(avail);
      return put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('info', 'Working out the network fee first. Check it, then privatize.')));
    }
    const shown = quoted;
    busy = true;
    cta.disabled = true;
    put(msg);
    const ok = await confirmIdentity(app, { title: 'Confirm privatizing', detail: `All ${formatAmount(avail)} ${UNIT} of your public balance into your private balance.`, cta: 'Confirm' });
    // Left while the password was asked: nothing is moved.
    if (!alive) return;
    if (!ok) {
      busy = false;
      return render();
    }
    // Another payment took the one place meanwhile: this one waits for it (release verification 0.1.8).
    const release = startPayment('privatize');
    if (!release) {
      busy = false;
      render();
      put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('info', 'Your last payment is still being sent, so nothing was moved. Privatize once it has left.')));
      return;
    }
    cta.textContent = 'Privatizing…';
    const amount = shown.amount - shown.fee;
    try {
      const r = await wallet.privatize(shown.amount, { subtractFee: true, expect: { fee: shown.fee, total: shown.total } });
      // Its status screen, from this screen only: someone who moved on stays where they are.
      if (alive) app.go('txStatus', { txid: r.txid, kind: 'privatize', amount, fee: shown.fee }, { replace: true });
      else toast(`Privatizing ${formatAmount(amount)} ${UNIT}: it shows in Activity.`, 6000);
    } catch (e) {
      // "Nothing was moved" only when the engine says so (FM-1); a privatizing that may have gone
      // through is followed on its status screen (the engine's half).
      const out = sendOutcome(e);
      if (out.kind === 'unsure') {
        if (alive) app.go('txStatus', { txid: out.txid, kind: 'privatize', unsure: true, amount, fee: shown.fee }, { replace: true });
        else toast(`${UNSURE_TITLE} Follow it in Activity.`, 8000);
        return;
      }
      if (e && e.code === 'fee-changed') {
        // Nothing was built: the new figures are worked out and shown, and the person decides.
        if (!alive) return toast('The network fee changed, so nothing was moved. Open Privatize to check the new figures.', 8000);
        busy = false;
        fee = null;
        feeFor = null;
        quoted = null;
        render();
        put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('warn', 'The network fee or your public balance changed, so nothing was moved. Check the new figures, then privatize.')));
        return;
      }
      const words = out.kind === 'not-sent' ? `Nothing was moved: ${e.message || e}` : `Firo PWA couldn't tell whether it went through: ${e.message || e} Look in Activity before you privatize again.`;
      if (!alive) return toast(words, 8000);
      busy = false;
      render();
      put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('error', words)));
    } finally {
      release();
    }
  }

  const off = wallet.onChange(() => !busy && render());
  const offFlight = onPaymentFlight(() => !busy && render());
  render();
  const el = screen({ title: 'Privatize', back: () => app.back('home') }, body);
  el.appendChild(actions);
  // Home's Privatize sits where this screen's button is: the second tap of a double tap is held.
  const hold = holdTaps(el);
  return {
    el,
    destroy: () => {
      alive = false;
      hold.stop();
      off();
      offFlight();
    },
  };
}
