// Private and public payments are believed only with proof (public audit P4, X6), and the ways an
// independent audit of 0.1.8 found around it (E1-E4, X6): a coin filed under one of this wallet's own
// payments, a caught fake coin kept after "Try another node", a coin found again with other data,
// a view-only wallet, and a payment with no change back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackend } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { buildSignedTransaction } from '../../src/lib/firo/tx.js';
import { addressToScript } from '../../src/lib/firo/address.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { hexToBytes, bytesToHex, sha256d, hashFromHex, concatBytes } from '../../src/lib/firo/bytes.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, fakeCoin, headerHex } from '../fixtures/firo_fake_chain.mjs';
import { FakeSpark } from '../fixtures/firo_fake_spark.mjs';

const MAIN = NETWORKS.main;
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const W = KEYS.vectors[0];
const OTHER = KEYS.vectors[2].addresses[0];
const URLS = ['wss://fake1.example:50004', 'wss://fake2.example:50004', 'wss://fake3.example:50004'];
const COIN = 100000000n;
const ELECTRUM = { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function fund(chain, address, value, height = chain.height - 10) {
  const tx = buildSignedTransaction({ inputs: [{ txid: bytesToHex(sha256d(Uint8Array.of(++n, 77))), vout: 0, value: value + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }], outputs: [{ script: addressToScript(address, MAIN), value }], locktime: height - 1 });
  return chain.addTx(tx.hex, height);
}

async function connected(b) {
  for (let i = 0; i < 200 && !b.getState().connected; i++) await tick(10);
  await b.waitForSync();
}

async function newBlock(chain, servers, b) {
  for (const s of servers) s.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await tick();
  await b.waitForSync();
}

/** A node that answers as `h`, but says nothing of Spark sets (no second word on them), or nothing at all once `down()` says so. */
function partial(h, { down = () => false, sparkDown = () => true } = {}) {
  return (m, p, sv) => {
    if (down() || (sparkDown() && m.startsWith('spark.'))) throw new Error('not here');
    return h(m, p, sv);
  };
}

/** A copy of group 1 of `from`, block for block, with `edit` applied to each block's coins. */
function copyChain(from, edit) {
  const c = new FakeChain();
  from.groups.get(1).forEach((blk, i) => c.addBlock(1, edit(blk.coins, i), { hash: blk.hash }));
  return c;
}

test('E1: a coin a node files under one of this wallet\'s own payments is not "made here": with no second node it waits, never counted', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], partial(chain.handler()));
  fund(chain, W.addresses[0].address, 3n * COIN);
  const spark = new FakeSpark();
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, relayLookMs: 0, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await connected(b);
  const pay = await b.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  chain.confirm(pay.txid);
  // The node's next set: a coin to our key, never on chain, filed under our payment.
  const fake = fakeCoin(undefined, { txHash: hashFromHex(pay.txid) });
  spark.own(fake, { value: 40n * COIN });
  chain.addBlock(1, [fake, fakeCoin()]);
  await newBlock(chain, [s1, s2], b);
  const c = [...b.ownCoins.values()].find((x) => x.value === 40n * COIN);
  assert.ok(c, 'identified');
  assert.equal(c.txid, pay.txid);
  assert.equal(b._sparkMadeHere(c), false, 'not in the bytes of the payment it is filed under');
  assert.equal(b._needsSparkProof(c), true);
  const st = b.getState();
  assert.equal(st.balance.private.available, '0');
  assert.equal(st.balance.private.pending, String(40n * COIN));
  await b.close();
});

test('E1: Make private\'s own coin, in the bytes this wallet built, counts at once; another coin filed under it does not', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], partial(chain.handler()));
  fund(chain, W.addresses[0].address, 3n * COIN);
  const spark = new FakeSpark();
  // The mint's coin: the bytes after OP_SPARKMINT are the coin the set lists (as firod serialises both).
  const mine = fakeCoin(undefined, { mine: true });
  const body = mine.coin.subarray(0, 60);
  spark.createSparkMintRecipients = async ({ outputs }) => outputs.map((o) => ({ script: concatBytes(Uint8Array.of(0xd1), body), value: o.value }));
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, relayLookMs: 0, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await connected(b);
  const { txid } = await b.privatize({ amount: String(COIN) });
  chain.confirm(txid);
  const ours = fakeCoin(mine.id, { txHash: hashFromHex(txid), mine: true });
  spark.own(ours, { value: COIN });
  const other = fakeCoin(undefined, { txHash: hashFromHex(txid) });
  spark.own(other, { value: 7n * COIN });
  chain.addBlock(1, [ours, other]);
  await newBlock(chain, [s1, s2], b);
  const coins = [...b.ownCoins.values()];
  const a = coins.find((c) => c.value === COIN);
  const f = coins.find((c) => c.value === 7n * COIN);
  assert.equal(b._sparkMadeHere(a), true, 'its bytes are in the mint this wallet built');
  assert.equal(b._sparkMadeHere(f), false);
  const st = b.getState();
  assert.equal(st.balance.private.available, String(COIN));
  assert.equal(st.balance.private.pending, String(7n * COIN));
  await b.close();
});

