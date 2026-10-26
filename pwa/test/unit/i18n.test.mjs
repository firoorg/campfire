// Translations (lib/i18n.js, lang-boot.js, loader-watch.js, tools/i18n_build.mjs): the device's
// language by default, a choice in Settings, catalogs that can only ever give text, English whenever
// a translation is missing or does not fit, and what a release ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  t, tn, tk, tNodes, lang, dateLocale, deviceLanguage, navigatorLanguages, readLanguageChoice, resolveLanguage, validateCatalog, activateLanguage, setLanguage, onLanguageChange,
  placeholdersOf, LANGUAGES, LANGUAGE_NAMES, STORAGE_KEY, EARLY_STORAGE_KEY, EARLY_KEYS, NOSCRIPT_TEXT, PLURAL_FORMS,
} from '../../src/lib/i18n.js';
import { shippedCatalog, noscriptHtml, NOT_SHIPPED, CATALOG_PATH } from '../../tools/i18n_build.mjs';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (p) => readFileSync(join(src, p), 'utf8');

function memoryStorage(init = {}, { blocked = false } = {}) {
  const m = new Map(Object.entries(init));
  const no = () => {
    throw new Error('SecurityError');
  };
  return {
    map: m,
    getItem: (k) => (blocked ? no() : m.has(k) ? m.get(k) : null),
    setItem: (k, v) => (blocked ? no() : m.set(k, String(v))),
    removeItem: (k) => (blocked ? no() : m.delete(k)),
  };
}
const fakeDoc = () => ({ documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } } });
const serve = (catalogs) => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const m = /i18n\/([A-Za-z-]+)\.json$/.exec(url);
    const c = m && catalogs[m[1]];
    if (c === undefined) return { ok: false, status: 404, json: async () => ({}) };
    if (c instanceof Error) throw c;
    return { ok: true, json: async () => (typeof c === 'string' ? JSON.parse(c) : c) };
  };
  fetchImpl.asked = asked;
  return fetchImpl;
};
async function inLanguage(code, catalog, fn) {
  const storage = memoryStorage();
  const doc = fakeDoc();
  const fetchImpl = serve({ [code]: catalog });
  try {
    await activateLanguage(code, { storage, doc, fetchImpl, notify: false });
    return await fn({ storage, doc, fetchImpl });
  } finally {
    await activateLanguage('en', { storage: memoryStorage(), doc: fakeDoc(), notify: false });
  }
}

test('eleven languages, each named in its own script', () => {
  assert.deepEqual(LANGUAGES, ['en', 'es', 'pt-BR', 'fr', 'de', 'tr', 'ru', 'zh-Hans', 'ja', 'ko', 'vi']);
  assert.deepEqual(LANGUAGE_NAMES, { en: 'English', es: 'Español', 'pt-BR': 'Português (Brasil)', fr: 'Français', de: 'Deutsch', tr: 'Türkçe', ru: 'Русский', 'zh-Hans': '简体中文', ja: '日本語', ko: '한국어', vi: 'Tiếng Việt' });
  // The forms asked of each language are the ones Intl.PluralRules gives counts in it ('many' of
  // Spanish, Portuguese and French is for round millions only: tn() takes 'other' there).
  for (const l of LANGUAGES) {
    const cats = new Intl.PluralRules(l === 'zh-Hans' ? 'zh' : l).resolvedOptions().pluralCategories.filter((c) => !(c === 'many' && ['es', 'pt-BR', 'fr'].includes(l)));
    assert.deepEqual([...PLURAL_FORMS[l]].sort(), [...cats].sort(), l);
  }
  assert.deepEqual(PLURAL_FORMS.ru, ['one', 'few', 'many', 'other']);
  assert.deepEqual(PLURAL_FORMS.ja, ['other']);
  assert.deepEqual(PLURAL_FORMS['zh-Hans'], ['other']);
});

