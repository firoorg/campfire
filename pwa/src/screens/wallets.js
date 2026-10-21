/* Wallets (Settings → Wallets), the switcher (Home's wallet name, the unlock screen's picker)
 * Spec (Wallets): ONE job: see the wallets on this device and manage them.
 *       Primary CTA: "Add a wallet". Each wallet's row opens what can be done with it: open it,
 *       rename it, delete it from this device.
 *       Taps from app open: Settings (1) → Wallets (2); a wallet's actions: 3.
 * Spec (switcher, a sheet): ONE job: open another wallet.
 *       Primary action: tap the wallet. Taps from app open: Home's wallet name (1) → the wallet (2),
 *       then its unlock (Face ID or password). From the unlock screen: the wallet's name (1) → the
 *       wallet (2), then unlock.
 * Exit-intent reasons and answers:
 *   - "Which wallet am I in?" -> its name is Home's title, and marked Open here.
 *   - "Is that balance live?" -> only the open wallet shows one, live; another says Locked: no
 *     amount of a wallet is kept on the device for when it is locked (anyone with a copy of the
 *     browser's data could read it). The lock screen shows names only, no amounts.
 *   - "Will switching break my payment?" -> no: a Firo payment is on the network as soon as it is
 *     sent; switching only locks the open wallet.
 *   - "Do my wallets share a password?" -> no: each has its own password, Face ID, backup and
 *     settings (said at the top of Wallets).
 *   - "Will deleting this one touch the others?" -> the delete screen says the others stay, and
 *     only that wallet's data goes.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, textButton, notice, openSheet, toast } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { listWallets, nameOf, switchWallet, selectWallet, renameWallet, MAX_NAME } from '../lib/wallets.js';

/** How a wallet came to this device, in words. */
export function kindText(r) {
  if (r.restored) return `Restored${r.words ? ` with ${r.words} words` : ''}`;
  return 'Made on this device';
}

/**
 * What a row says about a wallet's FIRO (private + public): live for the open one ("Open · 1.5
 * FIRO", or just the amount where an Open tag already says so), "Locked" for the others.
 */
export function balanceText(app, r, { tagged = false } = {}) {
  const open = Boolean(app.dbPass && app.record && app.record.id === r.id);
  if (open) {
    const s = app.wallet.state;
    const known = s.sync.state === 'synced' || s.txsLoaded;
    // As Home's figure: private FIRO one node showed counts, unless a node's lists did not add up (P4).
    const shownByNode = s.privateCheck ? 0n : (s.balance.private.checking ?? 0n);
    const amount = known ? `${formatAmount(s.balance.private.available + shownByNode + s.balance.public.available)} ${UNIT}` : null;
    if (tagged) return amount || 'Connecting…';
    return amount ? `Open · ${amount}` : 'Open';
  }
  return 'Locked';
}

/** Add a wallet: from the switcher, Settings → Wallets, or the unlock screen. */
export async function startAddWallet(app) {
  app.go('addWallet');
}

/** Opens `target`: from an open wallet, a switch (lock, then its unlock); on the unlock screen, a pick. */
export async function openWallet(app, target) {
  if (app.dbPass) return switchWallet(app, target);
  await selectWallet(app, target);
  app.go('unlock', { reason: 'picked' });
}

/**
 * The switcher: every wallet with its name, and FIRO for the open one (none at all on the lock
 * screen), a tap opens it. Add a wallet below.
 */
export async function openSwitcher(app) {
  const list = await listWallets();
  const locked = !app.dbPass;
  openSheet((close) => {
    const rows = list.map((r) => {
      const current = Boolean(app.record && app.record.id === r.id);
      const sub = locked ? (current ? 'Selected' : kindText(r)) : balanceText(app, r);
      return h(
        'button',
        {
          class: `row${current ? ' on' : ''}`,
          type: 'button',
          'data-testid': 'switch-row',
          'data-name': nameOf(r),
          'aria-current': current ? 'true' : null,
          onclick: () => {
            close();
            if (!current) openWallet(app, r);
          },
        },
        h('span', { class: 'ico' }, icon(current ? 'check' : 'wallet')),
        h('span', { class: 'main' }, h('div', { class: 't', text: nameOf(r) }), h('div', { class: 's', text: sub })),
        current ? null : h('span', { class: 'chev' }, icon('chevron')),
      );
    });
    const add = secondary(h('span', {}, 'Add a wallet'), () => {
      close();
      startAddWallet(app);
    }, { 'data-testid': 'switch-add' });
    add.prepend(icon('plus'));
    return [
      h('h2', { text: 'Your wallets' }),
      h('div', { class: 'card list', 'data-testid': 'switcher' }, ...rows),
      h('p', { class: 'small', text: 'Each wallet opens with its own password or Face ID, and shows its balance once open.' }),
      add,
      locked ? null : textButton('Manage wallets', () => {
        close();
        app.go('wallets');
      }, { 'data-testid': 'switch-manage' }),
    ];
  }, { label: 'Your wallets' });
}

