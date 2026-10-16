// What system back means on a screen (lib/back.js), and what it does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backAction, installBack } from '../../src/lib/back.js';
import { navHistory } from '../../src/lib/nav.js';

test('a sheet first, then a layer, then the screen\'s own Back, then tabs to Wallet; only roots leave', () => {
  const btn = {};
  assert.equal(backAction({ overlays: [{}], backButton: btn, screenName: 'send' }), 'sheet');
  assert.equal(backAction({ overlays: [{}], backButton: null, screenName: 'home' }), 'sheet');
  assert.equal(backAction({ overlays: [{}], layerBack: btn, backButton: btn, screenName: 'bridge' }), 'sheet');
  assert.equal(backAction({ overlays: [], layerBack: btn, backButton: btn, screenName: 'bridge' }), 'layer');
  assert.equal(backAction({ overlays: [], backButton: btn, screenName: 'about' }), 'button');
  assert.equal(backAction({ overlays: [], backButton: btn, screenName: 'ethStart' }), 'button');
  for (const s of ['settings', 'activity', 'ethHome', 'ethStart']) assert.equal(backAction({ overlays: [], backButton: null, screenName: s }), 'home', s);
  for (const s of ['home', 'welcome', 'unlock']) assert.equal(backAction({ overlays: [], backButton: null, screenName: s }), 'leave');
  // A screen with no Back of its own (a payment's status, a setup step) stays put.
  for (const s of ['txStatus', 'install', 'fastStart', 'backup', 'problem']) assert.equal(backAction({ overlays: [], backButton: null, screenName: s }), 'stay');
});

/**
 * A window with just what installBack touches, over a history like the
 * browser's: the page before the app, the app's own entry, then the entries the
 * app adds. `view()` is what the screen shows right now.
 */
function fakeWindow(view) {
  const on = {};
  const entries = [{ state: 'the page before' }, { state: null }];
  let idx = 1;
  const fire = (t) => [...(on[t] || [])].forEach((f) => f({}));
  const win = {
    history: {
      get state() {
        return entries[idx].state;
      },
      get length() {
        return entries.length;
      },
      pushState: (state) => {
        entries.splice(idx + 1);
        entries.push({ state });
        idx++;
      },
      go: (n) => {
        idx += n; // only ever used to leave: no event comes back to this page
      },
    },
    document: {
      querySelectorAll: (sel) => (sel === '.overlay' ? view().overlays || [] : []),
      getElementById: () => ({
        querySelector: (sel) => (sel === '[data-back]' ? view().layer || null : sel.startsWith('.topbar') ? view().button || null : sel.includes('aria-busy') ? view().loading || null : null),
      }),
    },
    addEventListener: (t, f) => (on[t] = on[t] || []).push(f),
    removeEventListener: (t, f) => (on[t] = (on[t] || []).filter((x) => x !== f)),
    fire,
    /** The system's Back: one entry back, and the page hears of it. */
    back() {
      idx--;
      if (idx >= 1) fire('popstate');
    },
    /** A traversal straight to entry i (1: the app's own). */
    jump(i) {
      idx = i;
      if (idx >= 1) fire('popstate');
    },
    left: () => idx < 1,
    entriesAbove: () => entries.length - 2,
  };
  return win;
}

function sheet(dismissable) {
  return { dataset: { dismissable: dismissable ? '1' : '0' }, events: [], dispatchEvent(e) { this.events.push(e.type); } };
}

test('the entries are added on the first touch, and topped up after every Back', () => {
  let view = { button: null };
  const app = { currentName: 'home', go() {} };
  const win = fakeWindow(() => view);
  installBack(app, win);
  win.fire('popstate'); // before any touch: the browser's own Back
  assert.equal(win.entriesAbove(), 0);
  win.fire('pointerdown');
  win.fire('keydown');
  assert.equal(win.entriesAbove(), 2, 'two entries, once');
  app.currentName = 'about';
  let clicks = 0;
  view = { button: { click: () => clicks++ } };
  win.back();
  assert.equal(clicks, 1);
  assert.equal(win.entriesAbove(), 2, 'topped up; nothing ahead for Forward');
  assert.equal(win.history.length, 4);
});

