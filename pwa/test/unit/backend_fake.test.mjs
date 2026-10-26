// The stand-in engine (lib/backend_fake.js) behind the seam (lib/chain.js) implements the whole
// contract of WALLET_API.md, so the screens can be built and tested before the real engine lands.
// These tests are the contract as the shell relies on it: when the core stream's engine replaces
// the fake, the same expectations should hold for it (amounts as satoshi strings, phases, errors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, keys, memoryStore, backendKind, ENGINE, ERROR_CODES, isNotYet, useEngine, isTestHost } from '../../src/lib/chain.js';
import '../../src/lib/backend_fake.js';

const RESTORED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SAT = /^\d+$/;
globalThis.__firoFake.speed(2);
useEngine('fake');

async function opened(words = RESTORED, store = memoryStore()) {
  const b = await createBackend({ store });
  let last = null;
  b.subscribe((s) => (last = s));
  await b.open({ mnemonic: words });
  await until(() => last && last.sync.phase === 'done');
  return { b, state: () => last, store };
}

async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the seam: the real engine; the stand-in only where a test pins it or a test host asks', async () => {
  assert.equal(ENGINE, 'real');
  assert.equal(await backendKind(), 'fake', 'pinned by this test');
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'campfire.test', 'mirror.test']) assert.equal(isTestHost(h), true, h);
  for (const h of ['campfire.app', 'pwa.buyfiro.app', 'localhost.example.com', 'test', 'mytest']) assert.equal(isTestHost(h), false, h);
  assert.deepEqual([...ERROR_CODES].sort(), ['NotYet', 'dust', 'insufficient', 'invalid-address', 'not-synced', 'offline', 'server'].sort());
});

test('keys: real BIP39 words, 12 or 24; validation says what is wrong', async () => {
  const k = await keys();
  const m24 = k.generateMnemonic(24);
  const m12 = k.generateMnemonic(12);
  assert.equal(m24.split(' ').length, 24);
  assert.equal(m12.split(' ').length, 12);
  assert.deepEqual(k.validateMnemonic(m24), { ok: true });
  assert.deepEqual(k.validateMnemonic(`  ${m12.toUpperCase()}  `), { ok: true }, 'case and spaces do not matter');
  assert.match(k.validateMnemonic('abandon abandon').error, /12, 15, 18, 21 or 24 words/);
  assert.match(k.validateMnemonic(RESTORED.replace('about', 'aboutt')).error, /Word 12/);
  assert.match(k.validateMnemonic(RESTORED.replace('about', 'abandon')).error, /not a valid recovery phrase/);
});

