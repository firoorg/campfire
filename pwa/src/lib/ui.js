// Shared screen furniture: top bar, tab bar, sheets, toasts.
import { h, clear } from './dom.js';
import { icon } from './icons.js';

export function topbar({ title, back, brand = false, right = null }) {
  return h(
    'header',
    { class: 'topbar' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: back }, icon('back')) : null,
    // brand: true for the app's name, or an element of its own (Home: the open wallet's name).
    brand instanceof Node ? brand : brand ? h('div', { class: 'brand' }, h('img', { src: 'img/logo.svg', alt: '' }), h('span', { text: 'Firo PWA' })) : h('h1', { text: title || '' }),
    right,
  );
}

/**
 * The app's main places. On a phone there is no tab bar (as in the Campfire app): Home has the
 * Receive / Send dock and ☰ for Settings, Activity is "See all". On a wide screen the same places
 * are a sidebar, as in Campfire desktop (CSS shows .sidenav from 900 px).
 */
export function tabbar(app, active) {
  const item = (name, label, ico) =>
    h('button', { class: `nav-item${active === name ? ' on' : ''}`, 'aria-current': active === name ? 'page' : null, 'data-testid': `nav-${name}`, onclick: () => app.go(name) }, icon(ico), h('span', { text: label }));
  return h(
    'nav',
    { class: 'sidenav', 'aria-label': 'Main' },
    h('div', { class: 'sidenav-brand' }, h('img', { src: 'img/logo.svg', alt: '' }), h('span', { text: 'Firo PWA' })),
    h('div', { class: 'sidenav-items' }, item('home', 'My wallet', 'wallet'), item('activity', 'Activity', 'activity'), item('contacts', 'Address book', 'person'), item('settings', 'Settings', 'settings'), item('about', 'About', 'info')),
    h('button', { class: 'nav-item sidenav-lock', 'data-testid': 'nav-lock', onclick: () => app.lock('manual') }, icon('lock'), h('span', { text: 'Lock' })),
  );
}

export function screen(opts, ...body) {
  const { tabs = null, app = null, actions = null, cls = '' } = opts;
  const el = h(
    'main',
    { class: `screen${tabs ? ' has-tabs' : ''} ${cls}` },
    opts.topbar === false ? null : topbar(opts),
    h('div', { class: 'content' }, ...body),
    actions ? h('div', { class: 'actions' }, ...[].concat(actions)) : null,
  );
  if (tabs && app) el.appendChild(tabbar(app, tabs));
  return el;
}

export function notice(kind, ...content) {
  const ico = { warn: 'alert', error: 'alert', info: 'info', success: 'check' }[kind] || 'info';
  return h('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : null }, icon(ico), h('div', { class: 'grow' }, ...content));
}

export function primary(label, onclick, extra = {}) {
  return h('button', { class: 'btn btn-primary', onclick, ...extra }, label);
}
export function secondary(label, onclick, extra = {}) {
  return h('button', { class: 'btn btn-secondary', onclick, ...extra }, label);
}
export function textButton(label, onclick, extra = {}) {
  return h('button', { class: 'btn btn-text', onclick, ...extra }, label);
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status', text: message });
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), ms);
}

/**
 * Whether the app may put the caret in a field by itself: only on a computer (a mouse and a
 * keyboard). On a phone the browser focuses the field without opening the keyboard (iOS opens it
 * only for a tap), and a tap on that already-focused field then offers Paste instead of the
 * keyboard: the person could not type their password. There they tap the field themselves.
 */
