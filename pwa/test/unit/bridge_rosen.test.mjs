// The Bridge screen's figures (lib/bridge_rosen.js): Rosen's fee is $10 or 0.5%, whichever is
// more, in both directions; 0.5% applies from 200 times the minimum ($2,000); fees as large as the
// amount are refused, a cost above 3% warns. The stand-in never moves anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stubQuote, assess, rosen, isRosenFiroAddress, isEvmAddress } from '../../src/lib/bridge_rosen.js';

const F = (n) => BigInt(Math.round(n * 1e8));

test('the fee rule: $10 in FIRO at today\'s price, or 0.5%, whichever is more; plus the destination\'s network fee', () => {
  const q = stubQuote({ to: 'bsc', amount: F(500), firoUsd: 0.9488 });
  assert.equal(q.minBridgeFee, BigInt(Math.ceil((10 / 0.9488) * 1e8)), '$10 at $0.9488, rounded up to a whole satoshi');
  assert.equal(q.bridgeFee, q.minBridgeFee);
  assert.equal(q.networkFee, 1669737n);
  assert.equal(q.receive, F(500) - q.bridgeFee - q.networkFee);
  const big = stubQuote({ to: 'ethereum', amount: F(10000), firoUsd: 0.9488 });
  assert.equal(big.bridgeFee, F(50), '0.5% above the line');
  const back = stubQuote({ to: 'firo', amount: F(3000) });
  assert.equal(back.networkFee, 500452n);
  assert.equal(back.minBridgeFee, F(10.54), 'without a price: the 2026-10-12 figure');
});

test('assess: the 0.5% line is 200 times the minimum; refuse when fees eat the amount; warn above 3%', () => {
  const q = stubQuote({ to: 'bsc', amount: F(100) });
  const v = assess(F(100), q);
  assert.equal(v.breakEven, F(2108));
  assert.equal(v.warn, true);
  assert.equal(v.small, true);
  assert.equal(v.refuse, false);
  assert.ok(v.costPercent > 10 && v.costPercent < 11);
  const tiny = assess(F(10), stubQuote({ to: 'bsc', amount: F(10) }));
  assert.equal(tiny.refuse, true);
  const big = assess(F(5000), stubQuote({ to: 'bsc', amount: F(5000) }));
  assert.equal(big.warn, false);
  assert.equal(big.small, false);
});

test('the screen gets the real Rosen module (lib/rosen); it refuses to quote without a price; destinations are checked', async () => {
  const r = await rosen();
  assert.equal(r.stub, undefined, 'the real module, not the stand-in');
  const q = await r.quote({ from: 'firo', to: 'bsc', amount: F(3000), firoUsd: 0.9486 });
  assert.equal(q.bridgeFee, F(15)); // 0.5% of 3,000
  assert.equal(q.live, true);
  assert.equal(assess(F(3000), q).breakEven, F(2109), "0.5% from where it reaches the declared minimum ($10 at $0.9486): 2,109 FIRO");
  await assert.rejects(async () => r.quote({ from: 'firo', to: 'bsc', amount: F(3000), firoUsd: null }), (e) => e.code === 'no-price');
  assert.equal(isRosenFiroAddress('aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y'), true);
  assert.equal(isRosenFiroAddress(`sm1${'q'.repeat(140)}`), false, 'Spark cannot receive from Rosen');
  assert.equal(isEvmAddress('0x451698faa07fc68301af622a3ad42205f13c6e4b'), true);
});

test('FM-1: a crossing that failed: "nothing was sent" only when it is certain; a lock with no answer is followed and holds the Bridge', async () => {
  const { crossFailure, rememberUnsureLock, unsureLock, forgetUnsureLocks } = await import('../../src/lib/bridge_rosen.js');
  const e = (code, extra = {}) => Object.assign(new Error(code), { code }, extra);
  const TX = 'cd'.repeat(32);
  assert.deepEqual(crossFailure(e('unsure', { txid: TX })), { kind: 'unsure', txid: TX });
  assert.equal(crossFailure(e('offline')).kind, 'not-sent', 'the bytes never reached a node');
  assert.equal(crossFailure(new Error('no code')).kind, 'unknown');
  assert.equal(crossFailure(Object.assign(new TypeError('x is not a function'), { beforeBroadcast: true })).kind, 'not-sent', 'cross() names what failed before the broadcast');
  assert.equal(crossFailure(e('server')).kind, 'not-sent', "a node's refusal");
  for (const c of ['mismatch', 'fee', 'amount', 'route', 'no-price', 'insufficient']) assert.equal(crossFailure(e(c)).kind, 'not-sent', c);
  assert.equal(crossFailure(e('NotYet')).kind, 'not-yet');
  assert.equal(crossFailure(e('unsure', { txid: TX }), { toFiro: true }).kind, 'not-sent', 'rsFIRO -> FIRO fails only before its review signs');

  forgetUnsureLocks();
  const w = { state: { tip: { height: 500 }, txs: [], txsLoaded: true, sync: { canSend: true } } };
  assert.equal(unsureLock(w), null);
  rememberUnsureLock({ txid: TX, at: 0, amount: 2500n, to: 'bsc' });
  assert.equal(unsureLock(w).verdict, 'checking');
  assert.equal(unsureLock(w).lock.txid, TX, 'held while the wallet has not decided');
  w.state.txs = [{ txid: TX, confirmations: 0, unsure: true }];
  assert.equal(unsureLock(w).verdict, 'checking');
  w.state.txs = [{ txid: TX, confirmations: 0, dropped: true }];
  assert.equal(unsureLock(w).verdict, 'gone', 'the network does not have it: said once');
  assert.equal(unsureLock(w), null);
  rememberUnsureLock({ txid: TX, at: 0, amount: 2500n, to: 'bsc' });
  w.state.txs = [{ txid: TX, confirmations: 1 }];
  assert.equal(unsureLock(w), null, 'in a block: Activity has it');
});

