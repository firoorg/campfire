/* Contacts (the address book)
 * Spec: ONE job: keep the people I pay (their Firo address or Spark name), so I never paste it again.
 *       Primary CTA: "Add a contact".
 *       Taps from app open: 2 (Settings -> Contacts), or 2 from Send (Contacts button) to pick one.
 * Exit-intent reasons and answers:
 *   - "Will it send to the wrong person?" -> a contact never changes by itself: the book is sealed
 *     on this device, only an edit here changes it, and an edit shows the old and the new address
 *     before saving. Picking a contact in Send shows its address too.
 *   - "Who can see my contacts?" -> nobody: kept on this phone, locked with the wallet, deleted with it.
 *   - "Is this address right?" -> the wallet checks it before it is saved (and refuses its own
 *     receive addresses); its kind is named (private Spark, public, exchange, Spark name).
 *   - "Nothing here" -> says what a contact is for, with Add a contact.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, textButton, notice, openSheet, copyText, toast, focusSoon } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { vaultFor, loadContacts, searchContacts, checkContact, cleanAddress, cleanName, NAME_MAX } from '../lib/contacts.js';
import { addressShape } from '../lib/firo_uri.js';
import { scanAddress } from './scan_sheet.js';

/** "sm1qpzr9x8g…3jn54khc": an address shortened to `edge` characters at each end (a Spark name stays whole). */
export function shortAddress(a, edge = 10) {
  const s = String(a || '');
  return s.length <= edge * 2 + 1 ? s : `${s.slice(0, edge)}…${s.slice(-edge)}`;
}

/** What kind of Firo address it is, in words. */
export function addressKindWords(a) {
  switch (addressShape(a)) {
    case 'spark':
      return 'Spark address (private)';
    case 'transparent':
      return 'Transparent address (public)';
    case 'exchange':
      return 'Exchange address (public)';
    case 'spark-name':
      return 'Spark name';
    default:
      return 'Firo address';
  }
}

/** A problem opening the sealed book, in words. Nothing is ever written over it. */
export function bookProblem(e) {
  if (e && (e.code === 'wrong_secret' || e.code === 'malformed' || e.code === 'weak'))
    return 'Your contacts on this device could not be opened, so they were left exactly as they are. Nothing was changed. Lock and unlock the wallet, then try again.';
  if (e && e.code === 'locked') return 'Unlock the wallet to see your contacts.';
  return `Your contacts could not be read just now (${(e && e.message) || 'storage error'}). Try again.`;
}

export default function contacts(app) {
  const listBox = h('div', { 'data-testid': 'contacts-list-box' });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search by name or address', 'aria-label': 'Search contacts', autocomplete: 'off', 'data-testid': 'contacts-search' });
  const searchBox = h('div', { class: 'hidden' }, search);
  let all = null;
  let problem = null;

  async function load() {
    try {
      all = await loadContacts(app);
      problem = null;
    } catch (e) {
      all = null;
      problem = e;
    }
    render();
  }

  function render() {
    if (problem) return put(listBox, notice('error', bookProblem(problem)), secondary('Try again', load));
    if (!all) return put(listBox, h('div', { class: 'card empty' }, h('div', { class: 'spinner' }), h('p', { text: 'Opening your contacts…' })));
    searchBox.classList.toggle('hidden', all.length < 8);
    if (!all.length)
      return put(
        listBox,
        h('div', { class: 'card empty', 'data-testid': 'contacts-empty' }, icon('person'), h('p', { text: 'No contacts yet.' }), h('p', { class: 'small', text: 'Save the people you pay with their Firo address or Spark name. Then pick them in Send instead of pasting.' })),
      );
    const shown = searchContacts(all, search.value);
    put(listBox, shown.length ? h('div', { class: 'card list', 'data-testid': 'contacts-list' }, ...shown.map((c) => contactRow(c, () => openContact(app, c, load)))) : h('p', { class: 'small center', text: 'No contact matches that.' }));
  }

  search.addEventListener('input', render);
  render();
  load();
  const add = primary(h('span', {}, 'Add a contact'), () => contactForm(app, { onSaved: load }), { 'data-testid': 'contact-add' });
  add.prepend(icon('buy'));
  const el = screen({ title: 'Contacts', back: () => app.back('settings'), actions: [add], cls: 'plain' }, h('p', { class: 'small', text: 'Kept on this phone with your wallet, locked with it, deleted with it.' }), searchBox, listBox);
  return { el };
}