test("the device's language: the first one the app has, every Chinese as Simplified, every Portuguese as Brazilian, else English", () => {
  for (const [list, want] of [
    [['ru-RU'], 'ru'], [['ru'], 'ru'], [['ja-JP'], 'ja'], [['ja'], 'ja'], [['zh-CN'], 'zh-Hans'], [['zh-TW'], 'zh-Hans'], [['zh-Hant-HK'], 'zh-Hans'], [['zh'], 'zh-Hans'],
    [['pt-PT'], 'pt-BR'], [['pt'], 'pt-BR'], [['es-419'], 'es'], [['fr-CA'], 'fr'], [['de-AT'], 'de'], [['tr-TR'], 'tr'], [['ko-KR'], 'ko'], [['vi-VN'], 'vi'],
    [['en-US', 'ru'], 'en'], [['it-IT', 'ru-RU'], 'ru'], [['it-IT', 'pl'], 'en'], [[], 'en'], [undefined, 'en'], [['RU-ru'], 'ru'], [['ja_JP'], 'ja'], [['english'], 'en'],
  ]) assert.equal(deviceLanguage(list), want, JSON.stringify(list));
  assert.deepEqual(navigatorLanguages({ languages: ['ja-JP', 'en'] }), ['ja-JP', 'en']);
  assert.deepEqual(navigatorLanguages({ languages: [], language: 'ja' }), ['ja']);
  assert.deepEqual(navigatorLanguages(null), []);
});

test('the choice: saved per device, "like this device" when absent, unreadable or not a language', () => {
  assert.equal(readLanguageChoice(memoryStorage()), 'system');
  assert.equal(readLanguageChoice(memoryStorage({ [STORAGE_KEY]: 'ru' })), 'ru');
  assert.equal(readLanguageChoice(memoryStorage({ [STORAGE_KEY]: 'zh-Hans' })), 'zh-Hans');
  assert.equal(readLanguageChoice(memoryStorage({ [STORAGE_KEY]: 'it' })), 'system');
  assert.equal(readLanguageChoice(memoryStorage({ [STORAGE_KEY]: 'ru' }, { blocked: true })), 'system');
  assert.equal(resolveLanguage('system', ['ja-JP']), 'ja');
  assert.equal(resolveLanguage('en', ['ja-JP']), 'en', 'English chosen on a Japanese device');
  assert.equal(resolveLanguage('ru', []), 'ru');
});

test('English: the key itself, placeholders filled once, as text', () => {
  assert.equal(lang(), 'en', 'outside a page (tests, workers): English');
  assert.equal(t('Reload'), 'Reload');
  assert.equal(t('Locks after {min} min without use', { min: 5 }), 'Locks after 5 min without use');
  assert.equal(t('{a} and {b}', { a: '{b}', b: 'x' }), '{b} and x', 'a value is never read as a placeholder');
  assert.equal(t('Send {amount}', { amount: '<img src=x onerror=alert(1)>' }), 'Send <img src=x onerror=alert(1)>', 'markup in a value is just characters');
  assert.equal(t('Hello {name}', {}), 'Hello {name}', 'a value not given stays visible (a bug to see, not to hide)');
  assert.equal(t('Hello {name}'), 'Hello {name}', 'no values: the text as it is');
  assert.equal(tk('Like this device'), 'Like this device', 'tk() only marks');
  assert.equal(dateLocale('en-GB'), 'en-GB', "English keeps the date locale a screen used");
  assert.equal(dateLocale(), undefined);
  assert.deepEqual(placeholdersOf('Send {amount} to {name}, {amount}'), ['amount', 'name']);
});

test('English counts: one for exactly 1, other for the rest; {n} may come written', () => {
  const f = { one: '{n} code', other: '{n} codes' };
  assert.equal(tn(f, 1), '1 code');
  assert.equal(tn(f, 0), '0 codes');
  assert.equal(tn(f, 2), '2 codes');
  assert.equal(tn(f, 21), '21 codes');
  assert.equal(tn(f, 1.5), '1.5 codes');
  assert.equal(tn({ one: '{n} block behind', other: '{n} blocks behind' }, 1234, { n: (1234).toLocaleString('en-US') }), '1,234 blocks behind');
  assert.equal(tn({ one: 'One code for {name}', other: '{n} codes for {name}' }, 1, { name: 'Ann' }), 'One code for Ann');
});

