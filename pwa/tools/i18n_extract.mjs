// Regenerates the translation key list and the catalogs from the app's sources.
//
//   node tools/i18n_extract.mjs           writes src/i18n/keys.json and brings src/i18n/<lang>.json (every language but English)
//                                         to exactly the English key set (new keys empty, translations kept,
//                                         keys no longer in the app removed and printed)
//   node tools/i18n_extract.mjs --check   writes nothing; exits 1 when a file is not up to date
//
// Keys are every text routed through t(), tk() and tn() (tools/i18n_scan.mjs) in src/, vendor/ left
// out. A count (tn) is keyed by its English "other" form; keys.json gives its English forms. A key's
// value in a catalog: '' = not translated yet (English is shown); a count: { form: '' } with the forms
// that language needs (lib/i18n.js PLURAL_FORMS). keys.json says where each key is used (files, no
// line numbers, so it changes only when a text does) and which placeholders it has.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, placeholders } from './i18n_scan.mjs';
import { PLURAL_FORMS, LANGUAGES, EARLY_KEYS } from '../src/lib/i18n.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
export const SRC = join(ROOT, 'src');
export const I18N_DIR = join(SRC, 'i18n');
export const TARGETS = LANGUAGES.filter((l) => l !== 'en');
// Files that are not modules of the page (other contexts, or classic scripts): their words are
// listed in lib/i18n.js (EARLY_KEYS, NOSCRIPT_TEXT) or mapped by lib/loader_words.js.
export const NOT_SCANNED_FOR_KEYS = new Set(['sw.js', 'loader-watch.js', 'theme-boot.js', 'lang-boot.js', 'lib/qr_worker.js']);

export function sourceFiles(dir = SRC) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'vendor' && name !== 'i18n') out.push(...sourceFiles(p));
    } else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

export const relSrc = (f) => relative(SRC, f).split(sep).join('/');

/**
 * Every key of the app: Map key -> { plural: { one, other } | null, files: [..], placeholders: [..] },
 * in the order the sources give them (file by file). Also the conflicts (one text both a plain key
 * and a count's, or two counts with one "other" and different forms) and the scan's problems.
 */
export function collectKeys(files = sourceFiles()) {
  const keys = new Map();
  const conflicts = [];
  const problems = [];
  for (const f of files) {
    const rel = relSrc(f);
    if (NOT_SCANNED_FOR_KEYS.has(rel)) continue;
    const { items, problems: p } = scanSource(readFileSync(f, 'utf8'), rel);
    for (const x of p) problems.push({ file: rel, ...x });
    const add = (key, plural, line) => {
      const had = keys.get(key);
      if (!had) {
        keys.set(key, { plural, files: [rel], placeholders: placeholders(key) });
        return;
      }
      if (!had.files.includes(rel)) had.files.push(rel);
      const same = (!had.plural && !plural) || (had.plural && plural && had.plural.one === plural.one);
      if (!same) conflicts.push({ file: rel, line, key, problem: had.plural || plural ? 'used both as a count (tn) and as a text, or by two counts with other singulars' : 'conflict' });
    };
    // Counts: group the forms of one tn({...}) object.
    const groups = new Map();
    for (const it of items) {
      if (it.kind === 'key' || it.kind === 'mark') add(it.value, null, it.line);
      else if (it.kind === 'plural') {
        if (!groups.has(it.group)) groups.set(it.group, { line: it.line, forms: {} });
        groups.get(it.group).forms[it.form] = it.value;
      }
    }
    for (const g of groups.values()) {
      if (typeof g.forms.other !== 'string') {
        problems.push({ file: rel, line: g.line, problem: 'tn() without an "other" form' });
        continue;
      }
      if (typeof g.forms.one !== 'string') {
        problems.push({ file: rel, line: g.line, problem: 'tn() without a "one" form (English needs both)' });
        continue;
      }
      const extra = Object.keys(g.forms).filter((k) => k !== 'one' && k !== 'other');
      if (extra.length) problems.push({ file: rel, line: g.line, problem: `tn() with forms English does not use: ${extra.join(', ')}` });
      const other = placeholders(g.forms.other);
      const one = placeholders(g.forms.one);
      if (one.some((p) => !other.includes(p))) problems.push({ file: rel, line: g.line, problem: 'tn(): the "one" form has a placeholder the "other" form lacks' });
      add(g.forms.other, { one: g.forms.one, other: g.forms.other }, g.line);
    }
  }
  return { keys, conflicts, problems };
}