export function contactRow(c, onclick, extra = {}) {
  return h(
    'button',
    { class: 'row contact-row', onclick, 'data-contact': c.name, ...extra },
    h('span', { class: 'ico avatar', 'aria-hidden': 'true', text: initials(c.name) }),
    h('span', { class: 'main' }, h('div', { class: 't', text: c.name }), h('div', { class: 's mono-s', text: shortAddress(c.address, 12) })),
    h('span', { class: 'chev' }, icon('chevron')),
  );
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : [...(parts[0] || '?')].slice(0, 2).join('');
  return s.toUpperCase();
}

/** One contact: its full address, and what can be done with it. */
export function openContact(app, c, onChanged = () => {}) {
  openSheet(
    (close) => [
      h('h2', { 'data-testid': 'contact-title', text: c.name }),
      h('div', { class: 'address-box' }, h('p', { class: 'small', 'data-testid': 'contact-kind', text: addressKindWords(c.address) }), h('p', { class: 'mono', 'data-testid': 'contact-address', text: c.address })),
      primary(`Pay ${c.name}`, () => {
        app.sendDraft = { address: c.address, amount: '', memo: '', from: 'private' };
        close();
        app.go('send');
      }, { 'data-testid': 'contact-pay', class: 'btn btn-primary wrap' }),
      h(
        'div',
        { class: 'btn-row' },
        secondary(h('span', {}, 'Copy'), () => copyText(c.address, 'Address copied'), { 'data-testid': 'contact-copy' }),
        secondary(h('span', {}, 'Edit'), () => {
          close();
          contactForm(app, { contact: c, onSaved: onChanged });
        }, { 'data-testid': 'contact-edit' }),
      ),
      textButton('Delete contact', () => {
        close();
        confirmDelete(app, c, onChanged);
      }, { class: 'btn btn-text danger', 'data-testid': 'contact-delete' }),
    ],
    { label: c.name },
  );
}

function confirmDelete(app, c, onChanged) {
  openSheet(
    (close, rerender) => {
      const msg = h('div', { class: 'pay-msg' });
      return [
        h('h2', { text: `Delete ${c.name}?` }),
        h('p', { class: 'lead', text: 'Only the contact goes. Payments to this address in your list stay, and nothing changes on the blockchain.' }),
        msg,
        h('button', {
          class: 'btn btn-danger',
          'data-testid': 'contact-delete-confirm',
          onclick: async () => {
            try {
              await (await vaultFor(app)).remove(c.id);
              await loadContacts(app).catch(() => {});
              close();
              toast(`${c.name} deleted`);
              onChanged();
            } catch (e) {
              put(msg, notice('error', bookProblem(e)));
            }
          },
        }, 'Delete contact'),
        textButton('Keep it', () => close()),
      ];
    },
    { label: 'Delete contact' },
  );
}

/**
 * Add or edit a contact. contact: the one being edited; address/name: pre-filled
 * (from Send or a payment). Resolves with the saved contact or null.
 */