test('a translation is used only when it has exactly the English placeholders; anything else stays English', async () => {
  const catalog = {
    Reload: 'Перезагрузить',
    Settings: '',
    'Send {amount} to {name}': 'Отправить {amount} получателю {name}',
    'Locks after {min} min without use': 'Блокируется через {minutes} мин', // renamed placeholder
    'Your own node: {node}': 'Ваш узел', // placeholder missing
    'Synced': 'Синхронизировано {height}', // placeholder added
    'Block {height}': 'Блок {height} {height}', // the same placeholder twice is fine
    'Not an object': { other: 'x' },
    'Bad shape': 7,
  };
  await inLanguage('ru', catalog, async ({ doc, fetchImpl }) => {
    assert.equal(lang(), 'ru');
    assert.equal(doc.documentElement.attrs.lang, 'ru');
    assert.match(fetchImpl.asked[0], /\/i18n\/ru\.json$/, 'the active language only');
    assert.equal(fetchImpl.asked.length, 1);
    assert.equal(t('Reload'), 'Перезагрузить');
    assert.equal(t('Settings'), 'Settings', 'empty: not translated yet');
    assert.equal(t('Never seen'), 'Never seen');
    assert.equal(t('Send {amount} to {name}', { amount: '1 FIRO', name: 'Ann' }), 'Отправить 1 FIRO получателю Ann');
    assert.equal(t('Locks after {min} min without use', { min: 5 }), 'Locks after 5 min without use', 'renamed: English');
    assert.equal(t('Your own node: {node}', { node: 'n.example:8200' }), 'Your own node: n.example:8200', 'missing: English');
    assert.equal(t('Synced'), 'Synced', 'added: English');
    assert.equal(t('Block {height}', { height: 7 }), 'Блок 7 7');
    assert.equal(t('Not an object'), 'Not an object', 'a count is not a text');
    assert.equal(dateLocale('en-GB'), 'ru', 'dates follow the language');
  });
  const { entries, dropped } = validateCatalog(catalog, 'ru');
  assert.deepEqual([...entries.keys()].sort(), ['Block {height}', 'Reload', 'Send {amount} to {name}']);
  assert.deepEqual(dropped.sort(), ['Locks after {min} min without use', 'Not an object', 'Synced', 'Your own node: {node}'], 'a count with forms missing too');
  assert.deepEqual(validateCatalog(null, 'ru').entries.size, 0);
  assert.deepEqual(validateCatalog(['x'], 'ru').entries.size, 0);
});

test('Russian counts: one / few / many / other by Intl.PluralRules; a form missing or without {n}: English', async () => {
  const catalog = {
    '{n} codes': { one: '{n} код', few: '{n} кода', many: '{n} кодов', other: '{n} кода' },
    '{n} blocks behind': { one: '{n} блок', few: '{n} блока', many: '', other: '{n} блока' }, // many missing
    '{n} words': { one: 'слово', few: '{n} слова', many: '{n} слов', other: '{n} слова' }, // {n} left out of one
    '{n} files from {host}': { one: '{n} файл с {host}', few: '{n} файла с {host}', many: '{n} файлов с {host}', other: '{n} файла с {host}' },
  };
  await inLanguage('ru', catalog, async () => {
    const f = { one: '{n} code', other: '{n} codes' };
    assert.deepEqual([1, 2, 5, 11, 21, 22, 25, 1.5].map((n) => tn(f, n)), ['1 код', '2 кода', '5 кодов', '11 кодов', '21 код', '22 кода', '25 кодов', '1.5 кода']);
    assert.equal(tn({ one: '{n} block behind', other: '{n} blocks behind' }, 5), '5 blocks behind', 'incomplete: English');
    assert.equal(tn({ one: '{n} word', other: '{n} words' }, 21), '21 words', 'a form without {n}: English');
    assert.equal(tn({ one: '{n} file from {host}', other: '{n} files from {host}' }, 3, { host: 'a.b' }), '3 файла с a.b');
    assert.equal(t('{n} codes'), '{n} codes', 'a count is not a plain text');
  });
});