test('E2: "Try another node" after a caught fake coin: the fake coin goes with the dropped set, never proven by the honest one', async () => {
  const spark = new FakeSpark();
  const real = fakeCoin();
  spark.own(real, { value: COIN });
  const fake = fakeCoin();
  spark.own(fake, { value: 50n * COIN });
  const honest = new FakeChain();
  honest.addBlock(1, [fakeCoin(), fakeCoin()]);
  honest.addBlock(1, [real, fakeCoin()]);
  honest.addBlock(1, [fakeCoin(), fakeCoin()]);
  const lying = copyChain(honest, (coins, i) => (i === 2 ? [...coins, fake] : coins));
  const net = new FakeNet();
  net.addServer(URLS[0], lying.handler());
  net.addServer(URLS[1], honest.handler());
  net.addServer(URLS[2], honest.handler());
  const b = createBackend({ network: 'main', servers: URLS.map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  let s = b.getState();
  assert.equal(s.privateCheck?.code, 'set-disagree', 'caught in the background');
  assert.equal(s.balance.private.available, '0');
  await b.useAnotherServer();
  await b.waitForSync();
  await b.waitForSync();
  s = b.getState();
  assert.equal(s.balance.private.available, String(COIN), 'the real coin, proven by the honest nodes');
  assert.equal(s.balance.private.pending, '0', 'the fake coin is gone');
  assert.deepEqual([...b.ownCoins.values()].map((c) => c.value), [COIN]);
  await b.close();
});

test('E3: a coin found again with other data loses the proof of the old one', async () => {
  const spark = new FakeSpark();
  const real = fakeCoin();
  spark.own(real, { value: COIN });
  const honest = new FakeChain();
  honest.addBlock(1, [fakeCoin(), fakeCoin()]);
  honest.addBlock(1, [real, fakeCoin()]);
  honest.addBlock(1, [fakeCoin(), fakeCoin()]);
  const lying = copyChain(honest, (coins) => coins);
  // The same serial (the same coin id here) with another value, in a block of the lying node's own.
  const twin = fakeCoin(real.id, { value: 77n });
  spark.own(twin, { value: 50n * COIN });
  lying.addBlock(1, [twin]);
  let lie = false;
  const H = honest.handler();
  const L = lying.handler();
  const net = new FakeNet();
  const s0 = net.addServer(URLS[0], (m, p, sv) => (lie ? L : H)(m, p, sv));
  net.addServer(URLS[1], H);
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  assert.equal(b.getState().balance.private.available, String(COIN));
  lie = true;
  s0.notify('blockchain.headers.subscribe', [{ height: lying.height, hex: headerHex(lying.height) }]);
  await tick(50);
  await b.waitForSync();
  const s = b.getState();
  const c = [...b.ownCoins.values()][0];
  assert.equal(c.value, 50n * COIN);
  assert.equal(c.proof, undefined, 'the old proof is not carried over');
  assert.equal(s.balance.private.available, '0');
  await b.close();
});

test('E4: a view-only wallet proves its private coins too: they count once a second node confirms their sets', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), mine, fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.openViewOnly({ xpub: W.accountXpub, sparkFullViewKey: 'ab'.repeat(40) });
  await b.waitForSync();
  chain.height++;
  await newBlock(chain, [s1], b);
  const s = b.getState();
  assert.equal(s.balance.private.available, String(2n * COIN));
  assert.equal(s.balance.private.pending, '0');
  await b.close();
});

test('X6: a payment with no change back is proven in its block before it is let go of; gone from every list later, its coins are spent first next time', async () => {
  const chain = new FakeChain();
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  fund(chain, W.addresses[0].address, 3n * COIN);
  fund(chain, W.addresses[1].address, 2n * COIN);
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, relayLookMs: 0, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await connected(b);
  const r = await b.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }], sendAll: true });
  const rec0 = b.transparent.txs.get(r.txid);
  assert.ok(!rec0.decoded.vout.some((o) => b.transparent.isOwnScript(o.script)), 'no change back');
  chain.confirm(r.txid);
  for (let i = 0; i < 6; i++) {
    chain.height++;
    await newBlock(chain, [s1, s2], b);
  }
  assert.equal(b.transparent.txs.get(r.txid).proof, 'two-servers', 'proven in its block, not merely six deep');
  assert.equal(b.transparent.pending.has(r.txid), false);
  // Then every list drops it.
  chain.txs.delete(r.txid);
  for (const [sh, h] of chain.history) chain.history.set(sh, h.filter((x) => x.tx_hash !== r.txid));
  for (const s of [s1, s2]) for (const sh of chain.history.keys()) s.notify('blockchain.scripthash.subscribe', [sh, chain.status(sh)]);
  await tick(50);
  await b.waitForSync();
  assert.equal(b.transparent.conflictCoins().size, rec0.decoded.vin.length, 'its coins are spent first by the next payment');
  await b.close();
});

test('X6: with no second node, a payment with no change back stays followed however deep (one node\'s word lets nothing go)', async () => {
  const chain = new FakeChain();
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  let gone = false;
  net.addServer(URLS[1], partial(chain.handler(), { down: () => gone }));
  fund(chain, W.addresses[0].address, 3n * COIN);
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, relayLookMs: 0, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await connected(b);
  // The coins were proven with the second node; from here it answers nothing.
  gone = true;
  const r = await b.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }], sendAll: true });
  chain.confirm(r.txid);
  for (let i = 0; i < 8; i++) {
    chain.height++;
    await newBlock(chain, [s1], b);
  }
  assert.equal(b.transparent.pending.has(r.txid), true, 'still followed');
  await b.close();
});

test('X2: a public payment to someone\'s Spark address names them while it is on its way: "Paid before?" sees it', async () => {
  const { openPaymentsTo } = await import('../../src/lib/open_payments.js');
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  fund(chain, W.addresses[0].address, 3n * COIN);
  fund(chain, W.addresses[1].address, 2n * COIN);
  fund(chain, W.addresses[2].address, 2n * COIN);
  fund(chain, W.addresses[3].address, 2n * COIN);
  const spark = new FakeSpark();
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, relayLookMs: 0, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await connected(b);
  const theirs = spark._addr(new Uint8Array(32).fill(5), 1, false);
  const { txid } = await b.send({ from: 'public', to: [{ address: theirs, amount: String(COIN) }] });
  const e = b.getState().txs.find((t) => t.txid === txid);
  assert.equal(e.kind, 'privatize');
  assert.equal(e.counterparty, theirs);
  assert.deepEqual(openPaymentsTo(b.getState().txs, theirs).map((t) => t.txid), [txid]);
  // Two people paid at once: both are seen (second audit N12: only the first was).
  const second = spark._addr(new Uint8Array(32).fill(6), 1, false);
  const third = spark._addr(new Uint8Array(32).fill(7), 1, false);
  const two = await b.send({ from: 'public', to: [{ address: second, amount: String(COIN / 4n) }, { address: third, amount: String(COIN / 4n) }] });
  assert.deepEqual(openPaymentsTo(b.getState().txs, third).map((t) => t.txid), [two.txid]);
  assert.deepEqual(openPaymentsTo(b.getState().txs, second).map((t) => t.txid), [two.txid]);
  // A Spark address and a public one at once: both seen (third audit F5).
  const mixed = await b.send({ from: 'public', to: [{ address: theirs, amount: String(COIN / 8n) }, { address: OTHER.address, amount: String(COIN / 8n) }] });
  assert.deepEqual(openPaymentsTo(b.getState().txs, OTHER.address).map((t) => t.txid), [mixed.txid]);
  assert.ok(openPaymentsTo(b.getState().txs, theirs).some((t) => t.txid === mixed.txid));
  // Make private (to this wallet's own Spark address) names no one.
  const own = await b.privatize({ amount: String(COIN) });
  assert.equal(b.getState().txs.find((t) => t.txid === own.txid).counterparty, undefined);
  await b.close();
});