test('a sheet closes first; a sheet at work (signing, downloading) stays and so does the screen', () => {
  const s1 = sheet(true);
  const s2 = sheet(false);
  let clicks = 0;
  let view = { overlays: [s1], button: { click: () => clicks++ } };
  const app = { currentName: 'send', go() {} };
  const win = fakeWindow(() => view);
  installBack(app, win);
  win.fire('pointerdown');
  win.back();
  assert.deepEqual(s1.events, ['campfire:dismiss']);
  assert.equal(clicks, 0);
  view = { overlays: [s2], button: { click: () => clicks++ } };
  win.back();
  win.back();
  assert.deepEqual(s2.events, [], 'not dismissed');
  assert.equal(clicks, 0, 'the screen underneath did not move');
  assert.equal(win.left(), false, 'and the app was not left');
  assert.equal(win.entriesAbove(), 2);
});

test('a layer over the screen closes before the screen goes back; tabs go to Wallet; Wallet leaves; others stay', () => {
  let closed = 0;
  let clicks = 0;
  const gone = [];
  let view = { layer: { click: () => closed++ }, button: { click: () => clicks++ } };
  const app = { currentName: 'bridge', go: (n) => gone.push(n) };
  const win = fakeWindow(() => view);
  installBack(app, win);
  win.fire('pointerdown');
  win.back();
  assert.equal(closed, 1);
  assert.equal(clicks, 0);
  view = {};
  for (const s of ['ethHome', 'settings']) {
    app.currentName = s;
    win.back();
  }
  assert.deepEqual(gone, ['home', 'home']);
  app.currentName = 'txStatus';
  win.back();
  assert.deepEqual(gone, ['home', 'home'], 'a payment status stays');
  assert.equal(win.left(), false);
  app.currentName = 'home';
  win.back();
  assert.equal(win.left(), true, 'out of the app');
});

test('rapid Backs step one screen at a time through the app history, even two the page has not handled yet', () => {
  const nav = navHistory();
  const app = {
    currentName: null,
    params: {},
    go(name, params = {}, opts = {}) {
      nav.move(this.currentName ? { name: this.currentName, params: this.params } : null, { name, params }, opts);
      this.currentName = name;
      this.params = params;
    },
    back(f) {
      const t = nav.backTarget(f);
      this.go(t.name, t.params, t.opts);
    },
  };
  const FALLBACK = { ownNode: 'nodeSettings', nodeSettings: 'settings', about: 'settings' };
  const view = () => (FALLBACK[app.currentName] ? { button: { click: () => app.back(FALLBACK[app.currentName]) } } : {});
  const win = fakeWindow(view);
  installBack(app, win);
  app.go('home');
  app.go('settings');
  app.go('nodeSettings');
  app.go('ownNode');
  win.fire('pointerdown');
  const seen = [];
  for (let i = 0; i < 3; i++) {
    win.back();
    seen.push(app.currentName);
  }
  assert.deepEqual(seen, ['nodeSettings', 'settings', 'home']);
  assert.equal(win.left(), false, 'still in the app');

  // Two Backs so close that the browser took the second before the page had
  // topped up after the first: it lands on the app's own entry, not outside.
  app.go('settings');
  app.go('nodeSettings');
  app.go('ownNode');
  win.back();
  win.jump(1);
  assert.equal(app.currentName, 'settings', 'two screens back, one at a time');
  assert.equal(win.left(), false, 'still in the app');
  assert.equal(win.entriesAbove(), 2, 'topped up again');
});

test('on a screen still loading, Back waits for its Back; more Backs meanwhile count once', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let clicks = 0;
  let view = { loading: {} };
  const app = { currentName: 'ethReceive', current: {}, go() {} };
  const win = fakeWindow(() => view);
  installBack(app, win);
  win.fire('pointerdown');
  win.back();
  win.back();
  assert.equal(win.entriesAbove(), 2, 'topped up at once');
  await sleep(120);
  assert.equal(clicks, 0, 'nothing while it loads');
  view = { button: { click: () => clicks++ } };
  await sleep(120);
  assert.equal(clicks, 1, 'its Back, once');
  assert.equal(win.left(), false);

  // Another screen opened meanwhile: the wait is dropped.
  view = { loading: {} };
  win.back();
  app.current = {};
  view = { button: { click: () => clicks++ } };
  await sleep(150);
  assert.equal(clicks, 1);
});
