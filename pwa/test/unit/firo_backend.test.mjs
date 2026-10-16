// The WALLET_API backend end to end against a fake chain and a fake Spark
// client: open, sync, balances, history, receive addresses, sending from the
// public and the private balance, privatizing, names, view-only, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackend, FiroBackend, anchorPositions, placeByAnchors, MAX_PAYMENT_FEE } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { buildSignedTransaction, decodeTx, verifyP2PKHInput, serializeTx } from '../../src/lib/firo/tx.js';
import { addressToScript, exchangeAddress } from '../../src/lib/firo/address.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { ElectrumError } from '../../src/lib/firo/electrum.js';
import { hexToBytes, bytesToHex, sha256d, hash160, concatBytes, hashToHex, bytesToBase64 } from '../../src/lib/firo/bytes.js';
import { assessSync } from '../../src/lib/sync.js';
import { sendOutcome } from '../../src/lib/send_outcome.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, fakeCoin, fakeTag, headerHex } from '../fixtures/firo_fake_chain.mjs';
import { FakeSpark } from '../fixtures/firo_fake_spark.mjs';

const MAIN = NETWORKS.main;
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const W = KEYS.vectors[0]; // "abandon … about": our wallet
const OTHER = KEYS.vectors[2].addresses[0]; // somebody else
const URL1 = 'wss://fake.example:50004';
const URL2 = 'wss://fake2.example:50004';
const COIN = 100000000n;

/**
 * The wallet on a fake chain, served by the node in use and a second node over the same chain (the
 * second opinion every public receipt needs: release re-audit R1-3).
 */
function world({ spark = new FakeSpark(), store = createMemoryStore(), chain = new FakeChain(), sparkTxDetails = 'none' } = {}) {
  const net = new FakeNet();
  const server = net.addServer(URL1, chain.handler());
  net.addServer(URL2, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store, spark, sparkTxDetails, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  /** Mines `txid` (or just a block) and tells the wallet about the new tip, as the server would. */
  const mine = async (txid) => {
    if (txid) chain.confirm(txid);
    else chain.height++;
    server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 10));
    await backend.waitForSync();
  };
  return { backend, chain, spark, store, net, mine };
}

/**
 * The wallet's private coins, as if confirmed by a second node before the node in use began to lie
 * (P4): a test of what a payment checks uses it, since the background check now catches a lying node
 * before any payment.
 */
function provenEarlier(backend) {
  for (const c of backend.ownCoins.values()) c.proof = 'two-servers';
}

/** A confirmed payment from OTHER to `address`. */
function fund(chain, address, value, height = chain.height - 10) {
  const tx = buildSignedTransaction({
    inputs: [{ txid: bytesToHex(sha256d(Uint8Array.of(chain.txs.size, 1))), vout: 0, value: value + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(address, MAIN), value }],
    locktime: height - 1,
  });
  return chain.addTx(tx.hex, height);
}

const states = (b) => {
  const seen = [];
  b.subscribe((s) => seen.push(s.sync.phase));
  return seen;
};

test('open a new wallet: syncs to done; receive addresses; empty balances', async () => {
  const { backend, chain } = world();
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const phases = states(backend);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.sync.phase, 'done', s.sync.error);
  assert.equal(s.connected, true);
  assert.equal(s.server, URL1);
  assert.equal(s.tip.height, chain.height);
  assert.equal(s.tip.time, 1791790000 + chain.height);
  assert.equal(s.receive.transparent, W.addresses[0].address);
  assert.match(s.receive.spark, /^sm1/);
  assert.deepEqual(s.balance, { private: { available: '0', pending: '0' }, public: { available: '0', pending: '0' } });
  assert.deepEqual(s.txs, []);
  assert.equal(s.viewOnly, false);
  for (const p of ['transparent', 'spark-sets', 'spark-tags', 'spark-identify', 'done']) assert.ok(phases.includes(p), p);
  // A new wallet starts its tags at the checkpoint.
  assert.ok(chain.calls.includes('spark.getusedcoinstagstxhashes'));
  await backend.close();
  assert.equal(backend.getState().receive.transparent, null);
});

test('public FIRO: received, shown, sent with change, the send verifies and shows up', async () => {
  const { backend, chain, mine } = world();
  const t1 = fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  let s = backend.getState();
  assert.equal(s.balance.public.available, String(3n * COIN));
  assert.equal(s.txs.length, 1);
  assert.deepEqual({ ...s.txs[0], time: undefined }, { txid: t1, height: chain.height - 10, time: undefined, confirmations: 11, direction: 'in', kind: 'transparent', amount: String(3n * COIN), fee: '0', counterparty: OTHER.address });
  // Paid, so Receive moves on to the next address.
  assert.equal(s.receive.transparent, W.addresses[1].address);

  const q = await backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.equal(q.fee, String((226n * 1008n + 999n) / 1000n)); // 1 in, 2 out at 1,008 sat/kB
  assert.equal(q.total, String(COIN + BigInt(q.fee)));
  assert.equal(q.change, String(2n * COIN - BigInt(q.fee)));
  assert.deepEqual(q.warnings, []);

  const { txid } = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.equal(chain.broadcasts.length, 1);
  const d = decodeTx(chain.broadcasts[0], MAIN);
  assert.equal(d.txid, txid);
  assert.equal(d.locktime, chain.height);
  assert.ok(verifyP2PKHInput(d, 0, addressToScript(W.addresses[0].address, MAIN)));
  assert.deepEqual(d.vout.map((o) => o.address).sort(), [OTHER.address, W.addresses[3].address].sort()); // change to m/…/1/0
  await backend.waitForSync();
  s = backend.getState();
  const sent = s.txs.find((t) => t.txid === txid);
  assert.equal(sent.direction, 'out');
  assert.equal(sent.height, null);
  assert.equal(sent.amount, String(COIN));
  assert.equal(sent.fee, q.fee);
  assert.equal(sent.counterparty, OTHER.address);
  assert.equal(s.txs[0].txid, txid); // newest (unconfirmed) first
  // Our unconfirmed change is pending until it confirms.
  assert.equal(s.balance.public.available, '0');
  assert.equal(s.balance.public.pending, q.change);
  await mine(txid);
  s = backend.getState();
  assert.equal(s.balance.public.available, q.change);
  assert.equal(s.txs.find((t) => t.txid === txid).confirmations, 1);
  await backend.close();
});

test('sending: too much, dust, bad addresses, EX and OP_RETURN outputs, send-all', async () => {
  const { backend, chain, mine } = world();
  fund(chain, W.addresses[0].address, COIN);
  fund(chain, W.addresses[1].address, 50000n);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  await assert.rejects(backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: String(2n * COIN) }] }), (e) => e.code === 'insufficient' && e.available === COIN + 50000n);
  await assert.rejects(backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: '500' }] }), (e) => e.code === 'dust');
  await assert.rejects(backend.quote({ from: 'public', to: [{ address: 'nonsense!', amount: '5000' }] }), (e) => e.code === 'invalid-address');
  await assert.rejects(backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: '1.5' }] }), (e) => e.code === 'invalid-amount');
  const ex = exchangeAddress(hash160(hexToBytes(KEYS.vectors[2].addresses[1].pubkey)), MAIN);
  const r = await backend.send({ from: 'public', to: [{ address: ex, amount: '200000' }], opReturn: 'deadbeef' });
  const d = decodeTx(chain.broadcasts.at(-1), MAIN);
  assert.equal(d.txid, r.txid);
  assert.ok(d.vout.some((o) => o.type === 'exchange' && o.address === ex && o.value === 200000n));
  assert.ok(d.vout.some((o) => o.type === 'nulldata' && bytesToHex(o.data) === 'deadbeef'));
  await mine(r.txid);
  // Send everything: no change, the fee comes out of the amount.
  const all = backend.getState().balance.public.available;
  const q = await backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: all }], subtractFee: true });
  assert.equal(q.change, '0');
  assert.equal(q.total, all);
  await backend.close();
});

test('private FIRO: coins found in the set, memo, change ignored as income, spent by a tag', async () => {
  const { backend, chain, spark } = world();
  const mine = fakeCoin();
  const change = fakeCoin();
  spark.own(mine, { value: 5n * COIN, memo: 'for coffee' });
  chain.addBlock(1, [fakeCoin(), mine, fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic }); // a restore: all groups, tags from 0
  await backend.waitForSync();
  let s = backend.getState();
  assert.equal(s.balance.private.available, String(5n * COIN));
  const rx = s.txs.find((t) => t.kind === 'spark');
  assert.equal(rx.direction, 'in');
  assert.equal(rx.amount, String(5n * COIN));
  assert.equal(rx.memo, 'for coffee');
  assert.equal(rx.time, null); // found while restoring: no date without asking about it
  assert.equal(rx.height, null); // WALLET_API: no exact block either, only a rough one
  assert.ok(Number.isInteger(rx.heightApprox) && rx.heightApprox > 0);
  // Our coin is spent elsewhere (the same seed in another app): its tag shows up, with our change.
  const spendTxid = 'ab'.repeat(32);
  spark.own({ ...change, coin: concatBytes(change.coin.subarray(0, 60), change.coin.subarray(60)) }, { value: 2n * COIN, diversifier: 9999 });
  chain.addBlock(1, [{ ...change, txHash: hexToBytes(spendTxid).reverse() }]);
  chain.tags.push({ tag: fakeTag(mine.id), txid: spendTxid });
  backend._requestSync();
  await backend.waitForSync();
  s = backend.getState();
  assert.equal(s.balance.private.available, String(2n * COIN));
  const out = s.txs.find((t) => t.txid === spendTxid);
  assert.equal(out.direction, 'out');
  assert.equal(out.amount, String(3n * COIN)); // 5 spent − 2 change (fee unknown: not asked for)
  assert.equal(out.kind, 'spark');
  const coins = await backend.coins.list();
  assert.equal(coins.filter((c) => c.kind === 'spark').length, 1);
  await backend.close();
});

test('private FIRO in the mempool is pending, then available once mined', async () => {
  const { backend, chain, spark } = world();
  chain.addBlock(1, [fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const incoming = fakeCoin();
  spark.own(incoming, { value: COIN });
  const txid = 'cd'.repeat(32);
  chain.mempool.set(txid, { coins: [incoming], lTags: null });
  backend._requestSync();
  await backend.waitForSync();
  let s = backend.getState();
  assert.deepEqual(s.balance.private, { available: '0', pending: String(COIN) });
  assert.equal(s.txs.find((t) => t.txid === txid).height, null);
  chain.mempool.delete(txid);
  chain.addBlock(1, [{ ...incoming, txHash: hexToBytes(txid).reverse() }]);
  backend._requestSync();
  await backend.waitForSync();
  s = backend.getState();
  assert.deepEqual(s.balance.private, { available: String(COIN), pending: '0' });
  const tx = s.txs.find((t) => t.txid === txid);
  assert.ok(tx.height > 0 && tx.time > 0); // seen in the mempool, so its time is known
  await backend.close();
});

test('privatize: public coins minted to our own Spark address, context from the inputs', async () => {
  const { backend, chain, spark, mine } = world();
  fund(chain, W.addresses[0].address, 2n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const { txid } = await backend.privatize({ amount: String(COIN) });
  const d = decodeTx(chain.broadcasts.at(-1), MAIN);
  assert.equal(d.txid, txid);
  assert.equal(d.kind, 'spark-mint');
  const mint = d.vout.find((o) => o.type === 'spark-mint');
  assert.equal(mint.value, COIN);
  assert.deepEqual(spark.lastMintInputs, d.vin.map((i) => ({ txid: i.txid, vout: i.vout })));
  assert.ok(verifyP2PKHInput(d, 0));
  assert.ok(spark.calls.includes('mint:false') && spark.calls.includes('mint:true'));
  await backend.waitForSync();
  const tx = backend.getState().txs.find((t) => t.txid === txid);
  assert.equal(tx.kind, 'privatize');
  assert.equal(tx.amount, String(COIN));
  // 'all' mints everything less the fee.
  await mine(txid);
  await backend.privatize({ amount: 'all' });
  const d2 = decodeTx(chain.broadcasts.at(-1), MAIN);
  assert.equal(d2.vout.length, 1);
  assert.equal(d2.vout[0].type, 'spark-mint');
  await backend.close();
});

test('XM: privatize what was shown: the fee taken from that amount and pinned; another fee, or coins that arrived, change nothing that is sent', async () => {
  const { backend, chain } = world();
  fund(chain, W.addresses[0].address, 2n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const q = await backend.quote({ from: 'public', to: [{ address: await backend._sparkAddress(backend.sparkAddr.diversifier), amount: String(2n * COIN) }], subtractFee: true });
  const sent = chain.broadcasts.length;
  await assert.rejects(backend.privatize({ amount: String(2n * COIN), subtractFee: true, expect: { fee: String(BigInt(q.fee) + 1n), total: q.total } }), (e) => e.code === 'fee-changed');
  assert.equal(chain.broadcasts.length, sent, 'nothing broadcast for a fee not shown');
  // A coin that arrives meanwhile is not swept in: exactly the amount shown, less its fee, is minted.
  fund(chain, W.addresses[0].address, COIN);
  await backend.waitForSync();
  const { txid } = await backend.privatize({ amount: String(2n * COIN), subtractFee: true, expect: { fee: q.fee, total: q.total } });
  const d = decodeTx(chain.broadcasts.at(-1), MAIN);
  assert.equal(d.txid, txid);
  const mint = d.vout.find((o) => o.type === 'spark-mint');
  assert.equal(mint.value, 2n * COIN - BigInt(q.fee));
  await backend.close();
});

test('send from the private balance: the Spark spend is assembled around the library\'s proof', async () => {
  const { backend, chain, spark } = world();
  const a = fakeCoin();
  const b = fakeCoin();
  spark.own(a, { value: 3n * COIN });
  spark.own(b, { value: 4n * COIN });
  chain.addBlock(1, [fakeCoin()]);
  chain.addBlock(1, [a, fakeCoin(), b]);
  chain.names = [{ name: 'Alice', address: (await new FakeSpark().getAddress({ keyData: new Uint8Array(32).fill(5), diversifier: 1, isTestNet: false })) }];
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal(backend.getState().balance.private.available, String(7n * COIN));

  const q = await backend.quote({ from: 'private', to: [{ address: OTHER.address, amount: String(5n * COIN) }] });
  assert.equal(q.fee, '10000');
  assert.equal(q.total, String(5n * COIN + 10000n));
  assert.deepEqual(q.warnings, ['The amount and the receiving address will be public on the blockchain.']);

  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(5n * COIN) }, { address: '@alice', amount: String(COIN), memo: 'hi' }] });
  const raw = chain.broadcasts.at(-1);
  const d = decodeTx(raw, MAIN);
  assert.equal(d.txid, txid);
  assert.equal(d.version, 3);
  assert.equal(d.type, 11);
  assert.equal(d.vin.length, 1);
  assert.equal(d.vin[0].kind, 'spark-spend');
  assert.equal(d.vin[0].txid, null);
  assert.equal(d.vout[0].address, OTHER.address);
  assert.equal(d.vout[0].value, 5n * COIN);
  assert.equal(d.vout.filter((o) => o.type === 'spark-smint').length, 2); // Alice + change
  // What the proof signs: the transaction with only its public outputs and an empty payload.
  const L = spark.lastSpend;
  const unsigned = serializeTx({ versionRaw: d.versionRaw, vin: d.vin.map((i) => ({ ...i, prevHash: new Uint8Array(32) })), vout: [d.vout[0]], locktime: d.locktime, extraPayload: new Uint8Array(0) });
  assert.equal(bytesToHex(L.txHashSig), bytesToHex(sha256d(unsigned)));
  assert.equal(bytesToHex(d.extraPayload.subarray(1)), bytesToHex(L.txHashSig));
  assert.equal(L.privateRecipients[0].address, chain.names[0].address);
  assert.equal(L.privateRecipients[0].memo, 'hi');
  assert.equal(L.coverSets.length, 1);
  assert.equal(L.coverSets[0].groupId, 1);
  assert.equal(L.coverSets[0].coins.length, 4);
  assert.equal(L.spendVersion, 2);
  // The spent coins are pending until their tags appear.
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.balance.private.available, '0');
  const out = s.txs.find((t) => t.txid === txid);
  assert.equal(out.direction, 'out');
  assert.equal(out.amount, String(6n * COIN));
  assert.equal(out.fee, '10000');
  assert.equal(out.memo, 'hi');
  await backend.close();
});

test('private sends refuse EX addresses, unknown names, too much; names resolve case-insensitively', async () => {
  const { backend, chain, spark } = world();
  const a = fakeCoin();
  spark.own(a, { value: COIN });
  chain.addBlock(1, [a]);
  chain.names = [{ name: 'Bob', address: 'sm1' + 'x'.repeat(140) }];
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const ex = exchangeAddress(hash160(hexToBytes(KEYS.vectors[2].addresses[1].pubkey)), MAIN);
  await assert.rejects(backend.quote({ from: 'private', to: [{ address: ex, amount: '100000' }] }), (e) => e.code === 'invalid-address' && /exchange/.test(e.message));
  await assert.rejects(backend.quote({ from: 'private', to: [{ address: '@nobody', amount: '100000' }] }), (e) => e.code === 'invalid-address' && /nobody/.test(e.message));
  await assert.rejects(backend.quote({ from: 'private', to: [{ address: OTHER.address, amount: String(2n * COIN) }] }), (e) => e.code === 'insufficient');
  assert.equal(await backend.resolveSparkName('BOB'), chain.names[0].address);
  assert.equal(await backend.resolveSparkName('@bob'), chain.names[0].address);
  assert.equal(await backend.resolveSparkName('carol'), null);
  assert.deepEqual(backend.classifyAddress('@bob'), { kind: 'spark-name', name: 'bob' });
  assert.deepEqual(backend.classifyAddress(ex), { kind: 'exchange', address: ex });
  await backend.close();
});

test('receive: new addresses, names owned, coins, freeze, labels, fee rates, exports', async () => {
  const { backend, chain, spark } = world();
  fund(chain, W.addresses[0].address, COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const s0 = backend.getState();
  const a2 = await backend.newTransparentAddress();
  assert.equal(a2, W.addresses[2].address);
  const sp1 = s0.receive.spark;
  const sp2 = await backend.newSparkAddress();
  assert.notEqual(sp1, sp2);
  assert.equal(backend.getState().receive.spark, sp2);
  chain.names = [{ name: 'me', address: sp1 }, { name: 'other', address: 'sm1zzz' }];
  backend._names = null;
  assert.deepEqual(await backend.sparkNames.list(), [{ name: 'me', address: sp1 }]);
  await assert.rejects(backend.sparkNames.register({}), (e) => e.code === 'invalid-name');
  await assert.rejects(backend.sparkNames.register({ name: 'campfiretest', years: 11 }), (e) => e.code === 'invalid-amount');
  // A valid name is a private payment of the fee: with no private FIRO it is refused as such.
  await assert.rejects(backend.sparkNames.register({ name: 'campfiretest' }), (e) => e.code === 'insufficient' || e.code === 'NotYet');
  assert.equal(backend.sparkNameFeeFiro('campfiretest', 2), 2);
  assert.equal(backend.sparkNameFeeFiro('abc'), 10);
  const coins = await backend.coins.list();
  assert.equal(coins.length, 1);
  await backend.coins.freeze(coins[0].id, true);
  assert.equal(backend.getState().balance.public.available, '0');
  await assert.rejects(backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: '100000' }] }), (e) => e.code === 'insufficient');
  await backend.coins.freeze(coins[0].id, false);
  await backend.coins.label(coins[0].id, 'savings');
  assert.equal((await backend.coins.list())[0].label, 'savings');
  const fr = await backend.estimateFeeRate();
  assert.deepEqual(fr, { fast: '1008', normal: '1008', slow: '1008', min: '1000', unit: 'sat/kB' });
  assert.equal(await backend.exportXpub(), W.accountXpub);
  assert.match(await backend.exportSparkViewKey(), /^[0-9a-f]{66}$/);
  for (const f of [() => backend.masternodes.register(), () => backend.rosen.lock({})]) await assert.rejects(f(), (e) => e.code === 'NotYet');
  assert.ok(Array.isArray(await backend.masternodes.list()));
  await backend.close();
});

test('without a Spark client: transparent works, Spark is off and says NotYet', async () => {
  const { backend, chain } = world({ spark: null });
  fund(chain, W.addresses[0].address, COIN);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.sync.phase, 'done');
  assert.equal(s.receive.spark, null);
  assert.equal(s.balance.public.available, String(COIN));
  assert.ok(!chain.calls.some((m) => m.startsWith('spark.')));
  await assert.rejects(backend.quote({ from: 'private', to: [{ address: OTHER.address, amount: '100000' }] }), (e) => e.code === 'NotYet');
  await assert.rejects(backend.privatize({ amount: '100000' }), (e) => e.code === 'NotYet');
  await assert.rejects(backend.newSparkAddress(), (e) => e.code === 'NotYet');
  await backend.close();
});

test('view-only: xpub addresses and balance, Spark from a view key, no sending', async () => {
  const { backend, chain } = world();
  fund(chain, W.addresses[1].address, COIN);
  await backend.openViewOnly({ xpub: W.accountXpub, sparkFullViewKey: 'ab'.repeat(40) });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.viewOnly, true);
  assert.equal(s.balance.public.available, String(COIN));
  assert.match(s.receive.spark, /^sm1/);
  await assert.rejects(backend.send({ from: 'public', to: [{ address: OTHER.address, amount: '100000' }] }), (e) => e.code === 'NotYet');
  assert.equal(await backend.exportSparkViewKey(), 'ab'.repeat(40));
  await backend.close();
});

test('offline: open still resolves; the state says connecting; sends say why not', async () => {
  const net = new FakeNet(); // no server at all
  const backend = createBackend({ servers: [URL1], store: createMemoryStore(), spark: null, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, connectTimeoutMs: 50, backoffInitialMs: 5000 } });
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.connected, false);
  assert.equal(s.sync.phase, 'connecting');
  assert.match(s.sync.error, /No connection/);
  await assert.rejects(backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: '100000' }] }), (e) => e.code === 'not-synced');
  await assert.rejects(backend.open({ mnemonic: W.mnemonic }), /already open/);
  await backend.close();
  assert.equal(backend.getState().connected, false);
});

test('a wrong phrase is refused before anything is derived; the store survives a reopen', async () => {
  const store = createMemoryStore();
  const { backend, chain } = world({ store });
  await assert.rejects(backend.open({ mnemonic: 'abandon abandon' }), (e) => e.code === 'invalid-mnemonic');
  fund(chain, W.addresses[0].address, COIN);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  await backend.close();
  // Reopen offline: balances come from the cache until the servers answer.
  const again = createBackend({ servers: [URL1], store, spark: new FakeSpark(), WebSocket: new FakeNet().WebSocket, electrum: { pingIntervalMs: 0, connectTimeoutMs: 50, backoffInitialMs: 5000 } });
  await again.open({ mnemonic: W.mnemonic });
  assert.equal(again.getState().txs.length, 1);
  await again.close();
});