test('state: the contract shape, amounts as satoshi strings, phases in order, then done', async () => {
  const b = await createBackend({ store: memoryStore() });
  const phases = [];
  b.subscribe((s) => phases[phases.length - 1] !== s.sync.phase && phases.push(s.sync.phase));
  await b.open({ mnemonic: RESTORED });
  await until(() => phases.includes('done'));
  assert.deepEqual(phases.filter((p, i) => phases.indexOf(p) === i), ['connecting', 'transparent', 'spark-sets', 'spark-tags', 'spark-identify', 'done']);
  const s = b.getState();
  assert.equal(s.network, 'main');
  assert.equal(s.connected, true);
  assert.match(s.server, /^wss:\/\/electrumx\.firo\.org:50004$/);
  assert.ok(Number.isSafeInteger(s.tip.height) && Number.isSafeInteger(s.tip.time));
  for (const side of ['private', 'public']) for (const k of ['available', 'pending']) assert.match(s.balance[side][k], SAT);
  assert.equal(s.balance.private.available, '309980000', 'a restored wallet comes back with its sample history');
  assert.equal(s.balance.public.available, '54990000');
  assert.equal(s.txs.length, 5);
  for (const t of s.txs) {
    assert.match(t.txid, /^[0-9a-f]{64}$/);
    assert.ok(['in', 'out', 'self'].includes(t.direction));
    assert.ok(['transparent', 'privatize', 'spark', 'spark-name', 'lelantus', 'coinbase', 'masternode'].includes(t.kind));
    assert.match(t.amount, SAT);
    assert.match(t.fee, SAT);
  }
  assert.ok(s.txs.every((t, i) => i === 0 || s.txs[i - 1].time >= t.time), 'newest first');
  assert.match(s.receive.spark, /^sm1[02-9ac-hj-np-z]{100,}$/);
  assert.match(s.receive.transparent, /^a[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.equal(s.viewOnly, false);
  await b.close();
  assert.equal(b.getState().txs.length, 0, 'closed: nothing left in memory');
});

test('a wallet made from words generated here starts empty', async () => {
  const k = await keys();
  const { b, state } = await opened(k.generateMnemonic(24));
  assert.equal(state().balance.private.available, '0');
  assert.equal(state().txs.length, 0);
  await b.close();
});

test('the same words open the same wallet; what it did is kept in its store', async () => {
  const store = memoryStore();
  const one = await opened(RESTORED, store);
  const addr = one.state().receive.spark;
  const fresh = await one.b.newSparkAddress();
  assert.notEqual(fresh, addr);
  await one.b.close();
  const two = await opened(RESTORED, store);
  assert.equal(two.state().receive.spark, fresh, 'the newest address comes back');
  await two.b.close();
});

test('classifyAddress: Spark, transparent, exchange, Spark names (with or without @), invalid', async () => {
  const { b, state } = await opened();
  assert.equal(b.classifyAddress(state().receive.spark).kind, 'spark');
  assert.equal(b.classifyAddress(state().receive.transparent).kind, 'transparent');
  assert.equal(b.classifyAddress(`EX${'k'.repeat(34)}`).kind, 'exchange');
  assert.deepEqual(b.classifyAddress('@Satoshi'), { kind: 'spark-name', name: 'satoshi' });
  assert.deepEqual(b.classifyAddress('campfire'), { kind: 'spark-name', name: 'campfire' });
  assert.equal(b.classifyAddress('hello world').kind, 'invalid');
  assert.equal(b.classifyAddress(`st1${'q'.repeat(100)}`).kind, 'invalid', 'a testnet Spark address on mainnet');
  assert.match(await b.resolveSparkName('satoshi'), /^sm1/);
  assert.equal(await b.resolveSparkName('nobody'), null);
  await b.close();
});

test('quote and send: the fee, the total, warnings in words; the payment confirms in the next block', async () => {
  const { b, state } = await opened();
  const to = state().receive.transparent.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  const q = await b.quote({ from: 'private', to: [{ address: to, amount: '10000000' }] });
  assert.deepEqual(Object.keys(q).sort(), ['change', 'fee', 'total', 'warnings']);
  assert.equal(q.fee, '20000');
  assert.equal(q.total, '10020000');
  assert.match(q.warnings[0], /public/);
  const all = await b.quote({ from: 'private', to: [{ address: '@satoshi', amount: state().balance.private.available, memo: 'all of it' }], subtractFee: true });
  assert.equal(all.total, state().balance.private.available, 'Max: the fee comes out of the amount');
  const { txid } = await b.send({ from: 'private', to: [{ address: '@satoshi', amount: '50000000', memo: 'Thanks' }] });
  const t = state().txs.find((x) => x.txid === txid);
  assert.equal(t.direction, 'out');
  assert.equal(t.kind, 'spark');
  assert.equal(t.memo, 'Thanks');
  assert.equal(t.confirmations, 0);
  assert.equal(state().balance.private.available, String(309980000 - 50000000 - 20000));
  globalThis.__firoFake.mine();
  assert.ok(state().txs.find((x) => x.txid === txid).confirmations >= 1);
  await b.close();
});

test('errors carry the contract codes and plain words', async () => {
  const { b, state } = await opened();
  const spark = state().receive.spark;
  const code = async (p, c) => assert.rejects(p, (e) => e.code === c && typeof e.message === 'string' && e.message.length > 10, c);
  await code(b.quote({ from: 'private', to: [{ address: 'nope nope', amount: '1000' }] }), 'invalid-address');
  await code(b.quote({ from: 'private', to: [{ address: '@nobody', amount: '100000' }] }), 'invalid-address');
  await code(b.quote({ from: 'private', to: [{ address: spark, amount: '999' }] }), 'dust');
  await code(b.quote({ from: 'public', to: [{ address: spark, amount: '100000000000' }] }), 'insufficient');
  await code(b.quote({ from: 'private', to: [{ address: `EX${'k'.repeat(34)}`, amount: '100000' }] }), 'invalid-address');
  await code(b.quote({ from: 'public', to: [{ address: state().receive.transparent, amount: '100000', memo: 'x' }] }), 'invalid-memo');
  globalThis.__firoFake.offline(true);
  assert.equal(state().sync.phase, 'error');
  assert.equal(state().connected, false);
  await code(b.send({ from: 'private', to: [{ address: spark, amount: '100000' }] }), 'offline');
  globalThis.__firoFake.offline(false);
  await until(() => state().sync.phase === 'done');
  await b.close();
});

test('privatize: all of the public balance, the fee taken from it; then private once confirmed', async () => {
  const { b, state } = await opened();
  const pub = BigInt(state().balance.public.available);
  const { txid } = await b.privatize({ amount: 'all' });
  const t = state().txs.find((x) => x.txid === txid);
  assert.equal(t.kind, 'privatize');
  assert.equal(t.direction, 'self');
  assert.equal(BigInt(t.amount) + BigInt(t.fee), pub);
  assert.equal(state().balance.public.available, '0');
  assert.equal(state().balance.private.pending, t.amount, 'arriving privately until the block');
  globalThis.__firoFake.mine();
  assert.equal(state().balance.private.pending, '0');
  await assert.rejects(b.privatize({ amount: 'all' }), (e) => e.code === 'insufficient');
  await b.close();
});

test('the later milestones: rescan, clear the Spark cache and servers work in the stand-in; the rest say NotYet', async () => {
  const { b, state } = await opened();
  await b.rescan({ fromHeight: 1000000 });
  assert.notEqual(state().sync.phase, 'done');
  await until(() => state().sync.phase === 'done');
  await b.clearSparkCache();
  await until(() => state().sync.phase === 'done');
  await b.setServers([{ url: 'wss://electrum.example.com:50004' }]);
  await until(() => state().sync.phase === 'done');
  assert.equal(state().server, 'wss://electrum.example.com:50004');
  await assert.rejects(b.setServers([{ url: 'http://x' }]), (e) => e.code === 'invalid');
  for (const p of [b.exportSparkViewKey(), b.exportXpub(), b.masternodes.register(), b.rosen.quote()]) await assert.rejects(p, (e) => isNotYet(e));
  assert.deepEqual(await b.masternodes.list(), []);
  // Coins in the stand-in: a list; private coins cannot be frozen.
  assert.ok(Array.isArray(await b.coins.list()));
  await assert.rejects(b.coins.freeze('b'.repeat(64), true), (e) => isNotYet(e));
  // Spark names in the stand-in: free/taken, the price by length, register then renew.
  assert.equal(await b.sparkNames.isFree('taken'), false);
  assert.equal(await b.sparkNames.isFree('campfire'), true);
  assert.equal(b.sparkNames.feeFiro('campfire', 2), 2);
  assert.equal(b.sparkNames.feeFiro('abc'), 10);
  await b.sparkNames.register({ name: 'campfire', years: 1 });
  const mine = await b.sparkNames.listDetailed();
  assert.deepEqual(mine.map((n) => n.name), ['campfire']);
  const before = mine[0].validUntil;
  await b.sparkNames.renew({ name: 'campfire', years: 1 });
  assert.equal((await b.sparkNames.listDetailed())[0].validUntil, before + 210240);
  // As the real engine: one own name asked about by name, on request (audit D-10).
  assert.deepEqual(await b.sparkNames.details('@campfire'), { validUntil: before + 210240, additionalInfo: '' });
  await assert.rejects(b.sparkNames.details('taken'), (e) => e.code === 'invalid-name');
  assert.equal(await b.sparkNames.isFree('campfire'), false);
  await b.close();
});

test('test controls: a payment credited arrives unconfirmed, then confirms', async () => {
  const { b, state } = await opened();
  const txid = globalThis.__firoFake.credit({ to: 'private', amount: '12345678', memo: 'hi' });
  const t = state().txs.find((x) => x.txid === txid);
  assert.equal(t.direction, 'in');
  assert.equal(t.memo, 'hi');
  assert.equal(state().balance.private.pending, '12345678');
  globalThis.__firoFake.mine();
  assert.equal(state().balance.private.pending, '0');
  await b.close();
});

test('as the real engine: one payment at a time; a second while one is on its way is refused as not sent (release verification 0.1.8)', async () => {
  const { b, state } = await opened();
  const spark = state().receive.spark;
  const before = state().txs.length;
  const first = b.send({ from: 'private', to: [{ address: '@satoshi', amount: '1000000' }] });
  for (const p of [b.send({ from: 'private', to: [{ address: '@satoshi', amount: '1000000' }] }), b.privatize({ amount: 'all' }), b.sparkNames.register({ name: 'onetime', years: 1 })]) {
    await assert.rejects(p, (e) => e.code === 'in-flight' && /was not sent/.test(e.message));
  }
  await first;
  assert.equal(state().txs.length, before + 1, 'one payment');
  await b.send({ from: 'private', to: [{ address: spark, amount: '1000000' }] });
  assert.equal(state().txs.length, before + 2, 'the next one goes once the first has left');
  await b.close();
});
