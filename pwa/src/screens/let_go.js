/* Letting go of a payment on one Firo node's word (release re-audit 3 RE3-3)
 * Spec: ONE job: free the FIRO of a payment of this wallet that the Firo node in use says never
 *       left, once no other Firo node could be reached for an hour to check it, knowing what that
 *       risks. A secondary action inside the payment's screen, Activity, Sell and Bridge (their own
 *       primary CTA stays theirs): one "Let it go" button, no second confirmation (what it risks is
 *       said right above it).
 *       Taps from app open: 2 (the payment's notice in Activity, then "Let it go").
 * Exit-intent reasons and answers:
 *   - "My FIRO is stuck on a payment that never went out" -> the node in use says it never left,
 *     and the person can free it here; the engine never does that alone on one node's word.
 *   - "What if it did leave?" -> said before the tap: sending again pays twice.
 *   - "Why only one node's word?" -> no other Firo node could be reached for an hour to check it.
 *   - "It failed" -> the reason in words, kept on screen: the node has it now (on its way), or it did
 *     not answer (try again in a moment). Those two are also said in a toast, which outlives the
 *     offer: on a screen that re-renders, "the node has it now" withdraws the offer (RE4-3).
 */
import { h, put } from '../lib/dom.js';
import { notice, toast } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';

export const LET_GO_TITLE = 'The Firo node in use says it never left: you can let it go.';
export const LET_GO_DETAIL = "That is one node's word: no other Firo node could be reached for an hour to check it. Letting it go makes its FIRO spendable again. If it did leave, sending again pays twice.";
/** A payment the person let go (Tx.letGo), in words. */
export const LET_GO_DONE = 'You let it go on the word of the Firo node in use: its FIRO is spendable again. If it did leave after all, Activity shows it again.';

// Per payment, across the screens' re-renders (a render must not forget a tap in flight or its
// answer); an answer is shown for a minute after the tap.
const busy = new Set();
const answers = new Map();
const ANSWER_MS = 60000;
// The offers on screen (pruned as they leave it): an answer is toasted only when none is left to say it.
const offers = new Set();
const offered = (txid) => {
  let any = false;
  for (const b of offers) {
    if (!b.isConnected) offers.delete(b);
    else if (b.getAttribute('data-txid') === txid) any = true;
  }
  return any;
};

/** How many offers are remembered (the unit tests check old ones are forgotten, release audit 0.1.5 N3). */
export const offersRemembered = () => offers.size;

/**
 * The offer for tx (wallet.state's Tx with oneNode), or null when there is none: what the node in
 * use says, that it is one node's word and what letting it go risks, and the "Let it go" button.
 * onDone(): after the engine let it go (a toast says so; the screens' own re-render shows the rest).
 */
export function letGoOffer(tx, { onDone = null } = {}) {
  if (!tx || !tx.oneNode || tx.dropped) return null;
  const box = h('div', { class: 'stack', 'data-testid': 'let-go', 'data-txid': tx.txid });
  // Boxes a re-render left behind (one every few seconds) are forgotten; a fresh one not on screen
  // yet is kept (release audit 0.1.5, N3).
  const t0 = Date.now();
  for (const b of offers) if (!b.isConnected && t0 - (b._at || 0) > 2000) offers.delete(b);
  box._at = t0;
  offers.add(box);
  const draw = () => {
    const a = answers.get(tx.txid);
    const failed = a && Date.now() - a.at < ANSWER_MS ? a.message : null;
    const working = busy.has(tx.txid);
    put(
      box,
      notice(
        'warn',
        h('strong', { text: `${LET_GO_TITLE} ` }),
        LET_GO_DETAIL,
        h(
          'div',
          { class: 'btn-row prompt-actions' },
          h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'let-go-button', disabled: working, onclick: tap }, working ? 'Letting it go…' : 'Let it go'),
        ),
      ),
      failed ? h('div', { 'data-testid': 'let-go-error' }, notice('error', failed)) : null,
    );
  };
  box._draw = draw;
  async function tap() {
    if (busy.has(tx.txid)) return;
    busy.add(tx.txid);
    answers.delete(tx.txid);
    draw();
    try {
      await wallet.letGo(tx.txid);
      busy.delete(tx.txid);
      toast('Let go: its FIRO is spendable again.', 4000);
      if (onDone) onDone();
    } catch (e) {
      busy.delete(tx.txid);
      const message = (e && e.message) || 'Firo PWA could not let it go. Try again in a moment.';
      answers.set(tx.txid, { message, at: Date.now() });
      // Release re-audit 4 RE4-3: 'seen' withdraws the offer (the screen re-renders on the change
      // before this answer), and a screen may re-render on any change: then no offer is left to say
      // why, and a toast does. While an offer is on screen it says it itself (a toast would cover
      // its button for those seconds).
      await new Promise((r) => setTimeout(r, 0));
      if (!offered(tx.txid)) toast(message, 6000);
    }
    // Every offer of this payment on screen, not only this one: a re-render while the tap was in
    // flight drew a new box showing "Letting it go…" (release audit 0.1.5, N2).
    for (const b of offers) if (b.isConnected && b.getAttribute('data-txid') === tx.txid && b._draw) b._draw();
  }
  draw();
  return box;
}