test('audit E6: a lock built from chosen coins spends the coins of a payment let go of too, and is signed at the lower tip of two nodes', async () => {
  const { backend, chain } = world();
  const t1 = fund(chain, W.addresses[0].address, 3n * COIN);
  const t2 = fund(chain, W.addresses[1].address, 2n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  // A payment from t1, let go of while it may still be on the network: t1 is spent first from here.
  const gone = await backend.buildTransparentTx({ inputs: [`${t1}:0`], outputs: [{ address: OTHER.address, amount: String(COIN) }], feePerKb: 1000n });
  await backend.transparent.keepConflicts(gone.txid, gone.hex);
  assert.equal((await backend.coins.list()).find((c) => c.id === `${t1}:0`).spendFirst, true);
  const tip = backend.tip.height;
  backend.serverCheck = { ...(backend.serverCheck ?? {}), otherHeight: tip - 2 };
  const LOCK = 'aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y';
  const b = await backend.buildTransparentTx({ inputs: [`${t2}:0`], outputs: [{ address: LOCK, amount: String(COIN) }], feePerKb: 1000n });
  const d = decodeTx(b.hex, MAIN);
  assert.deepEqual(d.vin.map((i) => `${i.txid}:${i.vout}`).sort(), [`${t1}:0`, `${t2}:0`].sort(), 'the let-go coin is in it: the two cannot both be mined');
  assert.equal(d.vout[0].address, LOCK);
  assert.equal(BigInt(d.vout[0].value), COIN, 'the lock amount is unchanged; the rest comes back as change');
  assert.equal(d.locktime, tip - 2);
  await backend.close();
});

test('explicit coins for the Rosen stream: build with an OP_RETURN, check, then broadcast separately', async () => {
  const { backend, chain, mine } = world();
  const t1 = fund(chain, W.addresses[0].address, 3n * COIN);
  const t2 = fund(chain, W.addresses[1].address, 2n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const LOCK = 'aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y';
  const payload = '03' + '0000000031aba856' + '000000000014f730' + '14' + 'e824fbb56014b08a279857a342efa113cded323d';
  const before = chain.broadcasts.length;
  const b = await backend.buildTransparentTx({ inputs: [`${t2}:0`], outputs: [{ address: LOCK, amount: String(COIN) }, { opReturn: payload }], feePerKb: 1000n });
  assert.equal(chain.broadcasts.length, before); // nothing sent yet
  const d = decodeTx(b.hex, MAIN);
  assert.equal(d.txid, b.txid);
  assert.deepEqual(d.vin.map((i) => `${i.txid}:${i.vout}`), [`${t2}:0`]); // exactly the chosen coin
  assert.equal(d.vout[0].address, LOCK);
  assert.equal(bytesToHex(d.vout[1].script), '6a26' + payload);
  assert.equal(d.vout[2].address, W.addresses[3].address); // change
  assert.equal(b.outputs[1].opReturn, payload);
  assert.equal(b.outputs[1].address, null);
  assert.equal(b.outputs[2].change, true);
  assert.equal(BigInt(b.fee), 2n * COIN - COIN - BigInt(b.outputs[2].value));
  assert.equal(b.inputs[0].address, W.addresses[1].address);
  assert.ok(verifyP2PKHInput(d, 0, addressToScript(W.addresses[1].address, MAIN)));
  const r = await backend.broadcastTx(b.hex);
  assert.equal(r.txid, b.txid);
  assert.equal(chain.broadcasts.at(-1), b.hex);
  // The wallet's own view of the lock payment.
  await backend.waitForSync();
  const pays = await backend.paymentsTo({ to: LOCK, from: W.addresses[1].address });
  assert.deepEqual(pays.map((p) => [p.txid, p.value, p.fromMatches, p.height]), [[b.txid, String(COIN), true, null]]);
  // Refusals: a coin not ours, a coin already spent, a frozen coin, a Spark output, a foreign change address.
  await assert.rejects(backend.buildTransparentTx({ inputs: ['ee'.repeat(32) + ':0'], outputs: [{ address: LOCK, amount: '100000' }] }), (e) => e.code === 'insufficient');
  await assert.rejects(backend.buildTransparentTx({ inputs: [`${t2}:0`], outputs: [{ address: LOCK, amount: '100000' }] }), (e) => e.code === 'insufficient');
  await backend.coins.freeze(`${t1}:0`, true);
  await assert.rejects(backend.buildTransparentTx({ inputs: [`${t1}:0`], outputs: [{ address: LOCK, amount: '100000' }] }), /frozen/);
  await backend.coins.freeze(`${t1}:0`, false);
  await assert.rejects(backend.buildTransparentTx({ inputs: [`${t1}:0`], outputs: [{ address: backend.getState().receive.spark, amount: '100000' }] }), (e) => e.code === 'invalid-address');
  await assert.rejects(backend.buildTransparentTx({ inputs: [`${t1}:0`], outputs: [{ address: LOCK, amount: '100000' }], changeAddress: OTHER.address }), /Change/);
  await assert.rejects(backend.buildTransparentTx({ inputs: [`${t1}:0`], outputs: [{ address: LOCK, amount: String(3n * COIN) }] }), (e) => e.code === 'insufficient');
  // All of a coin, the fee taken from the amount.
  const all = await backend.buildTransparentTx({ inputs: [`${t1}:0`], outputs: [{ address: LOCK, amount: String(3n * COIN) }, { opReturn: payload }], subtractFee: true, feePerKb: 1000n });
  assert.equal(all.outputs.length, 2);
  assert.equal(BigInt(all.outputs[0].value) + BigInt(all.fee), 3n * COIN);
  await assert.rejects(backend.broadcastTx('00'), (e) => e.code === 'invalid-amount');
  void mine;
  await backend.close();
});

test('a birthday long ago is treated as a restore: older Spark groups are scanned too', async () => {
  // Group 2 carries over only group 1's newest block (Firo: its newest 8,000 coins), not `old`.
  const { backend, chain, spark } = world({ chain: new FakeChain({ startGroupSize: 1 }) });
  const old = fakeCoin();
  spark.own(old, { value: COIN });
  chain.addBlock(1, [old]);
  chain.addBlock(1, [fakeCoin()]);
  chain.addBlock(2, [fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 10000 });
  await backend.waitForSync();
  assert.equal(backend.getState().balance.private.available, String(COIN));
  await backend.close();
  // A birthday of today scans only the newest group (a new wallet has nothing older).
  const w2 = world({ chain, spark });
  await w2.backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await w2.backend.waitForSync();
  assert.equal(w2.backend.getState().balance.private.available, '0');
  await w2.backend.close();
});

test('offline, the Spark receive address is still there (it needs no network)', async () => {
  const backend = createBackend({ servers: [URL1], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: new FakeNet().WebSocket, electrum: { pingIntervalMs: 0, connectTimeoutMs: 50, backoffInitialMs: 5000 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: 1 });
  assert.match(backend.getState().receive.spark, /^sm1/);
  assert.equal(backend.getState().receive.transparent, W.addresses[0].address);
  await backend.close();
});

test('mnemonics without a wallet: 24 words by default, plain-English problems', () => {
  const m = FiroBackend.generateMnemonic();
  assert.equal(m.split(' ').length, 24);
  assert.deepEqual(FiroBackend.validateMnemonic(m), { ok: true });
  assert.equal(createBackend({ store: createMemoryStore() }).generateMnemonic(12).split(' ').length, 12);
  const bad = FiroBackend.validateMnemonic('abandon abandon abandon');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /12, 15, 18, 21 or 24 words/);
});

test('masternodes: a registration with its collateral inside is found and described; a plain 1,000 FIRO coin is only a candidate', async () => {
  const { backend, chain } = world();
  const mine = W.addresses[0].address;
  // A ProRegTx (version 3, type 1) whose output 0 pays 1,000 FIRO to us; its payload's collateral
  // outpoint is null + index 0: the collateral is that output.
  const payload = new Uint8Array(6 + 36 + 10);
  payload.set([1, 0, 0, 0, 0, 0], 0); // version 1, type 0, mode 0
  // bytes 6..37: null txid; 38..41: index 0
  const proReg = serializeTx({ versionRaw: 3 | (1 << 16), vin: [{ prevHash: sha256d(Uint8Array.of(9, 9)), vout: 0, scriptSig: new Uint8Array(0), sequence: 0xffffffff }], vout: [{ value: 1000n * COIN, script: addressToScript(mine, MAIN) }], locktime: 0, extraPayload: payload });
  const proTxHash = chain.addTx(bytesToHex(proReg), chain.height - 20);
  const plain = fund(chain, mine, 1000n * COIN);
  chain.extra = {
    'blockchain.checkifmncollateral': ([txid, n]) => txid === proTxHash && n === '0',
    'protx.info': ([h]) => {
      if (h !== proTxHash) throw new Error('unknown');
      return { proTxHash: h, operatorReward: 0, state: { service: '203.0.113.7:8168', payoutAddress: mine, registeredHeight: 1300000, lastPaidHeight: 1392000, PoSePenalty: 0, PoSeBanHeight: -1 } };
    },
  };
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const list = await backend.masternodes.list();
  const reg = list.find((m) => m.collateral === `${proTxHash}:0`);
  assert.ok(reg, 'the registered collateral is listed');
  assert.equal(reg.isCollateral, true);
  assert.equal(reg.proTxHash, proTxHash);
  assert.deepEqual(reg.info, { service: '203.0.113.7:8168', payoutAddress: mine, registeredHeight: 1300000, lastPaidHeight: 1392000, posePenalty: 0, banned: false, operatorReward: 0 });
  const cand = list.find((m) => m.collateral.startsWith(plain));
  assert.ok(cand);
  assert.equal(cand.isCollateral, false);
  assert.equal(cand.proTxHash, null);
  await assert.rejects(backend.masternodes.register(), (e) => e.code === 'NotYet');
  await backend.close();
});

test('anchors: the same 17 positions of a set for every wallet, and a coin placed between the two around it', () => {
  assert.deepEqual(anchorPositions(80), [0, 5, 10, 15, 20, 25, 30, 35, 40, 44, 49, 54, 59, 64, 69, 74, 79]);
  assert.deepEqual(anchorPositions(1), [0]);
  assert.deepEqual(anchorPositions(0), []);
  const pts = [[0, 100], [10, 110], [20, 150]];
  assert.deepEqual([placeByAnchors(pts, 0), placeByAnchors(pts, 5), placeByAnchors(pts, 15), placeByAnchors(pts, 25)], [100, 105, 130, 150]);
  assert.equal(placeByAnchors([], 3), null);
});

test('a restored coin is dated by its place in its set: only the fixed positions are asked about, once', async () => {
  const { backend, chain, spark } = world();
  const mine = fakeCoin();
  spark.own(mine, { value: COIN, memo: 'old' });
  let minedAt = null;
  for (let b = 0; b < 40; b++) {
    chain.addBlock(1, b === 11 ? [fakeCoin(), mine] : [fakeCoin(), fakeCoin()]);
    if (b === 11) minedAt = chain.height;
  }
  await backend.open({ mnemonic: W.mnemonic }); // a restore
  await backend.waitForSync();
  const rx = backend.getState().txs.find((t) => t.txid === hashToHex(mine.txHash));
  assert.equal(rx.time, null);
  assert.equal(rx.height, null);
  assert.ok(Math.abs(rx.heightApprox - minedAt) <= 1, `placed at ${rx.heightApprox}, mined at ${minedAt}`);
  // What was asked: the coins at the fixed positions of the set as the wallet stores it (the
  // server's order, the same for everyone), never ours (it is not at one).
  const order = (await backend.sparkSync.coins(1)).sort((x, y) => x.index - y.index).map((c) => c.txid);
  const fixed = new Set(anchorPositions(order.length).map((i) => order[i]));
  assert.ok(!fixed.has(hashToHex(mine.txHash)), 'the test coin is not at a fixed position');
  assert.ok(chain.txGets.length > 0 && chain.txGets.every((t) => fixed.has(t)), 'only fixed positions');
  assert.ok(!chain.txGets.includes(hashToHex(mine.txHash)));
  // Kept: the next sync asks nothing.
  const asked = chain.txGets.length;
  backend._requestSync();
  await backend.waitForSync();
  assert.equal(chain.txGets.length, asked);
  await backend.close();
});

test('Exact dates (opt-in): a restored spend gets its block, date and fee, and a name registration says so', async () => {
  const { backend, chain, spark } = world({ sparkTxDetails: 'decoy' });
  const mine = fakeCoin();
  const change = fakeCoin();
  spark.own(mine, { value: 5n * COIN });
  for (let b = 0; b < 8; b++) chain.addBlock(1, b === 2 ? [mine, fakeCoin()] : [fakeCoin(), fakeCoin()]);
  // Spent by a name registration: 1 FIRO to the Spark Names fee address, fee 0.0000363 (as 44a9f868).
  const spendTxid = 'cd'.repeat(32);
  spark.own(change, { value: 5n * COIN - COIN - 3630n, diversifier: 9999 });
  chain.addBlock(1, [{ ...change, txHash: hexToBytes(spendTxid).reverse() }]);
  const spentAt = chain.height;
  chain.sparkTxs.set(spendTxid, { ...chain.sparkTxs.get(spendTxid), nFees: 0.0000363, nameFee: 1 });
  chain.tags.push({ tag: fakeTag(mine.id), txid: spendTxid });
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const out = backend.getState().txs.find((t) => t.txid === spendTxid);
  assert.deepEqual([out.kind, out.direction, out.amount, out.fee, out.height], ['spark-name', 'out', String(COIN), '3630', spentAt]);
  assert.equal(out.heightApprox, undefined);
  assert.ok(out.time > 0);
  // Asked among others: more transactions than ours.
  assert.ok(chain.txGets.includes(spendTxid));
  assert.ok(new Set(chain.txGets).size > 2);
  await backend.close();
});

test('back after a while: a coin that arrived while the app was closed is dated by its place, not "now"', async () => {
  const { backend, chain, spark, mine } = world();
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height }); // a new wallet
  await backend.waitForSync();
  const coin = fakeCoin();
  spark.own(coin, { value: COIN, memo: 'while away' });
  let minedAt = null;
  for (let b = 0; b < 20; b++) {
    chain.addBlock(1, b === 5 ? [fakeCoin(), coin] : [fakeCoin(), fakeCoin()]);
    if (b === 5) minedAt = chain.height;
  }
  await mine(); // the app is opened again: the server tells it the tip
  const rx = backend.getState().txs.find((t) => t.txid === hashToHex(coin.txHash));
  assert.equal(rx.time, null, 'not "now"');
  assert.equal(rx.height, null);
  assert.ok(Math.abs(rx.heightApprox - minedAt) <= 2, `placed at ${rx.heightApprox}, mined at ${minedAt}`);
  // Nothing asked about our coins: the one transaction asked about is the set's first coin, the
  // same for every wallet (where the check of the set's hash starts, audit D-09).
  const first = (await backend.sparkSync.coins(1, { to: 1 }))[0].txid;
  assert.deepEqual([...new Set(chain.txGets)], [first], 'nothing asked about our coins');
  // A coin found right after it was mined (the app open) keeps the time it was found.
  const soon = fakeCoin();
  spark.own(soon, { value: COIN });
  chain.addBlock(1, [soon]);
  await mine();
  const rx2 = backend.getState().txs.find((t) => t.txid === hashToHex(soon.txHash));
  assert.ok(rx2.time > 0);
  await backend.close();
});

test('Max from the private balance: the fee is taken once — the library is handed balance - fee, never asked to subtract again', async () => {
  const { backend, chain, spark } = world();
  const a = fakeCoin();
  spark.own(a, { value: 2n * COIN });
  chain.addBlock(1, [a, fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const q = await backend.quote({ from: 'private', to: [{ address: OTHER.address, amount: String(2n * COIN) }], subtractFee: true });
  assert.equal(q.total, String(2n * COIN));
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(2n * COIN) }], subtractFee: true });
  const L = spark.lastSpend;
  assert.deepEqual(L.recipients.map((r) => [r.value, r.subtractFee]), [[2n * COIN - BigInt(q.fee), false]]);
  // The public output written into the transaction is the same figure (the proof balances with it).
  const d = decodeTx(chain.broadcasts.at(-1), MAIN);
  assert.equal(d.vout[0].value, 2n * COIN - BigInt(q.fee));
  await backend.waitForSync();
  const out = backend.getState().txs.find((t) => t.txid === txid);
  assert.deepEqual([out.amount, out.fee], [String(2n * COIN - BigInt(q.fee)), q.fee]);
  await backend.close();
});

test('paying a Spark name: a second server must agree, and an address paid before must not change silently', async () => {
  const URL2 = 'wss://fake2.example:50004';
  const net = new FakeNet();
  const chain = new FakeChain();
  const chain2 = new FakeChain();
  net.addServer(URL1, chain.handler());
  const second = net.addServer(URL2, chain2.handler());
  const spark = new FakeSpark();
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  chain.addBlock(1, [fakeCoin()]);
  const addr = (n) => new FakeSpark().getAddress({ keyData: new Uint8Array(32).fill(n), diversifier: 1, isTestNet: false });
  const alice = await addr(5);
  const mallory = await addr(9);
  chain.names = [{ name: 'Alice', address: alice }];
  chain2.names = [{ name: 'Alice', address: alice }];
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  // Both servers agree.
  assert.deepEqual(await backend.resolveSparkNameForPayment('@alice'), { address: alice, checked: 'two-servers' });
  await backend.pinSparkName('alice', alice);
  // The server in use now says Mallory; the second still says Alice: refused.
  chain.names = [{ name: 'Alice', address: mallory }];
  backend._names = null;
  await assert.rejects(backend.resolveSparkNameForPayment('alice'), (e) => e.code === 'name-conflict' && e.answers.includes(mallory) && e.answers.includes(alice));
  // Both say Mallory (the name was re-registered, or both lie): the pin stops it; both addresses are given.
  chain2.names = [{ name: 'Alice', address: mallory }];
  await assert.rejects(backend.resolveSparkNameForPayment('alice'), (e) => e.code === 'name-changed' && e.before === alice && e.now === mallory);
  // Accepted on purpose: it goes ahead.
  assert.equal((await backend.resolveSparkNameForPayment('alice', { acceptChange: true })).address, mallory);
  // The second server answering that no one has the name: a disagreement too, never "one server"
  // alone deciding who is paid (public audit, P8).
  chain.names = [{ name: 'Bob', address: alice }];
  chain2.names = [];
  backend._names = null;
  await assert.rejects(backend.resolveSparkNameForPayment('bob'), (e) => e.code === 'name-conflict' && /another says no one has it/.test(e.message) && e.answers[0] === alice && e.answers[1] === null);
  // The second server gone (refusing connections): it still resolves, said as checked by one server.
  second.refuse = true;
  for (const ws of [...second.sockets]) ws.close?.();
  backend._names = null;
  assert.deepEqual(await backend.resolveSparkNameForPayment('bob'), { address: alice, checked: 'one-server' });
  // The pins are kept with the wallet.
  assert.equal(backend.namePins.get('ALICE'), alice);
  await backend.close();
});

test('a private payment the network dropped: sent again once after 2 blocks; after 6, on two nodes\' word, its coins are spendable again and it says it did not go through', async () => {
  const { backend, ctl, mine } = tagWorld();
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  await backend.waitForSync();
  assert.equal(backend.getState().balance.private.available, '0', 'its coin is pending');
  // Accepted, then gone: never in the mempool, never used on chain, no node has it.
  ctl.lost.add(txid);
  await mine();
  await mine();
  assert.equal(ctl.lostBroadcasts, 1, 'sent again, once');
  await mine();
  assert.equal(ctl.lostBroadcasts, 1, 'only once');
  await mine();
  await mine();
  await mine();
  const s = backend.getState();
  assert.equal(s.balance.private.available, String(5n * COIN), 'its coins are spendable again');
  const e = s.txs.find((t) => t.txid === txid);
  assert.ok(e && e.dropped === true && e.confirmations === 0, 'not left "waiting": said as not gone through');
  await backend.close();
});

test('Exact dates: the decoys are the same on every ask (nothing to intersect), from every set, in batches of 32', async () => {
  const { backend, chain, spark } = world({ sparkTxDetails: 'decoy' });
  const own = [fakeCoin(), fakeCoin(), fakeCoin()];
  for (const c of own) spark.own(c, { value: COIN });
  for (let b = 0; b < 20; b++) chain.addBlock(1, b < 3 ? [own[b], fakeCoin()] : [fakeCoin(), fakeCoin()]);
  for (let b = 0; b < 20; b++) chain.addBlock(2, [fakeCoin(), fakeCoin()]); // a set with none of ours
  await backend.open({ mnemonic: W.mnemonic }); // a restore
  await backend.waitForSync();
  const ask = async () => {
    // As after a Rescan: our coins' dates unknown again.
    for (const c of backend.ownCoins.values()) Object.assign(c, { heightApprox: true, time: null });
    backend.spendInfo.clear();
    const from = chain.txGets.length;
    await backend._decoyDetails();
    return chain.txGets.slice(from);
  };
  const first = await ask();
  const second = await ask();
  assert.deepEqual([...new Set(second)].sort(), [...new Set(first)].sort(), 'asking again asks exactly the same');
  assert.equal(new Set(first).size % 32, 0, 'padded to a multiple of 32');
  const ownTxids = own.map((c) => hashToHex(c.txHash));
  assert.ok(ownTxids.every((t) => first.includes(t)));
  const group2 = (await backend.sparkSync.coins(2)).map((c) => c.txid);
  assert.ok(first.some((t) => group2.includes(t)), 'decoys also from a set with none of our coins');
  await backend.close();
});

test('a public payment is believed only with proof: a server that invents one gets it shown as unconfirmed, never spendable', async () => {
  const URL2 = 'wss://fake2.example:50004';
  const net = new FakeNet();
  const chain = new FakeChain();
  const chain2 = new FakeChain();
  net.addServer(URL1, chain.handler());
  net.addServer(URL2, chain2.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  // A real payment, in the same block on both servers.
  const real = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  chain2.addTx(chain.txs.get(real).hex, chain.height - 20);
  // The server in use invents a 100 FIRO payment (an input that exists nowhere) in a block of its own.
  const phantom = buildSignedTransaction({
    inputs: [{ txid: 'ee'.repeat(32), vout: 0, value: 100n * COIN + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(W.addresses[1].address, MAIN), value: 100n * COIN }],
    locktime: chain.height - 7,
  });
  chain.addTx(phantom.hex, chain.height - 5);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.balance.public.available, String(2n * COIN), 'only the proven payment is available');
  const p = s.txs.find((t) => t.txid === phantom.txid);
  assert.ok(p && p.confirmations === 0, 'the invented payment is shown as not confirmed');
  assert.equal(backend.transparent.txs.get(real).proof, 'two-servers');
  // Not proven (audit FE-8: one node's other header is named and another asked; none answers here).
  assert.equal(backend.transparent.txs.get(phantom.txid).proof, 'unproven');
  assert.deepEqual(backend.transparent.txs.get(phantom.txid).disagreed, [URL2]);
  // It cannot be spent: the wallet will not sign a payment that needs it.
  await assert.rejects(backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(50n * COIN) }] }), (e) => e.code === 'insufficient');
  await backend.close();
});