/** Home's title: the open wallet's name; a tap opens the switcher. */
export function walletChip(app) {
  const name = nameOf(app.record);
  return h(
    'div',
    { class: 'brand' },
    h(
      'button',
      { class: 'wallet-chip', type: 'button', 'data-testid': 'wallet-chip', 'aria-label': `${name}. Switch wallet`, onclick: () => openSwitcher(app) },
      h('img', { src: 'img/firo.svg', alt: '' }),
      h('span', { class: 'name', 'data-testid': 'wallet-name', text: name }),
      icon('down', 'chev'),
    ),
  );
}

/** The unlock screen's wallet picker: only when there are several. Fills `box`; calls onList(list). */
export function unlockPicker(app, box, onList = () => {}) {
  listWallets().then((list) => {
    onList(list);
    if (list.length < 2 || !app.record) return put(box);
    put(
      box,
      h(
        'button',
        { class: 'card row wallet-pick', type: 'button', 'data-testid': 'unlock-wallet-pick', onclick: () => openSwitcher(app) },
        h('span', { class: 'ico' }, icon('wallet')),
        h('span', { class: 'main' }, h('div', { class: 't', 'data-testid': 'unlock-wallet-name', text: nameOf(app.record) }), h('div', { class: 's', text: `${list.length} wallets on this device · tap to switch` })),
        h('span', { class: 'chev' }, icon('down')),
      ),
    );
  }, () => put(box));
}

function renameSheet(app, r, done) {
  let message = null;
  let busy = false;
  openSheet((close, rerender) => {
    const input = h('input', { class: 'input', type: 'text', value: nameOf(r), maxlength: String(MAX_NAME), autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', 'aria-label': 'Wallet name', 'data-testid': 'rename-input' });
    const save = async () => {
      if (busy) return;
      busy = true;
      try {
        await renameWallet(app, r, input.value);
        close(true);
        toast('Wallet renamed');
        done();
      } catch (e) {
        busy = false;
        message = notice('warn', e.message);
        rerender();
      }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    setTimeout(() => input.select(), 50);
    return [h('h2', { text: 'Rename wallet' }), h('label', { class: 'field' }, 'Wallet name', input), message, primary('Save name', save, { 'data-testid': 'rename-save' }), textButton('Cancel', () => close(false))];
  }, { label: 'Rename wallet' });
}

function actionsSheet(app, r, done) {
  const current = Boolean(app.record && app.record.id === r.id);
  openSheet((close) => [
    h('h2', { 'data-testid': 'wallet-actions-title', text: nameOf(r) }),
    h('p', { class: 'small', text: `${kindText(r)} · Face ID ${r.envelopes && r.envelopes.passkey ? 'on' : 'off'}${current ? ' · open now' : ''}` }),
    current ? null : primary(`Open ${nameOf(r)}`, () => {
      close();
      openWallet(app, r);
    }, { 'data-testid': 'wallet-open' }),
    secondary('Rename', () => {
      close();
      renameSheet(app, r, done);
    }, { 'data-testid': 'wallet-rename' }),
    h('button', { class: 'btn btn-text danger', type: 'button', 'data-testid': 'wallet-delete', onclick: () => {
      close();
      app.go('deleteWallet', { id: r.id, name: nameOf(r), words: r.words, passphrase: Boolean(r.passphrase) });
    } }, 'Delete from this device'),
    textButton('Cancel', () => close()),
  ], { label: nameOf(r) });
}

export default function wallets(app) {
  const listBox = h('div', { class: 'card list', 'data-testid': 'wallets-list' }, h('div', { class: 'row' }, h('span', { class: 'main' }, h('div', { class: 's', text: 'Loading…' }))));
  const add = primary(h('span', {}, 'Add a wallet'), () => startAddWallet(app), { 'data-testid': 'wallets-add' });
  add.prepend(icon('plus'));
  let alive = true;

  async function render() {
    const list = await listWallets();
    if (!alive) return;
    put(
      listBox,
      ...list.map((r) => {
        const current = Boolean(app.record && app.record.id === r.id);
        return h(
          'button',
          { class: 'row', type: 'button', 'data-testid': 'wallet-row', 'data-name': nameOf(r), 'data-open': String(current), onclick: () => actionsSheet(app, r, render) },
          h('span', { class: 'ico' }, icon('wallet')),
          h(
            'span',
            { class: 'main' },
            h('div', { class: 't' }, h('span', { text: nameOf(r) }), current ? h('span', { class: 'tag private wallet-open-tag', text: 'Open' }) : null),
            h('div', { class: 's', text: balanceText(app, r, { tagged: current }) }),
          ),
          h('span', { class: 'chev' }, icon('more')),
        );
      }),
    );
  }
  render();
  const off = app.wallet.onChange(() => {
    // The open wallet's balance is live here.
    const row = listBox.querySelector('[data-open="true"] .s');
    if (row && app.record) row.textContent = balanceText(app, app.record, { tagged: true });
  });

  const el = screen(
    { title: 'Wallets', back: () => app.back('settings'), actions: [add] },
    h('p', { class: 'lead', text: 'Each wallet has its own password, Face ID, backup and settings. One is open at a time.' }),
    listBox,
    h('p', { class: 'small', text: 'Last known: the balance when that wallet was last open and up to date. Nothing is asked of a locked wallet.' }),
  );
  return {
    el,
    destroy() {
      alive = false;
      off();
    },
  };
}

