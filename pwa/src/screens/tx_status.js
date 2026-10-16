/* Payment status (after Send or Privatize)
 * Spec: ONE job: see that the payment left, and when it is confirmed.
 *       Primary CTA: "Done".
 *       Taps from app open: 3 (right after confirming a payment).
 * Exit-intent reasons and answers:
 *   - "Did it go through?" -> live status in words: sent to the network -> confirmed in a block.
 *   - "It's taking long" -> a block comes about every 5 minutes; the app does not need to stay open.
 *   - "Where can I check it?" -> the transaction ID to copy, and the explorer link to tap.
 *   - "The connection dropped while sending: did it leave?" (unsure, audit FM-1) -> said plainly:
 *     it may have left, don't send it again yet, Campfire is checking; where to follow it
 *     (Activity); then either "Payment sent" (seen on the network) or "Not sent" (the network does
 *     not have it: nothing left, it can be sent again). Never "nothing was sent" while unsure, and
 *     no time promised (release re-audit R1-7: "within about 30 minutes" was not always true).
 *   - "It has said 'checking' for over an hour" (re-audit 3 RE3-3) -> when the node in use says it
 *     never left and no other node could check it for an hour: the person may let it go, told it
 *     is one node's word and that sending again pays twice if it did leave (let_go.js).
 */
import { h, shorten, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copyText } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet, isPendingTx } from '../lib/wallet.js';
import { explorerLink } from './payment_extras.js';
import { letGoOffer, LET_GO_DONE } from './let_go.js';

/**
 * Under "may have left": when Activity says it did not. The engine decides only on Firo nodes'
 * positive word (backend._notOnNetwork), not by a clock (release re-audit R1-7).
 */
export const UNSURE_NOTE = 'The Firo node did not answer. If the payment did not leave, Activity says so once two Firo nodes confirm they do not have it.';

export default function txStatus(app, p) {
  if (!p || !p.txid) {
    queueMicrotask(() => app.go('home', {}, { replace: true }));
    return { el: h('div') };
  }
  const body = h('div', { class: 'status-body' });
  const privatizing = p.kind === 'privatize';
  const naming = p.kind === 'spark-name';

  function render() {
    const tx = wallet.state.txs.find((t) => t.txid === p.txid) || null;
    const done = tx && !isPendingTx(tx);
    // The broadcast had no answer (p.unsure): in doubt until the engine sees it on the network.
    const dropped = Boolean(tx && tx.dropped);
    const letGo = dropped && Boolean(tx.letGo);
    // The node in use says it never left, with no second node to check it for an hour (RE3-3).
    const offer = Boolean(tx && tx.oneNode) && !dropped && !done;
    const checking = !offer && Boolean(p.unsure) && !dropped && !done && (!tx || tx.unsure);
    const title = letGo
      ? 'Let go'
      : dropped
      ? naming
        ? `@${p.name} was not registered`
        : privatizing
          ? 'Not privatized'
          : 'Not sent'
      : checking || offer
        ? naming
          ? `Checking @${p.name}…`
          : privatizing
            ? 'Checking the privatizing…'
            : 'Checking your payment…'
        : naming
          ? done
            ? `@${p.name} is yours`
            : p.renew
              ? `Renewing @${p.name}…`
              : `Registering @${p.name}…`
          : privatizing
            ? done
              ? 'Privatized'
              : 'Privatizing…'
            : done
              ? 'Payment confirmed'
              : 'Payment sent';
    const kv = (k, v, extra = {}) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', ...extra, text: v }));
    put(
      body,
      h('div', { class: `status-icon ${done ? 'ok' : 'wait'}` }, icon(done ? 'check' : dropped ? 'alert' : 'clock')),
      h('h2', { class: 'title center', 'data-testid': 'tx-title', 'data-done': String(Boolean(done)), 'data-state': letGo ? 'let-go' : dropped ? 'dropped' : offer ? 'one-node' : checking ? 'unsure' : done ? 'done' : 'pending', text: title }),
      h('div', { class: 'big-amount', text: `${formatAmount(p.amount)} ${UNIT}` }),
      h(
        'div',
        { class: 'card' },
        naming ? kv('For', `@${p.name}${p.renew ? ' (renewal)' : ''}`) : privatizing ? kv('From', 'Your public balance') : kv('To', p.name ? `@${p.name}` : shorten(p.address, 10, 8), { class: p.name ? 'v' : 'v mono' }),
        naming ? kv('Paid to', "Firo's community fund") : null,
        privatizing ? kv('To', 'Your private balance') : kv('From', p.from === 'public' ? 'Your public balance' : 'Your private balance'),
        naming && !p.fee ? null : kv('Network fee', `${formatAmount(p.fee)} ${UNIT}`),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Transaction ID' }), h('button', { class: 'v mono btn-text', 'data-testid': 'tx-id', onclick: () => copyText(p.txid, 'Transaction ID copied'), text: shorten(p.txid, 10, 8) })),
        tx && tx.confirmations > 0 ? kv('Confirmations', String(tx.confirmations)) : null,
      ),
      letGo
        ? h('div', { 'data-testid': 'tx-let-go' }, notice('info', LET_GO_DONE))
        : dropped
        ? h('div', { 'data-testid': 'tx-dropped' }, notice('info', 'It did not go through: the Firo network does not have it, so nothing left your wallet. You can send it again.'))
        : offer
          ? h('div', { class: 'stack', 'data-testid': 'tx-one-node' }, letGoOffer(tx), secondary('See it in Activity', () => app.go('activity', { txid: p.txid }), { 'data-testid': 'tx-unsure-activity' }))
          : checking
          ? h(
              'div',
              { class: 'stack', 'data-testid': 'tx-unsure' },
              notice('warn', h('strong', { text: "Your payment may have left. Don't send it again yet: Campfire is checking." })),
              notice('info', UNSURE_NOTE),
              secondary('See it in Activity', () => app.go('activity', { txid: p.txid }), { 'data-testid': 'tx-unsure-activity' }),
            )
          : done
            ? notice('success', privatizing ? 'Your coins are private now: spend them from your private balance.' : 'It is in a block on the Firo blockchain.')
            : notice('info', privatizing ? 'It moves to your private balance once it is in a block, usually within 5 minutes. You can close the app meanwhile.' : 'It is on its way: it shows as confirmed once it is in a block, usually within 5 minutes. You can close the app meanwhile.'),
      dropped ? null : explorerLink(p.txid, app.prefs && app.prefs.explorer),
    );
  }

  const off = wallet.onChange(render);
  render();
  // Done stays in sight however long the status grows (a payment in doubt says more).
  const el = screen({ title: naming ? 'Spark name' : privatizing ? 'Privatize' : 'Payment', actions: [primary('Done', () => app.go('home'), { 'data-testid': 'tx-done' })], cls: 'sticky-actions' }, body);
  return { el: el, destroy: off };
}