test('the tip is checked with a second server: same chain agrees; a different block, or a server well ahead, disagrees', async () => {
  const URL2 = 'wss://fake2.example:50004';
  const net = new FakeNet();
  const chain = new FakeChain();
  const chain2 = new FakeChain();
  net.addServer(URL1, chain.handler());
  net.addServer(URL2, chain2.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  assert.equal(backend.getState().serverCheck.state, 'agree');
  // The second server's block at our tip holds another transaction: a different chain.
  const tx = buildSignedTransaction({ inputs: [{ txid: 'dd'.repeat(32), vout: 0, value: 3000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }], outputs: [{ script: addressToScript(OTHER.address, MAIN), value: 1000n }], locktime: 0 });
  chain2.addTx(tx.hex, chain.height);
  await backend._checkTip();
  assert.equal(backend.getState().serverCheck.state, 'disagree');
  // Same blocks again, but the second server is 10 blocks ahead: ours is behind.
  chain2.txs.clear();
  chain2.height = chain.height + 10;
  await backend._checkTip();
  assert.equal(backend.getState().serverCheck.state, 'disagree');
  await backend.close();
});

test('release re-audit 3 RE3-2: one of Firo\'s nodes that never opens does not fail every second opinion (production timeouts): receipts are proven, the tip agrees', async () => {
  // Firo's four public nodes, the default list: the one in use, then a dark one (a blackholed host:
  // the open never completes), then two healthy ones.
  const [IN_USE, DARK, OK2, OK3] = MAIN.servers;
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(IN_USE, chain.handler());
  const dark = net.addServer(DARK, chain.handler(), { silent: true });
  const ok = [net.addServer(OK2, chain.handler()), net.addServer(OK3, chain.handler())];
  const txid = fund(chain, W.addresses[0].address, 3n * COIN);
  // Production options: no connectTimeoutMs override (pings off only so the process can exit).
  const backend = createBackend({ network: 'main', servers: MAIN.servers.map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0 } });
  const t0 = Date.now();
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.server, IN_USE);
  assert.equal(backend.transparent.txs.get(txid).proof, 'two-servers', 'proven with a healthy node');
  assert.equal(s.balance.public.available, String(3n * COIN), 'spendable');
  assert.equal(s.serverCheck.state, 'agree');
  assert.ok(ok.some((x) => x.calls.length > 0), 'a healthy node was asked');
  assert.ok(Date.now() - t0 < 16000, `synced in ${Date.now() - t0} ms`);
  // Release re-audit 4 RE4-1: the other nodes are opened together, so the dark one does not hold a
  // second opinion for its 8 s; of the nodes open together, the first in the rotating order is asked;
  // no connection is left open after the answer. Re-audit 5 RE5-2: first in that order, it is waited
  // for a moment (SECOND_GRACE_MS, 1.5 s) after the others open, and no longer.
  const others = [DARK, OK2, OK3];
  for (let i = 0; i < 3; i++) {
    const turn = backend._secondTurn % others.length;
    const order = [...others.slice(turn), ...others.slice(0, turn)];
    const t1 = Date.now();
    let asked = null;
    const h = await backend._secondOpinion(async (c) => {
      asked = c.server;
      return (await c.subscribeHeaders()).height;
    });
    const ms = Date.now() - t1;
    assert.equal(h, chain.height);
    if (order[0] === DARK) assert.ok(ms >= 1400 && ms < 2100, `the dark node ahead in the order costs the grace and no more (${ms} ms)`);
    else assert.ok(ms < 500, `answered in ${ms} ms: no node ahead is waited for`);
    assert.equal(asked, order.find((u) => u !== DARK), `the rotation decides among the nodes open together (${order})`);
  }
  assert.equal(dark.sockets.size, 0, 'the dark node never opened');
  assert.ok(
    net.sockets.filter((x) => x.url !== IN_USE).every((x) => x.readyState === 3),
    'every connection to another node is closed',
  );
  await backend.close();
});

test('release re-audit 3 RE3-2: no second node reachable for 3 syncs: the sync line says incoming public payments wait; sending stays allowed', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const server = net.addServer(URL1, chain.handler());
  const other = net.addServer(URL2, chain.handler(), { refuse: true });
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const tick = async () => {
    chain.height++;
    server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 10));
    await backend.waitForSync();
  };
  const NO_SECOND = 'No second Firo node could be reached: incoming public payments wait until one can.';
  const line = () => {
    const st = backend.getState();
    return assessSync({ raw: st, everConnected: true, now: st.tip.time });
  };
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const count = () => backend.getState().serverCheck.noSecondSyncs;
  const sc = backend.getState().serverCheck;
  assert.equal(sc.state, 'unknown');
  assert.equal(sc.otherHeight, null, 'no second node answered');
  assert.ok(count() >= 1, 'counted per sync');
  // Not before the third sync in a row.
  const st = backend.getState();
  for (const n of [1, 2]) assert.notEqual(assessSync({ raw: { ...st, serverCheck: { ...sc, noSecondSyncs: n } }, everConnected: true, now: st.tip.time }).detail, NO_SECOND, `not after ${n}`);
  for (let i = 0; i < 5 && count() < 3; i++) {
    const before = count();
    await tick();
    assert.ok(count() > before, 'one more sync with no second node');
  }
  assert.ok(count() >= 3);
  const v = line();
  assert.equal(v.state, 'synced');
  assert.equal(v.detail, NO_SECOND, 'said once it has lasted 3 syncs');
  assert.equal(v.canSend, true, 'sending is allowed as before');
  // A second node answers again: the tip is checked anew at the next sync, and the line is the usual one.
  other.refuse = false;
  backend.serverCheck.at -= 30;
  await tick();
  assert.equal(backend.getState().serverCheck.state, 'agree');
  assert.equal(backend.getState().serverCheck.noSecondSyncs, undefined);
  assert.match(line().detail, /^Block /);
  await backend.close();
});

// Release re-audit 4 RE4-1: RE3-2 gave each other node 2.5 s to open, one after another, so on a slow
// link (an open + handshake of 3 s: congested mobile, satellite, Tor) every second opinion failed:
// public receipts stayed unproven and unspendable, and a payment the node in use relayed and then
// refused was forgotten and its coins freed (R-5 narrowed). Now they are opened together, each with
// the whole 8 s.
test('release re-audit 4 RE4-1: an honest second node that needs 3 s to open is waited for (production timeouts): the receipt is proven, a relayed-then-refused payment is kept', async () => {
  const chain = new FakeChain();
  const { backend, bc, servers } = twoNodes({ chain, electrum: { pingIntervalMs: 0 } });
  servers[1].openDelayMs = 3000; // a slow link to the second node: its open and handshake take 3 s
  const txid = fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  let s = backend.getState();
  assert.equal(s.server, URL1);
  assert.equal(backend.transparent.txs.get(txid).proof, 'two-servers', 'proven with the slow node');
  assert.equal(s.balance.public.available, String(3n * COIN), 'spendable');
  assert.equal(s.serverCheck.state, 'agree');
  // R-5: the node in use relays the payment, then answers an error; the slow node has it.
  bc.mode = 'relay-refuse';
  const r = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((e) => e);
  assert.match(String(r.txid), /^[0-9a-f]{64}$/, `sent and kept, not refused: ${r.code} ${r.message}`);
  assert.equal(r.code, undefined);
  assert.equal(backend.transparent.pending.has(r.txid), true, 'kept: its coin stays spent');
  s = backend.getState();
  assert.equal(s.balance.public.available, '0', 'not offered again');
  await backend.close();
});

test('release re-audit 4 RE4-1: every other node dark: "offline" within the 8 s cap, every connection closed; the person\'s own node contacts nobody', async () => {
  const [IN_USE, ...REST] = MAIN.servers;
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(IN_USE, chain.handler());
  const others = REST.map((u) => net.addServer(u, chain.handler()));
  const backend = createBackend({ network: 'main', servers: MAIN.servers.map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  assert.equal(backend.getState().server, IN_USE);
  for (const o of others) o.silent = true; // from here, blackholed: an open never completes
  const before = net.sockets.length;
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on('unhandledRejection', onUnhandled);
  const t0 = Date.now();
  const e = await backend._secondOpinion(async (c) => (await c.subscribeHeaders()).height).catch((x) => x);
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0, 'no unhandled rejection');
  assert.equal(e.code, 'offline');
  assert.ok(ms >= 7900 && ms < 8600, `gave up at the 8 s cap, not later (${ms} ms)`);
  const mine = net.sockets.slice(before);
  assert.deepEqual(mine.map((x) => x.url).sort(), [...REST].sort(), 'each other node tried once, together');
  assert.ok(mine.every((x) => x.readyState === 3), 'every connection it began is closed');
  assert.ok(others.every((o) => o.sockets.size === 0));
  // The person's own node: no other node is contacted at all.
  backend.ownNode = true;
  await assert.rejects(backend._secondOpinion(async () => 1), (x) => x.code === 'own-node');
  assert.equal(net.sockets.length, before + REST.length, 'not one more connection');
  backend.ownNode = false;
  await backend.close();
});

test('release re-audit 4 RE4-1: a node that opens after the answer, or while it is asked, is closed too; one that opens and drops the question hands it to the next', async () => {
  const [IN_USE, A, B, C] = MAIN.servers;
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(IN_USE, chain.handler());
  const plain = chain.handler();
  // A: opens, then drops the connection on any question (no answer); B: healthy; C: slow to open.
  const dropper = net.addServer(A, (m, p, socket) => {
    if (m === 'server.version') return plain(m, p, socket);
    queueMicrotask(() => socket.close());
    return FakeNet.NO_ANSWER;
  });
  const ok = net.addServer(B, chain.handler());
  const slow = net.addServer(C, chain.handler(), { openDelayMs: 300 });
  const backend = createBackend({ network: 'main', servers: MAIN.servers.map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const others = [A, B, C];
  const ask = async ({ hold = 0 } = {}) => {
    const before = net.sockets.length;
    const asked = [];
    const h = await backend._secondOpinion(async (c) => {
      asked.push(c.server);
      const height = (await c.subscribeHeaders()).height;
      if (hold) await new Promise((r) => setTimeout(r, hold));
      return height;
    });
    return { h, asked, mine: net.sockets.slice(before) };
  };
  // Start the rotation at A, the node that drops the question.
  while (others[backend._secondTurn % others.length] !== A) backend._secondTurn++;
  let r = await ask();
  assert.equal(r.h, chain.height);
  assert.deepEqual(r.asked, [A, B], 'the first open node did not answer; the next open one did');
  assert.ok(dropper.calls.some((c) => c.method === 'blockchain.headers.subscribe'));
  assert.ok(r.mine.every((x) => x.readyState === 3), 'all closed once answered, the slow one still opening');
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(slow.sockets.size, 0, 'the slow node, closed while opening, never opened');
  // The slow node opens while the answer is being given: closed at the end as well.
  while (others[backend._secondTurn % others.length] !== B) backend._secondTurn++;
  r = await ask({ hold: 500 });
  assert.deepEqual(r.asked, [B]);
  assert.ok(r.mine.some((x) => x.url === C && x.server), 'the slow node opened while B was answering');
  assert.ok(r.mine.every((x) => x.readyState === 3), 'every connection closed, the late one included');
  assert.equal(slow.sockets.size, 0);
  assert.equal(ok.sockets.size, 0);
  await backend.close();
});

// Release re-audit 5 RE5-3: `current` (the node in use, left out of the "others") was read as
// client.server, which is null while the main connection is down or moving to the next node, so
// every second opinion then contacted the node in use too, and asked it when it was first in order.
test('release re-audit 5 RE5-3: while the main connection is down or moving, no second opinion contacts the node it was on, nor the one it moves to (every caller)', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const inUse = net.addServer(URL1, chain.handler());
  const next = net.addServer(URL2, chain.handler());
  for (const u of MAIN.servers) net.addServer(u, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, relayLookMs: 0, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 500, backoffMaxMs: 500 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  assert.equal(backend.getState().server, URL1);
  /** Runs fn; -> the URLs it opened a connection to, and the nodes a second opinion asked. */
  const contacts = async (fn) => {
    const before = net.sockets.length;
    const asked = [];
    const second = backend._secondOpinion.bind(backend);
    backend._secondOpinion = (f, o) =>
      second(async (c) => {
        asked.push(c.server);
        return f(c);
      }, o);
    try {
      await fn();
    } finally {
      backend._secondOpinion = second;
    }
    // The main client's own reconnection is not a second opinion: only the sockets that are closed after it.
    return { opened: net.sockets.slice(before).filter((s) => s.readyState === 3).map((s) => s.url), asked };
  };
  const tip = () => backend._secondOpinion(async (c) => (await c.subscribeHeaders()).height);

  // Down: the node in use dropped the connection; the next try is 0.25-0.75 s away.
  inUse.dropAll();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(backend.client.server, null, 'the main connection is down');
  let c = await contacts(async () => assert.equal(await tip(), chain.height));
  assert.ok(!c.opened.includes(URL1) && !c.asked.includes(URL1), `the node it was on is not contacted (${c.opened})`);
  assert.ok(!c.opened.includes(URL2), 'nor the node it moves to');
  assert.ok(c.asked.length === 1 && MAIN.servers.includes(c.asked[0]), 'one of the other nodes answered');
  // Every caller: the R-5 look (a txid the network has) and the tip check (D-11; its own question to
  // the main connection waits for it to come back).
  const txid = fund(chain, OTHER.address, COIN, chain.height);
  c = await contacts(async () => {
    assert.equal(await backend._leftAnyway(txid), 'yes');
    assert.equal(backend.client.server, null, 'still down');
    await backend._checkTip();
  });
  assert.equal(c.asked.length, 2);
  assert.ok(!c.opened.includes(URL1) && !c.asked.includes(URL1), `the look and the tip check leave the node out (${c.asked})`);
  assert.equal(backend.getState().serverCheck.state, 'agree');
  for (let i = 0; i < 100 && backend.client.server !== URL2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(backend.client.server, URL2, 'the main connection moved on');

  // Moving: the node in use (now URL2) drops; the move back to URL1 takes 400 ms (a slow handshake).
  inUse.openDelayMs = 400;
  backend.client.backoffInitialMs = backend.client._backoff = 10;
  next.dropAll();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(backend.client.server, null, 'the main connection is moving to the next node');
  c = await contacts(async () => assert.equal(await tip(), chain.height));
  assert.ok(!c.opened.includes(URL2) && !c.opened.includes(URL1), `neither the node it was on nor the one it moves to (${c.opened})`);
  // Connected again: the node in use is left out as always, and the one it left is an "other" again.
  for (let i = 0; i < 100 && backend.client.server !== URL1; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(backend.client.server, URL1);
  inUse.openDelayMs = 0;
  c = await contacts(async () => assert.equal(await tip(), chain.height));
  assert.ok(!c.opened.includes(URL1), 'the node in use is not contacted');
  assert.ok(c.opened.includes(URL2), 'the node it left is one of the others again');
  await backend.close();
});

/**
 * Release re-audit 5 RE5-2: the node in use, two more of the person's nodes and Firo's four, the
 * others honest and opening in `delay` ms but one, LIAR, that opens at once and lies (`lie`):
 * 'have' (any transaction: "I have it"), 'noheader' (block.header: an error), 'tip+4' (a tip 4 blocks
 * ahead). Every node refuses broadcasts but the node in use; inUse.drop: the node in use drops the
 * connection on a broadcast, before an answer, without relaying it.
 */
function fastLiar({ lie, delay = 60, liarDelay = 0, inUse = {} } = {}) {
  const IN_USE = 'wss://inuse.example:50004';
  const LIAR = 'wss://liar.example:50004';
  const HONEST = ['wss://honest1.example:50004', 'wss://honest2.example:50004'];
  const net = new FakeNet();
  const chain = new FakeChain();
  const base = chain.handler();
  const mode = { drop: Boolean(inUse.drop) };
  const inUseServer = net.addServer(
    IN_USE,
    (m, p, socket) => {
      if (m !== 'blockchain.transaction.broadcast' || !mode.drop) return base(m, p, socket);
      queueMicrotask(() => socket.close());
      return FakeNet.NO_ANSWER;
    },
    { openDelayMs: delay }, // once the main connection has left it, one of the others: as slow as they are
  );
  const refuse = (handler) => (m, p, socket) => {
    if (m === 'blockchain.transaction.broadcast') throw Object.assign(new Error('bad-txns-inputs-missingorspent'), { code: 1 });
    return handler(m, p, socket);
  };
  const liar = net.addServer(
    LIAR,
    refuse((m, p, socket) => {
      if (lie === 'have' && m === 'blockchain.transaction.get') return chain.txs.get(p[0])?.hex ?? '02000000000000000000';
      if (lie === 'noheader' && m === 'blockchain.block.header') throw Object.assign(new Error('not available'), { code: -32000 });
      if (lie === 'tip+4' && m === 'blockchain.headers.subscribe') return { height: chain.height + 4, hex: headerHex(chain.height + 4) };
      return base(m, p, socket);
    }),
    { openDelayMs: liarDelay },
  );
  const honest = [...HONEST, ...MAIN.servers].map((u) => net.addServer(u, refuse(base), { openDelayMs: delay }));
  // A dropped main connection moves to an honest node (the liar is last of the person's list).
  const backend = createBackend({ network: 'main', servers: [IN_USE, ...HONEST, LIAR].map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, relayLookMs: 0, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10, backoffMaxMs: 20 } });
  const all = [inUseServer, liar, ...honest];
  const settle = async () => {
    for (let i = 0; i < 200 && !backend.getState().connected; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    await backend.waitForSync();
  };
  const mine = async () => {
    chain.height++;
    for (const x of all) x.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await settle();
  };
  return { backend, chain, net, mode, settle, mine, IN_USE, LIAR, others: [...HONEST, LIAR, ...MAIN.servers] };
}

// Release re-audit 5 RE5-2: since RE4-1 the first node to open was asked, so one node that opens
// faster than the rest was every second opinion: a lying one froze for good what used to heal within
// a few syncs (one question in N by rotation). Now, after the first node opens, the ones ahead of it
// in the question's rotating order are waited for a moment (SECOND_GRACE_MS), and the first in that
// order of those open is asked.
test('release re-audit 5 RE5-2: one fast lying node gets one question in N again: the rotation decides among nodes that open close together', async () => {
  const w = fastLiar({ lie: 'tip+4' });
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const others = w.others.filter((u) => u !== w.IN_USE);
  const asked = [];
  for (let i = 0; i < 14; i++) {
    const turn = w.backend._secondTurn % others.length;
    const first = [...others.slice(turn), ...others.slice(0, turn)][0];
    let who = null;
    await w.backend._secondOpinion(async (c) => {
      who = c.server;
      return (await c.subscribeHeaders()).height;
    });
    assert.equal(who, first, 'the first node of the rotating order is asked, not the first to open');
    asked.push(who);
  }
  assert.equal(asked.filter((u) => u === w.LIAR).length, 2, 'the liar: 2 questions of 14 with 7 others (was 14 of 14)');
  // The tip check (D-11): 'disagree' (sending paused) only on the liar's turns, not for good.
  const states = [];
  for (let i = 0; i < 9; i++) {
    w.backend.serverCheck.at -= 301;
    await w.mine();
    states.push(w.backend.getState().serverCheck.state);
  }
  assert.ok(states.filter((x) => x === 'agree').length >= 6, `the tip agrees on most checks: ${states}`);
  assert.equal(states.at(-1) === 'agree' || states.at(-2) === 'agree', true, 'and heals at the next check');
  await w.backend.close();
});

// Release re-audit 6 RE6-1: the grace was a fixed 1.5 s, so on a slow link (every node opening in
// seconds) a liar that opened more than 1.5 s before the honest nodes was every second opinion again.
// The grace now grows with how long the first node took to open: twice that, at least SECOND_GRACE_MS.
test('release re-audit 6 RE6-1: on a slow link the rotation still decides: a liar opening 1.8 s before the honest nodes gets its own turn only', async () => {
  const w = fastLiar({ lie: 'tip+4', delay: 2800, liarDelay: 1000 });
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const others = w.others.filter((u) => u !== w.IN_USE);
  const asked = [];
  for (let i = 0; i < others.length; i++) {
    let who = null;
    await w.backend._secondOpinion(async (c) => {
      who = c.server;
      return (await c.subscribeHeaders()).height;
    });
    asked.push(who);
  }
  assert.equal(asked.filter((u) => u === w.LIAR).length, 1, `the liar only on its own turn, of ${others.length}: ${asked.map((u) => new URL(u).hostname.split('.')[0]).join(' ')}`);
  await w.backend.close();
});

test('release re-audit 5 RE5-2: a fast node that withholds headers no longer keeps every public receipt unproven; a fast "I have it" no longer keeps a payment the network never took pending for ever', async () => {
  // R1-3: the receipt is proven (and spendable) within a few syncs.
  let w = fastLiar({ lie: 'noheader', delay: 40 });
  const txid = fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const proofs = [w.backend.transparent.txs.get(txid).proof];
  for (let i = 0; i < 4 && proofs.at(-1) !== 'two-servers'; i++) {
    await w.mine();
    proofs.push(w.backend.transparent.txs.get(txid).proof);
  }
  assert.equal(proofs.at(-1), 'two-servers', `proven: ${proofs}`);
  assert.equal(w.backend.getState().balance.public.available, String(3n * COIN));
  await w.backend.close();

  // R-6: the node in use dropped the broadcast without relaying it, no node takes the re-send, and
  // the fast liar says "I have it": after 6 blocks the honest nodes' word lets it go, coins free.
  w = fastLiar({ lie: 'have', delay: 40, inUse: { drop: true } });
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const e = await w.backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  w.mode.drop = false;
  await w.settle();
  assert.notEqual(w.backend.client.server, w.LIAR, 'the main connection moved to an honest node');
  assert.equal(w.chain.txs.has(e.txid), false, 'the network never took it');
  const tx = () => w.backend.getState().txs.find((x) => x.txid === e.txid);
  for (let i = 0; i < 14 && !tx()?.dropped; i++) await w.mine();
  assert.equal(tx()?.dropped, true, 'given up on the honest nodes\' word');
  assert.equal(w.backend.getState().balance.public.available, String(3n * COIN), 'its coin is free again');
  await w.backend.close();
});

test('release re-audit 5 RE5-2: what the wait costs (production timeouts): a dark node ahead at most the grace; a 3 s honest node alone is still used (RE4-1); one opening at 7 s is asked at the 8 s cap', async () => {
  // The person's own list holds one node; the others are Firo's four.
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(URL1, chain.handler());
  const firo = MAIN.servers.map((u) => net.addServer(u, chain.handler()));
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on('unhandledRejection', onUnhandled);
  /** One healthy node (Firo's `h`th) opening in `delay` ms, the rest dark, it `pos`th in the order. */
  const ask = async ({ h = 2, delay = 0, pos }) => {
    firo.forEach((x, k) => {
      x.silent = k !== h;
      x.openDelayMs = k === h ? delay : 0;
    });
    backend._secondTurn = (h - pos + 4) % 4;
    const before = net.sockets.length;
    const t0 = Date.now();
    let asked = null;
    const r = await backend._secondOpinion(async (c) => {
      asked = c.server;
      return (await c.subscribeHeaders()).height;
    }).catch((e) => e);
    const ms = Date.now() - t0;
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(net.sockets.slice(before).every((x) => x.readyState === 3), 'every connection it began is closed');
    return { ms, asked, r };
  };
  let q = await ask({ pos: 0 });
  assert.equal(q.r, chain.height);
  assert.ok(q.ms < 500, `first in the order: no wait (${q.ms} ms)`);
  q = await ask({ pos: 3 });
  assert.equal(q.asked, MAIN.servers[2]);
  assert.ok(q.ms >= 1400 && q.ms < 2100, `three dark nodes ahead cost the grace, together (${q.ms} ms)`);
  q = await ask({ delay: 3000, pos: 3 });
  assert.equal(q.r, chain.height, 'a 3 s honest node, the only one to open, is asked');
  // Re-audit 6 RE6-1: after a 3 s open the grace is the 3 s maximum (twice the open, capped), not 1.5 s.
  assert.ok(q.ms >= 5900 && q.ms < 6700, `3 s, then the grace for the dark ones ahead (${q.ms} ms)`);
  q = await ask({ delay: 7000, pos: 3 });
  assert.equal(q.r, chain.height, 'one that opens at 7 s still counts: the grace ends at the 8 s cap');
  assert.ok(q.ms >= 7900 && q.ms < 8600, `asked at the cap (${q.ms} ms)`);
  await new Promise((r) => setTimeout(r, 50));
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0, 'no unhandled rejection');
  await backend.close();
});

// Release re-audit 6 RE6-2: a lock during the second opinion of _notOnNetwork counted as "no second
// node could be reached" and started the one-node hour (in memory; the store refused the write).
test('release re-audit 6 RE6-2: a lock during the second opinion learns nothing: the one-node hour does not start', async () => {
  const [IN_USE, A, B, C] = MAIN.servers;
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(IN_USE, chain.handler());
  const plain = chain.handler();
  for (const u of [A, B, C]) {
    net.addServer(u, (m, p, socket) => (m === 'blockchain.transaction.get' ? FakeNet.NO_ANSWER : plain(m, p, socket)));
  }
  const backend = createBackend({ network: 'main', servers: MAIN.servers.map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const txid = 'ab'.repeat(32); // a payment the node in use has never seen
  const asking = backend._notOnNetwork(txid, null);
  await new Promise((r) => setTimeout(r, 150));
  await backend.close();
  const v = await asking;
  assert.deepEqual(v, { gone: false, since: null, oneNode: false }, 'a lock is not "no second node": the hour does not start');
  // An hour already running is kept as it was, neither restarted nor ended.
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const started = Math.floor(Date.now() / 1000) - 120;
  const again = backend._notOnNetwork(txid, started);
  await new Promise((r) => setTimeout(r, 150));
  await backend.close();
  assert.deepEqual(await again, { gone: false, since: started, oneNode: false });
});

// Release re-audit 5 RE5-5: a lock did not reach a second opinion in flight: its connections lived
// on until an answer or the 8 s cap (up to 120 s for a used-tag list), a node that opened after the
// lock was still asked, and Lock waited for it (close() waits for the sync the check runs in).
test('release re-audit 5 RE5-5: a lock ends a second opinion in flight: nothing more is asked, every connection is closed, and Lock does not wait for it', async () => {
  const [IN_USE, A, B, C] = MAIN.servers;
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(IN_USE, chain.handler());
  const plain = chain.handler();
  let hold = false; // the node asked keeps the question unanswered
  const others = [A, B, C].map((u) =>
    net.addServer(u, (m, p, socket) => {
      if (hold && m === 'blockchain.headers.subscribe') return FakeNet.NO_ANSWER;
      return plain(m, p, socket);
    }),
  );
  const backend = createBackend({ network: 'main', servers: MAIN.servers.map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0 } });
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on('unhandledRejection', onUnhandled);
  const reopen = async () => {
    await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
    await backend.waitForSync();
  };
  /** Starts a second opinion, locks after `after` ms: -> what it gave, how long after the lock, who was asked. */
  const lockDuring = async (after) => {
    const before = net.sockets.length;
    const asked = [];
    const p = backend
      ._secondOpinion(async (c) => {
        asked.push(c.server);
        return (await c.subscribeHeaders()).height;
      })
      .catch((e) => e);
    await new Promise((r) => setTimeout(r, after));
    const t0 = Date.now();
    await backend.close();
    const r = await p;
    const ms = Date.now() - t0;
    await new Promise((res) => setTimeout(res, 400));
    return { r, ms, asked, mine: net.sockets.slice(before) };
  };

  // While the nodes are opening (300 ms): none of them is asked once the wallet is locked.
  await reopen();
  for (const o of others) o.openDelayMs = 300;
  let q = await lockDuring(50);
  assert.equal(q.r.code, 'closed', `ended by the lock, not answered (${q.r})`);
  assert.ok(q.ms < 200, `at once (${q.ms} ms)`);
  assert.deepEqual(q.asked, [], 'a node that opened after the lock is not asked');
  assert.ok(q.mine.length === 3 && q.mine.every((x) => x.readyState === 3), 'every connection it began is closed');
  assert.ok(others.every((o) => o.sockets.size === 0));

  // While a node holds the question: it ends at once, no other node is asked.
  for (const o of others) o.openDelayMs = 0;
  await reopen();
  hold = true;
  q = await lockDuring(100);
  hold = false;
  assert.equal(q.r.code, 'closed');
  assert.ok(q.ms < 200, `at once, not at the 8 s timeout (${q.ms} ms)`);
  assert.equal(q.asked.length, 1, 'the next node is not asked instead');
  assert.ok(q.mine.every((x) => x.readyState === 3));

  // Lock during a sync whose tip check waits on nodes that never open: Lock is not held for 8 s.
  await reopen();
  for (const o of others) o.silent = true;
  backend.serverCheck.at -= 301;
  chain.height++;
  const before = net.sockets.length;
  backend._requestSync();
  for (let i = 0; i < 50 && net.sockets.length === before; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(net.sockets.length > before, 'the tip check is waiting on the other nodes');
  const t0 = Date.now();
  await backend.close();
  assert.ok(Date.now() - t0 < 500, `locked in ${Date.now() - t0} ms`);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(net.sockets.slice(before).every((x) => x.readyState === 3), 'every connection closed');
  process.off('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0, 'no unhandled rejection');
});

// ---------------------------------------------------------------- audit D-09: anonymity sets

/** Two fake servers' chains with the same group-1 blocks (same hashes and heights), the second's `edit(coins, i)`ed. */
function twinChains(blocks, edit, opts = {}) {
  const a = new FakeChain(opts);
  for (const coins of blocks) a.addBlock(1, coins);
  return [a, copyChain(a, edit, opts)];
}

/** Another fake server's view of `from`'s group-1 blocks (same hashes and heights), `edit(coins, i)`ed. */
function copyChain(from, edit, opts = {}) {
  const b = new FakeChain(opts);
  from.groups.get(1).forEach((blk, i) => b.addBlock(1, edit(blk.coins, i), { hash: blk.hash }));
  return b;
}

function multiWorld(handlers, spark = new FakeSpark()) {
  const net = new FakeNet();
  const urls = handlers.map((_, i) => `wss://fake${i + 1}.example:50004`);
  const servers = handlers.map((h, i) => net.addServer(urls[i], h));
  const backend = createBackend({ network: 'main', servers: urls.map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  return { backend, urls, servers, spark, net };
}

test('audit D-09: a set with a coin left out under the real hash is caught before anything is built; on another server the payment goes', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 3n * COIN });
  const [honest, pruned] = twinChains([[fakeCoin(), fakeCoin()], [mine, fakeCoin(), fakeCoin()], [fakeCoin(), fakeCoin()]], (coins, i) => (i === 2 ? coins.slice(1) : coins));
  // The server in use serves the pruned set but reports the real hash: before the fix the wallet
  // built and broadcast a payment over it, which told the server our coin was among those kept.
  const realHash = honest.handler()('spark.getsparkanonymitysetmeta', ['1']).setHash;
  const lie = pruned.handler();
  const { backend, urls, spark: lib } = multiWorld([(m, p, s) => (m === 'spark.getsparkanonymitysetmeta' ? { ...lie(m, p, s), setHash: realHash } : lie(m, p, s)), honest.handler(), honest.handler()], spark);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal(backend.getState().server, urls[0]);
  // Caught in the background, before any payment (P4): the coin waits, never counted, and Home offers another node.
  assert.equal(backend.getState().balance.private.available, '0');
  assert.equal(backend.getState().balance.private.pending, String(3n * COIN));
  assert.deepEqual(backend.getState().privateCheck, { code: 'set-mismatch', otherServer: true });
  assert.equal(backend.getState().txs.find((t) => t.kind === 'spark' || t.direction === 'in')?.unproven, true);
  // A coin confirmed before this node began to lie: the payment's own check stops it.
  provenEarlier(backend);
  assert.equal(backend.getState().balance.private.available, String(3n * COIN));
  const pay = { from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] };
  await assert.rejects(backend.send(pay), (e) => e.code === 'set-mismatch' && e.otherServer === true && e.message === "This Firo node's list of private coins does not add up, so the payment was stopped to keep it private.");
  assert.ok(!lib.calls.includes('spend'), 'the Spark library was never asked to build it');
  assert.equal(pruned.broadcasts.length, 0, 'nothing reached the server');
  // Another server: the list is fetched again from it, checked, confirmed by a third, and sent.
  assert.deepEqual(await backend.useAnotherServer(), { server: urls[1] });
  await backend.waitForSync();
  assert.equal(backend.getState().server, urls[1]);
  assert.equal(backend.getState().privateCheck, null, 'the new node\'s lists add up');
  const { txid } = await backend.send(pay);
  assert.equal(decodeTx(honest.broadcasts.at(-1), MAIN).txid, txid);
  assert.equal(lib.lastSpend.coverSets[0].coins.length, honest.serverList(1).length);
  await backend.close();
});

test('audit D-09: a server that hashes the coins it serves itself is caught by a second server\'s hash', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 3n * COIN });
  // The server in use swaps a decoy for one of its own and reports the hash of what it serves.
  const blocks = [[fakeCoin(), fakeCoin()], [mine, fakeCoin()], [fakeCoin(), fakeCoin()]];
  const [honest, swapped] = twinChains(blocks, (coins, i) => (i === 2 ? [coins[0], fakeCoin()] : coins));
  const { backend } = multiWorld([swapped.handler(), honest.handler()], spark);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal((await backend.sparkSync.verifyGroup(1, { tipHeight: swapped.height })).state, 'match', 'its coins do give its hash');
  // The second node's hash differs: caught in the background (P4); then at payment time, for a coin confirmed earlier.
  assert.deepEqual(backend.getState().privateCheck, { code: 'set-disagree', otherServer: true });
  assert.equal(backend.getState().balance.private.available, '0');
  provenEarlier(backend);
  await assert.rejects(backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }), (e) => e.code === 'set-disagree' && e.otherServer === true && /Two Firo nodes gave different lists of private coins/.test(e.message));
  assert.ok(!spark.calls.includes('spend'));
  assert.equal(swapped.broadcasts.length, 0);
  await backend.close();
  // Group 1's first block is in no hash (firod; 5 coins on mainnet): a coin swapped there changes
  // no hash at all, so those coins are compared with the second server's one by one.
  const early = copyChain(honest, (coins, i) => (i === 0 ? [coins[0], fakeCoin()] : coins));
  assert.equal(early.handler()('spark.getsparkanonymitysetmeta', ['1']).setHash, honest.handler()('spark.getsparkanonymitysetmeta', ['1']).setHash);
  const w2 = multiWorld([early.handler(), honest.handler()], spark);
  await w2.backend.open({ mnemonic: W.mnemonic });
  await w2.backend.waitForSync();
  assert.equal(w2.backend.getState().privateCheck?.code, 'set-disagree');
  provenEarlier(w2.backend);
  await assert.rejects(w2.backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }), (e) => e.code === 'set-disagree');
  await w2.backend.close();
});

