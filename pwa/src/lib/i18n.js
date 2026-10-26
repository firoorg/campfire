// The app's words in the person's language: English (the source) and the languages in LANGUAGES.
// Settings -> Appearance -> Language; by default the device's language, never asked.
//
//   t('Locks after {min} min without use', { min })   a text; English is the key
//   tn({ one: '{n} code', other: '{n} codes' }, n)       a count (Intl.PluralRules: Russian has
//                                                        one/few/many/other, Japanese and Chinese other)
//   tk('Like this device')                               marks a text kept in a constant (module level
//                                                        or a table); the screen shows t(CONSTANT)
//   tNodes('Read {guide} first.', { guide: link })       a sentence with an element inside it
//
// Security: a translation is only ever text. t() returns a string that the screens put on the page
// with textContent (lib/dom.js h()), never as markup; {placeholders} are filled after the lookup, in
// one pass, so a value is never read as a placeholder or as markup. A translation whose placeholders
// differ from the English text's (one missing, or one added) is not used: that text stays English.
// Catalogs (src/i18n/<lang>.json) are ordinary release files, hashed in the signed manifest like every
// other; only the active language's catalog is read. tools/build.mjs ships each with its translated
// entries only (an empty value means "not translated yet": English).
//
// What never goes through here: amounts, addresses, transaction ids, tickers (FIRO, ETH, BNB, USDT,
// rsFIRO), Spark names, the brand names (Firo, Firo PWA, Spark, Campfire, buyfiro.app, Rosen, Uniswap,
// PancakeSwap), the recovery words (the English word list), the Firo nodes' and buyfiro.app's own
// error texts, and numbers' formatting (always '1,234.5': a locale comma invites a wrong amount).
//
// The choice is kept in this browser's localStorage (one per device, for every wallet), like the
// theme (lib/theme.js): absent = like this device. lang-boot.js sets <html lang> from the same key
// before the first paint (CJK glyphs are chosen by it); test/unit/i18n.test.mjs keeps the two equal.

export const LANGUAGES = Object.freeze(['en', 'es', 'pt-BR', 'fr', 'de', 'tr', 'ru', 'zh-Hans', 'ja', 'ko', 'vi']);
// Each language in its own script, never translated: a person who cannot read the current language
// still finds theirs. i18n-ignore: each language's own name
export const LANGUAGE_NAMES = Object.freeze({ en: 'English', es: 'Español', 'pt-BR': 'Português (Brasil)', fr: 'Français', de: 'Deutsch', tr: 'Türkçe', ru: 'Русский', 'zh-Hans': '简体中文', ja: '日本語', ko: '한국어', vi: 'Tiếng Việt' });
export const LANGUAGE_CHOICES = Object.freeze(['system', ...LANGUAGES]);
export const STORAGE_KEY = 'campfire-lang';
// The language of the last start, for loader-watch.js (the tripwire's first stop runs before any
// module): its name only. That page's words, and the splash's (lang-boot.js), are in those signed files.
export const EARLY_STORAGE_KEY = 'campfire-lang-early';
// The plural forms each language's translation must give (Intl.PluralRules' categories for counts).
// Spanish, Portuguese and French also have 'many', for round millions only ("1 millón de"): a count
// there takes the 'other' form (tn()), so it is not asked of the translators.
const ONE_OTHER = Object.freeze(['one', 'other']);
const OTHER = Object.freeze(['other']);
export const PLURAL_FORMS = Object.freeze({ en: ONE_OTHER, es: ONE_OTHER, 'pt-BR': ONE_OTHER, fr: ONE_OTHER, de: ONE_OTHER, tr: ONE_OTHER, ru: Object.freeze(['one', 'few', 'many', 'other']), 'zh-Hans': OTHER, ja: OTHER, ko: OTHER, vi: OTHER });
const CATALOG_TIMEOUT_MS = 4000;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Marks a text for translation without translating it (a constant read before any language is known). */
export const tk = (text) => text;

/**
 * A table of texts kept at module level (each marked with tk()) that gives each one in the language
 * of the moment it is read: NOTIFY_TEXT.title is t('Notifications') wherever it is shown. Values that
 * are not strings are given as they are.
 */
