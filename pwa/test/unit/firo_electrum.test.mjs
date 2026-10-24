// The ElectrumX client: offline against a fake WebSocket server (handshake
// order, batching, timeouts, failover, reconnect and re-subscription), then a
// few read-only live calls to Firo's own wss servers, skipped when offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ElectrumClient, ElectrumError, coinPerKbToSat } from '../../src/lib/firo/electrum.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { FakeNet, electrumHandler } from '../fixtures/firo_fake_ws.mjs';
import { decodeTx } from '../../src/lib/firo/tx.js';

const A = 'wss://a.example:50004';
const B = 'wss://b.example:50004';
const SH = 'ab'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(5);
  }
};
const client = (net, servers, o = {}) => new ElectrumClient({ servers, WebSocket: net.WebSocket, pingIntervalMs: 0, backoffInitialMs: 10, backoffMaxMs: 40, timeoutMs: 500, connectTimeoutMs: 300, random: () => 0.5, ...o });

test('server.version goes first, and requests made before the connection wait for it', async () => {
  const net = new FakeNet();
  const s = net.addServer(A, electrumHandler({ 'blockchain.relayfee': 1e-5 }));
  const c = client(net, [A]);
  const p = c.relayFee(); // before connect()
  await c.connect();
  assert.equal(await p, 1000n);
  assert.deepEqual(s.methods().slice(0, 2), ['server.version', 'blockchain.relayfee']);
  assert.deepEqual(s.calls[0].params, ['Campfire', '1.4']);
  assert.equal(c.server, A);
  assert.deepEqual(c.serverVersion, ['ElectrumX 1.19.0', '1.4']);
  c.close();
});

test('a batch is one message and comes back in order, each failure in its place', async () => {
  const net = new FakeNet();
  const s = net.addServer(
    A,
    electrumHandler({
      echo: (p) => p[0],
      boom: () => {
        throw Object.assign(new Error('nope'), { code: 7 });
      },
    }),
  );
  const c = client(net, [A], { maxBatch: 3 });
  await c.connect();
  const before = s.messages;
  const r = await c.batch([['echo', [1]], ['boom', []], ['echo', [3]], ['echo', [4]]]);
  assert.equal(s.messages - before, 2); // 3 + 1
  assert.equal(r[0], 1);
  assert.ok(r[1] instanceof ElectrumError);
  assert.equal(r[1].code, 'server');
  assert.equal(r[1].rpcCode, 7);
  assert.equal(r[1].message, 'nope');
  assert.deepEqual([r[2], r[3]], [3, 4]);
  c.close();
});

test('a batch whose connection is closed part way ends at once: the rest are "closed", never sent or waited for', async () => {
  const net = new FakeNet();
  const s = net.addServer(A, electrumHandler({ slow: FakeNet.NO_ANSWER, echo: (p) => p[0] }));
  // A Lock while a set's blocks were being read: the parts after it each waited out their timeout
  // (30 s), so a wallet took many minutes to lock, and its sync (and Rescan) waited behind it.
  const c = client(net, [A], { maxBatch: 2, timeoutMs: 60000 });
  await c.connect();
  const before = s.messages;
  const t0 = Date.now();
  const pending = c.batch([['slow', []], ['slow', []], ['echo', [3]], ['echo', [4]], ['echo', [5]]]);
  await new Promise((r) => setTimeout(r, 20));
  c.close();
  const r = await pending;
  assert.ok(Date.now() - t0 < 2000, 'no part waits for its timeout');
  assert.equal(s.messages - before, 1, 'only the part sent before the close');
  assert.equal(r.length, 5);
  for (const x of r) assert.ok(x instanceof ElectrumError && x.code === 'closed', String(x));
  await assert.rejects(c.batch([['echo', [1]]]), (e) => e.code === 'closed');
});

test('a request with no answer times out; the connection stays', async () => {
  const net = new FakeNet();
  net.addServer(A, electrumHandler({ slow: FakeNet.NO_ANSWER, echo: (p) => p[0] }));
  const c = client(net, [A], { timeoutMs: 50 });
  await c.connect();
  await assert.rejects(c.request('slow'), (e) => e.code === 'timeout');
  assert.equal(await c.request('echo', ['still here']), 'still here');
  c.close();
});

