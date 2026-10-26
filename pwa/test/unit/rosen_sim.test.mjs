// Rosen, simulated end to end on the FIRO side (owner: no live crossing, it costs $10 a time):
// a funded wallet on the fake Firo chain bridges 2,500 FIRO to BNB Chain through lib/rosen's
// cross() and the real engine (coin choice, signing, read-back, broadcast); the transaction the
// server receives is checked field by field and signature by signature; then a pretend Rosen
// delivers on BNB Chain and pays out on FIRO, and the trackers must recognise exactly those.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackend } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { buildSignedTransaction, decodeTx, verifyP2PKHInput, serializeTx } from '../../src/lib/firo/tx.js';
import { addressToScript } from '../../src/lib/firo/address.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { hexToBytes, bytesToHex, sha256d } from '../../src/lib/firo/bytes.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, headerHex } from '../fixtures/firo_fake_chain.mjs';
import { FakeSpark } from '../fixtures/firo_fake_spark.mjs';
import { cross, MAX_LOCK_FEE } from '../../src/lib/rosen/index.js';
import { quote, decodePayload, eventIdOfFiroLock, isEvmDelivery, isFiroPayout, LOCK, RSFIRO, TRANSFER_SELECTOR } from '../../src/lib/rosen/rosen.js';

const MAIN = NETWORKS.main;
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const R = JSON.parse(readFileSync(new URL('../fixtures/rosen_real.json', import.meta.url), 'utf8'));
const W = KEYS.vectors[0];
const OTHER = KEYS.vectors[2].addresses[0];
const URL1 = 'wss://fake.example:50004';
const SAT = 100000000n;
const BSC_DEST = '0x56fa9181b1e73d3fa296a23bce9e2fead7b04a4e';

function world() {
  const chain = new FakeChain();
  const net = new FakeNet();
  const server = net.addServer(URL1, chain.handler());
  // A second node over the same chain: a public receipt counts once two nodes agree (release re-audit R1-3).
  net.addServer('wss://fake2.example:50004', chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: 'wss://fake2.example:50004' }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 } });
  const mine = async () => {
    chain.height++;
    server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 10));
    await backend.waitForSync();
  };
  return { backend, chain, mine };
}

function fund(chain, address, value) {
  const tx = buildSignedTransaction({
    inputs: [{ txid: bytesToHex(sha256d(Uint8Array.of(chain.txs.size, 7))), vout: 0, value: value + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(address, MAIN), value }],
    locktime: chain.height - 11,
  });
  return chain.addTx(tx.hex, chain.height - 10);
}

test('FIRO -> BNB Chain: a real signed lock from this wallet, read back, broadcast; a pretend delivery is recognised', async () => {
  const { backend, chain, mine } = world();
  fund(chain, W.addresses[0].address, 1800n * SAT);
  fund(chain, W.addresses[0].address, 900n * SAT);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  await mine();
  assert.equal(backend.getState().balance.public.available, String(2700n * SAT));

  const q = ({ ...quote({ from: 'firo', to: 'bsc', amount: 2500n * SAT, firoUsd: 0.9486 }), priceAt: Date.now() });
  assert.equal(q.bridgeFee, 1250000000n); // 0.5% of 2,500: above $10
  const sent = await cross({ from: 'firo', to: 'bsc', amount: 2500n * SAT, destination: BSC_DEST, quote: q, backend });
  assert.match(sent.txid, /^[0-9a-f]{64}$/);
  assert.equal(sent.eventId, eventIdOfFiroLock(sent.txid));

  // What the server received: exactly one transaction, the lock.
  const raw = chain.broadcasts.at(-1);
  const d = decodeTx(raw, MAIN);
  assert.equal(d.txid, sent.txid);
  const lockOut = d.vout.filter((o) => o.address === LOCK.firo);
  assert.equal(lockOut.length, 1);
  assert.equal(BigInt(lockOut[0].value), 2500n * SAT);
  const p = decodePayload(d.vout.find((o) => o.type === 'nulldata').data, MAIN);
  assert.deepEqual({ to: p.to, bridgeFee: p.bridgeFee, networkFee: p.networkFee, destination: p.destination }, { to: 'bsc', bridgeFee: q.bridgeFee, networkFee: q.networkFee, destination: BSC_DEST });
  // Both coins spent (1,800 + 900 cover 2,500 + fee), each signature valid, change back to this wallet.
  assert.equal(d.vin.length, 2);
  for (let i = 0; i < d.vin.length; i++) assert.ok(verifyP2PKHInput(d, i, addressToScript(W.addresses[0].address, MAIN)), `input ${i} signature`);
  const change = d.vout.filter((o) => o.type === 'p2pkh' && o.address !== LOCK.firo);
  assert.equal(change.length, 1);
  assert.ok(W.addresses.some((a) => a.address === change[0].address) || /^a/.test(change[0].address));

  // The pretend Rosen: rsFIRO.transfer(destination, delivered) from its BNB Chain lock, event id appended.
  const delivered = 2500n * SAT - q.bridgeFee - q.networkFee;
  const word = (h) => h.padStart(64, '0');
  const delivery = { from: LOCK.bsc, to: RSFIRO.bsc, input: `0x${TRANSFER_SELECTOR}${word(BSC_DEST.slice(2))}${word(delivered.toString(16))}${eventIdOfFiroLock(sent.txid)}` };
  const want = { to: 'bsc', destination: BSC_DEST, receive: delivered, lockTxid: sent.txid };
  assert.equal(isEvmDelivery(delivery, want), true);
  assert.equal(isEvmDelivery({ ...delivery, input: delivery.input.slice(0, -2) + '00' }, want), false, 'another event id');
  assert.equal(isEvmDelivery(delivery, { ...want, lockTxid: R.firoLockToBsc.txid }), false, 'another lock');
  await backend.close();
});