test('audit N3: a reorganisation that moves a waiting coin\'s place: the set downloaded anew finds it again, and it is proven, never deleted', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 3n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const x = fakeCoin();
  chain.addBlock(1, [x, mine]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  let quiet = true;
  const s2 = net.addServer(URLS[1], partial(chain.handler(), { down: () => false, sparkDown: () => quiet }));
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  assert.equal(b.getState().balance.private.pending, String(3n * COIN), 'waiting: the second node says nothing of sets');
  // The newest block replaced by one with the same two transactions in the other order.
  chain.reorgLast(1, [mine, x]);
  await newBlock(chain, [s1, s2], b);
  quiet = false;
  for (let i = 0; i < 2; i++) {
    chain.height++;
    await newBlock(chain, [s1, s2], b);
  }
  const c = [...b.ownCoins.values()].find((v) => v.value === 3n * COIN);
  assert.ok(c, 'kept');
  assert.equal(c.proof, 'two-servers');
  assert.equal(b.getState().balance.private.available, String(3n * COIN));
  await b.close();
});

test('audit N3: a node with a fake coin, then a move to another node on its own: the real coin is found again in its new place, the fake one let go of', async () => {
  const spark = new FakeSpark();
  const real = fakeCoin();
  spark.own(real, { value: 5n * COIN });
  const fake = fakeCoin();
  spark.own(fake, { value: 50n * COIN });
  const honest = new FakeChain();
  const lying = new FakeChain();
  [[fakeCoin(), fakeCoin()], [fakeCoin(), fakeCoin()], [real, fakeCoin()]].forEach((coins, i) => {
    const h = honest.addBlock(1, coins);
    lying.addBlock(1, i === 1 ? [...coins, fake] : coins, { hash: h });
  });
  const net = new FakeNet();
  const s0 = net.addServer(URLS[0], lying.handler());
  const s1 = net.addServer(URLS[1], honest.handler());
  const s2 = net.addServer(URLS[2], honest.handler());
  const b = createBackend({ network: 'main', servers: URLS.map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  assert.equal(b.getState().balance.private.available, '0', 'caught: both wait');
  s0.refuse = true;
  s0.dropAll();
  for (let i = 0; i < 100 && b.getState().server === URLS[0]; i++) await tick(20);
  for (let i = 0; i < 100 && !b.getState().connected; i++) await tick(20);
  honest.height++;
  await newBlock(honest, [s1, s2], b);
  await b.waitForSync();
  honest.addBlock(1, [fakeCoin(), fakeCoin()]);
  await newBlock(honest, [s1, s2], b);
  await b.waitForSync();
  assert.deepEqual([...b.ownCoins.values()].map((c) => [c.value, c.proof]), [[5n * COIN, 'two-servers']]);
  assert.equal(b.getState().balance.private.available, String(5n * COIN));
  await b.close();
});

test('audit N6: a coin carried into the next group keeps its proof (the same bytes, txid and value), with no second node to ask again', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  const chain = new FakeChain({ startGroupSize: 4 });
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(1, [mine, fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  let quiet = false;
  const s2 = net.addServer(URLS[1], partial(chain.handler(), { sparkDown: () => quiet }));
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  assert.equal([...b.ownCoins.values()][0].proof, 'two-servers');
  // The second node silent on sets; group 2 opens, carrying group 1's newest coins over.
  quiet = true;
  chain.addBlock(2, [fakeCoin(), fakeCoin()]);
  await newBlock(chain, [s1, s2], b);
  const c = [...b.ownCoins.values()][0];
  assert.equal(c.groupId, 2);
  assert.equal(c.proof, 'two-servers');
  assert.equal(b.getState().balance.private.available, String(2n * COIN));
  await b.close();
});

test('audit N1: a coin in a block only the node in use has (one block ahead of every other) is not proven by a second node that is behind; the rest is', async () => {
  const spark = new FakeSpark();
  const real = fakeCoin();
  spark.own(real, { value: COIN });
  const fake = fakeCoin();
  spark.own(fake, { value: 40n * COIN });
  const plan = [[1, [fakeCoin(), fakeCoin()]], [1, [fakeCoin(), fakeCoin()]], [1, [fakeCoin(), fakeCoin()]], [2, [real, fakeCoin()]], [2, [fakeCoin(), fakeCoin()]]];
  const honest = new FakeChain();
  const lying = new FakeChain();
  for (const [g, coins] of plan) lying.addBlock(g, coins, { hash: honest.addBlock(g, coins) });
  lying.addBlock(2, [fake]); // one block past the network's tip, only on the node in use
  const net = new FakeNet();
  net.addServer(URLS[0], lying.handler());
  net.addServer(URLS[1], honest.handler());
  net.addServer(URLS[2], honest.handler());
  const b = createBackend({ network: 'main', servers: URLS.map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  await b.waitForSync();
  const s = b.getState();
  assert.deepEqual([...b.ownCoins.values()].map((c) => [c.value, c.proof ?? null]).sort((x, y) => (x[0] < y[0] ? -1 : 1)), [[COIN, 'two-servers'], [40n * COIN, null]]);
  assert.equal(s.balance.private.available, String(COIN));
  assert.equal(s.balance.private.pending, String(40n * COIN));
  await b.close();
});

test('audit N5: a Make private with no change, marked "not ours" by 0.1.7, is proven in its block, and the private coin it made counts with no set to check', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], partial(chain.handler()));
  fund(chain, W.addresses[0].address, 3n * COIN);
  const spark = new FakeSpark();
  const mine = fakeCoin(undefined, { mine: true });
  const body = mine.coin.subarray(0, 60);
  spark.createSparkMintRecipients = async ({ outputs }) => outputs.map((o) => ({ script: concatBytes(Uint8Array.of(0xd1), body), value: o.value }));
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, relayLookMs: 0, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await connected(b);
  const { txid } = await b.privatize({ amount: 'all' });
  assert.ok(!b.transparent.txs.get(txid).decoded.vout.some((o) => b.transparent.isOwnScript(o.script)), 'no change back');
  chain.confirm(txid);
  const ours = fakeCoin(mine.id, { txHash: hashFromHex(txid), mine: true });
  spark.own(ours, { value: 3n * COIN - 10000n });
  chain.addBlock(1, [ours]);
  for (let i = 0; i < 6; i++) {
    chain.height++;
    await newBlock(chain, [s1, s2], b);
  }
  // As 0.1.7 left it: settled, "not ours" for good.
  const rec = b.transparent.txs.get(txid);
  rec.proof = 'not-ours';
  await b.transparent.settlePending(txid);
  chain.height++;
  await newBlock(chain, [s1, s2], b);
  assert.equal(b.transparent.txs.get(txid).proof, 'two-servers', 'proven in its block');
  const c = [...b.ownCoins.values()].find((x) => x.txid === txid);
  assert.equal(b._sparkMadeHere(c), true);
  assert.equal(b.getState().balance.private.available, String(3n * COIN - 10000n), 'counted with no set checked (the second node says nothing of sets)');
  await b.close();
});

test('audit N7: a private payment to one of this wallet\'s own addresses keeps its bytes once confirmed: the coin it made stays made here', async () => {
  const b = createBackend({ network: 'main', servers: [{ url: URLS[0] }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: new FakeNet().WebSocket });
  const own = 'sm1own';
  b._isOwnSparkAddress = (a) => a === own;
  b.tip = { height: 100 };
  b.progress = { groups: {} };
  b._saveSpark = async (w = new Set()) => (w.add('s/sends'), w);
  b._coinsSpentBy = async () => [];
  const built = { spark: true, txid: 'ab'.repeat(32), hex: 'cafe', fee: 1n, recips: [{ kind: 'spark', address: own, amount: 5n }] };
  await b._recordPayment(built);
  assert.equal(b.sends.get(built.txid).toSelf, true);
  // Seen used on chain: confirmed, its bytes kept.
  b.ownCoins.set('x', { lTagHash: 'x', spentTxid: built.txid, value: 1n });
  b.sparkSync = { mempool: new Map() };
  await b._dropLostSends();
  assert.equal(b.sends.get(built.txid).confirmed, true);
  assert.equal(b.sends.get(built.txid).hex, 'cafe');
});

test('second audit N9 / third audit F3 / fourth audit N6: the first check of an old wallet\'s sets is done in parts, one after another (not one per block), the checks alone', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  // The coin in an old group (the newest is checked in the background anyway).
  const chain = new FakeChain({ startGroupSize: 4 });
  chain.addBlock(1, [mine]);
  for (let i = 0; i < 40; i++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(2, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  // No time for more than one part of two blocks per sync.
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM, proveMsPerSync: 0, verifyHeightsPerPart: 2 });
  let syncs = 0;
  let parts = 0;
  const once = b._syncOnce.bind(b);
  b._syncOnce = async () => (syncs++, once());
  const prove = b._proveSparkReceipts.bind(b);
  b._proveSparkReceipts = async () => (parts++, prove());
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  assert.equal([...b.ownCoins.values()][0].proof, 'two-servers', 'done with no new block');
  assert.ok(parts >= 4, `in parts (${parts})`);
  assert.ok(syncs < parts, `the checks alone go on, not whole syncs (fourth audit N6: ${syncs} syncs, ${parts} parts)`);
  assert.equal(b.getState().balance.private.available, String(2n * COIN));
  await b.close();
});

test('third audit F1: a private payment refused by the node, then paid again with its let-go coin: it goes (the check tells coins by linking tag, not bytes)', async () => {
  const spark = new FakeSpark(); // hands spent coins back as the real library does: the coin alone
  const a = fakeCoin();
  const c = fakeCoin();
  spark.own(a, { value: 3n * COIN });
  spark.own(c, { value: 4n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin()]);
  chain.addBlock(1, [a, fakeCoin(), c]);
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const pay = { from: 'private', to: [{ address: OTHER.address, amount: String(COIN) }] };
  chain.extra = { 'blockchain.transaction.broadcast': () => { throw Object.assign(new Error('bad-txns-something'), { code: 1 }); } };
  await assert.rejects(b.send(pay), (e) => e.code === 'server');
  chain.extra = null;
  assert.equal([...b.ownCoins.values()].filter((x) => x.conflictAt).length, 1, 'its coin let go of, spent first next time');
  const q = await b.quote(pay);
  assert.equal(q.warnings.filter((w) => /may still go through/.test(w)).length, 0, 'the library takes that coin: nothing to warn of');
  const r = await b.send(pay);
  assert.match(r.txid, /^[0-9a-f]{64}$/);
  await b.close();
});

/** A store that copies what it keeps, as IndexedDB does (the plain test store keeps the very objects). */
function copyingStore() {
  const s = createMemoryStore();
  return { ...s, async get(k) { const v = await s.get(k); return v === undefined ? v : structuredClone(v); }, async put(k, v) { return s.put(k, structuredClone(v)); } };
}

test('third audit F2: a set downloaded anew, then the app closed before the sync ended: the group is still looked at whole at the next start', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  let tagsDown = false;
  const h = chain.handler();
  const handler = (m, p, sv) => {
    if (tagsDown && m === 'spark.getusedcoinstagstxhashes') throw new Error('busy');
    return h(m, p, sv);
  };
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], handler);
  const s2 = net.addServer(URLS[1], handler);
  const store = copyingStore();
  const mk = () => createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  let b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  // A reorganisation puts a coin of this wallet's in a place already looked at; that sync then fails.
  chain.reorgLast(1, [mine, fakeCoin()]);
  tagsDown = true;
  await newBlock(chain, [s1, s2], b);
  await b.close();
  tagsDown = false;
  b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  assert.ok([...b.ownCoins.values()].some((c) => c.value === 2n * COIN), 'the coin is found');
  await b.close();
});

