/* One tab at a time (lib/one_tab.js): this tab does not hold the wallet.
 *
 * otherTab - Spec: ONE job: say Campfire is already open in another tab, and move it here.
 *       Primary CTA: "Use it here instead" (only if the other tab does not answer: "Take over anyway").
 *       Taps from app open: 0 to see it, 1 to have the wallet here.
 * movedTab - Spec: ONE job: say the wallet moved to another tab (locked and saved here first), and
 *       bring it back. Primary CTA: "Use it here instead". Taps: 1.
 *       how 'unchecked' (this browser cannot say which tab holds the wallet, re-audit RE1-1): ONE job:
 *       say to close the other tabs and reload. Primary CTA: "Reload". Taps: 1 (after closing them).
 * Exit-intent reasons and answers:
 *   - "Is my wallet gone / broken?" -> the lead says why there is one tab at a time: so the wallet's
 *     data stays intact; the moved screen says it was locked and saved before it moved.
 *   - "Which tab do I use now?" -> either: one tap here moves it; nothing to find or close first.
 *   - "It's stuck" (the other tab sleeps in the background) -> after 10 s it says so, in plain words,
 *     and offers "Take over anyway" with what that costs.
 *   - "Will it ask for my password?" -> the line under the button: it locks there, then opens here
 *     (unlock as usual).
 */
import { h, clear } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';
import { oneTab } from '../lib/one_tab.js';

export const OTHER_TAB_TITLE = 'Firo PWA is open in another tab';
export const OTHER_TAB_LEAD = 'It works in one tab at a time, so your wallet data stays intact.';
export const MOVED_TITLE = 'Firo PWA moved to another tab';
export const MOVED_LEAD = {
  handed: 'It works in one tab at a time. Your wallet was locked and saved here before it moved.',
  stolen: 'It works in one tab at a time. Another tab took it over, so your wallet is locked here.',
  // Locking and saving had not finished when the hand-over's time ran out (lib/one_tab.js, RE1-7).
  capped: 'It works in one tab at a time. Your wallet was locked here before it moved, but it may not have saved its last few seconds.',
};
export const UNCHECKED_TITLE = 'Close your other Firo PWA tabs';
export const UNCHECKED_LEAD = 'This browser cannot keep Firo PWA to one tab. Close every other Firo PWA tab, then reload.';
const UNCHECKED_HINT = 'Your wallet stays locked in this tab until then.';
const USE_HERE = 'Use it here instead';
const HOW_IT_MOVES = 'Your wallet locks in the other tab first, then opens here.';
const POLL_MS = 2000;

export function otherTab(app) {
  return oneTabScreen(app, { title: OTHER_TAB_TITLE, lead: OTHER_TAB_LEAD, testid: 'one-tab-other', spent: false });
}

export function movedTab(app, p = {}) {
  if (p.how === 'unchecked') return uncheckedTab();
  const how = p.how === 'stolen' || p.how === 'capped' ? p.how : 'handed';
  return oneTabScreen(app, { title: MOVED_TITLE, lead: MOVED_LEAD[how], testid: 'one-tab-moved', spent: true, how });
}

function oneTabScreen(app, { title, lead, testid, spent, how = null }) {
  const tab = oneTab();
  let gone = false;
  let pollTimer = null;
  const note = h('div', { 'data-testid': 'one-tab-note' });
  const hint = h('p', { class: 'small center', role: 'status', 'data-testid': 'one-tab-status', text: HOW_IT_MOVES });
  // One listener (dom.js adds listeners): what a tap does changes with the state.
  let action = () => moveHere();
  const btn = primary(USE_HERE, () => action && action(), { 'data-testid': 'one-tab-use-here' });

  const setButton = (label, onclick, { testid: id = 'one-tab-use-here', disabled = false } = {}) => {
    btn.textContent = label;
    action = onclick;
    btn.disabled = disabled;
    btn.dataset.testid = id;
  };

  /** The wallet is this tab's now: a page that let it go reloads (its memory is the old copy). */
  const arrived = () => {
    if (gone) return;
    gone = true;
    stopPolling();
    if (spent || tab.spent) location.reload();
    else app.continueBoot();
  };

  const failed = (e) => {
    clear(note);
    note.appendChild(notice('error', `That didn't work: ${(e && e.message) || e}. Try again; your wallet is safe.`));
    hint.textContent = HOW_IT_MOVES;
    setButton(USE_HERE, () => moveHere());
  };

  const offerSteal = ({ acked }) => {
    if (gone) return;
    clear(note);
    note.appendChild(
      notice(
        'warn',
        h('strong', { text: acked ? 'The other tab is taking long to let go.' : "The other tab isn't answering." }),
        ' ',
        acked ? 'It is still locking your wallet.' : 'It may be asleep in the background.',
      ),
    );
    hint.textContent = 'Taking over stops it at once. Anything it did in its last few seconds may not be saved.';
    setButton('Take over anyway', () => {
      setButton('Taking over…', null, { testid: 'one-tab-steal', disabled: true });
      tab.stealNow().then(arrived, failed);
    }, { testid: 'one-tab-steal' });
  };

  function moveHere() {
    clear(note);
    setButton('Moving it here…', null, { disabled: true });
    hint.textContent = 'Waiting for the other tab to lock your wallet and save it…';
    tab.takeOver({ onNoAnswer: offerSteal }).then(arrived, failed);
  }

  // Not moved here yet and the other tab closes: the wallet is free, go on by itself (only a lock
  // that is free right now: { ifAvailable }, never a place in a queue).
  const tryClaim = () => {
    if (gone || spent || tab.state !== 'busy' || document.visibilityState !== 'visible') return;
    tab.claim().then((r) => r === 'held' && arrived(), () => {});
  };
  const onVisible = () => tryClaim();
  function stopPolling() {
    clearInterval(pollTimer);
    document.removeEventListener('visibilitychange', onVisible);
  }
  if (!spent) {
    pollTimer = setInterval(tryClaim, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }

  const el = screen(
    { topbar: false, cls: 'one-tab', actions: [btn, hint] },
    h('div', { class: 'hero', 'data-testid': testid, 'data-how': how || '' }, h('img', { src: 'img/logo.svg', alt: '' }), h('h1', { text: title }), h('p', { text: lead })),
    note,
  );
  // Left (another screen took over, e.g. this tab found it cannot check the lock): nothing of this
  // screen acts any more, not even a hand-over that answers late.
  return {
    el,
    destroy() {
      gone = true;
      stopPolling();
    },
  };
}

/** The lock could not be looked up in this browser (lib/one_tab.js, RE1-1): no wallet runs here. */
function uncheckedTab() {
  const el = screen(
    { topbar: false, cls: 'one-tab', actions: [primary('Reload', () => location.reload(), { 'data-testid': 'one-tab-reload' }), h('p', { class: 'small center', role: 'status', 'data-testid': 'one-tab-status', text: UNCHECKED_HINT })] },
    h('div', { class: 'hero', 'data-testid': 'one-tab-moved', 'data-how': 'unchecked' }, h('img', { src: 'img/logo.svg', alt: '' }), h('h1', { text: UNCHECKED_TITLE }), h('p', { text: UNCHECKED_LEAD })),
  );
  return { el };
}
