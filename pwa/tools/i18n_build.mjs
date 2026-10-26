// What tools/build.mjs does with the translations (pure, so test/unit/i18n.test.mjs can check it):
//   - each catalog src/i18n/<lang>.json ships with its usable translations only: the source catalog
//     has every key (an empty value = not translated yet, for the translators), the release only
//     what lib/i18n.js would use (validateCatalog: placeholders equal to the English text's), so an
//     untranslated language costs a few bytes, not the whole key list, in every install;
//   - the translators' files (keys.json, glossary.json) are not part of a release;
//   - index.html's <noscript> gets one line per language that has its sentence translated (no script
//     runs there to choose one), each escaped as text and marked with its lang.
import { validateCatalog, NOSCRIPT_TEXT, LANGUAGES } from '../src/lib/i18n.js';

export const NOT_SHIPPED = new Set(['i18n/keys.json', 'i18n/glossary.json']);
export const CATALOG_PATH = /^i18n\/([A-Za-z-]+)\.json$/;

/** The catalog a release ships for `lang`: { text, kept, dropped } (dropped: keys whose translation does not fit). */
export function shippedCatalog(raw, lang) {
  if (!LANGUAGES.includes(lang) || lang === 'en') throw new Error(`i18n/${lang}.json: not a language of the app`);
  const { entries, dropped } = validateCatalog(raw, lang);
  const out = {};
  for (const [k, v] of entries) out[k] = v;
  return { text: `${JSON.stringify(out)}\n`, kept: entries.size, dropped };
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * index.html with the noscript sentence in every language that has it: `catalogs` maps a language to
 * its raw catalog. Unchanged when none has it.
 */
export function noscriptHtml(html, catalogs) {
  const english = `<noscript><p class="lead">${escapeHtml(NOSCRIPT_TEXT)}</p>`;
  const at = html.indexOf(english);
  if (at < 0) throw new Error('index.html: the <noscript> sentence is not lib/i18n.js NOSCRIPT_TEXT');
  let lines = '';
  for (const lang of LANGUAGES) {
    if (lang === 'en' || !catalogs[lang]) continue;
    const v = validateCatalog({ [NOSCRIPT_TEXT]: catalogs[lang][NOSCRIPT_TEXT] }, lang).entries.get(NOSCRIPT_TEXT);
    if (typeof v === 'string') lines += `<p class="lead" lang="${escapeHtml(lang)}">${escapeHtml(v)}</p>`;
  }
  return lines ? html.slice(0, at + english.length) + lines + html.slice(at + english.length) : html;
}
