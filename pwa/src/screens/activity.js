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
import { t, tn, tk } from '../lib/i18n.js';

/** What kind of payment it was, in words (the engine's Tx kind). */
export const KIND_WORDS = Object.freeze({
  transparent: tk('Public payment'),
  privatize: tk('Privatize (public → private)'),
  spark: tk('Private payment (Spark)'),
  'spark-name': tk('Spark name registration'),
  lelantus: tk('From Lelantus (older private coins)'),
  coinbase: tk('Mining reward'),
  masternode: tk('Masternode payment'),
});

const FILTERS = Object.freeze([
  ['all', tk('All')],
  ['private', tk('Private')],
  ['public', tk('Public')],
]);
// A filter that shows nothing, in words (a sentence each: the kind's word changes with its language).
const NONE_OF = Object.freeze({ all: tk('No payments yet.'), private: tk('No private payments yet.'), public: tk('No public payments yet.') });

/** A payment's state in words, for its details. */
export function statusWords(item) {
  if (item.dropped && item.letGo) return t('Let go on the word of the Firo node in use');
  if (item.dropped) return t('Did not go through: nothing left your wallet');
  // The node in use says it never left, and no other node could check it for an hour (RE3-3).
  if (item.oneNode) return t('The Firo node in use says it never left');
  if (item.unsure) return t('Firo PWA is checking whether it left');
  if (item.unproven) return t('Reported by the Firo node, checking…');
  if (isPendingTx(item)) return t('Waiting for its first block');
  return tn({ one: 'Confirmed ({n} confirmation)', other: 'Confirmed ({n} confirmations)' }, item.confirmations);
}

export function matchesFilter(tx, f) {
  if (f === 'all') return true;
  const side = txSide(tx);
  return side === 'privatize' || side === f;
}

export default function activity(app, params = {}) {
  const listBox = h('div');
  const filterBox = h('div', { class: 'segmented small', role: 'radiogroup', 'aria-label': t('Show') });
  let filter = 'all';
  let opened = false;

  function renderFilter() {
    put(filterBox, ...FILTERS.map(([id, label]) => h('button', { type: 'button', class: `seg${filter === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(filter === id), 'data-testid': `filter-${id}`, onclick: () => ((filter = id), renderFilter(), render(wallet.state)) }, t(label))));
  }

  function render(s) {
    const known = s.sync.state === 'synced' || s.txsLoaded;
    const txs = s.txs.filter((item) => matchesFilter(item, filter));
    put(
      listBox,
      txs.length
        ? h('div', { class: 'card list', 'data-testid': 'activity-list' }, ...txs.map((tx) => txRow(app, tx, () => detail(tx.txid))))
        : s.txs.length
          ? h('div', { class: 'card empty' }, icon('activity'), h('p', { text: t(NONE_OF[filter]) }))
          : h('div', { class: 'card empty', 'data-testid': 'activity-empty' }, icon('activity'), h('p', { text: known ? t('No payments yet.') : t('Payments show up here once the wallet is up to date.') }), primary(t('Receive FIRO'), () => app.go('receive'), { 'data-testid': 'activity-receive' })),
    );
    if (params.txid && !opened && s.txs.some((tx) => tx.txid === params.txid)) {
      opened = true;
      detail(params.txid);
    }
  }

  function detail(txid) {
    openSheet((close) => {
      const tx2 = wallet.state.txs.find((x) => x.txid === txid);
      if (!tx2) return [h('h2', { text: t('Payment') }), h('p', { text: t('This payment is no longer in the list.') })];
      const kv = (k, v, opts = {}) => h('div', { class: 'kv', 'data-testid': opts.testid }, h('span', { class: 'k', text: k }), opts.copy ? h('button', { class: 'v mono btn-text', onclick: () => copyText(opts.copy, t('{k} copied', { k })), text: v }) : h('span', { class: `v${opts.mono ? ' mono' : ''}`, text: v }));
      const other = tx2.counterparty;
      const name = other ? contactNameFor(other) : null;
      return [
        h('h2', { 'data-testid': 'tx-detail-title', text: txTitle(tx2) }),
        h('div', { class: 'big-amount', text: `${txSign(tx2)}${formatAmount(tx2.amount)} ${UNIT}` }),
        h(
          'div',
          { class: 'card' },
          kv(t('Kind'), KIND_WORDS[tx2.kind] ? t(KIND_WORDS[tx2.kind]) : tx2.kind, { testid: 'tx-kind' }),
          kv(t('Balance'), SIDE_WORDS[txSide(tx2)]),
          kv(t('Status'), statusWords(tx2), { testid: 'tx-status' }),
          kv(t('Date'), txWhen(tx2, fmtDate) || t('Not known yet'), { testid: 'tx-date' }),
          !tx2.time && tx2.timeApprox ? h('p', { class: 'small', 'data-testid': 'tx-date-note', text: t('Found while restoring: its block is known only roughly. Settings → Exact dates for restored private payments finds it exactly.') }) : null,
          tx2.direction !== 'in' && tx2.fee > 0n && !tx2.dropped ? kv(t('Network fee'), `${formatAmount(tx2.fee)} ${UNIT}`) : null,
          other ? kv(tx2.direction === 'in' ? t('From') : t('To'), name ? `${name} · ${shorten(other, 6, 6)}` : shorten(other, 10, 8), { copy: other }) : null,
          tx2.memo ? kv(t('Memo'), tx2.memo, { testid: 'tx-memo' }) : null,
          tx2.height != null ? kv(t('Block'), tx2.height.toLocaleString('en-US')) : null,
          kv(t('Transaction ID'), shorten(tx2.txid, 10, 8), { copy: tx2.txid }),
        ),
        // One node's word for an hour: the person may let it go (release re-audit 3 RE3-3).
        letGoOffer(tx2, { onDone: () => close() }),
        ...paymentExtras(app, tx2, { close }),
        h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close')),
      ];
    }, { label: t('Payment details') });
  }

  async function csv() {
    try {
      const m = await import('../lib/tx_csv.js');
      const r = await m.saveCsv(app);
      if (r === 'empty') toast(t('No payments to save yet. They show up here once you send or receive FIRO.'), 4000);
      else if (r === 'downloaded') toast(t('Payment history saved to your downloads'), 4000);
      else if (r === 'shared') toast(t('Payment history shared'));
    } catch (e) {
      openSheet((close) => [h('h2', { text: t('Payment history') }), notice('error', t('The file could not be made: {message}', { message: e.message })), h('button', { class: 'btn btn-text', onclick: () => close() }, t('Close'))]);
    }
  }

  const off = wallet.onChange(render);
  renderFilter();
  render(wallet.state);
  // Contact names on the rows and in the details (sealed per wallet; read once per unlock).
  loadContacts(app).then(() => render(wallet.state), () => {});
  const csvBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Save payment history as a CSV file'), 'data-testid': 'activity-csv', onclick: csv }, icon('download'));
  const el = screen({ title: t('Activity'), tabs: 'activity', app, back: () => app.go('home'), right: csvBtn }, filterBox, listBox);
  return { el, destroy: () => off() };
}
