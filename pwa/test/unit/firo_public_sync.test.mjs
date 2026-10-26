// The public balance follows the chain after a question that failed (owner, 2026-10-25: "Firo PWA
// syncs the public balance incorrectly"). An address's status was written down before its history
// was fetched: when that fetch failed (a dropped connection, a timeout), the next sync saw the
// status unchanged and never asked again, so the payment stayed missing until the address changed
// once more. Likewise for addresses first watched when a later one was paid, already holding coins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackend } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { buildSignedTransaction } from '../../src/lib/firo/tx.js';
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
    return base(method, params, socket);
  });
  net.addServer(URL2, chain.handler());
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

test('a history fetch that fails during a sync is asked again at the next one', async () => {
  const w = world();
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  assert.equal(pub(w.backend).available, String(3n * COIN));

  // A second payment to the same address; the node times out on the history question once.
  fund(w.chain, W.addresses[0].address, 2n * COIN, 1);
  let failed = 0;
  w.fail = (m) => m === 'blockchain.scripthash.get_history' && failed++ === 0;
  await w.mine();
  assert.equal(failed > 0, true, 'the failure happened');
  w.fail = () => false;
  await w.mine();
  await w.mine();
  assert.equal(pub(w.backend).available, String(5n * COIN), 'both payments counted');
  await w.backend.close();
});

test('a status notification whose history fetch fails is asked again at the next sync', async () => {
  const w = world();
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();

  fund(w.chain, W.addresses[0].address, 2n * COIN, 1);
  w.fail = (m) => m === 'blockchain.scripthash.get_history';
  await w.tell(W.addresses[0].address);
  w.fail = () => false;
  await w.mine();
  await w.mine();
  assert.equal(pub(w.backend).available, String(5n * COIN), 'the payment the notification was about');
  await w.backend.close();
});

