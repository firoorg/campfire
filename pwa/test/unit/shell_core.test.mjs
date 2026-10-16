// The shell's own core: sync honesty (lib/sync.js), the sealed recovery words (lib/seed_vault.js),
// the encrypted backup file (lib/backup_file.js), the own-server address and its CSP
// (lib/server_address.js, lib/servers.js), and lib/wallet.js turning the engine's satoshi strings
// into what the screens read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSync, syncPercent, ageText, serverHost, RULES } from '../../src/lib/sync.js';
import { sealSeed, openSeed, SEED_INFO } from '../../src/lib/seed_vault.js';
import { makeBackup, openBackup, readBackupHeader, backupFileName, BACKUP_MAX_BYTES } from '../../src/lib/backup_file.js';
import { newDbPassword, PBKDF2_MIN_ITERATIONS } from '../../src/lib/envelope.js';
import { normalizeServerAddress, cspWithServer, serverOrigin } from '../../src/lib/server_address.js';
import { FIRO_SERVERS, serversFor, serverWords, isOwnServer, FIRO_POOL } from '../../src/lib/servers.js';
import { Wallet, mapTx, txTitle, txSign, txSide, isPendingTx } from '../../src/lib/wallet.js';
import { memoryStore, useEngine } from '../../src/lib/chain.js';
import '../../src/lib/backend_fake.js';

useEngine('fake');

const now = 1_800_000_000;
const raw = (over = {}) => ({ network: 'main', connected: true, server: 'wss://electrumx01.firo.org:50004', tip: { height: 1393000, time: now - 40 }, sync: { phase: 'done', done: 1, total: 1 }, balance: {}, txs: [], receive: {}, viewOnly: false, ...over });

test('sync: synced needs a connection, the phase done and a fresh tip; it names the block and the server', () => {
  const s = assessSync({ raw: raw(), everConnected: true, now });
  assert.equal(s.state, 'synced');
  assert.equal(s.canSend, true);
  assert.match(s.detail, /Block 1,393,000, made 40 s ago \(from electrumx01\.firo\.org\)/);
  assert.equal(assessSync({ raw: raw({ viewOnly: true }), now }).canSend, false, 'a watch-only wallet never sends');
});

test('sync: connecting, syncing with a percent and words per phase, behind, offline, reconnecting', () => {
  assert.equal(assessSync({ raw: null, now }).state, 'connecting');
  assert.equal(assessSync({ raw: raw({ connected: false, sync: { phase: 'connecting', done: 0, total: 0 } }), now }).state, 'connecting');
  const sy = assessSync({ raw: raw({ sync: { phase: 'spark-sets', done: 12, total: 24 } }), now });
  assert.equal(sy.state, 'syncing');
  assert.equal(sy.canSend, false);
  assert.equal(sy.percent, 45);
  assert.match(sy.detail, /Downloading private coin sets\. Sending is paused/);
  assert.equal(syncPercent({ phase: 'transparent', done: 0, total: 10 }), 0);
  assert.equal(syncPercent({ phase: 'spark-identify', done: 10, total: 10 }), 100);
  const behind = assessSync({ raw: raw({ tip: { height: 1, time: now - RULES.maxTipAgeSec - 600 } }), now });
  assert.equal(behind.state, 'behind');
  assert.equal(behind.canSend, false);
  const off = assessSync({ raw: raw({ connected: false, sync: { phase: 'error', error: 'No Firo node answered.' } }), now });
  assert.equal(off.state, 'offline');
  assert.match(off.detail, /No Firo node answered\. Sending is paused/);
  assert.equal(assessSync({ raw: raw({ connected: false }), everConnected: true, lostAt: now - 5, now }).reconnecting, true);
  assert.equal(assessSync({ raw: raw({ connected: false }), everConnected: true, lostAt: now - 60, now }).state, 'offline');
  assert.equal(ageText(3 * 3600), '3 h ago');
  assert.equal(serverHost('wss://electrumx.firo.org:50004'), 'electrumx.firo.org');
});