export function lazyWords(table) {
  const out = {};
  for (const k of Object.keys(table)) Object.defineProperty(out, k, { enumerable: true, get: () => (typeof table[k] === 'string' ? t(table[k]) : table[k]) });
  return Object.freeze(out);
}

// Texts loader-watch.js and the splash show before any module runs (their keys; see EARLY_STORAGE_KEY).
export const EARLY_KEYS = Object.freeze([
  tk('Starting Firo PWA…'),
  tk('Starting'),
  tk('Stop: unsigned code'),
  tk("This app's web address is serving code Firo PWA did not sign. Don't enter your password here."),
  tk('Firo PWA stopped before opening.'),
  tk('Your coins are on the Firo blockchain, not in this app. Open them in the Campfire app or another Firo wallet with your recovery words, or with your encrypted backup file and its password.'),
  tk('Close this app now. Do not reopen it from the same address or enter any password or words in it.'),
]);
// index.html's <noscript>: no script runs there, so tools/build.mjs writes each translated line into it.
export const NOSCRIPT_TEXT = tk('Firo PWA needs JavaScript to run the wallet on your device.');

/** The placeholders a text uses, sorted: 'Send {amount} to {name}' -> ['amount', 'name']. */
export function placeholdersOf(text) {
  return [...new Set([...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// A device language's first part -> the language Firo PWA shows for it: every zh-* as Simplified
// Chinese, every pt-* as Brazilian Portuguese. lang-boot.js keeps the same table (test/unit/i18n.test.mjs).
export const DEVICE_BASES = Object.freeze({ en: 'en', es: 'es', pt: 'pt-BR', fr: 'fr', de: 'de', tr: 'tr', ru: 'ru', zh: 'zh-Hans', ja: 'ja', ko: 'ko', vi: 'vi' });

/** The language a device's preference list asks for: the first entry Firo PWA has, else English. */
export function deviceLanguage(languages) {
  for (const raw of [].concat(languages || [])) {
    const base = String(raw || '').toLowerCase().split(/[-_]/)[0];
    if (Object.prototype.hasOwnProperty.call(DEVICE_BASES, base)) return DEVICE_BASES[base];
  }
  return 'en';
}

/** The device's preference list (navigator.languages, or navigator.language). */
export function navigatorLanguages(nav = globalThis.navigator) {
  if (!nav) return [];
  if (Array.isArray(nav.languages) && nav.languages.length) return nav.languages;
  return nav.language ? [nav.language] : [];
}

/** The saved choice: 'system' (like this device) when there is none or storage cannot be read. */
export function readLanguageChoice(storage = globalThis.localStorage) {
  try {
    const v = storage ? storage.getItem(STORAGE_KEY) : null;
    return LANGUAGES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

/** The language a choice means on this device. */
export function resolveLanguage(choice, languages = navigatorLanguages()) {
  return LANGUAGES.includes(choice) ? choice : deviceLanguage(languages);
}

// ------------------------------------------------------------------ catalogs

/**
 * The usable entries of a catalog for `lang`: key -> text, or key -> { form: text } for a count.
 * Kept only when the translation has exactly the English text's placeholders ({n} too, in every form
 * of a count whose English has it); empty or wrong-shaped entries are left out (English is shown).
 * Returns { entries: Map, dropped: [keys] }.
 */
export function validateCatalog(raw, lang) {
  const entries = new Map();
  const dropped = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { entries, dropped };
  const forms = PLURAL_FORMS[lang] || ['other'];
  for (const [key, value] of Object.entries(raw)) {
    const want = placeholdersOf(key);
    if (typeof value === 'string') {
      if (!value) continue;
      if (sameSet(placeholdersOf(value), want)) entries.set(key, value);
      else dropped.push(key);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out = {};
      let ok = true;
      let any = false;
      for (const f of forms) {
        const v = value[f];
        if (typeof v !== 'string' || !v) {
          ok = false;
          continue;
        }
        any = true;
        if (!sameSet(placeholdersOf(v), want)) ok = false;
        out[f] = v;
      }
      if (ok) entries.set(key, Object.freeze(out));
      else if (any) dropped.push(key);
    }
  }
  return { entries, dropped };
}

/** Reads src/i18n/<lang>.json (served from the verified copy). English has none: null. */
export async function fetchCatalog(lang, { fetchImpl = globalThis.fetch, timeoutMs = CATALOG_TIMEOUT_MS, base = import.meta.url } = {}) {
  if (lang === 'en' || !LANGUAGES.includes(lang)) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(new URL(`../i18n/${lang}.json`, base).href, { cache: 'no-cache', credentials: 'omit', signal: ctl ? ctl.signal : undefined });
    if (!r.ok) return null;
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ the active language

let active = 'en';
let entries = null; // Map of usable translations, null for English
const listeners = new Set();
const pluralRules = new Map();

function rulesFor(lang) {
  if (!pluralRules.has(lang)) pluralRules.set(lang, new Intl.PluralRules(lang === 'zh-Hans' ? 'zh' : lang));
  return pluralRules.get(lang);
}

/** The language the app shows now: one of LANGUAGES. */
export const lang = () => active;

// Chinese and Japanese write no space after their own full stop, comma and the like. Sentences are often
// joined with a space in code (`${t(a)} ${t(b)}`, a bold heading then its text): without this they read
// "…。 …" (found by the zh and ja translators, 2026-10-14).
const CJK = new Set(['zh-Hans', 'ja']);
const CJK_MARK = '。．，、：；！？）」』';
const CJK_SPACE_AFTER = new RegExp(`([${CJK_MARK}])[ \\t]+`, 'g');
const CJK_ENDS = new RegExp(`[${CJK_MARK}]$`);

/** A text as the active language sets it: in Chinese and Japanese, no space after their punctuation. */
export function typeset(s) {
  return CJK.has(active) && typeof s === 'string' ? s.replace(CJK_SPACE_AFTER, '$1') : s;
}

/** Whether a text that follows `before` should lose its leading spaces (Chinese and Japanese only). */
export function joinsTight(before) {
  return CJK.has(active) && typeof before === 'string' && CJK_ENDS.test(before);
}

/** A heading made the first sentence of a notice: its full stop and the space after it, as the language writes them. */
export function asSentence(title) {
  const s = String(title).replace(/[.。…]+$/, '');
  return CJK.has(active) ? `${s}。` : `${s}. `;
}

/**
 * The locale for dates and times on screen: the English one a screen used before (undefined: the
 * device's), or the app's language when it is not English. Never for amounts: numbers are always
 * written '1,234.5'.
 */
export const dateLocale = (english = undefined) => (active === 'en' ? english : active);

function fill(text, params) {
  if (!params) return text;
  return text.replace(PLACEHOLDER, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) && params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
}

/** A text in the active language (English when it has no usable translation), placeholders filled. */
export function t(text, params = null) {
  let s = text;
  if (entries) {
    const v = entries.get(text);
    if (typeof v === 'string') s = v;
  }
  // Typeset the template only, before the values go in: a value (a passphrase, a memo, a name) is the
  // person's own and is never changed (release audit: a passphrase's space must survive).
  return fill(typeset(String(s)), params);
}

/**
 * A sentence with an element inside it (a link, a bold word, a button): the parts of the translated
 * text, in its order, with each {placeholder} replaced by its value: a Node stays that node, anything
 * else becomes text. For h(): h('p', {}, ...tNodes('Read {guide} first.', { guide: h('a', …) })).
 * Every string part is put on the page as text (h() makes text nodes of strings).
 */
export function tNodes(text, params = {}) {
  let s = text;
  if (entries) {
    const v = entries.get(text);
    if (typeof v === 'string') s = v;
  }
  s = typeset(String(s));
  const out = [];
  const used = new Set();
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const has = Object.prototype.hasOwnProperty.call(params, m[1]) && params[m[1]] !== undefined && params[m[1]] !== null;
    const v = has ? params[m[1]] : m[0];
    const isNode = typeof Node !== 'undefined' && v instanceof Node;
    // An element can stand in one place only: a translation that names it twice gets its text the second time.
    out.push(isNode && !used.has(v) ? v : isNode ? String(v.textContent || '') : String(v));
    if (isNode) used.add(v);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/**
 * A text about a count: forms.one / forms.other in English (the other form is the key), n the count.
 * {n} is n, unless params.n gives it already written (e.g. '1,234').
 */
export function tn(forms, n, params = null) {
  const num = Number(n);
  const p = { n, ...(params || {}) };
  if (entries) {
    const v = entries.get(forms.other);
    if (v && typeof v === 'object') {
      const cat = rulesFor(active).select(num);
      const s = v[cat] || v.other;
      if (s) return fill(typeset(s), p);
    }
  }
  const cat = rulesFor('en').select(num);
  return fill(String(forms[cat] || forms.other), p);
}

/**
 * Whole sentences, each from t()/tn(), joined the language's way: a space between them, none after the
 * full stop of Chinese and Japanese. Only the joins are touched; never what is inside a sentence.
 */
export function sentences(...list) {
  let out = '';
  for (const part of list.flat()) {
    if (part === null || part === undefined || part === false || part === '') continue;
    const s = String(part);
    out = !out ? s : joinsTight(out) ? out + s.replace(/^[ \t]+/, '') : /\s$/.test(out) || /^\s/.test(s) ? out + s : `${out} ${s}`;
  }
  return out;
}

/** fn(lang) after every change of language (the catalog is read by then). Returns the unsubscribe. */
export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Sets <html lang> (Chinese and Japanese characters are drawn by it). */
export function applyLanguage(language = active, doc = globalThis.document) {
  if (doc && doc.documentElement) doc.documentElement.setAttribute('lang', language);
}

// The language loader-watch.js shows its stop page in (its words are its own, in the signed file: only
// the language's name is kept here, and it is checked against that file's table).
function writeEarly(storage) {
  try {
    if (!storage) return;
    if (active === 'en') storage.removeItem(EARLY_STORAGE_KEY);
    else storage.setItem(EARLY_STORAGE_KEY, JSON.stringify({ lang: active }));
  } catch {
    /* storage blocked: that page stays English */
  }
}

/**
 * Makes `language` the active one: reads its catalog (English needs none; a catalog that cannot be
 * read leaves English), sets <html lang>, and tells the listeners. Returns the language now active.
 */
let latest = 0;
export async function activateLanguage(language, { storage = globalThis.localStorage, doc = globalThis.document, fetchImpl = globalThis.fetch, notify = true } = {}) {
  const want = LANGUAGES.includes(language) ? language : 'en';
  const mine = ++latest;
  let next = null;
  if (want !== 'en') {
    try {
      const raw = await fetchCatalog(want, { fetchImpl });
      next = validateCatalog(raw, want).entries;
    } catch {
      next = null; // unreadable: the texts stay English, the language attribute still follows the choice
    }
  }
  // Chosen again meanwhile (two changes in a row): the later choice wins, whichever catalog came first.
  if (mine !== latest) return active;
  active = want;
  entries = next && next.size ? next : null;
  applyLanguage(want, doc);
  writeEarly(storage);
  if (notify) {
    for (const f of [...listeners]) {
      try {
        f(want);
      } catch (e) {
        console.error(e);
      }
    }
  }
  return want;
}

/** Saves a choice ('system' or a language) and makes it active (Settings). Saving may fail: it still applies now. */
export async function setLanguage(choice, { storage = globalThis.localStorage, doc = globalThis.document, fetchImpl = globalThis.fetch, languages = navigatorLanguages() } = {}) {
  const c = LANGUAGE_CHOICES.includes(choice) ? choice : 'system';
  try {
    if (c === 'system') storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, c);
  } catch {
    /* this page only */
  }
  await activateLanguage(resolveLanguage(c, languages), { storage, doc, fetchImpl });
  return c;
}

// In the page: the language chosen (or the device's) is read before any module that shows text runs,
// so even a module's first screen is in it. Elsewhere (unit tests, workers): English.
if (globalThis.document && globalThis.document.documentElement) {
  await activateLanguage(resolveLanguage(readLanguageChoice(), navigatorLanguages()), { notify: false });
}