test('audit D-09: a second server a block ahead confirms our hash by carrying it over its newer coins', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 3n * COIN });
  const blocks = [[fakeCoin(), fakeCoin()], [mine, fakeCoin()], [fakeCoin()]];
  const [ours, ahead] = twinChains(blocks, (c) => c);
  ahead.addBlock(1, [fakeCoin(), fakeCoin()]);
  const { backend, servers } = multiWorld([ours.handler(), ahead.handler()], spark);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal([...backend.ownCoins.values()][0].proof, 'two-servers', 'confirmed in the background by the node ahead (P4)');
  await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.ok(servers[1].methods().includes('blockchain.block.txids'), 'the newer coins placed in their blocks by that server');
  await backend.close();
  // Our server's own hash over a swapped coin, the other a block ahead: carried over, it does not reach that server's.
  const swapped = copyChain(ours, (coins, i) => (i === 1 ? [coins[0], fakeCoin()] : coins));
  const w2 = multiWorld([swapped.handler(), ahead.handler()], spark);
  await w2.backend.open({ mnemonic: W.mnemonic });
  await w2.backend.waitForSync();
  assert.equal(w2.backend.getState().privateCheck?.code, 'set-disagree');
  provenEarlier(w2.backend);
  await assert.rejects(w2.backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }), (e) => e.code === 'set-disagree');
  await w2.backend.close();
});

test('audit D-09 / P4: the newest set is checked in the background for every wallet; a received coin waiting for proof gets every set held checked (never only its own); a carried-over coin covers the group before', async () => {
  const chain = new FakeChain({ startGroupSize: 2 });
  const { backend, spark, mine } = world({ chain });
  const old = fakeCoin();
  spark.own(old, { value: 2n * COIN });
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(1, [old, fakeCoin()]); // group 2 will carry this block over
  chain.addBlock(2, [fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic }); // a restore: groups 1 and 2
  await backend.waitForSync();
  const coin = [...backend.ownCoins.values()][0];
  assert.deepEqual([coin.groupId, coin.index < 2], [2, true], 'our coin is among those group 2 carried over');
  assert.equal((await backend.sparkSync.verifiedState(2)).hash, chain.handler()('spark.getsparkanonymitysetmeta', ['2']).setHash, 'the newest set: checked');
  // Our coin waited for proof (P4): every set this wallet holds was checked, the older one too, all
  // of them: which ones hold our coins is still not told.
  const v1 = await backend.sparkSync.verifiedState(1);
  assert.equal(v1.size, 4, 'group 1 checked whole: its chain is the one covering our coin');
  assert.equal(coin.proof, 'two-servers');
  await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.deepEqual(spark.lastSpend.coverSets.map((s) => s.groupId), [2]);
  await backend.close();
  // A new wallet with no coins checks the newest set too, at most 6,000 blocks a sync.
  const c2 = new FakeChain();
  c2.addBlock(1, [fakeCoin()]);
  c2.height += 40000;
  c2.addBlock(1, [fakeCoin(), fakeCoin()]);
  const w = world({ chain: c2 });
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: c2.height });
  await w.backend.waitForSync();
  const txidCalls = () => w.net.sockets.flatMap((s) => s.sent).filter((t) => t.includes('blockchain.block.txids')).reduce((n, t) => n + (t.match(/blockchain\.block\.txids/g) || []).length, 0);
  let syncs = 0;
  while ((await w.backend.sparkSync.verifiedState(1)).size < 3 && syncs < 20) {
    await w.mine();
    syncs++;
  }
  assert.equal((await w.backend.sparkSync.verifiedState(1)).size, 3);
  assert.ok(syncs >= 3, `spread over syncs (${syncs} more after the first)`);
  assert.ok(txidCalls() <= 40003 + 6000, 'no block read twice beyond one sync\'s share');
  await w.backend.close();
  void mine;
});

