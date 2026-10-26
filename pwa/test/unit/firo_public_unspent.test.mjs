// The public balance is the node's list of unspent coins (owner, 2026-10-25, after 0.1.13: "Same
// amount of public Firo, it's incorrect" and "Check how it resolved in Campfire wallet and do the
// same"). Campfire counts the coins ElectrumX lists for each address (listunspent); the PWA worked
// them out from the histories alone, so a spend those did not name kept a spent coin counted, and a
// coin they did not name was missing. Now both answers are asked together, and a coin the node does
// not list is spent; every coin it lists is fetched and proven like any other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackend } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { buildSignedTransaction, decodeTx } from '../../src/lib/firo/tx.js';
import { addressToScript, scriptHash } from '../../src/lib/firo/address.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { hexToBytes, bytesToHex, sha256d } from '../../src/lib/firo/bytes.js';
import { FiroKeys } from '../../src/lib/firo/keys.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, headerHex } from '../fixtures/firo_fake_chain.mjs';
import { FakeSpark } from '../fixtures/firo_fake_spark.mjs';
import { assessSync } from '../../src/lib/sync.js';

const MAIN = NETWORKS.main;
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const W = KEYS.vectors[0];
const OTHER = KEYS.vectors[2].addresses[0];
const URL1 = 'wss://fake.example:50004';
const URL2 = 'wss://fake2.example:50004';
const COIN = 100000000n;

/** The wallet on a fake chain whose main node can be made to fail chosen questions (`fail(method, params)`). */
function world({ store = createMemoryStore(), chain = new FakeChain() } = {}) {
  const net = new FakeNet();
  const base = chain.handler();
  const w = { fail: () => false };
  const server = net.addServer(URL1, (method, params, socket) => {
    const f = w.fail(method, params);
    if (f) throw Object.assign(new Error(typeof f === 'string' ? f : 'timed out (test)'), { code: -1 });
    const lie = w.unspentMain ?? w.unspent; // the node in use alone, or both
    if (method === 'blockchain.scripthash.listunspent' && lie) return lie(params[0]) ?? base(method, params, socket);
    // patch(method, params, answer): what the node in use answers instead (undefined: the answer).
    if (w.patch) {
      const r = base(method, params, socket);
      const x = w.patch(method, params, r);
      return x === undefined ? r : x;
    }
    return base(method, params, socket);
  });
  const base2 = chain.handler();
  net.addServer(URL2, (method, params, socket) => (method === 'blockchain.scripthash.listunspent' && w.unspent ? w.unspent(params[0]) ?? base2(method, params, socket) : base2(method, params, socket)));
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store, spark: new FakeSpark(), sparkTxDetails: 'none', WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const mine = async () => {
    chain.height++;
    server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await settle();
    await backend.waitForSync();
  };
  /** As ElectrumX: a status notification for an address whose history changed. */
  const tell = async (address) => {
    const sh = scriptHash(addressToScript(address, MAIN));
    server.notify('blockchain.scripthash.subscribe', [sh, chain.status(sh)]);
    await settle();
  };
  return Object.assign(w, { backend, chain, store, mine, tell, settle });
}

let n = 0;
/** A confirmed payment from OTHER to `address`, `confs` blocks deep. */
function fund(chain, address, value, confs = 10) {
  const height = chain.height - confs + 1;
  const tx = buildSignedTransaction({
    inputs: [{ txid: bytesToHex(sha256d(Uint8Array.of(++n, 7))), vout: 0, value: value + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(address, MAIN), value }],
    locktime: height - 1,
  });
  return chain.addTx(tx.hex, height);
}

const pub = (b) => b.getState().balance.public;
const shOf = (address) => scriptHash(addressToScript(address, MAIN));

