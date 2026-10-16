// A secret copied to the clipboard (the Ethereum private key, the Spark view key, the xpub) is taken
// out again (audit A-6): copyText left it there for good, for every desktop program, the keyboard's
// clipboard history and Win+V. lib/ui.js copySecret: emptied after a minute, when the page is back
// in front or at the next tap if the browser would not let it write before, and at the lock; only
// when it still holds the secret where the page can check; the toast says so. Nothing keeps the
// secret itself meanwhile, only its hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySecret, clearSecretClipboard, secretOnClipboard } from '../../src/lib/ui.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env({ readable = false, focused = true } = {}) {
  const listeners = new Map();
  const on = (t, f) => listeners.set(t, [...(listeners.get(t) || []), f]);
  const off = (t, f) => listeners.set(t, (listeners.get(t) || []).filter((x) => x !== f));
  const fire = (t) => (listeners.get(t) || []).forEach((f) => f());
  const said = [];
  const e = {
    clip: null,
    focused,
    said,
    fire,
    count: () => [...listeners.values()].reduce((n, l) => n + l.length, 0),
    nav: {
      clipboard: {
        writeText: async (t) => {
          if (!e.focused) throw new Error('Document is not focused.');
          e.clip = t;
        },
        readText: async () => e.clip,
      },
      permissions: { query: async ({ name }) => ({ state: readable && name === 'clipboard-read' ? 'granted' : 'prompt' }) },
    },
    doc: { visibilityState: 'visible', addEventListener: on, removeEventListener: off },
    win: { addEventListener: on, removeEventListener: off },
    say: (m) => said.push(m),
  };
  return e;
}

test('emptied once due, and the toast says so; nothing is waiting afterwards', async () => {
  const e = env();
  assert.equal(await copySecret('0xKEY', 'Private key copied', { clearMs: 30, nav: e.nav, doc: e.doc, win: e.win, say: e.say }), true);
  assert.equal(e.clip, '0xKEY');
  assert.match(e.said[0], /^Private key copied\. Campfire empties the clipboard in 1 minute \(clipboard history apps may keep it\)\.$/);
  assert.equal(secretOnClipboard(), true);
  await sleep(120);
  assert.equal(e.clip, '');
  assert.equal(secretOnClipboard(), false);
  assert.equal(e.count(), 0, 'every listener removed');
});

test('not in front when due (the browser refuses): emptied when it comes back, or at the next tap', async () => {
  const e = env();
  await copySecret('VIEWKEY', 'View key copied', { clearMs: 20, nav: e.nav, doc: e.doc, win: e.win, say: e.say });
  e.focused = false;
  await sleep(80);
  assert.equal(e.clip, 'VIEWKEY', 'the write was refused while away');
  assert.equal(secretOnClipboard(), true);
  e.focused = true;
  e.fire('pointerdown');
  await sleep(10);
  assert.equal(e.clip, '');
  assert.equal(secretOnClipboard(), false);
});

test('where the page may read it: something copied since is left alone', async () => {
  const e = env({ readable: true });
  await copySecret('VIEWKEY', 'View key copied', { clearMs: 10, nav: e.nav, doc: e.doc, win: e.win, say: e.say });
  e.clip = 'an address the person copied since';
  await sleep(80);
  assert.equal(e.clip, 'an address the person copied since');
  assert.equal(secretOnClipboard(), false);
});

test('the lock empties it at once', async () => {
  const e = env();
  const app = { lockHooks: new Set() };
  await copySecret('0xKEY', 'Private key copied', { app, clearMs: 60000, nav: e.nav, doc: e.doc, win: e.win, say: e.say });
  assert.equal(app.lockHooks.size, 1);
  for (const f of app.lockHooks) f();
  await sleep(10);
  assert.equal(e.clip, '');
  assert.equal(app.lockHooks.size, 0);
  assert.equal(await clearSecretClipboard({ nav: e.nav }), true, 'nothing left to clear');
});

test('a lock while out of sight is refused by the browser: the next return clears it at once, without the minute', async () => {
  const e = env();
  const app = { lockHooks: new Set() };
  await copySecret('0xKEY', 'Private key copied', { app, clearMs: 60000, nav: e.nav, doc: e.doc, win: e.win, say: e.say });
  e.focused = false;
  for (const f of app.lockHooks) f();
  await sleep(10);
  assert.equal(e.clip, '0xKEY');
  e.focused = true;
  e.fire('visibilitychange');
  await sleep(10);
  assert.equal(e.clip, '');
  assert.equal(secretOnClipboard(), false);
});

test('the screens copy secrets with copySecret, never copyText; no recovery word is ever copied', () => {
  for (const f of ['screens/eth_settings.js', 'screens/view_key.js']) {
    const t = readFileSync(join(src, f), 'utf8');
    assert.ok(t.includes('copySecret('), f);
    assert.ok(!/copyText\(/.test(t), f);
  }
  for (const f of ['screens/backup.js', 'screens/eth_words.js', 'screens/confirm_words.js']) assert.ok(!/copy(Text|Secret)\(|clipboard/.test(readFileSync(join(src, f), 'utf8')), f);
});
