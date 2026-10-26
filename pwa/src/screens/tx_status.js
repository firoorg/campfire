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
import { t, tk } from '../lib/i18n.js';

/**
 * Under "may have left": when Activity says it did not. The engine decides only on Firo nodes'
 * positive word (backend._notOnNetwork), not by a clock (release re-audit R1-7).
 */
export const UNSURE_NOTE = tk('The Firo node did not answer. If the payment did not leave, Activity says so once two Firo nodes confirm they do not have it.');

export default function txStatus(app, p) {
  if (!p || !p.txid) {
    queueMicrotask(() => app.go('home', {}, { replace: true }));
    return { el: h('div') };
  }
  const body = h('div', { class: 'status-body' });
  const privatizing = p.kind === 'privatize';
  const naming = p.kind === 'spark-name';

  function render() {
    const tx = wallet.state.txs.find((tx) => tx.txid === p.txid) || null;
    const done = tx && !isPendingTx(tx);
    // The broadcast had no answer (p.unsure): in doubt until the engine sees it on the network.
    const dropped = Boolean(tx && tx.dropped);
    const letGo = dropped && Boolean(tx.letGo);
    // The node in use says it never left, with no second node to check it for an hour (RE3-3).
    const offer = Boolean(tx && tx.oneNode) && !dropped && !done;
    const checking = !offer && Boolean(p.unsure) && !dropped && !done && (!tx || tx.unsure);
    const title = letGo
      ? t('Let go')
      : dropped
      ? naming
        ? t('@{name} was not registered', { name: p.name })
        : privatizing
          ? t('Not privatized')
          : t('Not sent')
      : checking || offer
        ? naming
          ? t('Checking @{name}…', { name: p.name })
          : privatizing
            ? t('Checking the privatizing…')
            : t('Checking your payment…')
        : naming
          ? done
            ? t('@{name} is yours', { name: p.name })
            : p.renew
              ? t('Renewing @{name}…', { name: p.name })
              : t('Registering @{name}…', { name: p.name })
          : privatizing
            ? done
              ? t('Privatized')
              : t('Privatizing…')
            : done
              ? t('Payment confirmed')
              : t('Payment sent');
    const kv = (k, v, extra = {}) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', ...extra, text: v }));
    put(
      body,
      h('div', { class: `status-icon ${done ? 'ok' : 'wait'}` }, icon(done ? 'check' : dropped ? 'alert' : 'clock')),
      h('h2', { class: 'title center', 'data-testid': 'tx-title', 'data-done': String(Boolean(done)), 'data-state': letGo ? 'let-go' : dropped ? 'dropped' : offer ? 'one-node' : checking ? 'unsure' : done ? 'done' : 'pending', text: title }),
      h('div', { class: 'big-amount', text: `${formatAmount(p.amount)} ${UNIT}` }),
      h(
        'div',
        { class: 'card' },
        naming ? kv(t('For'), (p.renew ? t('@{name} (renewal)', { name: p.name }) : `@${p.name}`)) : privatizing ? kv(t('From'), t('Your public balance')) : kv(t('To'), p.name ? `@${p.name}` : shorten(p.address, 10, 8), { class: p.name ? 'v' : 'v mono' }),
        naming ? kv(t('Paid to'), t("Firo's community fund")) : null,
        privatizing ? kv(t('To'), t('Your private balance')) : kv(t('From'), p.from === 'public' ? t('Your public balance') : t('Your private balance')),
        naming && !p.fee ? null : kv(t('Network fee'), `${formatAmount(p.fee)} ${UNIT}`),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Transaction ID') }), h('button', { class: 'v mono btn-text', 'data-testid': 'tx-id', onclick: () => copyText(p.txid, t('Transaction ID copied')), text: shorten(p.txid, 10, 8) })),
        tx && tx.confirmations > 0 ? kv(t('Confirmations'), String(tx.confirmations)) : null,
      ),
      letGo
        ? h('div', { 'data-testid': 'tx-let-go' }, notice('info', t(LET_GO_DONE)))
        : dropped
        ? h('div', { 'data-testid': 'tx-dropped' }, notice('info', t('It did not go through: the Firo network does not have it, so nothing left your wallet. You can send it again.')))
        : offer
          ? h('div', { class: 'stack', 'data-testid': 'tx-one-node' }, letGoOffer(tx), secondary(t('See it in Activity'), () => app.go('activity', { txid: p.txid }), { 'data-testid': 'tx-unsure-activity' }))
          : checking
          ? h(
              'div',
              { class: 'stack', 'data-testid': 'tx-unsure' },
              notice('warn', h('strong', { text: t("Your payment may have left. Don't send it again yet: Firo PWA is checking.") })),
              notice('info', t(UNSURE_NOTE)),
              secondary(t('See it in Activity'), () => app.go('activity', { txid: p.txid }), { 'data-testid': 'tx-unsure-activity' }),
            )
          : done
            ? notice('success', privatizing ? t('Your coins are private now: spend them from your private balance.') : t('It is in a block on the Firo blockchain.'))
            : notice('info', privatizing ? t('It moves to your private balance once it is in a block, usually within 5 minutes. You can close the app meanwhile.') : t('It is on its way: it shows as confirmed once it is in a block, usually within 5 minutes. You can close the app meanwhile.')),
      dropped ? null : explorerLink(p.txid, app.prefs && app.prefs.explorer),
    );
  }

  const off = wallet.onChange(render);
  render();
  // Done stays in sight however long the status grows (a payment in doubt says more).
  const el = screen({ title: naming ? t('Spark name') : privatizing ? t('Privatize') : t('Payment'), actions: [primary(t('Done'), () => app.go('home'), { 'data-testid': 'tx-done' })], cls: 'sticky-actions' }, body);
  return { el: el, destroy: off };
}
