// Every word a person reads goes through the translation functions (tools/i18n_check.mjs), and every
// catalog has exactly the app's keys (tools/i18n_extract.mjs). When this fails:
//   node tools/i18n_check.mjs        lists the texts not routed through t() / tn() / tNodes() / tk()
//   node tools/i18n_extract.mjs      brings src/i18n/keys.json and the catalogs to the current keys
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkFiles, EXEMPT } from '../../tools/i18n_check.mjs';
import { collectKeys, sourceFiles, keysFile, TARGETS, I18N_DIR, SRC } from '../../tools/i18n_extract.mjs';
import { scanSource, wordLike } from '../../tools/i18n_scan.mjs';
import { PLURAL_FORMS } from '../../src/lib/i18n.js';

const fmt = (x) => `${x.file}:${x.line}: ${x.problem || `${JSON.stringify(x.value).slice(0, 100)} (${x.reason})`}`;

test('every word a person reads in app.js, lib/ and screens/ goes through the translation functions', () => {
  const { texts, problems } = checkFiles(sourceFiles());
  assert.deepEqual(texts.map(fmt), [], 'not translated: wrap with t() (see lib/i18n.js), or mark with // i18n-ignore: <why>');
  assert.deepEqual(problems.map(fmt), []);
});

test('the files the check leaves out exist, each with its reason', () => {
  for (const [file, why] of Object.entries(EXEMPT)) {
    assert.ok(existsSync(join(SRC, file)), `${file} is listed but gone`);
    assert.ok(why.length > 20, file);
  }
});

test('one text is one key: never both a count and a text, never two counts with other singulars', () => {
  const { conflicts, problems } = collectKeys();
  assert.deepEqual(conflicts.map(fmt), []);
  assert.deepEqual(problems.map(fmt), []);
});

