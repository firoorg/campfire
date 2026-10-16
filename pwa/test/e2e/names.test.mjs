// Spark names, end to end on the stand-in engine (lib/backend_fake.js: no network, no real funds):
// Settings -> Spark names (empty), Get a Spark name (taken / free / price / not enough private
// FIRO), register, the payment status, the list with the expiry date, Renew.
//
//   npm run e2e:names   (own build folder and port 8833)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, foreignHosts, fake, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome } from './flows.mjs';

const PORT = 8833;
const tid = (id) => `[data-testid="${id}"]`;
const PASSWORD = `names-${Math.random().toString(36).slice(2, 10)}`;
let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-names-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  ({ page, rec } = await recordedPage(ctx, { label: 'names' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function both(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const statusText = () => page.textContent(tid('name-status'));
async function typeName(n) {
  await page.fill(tid('name-input'), n);
  for (let i = 0; i < 40; i++) {
    const t = await statusText();
    if (!/Checking/.test(t)) return t;
    await sleep(100);
  }
  return statusText();
}

test('Settings -> Spark names: none yet, with the way to get one', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('names-row'));
  await waitScreen(page, 'names');
  await page.waitForSelector(tid('names-empty'));
  assert.equal(await page.isVisible(tid('names-get')), true);
  await both('names-01-empty');
});

test('Get a Spark name: taken, invalid, free with its price; not enough private FIRO says how much', { timeout: 2 * 60000 }, async () => {
  await page.click(tid('names-get'));
  await waitScreen(page, 'nameRegister');
  assert.match(await typeName('taken'), /taken/);
  assert.equal(await page.isDisabled(tid('name-confirm')), true);
  assert.match(await typeName('bad name!'), /Only letters/);
  assert.match(await typeName('campfire'), /is free/);
  assert.match(await page.textContent(tid('name-yearly')), /^1 FIRO a year$/);
  await page.selectOption(tid('name-years'), '2');
  assert.match(await page.textContent(tid('name-total')), /^2 FIRO \+ network fee$/);
  await page.waitForSelector(tid('name-short'));
  assert.equal(await page.isDisabled(tid('name-confirm')), true);
  await both('names-02-short');
  assert.match(await typeName('abc'), /is free/);
  assert.match(await page.textContent(tid('name-yearly')), /^10 FIRO a year$/);
});

test('register: confirm with the password, the status names it, the list shows it with its date', { timeout: 2 * 60000 }, async () => {
  await fake.credit(page, { to: 'private', amount: String(5 * 100000000) });
  await fake.mine(page);
  await page.selectOption(tid('name-years'), '1');
  assert.match(await typeName('campfire'), /is free/);
  await page.waitForFunction(() => !document.querySelector('[data-testid="name-confirm"]').disabled, null, { timeout: 30000 });
  assert.equal(await page.textContent(tid('name-confirm')), 'Get @campfire for 1 FIRO');
  await both('names-03-ready');
  await page.click(tid('name-confirm'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await waitScreen(page, 'txStatus', 30000);
  assert.match(await page.textContent(tid('tx-title')), /@campfire/);
  await both('names-04-status');
  await page.evaluate(() => window.__campfire.go('names'));
  await waitScreen(page, 'names');
  await page.waitForSelector(tid('names-list'));
  assert.deepEqual(await page.$$eval(tid('name-row'), (els) => els.map((e) => e.dataset.name)), ['campfire']);
  assert.match(await page.textContent(tid('name-until')), /^Yours until about /);
  await both('names-05-list');
});

test('Renew: the same name, its price for more years', { timeout: 2 * 60000 }, async () => {
  await page.click(tid('name-renew'));
  await waitScreen(page, 'nameRegister');
  assert.equal(await page.inputValue(tid('name-input')), 'campfire');
  assert.equal(await page.isDisabled(tid('name-input')), true);
  await page.waitForFunction(() => /is yours/.test(document.querySelector('[data-testid="name-status"]').textContent));
  await page.selectOption(tid('name-years'), '3');
  assert.equal(await page.textContent(tid('name-confirm')), 'Renew @campfire for 3 FIRO');
  await both('names-06-renew');
});

test('Settings -> Coins: public and private coins; freeze a public coin; a note stays with it', { timeout: 2 * 60000 }, async () => {
  await fake.credit(page, { to: 'public', amount: String(2 * 100000000) });
  await fake.mine(page);
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('coins-row'));
  await waitScreen(page, 'coins');
  await page.waitForSelector(tid('coins-public'));
  assert.equal(await page.$$eval(`${tid('coins-public')} ${tid('coin-row')}`, (els) => els.length), 1);
  assert.equal(await page.$$eval(`${tid('coins-private')} ${tid('coin-row')}`, (els) => els.length), 1);
  assert.equal(await page.$$eval(`${tid('coins-private')} ${tid('coin-freeze')}`, (els) => els.length), 0, 'private coins have no Freeze');
  await page.click(`${tid('coins-public')} ${tid('coin-freeze')}`);
  await page.waitForSelector(`${tid('coins-public')} [data-frozen="true"]`);
  await page.click(`${tid('coins-public')} ${tid('coin-note')}`);
  await page.fill(tid('coin-note-input'), 'Masternode collateral');
  await page.click(tid('coin-note-save'));
  await page.waitForFunction(() => /Masternode collateral/.test(document.querySelector('[data-testid="coins-public"] [data-testid="coin-label"]')?.textContent || ''));
  await both('coins-01');
});

test('Settings -> Masternodes: none here; says what one needs', { timeout: 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('masternodes-row'));
  await waitScreen(page, 'masternodes');
  await page.waitForSelector(tid('mn-empty'));
  assert.match(await page.textContent('main'), /1,000 FIRO as collateral/);
  await both('masternodes-01-empty');
});

test('pay @satoshi: Review shows the whole address and that two servers agree; a name that changed stops until accepted', { timeout: 3 * 60000 }, async () => {
  await fake.credit(page, { to: 'private', amount: String(2 * 100000000) });
  await fake.mine(page);
  async function typeTo(text) {
    await page.evaluate(() => window.__campfire.go('send'));
    await waitScreen(page, 'send');
    await page.fill(tid('send-address'), text);
  }
  await typeTo('@satoshi');
  await page.waitForFunction(() => /is a Spark name for/.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''), null, { timeout: 30000 });
  await page.fill(tid('send-amount'), '0.1');
  await page.waitForFunction(() => !document.querySelector('[data-testid="review"]').disabled, null, { timeout: 30000 });
  await page.click(tid('review'));
  await waitScreen(page, 'review');
  const before = (await page.textContent(tid('review-to'))).trim();
  assert.ok(before.startsWith('sm1') && before.length > 100, `the whole address, not a shortened one: ${before}`);
  assert.equal(await page.textContent(tid('review-name-checked')), 'Two Firo nodes agree on this address.');
  await both('names-06-review-name');
  await page.click(tid('confirm-send'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await waitScreen(page, 'txStatus', 30000);

  // The server now answers another address for @satoshi (re-registered, or lying).
  const now = await page.evaluate(async () => {
    const { wallet } = await import('./lib/wallet.js');
    const other = await wallet.resolveSparkName('campfire');
    globalThis.__firoFake.renameTo('satoshi', other);
    return other;
  });
  await typeTo('@satoshi');
  await page.waitForSelector(tid('name-changed'), { timeout: 30000 });
  assert.equal((await page.textContent(tid('name-before'))).trim(), before);
  assert.equal((await page.textContent(tid('name-now'))).trim(), now);
  assert.match(await page.textContent(tid('address-hint')), /different address than the one you paid before/);
  await page.fill(tid('send-amount'), '0.1');
  await sleep(1500);
  assert.equal(await page.isDisabled(tid('review')), true, 'nothing to review until the person decides');
  await both('names-07-name-changed');
  await page.click(tid('name-accept-new'));
  await page.waitForFunction(() => /is a Spark name for/.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''), null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="review"]').disabled, null, { timeout: 30000 });
});

test('a private payment: the coin-list check is said while it runs; a list that does not check out stops it, with another server to try (audit D-09)', { timeout: 3 * 60000 }, async () => {
  async function toReview() {
    await page.evaluate(() => window.__campfire.go('send'));
    await waitScreen(page, 'send');
    // @campfire: never paid before (the test above left @satoshi waiting on a decision).
    await page.fill(tid('send-address'), '@campfire');
    await page.waitForFunction(() => /is a Spark name for/.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''), null, { timeout: 30000 });
    await page.fill(tid('send-amount'), '0.1');
    await page.waitForFunction(() => !document.querySelector('[data-testid="review"]').disabled, null, { timeout: 30000 });
    await page.click(tid('review'));
    await waitScreen(page, 'review');
  }
  async function confirm() {
    await page.click(tid('confirm-send'));
    await page.waitForSelector(tid('auth-pw'));
    await page.fill(tid('auth-pw'), PASSWORD);
    await page.click(tid('auth-submit'));
  }
  // The first payment from a set waits on the check: the person is told what it waits on.
  await toReview();
  await page.evaluate(() => globalThis.__firoFake.slowCoinCheck(4000));
  await confirm();
  await page.waitForSelector(tid('review-checking-coins'), { timeout: 10000 });
  assert.match(await page.textContent(tid('review-checking-coins')), /^Checking the list of private coins with a second Firo node, so your payment stays private\. The first private payment can take up to a minute\.$/);
  assert.equal(await page.textContent(tid('confirm-send')), 'Sending…');
  await both('names-08-checking-coins');
  await waitScreen(page, 'txStatus', 30000);

  // A list that does not check out: nothing is sent, and another server is offered.
  await toReview();
  await page.evaluate(() => globalThis.__firoFake.refuseSets('set-mismatch'));
  await confirm();
  await page.waitForSelector(tid('review-error'), { timeout: 30000 });
  assert.match(await page.textContent(tid('review-error')), /Nothing left your wallet\./);
  assert.equal(await page.locator(tid('review-checking-coins')).count(), 0);
  await both('names-09-coin-list-refused');
  await page.click(tid('review-other-server'));
  await page.waitForSelector(tid('review-other-server-done'), { timeout: 30000 });
  await both('names-10-other-server');
});

test('a payment the node never answered (audit FM-1): never "not sent"; it may have left, followed until it is seen or dropped', { timeout: 3 * 60000 }, async () => {
  async function pay() {
    await page.evaluate(() => window.__campfire.go('send'));
    await waitScreen(page, 'send');
    await page.fill(tid('send-address'), '@campfire');
    await page.waitForFunction(() => /is a Spark name for/.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''), null, { timeout: 30000 });
    await page.fill(tid('send-amount'), '0.1');
    await page.waitForFunction(() => !document.querySelector('[data-testid="review"]').disabled, null, { timeout: 30000 });
    await page.click(tid('review'));
    await waitScreen(page, 'review');
    await page.click(tid('confirm-send'));
    await page.waitForSelector(tid('auth-pw'));
    await page.fill(tid('auth-pw'), PASSWORD);
    await page.click(tid('auth-submit'));
    await waitScreen(page, 'txStatus', 30000);
  }
  // It had reached the network: "may have left", then seen, then in a block. Blocks only on cue.
  await page.evaluate(() => globalThis.__firoFake.hold(true));
  await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: true }));
  await pay();
  await page.waitForSelector(tid('tx-unsure'));
  assert.match(await page.textContent(tid('tx-unsure')), /^Your payment may have left\. Don't send it again yet: Campfire is checking\./);
  assert.equal(await page.getAttribute(tid('tx-title'), 'data-state'), 'unsure');
  assert.equal(await page.textContent(tid('tx-title')), 'Checking your payment…');
  assert.doesNotMatch(await page.textContent('main'), /not sent|Nothing left/i);
  await both('names-11-unsure');
  await fake.mine(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.dataset.state === 'pending', null, { timeout: 30000 });
  assert.equal(await page.textContent(tid('tx-title')), 'Payment sent');
  await fake.mine(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.dataset.state === 'done', null, { timeout: 30000 });
  // It never left: still "may have left" until the engine knows, then "Not sent".
  await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: false }));
  await pay();
  await page.waitForSelector(tid('tx-unsure'));
  await fake.mine(page);
  assert.equal(await page.getAttribute(tid('tx-title'), 'data-state'), 'unsure', 'not given up after one block');
  await fake.mine(page);
  await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.dataset.state === 'dropped', null, { timeout: 30000 });
  assert.equal(await page.textContent(tid('tx-title')), 'Not sent');
  assert.match(await page.textContent(tid('tx-dropped')), /did not go through.*nothing left your wallet/);
  await both('names-12-dropped');
  await page.evaluate(() => globalThis.__firoFake.hold(false));
  await page.click(tid('tx-done'));
  await waitScreen(page, 'home');
});