/** A payment from `address` (key `sk`) spending `coin` to OTHER, in a block `confs` deep, indexed by the node as usual. */
function spend(chain, coin, sk, value, confs = 3) {
  const height = chain.height - confs + 1;
  const tx = buildSignedTransaction({
    inputs: [{ ...coin, sk: hexToBytes(sk) }],
    outputs: [{ script: addressToScript(OTHER.address, MAIN), value }],
    locktime: height - 1,
  });
  return chain.addTx(tx.hex, height);
}

/** The node's history of `address` without `txid` (an index that missed it), listunspent still right. */
function historyMisses(w, address, txid) {
  const sh = shOf(address);
  const right = w.chain.unspent(sh);
  w.chain.history.set(sh, w.chain.history.get(sh).filter((h) => h.tx_hash !== txid));
  const prev = w.unspent;
  w.unspent = (x) => (x === sh ? right : prev?.(x));
}

const A0 = W.addresses[0];

test('a coin the node no longer lists is spent, although its history does not name the spender', async () => {
  const w = world();
  const a = fund(w.chain, A0.address, 3n * COIN, 20);
  fund(w.chain, A0.address, 2n * COIN, 20);
  const s = spend(w.chain, { txid: a, vout: 0, value: 3n * COIN, script: addressToScript(A0.address, MAIN) }, A0.privkey, 3n * COIN - 3000n);
  historyMisses(w, A0.address, s);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  // From the history alone it was 5 FIRO: the 3 spent elsewhere (the same words in another wallet) counted.
  assert.equal(pub(w.backend).available, String(2n * COIN));
  assert.equal(pub(w.backend).pending, '0');
  assert.equal((await w.backend.coins.list()).length, 1);
  await w.backend.close();
});

test('a coin the node lists whose transaction its history does not name is fetched, proven and counted', async () => {
  const w = world();
  fund(w.chain, A0.address, 2n * COIN, 20);
  const sh = shOf(A0.address);
  const extra = fund(w.chain, A0.address, 4n * COIN, 15);
  historyMisses(w, A0.address, extra);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  assert.equal(pub(w.backend).available, String(6n * COIN));
  assert.ok(w.chain.unspent(sh).length === 1, 'the fake history really misses it');
  await w.backend.close();
});

test('a wallet synced by 0.1.13 asks every address for its coins once after the update', async () => {
  const store = createMemoryStore();
  const w = world({ store });
  const a = fund(w.chain, A0.address, 3n * COIN, 20);
  fund(w.chain, A0.address, 2n * COIN, 20);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  assert.equal(pub(w.backend).available, String(5n * COIN));
  await w.backend.close();

  // As 0.1.13 left it: statuses of version 2, no unspent coins; then a spend its history misses.
  const addr = await store.get('w/t/addr');
  await store.put('w/t/addr', { ...addr, statusV: 2 });
  await store.del('w/t/unspent');
  const s = spend(w.chain, { txid: a, vout: 0, value: 3n * COIN, script: addressToScript(A0.address, MAIN) }, A0.privkey, 3n * COIN - 3000n);
  const again = world({ store, chain: w.chain });
  historyMisses(again, A0.address, s);
  await again.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await again.backend.waitForSync();
  await again.mine();
  assert.equal(pub(again.backend).available, String(2n * COIN));
  assert.equal((await store.get('w/t/addr')).statusV, 3);
  await again.backend.close();
});

test('an address whose unspent coins the node will not give is asked again, its old coins kept', async () => {
  const w = world();
  fund(w.chain, A0.address, 3n * COIN, 20);
  let refuse = true;
  w.fail = (m) => refuse && m === 'blockchain.scripthash.listunspent';
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  assert.ok(w.backend.getState().sync.partial > 0, 'a partial sync');
  refuse = false;
  await w.mine();
  await w.mine();
  assert.equal(pub(w.backend).available, String(3n * COIN));
  await w.backend.close();
});

