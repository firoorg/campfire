// The app puts the caret in a field by itself only on a computer. On a phone (iOS) a field focused
// without a tap gets no keyboard, and tapping it then offered only Paste: the owner could not type a
// password in Backup's export sheet. Every deferred focus goes through focusSoon / canAutofocus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canAutofocus } from '../../src/lib/ui.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const media = (fine) => ({ matchMedia: (q) => ({ matches: fine && q.includes('pointer: fine') }) });

test('autofocus on a computer, never on a phone', () => {
  assert.equal(canAutofocus(media(true)), true);
  assert.equal(canAutofocus(media(false)), false);
  assert.equal(canAutofocus({}), false);
});

test('no screen focuses a field later by itself (setTimeout(... focus())): use focusSoon', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.js')) files.push(join(d, e.name));
    }
  };
  walk(join(src, 'screens'));
  walk(join(src, 'lib'));
  // lib/ui.js holds focusSoon itself.
  const bad = files.filter((f) => !f.endsWith(join('lib', 'ui.js')) && /setTimeout\(\s*\(\)\s*=>[^)]*\.focus\(\)/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map((f) => f.slice(src.length + 1)), []);
});

// The owner could not type a password in Backup's export sheet: its handler was
// `pw.onkeydown = (e) => e.key === 'Enter' && prepare()`, which returns false for every other key,
// and false from an on… PROPERTY handler cancels the key. Only block bodies there.
test('no on… property handler with an expression body (its false would cancel the event)', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith('.js')) files.push(join(d, e.name));
    }
  };
  walk(src);
  const bad = [];
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      // UI events, where a returned false cancels what the person did (IndexedDB/WebSocket callbacks ignore it).
      if (/\.on(keydown|keypress|keyup|beforeinput|input|click|submit|paste|change|mousedown|touchstart|pointerdown)\s*=\s*(async\s*)?\(?[\w\s,]*\)?\s*=>(?!\s*\{)/.test(line)) bad.push(`${f.slice(src.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
