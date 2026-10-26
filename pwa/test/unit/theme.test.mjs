// Settings -> Theme (lib/theme.js, theme-boot.js, css/app.css): like this device, light or dark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEMES, THEME_WORDS, readTheme, applyTheme, setTheme } from '../../src/lib/theme.js';

const src = (p) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };

function fakeDoc() {
  const meta = (attrs) => ({ attrs: { ...attrs }, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; } });
  const light = meta({ name: 'theme-color', content: '#fff1f1', media: '(prefers-color-scheme: light)' });
  const dark = meta({ name: 'theme-color', content: '#161a29', media: '(prefers-color-scheme: dark)' });
  const scheme = meta({ name: 'color-scheme', content: 'light dark' });
  return {
    documentElement: { dataset: {} },
    querySelectorAll: (sel) => (sel === 'meta[name="theme-color"]' ? [light, dark] : []),
    querySelector: (sel) => (sel === 'meta[name="color-scheme"]' ? scheme : null),
    light,
    dark,
    scheme,
  };
}

test('the choice: like this device unless one is saved; anything unknown or unreadable is like this device', () => {
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
  assert.equal(THEME_WORDS.system, 'Like this device');
  assert.equal(readTheme(memoryStorage()), 'system');
  assert.equal(readTheme(memoryStorage({ 'campfire-theme': 'dark' })), 'dark');
  assert.equal(readTheme(memoryStorage({ 'campfire-theme': 'purple' })), 'system');
  assert.equal(readTheme(blocked), 'system');
});

test('applied: the palette attribute, the native controls and the browser bar', () => {
  const d = fakeDoc();
  applyTheme('dark', d);
  assert.equal(d.documentElement.dataset.theme, 'dark');
  assert.equal(d.light.attrs.content, '#161a29', 'the bar is dark whatever the device says');
  assert.equal(d.dark.attrs.content, '#161a29');
  assert.equal(d.scheme.attrs.content, 'dark');
  applyTheme('light', d);
  assert.equal(d.documentElement.dataset.theme, 'light');
  assert.equal(d.dark.attrs.content, '#fff1f1');
  assert.equal(d.scheme.attrs.content, 'light');
  applyTheme('system', d);
  assert.equal('theme' in d.documentElement.dataset, false);
  assert.equal(d.light.attrs.content, '#fff1f1');
  assert.equal(d.dark.attrs.content, '#161a29', 'each tag its own colour again');
  assert.equal(d.scheme.attrs.content, 'light dark');
});

test('saved and applied at once; like this device leaves nothing saved; blocked storage still applies', () => {
  const st = memoryStorage();
  const d = fakeDoc();
  assert.equal(setTheme('dark', { storage: st, doc: d }), 'dark');
  assert.equal(st.m.get('campfire-theme'), 'dark');
  assert.equal(d.documentElement.dataset.theme, 'dark');
  setTheme('system', { storage: st, doc: d });
  assert.equal(st.m.has('campfire-theme'), false);
  const d2 = fakeDoc();
  assert.equal(setTheme('light', { storage: blocked, doc: d2 }), 'light');
  assert.equal(d2.documentElement.dataset.theme, 'light');
});

test('before the first paint: theme-boot.js reads the same key, and index.html loads it before the stylesheets', () => {
  const boot = src('theme-boot.js');
  assert.match(src('lib/theme.js'), /const KEY = 'campfire-theme';/);
  assert.match(boot, /localStorage\.getItem\('campfire-theme'\)/);
  const html = src('index.html');
  assert.ok(html.indexOf('<script src="theme-boot.js"></script>') > 0);
  assert.ok(html.indexOf('theme-boot.js') < html.indexOf('css/app.css'), 'before the colours are read');
  assert.doesNotMatch(boot, /\bimport\b|\bexport\b/, 'a classic script: it runs before the page is drawn');
});

test("css: the dark palette under the device's dark mode and under Dark is one palette", () => {
  const css = src('css/app.css');
  const decls = (body) => body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('--')).join('\n');
  const sys = /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme="light"\]\) \{\n([\s\S]*?)\n {2}\}\n\}/.exec(css);
  const forced = /\n:root\[data-theme="dark"\] \{\n([\s\S]*?)\n\}/.exec(css);
  assert.ok(sys && forced, 'both blocks found');
  assert.ok(decls(sys[1]).split('\n').length >= 20);
  assert.equal(decls(forced[1]), decls(sys[1]));
  // Every dark rule in the file follows the choice: none under the media query alone.
  for (const m of css.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/g)) {
    for (const line of m[1].split('\n').filter((l) => /\{/.test(l))) assert.match(line, /:root:not\(\[data-theme="light"\]\)/, line.trim());
  }
});