test('seed vault: the words come back only with the wallet\'s secret and id; an edit or a move is refused', async () => {
  const dbPass = newDbPassword();
  const env = await sealSeed(dbPass, 'aaaaaaaaaaaaaaaa', { mnemonic: 'word '.repeat(12).trim(), passphrase: 'p' });
  assert.equal(env.kind, 'firo-seed');
  assert.ok(!JSON.stringify(env).includes('word'), 'nothing readable');
  assert.deepEqual(await openSeed(dbPass, 'aaaaaaaaaaaaaaaa', env), { mnemonic: 'word '.repeat(12).trim(), passphrase: 'p' });
  await assert.rejects(openSeed(newDbPassword(), 'aaaaaaaaaaaaaaaa', env), (e) => e.code === 'wrong_secret');
  await assert.rejects(openSeed(dbPass, 'bbbbbbbbbbbbbbbb', env), (e) => e.code === 'wrong_secret');
  await assert.rejects(openSeed(dbPass, 'aaaaaaaaaaaaaaaa', { ...env, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }), (e) => e.code === 'wrong_secret');
  await assert.rejects(openSeed('', 'aaaaaaaaaaaaaaaa', env), (e) => e.code === 'locked');
  assert.match(SEED_INFO, /campfire-firo/);
});

test('backup file (v1, PBKDF2, as 0.1.7 wrote it): still restores; an edited header (fewer rounds, another app) is refused before any guess', async () => {
  const secret = { mnemonic: 'abandon '.repeat(11) + 'about', passphrase: 'x', birthday: 1100000, name: 'Main' };
  const text = await makeBackup(secret, 'a long password 12', { kdf: 'pbkdf2', now: new Date(Date.UTC(2026, 9, 12)) });
  const f = JSON.parse(text);
  assert.equal(f.app, 'campfire-firo');
  assert.equal(f.v, 1);
  assert.equal(f.iterations, PBKDF2_MIN_ITERATIONS);
  assert.ok(!text.includes('abandon'), 'nothing readable');
  assert.deepEqual(await openBackup(text, 'a long password 12'), { ...secret, network: 'main' });
  await assert.rejects(openBackup(text, 'wrong password'), (e) => e.code === 'wrong_password');
  assert.throws(() => readBackupHeader(JSON.stringify({ ...f, iterations: 1000 })), (e) => e.code === 'weak');
  assert.throws(() => readBackupHeader(JSON.stringify({ ...f, app: 'beam-campfire' })), (e) => e.code === 'not_backup');
  assert.throws(() => readBackupHeader('not json'), (e) => e.code === 'not_backup');
  assert.throws(() => readBackupHeader('x'.repeat(BACKUP_MAX_BYTES + 1)), (e) => e.code === 'too_big');
  await assert.rejects(openBackup(JSON.stringify({ ...f, iterations: f.iterations + 1 }), 'a long password 12'), (e) => e.code === 'wrong_password', 'rounds are bound to the ciphertext');
  assert.equal(backupFileName(new Date(2026, 9, 12)), 'campfire-firo-backup-2026-10-12.json');
});