test('third audit F4: moved to a node one block behind, a coin waiting in the newest block is kept, and counts once that node has the block', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 3n * COIN });
  const ahead = new FakeChain();
  const behind = new FakeChain();
  for (const coins of [[fakeCoin(), fakeCoin()], [fakeCoin(), fakeCoin()]]) behind.addBlock(1, coins, { hash: ahead.addBlock(1, coins) });
  const other = fakeCoin();
  const blk = ahead.addBlock(1, [mine, other]); // only node A has the newest block yet
  ahead.height++;
  const net = new FakeNet();
  const sA = net.addServer(URLS[0], ahead.handler());
  const sB = net.addServer(URLS[1], behind.handler());
  const sC = net.addServer(URLS[2], behind.handler());
  const b = createBackend({ network: 'main', servers: URLS.map((url) => ({ url })), store: copyingStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  await b.waitForSync();
  sA.refuse = true;
  sA.dropAll();
  for (let i = 0; i < 100 && (b.getState().server === URLS[0] || !b.getState().connected); i++) await tick(20);
  await b.waitForSync();
  assert.ok([...b.ownCoins.values()].some((c) => c.value === 3n * COIN), 'kept while the node is behind');
  behind.addBlock(1, [mine, other], { hash: blk });
  behind.height = ahead.height + 1;
  for (const s of [sB, sC]) s.notify('blockchain.headers.subscribe', [{ height: behind.height, hex: headerHex(behind.height) }]);
  await tick();
  await b.waitForSync();
  assert.equal(b.getState().balance.private.available, String(3n * COIN));
  await b.close();
});