test('audit D-10: our names come with expiry and note from the full list, nothing asked about them; one is asked about only on request', async () => {
  const { backend, chain } = world();
  chain.addBlock(1, [fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const me = backend.getState().receive.spark;
  const asked = () => chain.calls.filter((m) => m === 'spark.getsparknamedata').length;
  // As firod's getsparknames: every name's expiry block, and its note when it has one.
  chain.names = [{ name: 'me', address: me, validUntil: 1500000, additionalInfo: 'hi' }, { name: 'other', address: 'sm1' + 'z'.repeat(140), validUntil: 1600000 }];
  backend._names = null;
  assert.deepEqual(await backend.sparkNames.listDetailed(), [{ name: 'me', address: me, validUntil: 1500000, additionalInfo: 'hi' }]);
  assert.equal(asked(), 0, 'the Names screen asks nothing about our names');
  // A renewal keeps the note, from the list too.
  const renewals = [];
  backend._registerName = async (o) => {
    renewals.push(o);
    throw Object.assign(new Error('stopped here (test)'), { code: 'test' });
  };
  await assert.rejects(backend.sparkNames.renew({ name: 'me' }), (e) => e.code === 'test');
  assert.deepEqual([renewals[0].name, renewals[0].additionalInfo], ['me', 'hi']);
  assert.equal(asked(), 0);
  // A server whose list carries no expiry: unknown until the person asks about that one name.
  chain.names = [{ name: 'me', address: me }, { name: 'other', address: 'sm1' + 'z'.repeat(140) }];
  chain.extra = { 'spark.getsparknamedata': ([n]) => (n === 'me' ? { address: me, validUntil: 1500000, additionalInfo: 'hi' } : null) };
  backend._names = null;
  assert.deepEqual(await backend.sparkNames.listDetailed(), [{ name: 'me', address: me, validUntil: null, additionalInfo: null }]);
  assert.equal(asked(), 0);
  assert.deepEqual(await backend.sparkNames.details('@me'), { validUntil: 1500000, additionalInfo: 'hi' });
  assert.equal(asked(), 1, 'asked once, on request');
  await assert.rejects(backend.sparkNames.details('other'), (e) => e.code === 'invalid-name');
  assert.equal(asked(), 1, 'never about a name that is not ours');
  // Renewing on such a server asks then (the renewal names it and its address to that server anyway).
  await assert.rejects(backend.sparkNames.renew({ name: 'me' }), (e) => e.code === 'test');
  assert.deepEqual([renewals[1].additionalInfo, asked()], ['hi', 2]);
  await backend.close();
});

test('second audit X8: the engine never pays for a name twice: taken, already ours, being registered, or a renewal on its way', async () => {
  const { backend, chain } = world();
  chain.addBlock(1, [fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const me = backend.getState().receive.spark;
  chain.names = [{ name: 'me', address: me }, { name: 'taken', address: 'sm1' + 'z'.repeat(140) }];
  backend._names = { at: Date.now(), list: [] }; // a list 60 s stale that has none of them: read fresh anyway
  const notPaid = (re) => (e) => e.code === 'name-taken' && re.test(e.message) && sendOutcome(e).kind === 'not-sent';
  await assert.rejects(backend.sparkNames.register({ name: 'taken' }), notPaid(/^@taken is taken, so nothing was paid\.$/));
  await assert.rejects(backend.sparkNames.register({ name: 'taken', renew: true }), notPaid(/is taken/), 'a caller cannot call it a renewal');
  await assert.rejects(backend.sparkNames.register({ name: 'ME' }), notPaid(/This wallet already has @ME, so nothing was paid\. Renew it/));
  // One this wallet sent and that is not in any list yet (on its way, or mined behind a lagging list).
  backend.sends.set('ab'.repeat(32), { kind: 'spark-name', to: '@fresh', amount: '100', fee: '1', time: 1 });
  await assert.rejects(backend.sparkNames.register({ name: 'Fresh' }), notPaid(/already registering @Fresh/));
  backend.sends.get('ab'.repeat(32)).dropped = true; // dropped: it may be tried again
  const tries = [];
  const realSend = backend.send.bind(backend);
  backend.send = async (req) => (tries.push(req.nameInfo.name), { txid: 'cd'.repeat(32) });
  await backend.sparkNames.register({ name: 'fresh' });
  assert.deepEqual(tries, ['fresh']);
  // A renewal of our name while another renewal of it is on its way: refused; once confirmed, it goes.
  backend.sends.set('ef'.repeat(32), { kind: 'spark-name', to: '@me', amount: '100', fee: '1', time: 1 });
  await assert.rejects(backend.sparkNames.renew({ name: 'me' }), notPaid(/A renewal of @me is still on its way/));
  backend.sends.get('ef'.repeat(32)).confirmed = true;
  await backend.sparkNames.renew({ name: 'me' });
  assert.deepEqual(tries, ['fresh', 'me']);
  backend.send = realSend;
  await backend.close();
});

test('audit L7: a name\'s cost, network fee included, is quoted with nothing paid or asked, and the registration pays only those figures', async () => {
  const { backend, chain } = world();
  chain.addBlock(1, [fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const asked = [];
  const realQuote = backend.quote.bind(backend);
  backend.quote = async (req) => (asked.push(req), { fee: '4000', total: String(BigInt(req.to[0].amount) + 4000n), change: '0', warnings: [] });
  const before = backend.sparkAddr.diversifier;
  const q = await backend.sparkNames.quote({ name: 'fresh', years: 2, additionalInfo: 'hi' });
  assert.deepEqual(q, { fee: '4000', total: String(2n * 10n * COIN + 4000n), change: '0', warnings: [] });
  assert.equal(asked[0].nameInfo.name, 'fresh');
  assert.equal(asked[0].nameInfo.additionalInfo, 'hi');
  assert.equal(backend.sparkAddr.diversifier, before, 'no address made for a quote');
  backend.quote = realQuote;
  // The payment carries the figures shown; the engine's send refuses other ones (as for any payment).
  const sent = [];
  const realSend = backend.send.bind(backend);
  backend.send = async (req) => (sent.push(req), { txid: 'cd'.repeat(32) });
  chain.names = [];
  backend._names = { at: Date.now(), list: [] };
  await backend.sparkNames.register({ name: 'fresh', years: 2, expect: { fee: '4000', total: q.total } });
  assert.deepEqual(sent[0].expect, { fee: '4000', total: q.total });
  backend.send = realSend;
  await backend.close();
});

test('public audit PN-keys: closing the engine (Lock) makes the page\'s Spark client drop the view keys it derived', async () => {
  const spark = new FakeSpark();
  let forgot = 0;
  spark.forgetKeys = () => forgot++;
  const { backend } = world({ spark });
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal(forgot, 0);
  await backend.close();
  assert.equal(forgot, 1);
});

test('public audit PN: "another node has it" only when its bytes hash to the txid', async () => {
  const { backend, chain } = world();
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  backend._relayLookMs = 0;
  const txid = fund(chain, OTHER.address, COIN, chain.height);
  assert.equal(await backend._leftAnyway(txid), 'yes', 'the real bytes');
  // A node that answers with other bytes (or junk) for that txid: it tells nothing.
  const other = fund(chain, OTHER.address, 2n * COIN, chain.height);
  const otherHex = chain.txs.get(other).hex ?? chain.txs.get(other);
  chain.extra = { 'blockchain.transaction.get': () => (typeof otherHex === 'string' ? otherHex : 'ab'.repeat(60)) };
  assert.equal(await backend._leftAnyway(txid), 'unknown');
  chain.extra = { 'blockchain.transaction.get': () => 'zz' };
  assert.equal(await backend._leftAnyway(txid), 'unknown');
  await backend.close();
});

test('public audit PN: no payment pays a network fee above 0.05 FIRO, whatever its plan says', async () => {
  const { backend, chain } = world();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  let built = 0;
  backend._plan = async () => ({ fee: MAX_PAYMENT_FEE + 1n, total: COIN, change: 0n, warnings: [], build: async () => (built++, null) });
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'invalid-amount');
  assert.match(e.message, /^The network fee came out at 0\.05000001 FIRO, far above what Firo needs, so nothing was sent\.$/);
  assert.equal(built, 0);
  assert.equal(chain.broadcasts.length, 0);
  assert.equal(MAX_PAYMENT_FEE, 5000000n);
  await backend.close();
});

// ---------------------------------------------------------------- audit D-12: used tags

/** A chain with our coins a (2 FIRO) and b (3 FIRO), 50 others' spends, then a spent elsewhere (the same seed in another app). */
function taggedChain(spark) {
  const chain = new FakeChain();
  const a = fakeCoin();
  const b = fakeCoin();
  spark.own(a, { value: 2n * COIN });
  spark.own(b, { value: 3n * COIN });
  chain.addBlock(1, [fakeCoin(), a, b]);
  for (let i = 0; i < 50; i++) chain.tags.push({ tag: fakeTag(900000 + i), txid: bytesToHex(sha256d(Uint8Array.of(i, 7))) });
  chain.tags.push({ tag: fakeTag(a.id), txid: 'ab'.repeat(32) });
  return { chain, a };
}

/** A server answering as `chain` does, but `edit`ing its used-tag lists while `on()`. */
function tagLiar(chain, edit, on = () => true) {
  const real = chain.handler();
  return (m, p, s) => {
    const r = real(m, p, s);
    return m === 'spark.getusedcoinstagstxhashes' && on() ? { tagsandtxids: edit(r.tagsandtxids) } : r;
  };
}

const at = (backend) => {
  const s = backend.getState();
  return assessSync({ raw: s, everConnected: true, now: s.tip.time });
};

test('audit D-12: used tags a server leaves out are caught by a second server, and while the two disagree no coin is marked on one server\'s word', async () => {
  const spark = new FakeSpark();
  const { chain, a } = taggedChain(spark);
  const ours = bytesToBase64(fakeTag(a.id));
  let lying = true;
  // 1. The server in use leaves out the tag of our spent coin: a restored wallet shows 5 FIRO, not 3.
  const w = multiWorld([tagLiar(chain, (list) => list.filter(([t]) => t !== ours), () => lying), chain.handler()], spark);
  await w.backend.open({ mnemonic: W.mnemonic }); // a restore: every tag, from 0
  await w.backend.waitForSync();
  let s = w.backend.getState();
  assert.deepEqual([s.serverCheck.state, s.serverCheck.about], ['disagree', 'spent']);
  assert.deepEqual([at(w.backend).state, at(w.backend).canSend], ['disagree', false]);
  assert.match(at(w.backend).detail, /do not agree on which private coins are already spent\. Sending is paused; choose another Firo node\./);
  // It answers truly again: the next check agrees, and only then is the coin spent.
  lying = false;
  w.backend.tagCheck.at -= 1000;
  w.backend._requestSync();
  await w.backend.waitForSync();
  s = w.backend.getState();
  assert.notEqual(s.serverCheck?.about, 'spent');
  assert.equal(w.backend.tagCheck.state, 'agree');
  assert.equal(s.balance.private.available, String(3n * COIN));
  assert.equal(at(w.backend).canSend, true);
  await w.backend.close();

  // 2. The other way round: our server is right, the second leaves the tag out. While they
  // disagree our coin is not marked spent on our server's word either; once they agree, it is.
  let second = true;
  const w2 = multiWorld([chain.handler(), tagLiar(chain, (list) => list.filter(([t]) => t !== ours), () => second)], spark);
  await w2.backend.open({ mnemonic: W.mnemonic });
  await w2.backend.waitForSync();
  assert.equal(w2.backend.tagCheck.state, 'disagree');
  assert.equal(w2.backend.getState().balance.private.available, String(5n * COIN), 'not marked spent while in doubt');
  assert.ok([...w2.backend.ownCoins.values()].every((c) => !c.spentTxid));
  second = false;
  w2.backend.tagCheck.at -= 1000;
  w2.backend._requestSync();
  await w2.backend.waitForSync();
  assert.equal(w2.backend.tagCheck.state, 'agree');
  assert.equal(w2.backend.getState().balance.private.available, String(3n * COIN));
  await w2.backend.close();
});

test('audit D-12: an old tag left out with a made-up one in its place (the count kept) is caught on a restore\'s first check', async () => {
  const spark = new FakeSpark();
  const { chain, a } = taggedChain(spark);
  // Our spent coin's tag moved before 49 others, so it is not in any recent range.
  chain.tags.unshift(chain.tags.pop());
  const ours = bytesToBase64(fakeTag(a.id));
  const fake = bytesToBase64(fakeTag(777777));
  const w = multiWorld([tagLiar(chain, (list) => list.map(([t, x]) => (t === ours ? [fake, x] : [t, x]))), chain.handler()], spark);
  await w.backend.open({ mnemonic: W.mnemonic });
  await w.backend.waitForSync();
  assert.deepEqual([w.backend.tagCheck.state, w.backend.tagCheck.ours, w.backend.tagCheck.theirs], ['disagree', 51, 51]);
  await w.backend.close();
});

test('audit D-12: two servers that agree: later checks ask only from where they last agreed; different tips are no disagreement', async () => {
  const spark = new FakeSpark();
  const { chain } = taggedChain(spark);
  const w = multiWorld([chain.handler(), chain.handler()], spark);
  await w.backend.open({ mnemonic: W.mnemonic }); // a restore: every tag; the first check compares them all
  await w.backend.waitForSync();
  assert.equal(w.backend.tagCheck.state, 'agree');
  const agreed = w.backend.progress.tagsAgreed.count;
  assert.equal(agreed, 51);
  for (let i = 0; i < 3; i++) chain.tags.push({ tag: fakeTag(800000 + i), txid: bytesToHex(sha256d(Uint8Array.of(i, 9))) });
  w.backend.tagCheck.at -= 1000;
  w.backend._requestSync();
  await w.backend.waitForSync();
  const asks = w.servers[1].calls.filter((c) => c.method === 'spark.getusedcoinstagstxhashes').map((c) => Number(c.params[0]));
  assert.equal(asks.at(-1), agreed - 30, 'from the last agreement (less the overlap), not from the start');
  assert.equal(w.backend.tagCheck.state, 'agree');
  assert.equal(w.backend.progress.tagsAgreed.count, agreed + 3);
  await w.backend.close();
  // The second server a block ahead: no comparison (lists of different blocks), no disagreement; asked again soon.
  const real = chain.handler();
  const ahead = (m, p, s) => (m === 'blockchain.headers.subscribe' ? { height: chain.height + 1, hex: headerHex(chain.height + 1) } : real(m, p, s));
  const w2 = multiWorld([chain.handler(), ahead], spark);
  await w2.backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await w2.backend.waitForSync();
  assert.deepEqual([w2.backend.tagCheck.state, w2.backend.tagCheck.retrySoon], ['unknown', true]);
  assert.notEqual(w2.backend.getState().serverCheck?.about, 'spent');
  await w2.backend.close();
});

test("the person's own node is never second-guessed: no public node is contacted, the checks say 'own-node'", async () => {
  const PUBLIC = 'wss://electrumx.firo.org:50004';
  for (const ownNode of [false, true]) {
    const net = new FakeNet();
    const chain = new FakeChain();
    const publicChain = new FakeChain();
    net.addServer(URL1, chain.handler());
    net.addServer(PUBLIC, publicChain.handler());
    const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], ownNode, store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
    await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
    await backend.waitForSync();
    await backend._checkTip();
    if (ownNode) {
      assert.equal(backend.getState().serverCheck.state, 'own-node');
      assert.equal(publicChain.calls.length, 0, 'not one question to a public node');
    } else {
      assert.equal(backend.getState().serverCheck.state, 'agree', 'on public nodes, a second one is asked');
      assert.ok(publicChain.calls.length > 0);
    }
    await backend.close();
  }
});

test('checkNode: a node that answers gives its newest block and how long it took; one that does not, says so', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(URL1, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const up = await backend.checkNode(URL1);
  assert.equal(up.ok, true);
  assert.equal(up.height, chain.height);
  assert.ok(up.ms >= 1);
  const down = await backend.checkNode('wss://nobody.example:50004', { timeoutMs: 1500 });
  assert.equal(down.ok, false);
  assert.ok(down.error);
});

// ---------------------------------------------------------------- audit FM-1: a broadcast with no answer

/**
 * Two nodes over one chain, whose broadcasts the test controls: `bc.mode` 'answer' (as a node does),
 * 'drop' (the bytes arrive, the connection drops before any answer, nothing relayed), 'relay-drop'
 * (relayed, then the connection drops), 'refuse' (an error answer), 'relay-refuse' (relayed, then an
 * error answer). bc.seen(hex) runs as the bytes arrive: what the wallet had written down by then.
 * bc.onGet(txid) runs as a node is asked for a transaction (its result, if not undefined, is the answer).
 * electrum: the engine's connection options (production ones: no timeouts given).
 */
function twoNodes({ spark = new FakeSpark(), store = createMemoryStore(), chain = new FakeChain(), electrum = { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10, backoffMaxMs: 20 } } = {}) {
  const net = new FakeNet();
  const base = chain.handler();
  const bc = { mode: 'answer', seen: null, count: 0, onGet: null };
  const handler = (m, p, socket) => {
    if (m === 'blockchain.transaction.get' && bc.onGet) {
      const r = bc.onGet(p[0]);
      if (r !== undefined) return r;
    }
    if (m !== 'blockchain.transaction.broadcast' || bc.mode === 'answer') return base(m, p, socket);
    bc.count++;
    bc.seen?.(p[0]);
    if (bc.mode === 'refuse') throw Object.assign(new Error('bad-txns-inputs-missingorspent'), { code: 1 });
    if (bc.mode === 'relay-refuse') {
      base(m, p, socket);
      throw Object.assign(new Error('bad-txns-inputs-missingorspent'), { code: 1 });
    }
    if (bc.mode === 'known') throw Object.assign(new Error('txn-already-in-mempool'), { code: 1 });
    if (bc.mode === 'known2') throw Object.assign(new Error('txn-already-known'), { code: -27 });
    if (bc.mode === 'no-result') {
      base(m, p, socket);
      return FakeNet.NO_RESULT;
    }
    // The node has the bytes and has not answered yet (bc.seen may lock the wallet meanwhile).
    if (bc.mode === 'hold') return FakeNet.NO_ANSWER;
    if (bc.mode === 'relay-drop') base(m, p, socket);
    queueMicrotask(() => socket.close());
    return FakeNet.NO_ANSWER;
  };
  const servers = [net.addServer(URL1, handler), net.addServer(URL2, handler)];
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store, spark, WebSocket: net.WebSocket, relayLookMs: 0, electrum });
  const settle = async () => {
    for (let i = 0; i < 200 && !backend.getState().connected; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    await backend.waitForSync();
  };
  const mine = async (txid) => {
    if (txid) chain.confirm(txid);
    else chain.height++;
    for (const s of servers) s.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await settle();
  };
  return { backend, chain, spark, store, bc, mine, settle, servers, net };
}

test('audit FM-1: a private payment with no answer is written down before it leaves, "unsure" with its txid, its coin kept spent, then seen and followed', async () => {
  const { backend, chain, spark, store, bc, settle } = twoNodes();
  const a = fakeCoin();
  const b = fakeCoin();
  spark.own(a, { value: 5n * COIN });
  spark.own(b, { value: 3n * COIN });
  chain.addBlock(1, [a, fakeCoin(), b]);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal(backend.getState().balance.private.available, String(8n * COIN));
  let atBroadcast = null;
  bc.mode = 'drop';
  bc.seen = async (hex) => {
    const sends = await store.get('s/sends');
    const coins = await store.get('s/coins');
    const txid = decodeTx(hex, MAIN).txid;
    atBroadcast = { logged: Boolean(sends?.[txid]?.hex === hex), coinPending: coins.filter((c) => c.pendingSpentTxid === txid).length };
  };
  const e = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure', e.message);
  assert.equal(e.message, "Your payment may have left. Don't send it again yet: Campfire is checking.");
  assert.match(e.txid, /^[0-9a-f]{64}$/);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(atBroadcast, { logged: true, coinPending: 1 }, 'the payment and its coin were in the store before the bytes left');
  // Reconnected (to the other node): the coin it spends is still spent, the payment is in Activity.
  bc.mode = 'answer';
  await settle();
  let s = backend.getState();
  const spent = [...backend.ownCoins.values()].filter((c) => c.pendingSpentTxid === e.txid);
  assert.equal(spent.length, 1, 'the coin it spends stays spent');
  const usedCoin = [a, b].find((x) => spark.own(x, { value: x === a ? 5n * COIN : 3n * COIN }) === spent[0].lTagHash);
  const free = usedCoin === a ? 3n * COIN : 5n * COIN;
  assert.equal(s.balance.private.available, String(free), 'only the other coin is free');
  let tx = s.txs.find((t) => t.txid === e.txid);
  assert.ok(tx, 'it is in the history');
  assert.equal(tx.direction, 'out');
  assert.equal(tx.amount, String(COIN));
  assert.equal(tx.unsure, true);
  // It did reach the network: once seen in the mempool, it is no longer in doubt.
  chain.mempool.set(e.txid, { coins: [], lTags: [fakeTag(usedCoin.id)] });
  backend._requestSync();
  await backend.waitForSync();
  tx = backend.getState().txs.find((t) => t.txid === e.txid);
  assert.equal(tx.unsure, undefined);
  assert.equal(backend.getState().balance.private.available, String(free));
  await backend.close();
});

test('audit R1-1: a private payment whose spent coins are not all found among the wallet\'s own is refused before it is written down or sent', async () => {
  const { backend, chain, spark } = twoNodes();
  const a = fakeCoin();
  spark.own(a, { value: 5n * COIN });
  chain.addBlock(1, [a, fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  // The library says it spent a coin this wallet does not know as its own.
  const orig = spark.createSparkSpendTransaction.bind(spark);
  spark.createSparkSpendTransaction = async (args) => ({ ...(await orig(args)), usedCoins: [{ coin: fakeCoin().coin, groupId: 1 }] });
  const e = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'server');
  assert.equal(e.message, 'Campfire could not tell which of your private coins this payment spends, so it was not sent.');
  assert.equal(sendOutcome(e).kind, 'not-sent');
  assert.equal(chain.broadcasts.length, 0, 'nothing broadcast');
  assert.equal(backend.sends.size, 0, 'nothing written down');
  assert.equal(backend.getState().balance.private.available, String(5n * COIN), 'no coin marked');
  // With the library naming the coin it really spent, the payment goes, its coin pending-spent.
  spark.createSparkSpendTransaction = orig;
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.deepEqual(backend.sends.get(txid).coins, [[...backend.ownCoins.keys()][0]]);
  assert.equal(backend.getState().balance.private.available, '0');
  await backend.close();
});

test('audit FM-1: a public payment relayed, then the connection lost: "unsure"; the next sync finds it, its coins never come back as free', async () => {
  const { backend, chain, bc, mine, settle } = twoNodes();
  const t1 = fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  let pendingAtBroadcast = null;
  bc.mode = 'relay-drop';
  bc.seen = (hex) => {
    pendingAtBroadcast = backend.transparent.pending.has(decodeTx(hex, MAIN).txid);
  };
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure', e.message);
  assert.equal(pendingAtBroadcast, true, 'written down before it was broadcast');
  const d = decodeTx(chain.broadcasts.at(-1), MAIN);
  assert.equal(d.txid, e.txid);
  assert.deepEqual(d.vin.map((i) => i.txid), [t1]);
  bc.mode = 'answer';
  await settle();
  let s = backend.getState();
  assert.equal(s.balance.public.available, '0', 'the coin it spends is not offered again');
  const tx = s.txs.find((t) => t.txid === e.txid);
  assert.equal(tx.direction, 'out');
  assert.equal(tx.unsure, undefined, 'the node lists it: it left');
  await mine(e.txid);
  s = backend.getState();
  assert.equal(backend.transparent.pending.size, 0, 'in a block: no longer followed');
  assert.equal(s.txs.find((t) => t.txid === e.txid).dropped, undefined);
  await backend.close();
});

test('audit FM-1: a public payment that never reached the network: kept for 6 blocks (sent again once), then given up only on two nodes\' word', async () => {
  const { backend, chain, bc, mine, settle } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'drop';
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  await settle();
  assert.equal(backend.getState().balance.public.available, '0');
  const sent = bc.count;
  await mine();
  await mine();
  assert.equal(bc.count, sent + 1, 'sent again once, after 2 blocks');
  await mine();
  await mine();
  assert.equal(backend.getState().balance.public.available, '0', 'still kept: no decision before 6 blocks');
  await mine();
  await mine();
  const s = backend.getState();
  assert.equal(bc.count, sent + 1, 'only once');
  assert.equal(s.balance.public.available, String(3n * COIN), 'both nodes say they do not have it: its coin is free again');
  const tx = s.txs.find((t) => t.txid === e.txid);
  assert.ok(tx, 'it stays in the history');
  assert.equal(tx.dropped, true);
  assert.equal(tx.confirmations, 0);
  await backend.close();
});

test('audit FM-1: an error answer means not sent (forgotten, coins free); a broadcast that never reached a node is "offline", nothing kept', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'refuse';
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'server');
  assert.match(e.message, /bad-txns-inputs-missingorspent/);
  assert.equal(backend.transparent.pending.size, 0);
  assert.equal(backend.getState().balance.public.available, String(3n * COIN));
  assert.equal(backend.getState().txs.length, 1);
  // Not connected when it was to go out: it never left this page.
  bc.mode = 'answer';
  const orig = backend.client.broadcast.bind(backend.client);
  backend.client.broadcast = async () => {
    throw new ElectrumError('offline', 'Not connected to a Firo node.', { written: false });
  };
  const e2 = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e2.code, 'offline');
  assert.equal(backend.transparent.pending.size, 0);
  assert.equal(backend.getState().balance.public.available, String(3n * COIN));
  backend.client.broadcast = orig;
  await backend.close();
});

test('release re-audit R1-4: the same bytes written down again after "did not go through" have their coins spent again', async () => {
  const { backend, chain } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const t = backend.transparent;
  const tip = backend.tip.height;
  const signed = t.signPlan(t.planSend({ outputs: [{ script: addressToScript(OTHER.address, MAIN), value: COIN }], feePerKb: 1000n, tipHeight: tip }), tip);
  await t.addPending({ txid: signed.txid, hex: signed.hex, height: tip });
  assert.equal(t.balance(tip).available, 0n);
  await t.updatePending(signed.txid, { dropped: true, unsure: undefined }); // the 6-block verdict
  assert.equal(t.balance(tip).available, 3n * COIN, 'given up: its coin is free');
  await t.addPending({ txid: signed.txid, hex: signed.hex, height: tip });
  assert.equal(t.txs.get(signed.txid).dropped, undefined, 'no longer "did not go through"');
  assert.equal(t.balance(tip).available, 0n, 'its coin is spent again while it is followed');
  await backend.close();
});

test('release re-audit R-5: a node that relays a payment, then answers an error: another node has it, so it is sent, kept and followed', async () => {
  const { backend, chain, spark, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  const a = fakeCoin();
  spark.own(a, { value: 5n * COIN });
  chain.addBlock(1, [a, fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'relay-refuse';
  const pub = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.match(pub.txid, /^[0-9a-f]{64}$/, 'not "not sent": the network has it');
  assert.equal(backend.transparent.pending.has(pub.txid), true, 'kept: its coin stays spent');
  assert.equal(backend.getState().balance.public.available, '0');
  const priv = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.equal(backend.sends.has(priv.txid), true, 'a private one too: in the log (its counterparty with it)');
  assert.equal(backend.getState().txs.find((t) => t.txid === priv.txid).counterparty, OTHER.address);
  assert.equal(backend.getState().balance.private.available, '0');
  await backend.close();
});

test('release re-audit R-5: a refusal no other node contradicts is still "not sent", and the person\'s own node is not second-guessed', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'refuse';
  let asked = 0;
  const second = backend._secondOpinion.bind(backend);
  backend._secondOpinion = (...x) => {
    asked++;
    return second(...x);
  };
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'server');
  assert.equal(asked, 2, 'another node was asked first, twice (a relayed payment can take some seconds to reach it)');
  assert.equal(backend.transparent.pending.size, 0);
  backend.ownNode = true;
  const e2 = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e2.code, 'server');
  assert.equal(asked, 2, 'own node: no public node asked');
  backend.ownNode = false;
  await backend.close();
});

test('X3: a refusal no second node could be asked about stays "may have left": never forgotten, never paid again', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'relay-refuse';
  bc.onGet = () => FakeNet.NO_ANSWER; // the other node does not answer
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure', 'may have left');
  assert.equal(backend.transparent.pending.size, 1, 'kept: its coins stay spent');
  await backend.close();
});

test('X3: a broadcast answered without a result may have left: never "not sent"', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'no-result';
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  assert.equal(backend.transparent.pending.size, 1);
  await backend.close();
});

test('X3: a node answering "txn-already-known" has it: sent', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'known2';
  const r = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.ok(r.txid);
  await backend.close();
});