test('failover: a refused server, a silent one and one that rejects the handshake are skipped', async () => {
  const net = new FakeNet();
  net.addServer('wss://refuse.example', () => null, { refuse: true });
  net.addServer('wss://silent.example', () => null, { silent: true });
  net.addServer('wss://old.example', (m) => {
    if (m === 'server.version') throw new Error('unsupported protocol version');
    return null;
  });
  net.addServer(B, electrumHandler());
  const c = client(net, ['wss://refuse.example', 'wss://silent.example', 'wss://old.example', B], { connectTimeoutMs: 60 });
  await c.connect();
  assert.equal(c.server, B);
  c.close();
});

test('no server at all: connect() rejects "offline"', async () => {
  const net = new FakeNet();
  const c = client(net, [A, B], { reconnect: false });
  await assert.rejects(c.connect(), (e) => e instanceof ElectrumError && e.code === 'offline' && /No Firo node/.test(e.message));
  c.close();
});

test('notifications reach listeners; a dropped server is replaced and subscriptions renewed', async () => {
  const net = new FakeNet();
  const handler = electrumHandler({ 'blockchain.scripthash.subscribe': (p) => (p[0] === SH ? 'status1' : null), slow: FakeNet.NO_ANSWER });
  const a = net.addServer(A, handler);
  const b = net.addServer(B, handler);
  const c = client(net, [A, B]);
  const statuses = [];
  const headers = [];
  const shs = [];
  c.on('status', (s) => statuses.push(s));
  c.on('header', (h) => headers.push(h.height));
  c.on('scripthash', (sh, st) => shs.push([sh, st]));
  await c.connect();
  assert.equal((await c.subscribeHeaders()).height, 1000);
  assert.equal(await c.subscribeScripthash(SH), 'status1');
  a.notify('blockchain.headers.subscribe', [{ height: 1001, hex: '00' }]);
  a.notify('blockchain.scripthash.subscribe', [SH, 'status2']);
  a.notify('blockchain.scripthash.subscribe', ['cd'.repeat(32), 'not ours']);
  await until(() => shs.length === 1 && headers.includes(1001));
  assert.deepEqual(shs[0], [SH, 'status2']);

  const pending = c.request('slow');
  a.dropAll();
  await assert.rejects(pending, (e) => e.code === 'offline');
  await until(() => c.connected && c.server === B);
  // Both subscriptions were sent again to the new server.
  await until(() => b.methods().includes('blockchain.scripthash.subscribe') && b.methods().includes('blockchain.headers.subscribe'));
  await until(() => shs.length === 2);
  assert.deepEqual(shs[1], [SH, 'status1']);
  assert.deepEqual(
    statuses.map((s) => [s.connected, s.server]),
    [
      [true, A],
      [false, null],
      [true, B],
    ],
  );
  c.close();
  assert.equal(statuses.at(-1).connected, false);
});

test('a ping that is not answered drops the server', async () => {
  const net = new FakeNet();
  let pings = 0;
  net.addServer(A, (m) => {
    if (m === 'server.version') return ['ElectrumX 1.19.0', '1.4'];
    if (m === 'server.ping') {
      pings++;
      return FakeNet.NO_ANSWER;
    }
    return null;
  });
  net.addServer(B, electrumHandler());
  const c = client(net, [A, B], { pingIntervalMs: 20, timeoutMs: 30 });
  await c.connect();
  assert.equal(c.server, A);
  await until(() => c.server === B, 3000);
  assert.ok(pings >= 1);
  c.close();
});

test('close() fails what is pending with "closed" and stays closed', async () => {
  const net = new FakeNet();
  const s = net.addServer(A, electrumHandler({ slow: FakeNet.NO_ANSWER }));
  const c = client(net, [A]);
  await c.connect();
  const p = c.request('slow');
  c.close();
  await assert.rejects(p, (e) => e.code === 'closed');
  await assert.rejects(c.request('server.ping'), (e) => e.code === 'closed');
  await sleep(60);
  assert.equal(s.sockets.size, 0);
  assert.equal(c.connected, false);
});