test('FM-4: rsFIRO -> FIRO: a network error on the broadcast is not "Sent to Rosen"; the payment\'s status screen follows it', async () => {
  const { rawOutcome } = await import('../../src/lib/eth/send_raw.js');
  const { crossHandedOver } = await import('../../src/lib/bridge_rosen.js');
  const entry = (over = {}) => ({ hash: `0x${'ee'.repeat(32)}`, state: 'signed', refusedAt: null, ...over });
  // broadcast() of lib/eth/send.js: {entry, sent, error}.
  const lost = rawOutcome({ entry: entry(), sent: false, error: Object.assign(new Error('Failed to fetch'), { code: 'network' }) });
  assert.deepEqual(lost, { hash: `0x${'ee'.repeat(32)}`, sent: false, refused: false });
  assert.equal(crossHandedOver(lost), false, 'no answer: not "Sent to Rosen"');
  const refused = rawOutcome({ entry: entry({ refusedAt: 5 }), sent: false, error: new Error('txpool is full') });
  assert.equal(crossHandedOver(refused), false);
  const ok = rawOutcome({ entry: entry({ state: 'pending' }), sent: true, error: null });
  assert.deepEqual(ok, { hash: `0x${'ee'.repeat(32)}`, sent: true, refused: false });
  assert.equal(crossHandedOver(ok), true);
  assert.equal(crossHandedOver({ txid: 'ab'.repeat(32), eventId: 'x' }), true, 'a FIRO lock the node took');
});

test('R-3: a lock in doubt outlives the page: the Bridge reads it from the wallet\'s own payments (one to Rosen\'s FIRO lock address that may have left), with what the page remembers', async () => {
  const { LOCK } = await import('../../src/lib/rosen/rosen.js');
  const TX = 'ab'.repeat(32);
  const lockTx = (over = {}) => ({ txid: TX, direction: 'out', kind: 'transparent', unsure: true, dropped: false, confirmations: 0, counterparty: LOCK.firo, amount: 2500n, ...over });
  const w = { state: { tip: { height: 1 }, txsLoaded: true, sync: { canSend: true }, txs: [lockTx()] } };
  const page1 = await import('../../src/lib/bridge_rosen.js?page=1');
  page1.rememberUnsureLock({ txid: TX, at: 0, amount: 2500n, to: 'bsc' });
  assert.equal(page1.unsureLock(w).verdict, 'checking');
  assert.equal(page1.unsureLock(w).lock.to, 'bsc', "the page's memory first: it knows the chain");
  // The page reloads (iOS evicts it, the app is relaunched, another tab takes the wallet over): a fresh
  // module, which reads Rosen's lock address from lib/rosen (the Bridge screen loads it first).
  const page2 = await import('../../src/lib/bridge_rosen.js?page=2');
  assert.equal(page2.rosenFiroLock(), null, 'no lock address of its own');
  await page2.rosen();
  assert.equal(page2.rosenFiroLock(), LOCK.firo, "Rosen's own lock address, read at runtime");
  assert.equal(page2.ROSEN_FIRO_LOCK, undefined, 'no copy to drift from it');
  const u = page2.unsureLock(w);
  assert.ok(u, 'still held: the engine still follows the first lock and would resend it');
  assert.equal(u.verdict, 'checking');
  assert.equal(u.lock.txid, TX);
  assert.equal(u.lock.amount, 2500n);
  // Not a lock in doubt: let go by the network, in a block, sure, paid to someone else, or received.
  for (const [why, over] of [['dropped', { dropped: true }], ['in a block', { unsure: false, confirmations: 1 }], ['answered by the node', { unsure: false }], ['another payee', { counterparty: 'a1111111111111111111111111111111111' }], ['incoming', { direction: 'in' }]]) {
    assert.equal(page2.unsureLock({ state: { ...w.state, txs: [lockTx(over)] } }), null, why);
  }
});