test('P7/X3: a payment let go of (refused, forgotten) has one of its coins spent by the next payment: the two conflict, never both mined', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 2n * COIN);
  fund(chain, W.addresses[0].address, 2n * COIN);
  fund(chain, W.addresses[0].address, 5n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  let first = null;
  bc.mode = 'refuse';
  bc.seen = (hex) => (first = first ?? hex);
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'server', 'not sent (another node agrees it has no such payment)');
  const spentFirst = decodeTx(first, MAIN).vin.map((i) => `${i.txid}:${i.vout}`);
  assert.ok(backend.transparent.conflictCoins().size >= 1, 'its coins kept as conflict coins');
  bc.mode = 'answer';
  bc.seen = null;
  const before = chain.broadcasts.length;
  await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  const second = decodeTx(chain.broadcasts.at(-1), MAIN).vin.map((i) => `${i.txid}:${i.vout}`);
  assert.ok(chain.broadcasts.length > before);
  assert.ok(second.some((k) => spentFirst.includes(k)), `the retry spends a coin of the first (${second} vs ${spentFirst})`);
  await backend.close();
});

test('P7/X3: the coin choice with a conflict coin: it is always one of the inputs', async () => {
  const { selectCoins } = await import('../../src/lib/firo/transparent.js');
  const script = new Uint8Array(25);
  const u = (v, txid) => ({ txid, vout: 0, value: v, script });
  const coins = [u(10n * COIN, 'aa'.repeat(32)), u(3n * COIN, 'bb'.repeat(32)), u(1n * COIN, 'cc'.repeat(32))];
  const out = [{ script: addressToScript(OTHER.address, MAIN), value: 2n * COIN }];
  const plain = selectCoins({ utxos: coins, outputs: out, feePerKb: 1000n, changeScript: script });
  assert.equal(plain.inputs[0].txid, 'bb'.repeat(32), 'without: the smallest single coin that covers it');
  const kept = selectCoins({ utxos: coins, outputs: out, feePerKb: 1000n, changeScript: script, mustInclude: [coins[2]] });
  assert.ok(kept.inputs.some((i) => i.txid === 'cc'.repeat(32)), 'with: the conflict coin is in, the rest added');
});

test('L2: sparkPick picks as the Spark library does (sparkmobile GetCoinsToSpend, run on these 30 cases)', async () => {
  const { sparkPick } = await import('../../src/lib/firo/backend.js');
  // [required, [[value, height], ...], the coins it spent (by place)], from the C++ itself.
  const V = [[34,[[50,2],[1,1],[20,1],[2,2]],[0]],[55,[[1,1],[50,2],[5,1],[5,2]],[1,2]],[86,[[20,1],[8,1],[2,2],[5,1],[50,0],[100,0]],[5]],[2,[[1,1],[10,2],[50,0],[10,0],[8,2],[10,1]],[4]],[11,[[8,0],[10,1]],[0,1]],[9,[[20,0],[2,0]],[0]],[8,[[5,2],[20,0]],[1]],[6,[[1,2],[10,0]],[1]],[138,[[100,2],[3,2],[2,1],[5,1],[100,2],[1,0]],[0,4]],[45,[[50,0],[20,0]],[0]],[37,[[50,0],[10,1]],[0]],[67,[[5,1],[3,2],[50,0],[1,0],[50,0],[2,1]],[2,4]],[133,[[20,0],[50,1],[100,2],[5,0],[20,1],[1,1]],[1,2]],[5,[[1,1],[1,1],[2,0],[5,2]],[3]],[5,[[50,1],[1,2]],[0]],[33,[[100,0],[3,0]],[0]],[112,[[1,1],[20,2],[20,2],[10,1],[2,0],[100,0]],[1,5]],[3,[[2,2],[100,0],[8,1],[20,0]],[2]],[29,[[5,1],[50,1],[20,1],[1,2]],[1]],[18,[[3,1],[2,2],[2,0],[1,0],[1,1],[10,2]],[0,1,2,3,5]],[19,[[5,0],[20,2]],[1]],[55,[[100,0],[50,0],[8,2],[100,2]],[0]],[5,[[2,2],[8,0]],[1]],[5,[[3,2],[3,1],[50,2],[3,1],[5,0],[1,1]],[4]],[55,[[100,2],[1,2],[2,2],[20,2]],[0]],[1,[[2,1],[10,1],[50,2],[2,0]],[3]],[24,[[2,0],[5,2],[3,1],[8,1],[5,0],[20,0]],[4,5]],[2,[[2,0],[1,1]],[0]],[9,[[100,2],[50,1]],[1]],[65,[[1,0],[100,2],[1,0],[20,0],[20,0],[50,1]],[1]]];
  for (const [req, coins, want] of V) {
    const list = coins.map(([v, h], i) => ({ value: BigInt(v), height: h, i }));
    assert.deepEqual(sparkPick(list, BigInt(req)).map((c) => c.i).sort((a, b) => a - b), want, JSON.stringify([req, coins]));
  }
});

test('P7/X3/L2: private coins of a spend let go of: the library is given coins its own pick spends that coin from, for any fee', async () => {
  const net = new FakeNet();
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket });
  // Received and proven (P4: a coin a second node has not confirmed is not spent).
  const coin = (id, v, extra = {}) => [id, { lTagHash: id, value: v, groupId: 1, coin: id, proof: 'two-servers', ...extra }];
  const F = (n) => (BigInt(Math.round(n * 1e5)) * COIN) / 100000n;
  const ids = (list) => list.map((c) => c.lTagHash).sort();
  // The library's rule (sparkmobile GetCoinsToSpend): the largest while the rest is at least it, else
  // the smallest that covers the rest. 2.5 FIRO from a 5, a 3, a 2 and a 1: it would take the 3 alone.
  backend.ownCoins = new Map([coin('a', F(5)), coin('b', F(3)), coin('c', F(2), { conflictAt: Date.now() }), coin('d', F(1))]);
  let plan = backend._sparkCoinsForPlan(F(2.501), F(2.5));
  assert.equal(plan.forced, true);
  assert.ok(plan.coins.some((c) => c.lTagHash === 'c'), 'the conflict coin is given');
  // Audit L2: 1 FIRO from c (0.2, let go of) and o (1.0005): o alone pays the amount and any real fee,
  // so no set makes the library spend c: every coin given, and Review is told.
  backend.ownCoins = new Map([coin('c', F(0.2), { conflictAt: Date.now() }), coin('o', F(1.0005))]);
  plan = backend._sparkCoinsForPlan(F(1.001), F(1));
  assert.equal(plan.forced, false);
  assert.deepEqual(ids(plan.coins), ['c', 'o']);
  // 1 FIRO from c (0.6), o (1.0005) and p (0.5): without o, the library takes p and c.
  backend.ownCoins = new Map([coin('c', F(0.6), { conflictAt: Date.now() }), coin('o', F(1.0005)), coin('p', F(0.5))]);
  plan = backend._sparkCoinsForPlan(F(1.001), F(1));
  assert.equal(plan.forced, true);
  assert.deepEqual(ids(plan.coins), ['c', 'p']);
  // No conflict coin: every spendable coin, as before.
  backend.ownCoins = new Map([coin('a', F(5)), coin('b', F(3))]);
  assert.deepEqual(ids(backend._sparkCoinsForPlan(COIN).coins), ['a', 'b']);
  // Forty-eight hours on, the conflict is over: every coin again.
  backend.ownCoins = new Map([coin('a', F(5)), coin('c', F(2), { conflictAt: Date.now() - 49 * 3600000 })]);
  assert.deepEqual(ids(backend._sparkCoinsForPlan(COIN).coins), ['a', 'c']);
});

test('audit N4: the library\'s pick at the real fee leaves the let-go coin out though it held at the bare amount and the margin: Review is told', async () => {
  const net = new FakeNet();
  const spark = new FakeSpark();
  spark.fee = 5000n; // 0.00005 FIRO: between the bare amount and the margin
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], store: createMemoryStore(), spark, WebSocket: net.WebSocket });
  backend._sparkKey = new Uint8Array(32);
  const values = [92264n, 344296n, 400104n, 114920n, 238312n, 116328n];
  backend.ownCoins = new Map(values.map((v, i) => {
    const fc = fakeCoin();
    spark.own(fc, { value: v });
    return [`c${i}`, { lTagHash: `c${i}`, value: v, groupId: 1, index: i, coin: fc.coin, context: fc.context, txid: 'aa'.repeat(32), height: 1, proof: 'two-servers', ...(i === 0 ? { conflictAt: Date.now() } : {}) }];
  }));
  const to = spark._addr(new Uint8Array(32).fill(3), 1, false);
  const warnings = [];
  const plan = await backend._planSparkSpend({ recips: [{ kind: 'spark', address: to, amount: 1070200n }], tip: 1400000, subtractFee: false, warnings });
  assert.equal(plan.fee, 5000n);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /may still go through/);
});

test('P7: payments are signed with the lower of the two nodes\' tips; a node far ahead of the other disagrees', async () => {
  const net = new FakeNet();
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket });
  backend.serverCheck = { state: 'unknown', at: Date.now(), otherHeight: 1000 };
  assert.equal(backend._lockTip(1500), 1000, 'the second node says less: its tip');
  assert.equal(backend._lockTip(900), 900, 'ours is lower: ours');
  backend.serverCheck = { state: 'unknown', at: Date.now(), otherHeight: null };
  assert.equal(backend._lockTip(1500), 1500, 'no second node: ours');
});

test('audit L3: a second node far behind is not the last word: another one is asked before sending pauses', async () => {
  const chain = new FakeChain();
  const net = new FakeNet();
  const URL3 = 'wss://fake3.example:50004';
  net.addServer(URL1, chain.handler());
  const asked = [];
  const base = chain.handler();
  // Twenty blocks behind (a node catching up), and the same chain.
  net.addServer(URL2, (m, p, sv) => {
    if (m === 'blockchain.headers.subscribe') return { height: chain.height - 20, hex: headerHex(chain.height - 20) };
    return base(m, p, sv);
  });
  net.addServer(URL3, (m, p, sv) => (asked.push(m), base(m, p, sv)));
  const backend = createBackend({ network: 'main', servers: [URL1, URL2, URL3].map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  backend._secondTurn = 0; // the lagging node first
  await backend._checkTip();
  assert.equal(backend.serverCheck.state, 'agree', JSON.stringify(backend.serverCheck));
  assert.ok(asked.includes('blockchain.headers.subscribe'), 'the third node was asked');
  assert.equal(backend.serverCheck.otherHeight, chain.height - 20, 'payments still signed at the lower tip (N10)');
  // Every other node that far behind: the node in use is on its own: it disagrees.
  const lagging = new FakeNet();
  lagging.addServer(URL1, chain.handler());
  for (const u of [URL2, URL3]) lagging.addServer(u, (m, p, sv) => (m === 'blockchain.headers.subscribe' ? { height: chain.height - 20, hex: headerHex(chain.height - 20) } : base(m, p, sv)));
  const alone = createBackend({ network: 'main', servers: [URL1, URL2, URL3].map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: lagging.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  await alone.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await alone.waitForSync();
  await alone._checkTip();
  assert.equal(alone.serverCheck.state, 'disagree');
  await backend.close();
  await alone.close();
});

test('P3: a coin of exactly 1,000 FIRO is kept as a masternode collateral: never in a send or a privatize, until the network says it is not one or the person unlocks it', async () => {
  const { backend, chain } = world();
  fund(chain, W.addresses[0].address, 1000n * COIN);
  fund(chain, W.addresses[0].address, 2n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const t = backend.transparent;
  const mn = t.utxos(chain.height).find((u) => u.value === 1000n * COIN);
  assert.ok(mn.collateral && mn.frozen && !mn.spendable, 'locked (the node gave no answer about it)');
  // "Send all" from the public balance never takes it.
  const q = await backend.quote({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }], sendAll: true });
  assert.ok(BigInt(q.total) < 3n * COIN, `only the 2 FIRO coin: ${q.total}`);
  // The network says it is no masternode's collateral: it may be spent.
  t.collateral.set(`${mn.txid}:${mn.vout}`, 'no');
  assert.equal(t.utxos(chain.height).find((u) => u.value === 1000n * COIN).spendable, true);
  // Said to be one again (a new session): locked; the person unlocks it themselves (Coins, with a warning).
  t.collateral.set(`${mn.txid}:${mn.vout}`, 'yes');
  assert.equal(t.utxos(chain.height).find((u) => u.value === 1000n * COIN).spendable, false);
  await t.setFrozen(mn.txid, mn.vout, false);
  assert.equal(t.utxos(chain.height).find((u) => u.value === 1000n * COIN).spendable, true, 'unlocked by the person');
  await t.setFrozen(mn.txid, mn.vout, true);
  assert.equal(t.utxos(chain.height).find((u) => u.value === 1000n * COIN).collateral, true, 'frozen again: the lock is back');
  await backend.close();
});

/**
 * Release re-audit 5 RE5-1: the node in use (it opens first: it controls its own latency, and the
 * wallet just had a session with it), two more of the person's nodes and Firo's four, honest, a
 * little slower (80 ms). inUse.relayRefuseDrop: the node in use relays a broadcast, answers an error,
 * then drops the connection; inUse.lie: asked later for a transaction it relayed, it says it has none.
 */
function inUseRelaysThenDrops({ inUse = {}, relayLookMs, electrum = { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10, backoffMaxMs: 20 } } = {}) {
  const IN_USE = 'wss://inuse.example:50004';
  const HONEST1 = 'wss://honest1.example:50004';
  const HONEST2 = 'wss://honest2.example:50004';
  const net = new FakeNet();
  const chain = new FakeChain();
  const base = chain.handler();
  const relayed = new Set();
  const mode = { broadcast: 'answer' };
  net.addServer(IN_USE, (m, p, socket) => {
    if (inUse.lie && m === 'blockchain.transaction.get' && relayed.has(p[0])) throw Object.assign(new Error('No such mempool or blockchain transaction.'), { code: 2 });
    if (m !== 'blockchain.transaction.broadcast' || mode.broadcast === 'answer') return base(m, p, socket);
    if (mode.broadcast === 'relay-refuse-drop') relayed.add(base(m, p, socket));
    setTimeout(() => socket.close(), 0); // the error answer goes out first, then the connection
    throw Object.assign(new Error('bad-txns-inputs-missingorspent'), { code: 1 });
  });
  for (const u of [HONEST1, HONEST2, ...MAIN.servers]) net.addServer(u, base, { openDelayMs: 80 });
  const opts = { network: 'main', servers: [IN_USE, HONEST1, HONEST2].map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum };
  const backend = createBackend(relayLookMs === undefined ? opts : { ...opts, relayLookMs });
  fund(chain, W.addresses[0].address, 3n * COIN);
  fund(chain, W.addresses[1].address, 2n * COIN);
  return { backend, chain, net, mode, IN_USE, HONEST1 };
}

test('release re-audit 5 RE5-1: a node in use that relays, refuses, drops and then lies is never its own second opinion: the payment is kept in every turn of the rotation', async () => {
  const trial = async ({ turn, relayLookMs, electrum }) => {
    const w = inUseRelaysThenDrops({ inUse: { lie: true }, relayLookMs, electrum });
    const { backend, chain } = w;
    await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
    await backend.waitForSync();
    assert.equal(backend.getState().server, w.IN_USE);
    backend._secondTurn = turn;
    // Which node the second opinion asked, and where the main connection was by then.
    const asked = [];
    let mainThen;
    const second = backend._secondOpinion.bind(backend);
    backend._secondOpinion = (fn, o) => {
      mainThen = backend.client.server;
      return second(async (c) => {
        asked.push(c.server);
        return fn(c);
      }, o);
    };
    w.mode.broadcast = 'relay-refuse-drop';
    const r = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((e) => e);
    const first = decodeTx(chain.broadcasts[0], MAIN).txid;
    assert.equal(r.code, undefined, `turn ${turn}: not "The server refused" (${r.code} ${r.message}); asked ${asked}`);
    assert.equal(r.txid, first);
    assert.equal(mainThen, w.HONEST1, 'the main connection had moved on to the next node');
    assert.ok(asked.length > 0 && !asked.includes(w.IN_USE), `turn ${turn}: the node that answered the broadcast was not asked (${asked})`);
    assert.equal(backend.transparent.pending.has(first), true, 'kept: its coin stays spent, nothing offers it again');
    await backend.close();
  };
  // Every turn of the rotation (the other nodes: up to six), fast reconnects and a short look.
  for (let turn = 0; turn < 7; turn++) await trial({ turn, relayLookMs: 300 });
  // Production: the 3 s look (RELAY_LOOK_MS) and the default reconnect backoff.
  await trial({ turn: 1, electrum: { pingIntervalMs: 0 } });

  // The honest path: a refusal that was not relayed (no other node has it) is still "not sent".
  const w = inUseRelaysThenDrops({ relayLookMs: 300 });
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  w.mode.broadcast = 'refuse-drop';
  const e = await w.backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'server');
  assert.equal(w.backend.transparent.pending.size, 0, 'forgotten: no other node has it');
  await w.backend.close();
});

test('audit FM-1: the Rosen lock (broadcastTx) is written down first too, and an unanswered one is "unsure"', async () => {
  const { backend, chain, bc, settle } = twoNodes();
  const t2 = fund(chain, W.addresses[1].address, 2n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const LOCK = 'aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y';
  const b = await backend.buildTransparentTx({ inputs: [`${t2}:0`], outputs: [{ address: LOCK, amount: String(COIN) }, { opReturn: 'beef' }], feePerKb: 1000n });
  let kept = null;
  bc.mode = 'drop';
  bc.seen = () => {
    kept = backend.transparent.pending.has(b.txid);
  };
  const e = await backend.broadcastTx(b.hex).catch((x) => x);
  assert.equal(e.code, 'unsure');
  assert.equal(e.txid, b.txid);
  assert.equal(kept, true);
  bc.mode = 'answer';
  await settle();
  assert.equal(backend.getState().balance.public.available, '0', 'the locked coin is not offered for a second crossing');
  await assert.rejects(backend.buildTransparentTx({ inputs: [`${t2}:0`], outputs: [{ address: LOCK, amount: String(COIN) }] }), (x) => x.code === 'insufficient');
  await backend.close();
});

test('release re-audit 3 RE3-1: a lock closing the wallet during a Rosen lock\'s broadcast leaves it "unsure" on disk: after the next unlock the Bridge still holds', async () => {
  const { LOCK } = await import('../../src/lib/rosen/rosen.js');
  const bridge = await import('../../src/lib/bridge_rosen.js?re3-1');
  await bridge.rosen();
  const store = createMemoryStore();
  const chain = new FakeChain();
  const w1 = twoNodes({ store, chain });
  fund(chain, W.addresses[0].address, 3n * COIN);
  await w1.backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await w1.backend.waitForSync();
  let onDiskAtBroadcast = null;
  w1.bc.mode = 'hold';
  w1.bc.seen = async (hex) => {
    const txid = decodeTx(hex, MAIN).txid;
    onDiskAtBroadcast = (await store.get('w/pending'))?.[txid] ?? null;
    // Settings -> Lock, the auto-lock at its cap, or the one-tab hand-over, while the node holds the bytes.
    await w1.backend.close();
  };
  const e = await w1.backend.send({ from: 'public', to: [{ address: LOCK.firo, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure', e.message);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(onDiskAtBroadcast?.unsure, true, 'in doubt from the moment it is written down, before the bytes leave');
  assert.equal((await store.get('w/pending'))[e.txid].unsure, true, 'still in doubt on disk after the lock');
  // The next unlock (a reload, the other tab): the payment is in doubt, and the Bridge sees it.
  const w2 = twoNodes({ store, chain });
  await w2.backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await w2.backend.waitForSync();
  const tx = w2.backend.getState().txs.find((t) => t.txid === e.txid);
  assert.equal(tx.unsure, true, 'Activity says Campfire is checking whether it left');
  bridge.forgetUnsureLocks(); // the page that knew it died
  const held = bridge.unsureLock({ state: { txs: w2.backend.getState().txs } });
  assert.equal(held?.verdict, 'checking', 'the Bridge offers no second crossing');
  assert.equal(held.lock.txid, e.txid);
  await w2.backend.close();
});

test('release re-audit 3 RE3-1: a private payment closed during its broadcast is "unsure" on disk too; one the node answered is not', async () => {
  const store = createMemoryStore();
  const chain = new FakeChain();
  const spark = new FakeSpark();
  const w1 = twoNodes({ store, chain, spark });
  const a = fakeCoin();
  const b = fakeCoin();
  spark.own(a, { value: 5n * COIN });
  spark.own(b, { value: 3n * COIN });
  chain.addBlock(1, [a, fakeCoin(), b]);
  await w1.backend.open({ mnemonic: W.mnemonic });
  await w1.backend.waitForSync();
  // Answered: the record says nothing of doubt, in memory and on disk.
  const sent = await w1.backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.equal(w1.backend.sends.get(sent.txid).unsure, undefined);
  assert.equal((await store.get('s/sends'))[sent.txid].unsure, undefined);
  assert.equal(w1.backend.getState().txs.find((t) => t.txid === sent.txid).unsure, undefined);
  // Closed while the node holds the bytes.
  let atBroadcast = null;
  w1.bc.mode = 'hold';
  w1.bc.seen = async (hex) => {
    atBroadcast = (await store.get('s/sends'))?.[decodeTx(hex, MAIN).txid] ?? null;
    await w1.backend.close();
  };
  const e = await w1.backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure', e.message);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(atBroadcast?.unsure, true, 'written down in doubt');
  assert.equal((await store.get('s/sends'))[e.txid].unsure, true);
  const w2 = twoNodes({ store, chain, spark });
  await w2.backend.open({ mnemonic: W.mnemonic });
  await w2.backend.waitForSync();
  assert.equal(w2.backend.getState().txs.find((t) => t.txid === e.txid).unsure, true, 'Activity says it may have left');
  await w2.backend.close();
});

test('release re-audit 3 RE3-1: a public payment the node answered carries no doubt on disk', async () => {
  const { backend, chain, store } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const { txid } = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.equal(backend.transparent.pending.get(txid).unsure, undefined);
  assert.equal((await store.get('w/pending'))[txid].unsure, undefined);
  assert.equal(backend.getState().txs.find((t) => t.txid === txid).unsure, undefined);
  await backend.close();
});

// ---------------------------------------------------------------- release re-audit R-2: a store write that fails

/** A store whose next put of `key` throws (storage full); `landed`: the value is written first, then it throws. */
function failingStore() {
  const base = createMemoryStore();
  const ctl = { key: null, landed: false };
  const store = {
    ...base,
    put: async (k, v) => {
      if (ctl.key !== k) return base.put(k, v);
      ctl.key = null;
      if (ctl.landed) await base.put(k, v);
      throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    },
  };
  return { store, base, ctl };
}

test('release re-audit R-2: a public payment whose record cannot be saved is refused ("storage"), nothing is left in memory to be sent later', async () => {
  const { store, base, ctl } = failingStore();
  const { backend, chain, mine } = twoNodes({ store });
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const before = chain.broadcasts.length;
  ctl.key = 'w/pending';
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'storage', e.message);
  assert.equal(e.message, 'This device could not save the payment, so it was not sent.');
  assert.equal(sendOutcome(e).kind, 'not-sent');
  assert.equal(chain.broadcasts.length, before, 'not broadcast');
  assert.equal(backend.transparent.pending.size, 0, 'not kept in memory either');
  assert.equal(await base.get('w/pending'), undefined);
  assert.equal(backend.getState().balance.public.available, String(3n * COIN), 'its coin is free');
  assert.equal(backend.getState().txs.filter((t) => t.direction === 'out').length, 0, 'not in Activity');
  await mine();
  await mine();
  await mine();
  assert.equal(chain.broadcasts.length, before, 'and never sent by the follow-up');
  await backend.close();
});

test('release re-audit R-2: a private payment whose record cannot be saved is refused, its coin free; one whose record landed before the write failed is sent', async () => {
  const { store, base, ctl } = failingStore();
  const { backend, chain, spark, mine } = twoNodes({ store });
  const a = fakeCoin();
  spark.own(a, { value: 5n * COIN });
  chain.addBlock(1, [a, fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const pay = { from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] };
  ctl.key = 's/sends';
  const e = await backend.send(pay).catch((x) => x);
  assert.equal(e.code, 'storage', e.message);
  assert.equal(chain.broadcasts.length, 0);
  assert.equal(backend.sends.size, 0, 'not kept in memory');
  assert.equal(Object.keys((await base.get('s/sends')) ?? {}).length, 0);
  assert.equal(backend.getState().balance.private.available, String(5n * COIN), 'its coin is free again');
  assert.equal(((await base.get('s/coins')) ?? []).filter((c) => c.pendingSpentTxid).length, 0, 'and not marked on disk');
  for (let i = 0; i < 3; i++) await mine();
  assert.equal(chain.broadcasts.length, 0, 'never sent by the follow-up');
  // The record reached the store, and only then did the write report a failure: it is written
  // down, so it goes (never "not sent" over a record the next unlock would send).
  ctl.key = 's/sends';
  ctl.landed = true;
  const { txid } = await backend.send(pay);
  assert.equal(decodeTx(chain.broadcasts.at(-1), MAIN).txid, txid);
  assert.equal((await base.get('s/sends'))[txid].hex, chain.broadcasts.at(-1));
  await backend.close();
});

// ---------------------------------------------------------------- audit FE-1: the Merkle proof gates spending

/** A node in use that may invent a receipt and may stop answering get_merkle; a second honest node. */
function proofWorld({ merkleErrorFrom = Infinity, ownNode = false } = {}) {
  const net = new FakeNet();
  const chain = new FakeChain();
  const chain2 = new FakeChain();
  let merkleCalls = 0;
  const h1 = chain.handler();
  const liar = (m, p, s) => {
    if (m === 'blockchain.transaction.get_merkle' && ++merkleCalls >= merkleErrorFrom) throw Object.assign(new Error('unknown method blockchain.transaction.get_merkle'), { code: -32601 });
    return h1(m, p, s);
  };
  const server = net.addServer(URL1, liar);
  net.addServer(URL2, chain2.handler());
  const backend = createBackend({ network: 'main', servers: ownNode ? [{ url: URL1 }] : [{ url: URL1 }, { url: URL2 }], ownNode, store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const real = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  chain2.addTx(chain.txs.get(real).hex, chain.height - 20);
  const phantom = buildSignedTransaction({
    inputs: [{ txid: 'ee'.repeat(32), vout: 0, value: 100n * COIN + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(W.addresses[1].address, MAIN), value: 100n * COIN }],
    locktime: chain.height - 7,
  });
  chain.addTx(phantom.hex, chain.height - 5);
  const mine = async () => {
    chain.height++;
    chain2.height++;
    server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 20));
    await backend.waitForSync();
  };
  const spendable = (txid) => backend.transparent.utxos(backend.tip.height).find((u) => u.txid === txid)?.spendable;
  return { backend, chain, chain2, phantom, real, mine, spendable };
}

test('audit FE-1: a node that answers everything but get_merkle cannot make an invented receipt spendable', async () => {
  const { backend, phantom, chain } = proofWorld({ merkleErrorFrom: 1 });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const s = backend.getState();
  assert.equal(s.balance.public.available, '0', 'nothing proven, nothing available');
  assert.equal(s.balance.public.pending, String(102n * COIN));
  const p = s.txs.find((t) => t.txid === phantom.txid);
  assert.equal(p.confirmations, 0);
  assert.equal(p.unproven, true);
  await assert.rejects(backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(50n * COIN) }] }), (e) => e.code === 'insufficient');
  await backend.close();
});

test('audit FE-1: a failed proof is not undone by the next sync: the receipt stays unspendable before, during and after it', async () => {
  const { backend, phantom, real, chain, mine, spendable } = proofWorld();
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  assert.notEqual(backend.transparent.txs.get(phantom.txid).proof, 'two-servers');
  assert.notEqual(backend.transparent.txs.get(phantom.txid).proof, 'one-server');
  assert.equal(spendable(phantom.txid), false);
  assert.equal(spendable(real), true);
  let between = null;
  const orig = backend._proveReceipts.bind(backend);
  backend._proveReceipts = async function () {
    between = { spendable: spendable(phantom.txid), available: backend.getState().balance.public.available };
    return orig();
  };
  await mine();
  assert.deepEqual(between, { spendable: false, available: String(2n * COIN) }, 'after the history is fetched again, before any proof');
  assert.equal(spendable(phantom.txid), false);
  assert.equal(backend.getState().balance.public.available, String(2n * COIN));
  await backend.close();
});

test('audit FE-1: proven once, then get_merkle errors: the invented receipt never becomes spendable', async () => {
  const { backend, phantom, chain, mine } = proofWorld({ merkleErrorFrom: 3 });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  await mine();
  await mine();
  assert.equal(backend.getState().balance.public.available, String(2n * COIN));
  await assert.rejects(backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(50n * COIN) }] }), (e) => e.code === 'insufficient');
  void phantom;
  await backend.close();
});