test('every catalog has exactly the English keys, a count with the forms its language needs (run tools/i18n_extract.mjs)', () => {
  const { keys } = collectKeys();
  assert.ok(keys.size > 100, `${keys.size} keys`);
  for (const lang of TARGETS) {
    const catalog = JSON.parse(readFileSync(join(I18N_DIR, `${lang}.json`), 'utf8'));
    const missing = [...keys.keys()].filter((k) => !(k in catalog));
    const stale = Object.keys(catalog).filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${lang}: keys missing`);
    assert.deepEqual(stale, [], `${lang}: keys the app no longer has`);
    for (const [k, info] of keys) {
      const v = catalog[k];
      if (info.plural) {
        assert.ok(v && typeof v === 'object' && !Array.isArray(v), `${lang}: ${k} is a count`);
        assert.deepEqual(Object.keys(v).sort(), [...PLURAL_FORMS[lang]].sort(), `${lang}: ${k} forms`);
        for (const f of Object.values(v)) assert.equal(typeof f, 'string');
      } else assert.equal(typeof v, 'string', `${lang}: ${k} is a text`);
    }
  }
});

test('keys.json lists every key, where it is used and its English forms (run tools/i18n_extract.mjs)', () => {
  const { keys } = collectKeys();
  assert.deepEqual(JSON.parse(readFileSync(join(I18N_DIR, 'keys.json'), 'utf8')), keysFile(keys));
});

test('the glossary: every term explained, where it appears, a column per language', () => {
  const g = JSON.parse(readFileSync(join(I18N_DIR, 'glossary.json'), 'utf8'));
  assert.ok(Array.isArray(g.terms) && g.terms.length >= 60 && g.terms.length <= 120, `${g.terms && g.terms.length} terms`);
  const seen = new Set();
  for (const term of g.terms) {
    assert.equal(typeof term.en, 'string');
    assert.ok(!seen.has(term.en.toLowerCase()), `twice: ${term.en}`);
    seen.add(term.en.toLowerCase());
    assert.ok(term.meaning && term.meaning.length > 10, term.en);
    assert.ok(term.where && term.where.length > 3, term.en);
    for (const lang of TARGETS) assert.equal(typeof term[lang], 'string', `${term.en}: ${lang}`);
  }
});

// ---- the scanner itself

const scan = (code) => scanSource(`import { t, tn, tk, tNodes } from './i18n.js';\n${code}`);
const texts = (code) => scan(code).items.filter((x) => x.kind === 'text').map((x) => x.value);
const problems = (code) => scan(code).problems.map((x) => x.problem);

test('the scanner flags words that are not routed: literals, templates, concatenations, children, attributes', () => {
  assert.deepEqual(texts("function f(n) { return h('p', { text: 'Hello there' }, 'Read more', `${n} min`, 'You have ' + n + ' coins'); }"), ['Hello there', 'Read more', '{…} min', 'You have ', ' coins']);
  assert.deepEqual(texts("function f() { toast('Copied'); el.textContent = 'or'; h('input', { placeholder: 'Amount', 'aria-label': 'Close' }); }"), ['Copied', 'or', 'Amount', 'Close']);
  assert.deepEqual(texts("function f() { return { title: 'Synced', detail: 'Block 5.' }; }"), ['Synced', 'Block 5.']);
});

test('the scanner leaves names alone: classes, ids, keys, compared values, logs, selectors, URLs, brands', () => {
  const code = [
    "function f(e) {",
    "  h('div', { class: 'card list', 'data-testid': 'lock-now', type: 'button' });",
    "  console.warn('[campfire] engine stopped:', e);",
    "  if (e.code === 'Not found' || e.name === 'AbortError') return;",
    "  document.querySelector('.splash .hero p');",
    "  el.addEventListener('visibilitychange', f);",
    "  app.go('nodeSettings');",
    "  localStorage.getItem('campfire-theme');",
    "  fetch('https://explorer.example/api');",
    "  const x = { 'Content-Type': 'application/json' };",
    "  return 'Firo PWA';",
    "}",
  ].join('\n');
  assert.deepEqual(texts(code), []);
  assert.equal(wordLike('FIRO'), false);
  assert.equal(wordLike('rsFIRO'), false);
  assert.equal(wordLike('BNB Chain'), false);
  assert.equal(wordLike('tx_send'), false);
  assert.equal(wordLike('btn btn-primary'), false);
  assert.equal(wordLike('Reload'), true);
  assert.equal(wordLike('just now'), true);
});

test('the scanner: routed texts are keys; misuse is a problem', () => {
  const r = scan("export function f(n, a) { return [t('Hi {name}', { name: a }), tn({ one: '{n} code', other: '{n} codes' }, n), tNodes('Read {g}', { g: a })]; }\nconst L = { x: tk('Kept for later') };");
  assert.deepEqual(r.items.filter((x) => x.kind !== 'name').map((x) => [x.kind, x.value]), [['key', 'Hi {name}'], ['plural', '{n} code'], ['plural', '{n} codes'], ['key', 'Read {g}'], ['mark', 'Kept for later']]);
  assert.deepEqual(r.problems, []);
  assert.match(problems("const X = t('Now');").join(), /module level/);
  assert.match(problems('function f(n) { return t(`Now ${n}`); }').join(), /placeholder/);
  assert.match(problems("function f() { return t('Hi {name}'); }").join(), /no values/);
  assert.match(problems("function f(a) { return t('Hi {name}', { nam: a }); }").join(), /values for \{nam\}/);
  assert.match(problems('function f(list) { return list.map((t) => t.status); }').join(), /hides the translation function/);
  assert.match(problems("function f() { const t = 1; return t; }").join(), /hides/);
  assert.match(problems("// i18n-ignore\nfunction f() { return 'Some words here'; }").join(), /needs a reason/);
  assert.deepEqual(scan("// i18n-ignore: a log line\nfunction f() { return 'Some words here'; }").items.filter((x) => x.kind === 'ignored').length, 1);
  // A function called t that is not the translation one routes nothing.
  assert.deepEqual(scanSource("function f(r) { const t = (k) => r[k]; return t('Hello there'); }").items.filter((x) => x.kind === 'key'), []);
});