// Audit FM-1: a broadcast the caller was told had failed still left on the next handshake, and one
// written before the connection dropped looked exactly like one never written.
test('a broadcast is never queued for a later connection: refused at once, unwritten, and never sent later', async () => {
  const net = new FakeNet();
  const s = net.addServer(A, electrumHandler({ 'blockchain.transaction.broadcast': () => 'ab'.repeat(32) }), { silent: true });
  const c = client(net, [A], { timeoutMs: 40, connectTimeoutMs: 150 });
  try {
    const err = await c.broadcast('0100000001deadbeef').catch((e) => e);
    assert.ok(err instanceof ElectrumError, String(err));
    assert.equal(err.code, 'offline');
    assert.equal(err.written, false, 'nothing reached a socket');
    // The node comes up afterwards: the transaction does not leave behind the caller's back.
    s.silent = false;
    await until(() => c.connected, 3000);
    await sleep(20);
    assert.equal(s.methods().includes('blockchain.transaction.broadcast'), false);
  } finally {
    c.close();
  }
});

test('a queued request whose time ran out is dropped from the queue, never written later', async () => {
  const net = new FakeNet();
  const s = net.addServer(A, electrumHandler({ echo: (p) => p[0] }), { silent: true });
  const c = client(net, [A], { timeoutMs: 40, connectTimeoutMs: 150 });
  try {
    const err = await c.request('echo', ['late']).catch((e) => e);
    assert.equal(err.code, 'timeout');
    assert.equal(err.written, false);
    s.silent = false;
    await until(() => c.connected, 3000);
    await sleep(20);
    assert.equal(s.methods().includes('echo'), false, 'the late request was not sent');
  } finally {
    c.close();
  }
});

test('a broadcast written, then no answer: lost connection and time-out both say it was written', async () => {
  const net = new FakeNet();
  let mode = 'drop';
  net.addServer(
    A,
    electrumHandler({
      'blockchain.transaction.broadcast': (p, socket) => {
        if (mode === 'drop') queueMicrotask(() => socket.close());
        return FakeNet.NO_ANSWER;
      },
    }),
  );
  const c = client(net, [A], { timeoutMs: 60 });
  try {
    await c.connect();
    const lost = await c.broadcast('0100000001deadbeef').catch((e) => e);
    assert.equal(lost.code, 'offline');
    assert.equal(lost.written, true, 'the bytes reached the node: it may have relayed them');
    mode = 'silent';
    await until(() => c.connected, 3000);
    const late = await c.broadcast('0100000001deadbeef').catch((e) => e);
    assert.equal(late.code, 'timeout');
    assert.equal(late.written, true);
  } finally {
    c.close();
  }
});

test('typed calls check what comes back', async () => {
  const net = new FakeNet();
  net.addServer(
    A,
    electrumHandler({
      'blockchain.scripthash.get_history': (p) => (p[0] === SH ? [{ tx_hash: 'ff'.repeat(32), height: 5 }] : [{ tx_hash: 'zz', height: 1 }]),
      'blockchain.scripthash.listunspent': [{ tx_hash: 'ee'.repeat(32), tx_pos: 1, height: 0, value: 1500 }],
      'blockchain.estimatefee': (p) => (p[0] === 2 ? 1.008e-5 : -1),
      'spark.getsparklatestcoinid': 11,
      'spark.getsparkanonymitysetmeta': (p) => ({ blockHash: 'AA==', setHash: 'BB==', size: Number(p[0]) }),
      'spark.getsparkanonymitysetsector': (p) => ({ coins: [[p[0], p[1], p[2] + '-' + p[3]]] }),
      'spark.getusedcoinstagstxhashes': (p) => ({ tagsandtxids: [['t' + p[0], 'x']] }),
      // As firod: each name's expiry block, and its note when it has one; an older list without either.
      'spark.getsparknames': [{ name: 'a', address: 'sm1a', validUntil: 1500000, additionalInfo: 'hi' }, { name: 'b', address: 'sm1b', validUntil: 1600000 }, { name: 'c', address: 'sm1c' }, { name: 7, address: 'x' }],
      'blockchain.transaction.broadcast': () => 'rejected: dust',
    }),
  );
  const c = client(net, [A]);
  await c.connect();
  assert.deepEqual(await c.getHistory(SH), [{ tx_hash: 'ff'.repeat(32), height: 5 }]);
  await assert.rejects(c.getHistory('cd'.repeat(32)), (e) => e.code === 'bad_response');
  await assert.rejects(c.getHistory('nothex'), /script hash/);
  assert.equal((await c.listUnspent(SH))[0].value, 1500);
  assert.equal(await c.estimateFee(2), 1008n);
  assert.equal(await c.estimateFee(25), null);
  assert.equal(await c.sparkLatestCoinId(), 11);
  // Numbers go to firod as strings.
  assert.equal((await c.sparkSetMeta(4)).size, 4);
  assert.deepEqual(await c.sparkSetSector(3, 'AA==', 0, 1500), [['3', 'AA==', '0-1500']]);
  assert.deepEqual(await c.sparkUsedTags(240000), [['t240000', 'x']]);
  // Names: expiry and note kept from the full list (audit D-10); none listed with an expiry = none; no expiry = unknown.
  assert.deepEqual(await c.sparkNames(), [
    { name: 'a', address: 'sm1a', validUntil: 1500000, additionalInfo: 'hi' },
    { name: 'b', address: 'sm1b', validUntil: 1600000, additionalInfo: '' },
    { name: 'c', address: 'sm1c', validUntil: null, additionalInfo: null },
  ]);
  await assert.rejects(c.broadcast('00'), (e) => e.code === 'server' && /dust/.test(e.message));
  c.close();
});

