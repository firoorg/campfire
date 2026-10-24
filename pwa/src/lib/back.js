// System back - Android's back button and gesture, the edge swipe in an iPhone
// Home Screen app, the browser's Back - does what the screen's own Back does:
// it closes an open sheet, else a layer over the screen by its
// own close button ([data-back]), else taps the top bar's Back, which follows
// the app's history (lib/nav.js), else a tab goes to Wallet (Activity,
// Settings, and the Ethereum side). Only Wallet, Welcome and Unlock let it
// leave the app; any other screen without a Back (a payment's status, a step
// that must finish) stays. On a screen still loading, it waits for its Back.
//
// Two history entries sit on top of the app's own. A Back uses one up and the
// app tops them up again, so the address never changes, nothing about the
// screen is kept in the browser's history, and a second Back that arrives
// before the page has handled the first still lands on the app. Chrome skips
// entries a page adds before the person has touched it, so they are added on
// the first tap or key.

const ROOTS = new Set(['home', 'welcome', 'unlock']);
const TABS = new Set(['activity', 'settings', 'ethHome', 'ethStart']);
const DEPTH = 2;

/** What a Back means on the current screen: 'sheet' | 'layer' | 'button' | 'home' | 'leave' | 'stay'. */
export function backAction({ overlays, layerBack = null, backButton, screenName }) {
  if (overlays.length) return 'sheet';
  if (layerBack) return 'layer';
  if (backButton) return 'button';
  if (TABS.has(screenName)) return 'home';
  if (ROOTS.has(screenName)) return 'leave';
  return 'stay';
}

export function installBack(app, win = window) {
  const hist = win.history;
  if (!hist || typeof hist.pushState !== 'function') return;
  let armed = false;
  // Which of the entries above the app's own this is (0: the app's own). Only
  // this page's: after a reload the entries left from before do not count.
  const doc = Math.random().toString(36).slice(2);
  const depth = () => (hist.state && hist.state.campfire === 'back' && hist.state.doc === doc ? hist.state.n : 0);
  const arm = () => {
    armed = true;
    for (let n = depth() + 1; n <= DEPTH; n++) hist.pushState({ campfire: 'back', doc, n }, '');
  };
  const onFirst = () => {
    win.removeEventListener('pointerdown', onFirst, true);
    win.removeEventListener('keydown', onFirst, true);
    arm();
  };
  win.addEventListener('pointerdown', onFirst, true);
  win.addEventListener('keydown', onFirst, true);

  // A screen still loading its code (a spinner, no top bar yet) has no Back:
  // the Back waits for that screen, a few seconds at most. More Backs meanwhile count once.
  const LOADING = ':scope > main[aria-busy="true"]'; // i18n-ignore: a CSS selector
  let waiting = false;
  const whenLoaded = (root) => {
    if (waiting) return;
    waiting = true;
    const t0 = Date.now();
    const screen = app.current;
    const tick = () => {
      if (app.current !== screen) waiting = false;
      else if (!root.querySelector(LOADING)) {
        waiting = false;
        run(true);
      } else if (Date.now() - t0 < 5000) setTimeout(tick, 50);
      else waiting = false;
    };
    setTimeout(tick, 50);
  };

  /** Does what a Back means now; returns the action. After a wait, 'leave' is not taken. */
  function run(late) {
    const doc = win.document;
    const overlays = [...doc.querySelectorAll('.overlay')];
    const root = doc.getElementById('app');
    if (!overlays.length && root && root.querySelector(LOADING)) {
      whenLoaded(root);
      return 'wait';
    }
    const layerBack = root && root.querySelector('[data-back]');
    const backButton = root && root.querySelector('.topbar button[aria-label="Back"]');
    const action = backAction({ overlays, layerBack, backButton, screenName: app.currentName });
    if (action === 'sheet') {
      const top = overlays[overlays.length - 1];
      // A sheet that holds a payment decides (lib/ui.js openSheet): its way out while that is
      // offered, nothing while it signs or sends.
      top.dispatchEvent(new Event(top.dataset.dismissable !== '0' ? 'campfire:dismiss' : 'campfire:beside'));
    } else if (action === 'layer') layerBack.click();
    else if (action === 'button') backButton.click();
    else if (action === 'home') app.go('home');
    return late && action === 'leave' ? 'stay' : action;
  }

  win.addEventListener('popstate', () => {
    if (!armed) return; // a Back before the entries existed: the browser's own
    if (run(false) === 'leave') {
      armed = false;
      hist.go(-(depth() + 1)); // past this app's first entry: out of the app
      return;
    }
    arm();
  });
}