test('audit FE-1: at 1 confirmation a receipt is proven before it counts: a real one is spendable, one only the node in use has stays unproven', async () => {
  const { backend, chain, chain2, mine, spendable } = proofWorld();
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const honest = fund(chain, W.addresses[3].address, COIN, chain.height + 1);
  chain2.addTx(chain.txs.get(honest).hex, chain.height + 1);
  await mine();
  let s = backend.getState();
  assert.equal(spendable(honest), true, 'proven at its first confirmation');
  assert.equal(s.txs.find((x) => x.txid === honest).confirmations, 1);
  const invented = buildSignedTransaction({
    inputs: [{ txid: 'ef'.repeat(32), vout: 0, value: 40n * COIN + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(W.addresses[2].address, MAIN), value: 40n * COIN }],
    locktime: chain.height,
  });
  chain.addTx(invented.hex, chain.height + 1); // in the next block, on the node in use only
  await mine();
  s = backend.getState();
  const t = s.txs.find((x) => x.txid === invented.txid);
  assert.equal(t.confirmations, 0, 'not "Confirmed" on one node\'s word');
  assert.equal(t.unproven, true);
  assert.equal(spendable(invented.txid), false);
  assert.equal(s.balance.public.available, String(3n * COIN));
  await backend.close();
});

// Release re-audit R1-3: with no second node answering, a receipt was 'one-server': "Confirmed",
// spendable and spent, on the word of the node in use alone (one that invents a payment, with the
// other nodes blocked). Now it stays unproven and is asked again at the next sync.
test('release re-audit R1-3: no second node answers: a receipt stays unproven and unspendable, and is proven once one does', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const chain2 = new FakeChain();
  const s1 = net.addServer(URL1, chain.handler());
  const s2 = net.addServer(URL2, chain2.handler(), { refuse: true });
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const real = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  chain2.addTx(chain.txs.get(real).hex, chain.height - 20);
  const phantom = buildSignedTransaction({
    inputs: [{ txid: 'ee'.repeat(32), vout: 0, value: 100n * COIN + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(W.addresses[1].address, MAIN), value: 100n * COIN }],
    locktime: chain.height - 7,
  });
  chain.addTx(phantom.hex, chain.height - 5);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const t = backend.transparent;
  assert.equal(t.txs.get(real).proof, 'unproven');
  assert.equal(t.txs.get(phantom.txid).proof, 'unproven', 'the invented receipt is not proven on one node\'s word');
  let s = backend.getState();
  assert.equal(s.balance.public.available, '0');
  assert.equal(s.txs.find((x) => x.txid === phantom.txid).confirmations, 0);
  await assert.rejects(backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(50n * COIN) }] }), (e) => e.code === 'insufficient');
  // A second node answers at the next sync: the real one is proven, the invented one is not.
  s2.refuse = false;
  chain.height++;
  chain2.height++;
  s1.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await new Promise((r) => setTimeout(r, 20));
  await backend.waitForSync();
  assert.equal(t.txs.get(real).proof, 'two-servers');
  assert.notEqual(t.txs.get(phantom.txid).proof, 'two-servers');
  s = backend.getState();
  assert.equal(s.balance.public.available, String(2n * COIN));
  await backend.close();
});

test('release re-audit R1-3: a receipt 0.1.3 proved on one node\'s word is asked again, and counts only once two nodes agree', async () => {
  const { backend, chain, real, spendable } = proofWorld();
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const t = backend.transparent;
  // As 0.1.3 left it: proven by the node in use alone.
  const r = t.txs.get(real);
  await t.putTx(real, { ...r, proof: 'one-server' });
  await t.load();
  assert.equal(spendable(real), false, 'one node\'s word does not make it spendable');
  backend._requestSync();
  await backend.waitForSync();
  assert.equal(t.txs.get(real).proof, 'two-servers', 'asked again: the second node agrees');
  assert.equal(spendable(real), true);
  await backend.close();
});

test('audit FE-1: the person\'s own node is believed by its own word (no proof asked of it)', async () => {
  const { backend, chain, real, phantom, spendable } = proofWorld({ ownNode: true, merkleErrorFrom: 1 });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  assert.equal(backend.transparent.txs.get(real).proof, 'own-node');
  assert.equal(spendable(real), true);
  assert.equal(spendable(phantom.txid), true, 'their node, their truth');
  await backend.close();
});

test('audit FE-1: a record stored by 0.1.3 after a failed proof (height 0, claimedHeight) keeps its block and stays unspendable', async () => {
  const { backend, chain, phantom, spendable } = proofWorld();
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const at = chain.txs.get(phantom.txid).height;
  // As 0.1.3 wrote it.
  await backend.transparent.store.put(`t/tx/${phantom.txid}`, { hex: phantom.hex, height: 0, time: 1, firstSeen: 1, inputs: null, proof: 'failed', claimedHeight: at, failedAt: chain.height });
  await backend.transparent.load();
  const r = backend.transparent.txs.get(phantom.txid);
  assert.equal(r.height, at);
  assert.equal(r.proof, 'failed');
  assert.equal(spendable(phantom.txid), false);
  await backend.close();
});

// ---------------------------------------------------------------- audit FE-2: "dropped" only on a positive signal

/** Two nodes over one chain; the second leaves our spend's tag out of its used-tag list while `lag` is on. */
function tagWorld() {
  const spark = new FakeSpark();
  const chain = new FakeChain();
  const a = fakeCoin();
  spark.own(a, { value: 5n * COIN });
  chain.addBlock(1, [fakeCoin(), a, fakeCoin()]);
  for (let i = 0; i < 50; i++) chain.tags.push({ tag: fakeTag(900000 + i), txid: bytesToHex(sha256d(Uint8Array.of(i, 7))) });
  const ours = bytesToBase64(fakeTag(a.id));
  // lost: transactions the network does not have (a broadcast of one is answered, then forgotten).
  const ctl = { lag: false, lost: new Set(), lostBroadcasts: 0 };
  const base = chain.handler();
  const real = (m, p, s) => {
    if (m === 'blockchain.transaction.get' && ctl.lost.has(p[0])) throw Object.assign(new Error('No such mempool or blockchain transaction. Use gettransaction for wallet transactions.'), { code: -5 });
    if (m === 'blockchain.transaction.broadcast') {
      const id = decodeTx(p[0], MAIN).txid;
      if (ctl.lost.has(id)) {
        ctl.lostBroadcasts++;
        return id;
      }
    }
    return base(m, p, s);
  };
  const second = (m, p, s) => {
    const r = real(m, p, s);
    return m === 'spark.getusedcoinstagstxhashes' && ctl.lag ? { tagsandtxids: r.tagsandtxids.filter(([t]) => t !== ours) } : r;
  };
  const net = new FakeNet();
  const s1 = net.addServer(URL1, real);
  const s2 = net.addServer(URL2, second);
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const mine = async () => {
    chain.height++;
    s1.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 20));
    await backend.waitForSync();
  };
  const due = () => {
    backend.tagCheck.at -= 1000; // the 5-minute check is due
  };
  return { backend, chain, spark, a, ctl, mine, due, s2 };
}

test('audit FE-2: while the used-tag check is in doubt, a private payment is never given up, its coin stays spent and its record stays', async () => {
  const { backend, chain, a, ctl, mine, due } = tagWorld();
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal(backend.tagCheck.state, 'agree');
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }], });
  // Mined: the node in use sees its tag; the second node leaves it out (D-12's doubt). Both nodes'
  // transaction lookups lag too (the worst case): an absence is all there is.
  chain.tags.push({ tag: fakeTag(a.id), txid });
  ctl.lost.add(txid);
  ctl.lag = true;
  due();
  await mine();
  assert.equal(backend.tagCheck.state, 'disagree');
  for (let i = 0; i < 6; i++) await mine();
  let s = backend.getState();
  const sent = backend.sends.get(txid);
  assert.equal(Boolean(sent.dropped), false, 'not given up while in doubt');
  assert.ok(sent.hex, 'its bytes are kept');
  assert.equal(s.balance.private.available, '0', 'its coin is not offered again');
  // Agreement again: the tag counts, the payment is confirmed with its own record.
  ctl.lag = false;
  due();
  await mine();
  s = backend.getState();
  assert.equal(backend.sends.get(txid).confirmed, true);
  const e = s.txs.find((t) => t.txid === txid);
  assert.deepEqual([e.direction, e.amount, e.fee, e.counterparty], ['out', String(COIN), '10000', OTHER.address]);
  await backend.close();
});

test('audit FE-2: a payment a node still has is never given up, however long its tag takes', async () => {
  const { backend, mine } = tagWorld();
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  for (let i = 0; i < 8; i++) await mine(); // no tag, not in the mempool, but the node has the transaction
  assert.equal(Boolean(backend.sends.get(txid).dropped), false);
  assert.equal(backend.getState().balance.private.available, '0');
  await backend.close();
});

test('audit FE-2: given up only when both nodes say they do not have it; kept in Activity; confirmed with its record if its tag turns up', async () => {
  const { backend, chain, a, ctl, mine } = tagWorld();
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  ctl.lost.add(txid); // no node has it
  for (let i = 0; i < 6; i++) await mine();
  let s = backend.getState();
  assert.equal(backend.sends.get(txid).dropped, true);
  assert.equal(s.balance.private.available, String(5n * COIN), 'its coin is free again');
  let e = s.txs.find((t) => t.txid === txid);
  assert.ok(e, 'it stays in Activity');
  assert.deepEqual([e.dropped, e.amount, e.confirmations], [true, String(COIN), 0]);
  // It went through after all (a node relayed it late): the tag shows up.
  ctl.lost.delete(txid);
  chain.tags.push({ tag: fakeTag(a.id), txid });
  backend.tagCheck.at -= 1000;
  await mine();
  s = backend.getState();
  e = s.txs.find((t) => t.txid === txid);
  assert.equal(backend.sends.get(txid).confirmed, true);
  assert.equal(e.dropped, undefined);
  assert.deepEqual([e.direction, e.amount, e.counterparty], ['out', String(COIN), OTHER.address], 'its own record, not the whole coin');
  assert.equal(s.balance.private.available, '0');
  await backend.close();
});

// Release re-audit R-6: with no second node to ask, a payment nothing has was never given up: a Sell
// stayed "Follow it in Activity" until it expired, its coins pending for good. Now, after an hour of
// no second node at all, the node in use's own "no such transaction" decides.
test('release re-audit 3 RE3-3: no second node for an hour: a public payment the node in use does not have is offered to let go, never freed by the engine; the tap frees it', async () => {
  const store = createMemoryStore();
  const { backend, chain, bc, mine, settle, servers } = twoNodes({ store });
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  servers[1].refuse = true; // from here no second node can be reached (Firo's own are not in this network)
  bc.mode = 'drop'; // the bytes never reach the network (nor does the follow-up's resend)
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  await settle();
  assert.equal(backend.getState().server, URL1);
  await assert.rejects(backend.letGo(e.txid), (x) => x.code === 'not-offered', 'nothing to let go yet');
  for (let i = 0; i < 7; i++) await mine();
  const t = backend.transparent;
  let p = t.pending.get(e.txid);
  assert.equal(Boolean(p.dropped), false, 'not on one node\'s word at once');
  assert.ok(Number.isSafeInteger(p.noSecondSince), 'the hour without a second node is counted, with the payment');
  assert.equal(backend.getState().balance.public.available, '0');
  // Relayed after all (the node in use has it): the count stops.
  chain.addTx(p.hex, 0);
  await mine();
  assert.equal(t.pending.get(e.txid).noSecondSince, undefined);
  // Gone from the network again (from the node's transactions and address histories).
  chain.txs.delete(e.txid);
  for (const [sh, h] of chain.history) chain.history.set(sh, h.filter((x) => x.tx_hash !== e.txid));
  await mine();
  await mine();
  p = t.pending.get(e.txid);
  assert.ok(Number.isSafeInteger(p.noSecondSince), 'counted anew');
  // An hour later (the clock kept with the payment, set back), still no second node: offered, not decided.
  await t.updatePending(e.txid, { noSecondSince: p.noSecondSince - 3600 });
  await mine();
  await mine();
  let s = backend.getState();
  let tx = s.txs.find((x) => x.txid === e.txid);
  assert.equal(tx.dropped, undefined, 'never let go on one node\'s word by the engine');
  assert.equal(tx.oneNode, true, 'offered: the node in use says it never left');
  assert.equal(s.balance.public.available, '0', 'its coin stays spent until the person lets it go');
  // The node in use has it again at the tap: not let go, and no longer offered.
  chain.addTx(p.hex, 0);
  await assert.rejects(backend.letGo(e.txid), (x) => x.code === 'seen' && /has this payment now/.test(x.message));
  assert.equal(backend.getState().txs.find((x) => x.txid === e.txid).oneNode, undefined);
  assert.equal(backend.getState().balance.public.available, '0');
  chain.txs.delete(e.txid);
  for (const [sh, h] of chain.history) chain.history.set(sh, h.filter((x) => x.tx_hash !== e.txid));
  await mine();
  await t.updatePending(e.txid, { noSecondSince: t.pending.get(e.txid).noSecondSince - 3600 });
  await mine();
  assert.equal(backend.getState().txs.find((x) => x.txid === e.txid).oneNode, true);
  // The person lets it go.
  const r = await backend.letGo(e.txid);
  assert.deepEqual(r, { txid: e.txid, letGo: true });
  s = backend.getState();
  tx = s.txs.find((x) => x.txid === e.txid);
  assert.equal(tx.dropped, true, 'did not go through, by the person\'s choice');
  assert.equal(tx.letGo, true);
  assert.equal(tx.oneNode, undefined);
  assert.equal(s.balance.public.available, String(3n * COIN), 'its coin is free again');
  assert.equal((await store.get('w/pending'))[e.txid].letGo, true, 'kept with the payment');
  await backend.close();
});

test('release re-audit 3 RE3-3: a let-go the device cannot save changes nothing (its coin stays spent, the offer stays); the next tap lets it go', async () => {
  const { store, base, ctl } = failingStore();
  const { backend, chain, bc, mine, settle, servers } = twoNodes({ store });
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  servers[1].refuse = true;
  bc.mode = 'drop';
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  await settle();
  for (let i = 0; i < 7; i++) await mine();
  const t = backend.transparent;
  await t.updatePending(e.txid, { noSecondSince: t.pending.get(e.txid).noSecondSince - 3600 });
  await mine();
  assert.equal(backend.getState().txs.find((x) => x.txid === e.txid).oneNode, true);
  ctl.key = 'w/pending'; // the next write of the pending payments fails (storage full)
  await assert.rejects(backend.letGo(e.txid), (x) => x.code === 'storage' && /could not save that, so the payment was not let go/.test(x.message));
  const tx = backend.getState().txs.find((x) => x.txid === e.txid);
  assert.equal(tx.dropped, undefined, 'not let go in memory either');
  assert.equal(tx.oneNode, true, 'still offered');
  assert.equal(backend.getState().balance.public.available, '0', 'its coin stays spent');
  assert.equal((await base.get('w/pending'))[e.txid].dropped, undefined);
  await backend.letGo(e.txid);
  assert.equal((await base.get('w/pending'))[e.txid].letGo, true);
  assert.equal(backend.getState().balance.public.available, String(3n * COIN));
  await backend.close();
});

// Release re-audit 4 RE4-2: a lock (Settings, the auto-lock, the one-tab hand-over) while the node in
// use was asked again closed the connection, and the refusal said the node "didn't answer".
test('release re-audit 4 RE4-2: the wallet locked while the node in use is asked again: "the wallet was locked", nothing let go, still offered after the next unlock', async () => {
  const store = createMemoryStore();
  const chain = new FakeChain();
  const { backend, bc, mine, settle, servers } = twoNodes({ store, chain });
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  servers[1].refuse = true;
  bc.mode = 'drop';
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  await settle();
  for (let i = 0; i < 7; i++) await mine();
  const t = backend.transparent;
  await t.updatePending(e.txid, { noSecondSince: t.pending.get(e.txid).noSecondSince - 3600 });
  await mine();
  assert.equal(backend.getState().txs.find((x) => x.txid === e.txid).oneNode, true);
  // The tap asks the node in use once more; the wallet is locked as it does.
  bc.onGet = (txid) => {
    if (txid !== e.txid) return undefined;
    backend.close();
    throw Object.assign(new Error('No such mempool or blockchain transaction.'), { code: 2 });
  };
  await assert.rejects(backend.letGo(e.txid), (x) => x.code === 'not-open' && x.message === 'The wallet was locked, so the payment was not let go.', 'not "the node in use didn\'t answer"');
  bc.onGet = null;
  const disk = (await store.get('w/pending'))[e.txid];
  assert.equal(disk.dropped, undefined, 'not let go');
  assert.equal(disk.letGo, undefined);
  assert.equal(disk.oneNode, true, 'still offered');
  // The next unlock: still offered, its coin still spent.
  const again = twoNodes({ store, chain });
  again.servers[1].refuse = true;
  await again.backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await again.backend.waitForSync();
  assert.equal(again.backend.getState().txs.find((x) => x.txid === e.txid).oneNode, true);
  assert.equal(again.backend.getState().balance.public.available, '0');
  await again.backend.close();
});

