// "Stay unlocked until it is done" (owner, 2026-10-21; 0.1.11 audit M1, M2): the auto-lock waits only
// while the check runs in sight, for at most an hour, and never past a sleep that said nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keepingAwake, startKeepingAwake, stopKeepingAwake, installKeepAwake, KEEP_AWAKE_MAX_MS } from '../../src/lib/keep_awake.js';

const visible = { visibilityState: 'visible', addEventListener() {} };

function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test('in sight it holds; hidden, an hour on, or a 45 s gap (a sleep) ends it', () => {
  const t0 = 1_000_000;
  at(t0, () => startKeepingAwake());
  assert.equal(at(t0 + 15000, () => keepingAwake(visible)), true);
  assert.equal(at(t0 + 30000, () => keepingAwake(visible)), true);
  assert.equal(at(t0 + 30000 + 46000, () => keepingAwake(visible)), false, 'a sleep that never said hidden');
  at(t0, () => startKeepingAwake());
  assert.equal(at(t0 + 1000, () => keepingAwake({ visibilityState: 'hidden' })), false, 'out of sight');
  at(t0, () => startKeepingAwake());
  let t = t0;
  while (t < t0 + KEEP_AWAKE_MAX_MS - 15000) assert.equal(at((t += 15000), () => keepingAwake(visible)), true);
  assert.equal(at(t0 + KEEP_AWAKE_MAX_MS, () => keepingAwake(visible)), false, 'the hour over');
});

test('it ends when Home\'s note would go: the check done, a node\'s lists in doubt, watch-only, the person\'s own node; and on Lock', () => {
  const hooks = new Set();
  let onChange = null;
  const app = { lockHooks: hooks, prefs: { server: 'firo' } };
  installKeepAwake(app, { onChange: (fn) => (onChange = fn) }, visible);
  const state = (o = {}) => ({ balance: { private: { checking: 5n } }, privateCheck: null, viewOnly: false, ...o });
  for (const [why, s, server] of [
    ['check done', state({ balance: { private: { checking: 0n } } })],
    ['lists in doubt', state({ privateCheck: { code: 'set-disagree' } })],
    ['watch-only', state({ viewOnly: true })],
    ['own node', state(), 'node.example.org:50004'],
  ]) {
    app.prefs.server = server || 'firo';
    startKeepingAwake();
    onChange(state());
    if (!server) assert.equal(keepingAwake(visible), true, `still on before: ${why}`);
    onChange(s);
    assert.equal(keepingAwake(visible), false, why);
  }
  app.prefs.server = 'firo';
  startKeepingAwake();
  for (const f of hooks) f();
  assert.equal(keepingAwake(visible), false, 'Lock');
  stopKeepingAwake();
});
