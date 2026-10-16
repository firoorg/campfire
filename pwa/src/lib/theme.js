// Light or dark: like this device (the default), or always one of them. Settings -> Theme.
//
// The colours are css/app.css: its dark palette applies under the system's dark mode unless
// <html data-theme="light">, and always under <html data-theme="dark">. The choice is kept in this
// browser's localStorage (one per device, for every wallet), so it applies from the first screen,
// before any wallet is unlocked; with storage blocked the app simply follows the device.

export const THEMES = Object.freeze(['system', 'light', 'dark']);
export const THEME_WORDS = Object.freeze({ system: 'Like this device', light: 'Light', dark: 'Dark' });
const KEY = 'campfire-theme';
// The browser's bar colour: css/app.css --bg for each palette (index.html carries the same two).
const BAR = Object.freeze({ light: '#fff1f1', dark: '#161a29' });

/** The saved choice, 'system' when there is none or storage cannot be read. */
export function readTheme(storage = globalThis.localStorage) {
  try {
    const v = storage.getItem(KEY);
    return THEMES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Puts a choice on the page: the palette, the native controls' scheme, the browser bar's colour. */
export function applyTheme(choice, doc = globalThis.document) {
  if (!doc || !doc.documentElement) return;
  const forced = choice === 'light' || choice === 'dark' ? choice : null;
  if (forced) doc.documentElement.dataset.theme = forced;
  else delete doc.documentElement.dataset.theme;
  for (const m of doc.querySelectorAll('meta[name="theme-color"]')) {
    const own = /dark/.test(m.getAttribute('media') || '') ? 'dark' : 'light';
    m.setAttribute('content', BAR[forced || own]);
  }
  const cs = doc.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', forced || 'light dark');
}

/** Saves and applies a choice (Settings). Saving can fail (storage blocked): it still applies now. */
export function setTheme(choice, { storage = globalThis.localStorage, doc = globalThis.document } = {}) {
  const c = THEMES.includes(choice) ? choice : 'system';
  try {
    if (c === 'system') storage.removeItem(KEY);
    else storage.setItem(KEY, c);
  } catch {
    /* this page only */
  }
  applyTheme(c, doc);
  return c;
}