export function contactForm(app, { contact = null, address = '', name = '', from = null, onSaved = () => {} } = {}) {
  return new Promise((resolve) => {
    const editing = Boolean(contact);
    const nameIn = h('input', { class: 'input', type: 'text', maxlength: String(NAME_MAX), autocomplete: 'off', autocapitalize: 'words', placeholder: 'e.g. Alex', 'aria-label': 'Name', 'data-testid': 'contact-name' });
    nameIn.value = editing ? contact.name : name;
    const addrIn = h('textarea', { class: 'input mono', rows: 3, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'Paste their Firo address, or type a Spark name like @alice', 'aria-label': 'Firo address or Spark name', 'data-testid': 'contact-address-input' });
    addrIn.value = editing ? contact.address : address;
    const hint = h('p', { class: 'hint', 'data-testid': 'contact-hint' });
    const change = h('div', { 'data-testid': 'contact-change' });
    const msg = h('div', { class: 'pay-msg', 'aria-live': 'polite' });
    const save = primary(editing ? 'Save changes' : 'Save contact', submit, { 'data-testid': 'contact-save' });
    const pasteBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'contact-paste' }, icon('paste'), 'Paste');
    const scanBtn = h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'contact-scan' }, icon('scan'), 'Scan');
    let busy = false;

    function showChange() {
      const a = cleanAddress(addrIn.value);
      put(change, editing && a && a !== contact.address ? notice('warn', h('strong', { text: 'The address changes. ' }), `From ${shortAddress(contact.address, 10)} to ${shortAddress(a, 10)}. Payments to ${cleanName(nameIn.value) || contact.name} will go to the new one.`) : null);
    }
    addrIn.addEventListener('input', () => {
      hint.textContent = '';
      put(msg);
      showChange();
    });
    nameIn.addEventListener('input', showChange);
    pasteBtn.addEventListener('click', async () => {
      try {
        addrIn.value = cleanAddress(await navigator.clipboard.readText());
        showChange();
      } catch {
        hint.textContent = 'Press and hold in the box, then tap Paste.';
        addrIn.focus();
      }
    });
    scanBtn.addEventListener('click', async () => {
      const r = await scanAddress({ title: 'Scan their address' });
      if (r && r.paste) return pasteBtn.click();
      if (r && r.address) {
        addrIn.value = r.address;
        showChange();
      }
    });

    async function submit() {
      if (busy) return;
      busy = true;
      save.disabled = true;
      put(msg);
      try {
        const v = await vaultFor(app);
        const list = await v.contacts();
        const r = checkContact({ name: nameIn.value, address: addrIn.value }, list, { editingId: editing ? contact.id : null });
        if (!r.ok) {
          put(msg, notice(r.code === 'duplicate' ? 'info' : 'warn', r.problem));
          return;
        }
        // The engine's own check: a real Firo address (or a Spark name), and not this wallet's receive address.
        if (wallet.session) {
          let kind = 'invalid';
          try {
            kind = wallet.classifyAddress(r.address).kind;
          } catch {
            kind = 'invalid';
          }
          if (kind === 'invalid') return put(msg, notice('warn', "This isn't a Firo address. Copy it again from the person."));
        }
        const own = wallet.state.receive || {};
        if (r.address === own.spark || r.address === own.transparent) return put(msg, notice('warn', "This is one of your own addresses. Save the other person's address."));
        const saved = editing ? await v.update(contact.id, r) : await v.add(r);
        await loadContacts(app).catch(() => {});
        sheet.close(saved);
        toast(editing ? 'Contact saved' : `${saved.name} saved to contacts`);
        onSaved(saved);
      } catch (e) {
        put(msg, notice('error', e.code === 'duplicate' || e.code === 'invalid' ? e.message : bookProblem(e)));
      } finally {
        busy = false;
        save.disabled = false;
      }
    }

    const sheet = openSheet(
      () => [
        h('h2', { text: editing ? 'Edit contact' : 'Save a contact' }),
        from ? h('p', { class: 'small', 'data-testid': 'contact-from', text: from }) : null,
        h('label', { class: 'field' }, 'Name', nameIn),
        h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Firo address or Spark name' }), scanBtn, pasteBtn), addrIn),
        hint,
        change,
        msg,
        save,
        textButton('Cancel', () => sheet.close(null), { 'data-testid': 'contact-cancel' }),
      ],
      { label: editing ? 'Edit contact' : 'Save a contact' },
    );
    sheet.then((v) => resolve(v || null));
    showChange();
    if (!nameIn.value) focusSoon(nameIn);
  });
}

/**
 * Send's contact picker: every contact with its address shown, so the person sees
 * where the money goes. Resolves the picked contact or null.
 */
export function pickContact(app) {
  return new Promise((resolve) => {
    let all = null;
    let problem = null;
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search', 'aria-label': 'Search contacts', autocomplete: 'off', 'data-testid': 'pick-search' });
    const box = h('div');
    const render = () => {
      if (problem) return put(box, notice('error', bookProblem(problem)));
      if (!all) return put(box, h('div', { class: 'spinner' }));
      if (!all.length)
        return put(box, h('div', { 'data-testid': 'pick-empty' }, h('p', { class: 'lead', text: 'No contacts yet. After you paste an address in Send, "Save as a contact" keeps it for next time.' })));
      search.classList.toggle('hidden', all.length < 8);
      const shown = searchContacts(all, search.value);
      put(
        box,
        h(
          'div',
          { class: 'card list picker-list', 'data-testid': 'pick-list' },
          ...shown.map((c) => {
            const row = contactRow(c, () => sheet.close(c), { 'data-testid': 'pick-contact' });
            // In the picker the address is written out more fully: what is picked is what is shown.
            row.querySelector('.s').textContent = shortAddress(c.address, 16);
            return row;
          }),
        ),
      );
    };
    search.addEventListener('input', render);
    const sheet = openSheet(() => [h('h2', { text: 'Pay a contact' }), search, box, textButton('Manage contacts', () => {
      sheet.close(null);
      app.go('contacts');
    }, { 'data-testid': 'pick-manage' }), textButton('Cancel', () => sheet.close(null))], { label: 'Pay a contact' });
    sheet.then((v) => resolve(v || null));
    render();
    loadContacts(app).then(
      (list) => {
        all = list;
        render();
      },
      (e) => {
        problem = e;
        render();
      },
    );
  });
}