test('audit P1: a quote whose FIRO price is more than ten minutes old is never signed: nothing built, nothing sent', async () => {
  let built = 0;
  const engine = { coins: { list: async () => (built++, []) }, buildTransparentTx: async () => (built++, {}) };
  const q = quote({ from: 'firo', to: 'bsc', amount: 2500n * SAT, firoUsd: 0.9486 });
  for (const priceAt of [undefined, 0, Date.now() - 10 * 60000 - 1, Date.now() + 5 * 60000]) {
    await assert.rejects(cross({ from: 'firo', to: 'bsc', amount: 2500n * SAT, destination: BSC_DEST, quote: { ...q, priceAt }, backend: engine }), (e) => e.code === 'stale' && e.beforeBroadcast === true, String(priceAt));
  }
  assert.equal(built, 0);
});

test('a lock that would not match its plan is never broadcast', async () => {
  const { backend, chain, mine } = world();
  fund(chain, W.addresses[0].address, 3000n * SAT);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  await mine();
  const q = ({ ...quote({ from: 'firo', to: 'bsc', amount: 2500n * SAT, firoUsd: 0.9486 }), priceAt: Date.now() });
  // A builder that changes the lock amount behind the planner's back.
  const real = backend.buildTransparentTx.bind(backend);
  backend.buildTransparentTx = async (args) => real({ ...args, outputs: [{ ...args.outputs[0], amount: String(2400n * SAT) }, args.outputs[1]] });
  const before = chain.broadcasts.length;
  await assert.rejects(cross({ from: 'firo', to: 'bsc', amount: 2500n * SAT, destination: BSC_DEST, quote: q, backend }), (e) => e.code === 'mismatch' && /amount to Rosen/.test(e.message) && e.beforeBroadcast === true);
  assert.equal(chain.broadcasts.length, before, 'nothing reached the server');
  // Not enough public FIRO: said in words, nothing sent.
  backend.buildTransparentTx = real;
  await assert.rejects(cross({ from: 'firo', to: 'bsc', amount: 5000n * SAT, destination: BSC_DEST, quote: { priceAt: Date.now(), ...quote({ from: 'firo', to: 'bsc', amount: 5000n * SAT, firoUsd: 0.9486 }) }, backend }), (e) => e.code === 'amount' && /public balance/.test(e.message));
  await backend.close();
});

test('chain -> FIRO: a pretend Rosen payout from its FIRO lock key is recognised; another key is not', () => {
  // The lock's real signature script (its public key) from Rosen's real payout, on a payout to us.
  const realPayout = decodeTx(R.ethExitToFiro.firoPayout.hex, MAIN);
  const lockIn = realPayout.vin[0];
  const dest = W.addresses[0].address;
  const receive = 2984n * SAT;
  const fake = (vin) => serializeTx({ versionRaw: 1, vin, vout: [{ value: receive + 450n, script: addressToScript(dest, MAIN) }], locktime: 0, extraPayload: new Uint8Array(0) });
  assert.equal(isFiroPayout(bytesToHex(fake([{ prevHash: new Uint8Array(32), vout: 0, scriptSig: lockIn.scriptSig, sequence: 0xffffffff }])), { destination: dest, receive }, MAIN), true);
  const other = decodeTx(R.firoLockToBsc.hex, MAIN).vin[0];
  assert.equal(isFiroPayout(bytesToHex(fake([{ prevHash: new Uint8Array(32), vout: 0, scriptSig: other.scriptSig, sequence: 0xffffffff }])), { destination: dest, receive }, MAIN), false);
});