test('third audit F6: a restored payment found again in a set downloaded anew keeps no date (never "today")', async () => {
  const spark = new FakeSpark();
  const old = fakeCoin();
  spark.own(old, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [old, fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: copyingStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  assert.equal([...b.ownCoins.values()][0].time ?? null, null, 'restored: no time of its own');
  chain.reorgLast(1, [fakeCoin()]);
  await newBlock(chain, [s1, s2], b);
  assert.equal([...b.ownCoins.values()][0].time ?? null, null, 'still none after the set is downloaded anew');
  await b.close();
});

test('third audit H2: two checks of one set at once take turns', async () => {
  const { SparkSync } = await import('../../src/lib/firo/spark_sync.js');
  const sync = new SparkSync({ client: {}, store: createMemoryStore() });
  const order = [];
  let running = 0;
  sync._verifyGroup = async (g) => {
    running++;
    assert.equal(running, 1, 'never two at once');
    order.push(`start ${g}`);
    await tick(20);
    order.push(`end ${g}`);
    running--;
    return { state: 'match' };
  };
  await Promise.all([sync.verifyGroup(3), sync.verifyGroup(3), sync.verifyGroup(3)]);
  assert.deepEqual(order, ['start 3', 'end 3', 'start 3', 'end 3', 'start 3', 'end 3']);
  // Another group is not held up by it.
  sync._verifyGroup = async (g) => (order.push(`other ${g}`), { state: 'match' });
  await sync.verifyGroup(4);
  assert.equal(order.at(-1), 'other 4');
});

test('fourth audit N1: a set downloaded anew, its look cut short: the next look begins at its first coin again, and no real coin is let go of', async () => {
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [mine, ...Array.from({ length: 999 }, () => fakeCoin())]);
  chain.addBlock(1, Array.from({ length: 200 }, () => fakeCoin()));
  chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const b = createBackend({ network: 'main', servers: [{ url: URLS[0] }], store: copyingStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  chain.reorgLast(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  const orig = spark.identifyCoins.bind(spark);
  let calls = 0;
  spark.identifyCoins = async (a) => {
    if (a.coins.length > 100 && ++calls === 2) throw new Error('worker gone'); // the second part of the look
    return orig(a);
  };
  chain.height++;
  await newBlock(chain, [s1], b);
  spark.identifyCoins = orig;
  for (let i = 0; i < 2; i++) {
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, [s1], b);
  }
  assert.ok([...b.ownCoins.values()].some((c) => c.value === 2n * COIN), 'kept');
  assert.deepEqual(b.progress.anew ?? [], [], 'the look was done whole in the end');
  await b.close();
});

test('fourth audit N3: a node whose set never adds up: said once, and nothing read on and on; a payment over it is refused, not held', async () => {
  const { bytesToBase64 } = await import('../../src/lib/firo/bytes.js');
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [mine, fakeCoin()]);
  for (let i = 0; i < 40; i++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  chain.addBlock(2, [fakeCoin(), fakeCoin()]);
  const h = chain.handler();
  let reads = 0;
  const liar = (m, p, sv) => {
    if (m === 'blockchain.block.txids') reads++;
    const r = h(m, p, sv);
    return m === 'spark.getsparkanonymitysetmeta' && Number(p[0]) === 1 ? { ...r, setHash: bytesToBase64(new Uint8Array(32).fill(7)) } : r;
  };
  const net = new FakeNet();
  net.addServer(URLS[0], liar);
  net.addServer(URLS[1], h);
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM, proveMsPerSync: 40, verifyHeightsPerPart: 2 });
  await b.open({ mnemonic: W.mnemonic });
  await tick(2500);
  const after = reads;
  await tick(1000);
  assert.equal(reads, after, 'nothing more read with no new block');
  assert.equal(b.getState().privateCheck?.code, 'set-mismatch', 'and the person is told');
  const start = Date.now();
  await b.close();
  assert.ok(Date.now() - start < 2000, 'Lock is not held up');
});

test('fourth audit N4: a coin only one node ever had, after a move to a node that mined other blocks there: let go of, not "being checked" for ever', async () => {
  const spark = new FakeSpark();
  const ghost = fakeCoin();
  spark.own(ghost, { value: 5n * COIN });
  const ahead = new FakeChain();
  const behind = new FakeChain();
  for (const coins of [[fakeCoin(), fakeCoin()], [fakeCoin(), fakeCoin()]]) behind.addBlock(1, coins, { hash: ahead.addBlock(1, coins) });
  ahead.addBlock(1, [ghost, fakeCoin()]); // only on A
  ahead.height++;
  const net = new FakeNet();
  const sA = net.addServer(URLS[0], ahead.handler());
  const sB = net.addServer(URLS[1], behind.handler());
  const sC = net.addServer(URLS[2], behind.handler());
  const b = createBackend({ network: 'main', servers: URLS.map((url) => ({ url })), store: copyingStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  await b.waitForSync();
  sA.refuse = true;
  sA.dropAll();
  for (let i = 0; i < 100 && (b.getState().server === URLS[0] || !b.getState().connected); i++) await tick(20);
  await b.waitForSync();
  for (let i = 0; i < 4; i++) {
    behind.addBlock(1, [fakeCoin(), fakeCoin()]);
    behind.height = Math.max(behind.height, ahead.height + 1 + i);
    for (const s of [sB, sC]) s.notify('blockchain.headers.subscribe', [{ height: behind.height, hex: headerHex(behind.height) }]);
    await tick();
    await b.waitForSync();
  }
  assert.ok(![...b.ownCoins.values()].some((c) => c.value === 5n * COIN));
  assert.equal(b.getState().balance.private.pending, '0');
  await b.close();
});

test('fourth audit N5: a restored wallet\'s first look cut short and carried on: old coins are not dated today', async () => {
  const spark = new FakeSpark();
  const old = fakeCoin();
  spark.own(old, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, Array.from({ length: 1000 }, () => fakeCoin()));
  chain.addBlock(1, [old, ...Array.from({ length: 50 }, () => fakeCoin())]);
  for (let i = 0; i < 20; i++) chain.addBlock(1, [fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  const orig = spark.identifyCoins.bind(spark);
  let calls = 0;
  spark.identifyCoins = async (a) => {
    if (a.coins.length > 30 && ++calls === 2) throw new Error('worker gone');
    return orig(a);
  };
  await b.open({ mnemonic: W.mnemonic }); // restored: no birthday
  await b.waitForSync();
  await newBlock(chain, [s1, s2], b);
  assert.equal([...b.ownCoins.values()][0].time ?? null, null);
  await b.close();
});

test('fifth audit M1: after a Rescan, a restored wallet\'s old private payment is not dated today', async () => {
  const spark = new FakeSpark();
  const old = fakeCoin();
  spark.own(old, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), old, fakeCoin()]);
  for (let i = 0; i < 30; i++) chain.addBlock(1, [fakeCoin()]);
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  await b.rescan();
  await b.waitForSync();
  const c = [...b.ownCoins.values()][0];
  assert.ok(c, 'found again');
  assert.equal(c.time ?? null, null, 'no date of today');
  assert.equal(b.progress.relook, undefined, 'the mark goes once the sync is done');
  await b.close();
});

test('fifth audit M2: two wallets on one device share the set cache; one looking at a set downloaded anew leaves the other to look at it too', async () => {
  const KEYS2 = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
  const spark1 = new FakeSpark();
  const spark2 = new FakeSpark();
  const y = fakeCoin();
  spark2.own(y, { value: 3n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, Array.from({ length: 40 }, () => fakeCoin()));
  chain.addBlock(1, [fakeCoin(), fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const shared = copyingStore();
  const st1 = copyingStore();
  const st2 = copyingStore();
  const run = async (store, spark, mnemonic, blocks = 0) => {
    const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, sharedStore: shared, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
    await b.open({ mnemonic });
    await b.waitForSync();
    for (let i = 0; i < blocks; i++) {
      chain.addBlock(1, [fakeCoin()]);
      await newBlock(chain, [s1, s2], b);
    }
    const coins = [...b.ownCoins.values()].map((c) => c.value);
    await b.close();
    return coins;
  };
  await run(st2, spark2, KEYS2.vectors[1].mnemonic);
  chain.reorgLast(1, [y, fakeCoin(), fakeCoin()]); // wallet 2's coin now at a place it has looked at
  await run(st1, spark1, KEYS2.vectors[0].mnemonic); // wallet 1 sees the reorg first
  assert.ok((await run(st2, spark2, KEYS2.vectors[1].mnemonic, 2)).includes(3n * COIN), 'wallet 2 finds its coin');
});

test('fifth audit (r9): sessions too short for a whole look at a set downloaded anew carry it on, and reach its end', async () => {
  const spark = new FakeSpark();
  const pay = fakeCoin();
  spark.own(pay, { value: 4n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, Array.from({ length: 4990 }, () => fakeCoin()));
  chain.addBlock(1, Array.from({ length: 5 }, () => fakeCoin()));
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  const store = copyingStore();
  const shared = copyingStore();
  const mk = () => createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, sharedStore: shared, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  let b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  await b.close();
  chain.reorgLast(1, [pay, fakeCoin(), fakeCoin(), fakeCoin(), fakeCoin(), fakeCoin()]);
  const orig = spark.identifyCoins.bind(spark);
  let found = false;
  let sessions = 0;
  while (!found && sessions < 4) {
    sessions++;
    let parts = 0;
    spark.identifyCoins = async (a) => {
      if (a.coins.length >= 500 && ++parts > 3) throw new Error('session over');
      return orig(a);
    };
    b = mk();
    await b.open({ mnemonic: W.mnemonic });
    await b.waitForSync();
    found = [...b.ownCoins.values()].some((c) => c.value === 4n * COIN);
    await b.close();
  }
  spark.identifyCoins = orig;
  assert.ok(found, `found after ${sessions} short sessions`);
});

/** A wallet whose old 7 FIRO payment sits early in a 5,000-coin set. */
function oldPaymentWorld() {
  const spark = new FakeSpark();
  const old = fakeCoin();
  spark.own(old, { value: 7n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [...Array.from({ length: 50 }, () => fakeCoin()), old]);
  chain.addBlock(1, Array.from({ length: 4940 }, () => fakeCoin()));
  chain.addBlock(1, Array.from({ length: 5 }, () => fakeCoin()));
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  const store = copyingStore();
  const shared = copyingStore();
  const mk = () => createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, sharedStore: shared, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  const has = (b) => [...b.ownCoins.values()].some((c) => c.value === 7n * COIN);
  return { spark, chain, mk, has };
}

test('sixth audit N1: Rescan while a look at a set downloaded anew is unfinished: every coin found again', async () => {
  const { spark, chain, mk, has } = oldPaymentWorld();
  let b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  await b.close();
  chain.reorgLast(1, Array.from({ length: 6 }, () => fakeCoin()));
  const orig = spark.identifyCoins.bind(spark);
  let parts = 0;
  spark.identifyCoins = async (a) => {
    if (a.coins.length >= 500 && ++parts > 3) throw new Error('session over');
    return orig(a);
  };
  b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  spark.identifyCoins = orig;
  await b.rescan();
  await b.waitForSync();
  assert.ok(has(b), 'the old payment is found again');
  await b.close();
});

test('sixth audit P1: Rescan pressed again while the last one is still looking: nothing is lost', async () => {
  const { spark, mk, has } = oldPaymentWorld();
  const b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const orig = spark.identifyCoins.bind(spark);
  let parts = 0;
  spark.identifyCoins = async (a) => {
    if (a.coins.length >= 500) {
      parts++;
      await tick(30);
    }
    return orig(a);
  };
  await b.rescan();
  while (parts < 2) await tick(5);
  await b.rescan(); // past the old payment's place in the look under way
  await b.waitForSync();
  spark.identifyCoins = orig;
  assert.ok(has(b), 'found');
  assert.equal(b.getState().balance.private.available, String(7n * COIN));
  await b.close();
});

test('sixth audit N4: a mempool transaction the library cannot read stops nothing else: a coin spent elsewhere is seen spent', async () => {
  const { fakeTag } = await import('../fixtures/firo_fake_chain.mjs');
  const spark = new FakeSpark();
  const mine = fakeCoin();
  spark.own(mine, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [mine, fakeCoin(), fakeCoin()]);
  for (let i = 0; i < 5; i++) chain.addBlock(1, [fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  chain.mempool.set('ab'.repeat(32), { coins: [fakeCoin()], lTags: null });
  const orig = spark.identifyCoins.bind(spark);
  spark.identifyCoins = async (a) => {
    if (new Error().stack.includes('_sparkMempool')) throw new Error('the library cannot read this transaction');
    return orig(a);
  };
  chain.tags.push({ tag: fakeTag(mine.id), txid: 'cd'.repeat(32) });
  for (let i = 0; i < 3; i++) {
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, [s1, s2], b);
  }
  spark.identifyCoins = orig;
  assert.ok([...b.ownCoins.values()].find((x) => x.value === 2n * COIN).spentTxid, 'seen spent');
  await b.close();
});

test('seventh audit H1: a look that failed, carried on in the same session, then the app closed: no coin found and not yet saved is skipped', async () => {
  const spark = new FakeSpark();
  const x = fakeCoin();
  spark.own(x, { value: 7n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, Array.from({ length: 1500 }, () => fakeCoin()));
  chain.addBlock(1, [...Array.from({ length: 3490 }, () => fakeCoin()), x]);
  chain.addBlock(1, Array.from({ length: 5 }, () => fakeCoin()));
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const store = copyingStore();
  const shared = copyingStore();
  const mk = () => createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, sharedStore: shared, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  const has = (b) => [...b.ownCoins.values()].some((c) => c.value === 7n * COIN);
  let b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const orig = spark.identifyCoins.bind(spark);
  let part = 0;
  let plan = ['ok', 'ok', 'ok', 'fail'];
  let killed = false;
  spark.identifyCoins = async (a) => {
    if (a.coins.length >= 500) {
      const p = plan[part++] ?? 'ok';
      if (p === 'fail') throw new Error('worker gone');
      if (p === 'kill') {
        killed = true;
        throw new Error('app closed');
      }
    }
    return orig(a);
  };
  await b.rescan();
  await b.waitForSync();
  if (!killed) {
    part = 0;
    plan = ['ok', 'kill'];
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, [s1, s2], b);
  }
  await b.close();
  spark.identifyCoins = orig;
  b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  for (let i = 0; i < 2; i++) {
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, [s1, s2], b);
  }
  assert.ok(has(b), 'the 7 FIRO coin is found');
  await b.close();
});

test('seventh audit L1: a page that died during a Rescan\'s save does not show 0 for good', async () => {
  const spark = new FakeSpark();
  const x = fakeCoin();
  spark.own(x, { value: 7n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), x, fakeCoin()]);
  for (let i = 0; i < 5; i++) chain.addBlock(1, [fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const kill = { armed: false, dead: false };
  const base = createMemoryStore();
  const store = {
    ...base,
    async get(k) {
      const v = await base.get(k);
      return v === undefined ? v : structuredClone(v);
    },
    async put(k, v) {
      if (kill.dead) return;
      await base.put(k, structuredClone(v));
      if (kill.armed && k === 's/coins') kill.dead = true; // the page dies right after this write
    },
    async del(k) {
      if (!kill.dead) return base.del(k);
    },
  };
  const mk = () => createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  let b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  kill.armed = true;
  await b.rescan();
  await b.close();
  kill.dead = false;
  kill.armed = false;
  b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  for (let i = 0; i < 2; i++) {
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, [s1, s2], b);
  }
  assert.equal(b.getState().balance.private.available, String(7n * COIN));
  await b.close();
});

test('eighth audit N1: Rescan pressed while a look saves its first coin: the Rescan\'s look starts from the first coin, nothing hidden', async () => {
  const spark = new FakeSpark();
  const x = fakeCoin();
  const y = fakeCoin();
  spark.own(x, { value: 7n * COIN });
  spark.own(y, { value: 2n * COIN });
  const chain = new FakeChain();
  chain.addBlock(1, [...Array.from({ length: 50 }, () => fakeCoin()), x]);
  chain.addBlock(1, [...Array.from({ length: 3449 }, () => fakeCoin()), y]);
  chain.addBlock(1, Array.from({ length: 1500 }, () => fakeCoin()));
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const base = createMemoryStore();
  let slow = 0;
  let onSlowWrite = null;
  const store = {
    ...base,
    async get(k) {
      const v = await base.get(k);
      return v === undefined ? v : structuredClone(v);
    },
    async put(k, v) {
      if (k === 's/coins' && slow) {
        const f = onSlowWrite;
        onSlowWrite = null;
        if (f) f();
        await tick(slow);
      }
      return base.put(k, structuredClone(v));
    },
  };
  const shared = createMemoryStore();
  const mk = () => createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, sharedStore: shared, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  let b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  await b.close();
  chain.reorgLast(1, Array.from({ length: 1501 }, () => fakeCoin()));
  b = mk();
  slow = 40;
  let rescanned = null;
  const id = spark.identifyCoins.bind(spark);
  let armed = false;
  spark.identifyCoins = async (a) => {
    if (a.coins.length >= 500 && !armed) {
      armed = true;
      onSlowWrite = () => setTimeout(() => (rescanned = b.rescan()), 10); // pressed during the look's first save
    }
    return id(a);
  };
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  if (rescanned) await rescanned;
  await tick(100);
  await b.waitForSync();
  slow = 0;
  spark.identifyCoins = id;
  for (let i = 0; i < 2; i++) {
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, [s1, s2], b);
  }
  await b.close();
  b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const values = [...b.ownCoins.values()].map((c) => c.value);
  assert.ok(rescanned, 'the Rescan was pressed during the save');
  assert.ok(values.includes(7n * COIN) && values.includes(2n * COIN), `both coins: ${values}`);
  await b.close();
});

test('eighth audit N3: Lock stops a look at once: nothing more is looked at with the key', async () => {
  const spark = new FakeSpark();
  const chain = new FakeChain();
  for (let i = 0; i < 20; i++) chain.addBlock(1, Array.from({ length: 1000 }, () => fakeCoin()));
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), sharedStore: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  const orig = spark.identifyCoins.bind(spark);
  let parts = 0;
  let afterLock = 0;
  let locking = false;
  spark.identifyCoins = async (a) => {
    if (a.coins.length >= 500) {
      parts++;
      if (locking) afterLock++;
      await tick(50);
    }
    return orig(a);
  };
  await b.open({ mnemonic: W.mnemonic });
  while (parts < 2) await tick(5);
  locking = true;
  await b.close();
  assert.ok(afterLock <= 1, `at most the part under way (${afterLock})`);
});

test('ninth audit H1: a mempool answer that still lists a payment just mined does not take it out of its block', async () => {
  const { hashToHex } = await import('../../src/lib/firo/bytes.js');
  const spark = new FakeSpark();
  const chain = new FakeChain();
  for (let i = 0; i < 6; i++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const store = createMemoryStore();
  const mk = () => createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  let b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const x = fakeCoin();
  spark.own(x, { value: 5n * COIN });
  const txid = hashToHex(x.txHash);
  chain.addBlock(1, [fakeCoin(), x, fakeCoin()]);
  chain.mempool.set(txid, { coins: [x], lTags: null }); // one stale answer: mined, still listed
  await newBlock(chain, [s1, s2], b);
  chain.mempool.delete(txid);
  for (let i = 0; i < 4; i++) {
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, [s1, s2], b);
  }
  await b.close();
  b = mk();
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const c = [...b.ownCoins.values()].find((v) => v.value === 5n * COIN);
  assert.ok(c, 'still there');
  assert.equal(c.mempool, false);
  assert.equal(b.getState().balance.private.available, String(5n * COIN));
  await b.close();
});

test('tenth audit N3: a save writes the progress as it was when it took the coins, not as a look moved it meanwhile', async () => {
  const base = createMemoryStore();
  let slow = false;
  const store = {
    ...base,
    async get(k) {
      const v = await base.get(k);
      return v === undefined ? v : structuredClone(v);
    },
    async put(k, v) {
      const copy = structuredClone(v); // as IndexedDB: copied when put is called
      if (slow && k === 's/coins') await tick(30);
      return base.put(k, copy);
    },
  };
  const chain = new FakeChain();
  for (let i = 0; i < 4; i++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  net.addServer(URLS[0], chain.handler());
  net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store, spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const before = b.progress.groups[1];
  slow = true;
  const saving = b._saveSpark(); // a payment's record write while a look is under way
  await tick(5);
  b.progress.groups[1] = before + 1000; // the look moves on, past a coin this save did not take
  await saving;
  slow = false;
  assert.equal((await store.get('s/progress')).groups[1], before);
  await b.close();
});

test('tenth audit N2: a payment waiting in the mempool is still shown after a Rescan', async () => {
  const { hashToHex } = await import('../../src/lib/firo/bytes.js');
  const spark = new FakeSpark();
  const chain = new FakeChain();
  for (let i = 0; i < 6; i++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const s1 = net.addServer(URLS[0], chain.handler());
  const s2 = net.addServer(URLS[1], chain.handler());
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const x = fakeCoin();
  spark.own(x, { value: 5n * COIN });
  chain.mempool.set(hashToHex(x.txHash), { coins: [x], lTags: null });
  chain.addBlock(1, [fakeCoin()]);
  await newBlock(chain, [s1, s2], b);
  assert.equal(b.getState().balance.private.pending, String(5n * COIN));
  await b.rescan();
  await b.waitForSync();
  chain.addBlock(1, [fakeCoin()]);
  await newBlock(chain, [s1, s2], b);
  assert.equal(b.getState().balance.private.pending, String(5n * COIN), 'still shown');
  await b.close();
});

// A wallet with an incoming private payment of 5 FIRO about to be mined (tenth/eleventh audits).
async function waitingPaymentWorld() {
  const { hashToHex } = await import('../../src/lib/firo/bytes.js');
  const spark = new FakeSpark();
  const chain = new FakeChain();
  for (let i = 0; i < 6; i++) chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const servers = [net.addServer(URLS[0], chain.handler()), net.addServer(URLS[1], chain.handler())];
  const b = createBackend({ network: 'main', servers: URLS.slice(0, 2).map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM });
  await b.open({ mnemonic: W.mnemonic });
  await b.waitForSync();
  const x = fakeCoin();
  spark.own(x, { value: 5n * COIN });
  const shown = () => [...b.ownCoins.values()].filter((c) => c.value === 5n * COIN);
  const mined = async () => {
    chain.addBlock(1, [fakeCoin()]);
    await newBlock(chain, servers, b);
  };
  return { b, chain, servers, spark, x, txid: hashToHex(x.txHash), shown, mined };
}

test('tenth audit N1: a payment whose block a reorganisation takes while its coins are looked at is shown again while it waits in the mempool', async () => {
  const { b, chain, servers, spark, x, txid, shown, mined } = await waitingPaymentWorld();
  chain.addBlock(1, [fakeCoin(), x, fakeCoin()]);
  const orig = spark.identifyCoins.bind(spark);
  let done = false;
  spark.identifyCoins = async (a) => {
    const r = await orig(a);
    if (!done && !new Error().stack.includes('_sparkMempool') && a.coins.some((c) => bytesToHex(c.coin.subarray(0, 60)) === bytesToHex(x.coin.subarray(0, 60)))) {
      done = true;
      chain.reorgLast(1, [fakeCoin(), fakeCoin(), fakeCoin()]); // the block goes...
      chain.mempool.set(txid, { coins: [x], lTags: null }); // ...and the payment is back in the mempool
    }
    return r;
  };
  await newBlock(chain, servers, b);
  assert.ok(done, 'the reorganisation happened during the look');
  for (let i = 0; i < 2; i++) {
    await mined();
    assert.equal(shown().length, 1, `shown while it waits (block ${i + 1})`);
  }
  chain.mempool.delete(txid);
  chain.addBlock(1, [x]);
  await newBlock(chain, servers, b);
  await mined();
  await mined();
  assert.equal(shown().length, 1, JSON.stringify(shown().map((c) => ({ g: c.groupId, i: c.index, m: c.mempool }))));
  assert.ok(!shown()[0].mempool && shown()[0].index != null, 'mined again: in its block');
  await b.close();
});

test('tenth audit: a failed read of the held set while a mempool payment is checked leaves it to be looked at again next sync', async () => {
  const { b, chain, servers, spark, x, txid, shown, mined } = await waitingPaymentWorld();
  chain.addBlock(1, [fakeCoin(), x, fakeCoin()]);
  chain.mempool.set(txid, { coins: [x], lTags: null }); // a stale listing of a payment just mined
  const ss = b.sparkSync;
  const read = ss.coins.bind(ss);
  let throws = 0;
  ss.coins = async (g, o) => {
    if (new Error().stack.includes('_sparkMempool') && throws === 0) {
      throws++;
      throw new Error('IndexedDB read failed');
    }
    return read(g, o);
  };
  let done = false;
  const orig = spark.identifyCoins.bind(spark);
  spark.identifyCoins = async (a) => {
    const r = await orig(a);
    if (!done && !new Error().stack.includes('_sparkMempool') && a.coins.some((c) => bytesToHex(c.coin.subarray(0, 60)) === bytesToHex(x.coin.subarray(0, 60)))) {
      done = true;
      chain.reorgLast(1, [fakeCoin(), fakeCoin(), fakeCoin()]); // its block goes after all
    }
    return r;
  };
  await newBlock(chain, servers, b);
  assert.equal(throws, 1, 'the read failed once');
  for (let i = 0; i < 3; i++) {
    await mined();
    assert.equal(shown().length, 1, `shown while it waits (block ${i + 1})`);
  }
  await b.close();
});