test('Japanese and Chinese counts have one form; a catalog for another language cannot add forms it lacks', async () => {
  await inLanguage('ja', { '{n} codes': { other: '{n} 個のコード' }, Reload: '再読み込み' }, async ({ doc }) => {
    assert.equal(doc.documentElement.attrs.lang, 'ja');
    assert.equal(tn({ one: '{n} code', other: '{n} codes' }, 1), '1 個のコード');
    assert.equal(t('Reload'), '再読み込み');
  });
  await inLanguage('zh-Hans', { '{n} codes': { one: '{n} 个代码' } }, async ({ doc }) => {
    assert.equal(doc.documentElement.attrs.lang, 'zh-Hans');
    assert.equal(tn({ one: '{n} code', other: '{n} codes' }, 1), '1 code', 'no "other" form: English');
  });
});

test('a catalog that cannot be read leaves English, with the language attribute still the choice', async () => {
  const answers = {
    missing: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    offline: async () => {
      throw new TypeError('Failed to fetch');
    },
    garbage: async () => ({ ok: true, json: async () => JSON.parse('{not json') }),
    array: async () => ({ ok: true, json: async () => [1, 2] }),
  };
  for (const [why, fetchImpl] of Object.entries(answers)) {
    const doc = fakeDoc();
    await activateLanguage('ru', { storage: memoryStorage(), doc, fetchImpl, notify: false });
    assert.equal(t('Reload'), 'Reload', why);
    assert.equal(lang(), 'ru', why);
    assert.equal(doc.documentElement.attrs.lang, 'ru', why);
  }
  await activateLanguage('en', { storage: memoryStorage(), doc: fakeDoc(), notify: false });
  assert.equal(await activateLanguage('it', { storage: memoryStorage(), doc: fakeDoc(), notify: false }), 'en', 'not a language of the app: English');
});

test('Settings: saved (or forgotten for "like this device"), applied at once, every listener told', async () => {
  const storage = memoryStorage();
  const doc = fakeDoc();
  const heard = [];
  const off = onLanguageChange((l) => heard.push(`${l}:${t('Reload')}`));
  const fetchImpl = serve({ ru: { Reload: 'Перезагрузить' }, ja: { Reload: '再読み込み' } });
  try {
    assert.equal(await setLanguage('ru', { storage, doc, fetchImpl, languages: ['en-US'] }), 'ru');
    assert.equal(storage.map.get(STORAGE_KEY), 'ru');
    assert.equal(doc.documentElement.attrs.lang, 'ru');
    assert.equal(await setLanguage('system', { storage, doc, fetchImpl, languages: ['ja-JP'] }), 'system');
    assert.equal(storage.map.has(STORAGE_KEY), false, 'like this device: nothing saved');
    assert.equal(lang(), 'ja');
    assert.equal(await setLanguage('en', { storage: memoryStorage({}, { blocked: true }), doc, fetchImpl, languages: ['ja-JP'] }), 'en', 'storage blocked: applied anyway');
    assert.equal(lang(), 'en');
    assert.deepEqual(heard, ['ru:Перезагрузить', 'ja:再読み込み', 'en:Reload'], 'told after the catalog is read');
  } finally {
    off();
    await activateLanguage('en', { storage: memoryStorage(), doc: fakeDoc(), notify: false });
  }
});

test('two changes in a row: the later one wins, whichever catalog arrives first', async () => {
  let release;
  const slow = new Promise((r) => (release = r));
  const fetchImpl = async (url) => {
    if (/ja\.json$/.test(url)) await slow;
    return { ok: true, json: async () => (/ja\.json$/.test(url) ? { Reload: '再読み込み' } : { Reload: 'Перезагрузить' }) };
  };
  const doc = fakeDoc();
  const first = activateLanguage('ja', { storage: memoryStorage(), doc, fetchImpl, notify: false });
  const second = activateLanguage('ru', { storage: memoryStorage(), doc, fetchImpl, notify: false });
  await second;
  release();
  await first;
  assert.equal(lang(), 'ru');
  assert.equal(t('Reload'), 'Перезагрузить');
  assert.equal(doc.documentElement.attrs.lang, 'ru');
  await activateLanguage('en', { storage: memoryStorage(), doc: fakeDoc(), notify: false });
});