test('release re-audit 3 RE3-3: the same for a private payment; a second node that answers decides as before; the person\'s own node decides alone', async () => {
  const { backend, ctl, mine, s2 } = tagWorld();
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  ctl.lost.add(txid); // the network does not have it
  s2.refuse = true;
  for (let i = 0; i < 7; i++) await mine();
  const sent = backend.sends.get(txid);
  assert.equal(Boolean(sent.dropped), false);
  assert.ok(Number.isSafeInteger(sent.noSecondSince));
  assert.equal(backend.getState().balance.private.available, '0');
  sent.noSecondSince -= 3600;
  await mine();
  assert.equal(Boolean(backend.sends.get(txid).dropped), false, 'not decided by the engine');
  assert.equal(backend.getState().txs.find((x) => x.txid === txid).oneNode, true, 'offered');
  assert.equal(backend.getState().balance.private.available, '0');
  await backend.letGo(txid);
  assert.equal(backend.sends.get(txid).dropped, true);
  assert.equal(backend.sends.get(txid).letGo, true);
  assert.equal(backend.sends.get(txid).noSecondSince, undefined);
  const tx = backend.getState().txs.find((x) => x.txid === txid);
  assert.equal(tx.dropped, true);
  assert.equal(tx.letGo, true);
  assert.equal(backend.getState().balance.private.available, String(5n * COIN));
  await backend.close();
  // A second node that can be reached: both nodes' word, at 6 blocks, no hour, nothing to tap.
  const w2 = tagWorld();
  await w2.backend.open({ mnemonic: W.mnemonic });
  await w2.backend.waitForSync();
  const r2 = await w2.backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  w2.ctl.lost.add(r2.txid);
  for (let i = 0; i < 6; i++) await w2.mine();
  assert.equal(w2.backend.sends.get(r2.txid).dropped, true);
  assert.equal(w2.backend.sends.get(r2.txid).noSecondSince, undefined, 'no hour counted');
  assert.equal(w2.backend.getState().txs.find((x) => x.txid === r2.txid).letGo, undefined, 'the network\'s word, not a choice');
  await w2.backend.close();
});

test('release re-audit 3 RE3-3: with the person\'s own node, the node in use decides alone as before (no hour, nothing to tap)', async () => {
  const chain = new FakeChain();
  const net = new FakeNet();
  const base = chain.handler();
  let drop = false;
  const node = net.addServer(URL1, (m, p, socket) => {
    if (m === 'blockchain.transaction.broadcast' && drop) {
      queueMicrotask(() => socket.close());
      return FakeNet.NO_ANSWER;
    }
    return base(m, p, socket);
  });
  fund(chain, W.addresses[0].address, 3n * COIN);
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], ownNode: true, store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, relayLookMs: 0, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10, backoffMaxMs: 20 } });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  drop = true;
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  for (let i = 0; i < 8; i++) {
    chain.height++;
    for (let j = 0; j < 100 && !backend.getState().connected; j++) await new Promise((r) => setTimeout(r, 10));
    node.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 20));
    await backend.waitForSync();
  }
  const tx = backend.getState().txs.find((x) => x.txid === e.txid);
  assert.equal(tx.dropped, true, 'its own node says it does not have it: did not go through');
  assert.equal(tx.letGo, undefined);
  assert.equal(tx.oneNode, undefined);
  assert.equal(backend.getState().balance.public.available, String(3n * COIN));
  await backend.close();
});

test('audit FE-2/FM-1: a Rescan forgets which coins a payment in flight spends, the payment record does not', async () => {
  const { backend, mine } = tagWorld();
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const { txid } = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] });
  await backend.waitForSync();
  assert.equal(backend.getState().balance.private.available, '0');
  await backend.rescan();
  await backend.waitForSync();
  await mine();
  assert.equal(backend.getState().balance.private.available, '0', 'its coin is still spent by it');
  assert.equal([...backend.ownCoins.values()].filter((c) => c.pendingSpentTxid === txid).length, 1);
  await backend.close();
});

// ---------------------------------------------------------------- audit FE-4: a lock during a payment

// Release re-audit R1-2: a lock landing right after the coin list was written, before the payment
// log, used to answer 'unsure' with nothing written down behind it: "Checking your payment…" for
// ever, a Sell or Bridge payment never offered again. Now 'not-open' (nothing kept, nothing sent);
// once the log is written the payment is followed after the next unlock, so 'unsure' stays true.
test('audit FE-4: nothing is written after close(), and a lock inside a save never leaves the coin list empty', async () => {
  for (const at of ['s/coins', 's/sends', 's/progress']) {
    const logged = at !== 's/coins';
    const spark = new FakeSpark();
    const chain = new FakeChain();
    const a = fakeCoin();
    const b = fakeCoin();
    spark.own(a, { value: 5n * COIN });
    spark.own(b, { value: 3n * COIN });
    chain.addBlock(1, [fakeCoin(), a, b]);
    const net = new FakeNet();
    net.addServer(URL1, chain.handler());
    // A second node: received private coins count once it confirms their sets (P4).
    net.addServer(URL2, chain.handler());
    const store = createMemoryStore();
    const make = () => createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store, spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
    let backend = make();
    await backend.open({ mnemonic: W.mnemonic });
    await backend.waitForSync();
    assert.equal(backend.paymentInFlight, false);
    // The lock lands right after the payment's first write of `at`.
    let fired = false;
    let inFlight = null;
    let writesAfter = 0;
    const put = store.put.bind(store);
    store.put = async (k, v) => {
      if (fired) writesAfter++;
      await put(k, v);
      if (!fired && k === at) {
        fired = true;
        inFlight = backend.paymentInFlight;
        await backend.close();
      }
    };
    const e = await backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
    store.put = put;
    assert.equal(inFlight, true, `${at}: the payment was in flight`);
    assert.equal(writesAfter, 0, `${at}: nothing written after close()`);
    if (logged) {
      assert.equal(e.code, 'unsure', `${at}: locked after it was written down: followed, never "not sent"`);
      assert.match(e.txid, /^[0-9a-f]{64}$/);
    } else {
      assert.equal(e.code, 'not-open', `${at}: locked before the payment log was written: nothing kept, so "not sent"`);
      assert.equal(e.message, 'The wallet was locked, so the payment was not sent.');
    }
    assert.equal(chain.broadcasts.length, 0, `${at}: not broadcast from a closed engine`);
    const coins = await store.get('s/coins');
    assert.equal(coins.length, 2, `${at}: the coin list is whole`);
    const txid = logged ? e.txid : coins.find((c) => c.pendingSpentTxid)?.pendingSpentTxid;
    backend = make();
    await backend.open({ mnemonic: W.mnemonic });
    await backend.waitForSync();
    const s = backend.getState();
    assert.equal(backend.ownCoins.size, 2, `${at}: both coins known after the next unlock`);
    assert.equal(BigInt(s.balance.private.available) + [...backend.ownCoins.values()].filter((c) => c.pendingSpentTxid).reduce((x, c) => x + c.value, 0n), 8n * COIN, `${at}: every coin accounted for`);
    const tx = s.txs.find((t) => t.txid === txid);
    if (logged) {
      assert.equal(backend.sends.has(txid), true, `${at}: the payment is in the log after the next unlock`);
      assert.equal(tx && tx.direction, 'out', `${at}: and in Activity, followed`);
      assert.equal([...backend.ownCoins.values()].filter((c) => c.pendingSpentTxid === txid).length, 1, `${at}: its coin stays spent`);
    } else {
      assert.equal(backend.sends.has(txid), false, `${at}: nothing to follow`);
      assert.equal(tx, undefined, `${at}: not in Activity`);
      assert.equal(s.balance.private.available, String(8n * COIN), `${at}: both coins free`);
    }
    await backend.close();
  }
});

test('release re-audit R1-2: a lock landing just before a public payment is written down: "not sent", nothing kept, nothing sent later', async () => {
  const { backend, chain } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const t = backend.transparent;
  const save = t._savePending.bind(t);
  t._savePending = async () => {
    await backend.close();
    return save();
  };
  const e = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'not-open', e.message);
  assert.equal(chain.broadcasts.length, 0);
  assert.equal(t.pending.size, 0, 'not kept in memory');
  assert.equal([...t.txs.values()].length, 1, 'only the payment that funded it');
});

test('audit FE-4: the engine says a payment is in flight from send() to its record and broadcast', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  let during = null;
  bc.mode = 'refuse';
  bc.seen = () => {
    during = backend.paymentInFlight;
  };
  await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch(() => {});
  assert.equal(during, true);
  assert.equal(backend.paymentInFlight, false, 'and not after');
  await backend.close();
});

// ---------------------------------------------------------------- audit FE-3: the fee shown, or nothing

test('audit FE-3: send() with the figures Review showed refuses a different plan (\'fee-changed\', with the new figures), sends a matching one', async () => {
  const { backend, chain, spark, mine } = world();
  fund(chain, W.addresses[0].address, 60000000n);
  fund(chain, W.addresses[1].address, 60000000n);
  const a = fakeCoin();
  spark.own(a, { value: 5n * COIN });
  chain.addBlock(1, [a, fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  // Public: Review's plan needs both coins; a bigger coin arrives during Face ID: one input, another fee.
  const to = [{ address: OTHER.address, amount: String(COIN) }];
  const q = await backend.quote({ from: 'public', to });
  fund(chain, W.addresses[2].address, 3n * COIN, chain.height);
  await mine();
  const before = chain.broadcasts.length;
  const e = await backend.send({ from: 'public', to, expect: { fee: q.fee, total: q.total } }).catch((x) => x);
  assert.equal(e.code, 'fee-changed', e.message);
  assert.notEqual(e.fee, q.fee);
  const q2 = await backend.quote({ from: 'public', to });
  assert.deepEqual([e.fee, e.total], [q2.fee, q2.total], 'the figures it would pay now');
  assert.equal(chain.broadcasts.length, before, 'nothing built or sent');
  assert.equal(backend.transparent.pending.size, 0, 'nothing written down');
  const ok = await backend.send({ from: 'public', to, expect: { fee: q2.fee, total: q2.total } });
  assert.match(ok.txid, /^[0-9a-f]{64}$/);
  // Private: the library's fee moves between Review and the send.
  const pto = [{ address: OTHER.address, amount: String(COIN) }];
  const pq = await backend.quote({ from: 'private', to: pto, subtractFee: true });
  spark.fee = 12000n;
  const pe = await backend.send({ from: 'private', to: pto, subtractFee: true, expect: { fee: pq.fee, total: pq.total } }).catch((x) => x);
  assert.deepEqual([pe.code, pe.fee, pe.total], ['fee-changed', '12000', String(COIN)]);
  assert.equal(backend.sends.size, 0);
  await backend.close();
});

// ---------------------------------------------------------------- audit FE-7: a refused set and a node change

test('public audit P4: a private coin received counts only once a second node confirms its set; with no second node it waits, said in Activity', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), mine, fakeCoin()]);
  // One node only: its word alone.
  const net = new FakeNet();
  net.addServer(URL1, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }], store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  const st = backend.getState();
  assert.deepEqual(st.balance.private, { available: '0', pending: String(2n * COIN), checking: String(2n * COIN) }, 'in a block, its set being checked (N9: said so)');
  const rx = st.txs.find((t) => t.direction === 'in');
  assert.equal(rx.unproven, true, 'Activity: "Reported by the Firo node, checking…"');
  assert.equal(rx.confirmations, 0);
  assert.equal((await backend.coins.list()).find((c) => c.kind === 'spark').spendable, false);
  assert.equal(st.privateCheck, null, 'no node lied: nothing to say on Home but the waiting amount');
  await assert.rejects(backend.send({ from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] }), (e) => e.code === 'insufficient');
  await backend.close();
  // The person's own node: its word is theirs.
  const own = createBackend({ network: 'main', servers: [{ url: URL1 }], ownNode: true, store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  await own.open({ mnemonic: W.mnemonic });
  await own.waitForSync();
  assert.deepEqual(own.getState().balance.private, { available: String(2n * COIN), pending: '0' });
  assert.equal([...own.ownCoins.values()][0].proof, 'own-node');
  await own.close();
});

test('audit FE-7: after a refused set, choosing another node on the Firo nodes screen (setServers) fetches the set again and the payment goes', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 3n * COIN });
  // A coin swapped for another in the newest block: same size, same block, the real hash reported.
  const [honest, pruned] = twinChains([[fakeCoin(), fakeCoin()], [mine, fakeCoin(), fakeCoin()], [fakeCoin(), fakeCoin()]], (coins, i) => (i === 2 ? [fakeCoin(), ...coins.slice(1)] : coins));
  const realHash = honest.handler()('spark.getsparkanonymitysetmeta', ['1']).setHash;
  const lie = pruned.handler();
  const { backend, urls } = multiWorld([(m, p, s) => (m === 'spark.getsparkanonymitysetmeta' ? { ...lie(m, p, s), setHash: realHash } : lie(m, p, s)), honest.handler(), honest.handler()], spark);
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal(backend.getState().privateCheck?.code, 'set-mismatch', 'caught in the background (P4)');
  provenEarlier(backend);
  const pay = { from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] };
  await assert.rejects(backend.send(pay), (e) => e.code === 'set-mismatch');
  assert.equal((await backend.sparkSync.verifiedState(1))?.bad != null, true, 'the set is marked as not adding up');
  // The person picks another public node on the Firo nodes screen (not "Try another node").
  await backend.setServers([urls[1], urls[2]]);
  await backend.waitForSync();
  assert.equal(backend.getState().server, urls[1]);
  assert.equal(backend._refusedGroups.size, 0, 'the refusal is not carried to the new node');
  assert.equal(backend.getState().privateCheck, null);
  const { txid } = await backend.send(pay);
  assert.equal(decodeTx(honest.broadcasts.at(-1), MAIN).txid, txid, 'the honest node is not refused');
  await backend.close();
});

test('release re-audit R1-6: choosing another node drops the old node\'s tip check: the new one is checked at its first sync', async () => {
  const { backend } = world();
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.equal(backend.getState().serverCheck.state, 'agree');
  // The old node's word, minutes from being looked at again: it must not speak for the new node.
  backend.serverCheck = { state: 'disagree', at: Math.floor(Date.now() / 1000), otherHeight: 999999 };
  assert.equal(backend.getState().serverCheck.state, 'disagree');
  await backend.setServers([URL2, URL1]);
  assert.equal(backend.getState().serverCheck, null, 'not known for the new node yet');
  await backend.waitForSync();
  assert.equal(backend.getState().server, URL2);
  assert.equal(backend.getState().serverCheck.state, 'agree', 'the new node checked at once');
  await backend.close();
});

// ---------------------------------------------------------------- audit FE-8: one second node cannot demote a receipt

/** The node in use (honest) and second nodes that each give honest or made-up headers. */
function secondNodes(liars) {
  const net = new FakeNet();
  const chain = new FakeChain();
  const urls = [URL1, ...liars.map((_, i) => `wss://second${i + 1}.example:50004`)];
  const server = net.addServer(URL1, chain.handler());
  const seconds = liars.map((lies, i) => {
    const c = new FakeChain();
    const h = c.handler();
    const asked = [];
    net.addServer(urls[i + 1], (m, p, s) => {
      if (m === 'blockchain.block.header') asked.push(p[0]);
      return m === 'blockchain.block.header' && lies() ? headerHex(p[0], 1) : h(m, p, s);
    });
    return { chain: c, asked };
  });
  const backend = createBackend({ network: 'main', servers: urls.map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const real = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  for (const s of seconds) s.chain.addTx(chain.txs.get(real).hex, chain.height - 20);
  const mine = async () => {
    chain.height++;
    for (const s of seconds) s.chain.height++;
    server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 20));
    await backend.waitForSync();
  };
  return { backend, chain, real, seconds, mine, urls };
}

test('audit FE-8: a second node giving another header does not demote a receipt alone: another node is asked next, and its agreement proves it', async () => {
  const { backend, chain, real, seconds } = secondNodes([() => true, () => false]);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const r = backend.transparent.txs.get(real);
  assert.ok(seconds[0].asked.length > 0, 'the lying node was asked first');
  assert.ok(seconds[1].asked.length > 0, 'then another node');
  assert.equal(r.proof, 'two-servers', 'another node agreed');
  assert.equal(backend.getState().balance.public.available, String(2n * COIN));
  await backend.close();
});

test('audit FE-8: demoted only when two different nodes disagree; with no other node to ask it stays unproven, never "one server"', async () => {
  const both = secondNodes([() => true, () => true]);
  await both.backend.open({ mnemonic: W.mnemonic, birthdayHeight: both.chain.height - 100 });
  await both.backend.waitForSync();
  await both.mine();
  const r = both.backend.transparent.txs.get(both.real);
  assert.equal(r.proof, 'failed');
  assert.deepEqual([...r.disagreed].sort(), both.urls.slice(1).sort());
  await both.backend.close();
  // Only one other node, and it disagrees: the next sync has no one else to ask.
  const one = secondNodes([() => true]);
  // Firo's public nodes are not in this fake network: asking them fails like an unreachable node.
  await one.backend.open({ mnemonic: W.mnemonic, birthdayHeight: one.chain.height - 100 });
  await one.backend.waitForSync();
  await one.mine();
  await one.mine();
  const r1 = one.backend.transparent.txs.get(one.real);
  assert.equal(r1.proof, 'unproven');
  assert.equal(one.backend.getState().balance.public.available, '0');
  await one.backend.close();
});

// ---------------------------------------------------------------- audit FE-6: Exact-dates decoys and pool growth

test('audit FE-6: Exact dates asks about the same seven decoys per transaction after the sets grew (two asks do not intersect to our own)', async () => {
  const { backend, chain, spark } = world({ sparkTxDetails: 'decoy' });
  const own = [fakeCoin(), fakeCoin()];
  for (const c of own) spark.own(c, { value: COIN });
  // A pool much larger than one padded batch (32), as on mainnet.
  for (let b = 0; b < 120; b++) chain.addBlock(1, b < 2 ? [own[b], fakeCoin(), fakeCoin(), fakeCoin()] : [fakeCoin(), fakeCoin(), fakeCoin(), fakeCoin()]);
  await backend.open({ mnemonic: W.mnemonic }); // a restore
  await backend.waitForSync();
  const ask = async () => {
    for (const c of backend.ownCoins.values()) Object.assign(c, { heightApprox: true, time: null });
    backend.spendInfo.clear();
    const from = chain.txGets.length;
    await backend._decoyDetails();
    return new Set(chain.txGets.slice(from));
  };
  const first = await ask();
  // Another day: the sets grew (the pool the decoys are drawn from is larger), then a Rescan.
  for (let b = 0; b < 40; b++) chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  backend._requestSync();
  await backend.waitForSync();
  const second = await ask();
  const ownTxids = own.map((c) => hashToHex(c.txHash));
  const both = [...first].filter((t) => second.has(t) && !ownTxids.includes(t));
  assert.ok(both.length >= 7, `the two asks share only ${both.length} decoys: they intersect to our own transactions`);
  await backend.close();
});

test('audit FM-1: a node answering that it already has the payment is not a refusal: it stays recorded and followed', async () => {
  const { backend, chain, bc } = twoNodes();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  bc.mode = 'known';
  const r = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.match(r.txid, /^[0-9a-f]{64}$/);
  assert.equal(backend.transparent.pending.has(r.txid), true, 'kept: its coins stay spent');
  assert.equal(backend.getState().balance.public.available, '0');
  await backend.close();
});

test('second audit XX: a built transaction whose coin another payment spent meanwhile is not sent (built outside the one-payment guard)', async () => {
  const { backend, chain } = world();
  fund(chain, W.addresses[0].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const [coin] = backend.transparent.utxos(chain.height).filter((u) => u.spendable);
  const LOCK = 'aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y';
  // The Bridge builds its lock from that coin…
  const built = await backend.buildTransparentTx({ inputs: [`${coin.txid}:${coin.vout}`], outputs: [{ address: LOCK, amount: String(COIN) }], feePerKb: 1000n });
  // …and before it hands it over, Send pays with the same coin.
  const paid = await backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.equal(chain.broadcasts.length, 1);
  const e = await backend.broadcastTx(built.hex).catch((x) => x);
  assert.equal(e.code, 'insufficient');
  assert.match(e.message, /used by another payment meanwhile, so it was not sent/);
  assert.equal(sendOutcome(e).kind, 'not-sent');
  assert.equal(chain.broadcasts.length, 1, 'only the payment that took the coin left');
  assert.equal(decodeTx(chain.broadcasts[0], MAIN).txid, paid.txid);
  assert.equal(backend.transparent.pending.has(built.txid), false, 'not recorded as a payment of this wallet');
  await backend.close();
});

test('release verification 0.1.8: one payment at a time: a second send or broadcast while one is on its way is refused as not sent, nothing built', async () => {
  const { backend, chain } = world();
  // Two coins: the first payment's change is not spendable until it is confirmed.
  fund(chain, W.addresses[0].address, 3n * COIN);
  fund(chain, W.addresses[1].address, 3n * COIN);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const pay = { from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] };
  // Some other Firo transaction, signed: what a second Bridge crossing would hand broadcastTx.
  const other = buildSignedTransaction({
    inputs: [{ txid: 'ab'.repeat(32), vout: 0, value: COIN + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(OTHER.address, MAIN), value: COIN }],
    locktime: chain.height,
  });
  const first = backend.send(pay);
  assert.equal(backend.paymentInFlight, true);
  const again = await backend.send(pay).catch((e) => e);
  assert.equal(again.code, 'in-flight');
  assert.match(again.message, /was not sent/);
  assert.equal(sendOutcome(again).kind, 'not-sent');
  const crossing = await backend.broadcastTx(other.hex).catch((e) => e);
  assert.equal(crossing.code, 'in-flight');
  const privatizing = await backend.privatize({ amount: 'all' }).catch((e) => e);
  assert.ok(privatizing.code === 'in-flight' || privatizing.code === 'NotYet', privatizing.code);
  const { txid } = await first;
  assert.equal(chain.broadcasts.length, 1, 'only the first one left');
  assert.equal(decodeTx(chain.broadcasts[0], MAIN).txid, txid);
  // Once it has left, the next payment goes.
  assert.equal(backend.paymentInFlight, false);
  const next = await backend.send(pay);
  assert.match(next.txid, /^[0-9a-f]{64}$/);
  assert.equal(chain.broadcasts.length, 2);
  await backend.close();
});

test('X-misc: a payment from neither balance is refused with a code that reads "not sent"', async () => {
  const { backend, chain } = world();
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const e = await backend.send({ from: 'savings', to: [{ address: OTHER.address, amount: String(COIN) }] }).catch((x) => x);
  assert.equal(e.code, 'invalid');
  assert.equal(sendOutcome(e).kind, 'not-sent');
  await backend.close();
});