test('coin-per-kB floats become exact satoshi', () => {
  assert.equal(coinPerKbToSat(1e-5), 1000n);
  assert.equal(coinPerKbToSat(1.008e-5), 1008n);
  assert.equal(coinPerKbToSat(0.0002), 20000n);
  assert.equal(coinPerKbToSat(1.5), 150000000n);
  assert.equal(coinPerKbToSat(-1), null);
  assert.equal(coinPerKbToSat('1'), null);
});

// ---------------------------------------------------------------- live (read-only)

async function liveClient() {
  if (process.env.FIRO_OFFLINE) return null;
  if (typeof globalThis.WebSocket !== 'function') return null;
  const c = new ElectrumClient({ servers: NETWORKS.main.servers, reconnect: false, timeoutMs: 20000, connectTimeoutMs: 8000, pingIntervalMs: 0 });
  try {
    await c.connect();
    return c;
  } catch {
    c.close();
    return null;
  }
}

test('live: Firo mainnet over wss (read-only; skipped when offline)', async (t) => {
  const c = await liveClient();
  if (!c) {
    t.skip('no Firo ElectrumX server reachable');
    return;
  }
  try {
    assert.match(c.serverVersion[0], /ElectrumX/);
    const tip = await c.subscribeHeaders();
    assert.ok(tip.height > 1393000, `tip ${tip.height}`);
    // Firo headers since FiroPoW are 120 bytes; the time is at offset 68.
    assert.equal(tip.hex.length, 240);
    assert.ok((await c.sparkLatestCoinId()) >= 11);
    assert.equal(await c.relayFee(), 1000n);
    // The server's estimate may be under the relay fee (seen 2026-10-15): the wallet never pays under
    // it (transparent.js feeRates raises it to the floor), so only its shape is checked here.
    const fee = await c.estimateFee(2);
    assert.ok(fee === null || (typeof fee === 'bigint' && fee > 0n), `estimate ${fee}`);
    // An address nobody uses has no history (cheap to ask).
    assert.deepEqual(await c.getHistory('00'.repeat(32)), []);
    // A fixed block's coinbase: id_from_pos, then the transaction hashes back to its id.
    const txid = await c.txidFromPos(1393000, 0);
    assert.equal(txid, '7fe865cc9c6db9623965430658281ad0c3f516de025a0b4b00162961764e5e11');
    const raw = await c.getTransaction(txid);
    assert.equal(decodeTx(raw).txid, txid);
    const meta = await c.sparkSetMeta(11);
    assert.ok(meta.size > 0 && meta.blockHash.length === 44);
    const two = await c.sparkSetSector(11, meta.blockHash, 0, 2);
    assert.equal(two.length, 2);
  } finally {
    c.close();
  }
});

test('live: Firo testnet over wss (read-only; skipped when offline)', async (t) => {
  if (process.env.FIRO_OFFLINE || typeof globalThis.WebSocket !== 'function') return t.skip('offline');
  const c = new ElectrumClient({ servers: NETWORKS.test.servers, reconnect: false, timeoutMs: 20000, connectTimeoutMs: 8000, pingIntervalMs: 0 });
  try {
    await c.connect();
  } catch {
    c.close();
    return t.skip('no Firo testnet server reachable');
  }
  try {
    const f = await c.request('server.features');
    assert.equal(f.genesis_hash, NETWORKS.test.genesisHash);
    assert.ok((await c.subscribeHeaders()).height > NETWORKS.test.sparkChaumV2StartBlock);
    assert.ok((await c.sparkLatestCoinId()) >= 1);
  } finally {
    c.close();
  }
});