test('backup file (v2, from 0.1.8): scrypt N 2^16 r 8 p 1; the cost is bound and capped; a newer version is named as such (P9)', async () => {
  const secret = { mnemonic: 'abandon '.repeat(11) + 'about', passphrase: '', birthday: 1100000, name: 'Main' };
  const text = await makeBackup(secret, 'a long password 12', { now: new Date(Date.UTC(2026, 9, 15)) });
  const f = JSON.parse(text);
  assert.deepEqual([f.v, f.kdf, f.N, f.r, f.p, f.iterations], [2, 'scrypt', 2 ** 16, 8, 1, undefined]);
  assert.deepEqual(await openBackup(text, 'a long password 12'), { ...secret, network: 'main' });
  await assert.rejects(openBackup(text, 'wrong password'), (e) => e.code === 'wrong_password');
  assert.throws(() => readBackupHeader(JSON.stringify({ ...f, N: 2 ** 10 })), (e) => e.code === 'weak');
  assert.throws(() => readBackupHeader(JSON.stringify({ ...f, N: 2 ** 30 })), (e) => e.code === 'weak');
  assert.throws(() => readBackupHeader(JSON.stringify({ ...f, kdf: 'pbkdf2-sha256' })), (e) => e.code === 'not_backup');
  assert.throws(() => readBackupHeader(JSON.stringify({ ...f, v: 3 })), (e) => e.code === 'not_backup' && /newer Campfire/.test(e.message));
  await assert.rejects(openBackup(JSON.stringify({ ...f, N: 2 ** 17 }), 'a long password 12'), (e) => e.code === 'wrong_password', 'the cost is bound to the ciphertext');
});

test('own server: wss host:port only (port 50004 when left out); exactly one origin added to connect-src', () => {
  assert.deepEqual(normalizeServerAddress('wss://Electrum.Example.com:50004/'), { ok: true, address: 'electrum.example.com:50004', host: 'electrum.example.com', port: 50004 });
  assert.equal(normalizeServerAddress('electrum.example.com').address, 'electrum.example.com:50004');
  assert.equal(normalizeServerAddress('1.2.3.4:1').address, '1.2.3.4:1');
  for (const [bad, code] of [['', 'empty'], ['ws://x.com:1', 'insecure'], ['tcp://x.com:50001', 'insecure'], ['https://x.com', 'scheme'], ['u:p@x.com:1', 'credentials'], ['x.com:1/path', 'path'], ['[::1]:1', 'ipv6'], ['x.com:70000', 'port'], ['x..com', 'host'], ['999.1.1.1:1', 'host']]) assert.equal(normalizeServerAddress(bad).code, code, bad);
  const csp = "default-src 'self'; connect-src 'self' wss://electrumx.firo.org:50004; img-src 'self'";
  assert.equal(cspWithServer(csp, null), csp);
  assert.equal(cspWithServer(csp, 'my.server:50004'), "default-src 'self'; connect-src 'self' wss://electrumx.firo.org:50004 wss://my.server:50004; img-src 'self'");
  assert.equal(serverOrigin('my.server'), 'wss://my.server:50004');
  assert.deepEqual(FIRO_SERVERS, ['wss://electrumx.firo.org:50004', 'wss://electrumx01.firo.org:50004', 'wss://electrumx02.firo.org:50004', 'wss://electrumx03.firo.org:50004']);
  assert.deepEqual(serversFor({ server: FIRO_POOL }), FIRO_SERVERS);
  assert.deepEqual(serversFor({ server: 'my.server:1' }), ['wss://my.server:1'], 'your own server only, never a fallback');
  assert.equal(serverWords({ server: 'my.server:1' }), 'Your own node: my.server:1');
  // The public node the person picked is tried first; the other three stay behind it for failover.
  assert.deepEqual(serversFor({ server: FIRO_POOL, node: 'electrumx02.firo.org' }), ['wss://electrumx02.firo.org:50004', ...FIRO_SERVERS.filter((u) => !u.includes('electrumx02'))]);
  assert.deepEqual(serversFor({ server: FIRO_POOL, node: 'evil.example' }), FIRO_SERVERS, 'only one of Firo\'s public nodes can be picked');
  assert.equal(serverWords({ server: FIRO_POOL }), "Firo's public nodes");
  assert.equal(isOwnServer('firo'), false);
});