test('an address with too many payments for the node to list is counted by its coins, and followed at every block', async () => {
  const w = world();
  fund(w.chain, A0.address, 3n * COIN);
  const big = W.addresses[1];
  const a = fund(w.chain, big.address, 1n * COIN, 30);
  fund(w.chain, big.address, 2n * COIN, 25);
  const shBig = shOf(big.address);
  // As three of Firo's four nodes for an address of thousands of payments (measured 2026-10-25):
  // its status and its history refused, its unspent coins given.
  w.fail = (m, p) => (m === 'blockchain.scripthash.get_history' || m === 'blockchain.scripthash.subscribe') && p[0] === shBig && 'history too large';
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  assert.equal(pub(w.backend).available, String(6n * COIN));
  assert.equal(w.backend.getState().sync.partial, undefined, 'not "catching up": nothing is missing');
  // A payment to it and a spend from it (the same words in another wallet): no notification comes,
  // the next block shows both.
  fund(w.chain, big.address, 4n * COIN, 1);
  spend(w.chain, { txid: a, vout: 0, value: 1n * COIN, script: addressToScript(big.address, MAIN) }, big.privkey, 1n * COIN - 3000n, 1);
  await w.mine();
  await w.mine();
  assert.equal(pub(w.backend).available, String(9n * COIN));
  // Every coin is still proven before it counts: a node inventing one in its list is not believed.
  const fake = 'ab'.repeat(32);
  const right = w.chain.unspent.bind(w.chain);
  w.unspent = (sh) => (sh === shBig ? [...right(sh), { tx_hash: fake, tx_pos: 0, height: w.chain.height - 3, value: 50 * 1e8 }] : null);
  await w.mine();
  assert.equal(pub(w.backend).available, String(9n * COIN));
  await w.backend.close();
});

test('an address whose node answers a history far too long is counted by its coins, its history not fetched', async () => {
  const { BIG_HISTORY } = await import('../../src/lib/firo/transparent.js');
  const w = world();
  const big = W.addresses[1];
  fund(w.chain, big.address, 2n * COIN, 20);
  const shBig = shOf(big.address);
  // As Firo's fourth node: the whole history, here of payments long spent (made-up txids).
  const long = Array.from({ length: BIG_HISTORY + 1 }, (_, i) => ({ tx_hash: bytesToHex(sha256d(Uint8Array.of(i & 255, i >> 8, 9))), height: 1000 + i }));
  const real = w.chain.history.get(shBig);
  w.chain.history.set(shBig, [...long, ...real]);
  const right = w.chain.unspent.bind(w.chain);
  w.unspent = (sh) => (sh === shBig ? right(sh).filter((u) => real.some((h) => h.tx_hash === u.tx_hash)) : null);
  const gets = new Set();
  w.fail = (m, p) => {
    if (m === 'blockchain.transaction.get') gets.add(p[0]);
    return false;
  };
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  assert.equal(pub(w.backend).available, String(2n * COIN));
  assert.ok(gets.has(real[0].tx_hash), 'its coin fetched');
  assert.ok(!long.some((h) => gets.has(h.tx_hash)), 'none of the long history fetched');
  assert.equal(w.backend.getState().sync.partial, undefined);
  await w.backend.close();
});

// The audit of 0.1.14 (U-1 to U-4), each first shown failing on the commit it audited.
const A1 = W.addresses[1];
const bigFail = (sh) => (m, p) => (m === 'blockchain.scripthash.get_history' || m === 'blockchain.scripthash.subscribe') && p[0] === sh && 'history too large';
const inputsOf = (w, txid) => decodeTx(w.chain.txs.get(txid).hex, MAIN).vin.map((i) => `${i.txid}:${i.vout}`);

