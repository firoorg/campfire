/* Activity
 * Spec: ONE job: see every payment and what happened to it.
 *       Primary CTA: none on the list (tap a payment for details); empty list: "Receive FIRO".
 *       Taps from app open: 1 (tab), 2 for a payment's details.
 * Exit-intent reasons and answers:
 *   - "Is my payment stuck?" -> status in words (Sending / Sent, Receiving / Received, Privatizing),
 *     with its confirmations; a block comes about every 5 minutes.
 *   - "Which of these were private?" -> each row says Private, Public, or Public → Private, and the
 *     filter shows one kind at a time.
 *   - "Proof it happened?" -> the transaction ID (copyable), the block, the fee, the explorer link.
 *   - "Nothing here" -> says why and offers Receive.
 *   - "A payment has said 'checking' for over an hour" -> when the Firo node in use says it never
 *     left and no other node could check it, its details offer to let it go (let_go.js, RE3-3).
 *   - "I need it for my accountant" -> the download button at the top: every payment as a CSV file.
 */
import { h, shorten, fmtDate, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, openSheet, primary, copyText, notice, toast } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet, txTitle, txSign, txSide, isPendingTx, SIDE_WORDS, txWhen } from '../lib/wallet.js';
import { txRow } from './home.js';
import { paymentExtras } from './payment_extras.js';
import { loadContacts, contactNameFor } from '../lib/contacts.js';
import { letGoOffer } from './let_go.js';

/** What kind of payment it was, in words (the engine's Tx kind). */
export const KIND_WORDS = Object.freeze({
  transparent: 'Public payment',
  privatize: 'Privatize (public → private)',
  spark: 'Private payment (Spark)',
  'spark-name': 'Spark name registration',
  lelantus: 'From Lelantus (older private coins)',
  coinbase: 'Mining reward',
  masternode: 'Masternode payment',
});

const FILTERS = Object.freeze([
  ['all', 'All'],
  ['private', 'Private'],
  ['public', 'Public'],
]);

/** A payment's state in words, for its details. */
export function statusWords(t) {
  if (t.dropped && t.letGo) return 'Let go on the word of the Firo node in use';
  if (t.dropped) return 'Did not go through: nothing left your wallet';
  // The node in use says it never left, and no other node could check it for an hour (RE3-3).
  if (t.oneNode) return 'The Firo node in use says it never left';
  if (t.unsure) return 'Campfire is checking whether it left';
  if (t.unproven) return 'Reported by the Firo node, checking…';
  if (isPendingTx(t)) return 'Waiting for its first block';
  return `Confirmed (${t.confirmations} confirmation${t.confirmations === 1 ? '' : 's'})`;
}

export function matchesFilter(tx, f) {
  if (f === 'all') return true;
  const side = txSide(tx);
  return side === 'privatize' || side === f;
}

export default function activity(app, params = {}) {
  const listBox = h('div');
  const filterBox = h('div', { class: 'segmented small', role: 'radiogroup', 'aria-label': 'Show' });
  let filter = 'all';
  let opened = false;

  function renderFilter() {
    put(filterBox, ...FILTERS.map(([id, label]) => h('button', { type: 'button', class: `seg${filter === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(filter === id), 'data-testid': `filter-${id}`, onclick: () => ((filter = id), renderFilter(), render(wallet.state)) }, label)));
  }

  function render(s) {
    const known = s.sync.state === 'synced' || s.txsLoaded;
    const txs = s.txs.filter((t) => matchesFilter(t, filter));
    put(
      listBox,
      txs.length
        ? h('div', { class: 'card list', 'data-testid': 'activity-list' }, ...txs.map((t) => txRow(app, t, () => detail(t.txid))))
        : s.txs.length
          ? h('div', { class: 'card empty' }, icon('activity'), h('p', { text: `No ${filter} payments yet.` }))
          : h('div', { class: 'card empty', 'data-testid': 'activity-empty' }, icon('activity'), h('p', { text: known ? 'No payments yet.' : 'Payments show up here once the wallet is up to date.' }), primary('Receive FIRO', () => app.go('receive'), { 'data-testid': 'activity-receive' })),
    );
    if (params.txid && !opened && s.txs.some((t) => t.txid === params.txid)) {
      opened = true;
      detail(params.txid);
    }
  }

  function detail(txid) {
    openSheet((close) => {
      const t = wallet.state.txs.find((x) => x.txid === txid);
      if (!t) return [h('h2', { text: 'Payment' }), h('p', { text: 'This payment is no longer in the list.' })];
      const kv = (k, v, opts = {}) => h('div', { class: 'kv', 'data-testid': opts.testid }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, `${k} copied`), text: v }) : h('span', { class: `v${opts.mono ? ' mono' : ''}`, text: v }));
      const other = t.counterparty;
      const name = other ? contactNameFor(other) : null;
      return [
        h('h2', { 'data-testid': 'tx-detail-title', text: txTitle(t) }),
        h('div', { class: 'big-amount', text: `${txSign(t)}${formatAmount(t.amount)} ${UNIT}` }),
        h(
          'div',
          { class: 'card' },
          kv('Kind', KIND_WORDS[t.kind] || t.kind, { testid: 'tx-kind' }),
          kv('Balance', SIDE_WORDS[txSide(t)]),
          kv('Status', statusWords(t), { testid: 'tx-status' }),
          kv('Date', txWhen(t, fmtDate) || 'Not known yet', { testid: 'tx-date' }),
          !t.time && t.timeApprox ? h('p', { class: 'small', 'data-testid': 'tx-date-note', text: 'Found while restoring: its block is known only roughly. Settings → Exact dates for restored private payments finds it exactly.' }) : null,
          t.direction !== 'in' && t.fee > 0n && !t.dropped ? kv('Network fee', `${formatAmount(t.fee)} ${UNIT}`) : null,
          other ? kv(t.direction === 'in' ? 'From' : 'To', name ? `${name} · ${shorten(other, 6, 6)}` : shorten(other, 10, 8), { copy: other }) : null,
          t.memo ? kv('Memo', t.memo, { testid: 'tx-memo' }) : null,
          t.height != null ? kv('Block', t.height.toLocaleString('en-US')) : null,
          kv('Transaction ID', shorten(t.txid, 10, 8), { copy: t.txid }),
        ),
        // One node's word for an hour: the person may let it go (release re-audit 3 RE3-3).
        letGoOffer(t, { onDone: () => close() }),
        ...paymentExtras(app, t, { close }),
        h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close'),
      ];
    }, { label: 'Payment details' });
  }

  async function csv() {
    try {
      const m = await import('../lib/tx_csv.js');
      const r = await m.saveCsv(app);
      if (r === 'empty') toast('No payments to save yet. They show up here once you send or receive FIRO.', 4000);
      else if (r === 'downloaded') toast('Payment history saved to your downloads', 4000);
      else if (r === 'shared') toast('Payment history shared');
    } catch (e) {
      openSheet((close) => [h('h2', { text: 'Payment history' }), notice('error', `The file could not be made: ${e.message}`), h('button', { class: 'btn btn-text', onclick: () => close() }, 'Close')]);
    }
  }

  const off = wallet.onChange(render);
  renderFilter();
  render(wallet.state);
  // Contact names on the rows and in the details (sealed per wallet; read once per unlock).
  loadContacts(app).then(() => render(wallet.state), () => {});
  const csvBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Save payment history as a CSV file', 'data-testid': 'activity-csv', onclick: csv }, icon('download'));
  const el = screen({ title: 'Activity', tabs: 'activity', app, back: () => app.go('home'), right: csvBtn }, filterBox, listBox);
  return { el, destroy: () => off() };
}