test('a payment the node in use says never left, with no second node for an hour (re-audit 3 RE3-3): its screen and its details offer to let it go; only the tap frees it', { timeout: 3 * 60000 }, async () => {
  async function pay() {
    await page.evaluate(() => window.__campfire.go('send'));
    await waitScreen(page, 'send');
    await page.fill(tid('send-address'), '@campfire');
    await page.waitForFunction(() => /is a Spark name for/.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''), null, { timeout: 30000 });
    await page.fill(tid('send-amount'), '0.1');
    await page.waitForFunction(() => !document.querySelector('[data-testid="review"]').disabled, null, { timeout: 30000 });
    await page.click(tid('review'));
    await waitScreen(page, 'review');
    await page.click(tid('confirm-send'));
    await page.waitForSelector(tid('auth-pw'));
    await page.fill(tid('auth-pw'), PASSWORD);
    await page.click(tid('auth-submit'));
    await waitScreen(page, 'txStatus', 30000);
  }
  const state = () => page.getAttribute(tid('tx-title'), 'data-state');
  await fake.credit(page, { to: 'private', amount: String(100000000) });
  await page.waitForFunction(() => BigInt(window.__campfire.balance().private.available) >= 100000000n, null, { timeout: 30000 });
  await page.evaluate(() => globalThis.__firoFake.hold(true));
  try {
    // The payment's screen: offered once the node in use has said so for an hour; the tap lets it go.
    await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: false, oneNode: true }));
    await pay();
    await page.waitForSelector(tid('tx-unsure'));
    assert.equal(await page.$(tid('let-go')), null, 'nothing to let go before the hour');
    await fake.mine(page);
    await fake.mine(page);
    await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.dataset.state === 'one-node', null, { timeout: 30000 });
    assert.equal(await page.textContent(tid('tx-title')), 'Checking your payment…');
    assert.match(await page.textContent(tid('let-go')), /^The Firo node in use says it never left: you can let it go\. That is one node's word: no other Firo node could be reached for an hour to check it\. Letting it go makes its FIRO spendable again\. If it did leave, sending again pays twice\./);
    const spent = (await page.evaluate(() => window.__campfire.balance())).private.available;
    await fake.mine(page);
    assert.equal(await state(), 'one-node', 'never let go by the engine');
    await both('names-13-one-node');
    await page.click(tid('let-go-button'));
    await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.dataset.state === 'let-go', null, { timeout: 30000 });
    assert.equal(await page.textContent(tid('tx-title')), 'Let go');
    assert.match(await page.textContent(tid('tx-let-go')), /^You let it go on the word of the Firo node in use: its FIRO is spendable again\./);
    assert.ok(BigInt((await page.evaluate(() => window.__campfire.balance())).private.available) > BigInt(spent), 'its FIRO is back');
    await both('names-14-let-go');
    // Activity's details offer it too, and say what became of it.
    await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: false, oneNode: true }));
    await pay();
    await fake.mine(page);
    await fake.mine(page);
    await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.dataset.state === 'one-node', null, { timeout: 30000 });
    const txid = await page.getAttribute(tid('let-go'), 'data-txid');
    await page.evaluate((t) => window.__campfire.go('activity', { txid: t }), txid);
    await waitScreen(page, 'activity');
    await page.waitForSelector(tid('let-go'), { timeout: 30000 });
    assert.match(await page.textContent(tid('tx-status')), /The Firo node in use says it never left/);
    await page.click(tid('let-go-button'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="let-go"]'), null, { timeout: 30000 });
    await page.click(`[data-txid="${txid}"]`);
    await page.waitForSelector(tid('tx-status'));
    assert.match(await page.textContent(tid('tx-status')), /Let go on the word of the Firo node in use/);
    assert.equal(await page.textContent(tid('tx-detail-title')), 'Let go');
    await page.keyboard.press('Escape');
    // The node in use answers otherwise at the tap (re-audit 4 RE4-3): "didn't answer" is said in the
    // offer, which stays (no toast over its button); "has it now" withdraws the offer and a toast says why.
    await page.evaluate(() => globalThis.__firoFake.unsureNext({ arrives: false, oneNode: true }));
    await pay();
    await fake.mine(page);
    await fake.mine(page);
    await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.dataset.state === 'one-node', null, { timeout: 30000 });
    const OFFLINE = "The Firo node in use didn't answer, so the payment was not let go. Try again in a moment.";
    await page.evaluate(() => globalThis.__firoFake.letGoNext('offline'));
    await page.click(tid('let-go-button'));
    await page.waitForSelector(tid('let-go-error'), { timeout: 30000 });
    assert.equal(await page.textContent(tid('let-go-error')), OFFLINE, 'said with the offer');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate((w) => [...document.querySelectorAll('.toast')].some((t) => t.textContent === w), OFFLINE), false, 'no toast over the offer\'s button');
    assert.equal(await state(), 'one-node', 'still offered');
    await both('names-15-let-go-offline');
    const SEEN = 'The Firo node in use has this payment now: it is on its way, so it was not let go.';
    await page.evaluate(() => globalThis.__firoFake.letGoNext('seen'));
    await page.click(tid('let-go-button'));
    await page.waitForFunction((w) => document.querySelector('.toast')?.textContent === w, SEEN, { timeout: 30000 });
    assert.equal(await page.$(tid('let-go')), null, 'the offer is withdrawn: the node has it now');
    assert.notEqual(await state(), 'one-node');
    await both('names-16-let-go-seen');
  } finally {
    await page.evaluate(() => globalThis.__firoFake.hold(false));
  }
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
});

