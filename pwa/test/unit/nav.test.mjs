// Where Back goes (lib/nav.js), through a router that moves exactly as
// app.go() and app.back() do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { navHistory, isRoot } from '../../src/lib/nav.js';

function router() {
  const nav = navHistory();
  const r = {
    nav,
    cur: null,
    go(name, params = {}, opts = {}) {
      nav.move(r.cur, { name, params }, opts);
      r.cur = { name, params };
    },
    back(fallback = 'home', fallbackParams = {}) {
      const t = nav.backTarget(fallback, fallbackParams);
      r.go(t.name, t.params, t.opts);
    },
    at: () => r.cur.name,
  };
  return r;
}

test('Back returns the way the person came, with the params each screen had', () => {
  const r = router();
  r.go('home');
  r.go('settings');
  r.go('nodeSettings');
  r.go('ownNode', { edit: true });
  r.go('ownerKey', { from: 'ownNode' });
  assert.deepEqual(r.nav.names(), ['settings', 'nodeSettings', 'ownNode']);
  r.back('backup');
  assert.deepEqual(r.cur, { name: 'ownNode', params: { edit: true } });
  r.back('nodeSettings');
  assert.equal(r.at(), 'nodeSettings');
  r.back('settings');
  assert.equal(r.at(), 'settings');
  assert.deepEqual(r.nav.names(), []);
});

test('the same screen from two places goes back to each place', () => {
  const r = router();
  r.go('home');
  r.go('receive');
  r.back('home');
  assert.equal(r.at(), 'home');
  r.go('ethHome');
  r.go('ethSwap');
  r.go('buyFiro', { from: 'eth' });
  r.back('home');
  assert.equal(r.at(), 'ethSwap');
  r.back('ethHome');
  assert.equal(r.at(), 'ethHome');
  r.go('bridge', { dir: 'toFiro', back: 'ethHome' });
  r.go('ethReceive');
  r.back('ethHome');
  assert.deepEqual(r.cur, { name: 'bridge', params: { dir: 'toFiro', back: 'ethHome' } });
});

test('roots start a fresh history; Ethereum start is a root only as the Ethereum side', () => {
  for (const s of ['home', 'ethHome', 'activity', 'settings', 'welcome', 'unlock', 'install', 'problem']) assert.ok(isRoot(s), s);
  assert.ok(isRoot('ethStart', {}));
  assert.ok(isRoot('ethStart', { from: 'home' }));
  for (const from of ['settings', 'bridge', 'buy']) assert.equal(isRoot('ethStart', { from }), false, from);
  assert.equal(isRoot('receive'), false);

  const r = router();
  r.go('home');
  r.go('dapps');
  r.go('settings');
  assert.deepEqual(r.nav.names(), []);
  r.go('about');
  r.go('activity');
  assert.deepEqual(r.nav.names(), []);
  r.go('ethHome');
  r.go('ethStart');
  assert.deepEqual(r.nav.names(), []);
});

test('replace moves on without leaving the screen as a Back target; reset forgets everything', () => {
  const r = router();
  r.go('home');
  r.go('send');
  r.go('review', { address: 'a', amount: 1n });
  r.go('txStatus', { txId: 't' }, { replace: true });
  assert.deepEqual(r.nav.names(), ['home', 'send']);
  // A payment's status is never a target, even when left without replace.
  r.go('receive');
  assert.deepEqual(r.nav.names(), ['home', 'send']);

  const s = router();
  s.go('welcome');
  s.go('backup');
  s.go('confirmWords');
  s.go('setPassword');
  s.go('passkeySetup', { first: true }, { reset: true });
  assert.deepEqual(s.nav.names(), []);
  s.go('fastStart', { first: true }, { replace: true });
  assert.deepEqual(s.nav.names(), []);
});