test('one review per bridge exit: a second review over the same request (the first left while it signs, then Back) never offers it again', async () => {
  await import('./helpers/fake_dom.mjs');
  const { openRawRequest, claimRawRequest, rawRequest, settleRawRequest } = await import('../../src/lib/eth/send_raw.js');
  const ethRawReview = (await import('../../src/screens/eth_raw_review.js')).default;
  const gone = [];
  const app = { currentName: 'bridge', params: {}, go: (name, params) => gone.push({ name, params }) };
  const outcome = openRawRequest(app, { chain: { key: 'bsc', name: 'BNB Chain' } }, { title: 'Bridge rsFIRO to FIRO', amountText: '1 rsFIRO', rows: [] });
  const { id } = gone[0].params;
  assert.equal(gone[0].name, 'ethRawReview');
  assert.equal(claimRawRequest(id), true, 'the first review owns it');
  assert.equal(claimRawRequest(id), false, 'never a second owner');
  // The second review (Back to ethRawReview {id} while the first still signs) shows nothing and leaves.
  const second = ethRawReview(app, { id });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gone.at(-1).name, 'ethHome', 'sent on, never offered again');
  assert.ok(rawRequest(id), 'the first review still settles it');
  settleRawRequest(id, { hash: `0x${'ab'.repeat(32)}`, sent: true });
  assert.equal((await outcome).sent, true);
  assert.equal(claimRawRequest(id), false, 'settled: gone');
  void second;
});

test('a bridge exit whose review never takes it (left before it loaded, or sent to Unlock) is cancelled, never left waiting', async () => {
  const { openRawRequest, rawRequest } = await import('../../src/lib/eth/send_raw.js');
  const app = { currentName: 'bridge', params: {}, go(name) { this.currentName = name === 'ethRawReview' ? 'unlock' : name; } };
  const outcome = openRawRequest(app, { chain: { key: 'bsc', name: 'BNB Chain' } }, { title: 'Bridge rsFIRO to FIRO', amountText: '1 rsFIRO', rows: [] }, { watchMs: 5 });
  await assert.rejects(outcome, (e) => e.code === 'cancelled');
  // On the review screen, unclaimed while it loads: still waiting; it leaves: cancelled.
  const app2 = { currentName: 'bridge', params: {}, go(name, params) { this.currentName = name; this.params = params; } };
  const out2 = openRawRequest(app2, { chain: { key: 'bsc', name: 'BNB Chain' } }, { title: 'Bridge rsFIRO to FIRO', amountText: '1 rsFIRO', rows: [] }, { watchMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(rawRequest(app2.params.id), 'still open while its review loads');
  app2.currentName = 'activity';
  await assert.rejects(out2, (e) => e.code === 'cancelled');
});

test('audit E6: Rosen spends the coins of a payment let go of first, every one of them, then the largest', async () => {
  const { cross } = await import('../../src/lib/rosen/index.js');
  const q = { from: 'firo', to: 'bsc', amount: 250000000000n, bridgeFee: 1250000000n, networkFee: 1669737n, priceAt: Date.now() };
  const coin = (id, amount, extra = {}) => ({ id, kind: 'transparent', spendable: true, frozen: false, amount: String(amount), ...extra });
  let asked = null;
  const engine = {
    coins: { list: async () => [coin('big:0', 300000000000n), coin('first:0', 100000000n, { spendFirst: true }), coin('first:1', 200000000n, { spendFirst: true }), coin('mid:0', 50000000000n)] },
    buildTransparentTx: async ({ inputs }) => {
      asked = inputs;
      throw new Error('stop here');
    },
  };
  await assert.rejects(cross({ app: {}, from: 'firo', to: 'bsc', amount: q.amount, destination: '0x' + '11'.repeat(20), quote: q, backend: engine }), /stop here/);
  assert.deepEqual(asked, ['first:1', 'first:0', 'big:0']);
  // Let-go coins enough on their own: nothing else is added (N13).
  asked = null;
  engine.coins.list = async () => [coin('big:0', 300000000000n), coin('first:0', 260000000000n, { spendFirst: true }), coin('mid:0', 50000000000n)];
  await assert.rejects(cross({ app: {}, from: 'firo', to: 'bsc', amount: q.amount, destination: '0x' + '11'.repeat(20), quote: q, backend: engine }), /stop here/);
  assert.deepEqual(asked, ['first:0']);
});

test('Rosen refuses a quote for another route or amount: nothing is built', async () => {
  const { cross } = await import('../../src/lib/rosen/index.js');
  const q = { from: 'firo', to: 'bsc', amount: 250000000000n, bridgeFee: 1250000000n, networkFee: 1669737n };
  let built = 0;
  const engine = { coins: { list: async () => (built++, []) }, buildTransparentTx: async () => (built++, {}) };
  await assert.rejects(cross({ app: {}, from: 'firo', to: 'ethereum', amount: 250000000000n, destination: '0x' + '11'.repeat(20), quote: q, backend: engine }), (e) => e.code === 'mismatch' && e.beforeBroadcast === true);
  await assert.rejects(cross({ app: {}, from: 'firo', to: 'bsc', amount: 100n, destination: '0x' + '11'.repeat(20), quote: q, backend: engine }), (e) => e.code === 'mismatch');
  await assert.rejects(cross({ app: {}, from: 'firo', to: 'bsc', amount: 250000000000n, destination: '0x' + '11'.repeat(20), quote: { ...q, networkFee: 1n }, backend: engine }), (e) => e.code === 'mismatch');
  assert.equal(built, 0, 'nothing built, nothing chosen');
});