test('U-1: a coin of a payment let go of is spent first by the next one, although the node no longer lists it', async () => {
  const w = world();
  const c1 = fund(w.chain, A0.address, 3n * COIN, 20);
  fund(w.chain, A0.address, 2n * COIN, 20);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const gone = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(COIN) }], feePerKb: 1000n });
  await w.backend.transparent.keepConflicts(gone.txid, gone.hex);
  // The node in use, which kept that payment, leaves its coin out of its list and names no spender;
  // the second node still lists it.
  const right = w.chain.unspent.bind(w.chain);
  w.unspentMain = (sh) => (sh === shOf(A0.address) ? right(sh).filter((u) => u.tx_hash !== c1) : null);
  fund(w.chain, A0.address, 1000000n, 1);
  await w.tell(A0.address);
  await w.backend.waitForSync();
  await w.mine();
  assert.equal(pub(w.backend).available, String(2n * COIN + 1000000n), 'not in the balance');
  assert.ok(!(await w.backend.coins.list()).some((c) => c.id === `${c1}:0`), 'not offered as a coin');
  const r = await w.backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.ok(inputsOf(w, r.txid).includes(`${c1}:0`), 'spent first: at most one of the two is mined');
  await w.backend.close();
});

test('U-1: honest nodes, an address of thousands of payments: a refused payment that went out anyway shows as sent, not lost', async () => {
  const w = world();
  const c1 = fund(w.chain, A1.address, 3n * COIN, 20);
  fund(w.chain, A1.address, 3n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  assert.equal(pub(w.backend).available, String(6n * COIN));
  const gone = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(3n * COIN - 900n) }], feePerKb: 1000n });
  await w.backend.transparent.keepConflicts(gone.txid, gone.hex);
  // It reached the network after all (relayed by a node that answered "refused"): both nodes stop
  // listing its coin, and no history of ours will name it.
  w.chain.addTx(gone.hex, 0);
  await w.mine();
  w.chain.confirm(gone.txid);
  for (let i = 0; i < 3; i++) await w.mine();
  const e = w.backend.getState().txs.find((x) => x.txid === gone.txid);
  assert.ok(e, 'in Activity again');
  assert.equal(e.direction, 'out');
  assert.ok(e.confirmations >= 1);
  assert.ok(!w.backend.transparent.pending.has(gone.txid), 'settled');
  assert.equal(w.backend.transparent.conflictCoins().size, 0, 'nothing kept for it any more');
  assert.equal(pub(w.backend).available, String(3n * COIN));
  // The next payment is an ordinary one.
  const r = await w.backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  assert.ok(!inputsOf(w, r.txid).includes(`${c1}:0`));
  await w.backend.close();
});