test('a server asking an absurd fee rate: the wallet pays its ceiling, and a lock above 0.01 FIRO of fee is never broadcast', async () => {
  const { backend, chain, mine } = world();
  fund(chain, W.addresses[0].address, 3000n * SAT);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  await mine();
  // The audit's case (D-03): the server says 20 FIRO/kB.
  chain.feeRate = 20;
  const rates = await backend.estimateFeeRate();
  assert.equal(rates.normal, String(MAIN.maxFeePerKb), 'capped at 0.001 FIRO/kB');
  const q = ({ ...quote({ from: 'firo', to: 'bsc', amount: 2500n * SAT, firoUsd: 0.9486 }), priceAt: Date.now() });
  const sent = await cross({ from: 'firo', to: 'bsc', amount: 2500n * SAT, destination: BSC_DEST, quote: q, backend });
  const d = decodeTx(chain.broadcasts.at(-1), MAIN);
  assert.equal(d.txid, sent.txid);
  const fee = 3000n * SAT - d.vout.reduce((s, o) => s + o.value, 0n);
  // The lock is about 275 bytes: at the ceiling that is 27,500 sat (0.000275 FIRO), not 5.5 FIRO.
  assert.ok(fee > 0n && fee <= 30000n, `fee ${fee} within the ceiling`);
  assert.ok(fee < MAX_LOCK_FEE);
  // The lock's coin is spent from the moment it was broadcast (audit FM-1): a fresh one for the rest.
  assert.equal((await backend.coins.list()).filter((c) => c.kind === 'transparent' && c.spendable).length, 0);
  fund(chain, W.addresses[0].address, 3000n * SAT);
  await mine();
  // An explicit absurd rate is refused outright.
  const coin = (await backend.coins.list()).find((c) => c.kind === 'transparent' && c.spendable);
  await assert.rejects(backend.buildTransparentTx({ inputs: [coin.id], outputs: [{ address: OTHER.address, amount: String(SAT) }], feePerKb: 20n * SAT }), (e) => e.code === 'invalid-amount' && /far above/.test(e.message));
  // A builder that somehow pays 0.02 FIRO of fee: refused before broadcast.
  const real = backend.buildTransparentTx.bind(backend);
  backend.buildTransparentTx = async (args) => ({ ...(await real(args)), fee: '2000000' });
  const before = chain.broadcasts.length;
  await assert.rejects(cross({ from: 'firo', to: 'bsc', amount: 2500n * SAT, destination: BSC_DEST, quote: q, backend }), (e) => e.code === 'fee' && /far above normal/.test(e.message));
  assert.equal(chain.broadcasts.length, before, 'nothing reached the server');
  await backend.close();
});

test('FM-1: a lock broadcast that got no answer is "unsure" with the lock\'s txid; never reaching a node, or a node\'s refusal, is passed on as it was', async () => {
  const { backend, chain, mine } = world();
  fund(chain, W.addresses[0].address, 3000n * SAT);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  await mine();
  const q = ({ ...quote({ from: 'firo', to: 'bsc', amount: 2500n * SAT, firoUsd: 0.9486 }), priceAt: Date.now() });
  const real = backend.broadcastTx.bind(backend);
  let sentHex = null;
  // Written to the node, then no answer (an engine error that did not name the transaction).
  backend.broadcastTx = async (hex) => {
    sentHex = hex;
    throw Object.assign(new Error('The Firo node did not answer.'), { code: 'unsure' });
  };
  await assert.rejects(cross({ from: 'firo', to: 'bsc', amount: 2500n * SAT, destination: BSC_DEST, quote: q, backend }), (e) => e.code === 'unsure' && e.txid === decodeTx(sentHex, MAIN).txid && !e.beforeBroadcast);
  for (const code of ['offline', 'server']) {
    backend.broadcastTx = async () => {
      throw Object.assign(new Error(`words for ${code}`), { code });
    };
    await assert.rejects(cross({ from: 'firo', to: 'bsc', amount: 2500n * SAT, destination: BSC_DEST, quote: q, backend }), (e) => e.code === code && !e.txid);
  }
  backend.broadcastTx = real;
  await backend.close();
});
