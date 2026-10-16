// A sheet that just opened answers nothing for a moment (lib/ui.js openSheet, release verification
// 0.1.8): the second tap of a double tap on a button lands on the sheet that button opened, on its
// Cancel or its confirm ("Yes, bridge it", "Send", "Swap", "Allow"), and answered for the person
// before they read it. Taps (and Enter / Space, which are clicks) inside the sheet are held for
// SHEET_SETTLE_MS, a tap beside it does not close it meanwhile, and assistive technology and
// browser automation are told (aria-disabled) until it settles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one, body } from './helpers/fake_dom.mjs';
import { h } from '../../src/lib/dom.js';
import { openSheet, SHEET_SETTLE_MS } from '../../src/lib/ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function confirmSheet(opts) {
  const said = [];
  const sheet = openSheet(
    (close) => [
      h('h2', { text: 'Send 500 FIRO?' }),
      h('button', { class: 'btn btn-primary', 'data-testid': 'sheet-yes', onclick: () => (said.push('yes'), close(true)) }, h('span', { text: 'Send' })),
      h('button', { class: 'btn btn-text', 'data-testid': 'sheet-no', onclick: () => (said.push('no'), close(false)) }, 'Cancel'),
    ],
    opts,
  );
  let answer;
  sheet.then((v) => (answer = v));
  return { sheet, said, answer: () => answer };
}

test('a sheet that just opened: its buttons answer nothing (the second tap of a double tap), then answer as usual', async () => {
  body.replaceChildren();
  const s = confirmSheet();
  assert.equal(SHEET_SETTLE_MS, 600);
  const panel = body.findAll((el) => el.className === 'sheet')[0];
  assert.equal(panel.getAttribute('aria-busy'), 'true', 'told while it settles');
  assert.equal(one('sheet-yes').getAttribute('aria-disabled'), 'true', 'its buttons too');
  assert.equal(panel.getAttribute('aria-disabled'), null, 'never the whole (a field in it would read as dimmed)');
  await one('sheet-yes').tap();
  await one('sheet-no').tap();
  // A tap on what is inside a button (its label) is held too.
  await one('sheet-yes').childNodes[0].tap();
  assert.deepEqual(s.said, []);
  assert.equal(s.sheet.closed, false);
  await sleep(SHEET_SETTLE_MS + 20);
  assert.equal(panel.getAttribute('aria-busy'), null, 'settled');
  assert.equal(one('sheet-yes').getAttribute('aria-disabled'), null, 'its buttons answer');
  await one('sheet-yes').tap();
  assert.deepEqual(s.said, ['yes']);
  assert.equal(s.answer(), true);
});

test('a tap beside a sheet that just opened does not close it; once settled it does', async () => {
  body.replaceChildren();
  const s = confirmSheet();
  const overlay = body.findAll((el) => el.className === 'overlay')[0];
  await overlay.tap();
  assert.equal(s.sheet.closed, false);
  await sleep(SHEET_SETTLE_MS + 20);
  await overlay.tap();
  assert.equal(s.sheet.closed, true);
  assert.equal(s.answer(), undefined);
});

test('a sheet that cannot be closed by a tap beside it: held the same way, and redrawn buttons too', async () => {
  body.replaceChildren();
  const s = confirmSheet({ dismissable: false });
  s.sheet.rerender();
  await one('sheet-yes').tap();
  assert.deepEqual(s.said, []);
  await sleep(SHEET_SETTLE_MS + 20);
  await one('sheet-no').tap();
  assert.deepEqual(s.said, ['no']);
  assert.equal(s.answer(), false);
});

test('a device clock set back while a sheet settles never holds its taps for as long (monotonic time)', async () => {
  body.replaceChildren();
  const said = [];
  const realNow = Date.now;
  openSheet((close) => [h('button', { 'data-testid': 'p-change', onclick: () => (said.push('change'), close(null)) }, 'Change')], { dismissable: false });
  Date.now = () => realNow() - 3600000; // a clock correction backwards, just after it opened
  try {
    await sleep(SHEET_SETTLE_MS + 200);
    await one('p-change').tap();
    assert.deepEqual(said, ['change'], 'answered once it settled, whatever the wall clock says');
  } finally {
    Date.now = realNow;
  }
});

test('A8a: while a sheet settles, only its buttons are marked: a field in it is never read as dimmed', async () => {
  body.replaceChildren();
  openSheet(() => [h('input', { 'data-testid': 'pw', type: 'password' }), h('button', { 'data-testid': 'ok' }, 'Confirm')]);
  const panel = body.findAll((el) => el.className === 'sheet')[0];
  assert.equal(panel.getAttribute('aria-disabled'), null);
  assert.equal(one('pw').getAttribute('aria-disabled'), null, 'the field is not marked');
  assert.equal(one('ok').getAttribute('aria-disabled'), 'true');
  await sleep(SHEET_SETTLE_MS + 20);
  assert.equal(one('ok').getAttribute('aria-disabled'), null);
});
