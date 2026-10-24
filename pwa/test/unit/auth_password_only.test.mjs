// What shows a secret, and turning Face ID on, take the password, never Face ID alone (public
// audit, P2): whoever can unlock the phone (its face, its passcode) must not see the recovery words,
// a private key or a view key, nor add a passkey of theirs. lib/auth_ui.js on a stand-in DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one, body } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
const AUTH = ['/src/lib/auth_ui.js'];
redirect([
  { parents: AUTH, spec: './session.js', to: standIn('session_auth') },
  { parents: AUTH, spec: './passkey.js', to: standIn('passkey_avail') },
]);
const { confirmIdentity } = await import('../../src/lib/auth_ui.js');
const { tries } = await import('./helpers/stand_ins/session_auth.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clear = () => {
  for (const o of body.findAll((el) => el.className.split(/\s+/).includes('overlay'))) o.remove();
  tries.length = 0;
};
const withPasskey = { record: { passkey: true } };

test('with Face ID set up, a payment may use it; showing a secret asks for the password and offers no Face ID', async () => {
  clear();
  const pay = confirmIdentity(withPasskey, { title: 'Confirm the payment' });
  await sleep(700); // the sheet settles
  assert.ok(one('auth-passkey'), 'Face ID offered for a payment');
  one('auth-passkey').click();
  assert.equal(await pay, true);
  assert.deepEqual(tries, [['passkey']]);
  clear();
  const show = confirmIdentity(withPasskey, { title: 'Show your recovery words', passwordOnly: true });
  await sleep(700);
  assert.equal(body.findAll((el) => el.getAttribute && el.getAttribute('data-testid') === 'auth-passkey').length, 0, 'no Face ID button');
  assert.equal(body.findAll((el) => el.getAttribute && el.getAttribute('data-testid') === 'auth-use-password').length, 0);
  assert.match(one('auth-password-only').textContent, /This needs your password: Face ID cannot do it\./);
  one('auth-pw').value = 'wrong';
  one('auth-submit').click();
  await sleep(20);
  one('auth-pw').value = 'right';
  one('auth-submit').click();
  assert.equal(await show, true);
  assert.deepEqual(tries, [['password', 'wrong'], ['password', 'right']], 'never the passkey');
});

test('without Face ID, password-only reads as any other confirmation (no extra line)', async () => {
  clear();
  const p = confirmIdentity({ record: {} }, { title: 'Show the private key', passwordOnly: true });
  await sleep(700);
  assert.equal(body.findAll((el) => el.getAttribute && el.getAttribute('data-testid') === 'auth-password-only').length, 0);
  one('auth-cancel').click();
  assert.equal(await p, false);
});
