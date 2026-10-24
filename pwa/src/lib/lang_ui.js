// The language control, on the first screen (Welcome) and in Settings -> App -> Language. By default
// the app follows the device's language and never asks (USER_PSYCHOLOGY 1.5); this is for a person who
// wants another one. Each language is named in its own script, so whoever cannot read the current one
// still finds theirs. It changes at once: lib/i18n.js reads that catalog and app.js draws the screen
// again. The recovery words stay English whatever is chosen (the word list is English only).
import { h } from './dom.js';
import { icon } from './icons.js';
import { t, lang, LANGUAGES, LANGUAGE_NAMES, readLanguageChoice, setLanguage, deviceLanguage, navigatorLanguages } from './i18n.js';

/**
 * Settings' select: "Like this device" (the default) or a language. The closed select shows only the
 * start of its choice on a phone, so "Like this device" stays short and the row's second line names
 * the device's language while it is followed (languageRowNote).
 */
export function languageSelect() {
  const sel = h(
    'select',
    { class: 'inline', 'aria-label': t('Language'), 'data-testid': 'lang-select' },
    h('option', { value: 'system', text: t('Like this device') }),
    ...LANGUAGES.map((l) => h('option', { value: l, lang: l, text: LANGUAGE_NAMES[l] })),
  );
  sel.value = readLanguageChoice();
  // Not disabled while the catalog is read: a disabled select loses the focus, and app.js puts the
  // redrawn screen back where it was by the focused control.
  sel.addEventListener('change', () => setLanguage(sel.value));
  return sel;
}

/** The device's language, named in it, while the app follows the device; else null. */
export function languageRowNote() {
  if (readLanguageChoice() !== 'system') return null;
  const device = deviceLanguage(navigatorLanguages());
  return h('div', { class: 's', lang: device, 'data-testid': 'lang-device', text: LANGUAGE_NAMES[device] });
}

/**
 * Welcome's control: the language shown now, by its own name, with the language mark; a tap opens the
 * list. Choosing one keeps it (as Settings does); Settings can go back to "Like this device".
 */
export function languagePicker() {
  const sel = h(
    'select',
    { 'aria-label': t('Language'), 'data-testid': 'welcome-lang' },
    ...LANGUAGES.map((l) => h('option', { value: l, lang: l, text: LANGUAGE_NAMES[l] })),
  );
  sel.value = lang();
  sel.addEventListener('change', () => setLanguage(sel.value));
  return h('label', { class: 'lang-pick' }, icon('language'), sel, icon('down'));
}