test('U-2: Send all from an address the node will not list is settled once in a block', async () => {
  const w = world();
  fund(w.chain, A1.address, 3n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  const r = await w.backend.send({ from: 'public', to: [{ address: OTHER.address, amount: '1000' }], sendAll: true });
  assert.equal(decodeTx(w.chain.txs.get(r.txid).hex, MAIN).vout.length, 1, 'no change');
  w.chain.confirm(r.txid);
  for (let i = 0; i < 3; i++) await w.mine();
  assert.ok(!w.backend.transparent.pending.has(r.txid), 'settled');
  const e = w.backend.getState().txs.find((x) => x.txid === r.txid);
  assert.equal(e.direction, 'out');
  assert.ok(e.confirmations >= 1);
  assert.equal(pub(w.backend).available, '0');
  await w.backend.close();
});

test('U-3: a payment with change from an address the node will not list stays "sent" in Activity once mined', async () => {
  const w = world();
  fund(w.chain, A1.address, 3n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  const r = await w.backend.send({ from: 'public', to: [{ address: OTHER.address, amount: String(COIN) }] });
  w.chain.confirm(r.txid);
  for (let i = 0; i < 8; i++) await w.mine();
  const e = w.backend.getState().txs.find((x) => x.txid === r.txid);
  assert.equal(e.direction, 'out');
  assert.equal(e.amount, String(COIN));
  assert.ok(BigInt(e.fee) > 0n);
  assert.ok(w.backend.getState().txs.some((x) => x.direction === 'in' && x.amount === String(3n * COIN)), 'the spent receipt is still listed');
  await w.backend.close();
});

test('U-4: "excessive resource usage" (the node\'s limit on one connection) is asked again, the address not marked', async () => {
  const w = world();
  const a = fund(w.chain, A0.address, 3n * COIN, 20);
  fund(w.chain, A0.address, 2n * COIN, 20);
  spend(w.chain, { txid: a, vout: 0, value: 3n * COIN, script: addressToScript(A0.address, MAIN) }, A0.privkey, 3n * COIN - 3000n, 5);
  let once = true;
  w.fail = (m, p) => m === 'blockchain.scripthash.get_history' && p[0] === shOf(A0.address) && once && ((once = false), 'excessive resource usage');
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  for (let i = 0; i < 3; i++) await w.mine();
  assert.equal(w.backend.transparent.addr.big?.[shOf(A0.address)], undefined);
  assert.equal(w.backend.getState().txs.length, 3, 'both receipts and the spend');
  assert.equal(pub(w.backend).available, String(2n * COIN));
  await w.backend.close();
});

test('U-5: an address the node will not list, asked at every block, is not written again while unchanged', async () => {
  const inner = createMemoryStore();
  const writes = [];
  const store = { get: (k) => inner.get(k), keys: (p) => inner.keys(p), del: (k) => inner.del(k), put: (k, v) => (writes.push(k), inner.put(k, v)) };
  const w = world({ store });
  fund(w.chain, A1.address, 3n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  writes.length = 0;
  for (let i = 0; i < 4; i++) await w.mine();
  assert.deepEqual(writes.filter((k) => /t\/(hist|unspent)$/.test(k)), []);
  fund(w.chain, A1.address, 1n * COIN, 1);
  await w.mine();
  assert.ok(writes.some((k) => k.endsWith('t/unspent')), 'a change is written');
  assert.equal(pub(w.backend).available, String(4n * COIN));
  await w.backend.close();
});

// The second audit of 0.1.14 (N-1 to N-6), each first shown failing on the commit it audited.
test('N-1: a payment of ours from an address the node will not list that never got out is let go of, sending not paused', async () => {
  const w = world();
  const c1 = fund(w.chain, A1.address, 3n * COIN, 20);
  fund(w.chain, A1.address, 2n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  const d = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(COIN) }], feePerKb: 1000n });
  await w.backend.transparent.addPending({ txid: d.txid, hex: d.hex, height: w.chain.height - 10 });
  for (let i = 0; i < 4; i++) await w.mine();
  assert.equal(w.backend.transparent.pending.get(d.txid)?.dropped, true, 'not on the network: dropped');
  assert.equal(w.backend.getState().sync.partial, undefined, 'sending not paused');
  assert.equal(pub(w.backend).available, String(5n * COIN));
  await w.backend.close();
});

test('N-2/N-3: a payment that leaves the mempool, a stranger\'s to us or ours refused, holds nothing and pauses nothing', async () => {
  const w = world();
  const c1 = fund(w.chain, A1.address, 3n * COIN, 20);
  fund(w.chain, A1.address, 2n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  // A stranger's payment, seen in the mempool, then evicted.
  const t = fund(w.chain, A1.address, 1n * COIN, 0);
  w.chain.txs.get(t).height = 0;
  for (const h of w.chain.history.values()) for (const e of h) if (e.tx_hash === t) e.height = 0;
  await w.mine();
  w.chain.txs.delete(t);
  for (const [sh, h] of w.chain.history) w.chain.history.set(sh, h.filter((e) => e.tx_hash !== t));
  // Ours, written down before its broadcast, a sync meanwhile, then refused and forgotten.
  const d = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(3n * COIN - 900n) }], feePerKb: 1000n });
  await w.backend.transparent.addPending({ txid: d.txid, hex: d.hex, height: w.chain.height });
  await w.mine();
  await w.backend.transparent.removePending(d.txid);
  for (let i = 0; i < 4; i++) await w.mine();
  assert.equal(w.backend.getState().sync.partial, undefined);
  assert.ok(!w.backend.transparent.txs.has(t) && !w.backend.transparent.txs.has(d.txid), 'neither held');
  assert.equal(pub(w.backend).available, String(5n * COIN));
  assert.equal(pub(w.backend).pending, '0');
  await w.backend.close();
});