/** A catalog for `lang` with exactly `keys`: translations kept, new keys empty. */
export function syncCatalog(keys, existing, lang) {
  const forms = PLURAL_FORMS[lang];
  const out = {};
  const removed = [];
  for (const [key, info] of keys) {
    const had = existing ? existing[key] : undefined;
    if (info.plural) {
      const v = {};
      for (const f of forms) v[f] = had && typeof had === 'object' && typeof had[f] === 'string' ? had[f] : '';
      out[key] = v;
    } else out[key] = typeof had === 'string' ? had : '';
  }
  for (const [key, v] of Object.entries(existing || {})) {
    if (!keys.has(key)) {
      const translated = typeof v === 'string' ? v : v && Object.values(v).some(Boolean);
      if (translated) removed.push({ key, value: v });
    }
  }
  return { catalog: out, removed };
}

export function keysFile(keys) {
  const out = {};
  for (const [key, info] of keys) {
    const e = { where: info.files };
    if (info.placeholders.length) e.placeholders = info.placeholders;
    if (info.plural) e.count = { one: info.plural.one, other: info.plural.other };
    out[key] = e;
  }
  return out;
}

export const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

// The splash (lang-boot.js) and the tripwire's first stop (loader-watch.js) run before any module and
// read no words from storage: each carries its own table, written here from the catalogs (only
// translated entries; a language with none is left out and shows English).
export const SPLASH_KEYS = Object.freeze(EARLY_KEYS.slice(0, 2));
export const TRIPWIRE_KEYS = Object.freeze(EARLY_KEYS.slice(2));
export function bootTable(catalogs, keys) {
  const out = {};
  for (const lang of TARGETS) {
    const c = catalogs[lang] || {};
    const words = {};
    for (const k of keys) if (typeof c[k] === 'string' && c[k]) words[k] = c[k];
    if (Object.keys(words).length) out[lang] = words;
  }
  return out;
}
/** `src` with its `var TEXTS = …;` replaced by `table` (indent: the line's own). */
export function withTable(src, table) {
  const m = /^( *)var TEXTS = [\s\S]*?;$/m.exec(src);
  if (!m) throw new Error('no "var TEXTS = …;" line');
  const body = JSON.stringify(table, null, 2).replace(/\n/g, `\n${m[1]}`);
  return src.slice(0, m.index) + `${m[1]}var TEXTS = ${body};` + src.slice(m.index + m[0].length);
}

function main() {
  const check = process.argv.includes('--check');
  const { keys, conflicts, problems } = collectKeys();
  for (const p of [...problems, ...conflicts]) console.error(`i18n: ${p.file}:${p.line}: ${p.problem}${p.key ? ` (${JSON.stringify(p.key).slice(0, 80)})` : ''}`);
  if (problems.length || conflicts.length) process.exitCode = 1;
  const stale = [];
  const write = (file, text) => {
    const had = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (had === text) return;
    if (check) stale.push(relative(ROOT, file));
    else writeFileSync(file, text);
  };
  write(join(I18N_DIR, 'keys.json'), json(keysFile(keys)));
  const catalogs = {};
  for (const lang of TARGETS) {
    const file = join(I18N_DIR, `${lang}.json`);
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const { catalog, removed } = syncCatalog(keys, existing, lang);
    for (const r of removed) console.log(`i18n: ${lang}: removed ${JSON.stringify(r.key).slice(0, 100)} (its translation was ${JSON.stringify(r.value).slice(0, 100)})`);
    write(file, json(catalog));
    catalogs[lang] = catalog;
  }
  for (const [name, which] of [['lang-boot.js', SPLASH_KEYS], ['loader-watch.js', TRIPWIRE_KEYS]]) {
    const file = join(SRC, name);
    write(file, withTable(readFileSync(file, 'utf8'), bootTable(catalogs, which)));
  }
  const plural = [...keys.values()].filter((k) => k.plural).length;
  if (check && stale.length) {
    console.error(`i18n: not up to date: ${stale.join(', ')} (run node tools/i18n_extract.mjs)`);
    process.exitCode = 1;
  } else console.log(`i18n: ${keys.size} keys (${plural} counts)${check ? ', catalogs up to date' : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