export function canAutofocus(win = globalThis) {
  return typeof win.matchMedia === 'function' && win.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Focuses `el` once it is on screen, on a computer only (canAutofocus). */
export function focusSoon(el, delay = 50) {
  if (!el || !canAutofocus()) return;
  setTimeout(() => el.isConnected && el.focus(), delay);
}

/**
 * How long a sheet that just opened lets nothing inside it answer. The second tap of a double tap on
 * a button lands on the sheet that button opened, on its Cancel or on its confirm ("Yes, bridge it",
 * "Send", "Swap", "Allow"), answering for the person before they read it (release verification
 * 0.1.8). Keyboard activations are clicks too, and are held the same way.
 */
export const SHEET_SETTLE_MS = 600;

/**
 * Holds every tap inside `el` for `ms` (a sheet, or a screen that asks to confirm a payment, just
 * opened): caught on the way down, before any button's own handler, so nothing answers yet; said
 * meanwhile with aria-disabled (assistive technology, and browser automation waits for it).
 * -> {settling(), stop()}.
 */
export function holdTaps(el, ms = SHEET_SETTLE_MS) {
  // A monotonic clock: a device clock set back meanwhile must not hold every tap for as long (audit 0.1.8).
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const openedAt = now();
  const settling = () => now() - openedAt < ms;
  // Said on its buttons (assistive technology, and browser automation waits for them), and the whole
  // as busy: never aria-disabled on the whole, which read a password field in it as dimmed (A8a).
  el.setAttribute('aria-busy', 'true');
  const marked = [];
  const mark = () => {
    if (!settling()) return;
    for (const b of interactiveIn(el)) {
      if (b.getAttribute('aria-disabled') != null) continue;
      b.setAttribute('aria-disabled', 'true');
      marked.push(b);
    }
  };
  // Its content is built right after (openSheet), so the buttons are marked once it is there, and
  // again whenever it is redrawn while it settles (a browser tells: MutationObserver).
  queueMicrotask(mark);
  const watch = typeof MutationObserver === 'function' ? new MutationObserver(mark) : null;
  if (watch) watch.observe(el, { childList: true, subtree: true });
  const settle = () => {
    if (watch) watch.disconnect();
    el.removeAttribute('aria-busy');
    for (const b of marked.splice(0)) b.removeAttribute('aria-disabled');
  };
  const t = setTimeout(settle, ms);
  el.addEventListener(
    'click',
    (e) => {
      if (!settling()) return;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  return {
    settling,
    /** Marks buttons drawn since (a sheet's content, a redraw while it settles). */
    mark,
    stop: () => {
      clearTimeout(t);
      settle();
    },
  };
}

/**
 * The buttons, links and tick boxes in `el` (a browser's DOM, or the unit tests' stand-in). A tick
 * box is held like a button while a sheet settles, so it is said like one too: unmarked, it looked
 * ready while its tap was swallowed.
 */
function interactiveIn(el) {
  if (typeof el.querySelectorAll === 'function') {
    try {
      return Array.from(el.querySelectorAll('button, [role="button"], a[href], input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"]'));
    } catch {
      /* a stand-in DOM that finds classes only: below */
    }
  }
  if (typeof el.findAll === 'function') return el.findAll((x) => x.tagName === 'BUTTON' || x.tagName === 'A' || (x.getAttribute && x.getAttribute('role') === 'button') || (x.tagName === 'INPUT' && (x.type === 'checkbox' || x.type === 'radio')));
  return [];
}

/** Opens a bottom sheet. build(close) returns its children. */
export function openSheet(build, { dismissable = true, label = 'Dialog' } = {}) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  let closed = false;
  let onClose = null;
  const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, 'data-dismissable': dismissable ? '1' : '0' });
  const sheet = h('div', { class: 'sheet' });
  overlay.appendChild(sheet);
  // Nothing in a sheet that just opened answers: not the second tap of the double tap that opened it.
  const hold = holdTaps(sheet);
  const settling = hold.settling;
  const close = (v) => {
    if (closed) return;
    closed = true;
    hold.stop();
    overlay.remove();
    if (onClose) onClose(v);
  };
  if (dismissable)
    overlay.addEventListener('click', (e) => {
      // A tap beside the sheet closes it, but not the second tap of the double tap that opened it.
      if (e.target === overlay && !settling()) close(undefined);
    });
  // app.go() removes every overlay: whoever waits on this sheet hears "closed".
  overlay.addEventListener('campfire:dismiss', () => close(undefined));
  const render = () => {
    clear(sheet);
    sheet.appendChild(h('div', { class: 'grab' }));
    for (const c of [].concat(build(close, render))) if (c) sheet.appendChild(c);
    hold.mark();
  };
  render();
  document.body.appendChild(overlay);
  return {
    close,
    rerender: render,
    get closed() {
      return closed;
    },
    then(fn) {
      onClose = fn;
    },
  };
}

export function sheetPromise(build, opts) {
  return new Promise((resolve) => {
    const s = openSheet(build, opts);
    s.then(resolve);
  });
}

export function progressBar(fraction) {
  const bar = h('div');
  const el = h('div', { class: 'progress' + (fraction == null ? ' indeterminate' : '') }, bar);
  if (fraction != null) bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return el;
}

/**
 * fn() whenever the page goes out of sight: the app switcher, another app or tab, the screen
 * turning off (visibilitychange to hidden), or the page being left (pagehide). The system takes a
 * picture of the last screen for the app switcher at that moment: a screen showing a secret hides
 * it here first. Returns the unsubscribe.
 */
export function onHidden(fn, doc = globalThis.document, win = globalThis.window) {
  const vis = () => doc.visibilityState === 'hidden' && fn();
  doc.addEventListener('visibilitychange', vis);
  if (win) win.addEventListener('pagehide', fn);
  return () => {
    doc.removeEventListener('visibilitychange', vis);
    if (win) win.removeEventListener('pagehide', fn);
  };
}

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
    return true;
  } catch {
    toast("Couldn't copy. Press and hold the text to copy it.");
    return false;
  }
}