test('N-4/K-2: a coin kept from a payment let go of keeps the time it was first kept; another payment of it is kept too', async () => {
  const w = world();
  const c1 = fund(w.chain, A0.address, 3n * COIN, 20);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const item = w.backend.transparent;
  const d = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(COIN) }], feePerKb: 1000n });
  await item.keepConflicts(d.txid, d.hex);
  const at = item.conflictPays(`${c1}:0`)[0].at;
  await new Promise((r) => setTimeout(r, 5));
  await item.keepConflicts(d.txid, d.hex);
  assert.deepEqual(item.conflictPays(`${c1}:0`).map((p) => [p.txid, p.at]), [[d.txid, at]], 'the same payment: its first time');
  const d2 = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(COIN / 2n) }], feePerKb: 1000n });
  await item.keepConflicts(d2.txid, d2.hex);
  assert.deepEqual(item.conflictPays(`${c1}:0`).map((p) => p.txid), [d.txid, d2.txid], 'a retry of it is kept as well');
  const stored = (await w.store.get('w/t/conflicts'))[`${c1}:0`];
  assert.equal(stored.txid, d2.txid, 'the newest at the top, as 0.1.13 reads it');
  assert.ok(Date.now() - stored.at < 3600 * 1000);
  // Long after (72 hours): expired, and a payment let go of then is kept anew.
  const later = Date.now() + 72 * 3600 * 1000;
  assert.equal(item.conflictCoins(later).size, 0);
  const real = Date.now;
  Date.now = () => later;
  try {
    await item.keepConflicts(d.txid, d.hex);
    assert.ok(item.conflictCoins(later).has(`${c1}:0`), 'kept anew');
  } finally {
    Date.now = real;
  }
  await w.backend.close();
});

test('K-1: of two payments let go of from one coin, the retry that went out is found and shown as sent', async () => {
  const w = world();
  const c1 = fund(w.chain, A1.address, 3n * COIN, 20);
  fund(w.chain, A1.address, 3n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  const item = w.backend.transparent;
  const first = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(3n * COIN - 900n) }], feePerKb: 1000n });
  await item.keepConflicts(first.txid, first.hex);
  const retry = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(3n * COIN - 1200n) }], feePerKb: 1000n });
  await item.keepConflicts(retry.txid, retry.hex, { to: OTHER.address });
  // The retry went out after all and is mined; the first never did.
  w.chain.addTx(retry.hex, 0);
  w.chain.confirm(retry.txid);
  for (let i = 0; i < 4; i++) await w.mine();
  const e = w.backend.getState().txs.find((x) => x.txid === retry.txid);
  assert.ok(e, 'in Activity');
  assert.equal(e.direction, 'out');
  assert.equal(e.counterparty, OTHER.address);
  assert.equal(pub(w.backend).available, String(3n * COIN));
  await w.backend.close();
});

test('N-5: a history the device failed to store is written by the next sync, its status only after it', async () => {
  const raw = createMemoryStore();
  const copying = { get: async (k) => { const v = await raw.get(k); return v === undefined ? v : structuredClone(v); }, put: (k, v) => raw.put(k, structuredClone(v)), del: (k) => raw.del(k), keys: (p) => raw.keys(p) };
  let arm = false;
  const store = { ...copying, put: async (k, v) => { if (arm && (k === 'w/t/hist' || k === 'w/t/unspent')) { arm = false; throw new Error('QuotaExceededError (test)'); } return copying.put(k, v); } };
  const chain = new FakeChain();
  const w = world({ store, chain });
  fund(chain, A0.address, 3n * COIN, 20);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await w.backend.waitForSync();
  fund(chain, A0.address, 2n * COIN, 2);
  arm = true;
  await w.tell(A0.address);
  await w.backend.waitForSync();
  await w.mine();
  await w.backend.close();
  const again = world({ store: copying, chain });
  await again.backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await again.backend.waitForSync();
  await again.mine();
  assert.equal(pub(again.backend).available, String(5n * COIN));
  await again.backend.close();
});