test('Review sends the figures it shows (audit FE-3): a fee that changed during the confirmation is shown, never paid silently', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('send'));
  await waitScreen(page, 'send');
  await page.fill(tid('send-address'), '@campfire');
  await page.waitForFunction(() => /is a Spark name for/.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''), null, { timeout: 30000 });
  await page.fill(tid('send-amount'), '0.1');
  await page.waitForFunction(() => !document.querySelector('[data-testid="review"]').disabled, null, { timeout: 30000 });
  await page.click(tid('review'));
  await waitScreen(page, 'review');
  const feeBefore = await page.textContent(tid('review-fee'));
  // A coin arrives while the person confirms: the engine would pay another fee.
  await page.evaluate(() => globalThis.__firoFake.feeChangeNext(7000));
  await page.click(tid('confirm-send'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await page.waitForSelector(tid('review-fee-changed'), { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__campfire.screen()), 'review', 'still on Review: nothing was sent');
  assert.notEqual(await page.textContent(tid('review-fee')), feeBefore);
  assert.match(await page.textContent(tid('review-fee-changed')), /^The network fee changed to .* FIRO\. Check the total, then send\.$/);
  await both('names-13-fee-changed');
  await page.click(tid('confirm-send'));
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
  await waitScreen(page, 'txStatus', 30000);
});

test('privacy: no host but the origin; no CSP violation; no page error', async () => {
  assert.deepEqual(foreignHosts(rec, srv.url), []);
  assert.deepEqual(await page.evaluate(() => window.__cspViolations), []);
  assert.deepEqual(rec.errors, []);
});
