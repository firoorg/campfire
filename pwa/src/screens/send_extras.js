// Send's additions: pick a contact, scan a QR code, the line that says whose address it is (or
// that it only looks like a contact's), and the Spark memo. Kept out of send.js so that screen
// stays one job: who gets how much.
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { notice, textButton } from '../lib/ui.js';
import { toInputString } from '../lib/amount.js';
import { SPARK_MEMO_MAX } from '../lib/wallet.js';
import { cleanMemo, memoBytes } from '../lib/payments.js';
import { cachedContacts, findByAddress, lookalikeOf, loadContacts } from '../lib/contacts.js';
import { pickContact, contactForm } from './contacts.js';
import { scanAddress } from './scan_sheet.js';
import { t, tn } from '../lib/i18n.js';

/**
 * The Contacts and Scan buttons beside Paste. fill({address, amount?, memo?}) puts what was
 * picked or scanned into the form; paste() runs Paste.
 */
export function recipientButtons(app, { fill, paste }) {
  const contactsBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'send-contacts', 'aria-label': t('Pay a contact') }, icon('person'), t('Contacts'));
  const scanBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'send-scan', 'aria-label': t('Scan a QR code') }, icon('scan'), t('Scan'));
  contactsBtn.addEventListener('click', async () => {
    const c = await pickContact(app);
    if (c) fill({ address: c.address });
  });
  scanBtn.addEventListener('click', async () => {
    const r = await scanAddress({ title: t('Scan an address') });
    if (r && r.paste) return paste();
    if (r && r.address) fill(r);
  });
  return [contactsBtn, scanBtn];
}

/** The amount a scanned "firo:" link carried, as the amount field writes it. */
export const scannedAmount = (r) => (r && typeof r.amount === 'bigint' ? toInputString(r.amount) : r && typeof r.amount === 'string' ? r.amount : null);

/**
 * Under the address: "Alice (your contact)", a warning when it only looks like a contact's
 * address, or "Save as a contact" for a checked address that is new.
 */
export function contactLine(app, { onSaved = () => {} } = {}) {
  const el = h('div', { class: 'contact-line', 'data-testid': 'send-contact-line' });
  let last = '';
  let lastState = {};
  loadContacts(app).then(() => update(last, lastState), () => {});
  function update(address, { ok = false } = {}) {
    last = address;
    lastState = { ok };
    const list = cachedContacts();
    if (!address || !list) return put(el);
    const c = findByAddress(list, address);
    if (c) return put(el, h('p', { class: 'hint good', 'data-testid': 'send-contact-name' }, icon('person', 'inline-icon'), t(' {name} · your contact', { name: c.name })));
    const look = lookalikeOf(list, address);
    if (look) return put(el, h('div', { 'data-testid': 'send-lookalike' }, notice('warn', h('strong', { text: t('Not {name}\'s saved address. ', { name: look.name }) }), t('It starts and ends like it ({address}) but the middle differs. Check it with {name} before sending.', { address: shorten(look.address, 6, 6), name: look.name }))));
    if (!ok) return put(el);
    put(el, textButton(h('span', {}, t('Save as a contact')), async () => {
      const saved = await contactForm(app, { address });
      if (saved) {
        update(address, lastState);
        onSaved(saved);
      }
    }, { class: 'btn btn-text btn-inline-left', 'data-testid': 'send-save-contact' }));
  }
  return { el, update };
}

/**
 * The Spark memo: folded behind "Add a memo" until used (one less field to read on the way to
 * Review), open when the draft has one; only a payment to a Spark address can carry one
 * (setAllowed). draft.memo holds it.
 */
export function memoField(draft) {
  const input = h('input', { class: 'input', type: 'text', maxlength: String(SPARK_MEMO_MAX), autocomplete: 'off', placeholder: t('e.g. Rent for March'), 'aria-label': t('Memo'), 'data-testid': 'send-memo' });
  input.value = draft.memo || '';
  const BASE = tn({ one: 'Encrypted: only the receiver can read it. Up to {n} character in English; a letter of another script, or an emoji, counts as 2 to 4.', other: 'Encrypted: only the receiver can read it. Up to {n} characters in English; a letter of another script, or an emoji, counts as 2 to 4.' }, SPARK_MEMO_MAX);
  const hint = h('p', { class: 'hint', 'data-testid': 'send-memo-hint', text: BASE });
  // Counted as the Spark library counts it: in bytes. Over the limit, what will be cut is said (PN).
  const sayLength = () => {
    const over = memoBytes(input.value.trim()) > SPARK_MEMO_MAX;
    hint.textContent = over ? t('Too long for a memo: it will be cut to "{memo}".', { memo: cleanMemo(input.value) }) : BASE;
    hint.className = over ? 'hint bad' : 'hint'; // i18n-ignore: class names
  };
  const field = h('label', { class: 'field' }, t('Memo (optional)'), input);
  const open = h('div', { class: draft.memo ? '' : 'hidden', 'data-testid': 'send-memo-box' }, field, hint);
  const opener = textButton(h('span', {}, t('Add a memo for the receiver')), () => {
    opener.classList.add('hidden');
    open.classList.remove('hidden');
    input.focus();
  }, { class: `btn btn-text btn-inline-left${draft.memo ? ' hidden' : ''}`, 'data-testid': 'send-add-memo' });
  input.addEventListener('input', () => {
    draft.memo = input.value;
    sayLength();
  });
  sayLength();
  const el = h('div', { class: 'note-wrap' }, opener, open);
  return {
    el,
    /** Only a payment to a Spark address carries a memo: the field hides for anything else. */
    setAllowed(on) {
      el.classList.toggle('hidden', !on);
    },
    value: () => cleanMemo(input.value),
  };
}

/** A memo as it is sent (lib/payments.js): printable, single spaces, at most SPARK_MEMO_MAX bytes. */
export { cleanMemo };
