/* A payment's details: what else can be done with it (below Activity's details card)
 * Spec: ONE job of the details stays "see exactly what happened"; these are its secondary actions:
 *       the saved contact (or "Save to contacts") and the explorer link. None is dominant.
 *       Taps from app open: 2 to a payment (Activity -> payment), 3 for any of these.
 * Exit-intent reasons and answers:
 *   - "Is it really on the blockchain?" -> the explorer link, a plain link the person taps; the
 *     app fetches nothing from the explorer. A private payment shows little there, and the line
 *     under the link says so.
 *   - "Who was that?" -> the contact's name, or one tap to save the address as a contact.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { textButton } from '../lib/ui.js';
import { txExplorerUrl } from '../lib/payments.js';
import { contactNameFor, looksLikeAddress } from '../lib/contacts.js';
import { contactForm } from './contacts.js';

/** "Alice · Rent": what a list row says under its title, past the date (contact, memo). */
export function rowExtra(t) {
  const name = t.counterparty ? contactNameFor(t.counterparty) : null;
  return [name, t.memo].filter(Boolean).join(' · ');
}

/** The explorer link for a transaction id (the explorer chosen in Settings), with what it can show. */
export function explorerLink(txid, explorerId) {
  let url = null;
  try {
    url = txExplorerUrl(txid, explorerId);
  } catch {
    url = null;
  }
  if (!url) return null;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = 'the explorer';
  }
  return h(
    'div',
    { class: 'explorer-link' },
    h('a', { class: 'btn btn-text', href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'tx-explorer' }, icon('external'), 'See it on a block explorer'),
    h('p', { class: 'small center', text: `Opens ${host} in your browser. A private payment shows there without its amount or addresses.` }),
  );
}

/** The extras under a payment's details card. ctx: {close} of the sheet. */
export function paymentExtras(app, t, { close }) {
  const out = [];
  out.push(explorerLink(t.txid, app.prefs && app.prefs.explorer));
  const other = t.direction === 'self' ? null : t.counterparty;
  if (other && looksLikeAddress(other)) {
    const name = contactNameFor(other);
    out.push(
      name
        ? h('p', { class: 'small center', 'data-testid': 'tx-contact' }, icon('person', 'inline-icon'), ` ${t.direction === 'in' ? 'From' : 'To'} your contact ${name}`)
        : textButton(h('span', {}, 'Save to contacts'), () => {
            contactForm(app, { address: other }).then((c) => c && close());
          }, { 'data-testid': 'tx-save-contact' }),
    );
  }
  return out;
}