test('wallet: the engine\'s strings become BigInt; titles and signs in words', () => {
  const t = mapTx({ txid: 'ab', height: null, time: 5, confirmations: 0, direction: 'in', kind: 'spark', amount: '150000000', fee: '0', memo: 'hi' });
  assert.equal(t.amount, 150000000n);
  assert.equal(isPendingTx(t), true);
  assert.equal(txTitle(t), 'Receiving');
  assert.equal(txTitle({ ...t, confirmations: 1 }), 'Received');
  assert.equal(txTitle({ ...t, kind: 'privatize', direction: 'self', confirmations: 3 }), 'Privatized');
  assert.equal(txTitle({ ...t, direction: 'out' }), 'Sending');
  assert.equal(txTitle({ ...t, direction: 'self', kind: 'transparent', confirmations: 2 }), 'Sent to yourself');
  assert.equal(txTitle({ ...t, kind: 'coinbase', confirmations: 2 }), 'Mining reward');
  assert.equal(txSign(t), '+');
  assert.equal(txSign({ ...t, direction: 'out' }), '−');
  assert.equal(txSide({ kind: 'transparent' }), 'public');
  assert.equal(txSide({ kind: 'privatize' }), 'privatize');
  assert.equal(txSide({ kind: 'lelantus' }), 'private');
});