test('a completed flow is never returned to', () => {
  const r = router();
  r.go('home');
  r.go('airdrop');
  r.go('airdropCreate');
  r.go('airdropCodes', { localId: 1, justCreated: true }, { replace: true });
  r.back('airdrop');
  assert.equal(r.at(), 'airdrop');
  r.back('home');
  assert.equal(r.at(), 'home');

  // Ethereum set up from Move coins: back on Move coins, the setup behind it.
  const b = router();
  b.go('home');
  b.go('bridgeMove', { dir: 'toEthereum', back: 'home' });
  b.go('ethStart', { from: 'bridge' });
  b.go('ethImport');
  b.go('ethPrivacy', { setup: true });
  b.go('bridgeMove', { created: 'import' }, { replace: true });
  assert.deepEqual(b.nav.names(), ['home']);
  b.back('home');
  assert.equal(b.at(), 'home');
});

test('going to a screen already in the history goes back to it: Back never loops', () => {
  const r = router();
  r.go('welcome');
  r.go('backup');
  r.go('confirmWords');
  r.go('backup'); // "Show the words again"
  assert.deepEqual(r.nav.names(), ['welcome']);
  r.go('confirmWords');
  r.go('setPassword');
  r.go('confirmWords'); // its Back
  assert.deepEqual(r.nav.names(), ['welcome', 'backup']);

  const e = router();
  e.go('ethHome');
  e.go('ethSwap');
  e.go('buyFiro', { from: 'eth' });
  e.go('ethSwap'); // "Buy rsFIRO"
  assert.deepEqual(e.nav.names(), ['ethHome']);

  // The same screen about something else is another entry.
  const c = router();
  c.go('home');
  c.go('bridgeMove');
  c.go('bridgeList', { back: 'bridgeMove' });
  c.go('bridgeCrossing', { id: 'a', back: 'bridgeList' });
  c.back('bridgeList');
  c.go('bridgeCrossing', { id: 'b', back: 'bridgeList' });
  assert.deepEqual(c.nav.names(), ['home', 'bridgeMove', 'bridgeList']);
  c.go('airdropBatches');
  c.go('airdropCodes', { localId: 2 });
  assert.deepEqual(c.nav.names(), ['home', 'bridgeMove', 'bridgeList', 'bridgeCrossing', 'airdropBatches']);
  c.back('airdropBatches');
  c.back('home');
  assert.deepEqual(c.cur, { name: 'bridgeCrossing', params: { id: 'b', back: 'bridgeList' } });

  // A screen opened again (a retry) does not stack on itself.
  const s = router();
  s.go('ethHome');
  s.go('ethSend');
  s.go('ethSend');
  assert.deepEqual(s.nav.names(), ['ethHome']);
});

test('the lock screen is never a Back target; locking clears the history', () => {
  const r = router();
  r.go('unlock');
  r.go('deleteWallet', { forgot: true });
  assert.deepEqual(r.nav.names(), []);
  r.back('unlock');
  assert.equal(r.at(), 'unlock');
  // After unlock, back to a bridge screen that was open when it locked.
  r.go('bridgeCrossing', { id: 'a', back: 'bridgeMove' });
  assert.deepEqual(r.nav.names(), []);

  const s = router();
  s.go('home');
  s.go('settings');
  s.go('backup');
  s.go('ownerKey');
  s.nav.clear(); // app.lock()
  assert.deepEqual(s.nav.names(), []);
});

test('no history (a reload, an unlock straight into a screen): Back opens the fallback and records nothing', () => {
  const r = router();
  r.go('bridgeCrossing', { id: 'a', back: 'bridgeMove' });
  assert.deepEqual(r.nav.backTarget('bridgeMove'), { name: 'bridgeMove', params: {}, opts: { replace: true } });
  r.back('bridgeMove');
  assert.equal(r.at(), 'bridgeMove');
  assert.deepEqual(r.nav.names(), [], 'the screen left is not a target');
  r.back('ethHome', { tab: 1 });
  assert.deepEqual(r.cur, { name: 'ethHome', params: { tab: 1 } });
});

test('the history is kept short', () => {
  const nav = navHistory({ max: 3 });
  let cur = null;
  for (const n of ['home', 'a', 'b', 'c', 'd', 'e']) {
    nav.move(cur, { name: n, params: {} });
    cur = { name: n, params: {} };
  }
  assert.deepEqual(nav.names(), ['b', 'c', 'd']);
});