test('the language of this start is kept for the next tripwire stop: its name only, never words', async () => {
  const s = memoryStorage();
  await activateLanguage('ru', { storage: s, doc: fakeDoc(), fetchImpl: serve({ ru: { 'Stop: unsigned code': 'Стоп: неподписанный код' } }), notify: false });
  assert.deepEqual(JSON.parse(s.map.get(EARLY_STORAGE_KEY)), { lang: 'ru' });
  await activateLanguage('ja', { storage: s, doc: fakeDoc(), fetchImpl: serve({}), notify: false });
  assert.deepEqual(JSON.parse(s.map.get(EARLY_STORAGE_KEY)), { lang: 'ja' }, 'a catalog not read: still the language chosen');
  await activateLanguage('en', { storage: s, doc: fakeDoc(), notify: false });
  assert.equal(s.map.has(EARLY_STORAGE_KEY), false, 'English: forgotten');
});

test('every text loader-watch.js and the splash show is one of the early keys', () => {
  const watch = read('loader-watch.js');
  const shown = [...watch.matchAll(/tr\((?:'([^']+)'|"([^"]+)"|WARNING)\)/g)].map((m) => m[1] || m[2] || /var WARNING = "([^"]+)"/.exec(watch)[1]);
  assert.equal(shown.length, 5);
  for (const s of shown) assert.ok(EARLY_KEYS.includes(s), s);
  const html = read('index.html');
  assert.ok(html.includes('<p>Starting Firo PWA…</p>') && EARLY_KEYS.includes('Starting Firo PWA…'));
  assert.ok(html.includes('aria-label="Starting"') && EARLY_KEYS.includes('Starting'));
  assert.ok(html.includes(`<noscript><p class="lead">${NOSCRIPT_TEXT}</p></noscript>`), 'the noscript sentence is NOSCRIPT_TEXT');
});

// The two files' own tables, as they are, and as tools/i18n_extract.mjs would write them from the catalogs.
const tableOf = (file) => {
  const s = read(file);
  const m = /var TEXTS = ([\s\S]*?);\n/.exec(s);
  return JSON.parse(m[1]);
};
const catalogs = () => Object.fromEntries(LANGUAGES.filter((l) => l !== 'en').map((l) => [l, JSON.parse(read(`i18n/${l}.json`))]));
// A file with a stand-in table, to run its code on words the catalogs may not have yet.
const STAND_IN = {
  ru: { 'Starting Firo PWA…': 'Запуск Firo PWA…', Starting: 'Запуск', 'Stop: unsigned code': 'Стоп: неподписанный код', 'Firo PWA stopped before opening.': 'Firo PWA остановился, не открывшись.' },
  ja: { 'Starting Firo PWA…': 'Firo PWAを起動しています…', Starting: '起動中' },
};

function runBoot(source, { languages = ['en-US'], stored = {}, blocked = false } = {}) {
  const attrs = {};
  const handlers = {};
  const nodes = { p: { textContent: 'Starting Firo PWA…' }, bar: { attrs: { 'aria-label': 'Starting' }, setAttribute(k, v) { this.attrs[k] = v; } } };
  const document = {
    documentElement: { setAttribute: (k, v) => (attrs[k] = v) },
    addEventListener: (ev, fn) => (handlers[ev] = fn),
    querySelector: (sel) => (sel.endsWith(' p') ? nodes.p : sel.includes('progressbar') ? nodes.bar : null),
  };
  const localStorage = memoryStorage(stored, { blocked });
  vm.runInNewContext(source, { document, navigator: { languages, language: languages[0] }, localStorage, JSON, Object, String });
  if (handlers.DOMContentLoaded) handlers.DOMContentLoaded();
  return { lang: attrs.lang, splash: nodes.p.textContent, bar: nodes.bar.attrs['aria-label'] };
}

test('lang-boot.js sets <html lang> before the first paint, the same way lib/i18n.js decides', () => {
  const boot = read('lang-boot.js');
  const lists = [['ru-RU'], ['ja-JP', 'en'], ['zh-TW'], ['pt-PT'], ['it', 'fr'], ['it', 'ko'], ['en-GB', 'ja'], ['vi'], ['tr-TR', 'de'], []];
  for (const languages of lists) {
    assert.equal(runBoot(boot, { languages }).lang, resolveLanguage('system', languages), JSON.stringify(languages));
    for (const choice of LANGUAGES) assert.equal(runBoot(boot, { languages, stored: { [STORAGE_KEY]: choice } }).lang, choice);
  }
  assert.equal(runBoot(boot, { languages: ['ja'], blocked: true }).lang, 'ja', 'storage blocked: the device');
  assert.equal(runBoot(boot, { languages: ['ja'], stored: { [STORAGE_KEY]: 'xx' } }).lang, 'ja');
  assert.ok(boot.includes(`'${STORAGE_KEY}'`), 'the same key');
  assert.ok(!boot.includes(EARLY_STORAGE_KEY), 'no words read from storage');
  assert.match(boot, new RegExp(`var LANGS = ${JSON.stringify(LANGUAGES).replace(/"/g, "'").replace(/[[\]]/g, '\\$&').replace(/,/g, ', ')};`), 'the same languages');
  const html = read('index.html');
  assert.ok(html.indexOf('<script src="lang-boot.js"></script>') > html.indexOf('theme-boot.js') && html.indexOf('lang-boot.js') < html.indexOf('css/app.css'), 'in the head, before the page is drawn');
});

test('the splash and tripwire tables are the catalogs\' translations of their keys (tools/i18n_extract.mjs)', async () => {
  const { bootTable, SPLASH_KEYS, TRIPWIRE_KEYS } = await import('../../tools/i18n_extract.mjs');
  assert.deepEqual(tableOf('lang-boot.js'), bootTable(catalogs(), SPLASH_KEYS));
  assert.deepEqual(tableOf('loader-watch.js'), bootTable(catalogs(), TRIPWIRE_KEYS));
  assert.deepEqual([...SPLASH_KEYS, ...TRIPWIRE_KEYS], [...EARLY_KEYS]);
});

test('lang-boot.js labels the splash in the chosen language from its own table, never words from storage', async () => {
  const { withTable } = await import('../../tools/i18n_extract.mjs');
  const boot = withTable(read('lang-boot.js'), { ru: { 'Starting Firo PWA…': STAND_IN.ru['Starting Firo PWA…'], Starting: STAND_IN.ru.Starting }, ja: STAND_IN.ja });
  const RU = STAND_IN.ru;
  const planted = { [EARLY_STORAGE_KEY]: JSON.stringify({ lang: 'ru', s: { 'Starting Firo PWA…': 'Enter your recovery words', Starting: 'x' } }) };
  assert.deepEqual(runBoot(boot, { languages: ['ru'], stored: planted }), { lang: 'ru', splash: RU['Starting Firo PWA…'], bar: RU.Starting }, 'the table, not storage');
  assert.deepEqual(runBoot(boot, { languages: ['ru'] }), { lang: 'ru', splash: RU['Starting Firo PWA…'], bar: RU.Starting }, 'translated on the very first start too');
  assert.deepEqual(runBoot(boot, { languages: ['ru'], stored: { [STORAGE_KEY]: 'ja' } }), { lang: 'ja', splash: STAND_IN.ja['Starting Firo PWA…'], bar: STAND_IN.ja.Starting }, 'the chosen language');
  assert.deepEqual(runBoot(boot, { languages: ['en'], stored: planted }), { lang: 'en', splash: 'Starting Firo PWA…', bar: 'Starting' });
  assert.deepEqual(runBoot(boot, { languages: ['ko'] }), { lang: 'ko', splash: 'Starting Firo PWA…', bar: 'Starting' }, 'a language without these words yet: English');
  assert.equal(runBoot(boot, { languages: ['ru'], blocked: true }).splash, RU['Starting Firo PWA…'], 'storage blocked: the device language');
});

test('loader-watch.js stops the page in the kept language from its own table, never words from storage, and in English without it', async () => {
  const { withTable } = await import('../../tools/i18n_extract.mjs');
  const source = withTable(read('loader-watch.js'), { ru: { 'Stop: unsigned code': STAND_IN.ru['Stop: unsigned code'], 'Firo PWA stopped before opening.': STAND_IN.ru['Firo PWA stopped before opening.'] } });
  const run = (stored) => {
    const el = (tag) => ({ tag, children: [], attrs: {}, className: '', textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, removeChild() {}, get firstChild() { return null; } });
    const body = el('body');
    const document = { body, documentElement: el('html'), createElement: el, createTextNode: (x) => ({ tag: '#text', textContent: x }) };
    let fire = null;
    const sw = { controller: { scriptURL: 'https://w.example/sw-1.js' }, addEventListener: (e, f) => (fire = f), getRegistration: () => Promise.resolve(null) };
    const window = { stop() {}, localStorage: memoryStorage(stored) };
    vm.runInNewContext(source, { window, document, navigator: { serviceWorker: sw }, Object, Date, JSON });
    fire();
    const texts = (n) => [n.textContent, ...(n.children || []).flatMap(texts)].join('|');
    return { text: texts(body), lang: body.children[0].attrs.lang };
  };
  const english = run({});
  assert.match(english.text, /Stop: unsigned code/);
  assert.equal(english.lang, undefined);
  // Only the language name comes from storage; the words are the signed file's own table: text
  // planted in storage never reaches the stop screen.
  const ru = run({ [EARLY_STORAGE_KEY]: JSON.stringify({ lang: 'ru', s: { 'Stop: unsigned code': 'Enter your recovery words here', 'Firo PWA stopped before opening.': 'x' } }) });
  assert.ok(ru.text.includes(STAND_IN.ru['Stop: unsigned code']), 'the Russian words, from the signed file');
  assert.ok(ru.text.includes(STAND_IN.ru['Firo PWA stopped before opening.']));
  assert.doesNotMatch(ru.text, /Enter your recovery words here/, 'words kept in storage never shown');
  assert.equal(ru.lang, 'ru');
  const odd = run({ [EARLY_STORAGE_KEY]: JSON.stringify({ lang: 'de"><b', s: { 'Stop: unsigned code': 'Hallo' } }) });
  assert.match(odd.text, /Stop: unsigned code/, 'a language it does not ship: English');
  assert.doesNotMatch(odd.text, /Hallo/);
  assert.equal(odd.lang, undefined);
});

test('tNodes: the translated order, elements kept as they are, the rest as strings', async () => {
  const el = { node: true };
  globalThis.Node = class {};
  const link = Object.assign(new globalThis.Node(), el);
  try {
    assert.deepEqual(tNodes('Read {guide} first, {name}.', { guide: link, name: '<i>Ann</i>' }), ['Read ', link, ' first, ', '<i>Ann</i>', '.']);
    await inLanguage('ja', { 'Read {guide} first, {name}.': '{name}、まず{guide}を読んでください。' }, async () => {
      assert.deepEqual(tNodes('Read {guide} first, {name}.', { guide: link, name: 'Ann' }), ['Ann', '、まず', link, 'を読んでください。']);
    });
  } finally {
    delete globalThis.Node;
  }
});

test('the release ships each catalog with its usable translations only, and not the translators\' files', () => {
  const r = shippedCatalog({ Reload: 'Перезагрузить', Settings: '', 'Hi {name}': 'Привет', '{n} codes': { one: '{n} код', few: '{n} кода', many: '{n} кодов', other: '{n} кода' } }, 'ru');
  assert.deepEqual(JSON.parse(r.text), { Reload: 'Перезагрузить', '{n} codes': { one: '{n} код', few: '{n} кода', many: '{n} кодов', other: '{n} кода' } });
  assert.equal(r.kept, 2);
  assert.deepEqual(r.dropped, ['Hi {name}']);
  assert.equal(shippedCatalog({ Reload: '' }, 'ja').text, '{}\n', 'nothing translated: an empty catalog');
  assert.throws(() => shippedCatalog({}, 'en'));
  assert.throws(() => shippedCatalog({}, 'it'));
  assert.ok(NOT_SHIPPED.has('i18n/keys.json') && NOT_SHIPPED.has('i18n/glossary.json'));
  assert.equal(CATALOG_PATH.exec('i18n/zh-Hans.json')[1], 'zh-Hans');
});

test('index.html: the noscript sentence in every translated language, escaped as text; unchanged without', () => {
  const html = read('index.html');
  assert.equal(noscriptHtml(html, { ru: { [NOSCRIPT_TEXT]: '' }, ja: {} }), html, 'nothing translated: byte for byte');
  const out = noscriptHtml(html, { ru: { [NOSCRIPT_TEXT]: 'Нужен JavaScript.</p></noscript><script>alert(1)</script>' }, ja: { [NOSCRIPT_TEXT]: 'JavaScript が必要です。' }, 'zh-Hans': { [NOSCRIPT_TEXT]: 'bad {x}' } });
  assert.ok(out.includes('<p class="lead" lang="ru">Нужен JavaScript.&lt;/p&gt;&lt;/noscript&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p><p class="lead" lang="ja">JavaScript が必要です。</p></noscript>'));
  assert.ok(!out.includes('lang="zh-Hans"'), 'a placeholder that is not in the English: left out');
  assert.equal((out.match(/<script/g) || []).length, (html.match(/<script/g) || []).length, 'no script added');
});

test('translations reach the page as text only: no HTML string anywhere in the app\'s modules', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(src, dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (statSync(join(src, rel)).isDirectory()) {
        if (name !== 'vendor') walk(rel);
      } else if (name.endsWith('.js')) files.push(rel);
    }
  };
  walk('lib');
  walk('screens');
  files.push('app.js', 'lang-boot.js', 'loader-watch.js');
  for (const f of files) assert.doesNotMatch(read(f), /\.innerHTML\b|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(|createContextualFragment|DOMParser/, f);
});

test('Chinese and Japanese: no space after their punctuation, across text nodes too; a heading becomes a sentence the language\'s way', async () => {
  const { typeset, asSentence, joinsTight } = await import('../../src/lib/i18n.js');
  const fetchImpl = serve({ 'zh-Hans': { Reload: '重新加载' }, ja: { Reload: '再読み込み' }, ru: { Reload: 'Перезагрузить' } });
  try {
    await activateLanguage('en', { storage: memoryStorage(), doc: fakeDoc(), notify: false, fetchImpl });
    assert.equal(typeset('Done. Next one.'), 'Done. Next one.');
    assert.equal(asSentence('Codes work like cash'), 'Codes work like cash. ');
    assert.equal(joinsTight('Done.'), false);
    await activateLanguage('ru', { storage: memoryStorage(), doc: fakeDoc(), notify: false, fetchImpl });
    assert.equal(typeset('Готово. Дальше.'), 'Готово. Дальше.', 'Russian keeps its spaces');
    await activateLanguage('ko', { storage: memoryStorage(), doc: fakeDoc(), notify: false, fetchImpl });
    assert.equal(typeset('완료. 다음.'), '완료. 다음.', 'Korean writes spaces between its words');
    for (const l of ['zh-Hans', 'ja']) {
      await activateLanguage(l, { storage: memoryStorage(), doc: fakeDoc(), notify: false, fetchImpl });
      assert.equal(typeset('已发送。 下一步：  继续'), '已发送。下一步：继续', l);
      assert.equal(typeset('FIRO 0.5 FIRO'), 'FIRO 0.5 FIRO', `${l}: spaces elsewhere stay`);
      assert.equal(asSentence('领取码就像现金'), '领取码就像现金。', l);
      assert.equal(asSentence('Reconnecting…'), 'Reconnecting。', `${l}: the old ending is replaced, not doubled`);
      assert.equal(joinsTight('标题。'), true);
      assert.equal(joinsTight('FIRO'), false);
      assert.equal(typeset(42), 42, 'not a string: as it is');
    }
  } finally {
    await activateLanguage('en', { storage: memoryStorage(), doc: fakeDoc(), notify: false, fetchImpl });
  }
});