// ---------------------------------------------------------------- secrets on the clipboard
// A private key or a view key copied to the system clipboard stays there for any app to read
// (desktop programs, the keyboard's clipboard history, Windows' Win+V, Universal Clipboard). So a
// secret is taken out again after SECRET_CLIPBOARD_MS, and at the lock. Only what Campfire put
// there: where the browser lets the page read the clipboard without asking, it checks first;
// elsewhere the clipboard is emptied (the toast said it would be). A browser lets a page write only
// while it is in front (Chrome) or right after a tap (Safari, Firefox), so the clear also runs
// when the page is back in front and at the next tap. No copy of the secret is kept for that: only
// its SHA-256. Recovery words have no copy button at all.
export const SECRET_CLIPBOARD_MS = 60000;
let pending = null; // { hash, due, compare, stop }

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether a secret copied by Campfire is still waiting to be cleared (for the tests). */
export const secretOnClipboard = () => Boolean(pending);

/**
 * Empties the clipboard if it still holds the secret Campfire copied (force: now, not only once it
 * is due: the lock). Resolves true once done or nothing is waiting.
 */
export function clearSecretClipboard({ force = false, nav = globalThis.navigator } = {}) {
  const p = pending;
  if (!p) return Promise.resolve(true);
  if (!force && Date.now() < p.due) return Promise.resolve(false);
  const done = () => {
    if (pending === p) {
      pending = null;
      p.stop();
    }
    return true;
  };
  // No read-back possible: write now, in this very turn, so a tap still counts as one. A lock out of
  // sight is refused (not in front): then the next return or tap clears it, without the wait.
  const write = () =>
    nav.clipboard.writeText('').then(done, () => {
      if (force) p.due = 0;
      return false;
    });
  if (!p.compare) return write();
  return nav.clipboard.readText().then(
    (now) => sha256Hex(now).then((h) => (h === p.hash ? write() : done())),
    () => write(),
  );
}

/**
 * Copies a secret: a toast that says the clipboard is emptied after a minute, then it is (see
 * above). app: also emptied when the wallet locks. say: the toast (the tests pass their own).
 */
export async function copySecret(text, what, { app = null, clearMs = SECRET_CLIPBOARD_MS, nav = globalThis.navigator, doc = globalThis.document, win = globalThis.window, say = toast } = {}) {
  try {
    await nav.clipboard.writeText(text);
  } catch {
    say("Couldn't copy. Press and hold the text to copy it.");
    return false;
  }
  if (pending) pending.stop();
  let compare = false;
  try {
    const st = nav.permissions && (await nav.permissions.query({ name: 'clipboard-read' }));
    compare = Boolean(st && st.state === 'granted' && nav.clipboard.readText);
  } catch {
    /* this browser cannot say: it is emptied without a check */
  }
  const p = { hash: await sha256Hex(text), due: Date.now() + clearMs, compare };
  const tryClear = () => clearSecretClipboard({ nav });
  const onVisible = () => doc.visibilityState === 'visible' && tryClear();
  const onLock = () => clearSecretClipboard({ force: true, nav });
  const timer = setTimeout(tryClear, clearMs + 50);
  doc.addEventListener('visibilitychange', onVisible);
  if (win) for (const ev of ['focus', 'pointerdown', 'keydown']) win.addEventListener(ev, tryClear, true);
  if (app && app.lockHooks) app.lockHooks.add(onLock);
  p.stop = () => {
    clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVisible);
    if (win) for (const ev of ['focus', 'pointerdown', 'keydown']) win.removeEventListener(ev, tryClear, true);
    if (app && app.lockHooks) app.lockHooks.delete(onLock);
  };
  pending = p;
  const mins = Math.max(1, Math.round(clearMs / 60000));
  say(`${what}. Firo PWA empties the clipboard in ${mins} minute${mins === 1 ? '' : 's'} (clipboard history apps may keep it).`, 6000);
  return true;
}

/**
 * A coin's round icon, the same on every screen: FIRO's logo (label.id 'firo'), otherwise the
 * coin's first letters on a colour picked for it (an Ethereum token). Every picture ships with
 * the app; nothing is fetched by what a token's creator wrote.
 */
export function assetBadge(label, { size = '' } = {}) {
  if (label && label.id === 'firo') return h('span', { class: `asset-badge firo ${size}`.trim(), 'aria-hidden': 'true' }, h('img', { src: 'img/firo.svg', alt: '' }));
  return letterBadge(label || {}, size);
}

/** Up to three letters of a coin's ticker, for its badge. */
export function badgeText(label) {
  const u = String((label && (label.unit || label.symbol)) || '?').replace(/[^A-Za-z0-9]/g, '');
  return (u || '?').slice(0, 3).toUpperCase();
}

function letterBadge(label, size) {
  const el = h('span', { class: `asset-badge ${size}`.trim(), 'aria-hidden': 'true', text: badgeText(label) });
  if (/^#[0-9a-f]{6}$/i.test(label.color || '')) {
    el.style.setProperty('--badge', label.color);
    el.style.setProperty('--badge-ink', inkFor(label.color));
    el.classList.add('tinted');
  }
  return el;
}

/** Dark or white letters, whichever reads on the badge colour. */
export function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.36 ? '#1c1d22' : '#ffffff';
}