test('addresses first watched when a later one is paid, already holding coins, are counted', async () => {
  const w = world();
  // The same words used in another wallet: coins on receive addresses 0, 20 and 25.
  const keys = await FiroKeys.fromMnemonic(W.mnemonic, '', MAIN);
  const at = (i) => keys.address(0, i).address;
  fund(w.chain, at(0), COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  assert.equal(pub(w.backend).available, String(COIN));

  // Index 25 was paid first (beyond the 20 watched), then 20 (watched): the notification for 20
  // brings 21..40 under watch, 25 among them, already paid.
  fund(w.chain, at(25), 4n * COIN, 2);
  fund(w.chain, at(20), 2n * COIN, 2);
  await w.tell(at(20));
  await w.mine();
  await w.mine();
  assert.equal(pub(w.backend).available, String(7n * COIN), 'address 25 too');
  await w.backend.close();
});

test('a wallet left by 0.1.12 with a status and no history behind it heals once updated', async () => {
  const w = world();
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  await w.backend.close();
  // As 0.1.12 could leave it: the status of a payment written down, its history never fetched.
  const t2 = fund(w.chain, W.addresses[0].address, 2n * COIN, 3);
  const sh = scriptHash(addressToScript(W.addresses[0].address, MAIN));
  const addr = await w.store.get('w/t/addr');
  delete addr.statusV;
  addr.status[sh] = w.chain.status(sh);
  await w.store.put('w/t/addr', addr);
  assert.equal((await w.store.get('w/t/hist'))[sh].some((h) => h.tx_hash === t2), false);

  const again = world({ store: w.store, chain: w.chain });
  await again.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await again.backend.waitForSync();
  assert.equal(pub(again.backend).available, String(5n * COIN));
  assert.equal((await w.store.get('w/t/addr')).statusV, 3);
  await again.backend.close();
});

test('a history the device fails to store leaves the status as it was: after a reload the payment is fetched', async () => {
  const inner = createMemoryStore();
  let failHist = false;
  // As IndexedDB: a copy is stored, not the live object.
  const store = {
    get: async (k) => structuredClone(await inner.get(k)),
    keys: (p) => inner.keys(p),
    del: (k) => inner.del(k),
    put: async (k, v) => {
      if (failHist && k === 'w/t/hist') throw new Error('quota (test)');
      return inner.put(k, structuredClone(v));
    },
  };
  const w = world({ store });
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  fund(w.chain, W.addresses[0].address, 2n * COIN, 1);
  failHist = true;
  await w.tell(W.addresses[0].address);
  failHist = false;
  const sh = scriptHash(addressToScript(W.addresses[0].address, MAIN));
  assert.notEqual((await inner.get('w/t/addr')).status[sh], w.chain.status(sh), 'the new status is not written');
  await w.backend.close();

  const again = world({ store, chain: w.chain });
  await again.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await again.backend.waitForSync();
  await again.mine();
  assert.equal(pub(again.backend).available, String(5n * COIN));
  await again.backend.close();
});

test('a Rescan keeps the person\'s choices: a frozen coin stays frozen', async () => {
  const w = world();
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const coins = await w.backend.coins.list();
  await w.backend.coins.freeze(coins[0].id, true);
  assert.equal(pub(w.backend).available, '0');
  await w.backend.rescan();
  await w.backend.waitForSync();
  await w.mine();
  assert.equal(pub(w.backend).available, '0', 'still frozen');
  assert.equal((await w.backend.coins.list())[0].frozen, true);
  await w.backend.close();
});

test('an address the node refuses for good stops nothing else: the other payments are counted and proven', async () => {
  const w = world();
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  fund(w.chain, W.addresses[1].address, 1n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  assert.equal(pub(w.backend).available, String(4n * COIN));
  const shBig = scriptHash(addressToScript(W.addresses[1].address, MAIN));
  // A node that times out on one address's history: the others are brought up to date.
  fund(w.chain, W.addresses[1].address, 1n * COIN, 1);
  w.fail = (m, p) => (m === 'blockchain.scripthash.get_history' || m === 'blockchain.scripthash.subscribe') && p[0] === shBig;
  fund(w.chain, W.addresses[0].address, 2n * COIN, 1);
  await w.mine();
  await w.mine();
  assert.equal(pub(w.backend).available, String(6n * COIN), 'address 0 brought up to date; address 1 as it was');
  // Not up to date: sending waits (as when a whole sync failed), and it is not called offline.
  const raw = w.backend.getState();
  assert.ok(raw.sync.partial > 0);
  const a = assessSync({ raw, everConnected: true, now: Math.floor(Date.now() / 1000) });
  assert.equal(a.state, 'syncing');
  assert.equal(a.canSend, false);
  // The node answers again: the address is asked about again.
  w.fail = () => false;
  await w.mine();
  assert.equal(pub(w.backend).available, String(7n * COIN));
  assert.equal(w.backend.getState().sync.partial, undefined);
  await w.backend.close();
});

test('choosing another node keeps the public balance shown while it connects', async () => {
  const w = world();
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  const seen = [];
  w.backend.subscribe((s) => seen.push(s.balance.public.available));
  await w.backend.setServers([URL2, URL1]);
  await w.backend.waitForSync();
  assert.ok(seen.length > 0);
  assert.deepEqual([...new Set(seen)], [String(3n * COIN)], 'never 0 meanwhile');
  await w.backend.close();
});

test('a sync that failed is tried again within seconds, not at the next block', async () => {
  const w = world();
  fund(w.chain, W.addresses[0].address, 3n * COIN);
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  fund(w.chain, W.addresses[0].address, 2n * COIN, 1);
  let failed = 0;
  w.fail = (m) => m === 'blockchain.scripthash.get_history' && failed++ === 0;
  await w.mine();
  assert.equal(pub(w.backend).available, String(3n * COIN), 'not answered yet');
  // No new block: the retry (5 s) brings it.
  const until = Date.now() + 9000;
  while (pub(w.backend).available !== String(5n * COIN) && Date.now() < until) await w.settle();
  assert.equal(pub(w.backend).available, String(5n * COIN));
  await w.backend.close();
});

test('a private part that keeps failing is asked again less and less often, not every 5 s', async () => {
  const w = world();
  await w.backend.open({ mnemonic: W.mnemonic, birthdayHeight: w.chain.height });
  await w.backend.waitForSync();
  let sparkCalls = 0;
  w.fail = (m) => {
    if (!m.startsWith('spark.')) return false;
    sparkCalls++;
    return true;
  };
  await w.mine();
  const at = sparkCalls;
  // 5 s, then 10 s: within 12 s at most two more tries (every 5 s would make three).
  const until = Date.now() + 12000;
  while (Date.now() < until) await w.settle();
  assert.ok(w.backend._retry.n >= 2, `backed off (n = ${w.backend._retry.n})`);
  assert.ok(sparkCalls - at <= 2, `${sparkCalls - at} tries`);
  await w.backend.close();
});
