/* Spark names (☰ -> Spark names)
 * Spec: ONE job: see your Spark names, and get one if you have none.
 *       Primary CTA: "Get a Spark name".
 *       Taps from app open: 2 (☰ -> Spark names).
 * Exit-intent reasons and answers:
 *   - "What is a Spark name?" -> one sentence first: people pay @yourname instead of a long address.
 *   - "When does mine run out?" -> each name shows about when, from the block it is valid until,
 *     with Renew next to it. That block comes from the full list of names every wallet reads;
 *     where a server's list lacks it, "Renewal date: tap to check" asks about that one name, and
 *     only then, since asking tells the server the name is this wallet's (audit D-10).
 *   - "It didn't load" -> says why, with Try again; the rest of the wallet is unaffected.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { isNotYet } from '../lib/chain.js';

const BLOCK_SECONDS = 150;

/** "about 12 Mar 2027" for a block height, from the current tip; null when unknown. */
export function aboutDate(validUntil, tipHeight, nowMs = Date.now()) {
  if (!Number.isFinite(validUntil) || !Number.isFinite(tipHeight)) return null;
  const ms = nowMs + (validUntil - tipHeight) * BLOCK_SECONDS * 1000;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function names(app) {
  const body = h('div', { 'aria-live': 'polite' });
  const cta = primary('Get a Spark name', () => app.go('nameRegister'), { 'data-testid': 'names-get' });

  async function load() {
    put(body, h('div', { class: 'card empty', 'data-testid': 'names-loading' }, h('p', { text: 'Looking up your names…' })));
    let list;
    try {
      list = await wallet.myNames();
    } catch (e) {
      put(
        body,
        h('div', { 'data-testid': 'names-error' }, notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? 'Spark names are not in this version yet.' : `Your names could not be loaded: ${e.message}`)),
        isNotYet(e) ? null : secondary('Try again', load, { 'data-testid': 'names-retry' }),
      );
      return;
    }
    if (!list.length) {
      put(
        body,
        h(
          'div',
          { class: 'card empty', 'data-testid': 'names-empty' },
          icon('at'),
          h('p', { text: 'No Spark name yet.' }),
          h('p', { class: 'small muted', text: 'A name like @alice lets people pay you privately without copying a long address.' }),
        ),
      );
      return;
    }
    const tip = wallet.state.tip?.height;
    put(
      body,
      h(
        'div',
        { class: 'card list', 'data-testid': 'names-list' },
        ...list.map((n) => {
          const until = aboutDate(n.validUntil, tip);
          return h(
            'div',
            { class: 'row', 'data-testid': 'name-row', 'data-name': n.name },
            h('div', { class: 'main' }, h('p', { class: 'title', text: `@${n.name}` }), h('p', { class: 'sub mono small', text: `${n.address.slice(0, 12)}…${n.address.slice(-8)}` }), until ? h('p', { class: 'sub small', 'data-testid': 'name-until', text: `Yours until about ${until}` }) : renewalDate(n.name)),
            h('button', { class: 'btn btn-text btn-inline', 'data-testid': 'name-renew', onclick: () => app.go('nameRegister', { renew: n.name }) }, 'Renew'),
          );
        }),
      ),
    );
  }

  /** No expiry in the server's list of names: asked for this one name on a tap, never before (D-10). */
  function renewalDate(name) {
    const slot = h('div', { class: 'sub small', 'data-testid': 'name-until-slot' });
    const button = () => h('button', { class: 'btn btn-text btn-inline', 'data-testid': 'name-until-ask', onclick: ask }, 'Renewal date: tap to check');
    async function ask() {
      put(slot, h('span', { text: 'Checking…' }));
      try {
        const d = await wallet.nameDetails(name);
        const until = aboutDate(d.validUntil, wallet.state.tip?.height);
        put(slot, h('span', { 'data-testid': 'name-until', text: until ? `Yours until about ${until}` : 'The server did not say until when.' }));
      } catch (e) {
        put(slot, h('span', { 'data-testid': 'name-until-error', text: `Could not check: ${e.message || e} ` }), button());
      }
    }
    put(slot, button());
    return slot;
  }

  load();
  return { el: screen({ title: 'Spark names', back: () => app.back('settings'), actions: [cta], cls: 'sticky-actions' }, body) };
}