test('N-6: a node naming our ordinary address as the input of a payment to us cannot make it "sent to ourselves"', async () => {
  const { transparentEntries } = await import('../../src/lib/firo/history.js');
  const w = world();
  const t = fund(w.chain, A0.address, 3n * COIN, 20);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const item = w.backend.transparent;
  const rec = item.txs.get(t);
  const lied = new Map([[t, { ...rec, inputs: [{ valueSat: 300002000, address: A0.address }] }]]);
  const e = transparentEntries({ net: MAIN, records: lied, isOwnScript: (s) => item.isOwnScript(s), isBigScript: (s) => item.isBigScript(s), tipHeight: w.chain.height }).get(t);
  assert.equal(e.direction, 'in');
  assert.equal(e.amount, 3n * COIN);
  await w.backend.close();
});

// The third audit of 0.1.14 (M-1, M-2): a payment let go of that went out after all is shown as sent.
test('M-1: a node in use that hides the payment let go of, which it sent itself: the payment is found on the second node and shown as sent', async () => {
  const w = world();
  const c1 = fund(w.chain, A0.address, 3n * COIN, 20);
  fund(w.chain, A0.address, 2n * COIN, 20);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const gone = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(COIN) }], feePerKb: 1000n });
  await w.backend.transparent.keepConflicts(gone.txid, gone.hex, { to: OTHER.address });
  w.chain.addTx(gone.hex, 0);
  const sh0 = shOf(A0.address);
  w.patch = (m, p, r) => {
    if (m === 'blockchain.scripthash.get_history' && p[0] === sh0) return r.filter((h) => h.tx_hash !== gone.txid);
    if (m === 'blockchain.transaction.get' && p[0] === gone.txid) throw Object.assign(new Error('No such mempool or blockchain transaction.'), { code: 2 });
    return undefined;
  };
  fund(w.chain, A0.address, 1000000n, 1);
  await w.tell(A0.address);
  await w.backend.waitForSync();
  for (let i = 0; i < 2; i++) await w.mine();
  assert.ok(w.backend.transparent.pending.has(gone.txid), 'ours again, followed');
  const e = w.backend.getState().txs.find((x) => x.txid === gone.txid);
  assert.equal(e.direction, 'out');
  assert.ok(!e.dropped);
  assert.equal(pub(w.backend).available, String(2n * COIN + 1000000n), 'its coin is not counted');
  await w.backend.close();
});

test('M-2: a payment from an address the node will not list, dropped, then mined after all: sent, settled, never "did not go through"', async () => {
  const w = world();
  const c1 = fund(w.chain, A1.address, 3n * COIN, 20);
  fund(w.chain, A1.address, 3n * COIN, 20);
  w.fail = bigFail(shOf(A1.address));
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.mine();
  const d = await w.backend.buildTransparentTx({ inputs: [`${c1}:0`], outputs: [{ address: OTHER.address, amount: String(3n * COIN - 900n) }], feePerKb: 1000n });
  await w.backend.transparent.addPending({ txid: d.txid, hex: d.hex, height: w.chain.height - 10 });
  await w.mine();
  await w.mine();
  assert.equal(w.backend.transparent.pending.get(d.txid)?.dropped, true, 'given up on first');
  w.chain.addTx(d.hex, 0);
  w.chain.confirm(d.txid);
  for (let i = 0; i < 4; i++) await w.mine();
  assert.ok(!w.backend.transparent.pending.has(d.txid), 'settled');
  const e = w.backend.getState().txs.find((x) => x.txid === d.txid);
  assert.equal(e.direction, 'out');
  assert.ok(!e.dropped && e.confirmations >= 1);
  assert.equal(pub(w.backend).available, String(3n * COIN));
  await w.backend.close();
});