test('wallet: start, state, actions and stop over the engine behind the seam', async () => {
  globalThis.__firoFake.speed(2);
  const w = new Wallet();
  const seen = [];
  w.onChange((s) => seen.push(s.sync.state));
  await w.start({ walletId: 'aaaaaaaaaaaaaaaa', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', store: memoryStore(), servers: FIRO_SERVERS });
  const t0 = Date.now();
  while (w.state.sync.state !== 'synced' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.state.sync.state, 'synced');
  assert.ok(seen.includes('syncing'));
  assert.equal(w.state.balance.private.available, 309980000n);
  assert.equal(w.total(), 309980000n + 54990000n);
  assert.equal(w.state.txsLoaded, true);
  assert.equal(w.classifyAddress('@satoshi').kind, 'spark-name');
  const q = await w.quote({ from: 'public', to: [{ address: w.state.receive.spark, amount: 1000000n }] });
  assert.equal(typeof q.fee, 'bigint');
  const { txid } = await w.privatize('all');
  assert.match(txid, /^[0-9a-f]{64}$/);
  assert.equal(w.state.balance.public.available, 0n);
  await assert.rejects(w.start({ walletId: 'b', mnemonic: 'x' }), /already open/);
  await w.stop();
  assert.equal(w.session, null);
  assert.equal(w.state.running, false);
  assert.throws(() => w.need(), (e) => e.code === 'not-open');
});

test('assessSync: another Firo server telling a different chain is not "Synced", and sending pauses', () => {
  const now = 1791800000;
  const raw = { connected: true, server: 'wss://electrumx.firo.org:50004', tip: { height: 1393000, time: now - 60 }, sync: { phase: 'done', done: 1, total: 1 } };
  assert.equal(assessSync({ raw, now }).state, 'synced');
  assert.equal(assessSync({ raw: { ...raw, serverCheck: { state: 'agree' } }, now }).state, 'synced');
  assert.equal(assessSync({ raw: { ...raw, serverCheck: { state: 'unknown' } }, now }).state, 'synced');
  const d = assessSync({ raw: { ...raw, serverCheck: { state: 'disagree' } }, now });
  assert.equal(d.state, 'disagree');
  assert.equal(d.canSend, false);
  assert.match(d.detail, /electrumx\.firo\.org.*another Firo node.*Sending is paused/);
  // The same chain, but not the same private coins spent (audit D-12): said as such.
  const t = assessSync({ raw: { ...raw, serverCheck: { state: 'disagree', about: 'spent' } }, now });
  assert.deepEqual([t.state, t.canSend, t.title], ['disagree', false, 'Another Firo node disagrees with yours']);
  assert.equal(t.detail, 'Your node (electrumx.firo.org) and another Firo node do not agree on which private coins are already spent. Sending is paused; choose another Firo node.');
});

test('wallet (audit FM-1): a payment with no answer keeps its code and txid; shown unsure and spent; arrived or dropped as the engine says', async () => {
  globalThis.__firoFake.speed(2);
  globalThis.__firoFake.hold(true);
  const w = new Wallet();
  await w.start({ walletId: 'cccccccccccccccc', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', store: memoryStore(), servers: FIRO_SERVERS });
  const t0 = Date.now();
  while (w.state.sync.state !== 'synced' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  const before = w.state.balance.private.available;
  const to = [{ address: '@satoshi', amount: 1000000n }];
  // It reached the network but no answer came: 'unsure', the txid to follow, the amount spent.
  globalThis.__firoFake.unsureNext({ arrives: true });
  const e = await w.send({ from: 'private', to }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  assert.equal(e.message, "Your payment may have left. Don't send it again yet: Campfire is checking.");
  assert.match(e.txid, /^[0-9a-f]{64}$/);
  let tx = w.state.txs.find((t) => t.txid === e.txid);
  assert.equal(tx.unsure, true);
  assert.equal(tx.dropped, false);
  assert.ok(w.state.balance.private.available < before, 'its amount is not offered again');
  globalThis.__firoFake.mine();
  tx = w.state.txs.find((t) => t.txid === e.txid);
  assert.equal(tx.unsure, false, 'seen on the network');
  globalThis.__firoFake.mine();
  tx = w.state.txs.find((t) => t.txid === e.txid);
  assert.equal(isPendingTx(tx), false);
  // It never left: two blocks later it is dropped, and the amount is back.
  const mid = w.state.balance.private.available;
  globalThis.__firoFake.unsureNext({ arrives: false });
  const e2 = await w.send({ from: 'private', to }).catch((x) => x);
  assert.equal(e2.code, 'unsure');
  globalThis.__firoFake.mine();
  assert.equal(w.state.txs.find((t) => t.txid === e2.txid).dropped, false, 'not given up after one block');
  globalThis.__firoFake.mine();
  const gone = w.state.txs.find((t) => t.txid === e2.txid);
  assert.equal(gone.dropped, true);
  assert.equal(txTitle(gone), 'Did not go through');
  assert.equal(txSign(gone), '');
  assert.equal(w.state.balance.private.available, mid);
  // A refusal (an answer) keeps nothing.
  globalThis.__firoFake.refuseNext('bad-txns-spark-lineage');
  const n = w.state.txs.length;
  const e3 = await w.send({ from: 'private', to }).catch((x) => x);
  assert.equal(e3.code, 'server');
  assert.equal(w.state.txs.length, n);
  await w.stop();
  globalThis.__firoFake.hold(false);
});

test('wallet (re-audit 3 RE3-3): a payment the node in use says never left, an hour with no second node: offered, freed only by letGo (stand-in)', async () => {
  globalThis.__firoFake.speed(2);
  globalThis.__firoFake.hold(true);
  const w = new Wallet();
  await w.start({ walletId: 'eeeeeeeeeeeeeeee', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', store: memoryStore(), servers: FIRO_SERVERS });
  const t0 = Date.now();
  while (w.state.sync.state !== 'synced' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  const before = w.state.balance.private.available;
  globalThis.__firoFake.unsureNext({ arrives: false, oneNode: true });
  const e = await w.send({ from: 'private', to: [{ address: '@satoshi', amount: 1000000n }] }).catch((x) => x);
  assert.equal(e.code, 'unsure');
  await assert.rejects(w.letGo(e.txid), (x) => x.code === 'not-offered', 'nothing to let go yet');
  globalThis.__firoFake.mine();
  globalThis.__firoFake.mine();
  globalThis.__firoFake.mine();
  let tx = w.state.txs.find((t) => t.txid === e.txid);
  assert.equal(tx.oneNode, true, 'offered');
  assert.equal(tx.dropped, false, 'never given up by the engine on one node\'s word');
  assert.ok(w.state.balance.private.available < before, 'its amount stays spent');
  const { statusWords } = await import('../../src/screens/activity.js');
  assert.equal(statusWords(tx), 'The Firo node in use says it never left');
  assert.deepEqual(await w.letGo(e.txid), { txid: e.txid, letGo: true });
  tx = w.state.txs.find((t) => t.txid === e.txid);
  assert.equal(tx.dropped, true);
  assert.equal(tx.letGo, true);
  assert.equal(tx.oneNode, false);
  assert.equal(txTitle(tx), 'Let go');
  assert.equal(statusWords(tx), 'Let go on the word of the Firo node in use');
  assert.equal(w.state.balance.private.available, before, 'its amount is spendable again');
  await w.stop();
  globalThis.__firoFake.hold(false);
});

test('wallet (audit FE-1): a payment in a block on the node\'s word is not confirmed or spendable until proven (stand-in)', async () => {
  globalThis.__firoFake.speed(2);
  globalThis.__firoFake.hold(true);
  const w = new Wallet();
  await w.start({ walletId: 'dddddddddddddddd', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', store: memoryStore(), servers: FIRO_SERVERS });
  const t0 = Date.now();
  while (w.state.sync.state !== 'synced' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  const before = w.state.balance.public.available;
  const txid = globalThis.__firoFake.credit({ to: 'public', amount: '700000000', unproven: true });
  globalThis.__firoFake.mine();
  let tx = w.state.txs.find((t) => t.txid === txid);
  assert.deepEqual([tx.unproven, tx.confirmations, isPendingTx(tx), txTitle(tx)], [true, 0, true, 'Receiving']);
  assert.equal(w.state.balance.public.available, before, 'not spendable yet');
  assert.equal(w.state.balance.public.pending, 700000000n);
  globalThis.__firoFake.mine();
  tx = w.state.txs.find((t) => t.txid === txid);
  assert.deepEqual([tx.unproven, isPendingTx(tx)], [false, false]);
  assert.equal(w.state.balance.public.available, before + 700000000n);
  await w.stop();
  globalThis.__firoFake.hold(false);
});

test('wallet (audit FE-4): a payment under way from send() to its answer, so auto-lock waits (stand-in)', async () => {
  globalThis.__firoFake.speed(2);
  const w = new Wallet();
  await w.start({ walletId: 'eeeeeeeeeeeeeeee', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', store: memoryStore(), servers: FIRO_SERVERS });
  const t0 = Date.now();
  while (w.state.sync.state !== 'synced' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.paymentUnderWay(), false);
  globalThis.__firoFake.slowCoinCheck(150);
  const p = w.send({ from: 'private', to: [{ address: '@satoshi', amount: 1000000n }] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.paymentUnderWay(), true);
  await p;
  assert.equal(w.paymentUnderWay(), false);
  await w.stop();
  assert.equal(w.paymentUnderWay(), false);
});

test('wallet (audit FE-3): send() with the figures shown; another plan is refused with the new figures as BigInt (stand-in)', async () => {
  globalThis.__firoFake.speed(2);
  const w = new Wallet();
  await w.start({ walletId: 'ffffffffffffffff', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', store: memoryStore(), servers: FIRO_SERVERS });
  const t0 = Date.now();
  while (w.state.sync.state !== 'synced' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  const to = [{ address: '@satoshi', amount: 1000000n }];
  const q = await w.quote({ from: 'private', to });
  const n = w.state.txs.length;
  globalThis.__firoFake.feeChangeNext(7000);
  const e = await w.send({ from: 'private', to, expect: { fee: q.fee, total: q.total } }).catch((x) => x);
  assert.equal(e.code, 'fee-changed');
  assert.deepEqual([e.fee, e.total], [q.fee + 7000n, q.total + 7000n]);
  assert.equal(w.state.txs.length, n, 'nothing sent');
  const r = await w.send({ from: 'private', to, expect: { fee: e.fee, total: e.total } });
  assert.match(r.txid, /^[0-9a-f]{64}$/);
  await w.stop();
});
