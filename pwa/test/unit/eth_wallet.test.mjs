// The Ethereum wallet's own logic, offline: the sealed data store, the outbox
// (written before anything is broadcast), the history index parser and merge,
// recipient checks, preparing a payment with its fees, signing and sending,
// and following a transaction to its receipt (or to "replaced").
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealData, openData, forgetDataKeys, ETH_DATA_INFO } from '../../src/lib/eth/sealed.js';
import { loadOutbox, addToOutbox, updateOutbox, clearOutbox, validEntry, trimOutbox, OUTBOX_MAX, inDoubt, entryWords, BROADCAST_ANSWER_MS, openApprovals } from '../../src/lib/eth/outbox.js';
import { parseTransactions, parseTokenTransfers, mergeActivity, fetchHistory, HistoryError, PAGE, TRANSFER_TOPIC } from '../../src/lib/eth/history.js';
import { broadcast, approvalOnItsWay, approvalPass, allowanceNotBefore, recipientProblem, transferCall, prepareSend, signAndSend, signAndBroadcastCall, prepareCall, doubtText, settledByIndex, recheckClosed, REJECTED_LOOK_MS, RESEND_WAIT_MS, followOnce, classify, findNonceTaker, maxSendable, costRose, entryFee, SendError, ETH_TRANSFER_GAS, NONCE_LOOK_MS, REFUSAL_WATCH_MS, NONCE_GONE_BLOCKS, REJECTED_FOLLOW_MS } from '../../src/lib/eth/send.js';
import { ethWallet, removeEthWallet, ethPrefs, forgetEthWallet } from '../../src/lib/eth/wallet.js';
import { saveEthKey, getEthRecord, VaultError } from '../../src/lib/eth/vault.js';
import { hasEthWallet, ETH_OUTBOX_KEY, ETH_RECORD_KEY } from '../../src/lib/eth/record.js';
import { ethKeyFromMnemonic, toChecksumAddress } from '../../src/lib/eth/crypto.js';
import { EthRpc, EthRpcError } from '../../src/lib/eth/rpc.js';
import { chainOf } from '../../src/lib/eth/chains.js';
import { RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import { parseSignedTransaction, transactionHash, signTransaction } from '../../src/lib/eth/tx.js';
import { decodeCall, abiEncode } from '../../src/lib/eth/abi.js';
import { bytesToHex } from '../../src/lib/eth/hex.js';
import { ETH, RSFIRO, TOKENS, tokenBySymbol, nativeFor } from '../../src/lib/eth/tokens.js';
import { newDbPassword, PBKDF2_MIN_ITERATIONS } from '../../src/lib/envelope.js';
import * as F from './fixtures/eth/history_export.mjs';

const JUNK = 'test test test test test test test test test test test junk';
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ALICE = toChecksumAddress(F.ALICE);
const GWEI = 10n ** 9n;
const ETHER = 10n ** 18n;

const memoryKv = () => {
  const m = new Map();
  return { m, get: async (k) => structuredClone(m.get(k)), set: async (k, v) => void m.set(k, structuredClone(v)), del: async (k) => void m.delete(k) };
};
const newApp = (over = {}) => ({ record: { id: 'w-1', imported: false }, dbPass: newDbPassword(), prefs: {}, ...over });

async function walletWithKey({ imported = false } = {}) {
  const kv = memoryKv();
  const app = newApp({ record: { id: 'w-1', imported }, dbPass: imported ? 'file password' : newDbPassword() });
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  const record = await saveEthKey(app, { sk, address, words: 12 }, { kv });
  return { app, kv, record, ethId: record.id };
}

function entry(over = {}) {
  return {
    hash: `0x${'11'.repeat(32)}`,
    raw: '0x02f8aa',
    nonce: '0',
    from: ME,
    to: ALICE,
    asset: 'ETH',
    token: null,
    amount: '10000000000000000',
    gasLimit: '21000',
    maxFeePerGas: '3000000000',
    maxPriorityFeePerGas: '1000000000',
    createdAt: 1000,
    sentAt: null,
    state: 'signed',
    receipt: null,
    error: null,
    ...over,
  };
}

// ---------------------------------------------------------------- sealed

test('sealed data: round trip under the Firo wallet\'s secret; nothing in the clear; bound to its wallet and name', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const value = [{ hash: '0xabc', to: ALICE }];
  const env = await sealData(app, 'eth-test', value, { ethId, kv });
  assert.equal(env.kind, 'eth-data');
  assert.equal(env.kdf, 'hkdf-sha256');
  assert.equal(ETH_DATA_INFO, 'campfire-firo-eth-data-v1');
  assert.ok(!JSON.stringify(env).toLowerCase().includes(F.ALICE.slice(2)), 'the address is only inside');
  assert.deepEqual(await openData(app, 'eth-test', { ethId, kv }), value);
  // The salt (and so the derived key) is kept across rewrites; the iv is not.
  const env2 = await sealData(app, 'eth-test', [...value, { hash: '0xdef' }], { ethId, kv });
  assert.equal(env2.salt, env.salt);
  assert.notEqual(env2.iv, env.iv);
  forgetDataKeys();
  assert.equal((await openData(app, 'eth-test', { ethId, kv })).length, 2, 'opens again after the keys are forgotten');
  // Another dbPass, another wallet, another Ethereum wallet, a renamed record.
  await assert.rejects(openData({ ...app, dbPass: newDbPassword() }, 'eth-test', { ethId, kv }), (e) => e instanceof VaultError && e.code === 'wrong_secret');
  await assert.rejects(openData({ ...app, record: { id: 'w-2', imported: false } }, 'eth-test', { ethId, kv }), (e) => e.code === 'mismatch');
  assert.equal(await openData(app, 'eth-test', { ethId: 'other', kv }), null, "a removed Ethereum wallet's data is not shown for a new one");
  kv.m.set('eth-other', { ...kv.m.get('eth-test'), name: 'eth-other' });
  await assert.rejects(openData(app, 'eth-other', { ethId, kv }), (e) => e.code === 'wrong_secret', 'the name is bound');
  assert.equal(await openData(app, 'nothing-here', { ethId, kv }), null);
  await assert.rejects(openData({ ...app, dbPass: null }, 'eth-test', { ethId, kv }), (e) => e.code === 'locked');
});

test('sealed data (P17): its key cache never holds the wallet\'s secret, and Lock drops it on any path', async () => {
  const { app, kv, ethId } = await walletWithKey();
  app.lockHooks = new Set();
  await sealData(app, 'eth-p17', [1], { ethId, kv });
  assert.equal(app.lockHooks.size, 1, 'Lock drops the derived keys, whichever path sealed first');
  await openData(app, 'eth-p17', { ethId, kv });
  assert.equal(app.lockHooks.size, 1, 'once');
  // Nothing in the module's memory equals the secret (a digest stands for it).
  const mod = await import('../../src/lib/eth/sealed.js');
  void mod;
  const secret = String(app.dbPass);
  const held = [];
  const seen = new WeakSet();
  const walk = (v, depth = 0) => {
    if (v == null || depth > 6) return;
    if (typeof v === 'string') return void (v === secret && held.push(v));
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map) for (const [k, x] of v) (walk(k, depth + 1), walk(x, depth + 1));
    else for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(mod.__cacheForTests());
  assert.deepEqual(held, [], 'the secret is not kept');
  // Lock: the hook empties it.
  for (const f of app.lockHooks) f();
  assert.equal(mod.__cacheForTests().size, 0);
});

test('sealed data: an imported wallet uses PBKDF2 at 600,000 rounds or more, and refuses fewer or a swapped KDF', async () => {
  const { app, kv, ethId } = await walletWithKey({ imported: true });
  const env = await sealData(app, 'eth-test', { a: 1 }, { ethId, kv });
  assert.equal(env.kdf, 'pbkdf2-sha256');
  assert.equal(env.iterations, PBKDF2_MIN_ITERATIONS);
  assert.ok(env.iterations >= 600000);
  assert.deepEqual(await openData(app, 'eth-test', { ethId, kv }), { a: 1 });
  kv.m.set('eth-test', { ...env, iterations: 1000 });
  await assert.rejects(openData(app, 'eth-test', { ethId, kv }), (e) => e.code === 'weak');
  await assert.rejects(sealData(app, 'eth-test', { a: 2 }, { ethId, kv }), (e) => e.code === 'weak', 'a lowered count is not carried into the next write');
  kv.m.set('eth-test', { ...env, kdf: 'hkdf-sha256', iterations: undefined });
  await assert.rejects(openData(app, 'eth-test', { ethId, kv }), (e) => e.code === 'weak');
});

// ---------------------------------------------------------------- outbox

test('outbox: add, update, newest first; checked entries only; hash, raw, nonce and sender cannot be changed', async () => {
  const { app, kv, ethId } = await walletWithKey();
  assert.deepEqual(await loadOutbox(app, { ethId, kv }), []);
  await addToOutbox(app, entry(), { ethId, kv });
  await addToOutbox(app, entry({ hash: `0x${'22'.repeat(32)}`, createdAt: 2000 }), { ethId, kv });
  let list = await loadOutbox(app, { ethId, kv });
  assert.deepEqual(list.map((e) => e.hash.slice(0, 4)), ['0x22', '0x11']);
  const u = await updateOutbox(app, `0x${'11'.repeat(32)}`, { state: 'pending', sentAt: 5, raw: '0x02ff', nonce: '9' }, { ethId, kv });
  assert.equal(u.state, 'pending');
  assert.equal(u.raw, '0x02f8aa');
  assert.equal(u.nonce, '0');
  await assert.rejects(updateOutbox(app, `0x${'11'.repeat(32)}`, { state: 'lost' }, { ethId, kv }));
  assert.equal(await updateOutbox(app, `0x${'33'.repeat(32)}`, { state: 'pending' }, { ethId, kv }), null);
  await assert.rejects(addToOutbox(app, { ...entry(), hash: 'nope' }, { ethId, kv }));
  for (const bad of [null, {}, entry({ raw: '0x01aa' }), entry({ amount: '-1' }), entry({ to: 'bob' }), entry({ state: 'done' })]) assert.equal(validEntry(bad), false);
  // Two quick updates do not lose each other.
  await Promise.all([updateOutbox(app, `0x${'11'.repeat(32)}`, { error: 'x' }, { ethId, kv }), updateOutbox(app, `0x${'22'.repeat(32)}`, { state: 'pending' }, { ethId, kv })]);
  list = await loadOutbox(app, { ethId, kv });
  assert.equal(list.find((e) => e.hash.startsWith('0x11')).error, 'x');
  assert.equal(list.find((e) => e.hash.startsWith('0x22')).state, 'pending');
  assert.ok(!JSON.stringify([...kv.m.values()]).toLowerCase().includes(F.ALICE.slice(2)), 'nothing readable in storage');
  await clearOutbox(kv);
  assert.equal(kv.m.has(ETH_OUTBOX_KEY), false);
});

test('outbox: trimming keeps every open transaction and the newest closed ones', () => {
  const list = [];
  for (let i = 0; i < OUTBOX_MAX + 20; i++) list.push(entry({ hash: `0x${i.toString(16).padStart(64, '0')}`, state: i % 30 === 29 ? 'pending' : 'confirmed', createdAt: 10000 - i }));
  const t = trimOutbox(list);
  assert.equal(t.length, OUTBOX_MAX);
  assert.equal(t.filter((e) => e.state === 'pending').length, list.filter((e) => e.state === 'pending').length);
  assert.equal(t[0].hash, list[0].hash);
});

// ---------------------------------------------------------------- history

test('history index: transactions parsed exactly, junk dropped, fee from gasUsed x effectiveGasPrice', () => {
  const txs = parseTransactions(F.txs(), ME);
  assert.deepEqual(txs.map((t) => t.hash), [F.h(1), F.h(2), F.h(3), F.h(4)]);
  assert.equal(txs[0].value, ETHER);
  assert.equal(txs[0].from, F.ALICE);
  assert.equal(txs[1].fee, 21000n * 12345678901n, 'not the gasCost number');
  assert.equal(txs[2].contractCall, true);
  assert.equal(txs[3].failed, true);
  assert.throws(() => parseTransactions({ message: 'nope' }, ME), HistoryError);
});

test('history index: only Transfer events of the token itself, naming this address', () => {
  const xs = parseTokenTransfers(F.tokenLogs(), ME, RSFIRO);
  assert.deepEqual(xs.map((x) => [x.hash, x.from, x.to, x.amount]), [
    [F.h(3), F.ME, F.BOB, 1250000000n],
    [F.h(7), F.ALICE, F.ME, 10000000000n],
  ]);
});

test('activity: one row per movement, token transfers instead of their 0-ETH call, what this device sent wins, open ones first', () => {
  const txs = parseTransactions(F.txs(), ME);
  const transfers = parseTokenTransfers(F.tokenLogs(), ME, RSFIRO);
  const sentHere = entry({ hash: F.h(2), state: 'confirmed', amount: '250000000000000000', to: toChecksumAddress(F.BOB), receipt: { blockNumber: 200, status: 1, gasUsed: '21000', effectiveGasPrice: '12345678901' } });
  const open = entry({ hash: `0x${'aa'.repeat(32)}`, state: 'pending', createdAt: 1 });
  const items = mergeActivity({ address: ME, outbox: [sentHere, open], txs, transfers });
  assert.equal(items[0].hash, open.hash, 'open first');
  assert.equal(items[0].state, 'pending');
  const rows = items.map((i) => [i.hash, i.asset.symbol, i.direction, i.amount, i.state]);
  assert.deepEqual(rows.slice(1), [
    [F.h(7), 'rsFIRO', 'in', 10000000000n, 'confirmed'],
    [F.h(4), 'ETH', 'out', 5n, 'failed'],
    [F.h(3), 'rsFIRO', 'out', 1250000000n, 'confirmed'],
    [F.h(2), 'ETH', 'out', 250000000000000000n, 'confirmed'],
    [F.h(1), 'ETH', 'in', ETHER, 'confirmed'],
  ]);
  assert.equal(items.find((i) => i.hash === F.h(3)).fee, 51000n * 2000000000n, "the token transfer carries its call's fee");
  assert.equal(items.find((i) => i.hash === F.h(2)).local, true);
  assert.equal(items.find((i) => i.hash === F.h(1)).fee, null, 'nothing paid on what came in');
});

test('activity: an open payment in doubt says so (its bytes refused, or its nonce said used with nothing shown); a settled one does not', () => {
  const at = (n) => `0x${n.repeat(32)}`;
  const outbox = [
    entry({ hash: at('a1'), state: 'signed', refusedAt: 5, error: 'txpool is full' }),
    entry({ hash: at('a2'), state: 'pending', unsureSince: 6 }),
    entry({ hash: at('a3'), state: 'signed', refusedAt: 5, unsureSince: 6 }),
    entry({ hash: at('a4'), state: 'rejected', refusedAt: 5 }),
    entry({ hash: at('a5'), state: 'pending' }),
    entry({ hash: at('a6'), state: 'pending', refusedAt: 5, chain: 'bsc', asset: 'BNB' }),
  ];
  const doubt = (chain) => Object.fromEntries(mergeActivity({ address: ME, outbox, chain }).map((i) => [i.hash.slice(2, 4), i.doubt]));
  assert.deepEqual(doubt('ethereum'), { a1: 'refused', a2: 'unsure', a3: 'unsure', a4: null, a5: null });
  assert.deepEqual(doubt('bsc'), { a6: null }, 'taken by the server since: no longer in doubt');
});

test('history fetch: Stack Wallet only, no credentials, pages by firstBlock, an empty body is an empty history', async () => {
  const seen = [];
  // Page 2 starts at the last block of page 1, so that block's transaction comes again.
  const page = (from, n) => ({ data: Array.from({ length: n }, (_, i) => ({ hash: F.h(from + i), from: F.ALICE, to: F.ME, value: '1', blockNumber: from + i, timestamp: 1 })) });
  const fetch = async (url, init) => {
    seen.push({ url, init });
    const u = new URL(url);
    let body;
    if (u.searchParams.get('emitter')) body = u.searchParams.get('emitter') === F.TOKEN_ADDR ? JSON.stringify(F.tokenLogs()) : '';
    else body = JSON.stringify(Number(u.searchParams.get('firstBlock')) === 0 ? page(1, PAGE) : page(PAGE, 3));
    return { ok: true, status: 200, text: async () => body };
  };
  const { txs, transfers } = await fetchHistory(ME, { fetch });
  assert.equal(txs.length, PAGE + 2, 'the overlapping block is not counted twice');
  assert.equal(transfers.length, 2);
  for (const s of seen) {
    assert.match(s.url, /^https:\/\/eth2\.stackwallet\.com\/export\?addrs=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266&/);
    assert.equal(s.init.credentials, 'omit');
    assert.equal(s.init.referrerPolicy, 'no-referrer');
    assert.equal(s.init.redirect, 'error');
  }
  assert.equal(seen.filter((s) => s.url.includes('emitter=')).length, TOKENS.length);
  await assert.rejects(fetchHistory(ME, { fetch: async () => ({ ok: false, status: 502, text: async () => '' }) }), (e) => e instanceof HistoryError && e.code === 'http');
  await assert.rejects(fetchHistory(ME, { fetch: async () => { throw new TypeError('x'); } }), (e) => e.code === 'network');
});

// ---------------------------------------------------------------- recipients

test('recipients: format, checksum, own, zero and token contracts are refused in words', () => {
  assert.equal(recipientProblem(ALICE, { own: ME }), null);
  assert.equal(recipientProblem(F.ALICE, { own: ME }), null, 'all lowercase carries no checksum and is fine');
  assert.equal(recipientProblem('').code, 'empty');
  assert.equal(recipientProblem('0x123').code, 'format');
  assert.equal(recipientProblem(F.ALICE.slice(2)).code, 'format');
  assert.match(recipientProblem(F.ALICE.slice(2)).message, /starts with 0x/);
  const typo = ALICE.slice(0, -1) + (ALICE.at(-1) === 'C' ? 'c' : 'C');
  assert.equal(recipientProblem(typo === ALICE ? ALICE.replace('9', 'a') : typo).code, 'checksum');
  assert.equal(recipientProblem(ME.toLowerCase(), { own: ME }).code, 'own');
  assert.equal(recipientProblem('0x0000000000000000000000000000000000000000').code, 'zero');
  for (const t of TOKENS) assert.equal(recipientProblem(toChecksumAddress(t.address)).code, 'token', t.symbol);
  assert.match(recipientProblem(RSFIRO.address).message, /rsFIRO token's own contract/);
  // Contracts that never take a plain payment (public audit, P12): Rosen's locks, Uniswap's and PancakeSwap's.
  for (const a of ['0x451698faa07fc68301af622a3ad42205f13c6e4b', '0x34c9f8a268df15fb38811800cb6e7f6a109cd0e7']) {
    assert.equal(recipientProblem(a).code, 'contract');
    assert.match(recipientProblem(a).message, /Rosen Bridge's lock address on (Ethereum|BNB Chain)\. .* use Bridge\./);
  }
  assert.match(recipientProblem(toChecksumAddress('0x000000000022d473030f116ddee9f6b43ac78ba3')).message, /one of Uniswap's own contracts/);
  assert.match(recipientProblem('0x66a9893cc07d91d95644aedd05d03f95e1dba8af').message, /one of Uniswap's own contracts/);
  assert.match(recipientProblem('0x13f4ea83d0bd40e75c8222255bc855a974568dd4').message, /one of PancakeSwap's own contracts/);
});

test('transfer calls: ETH goes to the person; a token goes to its contract as transfer(to, amount)', () => {
  assert.deepEqual(transferCall(ETH, F.ALICE, 5n), { to: ALICE, value: 5n, data: '0x' });
  const t = transferCall(RSFIRO, F.ALICE, 7n);
  assert.equal(t.to, toChecksumAddress(RSFIRO.address));
  assert.equal(t.value, 0n);
  assert.deepEqual(decodeCall('transfer(address,uint256)', t.data), [ALICE, 7n]);
  assert.throws(() => transferCall({ symbol: 'FAKE', address: F.BOB, decimals: 18 }, F.ALICE, 1n), SendError);
});

// ---------------------------------------------------------------- a fake chain

const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
const q = (n) => `0x${BigInt(n).toString(16)}`;

/** A signed transaction as a server's JSON shows it (eth_getTransactionByHash, a full block). */
function txJson(raw, blockNumber = null) {
  const p = parseSignedTransaction(raw);
  const t = p.tx;
  return {
    type: '0x2',
    chainId: q(t.chainId),
    nonce: q(t.nonce),
    maxPriorityFeePerGas: q(t.maxPriorityFeePerGas),
    maxFeePerGas: q(t.maxFeePerGas),
    gas: q(t.gasLimit),
    to: t.to.toLowerCase(),
    value: q(t.value),
    input: t.data,
    accessList: [],
    v: q(p.yParity),
    yParity: q(p.yParity),
    r: q(p.r),
    s: q(p.s),
    hash: p.hash,
    from: p.from.toLowerCase(),
    blockHash: blockNumber === null ? null : F.h(0xb000 + blockNumber),
    blockNumber: blockNumber === null ? null : q(blockNumber),
  };
}

/**
 * A tiny chain behind EthRpc's own fetch: one account, a pool, receipts on demand, blocks from
 * 100 on with the transactions mined in them, and the account's count at each block. st.latest
 * is what 'latest' answers (a test sets it to lie); st.lieAll makes every block's count lie too;
 * st.noOldState refuses counts at past blocks, as a server without old state does; st.relayOnRefuse
 * keeps refused bytes (a server that passed them on and then said no).
 */
function fakeChain({ eth = ETHER, nonce = 0n, transferReturns = word(1), estimate = null, codeAt = {}, onSend = null } = {}) {
  const st = { eth, latest: nonce, pending: nonce, pool: new Map(), mined: new Map(), byHash: new Map(), blocks: new Map(), own: [], head: 100, sends: [], calls: [], down: false, refuse: null, relayed: new Map(), relayOnRefuse: false, lieAll: false, noOldState: false };
  const countAt = (n) => {
    if (st.lieAll) return st.latest;
    if (st.noOldState && n < st.head) throw Object.assign(new Error('missing trie node'), { code: -32000 });
    return nonce + BigInt(st.own.filter((b) => b <= n).length);
  };
  const handle = async (method, params) => {
    st.calls.push(method);
    switch (method) {
      case 'eth_chainId':
        return '0x1';
      case 'eth_blockNumber':
        return q(st.head);
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(params[0]));
        if (n > st.head) return null;
        return { number: q(n), hash: F.h(0xb000 + n), transactions: st.blocks.get(n) || [] };
      }
      case 'eth_feeHistory':
        // base fee 10 gwei (next block), tips 1..5 gwei -> median 3
        return { oldestBlock: '0x60', baseFeePerGas: Array(6).fill(q(10n * GWEI)), reward: [1, 2, 3, 4, 5].map((g) => [q(BigInt(g) * GWEI)]) };
      case 'eth_estimateGas': {
        if (estimate instanceof Error) throw estimate;
        if (estimate != null) return q(estimate);
        return params[0].data && params[0].data !== '0x' ? q(51000) : q(21000);
      }
      case 'eth_getCode':
        return codeAt[params[0]] || '0x';
      case 'eth_call':
        if (transferReturns instanceof Error) throw transferReturns;
        return transferReturns;
      case 'eth_getBalance':
        return q(st.eth);
      case 'eth_getTransactionCount':
        if (params[1] === 'pending') return q(st.pending);
        if (params[1] === 'latest') return q(st.latest);
        return q(countAt(Number(BigInt(params[1]))));
      case 'eth_sendRawTransaction': {
        if (onSend) await onSend(params[0]);
        if (st.refuse) {
          if (st.relayOnRefuse) st.relayed.set(transactionHash(params[0]), params[0]);
          throw st.refuse;
        }
        const hash = transactionHash(params[0]);
        st.sends.push(params[0]);
        st.pool.set(hash, params[0]);
        st.pending += 1n;
        return hash;
      }
      case 'eth_getTransactionReceipt':
        return st.mined.get(params[0]) || null;
      case 'eth_getTransactionByHash': {
        const h = params[0];
        if (st.byHash.has(h)) return st.byHash.get(h);
        if (st.mined.has(h)) return { hash: h, blockHash: F.h(0xbb) };
        if (st.pool.has(h)) return { hash: h, blockHash: null };
        return null;
      }
      default:
        throw Object.assign(new Error(`unexpected ${method}`), { code: -32601 });
    }
  };
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (st.down === true || (st.down && body.method === st.down)) throw new TypeError('Failed to fetch');
    const one = async (r) => {
      try {
        return { jsonrpc: '2.0', id: r.id, result: await handle(r.method, r.params) };
      } catch (e) {
        return { jsonrpc: '2.0', id: r.id, error: { code: e.code ?? -32000, message: e.message } };
      }
    };
    const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
    return { status: 200, text: async () => JSON.stringify(out) };
  };
  const receiptOf = (hash, n, status) => ({ transactionHash: hash, status: q(status), blockNumber: q(n), blockHash: F.h(0xb000 + n), from: ME.toLowerCase(), to: F.ALICE, gasUsed: q(21000), effectiveGasPrice: q(13n * GWEI), logs: [] });
  const mine = (hash, status = 1) => {
    const raw = st.pool.get(hash) || st.relayed.get(hash);
    st.pool.delete(hash);
    st.relayed.delete(hash);
    st.latest += 1n;
    const n = ++st.head;
    st.own.push(n);
    if (raw) st.blocks.set(n, [txJson(raw, n)]);
    st.mined.set(hash, receiptOf(hash, n, status));
  };
  /** Mines signed bytes this server never had in its pool (sent elsewhere); `json` as the block shows it. */
  const mineRaw = (raw, { json = txJson(raw, st.head + 1), receipt = true } = {}) => {
    const n = ++st.head;
    st.latest += 1n;
    st.own.push(n);
    st.blocks.set(n, [json]);
    st.byHash.set(json.hash, json);
    if (receipt) st.mined.set(json.hash, receiptOf(json.hash, n, 1));
    return n;
  };
  return { st, rpc: new EthRpc('stackwallet', { fetch }), mine, mineRaw };
}

// ---------------------------------------------------------------- prepare

test('prepare ETH: 21,000 gas for a plain account; "likely" and "up to" fees; refuses what the fee leaves no room for', async () => {
  const { rpc } = fakeChain();
  const balances = { eth: ETHER };
  const p = await prepareSend(rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 10n ** 16n, balances });
  assert.equal(p.tx.gasLimit, ETH_TRANSFER_GAS);
  assert.equal(p.tx.maxPriorityFeePerGas, 3n * GWEI, 'the median tip');
  assert.equal(p.tx.maxFeePerGas, 23n * GWEI, '2 x base + tip');
  assert.equal(p.fees.upTo, 21000n * 23n * GWEI);
  assert.equal(p.fees.likely, 21000n * 13n * GWEI);
  assert.equal(p.recipient, ALICE);
  assert.equal(p.tx.to, ALICE);
  assert.equal(p.tx.value, 10n ** 16n);
  const max = maxSendable(ETH, balances, p.fees.upTo);
  assert.equal(max, ETHER - p.fees.upTo);
  await prepareSend(rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: max, balances });
  await assert.rejects(prepareSend(rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: max + 1n, balances }), (e) => e.code === 'not_enough' && /You can send up to/.test(e.message));
  await assert.rejects(prepareSend(rpc, { from: ME, asset: ETH, recipient: ME, amount: 1n, balances }), (e) => e.code === 'recipient');
  await assert.rejects(prepareSend(rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 0n, balances }), (e) => e.code === 'not_enough');
});

test('prepare ETH to a contract: the estimate with headroom; a refusing contract is said plainly', async () => {
  const { rpc } = fakeChain({ estimate: 30000n, codeAt: { [F.BOB]: '0x6080' } });
  const p = await prepareSend(rpc, { from: ME, asset: ETH, recipient: F.BOB, amount: 1n, balances: { eth: ETHER } });
  assert.equal(p.tx.gasLimit, 50000n, '+20,000 at least');
  const refusing = fakeChain({ estimate: Object.assign(new Error('execution reverted: no thanks'), { code: 3 }), codeAt: { [F.BOB]: '0x6080' } });
  await assert.rejects(prepareSend(refusing.rpc, { from: ME, asset: ETH, recipient: F.BOB, amount: 1n, balances: { eth: ETHER } }), (e) => e.code === 'would_fail' && /no thanks/.test(e.message));
  const plain = fakeChain({ estimate: Object.assign(new Error('some node quirk'), { code: -32000 }) });
  assert.equal((await prepareSend(plain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } })).tx.gasLimit, 21000n, 'an account without code cannot refuse ETH');
});

test('prepare a token: transfer() to the token, simulated first; the fee must be there in ETH', async () => {
  const { rpc } = fakeChain();
  const balances = { eth: ETHER, rsFIRO: 5n * 10n ** 8n };
  const p = await prepareSend(rpc, { from: ME, asset: RSFIRO, recipient: F.ALICE, amount: 10n ** 8n, balances });
  assert.equal(p.tx.to, toChecksumAddress(RSFIRO.address));
  assert.equal(p.tx.value, 0n);
  assert.deepEqual(decodeCall('transfer(address,uint256)', p.tx.data), [ALICE, 10n ** 8n]);
  assert.equal(p.tx.gasLimit, 71000n, '51,000 + 20,000');
  assert.equal(maxSendable(RSFIRO, balances, p.fees.upTo), 5n * 10n ** 8n);
  await assert.rejects(prepareSend(rpc, { from: ME, asset: RSFIRO, recipient: F.ALICE, amount: 6n * 10n ** 8n, balances }), (e) => e.code === 'not_enough');
  await assert.rejects(prepareSend(rpc, { from: ME, asset: RSFIRO, recipient: F.ALICE, amount: 1n, balances: { eth: 1000n, rsFIRO: 10n } }), (e) => e.code === 'no_gas' && /paid in ETH/.test(e.message));
  const no = fakeChain({ transferReturns: word(0) });
  await assert.rejects(prepareSend(no.rpc, { from: ME, asset: RSFIRO, recipient: F.ALICE, amount: 1n, balances }), (e) => e.code === 'would_fail');
  const usdt = fakeChain({ transferReturns: '0x' });
  const usdtToken = tokenBySymbol('USDT');
  await prepareSend(usdt.rpc, { from: ME, asset: usdtToken, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER, USDT: 1n } }); // returns nothing, like USDT
  const reverts = fakeChain({ transferReturns: Object.assign(new Error('execution reverted: blacklisted'), { code: 3 }) });
  await assert.rejects(prepareSend(reverts.rpc, { from: ME, asset: RSFIRO, recipient: F.ALICE, amount: 1n, balances }), (e) => e.code === 'would_fail' && /blacklisted/.test(e.message));
});

test('a fresh preparation that costs more than the reviewed one is noticed', () => {
  const a = { fees: { upTo: 100n }, tx: { gasLimit: 21000n, to: ALICE, value: 1n } };
  assert.equal(costRose(a, a), false);
  assert.equal(costRose(a, { ...a, fees: { upTo: 101n } }), true);
  assert.equal(costRose(a, { ...a, fees: { upTo: 99n } }), false);
  assert.equal(costRose(a, { ...a, tx: { ...a.tx, value: 2n } }), true);
});

// ---------------------------------------------------------------- sign, save, send, follow

test('send: signed with a fresh nonce, saved BEFORE it is broadcast, then pending; the key opens only with the wallet unlocked', async () => {
  const { app, kv, ethId } = await walletWithKey();
  let savedBeforeSend = null;
  const chain = fakeChain({
    nonce: 4n,
    onSend: async (raw) => {
      const list = await loadOutbox(app, { ethId, kv });
      savedBeforeSend = list.find((e) => e.raw === raw) || null;
    },
  });
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 10n ** 16n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv, now: () => 42 });
  assert.equal(r.sent, true);
  assert.ok(savedBeforeSend, 'the outbox held the bytes when they were broadcast');
  assert.equal(savedBeforeSend.state, 'signed');
  assert.equal(r.entry.state, 'pending');
  const parsed = parseSignedTransaction(r.entry.raw);
  assert.equal(parsed.from, ME);
  assert.equal(parsed.tx.nonce, 4n);
  assert.equal(parsed.tx.chainId, 1n);
  assert.equal(parsed.tx.to, ALICE);
  assert.equal(parsed.tx.value, 10n ** 16n);
  assert.equal(parsed.tx.gasLimit, p.tx.gasLimit);
  assert.equal(parsed.tx.maxFeePerGas, p.tx.maxFeePerGas, 'exactly what was reviewed');
  assert.equal(r.entry.hash, parsed.hash);
  assert.equal(chain.st.calls.filter((m) => m === 'eth_chainId').length, 1, 'chain id checked right before signing');
  // Followed: pending, then mined.
  assert.equal((await followOnce(app, chain.rpc, r.entry, { ethId, kv })).state, 'pending');
  chain.mine(r.entry.hash);
  const done = await followOnce(app, chain.rpc, r.entry, { ethId, kv });
  assert.equal(done.state, 'confirmed');
  assert.equal(entryFee(done).wei, 21000n * 13n * GWEI);
  assert.equal(entryFee(done).final, true);
  await assert.rejects(signAndSend({ ...app, dbPass: null }, chain.rpc, p, { ethId, kv }), (e) => e.code === 'locked');
});

test('send: a network error leaves it signed; following sends the identical bytes again, never re-signed', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  chain.st.down = 'eth_sendRawTransaction';
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  assert.equal(r.sent, false);
  assert.equal(r.entry.state, 'signed');
  assert.equal(r.error.code, 'network');
  chain.st.down = null;
  const again = await followOnce(app, chain.rpc, r.entry, { ethId, kv });
  assert.equal(again.state, 'pending');
  assert.deepEqual(chain.st.sends, [r.entry.raw], 'the saved bytes, once they could go');
  assert.equal((await loadOutbox(app, { ethId, kv })).length, 1);
});

test('send: bytes the server refuses stay open and checked; "never sent" only after 30 minutes of refusals', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  chain.st.refuse = Object.assign(new Error('insufficient funds for gas * price + value'), { code: -32000 });
  let now = 1000;
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv, now: () => now });
  assert.equal(r.sent, false);
  assert.equal(r.entry.state, 'signed', 'not "Nothing was spent": the server may have passed it on');
  assert.equal(r.entry.refusedAt, 1000);
  assert.match(r.entry.error, /insufficient funds/);
  assert.equal((await loadOutbox(app, { ethId, kv }))[0].refusedAt, 1000, 'kept with the entry');
  // Followed: its hash asked, its bytes offered again, still refused: still open.
  now += REFUSAL_WATCH_MS - 1;
  let e = await followOnce(app, chain.rpc, r.entry, { ethId, kv, now: () => now });
  assert.equal(e.state, 'signed');
  assert.equal(e.refusedAt, 1000, 'since the first refusal');
  assert.ok(chain.st.calls.includes('eth_getTransactionByHash'));
  assert.equal(chain.st.calls.filter((m) => m === 'eth_sendRawTransaction').length, 2, 'the same bytes, again');
  // Half an hour of refusals with the hash unknown and the nonce free: never sent.
  now += 1;
  e = await followOnce(app, chain.rpc, e, { ethId, kv, now: () => now });
  assert.equal(e.state, 'rejected');
  assert.equal((await followOnce(app, chain.rpc, e, { ethId, kv })).state, 'rejected', 'not followed any more');
});

test('send: a server that refused the bytes but had passed them on: the payment is followed to its receipt', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  chain.st.refuse = Object.assign(new Error('transaction underpriced'), { code: -32000 });
  chain.st.relayOnRefuse = true;
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv, now: () => 5 });
  assert.equal(r.entry.state, 'signed', 'refused, but it may have left: still followed');
  // Another node mined it.
  chain.mine(r.entry.hash);
  const e = await followOnce(app, chain.rpc, r.entry, { ethId, kv, now: () => 5 + REFUSAL_WATCH_MS * 2 });
  assert.equal(e.state, 'confirmed', 'mined, whatever the server said when it was sent');
  assert.equal(e.refusedAt, null);
  // And a server that takes the bytes on a later try clears the doubt.
  const { app: app2, kv: kv2, ethId: id2 } = await walletWithKey();
  const c2 = fakeChain();
  const p2 = await prepareSend(c2.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 2n, balances: { eth: ETHER } });
  c2.st.refuse = Object.assign(new Error('txpool is full'), { code: -32000 });
  const r2 = await signAndSend(app2, c2.rpc, p2, { ethId: id2, kv: kv2 });
  assert.ok(r2.entry.refusedAt);
  c2.st.refuse = null;
  // Offered again once the wait after a refusal is over (FM-8).
  const e2 = await followOnce(app2, c2.rpc, r2.entry, { ethId: id2, kv: kv2, now: () => Date.now() + RESEND_WAIT_MS });
  assert.equal(e2.state, 'pending');
  assert.equal(e2.refusedAt, null);
});

// Second audit, X7: "failed" frees the amount and invites a second payment, so one server's failed
// receipt is not enough: another listed server must show it too, and none may show it succeeded.
test('follow (X7): "failed" needs a second server; until then it is held, in doubt, and says so', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain({ nonce: 4n });
  const second = fakeChain({ nonce: 4n });
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 10n ** 16n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  chain.mine(r.entry.hash, 0); // the server in use: mined and failed
  // The second server has not seen it yet: held open, in doubt.
  let e = await followOnce(app, chain.rpc, r.entry, { ethId, kv, others: [second.rpc] });
  assert.equal(e.state, 'pending');
  assert.deepEqual(e.failedSeen, { block: chain.st.head, said: 'unseen' });
  assert.equal(inDoubt(await loadOutbox(app, { ethId, kv }), 'ethereum').length, 1, 'new signing on Ethereum waits');
  assert.match(doubtText(e), /your Ethereum server says it failed, and no second server has confirmed that yet/);
  // No other server answers: still held.
  second.st.down = true;
  e = await followOnce(app, chain.rpc, e, { ethId, kv, others: [second.rpc] });
  assert.equal(e.state, 'pending');
  assert.equal(e.failedSeen.said, 'no-answer');
  second.st.down = false;
  // The second shows the same failed receipt: failed.
  second.st.pool.set(r.entry.hash, r.entry.raw);
  second.mine(r.entry.hash, 0);
  e = await followOnce(app, chain.rpc, e, { ethId, kv, others: [second.rpc] });
  assert.equal(e.state, 'failed');
  assert.equal(e.failedSeen, null);
  assert.equal(inDoubt(await loadOutbox(app, { ethId, kv }), 'ethereum').length, 0);
});

test('follow (X7): a second server showing it succeeded keeps it open; the person\'s own server alone counts only 12 blocks deep', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain({ nonce: 4n });
  const second = fakeChain({ nonce: 4n });
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 10n ** 16n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  chain.mine(r.entry.hash, 0);
  second.st.pool.set(r.entry.hash, r.entry.raw);
  second.mine(r.entry.hash, 1); // the other says it went through
  let e = await followOnce(app, chain.rpc, r.entry, { ethId, kv, others: () => [second.rpc] });
  assert.equal(e.state, 'pending');
  assert.equal(e.failedSeen.said, 'disagree');
  // Own server: no listed server is asked; its word once the block is deep.
  e = await followOnce(app, chain.rpc, e, { ethId, kv, others: [] });
  assert.equal(e.state, 'pending');
  assert.equal(e.failedSeen.said, 'alone');
  chain.st.head += 11;
  assert.equal((await followOnce(app, chain.rpc, e, { ethId, kv, others: [] })).state, 'pending', '11 deep: not yet');
  chain.st.head += 1;
  assert.equal((await followOnce(app, chain.rpc, e, { ethId, kv, others: [] })).state, 'failed', '12 deep');
});

test('follow: a used-up nonce alone is "unsure", never "replaced"; mined, or in a block, wins', () => {
  assert.equal(classify({ receipt: { status: 1 }, minedNonce: 9n, nonce: '0', known: true }), 'confirmed');
  assert.equal(classify({ receipt: { status: 0 }, minedNonce: 9n, nonce: '0', known: true }), 'failed');
  assert.equal(classify({ receipt: null, minedNonce: 1n, nonce: '0', known: false }), 'unsure');
  assert.equal(classify({ receipt: null, minedNonce: 6n, nonce: '5', known: true }), 'unsure', 'the PoC: one server says 6 while it still holds nonce 5 waiting');
  assert.equal(classify({ receipt: null, minedNonce: 1n, nonce: '0', known: true, inBlock: true }), 'pending', 'mined, the receipt is on its way');
  assert.equal(classify({ receipt: null, minedNonce: 0n, nonce: '0', known: false }), 'unknown');
  assert.equal(classify({ receipt: null, minedNonce: 0n, nonce: '0', known: true }), 'pending');
});

// followOnce looks into a used-up nonce at most once a minute per transaction, and the test key
// signs the same bytes in every test: one clock for all of them, moved past that minute each time.
let clock = 10 ** 9;
const later = () => (clock += NONCE_LOOK_MS);

/** A wallet with one 1-wei payment sent and waiting on `chain`. */
async function sentOne(chain = fakeChain()) {
  const { app, kv, ethId } = await walletWithKey();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  assert.equal(r.entry.state, 'pending');
  return { app, kv, ethId, chain, entry: r.entry, p };
}

/** Another transaction from this wallet with `entry`'s nonce (what another device with the same words would send). */
async function sameNonce(entry, { chainId = 1n, to = F.BOB, words = JUNK } = {}) {
  const { sk } = await ethKeyFromMnemonic(words);
  return signTransaction({ chainId, nonce: BigInt(entry.nonce), to: toChecksumAddress(to), value: 5n, gasLimit: 21000n, maxFeePerGas: 40n * GWEI, maxPriorityFeePerGas: 2n * GWEI }, sk);
}

test('follow (D-04): one server saying the nonce is used up cannot turn a waiting payment into "replaced"', async () => {
  const { app, kv, ethId, chain, entry } = await sentOne();
  // The PoC: the server still holds the payment, waiting, but says the account's nonce moved on.
  chain.st.latest = 1n;
  let now = later();
  const first = now;
  const look = () => followOnce(app, chain.rpc, entry, { ethId, kv, now: () => now });
  let e = await look();
  assert.equal(e.state, 'pending', 'still open: it may yet be mined');
  assert.equal(e.unsureSince, first, 'the screens are told not to send it again yet');
  assert.deepEqual(chain.st.sends, [entry.raw, entry.raw], 'the same bytes offered again, never re-signed');
  assert.equal((await loadOutbox(app, { ethId, kv }))[0].unsureSince, first, 'kept with the entry');
  // A server that lies about every block too, and forgets the payment: still no evidence, still not replaced.
  chain.st.lieAll = true;
  chain.st.pool.delete(entry.hash);
  const counts = () => chain.st.calls.filter((m) => m === 'eth_getTransactionCount').length;
  now += 1000;
  let before = counts();
  e = await look();
  assert.equal(e.state, 'pending');
  assert.equal(counts() - before, 1, 'looked into a moment ago: only the nonce is asked, no search');
  for (let i = 0; i < 5; i++) {
    now += NONCE_LOOK_MS;
    e = await look();
    assert.equal(e.state, 'pending', `look ${i}: never replaced on the server's word`);
    assert.equal(e.unsureSince, first, 'since the first time');
  }
  clock = now;
  // The payment was in fact still out there: it is mined, and that is what counts.
  chain.st.lieAll = false;
  chain.st.latest = 0n;
  chain.st.pool.set(entry.hash, entry.raw);
  chain.mine(entry.hash);
  e = await look();
  assert.equal(e.state, 'confirmed');
  assert.equal(e.unsureSince, null, 'no longer in doubt');
});

test('follow (D-04): "replaced" only once the server shows the transaction that took the nonce, signed by this wallet, with a receipt', async () => {
  const { app, kv, ethId, chain, entry } = await sentOne();
  const other = await sameNonce(entry);
  chain.st.pool.delete(entry.hash);
  const block = chain.mineRaw(other.raw);
  const e = await followOnce(app, chain.rpc, entry, { ethId, kv, now: later });
  assert.equal(e.state, 'replaced');
  assert.equal(e.replacedBy, other.hash);
  assert.equal(e.replacedIn, block);
  assert.equal(e.unsureSince, null);
  assert.ok(chain.st.calls.includes('eth_getBlockByNumber'), 'found in the block where the count passed the nonce');
});

test('follow (D-04): made-up, altered, foreign-chain or unmined "replacements" are not evidence', async () => {
  const STRANGER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const cases = {
    'signed by another key, labelled as this wallet': async (entry) => ({ ...txJson((await sameNonce(entry, { words: STRANGER })).raw), from: ME.toLowerCase() }),
    'a real one of ours with its amount changed': async (entry) => ({ ...txJson((await sameNonce(entry)).raw), value: q(10n ** 18n) }),
    'ours, but signed for BNB Chain': async (entry) => txJson((await sameNonce(entry, { chainId: 56n })).raw),
  };
  for (const [name, make] of Object.entries(cases)) {
    const { app, kv, ethId, chain, entry } = await sentOne();
    chain.st.pool.delete(entry.hash);
    const json = await make(entry);
    chain.mineRaw(null, { json: { ...json, blockHash: F.h(0xb065), blockNumber: q(chain.st.head + 1) } });
    const e = await followOnce(app, chain.rpc, entry, { ethId, kv, now: later });
    assert.equal(e.state, 'pending', name);
    assert.ok(e.unsureSince, name);
  }
  // Genuinely ours and in the block, but the server serves no receipt for it: not yet evidence.
  const { app, kv, ethId, chain, entry } = await sentOne();
  chain.st.pool.delete(entry.hash);
  chain.mineRaw((await sameNonce(entry)).raw, { receipt: false });
  assert.equal((await followOnce(app, chain.rpc, entry, { ethId, kv, now: later })).state, 'pending');
});

test('follow (D-04): our own payment found in the block (its receipt not served yet) is waiting, not replaced', async () => {
  const { app, kv, ethId, chain, entry } = await sentOne();
  // A server whose receipt lags its blocks: the count moved, the block holds our bytes, no receipt yet.
  const json = txJson(entry.raw, chain.st.head + 1);
  chain.st.pool.delete(entry.hash);
  chain.mineRaw(entry.raw, { json, receipt: false });
  chain.st.byHash.delete(entry.hash); // and it says it does not know the hash
  const e = await followOnce(app, chain.rpc, entry, { ethId, kv, now: later });
  assert.equal(e.state, 'pending');
  assert.ok(!e.unsureSince);
});

test('follow (D-04): a hash the wallet already knows proves it where the server keeps no old state', async () => {
  const { app, kv, ethId, chain, entry } = await sentOne();
  const other = await sameNonce(entry);
  chain.st.pool.delete(entry.hash);
  chain.mineRaw(other.raw);
  chain.st.head += 500; // long ago
  chain.st.noOldState = true;
  assert.equal(await findNonceTaker(chain.rpc, entry).catch((err) => err.code), -32000, 'the block search needs old state');
  assert.equal((await followOnce(app, chain.rpc, entry, { ethId, kv, now: later })).state, 'pending');
  const e = await followOnce(app, chain.rpc, entry, { ethId, kv, candidates: [F.h(0xdead), other.hash], now: later });
  assert.equal(e.state, 'replaced');
  assert.equal(e.replacedBy, other.hash);
  // The wallet offers its outbox's same-nonce entries and the history index's as candidates.
  const w = await ethWallet(app, { kv });
  w.state.history = { txs: [{ hash: other.hash, from: ME.toLowerCase(), nonce: Number(entry.nonce) }, { hash: F.h(7), from: ME.toLowerCase(), nonce: 99 }], transfers: [], error: null, at: 1 };
  assert.deepEqual(w.nonceTwins(entry), [other.hash]);
  w.state.history = { txs: [], transfers: [], error: null, at: null };
  forgetEthWallet();
});

// ---------------------------------------------------------------- the wallet object

test('wallet: the address comes from the sealed key; prefs default to Stack Wallet and history on; removal forgets everything', async () => {
  const { app, kv, ethId } = await walletWithKey();
  assert.deepEqual(ethPrefs(app).rpcId, 'stackwallet');
  assert.equal(ethPrefs(app).history, true);
  assert.equal(ethPrefs({ prefs: { ethRpc: 'publicnode', ethHistory: false } }).rpcId, 'publicnode');
  assert.equal(ethPrefs({ prefs: { ethRpc: 'evil.example' } }).rpcId, 'stackwallet', 'only listed servers');
  assert.equal(ethPrefs({ prefs: { ethHistory: false } }).history, false);
  const w = await ethWallet(app, { kv });
  assert.equal(w.state.address, ME);
  assert.equal(w.ethId, ethId);
  assert.equal(await ethWallet(app, { kv }), w, 'one object per unlocked wallet');
  await addToOutbox(app, entry(), { ethId, kv });
  assert.equal(await hasEthWallet(kv), true);
  await removeEthWallet(kv);
  assert.equal(await hasEthWallet(kv), false);
  assert.equal(kv.m.has(ETH_OUTBOX_KEY), false);
  assert.equal(kv.m.has(ETH_RECORD_KEY), false);
  assert.equal(await ethWallet(app, { kv }), null);
  await assert.rejects(ethWallet({ ...app, dbPass: null }, { kv }), (e) => e.code === 'locked');
  forgetEthWallet();
});

// ------------------------------------- BM-1: nothing new is signed while a payment is in doubt

const hx = (n) => `0x${n.repeat(32)}`;

test('BM-1: which open entries are in doubt: nonce said used with nothing shown, or bytes refused; per chain', () => {
  const list = [
    entry({ hash: hx('b1'), state: 'signed', refusedAt: 5 }),
    entry({ hash: hx('b2'), state: 'pending', unsureSince: 6 }),
    entry({ hash: hx('b3'), state: 'pending' }),
    entry({ hash: hx('b4'), state: 'signed' }),
    entry({ hash: hx('b5'), state: 'rejected', refusedAt: 5 }),
    entry({ hash: hx('b6'), state: 'confirmed', unsureSince: 6 }),
    entry({ hash: hx('b7'), state: 'signed', refusedAt: 5, chain: 'bsc', asset: 'BNB' }),
  ];
  // A moment after b4 was signed, its broadcast still waiting for its answer: in doubt too (re-audit 3 RE3-5).
  assert.deepEqual(inDoubt(list, 'ethereum', 2000).map((e) => e.hash), [hx('b1'), hx('b2'), hx('b4')]);
  assert.deepEqual(inDoubt(list, 'bsc', 2000).map((e) => e.hash), [hx('b7')]);
  assert.deepEqual(inDoubt(list, null, 2000).map((e) => e.hash), [hx('b1'), hx('b2'), hx('b4'), hx('b7')]);
});

test('BM-1: while a payment is "Not sent yet", the next one is not signed on that chain: it would take the next nonce and both could go through', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  chain.st.refuse = Object.assign(new Error('txpool is full'), { code: -32000 });
  const first = await signAndSend(app, chain.rpc, p, { ethId, kv, now: () => 1000 });
  assert.ok(first.entry.refusedAt);
  chain.st.refuse = null;
  const counts = () => chain.st.calls.filter((m) => m === 'eth_getTransactionCount').length;
  const before = counts();
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e instanceof SendError && e.code === 'in_doubt' && e.entry.hash === first.entry.hash && /not settled yet/.test(e.message) && /another .*server/i.test(e.message));
  const call = await prepareCall(chain.rpc, { from: ME, to: F.ALICE, data: '0x', value: 0n });
  await assert.rejects(signAndBroadcastCall(app, chain.rpc, call.tx, { kind: 'raw', asset: ETH, amount: 0n }, { ethId, kv }), (e) => e.code === 'in_doubt');
  assert.equal(counts(), before, 'refused before anything was signed: no nonce asked');
  assert.equal((await loadOutbox(app, { ethId, kv })).length, 1, 'nothing new saved');
  assert.deepEqual(chain.st.sends, [], 'nothing broadcast');
  // On the other chain it would be another nonce sequence: not held up.
  await updateOutbox(app, first.entry.hash, { chain: 'bsc', asset: 'BNB' }, { ethId, kv });
  const ok = await signAndSend(app, chain.rpc, p, { ethId, kv });
  assert.equal(ok.sent, true);
});

test('BM-1: "Not sure yet" holds the next payment too; once the doubt is settled it goes', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const first = await signAndSend(app, chain.rpc, p, { ethId, kv });
  await updateOutbox(app, first.entry.hash, { unsureSince: 7 }, { ethId, kv });
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e.code === 'in_doubt');
  chain.mine(first.entry.hash); // the chain agrees (XN: the server's pool is compared with what this device follows)
  await updateOutbox(app, first.entry.hash, { unsureSince: null, state: 'confirmed' }, { ethId, kv });
  assert.equal((await signAndSend(app, chain.rpc, p, { ethId, kv })).sent, true);
});

// Second audit, XN: the nonce came from the server's 'pending' count alone.
test('XN: a server that has not seen an open payment cannot put the next one in its place', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain({ nonce: 7n });
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const a = await signAndSend(app, chain.rpc, p, { ethId, kv });
  assert.equal(a.entry.nonce, '7');
  // Another server (or backend) that never saw A: its 'pending' count is still 7.
  const other = fakeChain({ nonce: 7n });
  const b = await signAndSend(app, other.rpc, p, { ethId, kv });
  assert.equal(b.entry.nonce, '8', 'one past the open payment, never in its place');
});

test('XN: a server pool holding a transaction of this wallet that this device does not follow: nothing is signed', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain({ nonce: 5n });
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  // Its pool holds one at nonce 5 (one that showed "Not sent" here, or another device's): 'pending' 6, 'latest' 5.
  chain.st.pending = 6n;
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e.code === 'in_doubt' && /holds a transaction from this wallet that this device isn't following/.test(e.message));
  assert.equal(chain.st.sends.length, 0, 'nothing signed or sent');
  // Mined: its place is used, the pool is empty again: the next one goes, at 6.
  chain.st.latest = 6n;
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  assert.equal(r.sent, true);
  assert.equal(r.entry.nonce, '6');
});

test('audit V1: one server\'s inflated count, once signed at, is no floor: the next payments take the honest count, past this device\'s own places', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const liar = fakeChain({ nonce: 1000n });
  const p = await prepareSend(liar.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const a = await signAndSend(app, liar.rpc, p, { ethId, kv });
  assert.equal(a.entry.nonce, '1000');
  // An honest server: 8 sent so far. The entry at 1000 does not push the next payments after a gap.
  const honest = fakeChain({ nonce: 8n });
  const b = await signAndSend(app, honest.rpc, p, { ethId, kv });
  assert.equal(b.entry.nonce, '8');
  const c = await signAndSend(app, fakeChain({ nonce: 8n }).rpc, p, { ethId, kv });
  assert.equal(c.entry.nonce, '9', 'past its own open place at 8');
});

test('audit L4: two entries at one place fill one place: a transaction of this wallet\'s at the next place, unknown here, still stops the signing', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain({ nonce: 5n });
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const a = await signAndSend(app, chain.rpc, p, { ethId, kv });
  // A second entry at the same place (a resend with a higher fee, say), then a pool with one more.
  await addToOutbox(app, { ...a.entry, hash: '0x' + 'ab'.repeat(32), raw: a.entry.raw }, { ethId, kv });
  chain.st.pending = 7n;
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e.code === 'in_doubt' && /isn't following/.test(e.message));
});

test('BM-1: the payment in doubt is named in words, with the way out', () => {
  assert.equal(entryWords(entry({ amount: '12500000000000000000' })), 'the payment of 12.5 ETH');
  assert.equal(entryWords(entry({ chain: 'bsc', asset: 'rsFIRO', token: '0x13cdb5f7f398f6af2cc3b34eb04476af3488853f', amount: '250000000', kind: 'swap' })), 'the swap of 2.5 rsFIRO');
  assert.equal(entryWords(entry({ asset: 'rsFIRO', token: '0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2', amount: '1', kind: 'approve' })), 'the permission for rsFIRO');
  assert.equal(entryWords(entry({ asset: 'rsFIRO', token: '0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2', amount: '300000000000', kind: 'raw', label: 'Bridge rsFIRO to FIRO' })), '"Bridge rsFIRO to FIRO" (3,000 rsFIRO)');
  assert.equal(
    doubtText(entry({ chain: 'bsc', asset: 'BNB', amount: '100000000000000000', refusedAt: 5 })),
    'Your earlier transaction on BNB Chain, the payment of 0.1 BNB, is not settled yet: the BNB Chain server refused it, but may have passed it on first. A new one could go through together with it, so Firo PWA signs nothing new on BNB Chain until it is. Wait (Firo PWA keeps checking it), or choose another BNB Chain server in the Ethereum & BNB settings to check it there.',
  );
  assert.match(doubtText(entry({ state: 'pending', unsureSince: 6 })), /the Ethereum server says another transaction took its place but can't show it\./);
});

// ------------------------------------- BM-2: "Not sent" is one server's word, never final for ever

test('BM-2: a mined history row wins over "Not sent" for the same hash (not over a proven "Replaced": RE2-5)', () => {
  const me = ME.toLowerCase();
  const hash = hx('ab');
  const tx = { hash, from: me, to: ALICE.toLowerCase(), value: 1000n, blockNumber: 123, timestamp: 1700000000, failed: false, fee: 21000n, nonce: 7 };
  const shown = mergeActivity({ address: ME, outbox: [entry({ hash, state: 'rejected', amount: '1000' })], txs: [tx], transfers: [] }).find((i) => i.hash === hash);
  assert.equal(shown.state, 'confirmed', 'rejected: the index saw it mined');
  assert.equal(shown.blockNumber, 123);
  assert.equal(mergeActivity({ address: ME, outbox: [entry({ hash, state: 'replaced', replacedBy: hx('ac'), amount: '1000' })], txs: [tx], transfers: [] }).find((i) => i.hash === hash).state, 'replaced');
  // A row the index has not seen mined does not overrule what this device decided.
  const pending = { ...tx, blockNumber: null };
  assert.equal(mergeActivity({ address: ME, outbox: [entry({ hash, state: 'rejected', amount: '1000' })], txs: [pending], transfers: [] }).find((i) => i.hash === hash).state, 'rejected');
  // An open entry stays this device's (it is followed on its own).
  assert.equal(mergeActivity({ address: ME, outbox: [entry({ hash, state: 'pending', amount: '1000' })], txs: [tx], transfers: [] }).find((i) => i.hash === hash).state, 'pending');
});

test('BM-2: the outbox learns from the index: a "Not sent" the index shows mined becomes confirmed (or failed)', () => {
  const me = ME.toLowerCase();
  const hash = hx('ac');
  const tx = { hash, from: me, to: ALICE.toLowerCase(), value: 1000n, blockNumber: 77, timestamp: 1700000000, failed: false, fee: 21000n, nonce: 7 };
  assert.deepEqual(settledByIndex(entry({ hash, state: 'rejected', refusedAt: 5 }), [tx]), { state: 'confirmed', receipt: { blockNumber: 77, status: 1, gasUsed: null, effectiveGasPrice: null }, refusedAt: null, unsureSince: null });
  assert.equal(settledByIndex(entry({ hash, state: 'rejected' }), [{ ...tx, failed: true }]).state, 'failed');
  assert.equal(settledByIndex(entry({ hash, state: 'replaced', replacedBy: hx('ad') }), [tx]), null, 'a proven "Replaced": only the receipt undoes it (RE2-5)');
  assert.equal(settledByIndex(entry({ hash, state: 'rejected' }), [{ ...tx, blockNumber: null }]), null, 'not mined: nothing to learn');
  assert.equal(settledByIndex(entry({ hash, state: 'confirmed' }), [tx]), null, 'already settled');
  assert.equal(settledByIndex(entry({ hash, state: 'rejected', chain: 'bsc', asset: 'BNB' }), [tx]), null, "the index is Ethereum's");
});

test('BM-2: a "Not sent" is looked at again now and then (slowly): mined after all, or back in the pool', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  chain.st.refuse = Object.assign(new Error('txpool is full'), { code: -32000 });
  chain.st.relayOnRefuse = true; // it passed the bytes on before saying no
  let now = 1000;
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv, now: () => now });
  await updateOutbox(app, r.entry.hash, { state: 'rejected' }, { ethId, kv });
  let e = (await loadOutbox(app, { ethId, kv }))[0];
  assert.equal(e.state, 'rejected');
  // Nothing new on the chain: still "Not sent", and not asked again before REJECTED_LOOK_MS.
  e = await recheckClosed(app, chain.rpc, e, { ethId, kv, now: () => now });
  assert.equal(e.state, 'rejected');
  chain.mine(r.entry.hash);
  const asked = chain.st.calls.length;
  now += REJECTED_LOOK_MS - 1;
  e = await recheckClosed(app, chain.rpc, e, { ethId, kv, now: () => now });
  assert.equal(e.state, 'rejected');
  assert.equal(chain.st.calls.length, asked, 'slowly: not asked again so soon');
  now += 1;
  e = await recheckClosed(app, chain.rpc, e, { ethId, kv, now: () => now });
  assert.equal(e.state, 'confirmed', 'it was mined after all');
  assert.ok(e.receipt);
  assert.equal((await loadOutbox(app, { ethId, kv }))[0].state, 'confirmed', 'and kept so');
});

test('BM-2: a "Not sent" the server holds again is open again (followed, and in doubt no more)', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  await updateOutbox(app, r.entry.hash, { state: 'rejected', refusedAt: 5 }, { ethId, kv });
  const e = await recheckClosed(app, chain.rpc, (await loadOutbox(app, { ethId, kv }))[0], { ethId, kv, now: () => 10 * REJECTED_LOOK_MS });
  assert.equal(e.state, 'pending');
  assert.equal(e.refusedAt, null);
});

// ------------------------------------- FM-8: the refusal watch backs off, and decides on two looks

test('FM-8: refused bytes are offered again with a growing wait, not every 4 seconds for half an hour', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 3n, balances: { eth: ETHER } });
  chain.st.refuse = Object.assign(new Error('txpool is full'), { code: -32000 });
  let now = 1000;
  let e = (await signAndSend(app, chain.rpc, p, { ethId, kv, now: () => now })).entry;
  const sends = () => chain.st.calls.filter((m) => m === 'eth_sendRawTransaction').length;
  // The status screen looks every 4 s.
  while (e.state === 'signed' && now - 1000 < REFUSAL_WATCH_MS + 60000) {
    now += 4000;
    e = await followOnce(app, chain.rpc, e, { ethId, kv, now: () => now });
  }
  assert.equal(e.state, 'rejected', 'still decided once half an hour of refusals is over');
  assert.ok(now - 1000 >= REFUSAL_WATCH_MS);
  assert.ok(sends() <= 40, `offered ${sends()} times, not ~450`);
  assert.ok(sends() >= 10, 'but still offered again and again');
});

test('FM-8: after a gap (locked, hidden) the first look alone never decides "Not sent": a second one must agree', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 4n, balances: { eth: ETHER } });
  chain.st.refuse = Object.assign(new Error('txpool is full'), { code: -32000 });
  let now = 1000;
  let e = (await signAndSend(app, chain.rpc, p, { ethId, kv, now: () => now })).entry;
  now += 2 * 3600 * 1000; // two hours later, the wallet unlocked again
  e = await followOnce(app, chain.rpc, e, { ethId, kv, now: () => now });
  assert.equal(e.state, 'signed', 'one look after the gap: still "Not sent yet"');
  now += 4000;
  e = await followOnce(app, chain.rpc, e, { ethId, kv, now: () => now });
  assert.equal(e.state, 'rejected', 'two looks in a row agree');
});

// ------------------------------------- FM-9: an old unproven "Replaced" is followed again

test('FM-9: a "Replaced" written before D-04 (no replacing transaction shown) opens again as "Not sure yet"; a proven one stays', async () => {
  const { app, kv, ethId } = await walletWithKey();
  await addToOutbox(app, entry({ hash: hx('c1'), state: 'replaced', createdAt: 1000 }), { ethId, kv });
  await addToOutbox(app, entry({ hash: hx('c2'), state: 'replaced', replacedBy: hx('c3'), replacedIn: 77, createdAt: 2000 }), { ethId, kv });
  const list = await loadOutbox(app, { ethId, kv });
  const old = list.find((e) => e.hash === hx('c1'));
  assert.equal(old.state, 'pending', 'followed again: it may have been mined after all');
  assert.equal(old.unsureSince, 1000, '"Not sure yet": not sent again as a new payment');
  assert.equal(list.find((e) => e.hash === hx('c2')).state, 'replaced', 'proven: stays');
  // Kept so with the next write.
  await updateOutbox(app, hx('c2'), { error: null }, { ethId, kv });
  assert.equal((await loadOutbox(app, { ethId, kv })).find((e) => e.hash === hx('c1')).state, 'pending');
});

// ------------------------------------- R-1: a doubt two servers settle does not hold a chain for ever

/**
 * BNB Chain as its public servers serve it (release re-audit PoC 1/2): one chain seen through any
 * number of servers, none keeping account state older than `window` blocks. A server can be told
 * to see the account's count otherwise (`latest`), to know a hash, or to be down.
 */
function evmChain({ key = 'bsc', window = 128 } = {}) {
  const ch = { head: 1000, takenAt: [], pool: new Map(), pending: 0n, window };
  const countAt = (n) => BigInt(ch.takenAt.filter((b) => b <= n).length);
  ch.server = (id, over = {}) => {
    const s = { id, down: false, latest: null, knows: new Set(), calls: [], ...over };
    const up = (m) => {
      s.calls.push(m);
      if (s.down) throw new EthRpcError('network', `${id} could not be reached.`);
    };
    const latest = () => (s.latest ?? countAt(ch.head));
    s.rpc = {
      chain: chainOf(key),
      host: { id, name: id, chain: key },
      async assertChain() { up('chainId'); },
      async blockNumber() { up('blockNumber'); return ch.head; },
      async getTransactionCount(_a, block = 'pending') {
        up(`count:${block}`);
        if (block === 'pending') return ch.pending > latest() ? ch.pending : latest();
        if (block === 'latest') return latest();
        const n = Number(block);
        if (n < ch.head - (s.window ?? ch.window)) throw new EthRpcError(-32000, 'missing trie node: state is not available');
        return s.latest ?? countAt(n);
      },
      async sendRawTransaction(raw) {
        up('send');
        const t = parseSignedTransaction(raw);
        if (t.tx.nonce < latest()) throw new EthRpcError(-32000, 'nonce too low');
        ch.pool.set(t.hash, raw);
        if (t.tx.nonce + 1n > ch.pending) ch.pending = t.tx.nonce + 1n;
        return t.hash;
      },
      async getTransactionReceipt() { up('receipt'); return null; },
      async getTransactionByHash(hash) { up('byHash'); return ch.pool.has(hash) || s.knows.has(hash) ? { hash, blockHash: null } : null; },
      async getBlockByNumber(n) { up('block'); return { number: n, transactions: [] }; },
    };
    return s;
  };
  /** The same key in another wallet takes the next nonce at block `at` (ours, if pooled, is evicted). */
  ch.takeNonce = (at = ch.head) => {
    ch.takenAt.push(at);
    ch.pool.clear();
  };
  return ch;
}

const bnbPayment = (amount = 10n ** 15n) => ({ asset: nativeFor('bsc'), recipient: ALICE, amount, tx: { to: ALICE, value: amount, data: '0x', gasLimit: 21000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI } });

test('R-1: another wallet took the nonce long ago and no server keeps that old state: closed as replaced once the server in use and a second one both show it used 64+ blocks deep and neither knows it; the next transaction goes', async () => {
  assert.deepEqual(NONCE_GONE_BLOCKS, { ethereum: 32, bsc: 64 });
  const { app, kv, ethId } = await walletWithKey();
  const ch = evmChain();
  const mine = ch.server('bsc-defibit');
  const second = ch.server('bsc-bnbchain');
  let now = 1_000_000;
  const first = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv, now: () => now });
  assert.equal(first.entry.state, 'pending');
  // The same words in MetaMask: the same nonce at a higher fee, mined; ours evicted. Hours pass.
  ch.takeNonce(ch.head + 120);
  ch.head += 4000;
  now += 3600 * 1000;
  const e = await followOnce(app, mine.rpc, first.entry, { ethId, kv, candidates: [], now: () => now, others: [second.rpc] });
  assert.equal(e.state, 'replaced', 'two servers: its nonce is used for good, its bytes can no longer be mined');
  assert.equal(e.replacedBy, null, 'by a transaction neither server can show');
  assert.deepEqual(e.replacedUnseen, { block: ch.head, servers: ['bsc-defibit', 'bsc-bnbchain'] });
  assert.equal(e.unsureSince, null);
  assert.ok(second.calls.includes('count:latest') && second.calls.includes('byHash') && second.calls.includes('receipt'), 'the second server was asked for the count and the hash');
  assert.ok(!second.calls.includes('send'), 'nothing is broadcast through the second server');
  const list = await loadOutbox(app, { ethId, kv });
  assert.equal(list[0].state, 'replaced', 'kept so: not reopened as an unproven "Replaced" (FM-9)');
  assert.equal(inDoubt(list, 'bsc').length, 0, 'the chain is free again');
  const next = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv, now: () => now });
  assert.equal(next.sent, true);
  assert.equal(next.entry.nonce, '1');
});

test('R-1 (release audit 0.1.5, S4): when the first other server answers, it alone is asked: the next one never learns the address', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const ch = evmChain();
  const mine = ch.server('bsc-defibit');
  const first = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv });
  ch.takeNonce(ch.head + 10);
  ch.head += 500;
  const second = ch.server('bsc-bnbchain');
  const third = ch.server('bsc-nodereal');
  const t = later();
  const e = await followOnce(app, mine.rpc, first.entry, { ethId, kv, now: () => t, others: [second.rpc, third.rpc] });
  assert.equal(e.state, 'replaced');
  assert.deepEqual(e.replacedUnseen.servers, ['bsc-defibit', 'bsc-bnbchain']);
  assert.ok(second.calls.length > 0, 'the first other server was asked');
  assert.deepEqual(third.calls, [], 'and no other');
});

test('R-1: the hold stays while only one server says so: the second disagrees, knows the hash, or none answers', async () => {
  const setup = async () => {
    const { app, kv, ethId } = await walletWithKey();
    const ch = evmChain();
    const mine = ch.server('bsc-defibit');
    const first = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv });
    ch.takeNonce(ch.head + 10);
    ch.head += 500;
    return { app, kv, ethId, ch, mine, entry: first.entry };
  };
  const look = (r, others, now = later()) => followOnce(r.app, r.mine.rpc, r.entry, { ethId: r.ethId, kv: r.kv, now: () => now, others });
  const held = async (r, e, why) => {
    assert.equal(e.state, 'pending', why);
    assert.ok(e.unsureSince, why);
    await assert.rejects(signAndSend(r.app, r.mine.rpc, bnbPayment(), { ethId: r.ethId, kv: r.kv }), (err) => err.code === 'in_doubt', why);
  };
  // The second server sees the nonce free: hold, and no third server is asked to outvote it.
  let r = await setup();
  const third = r.ch.server('bsc-nodereal');
  await held(r, await look(r, [r.ch.server('bsc-bnbchain', { latest: 0n }).rpc, third.rpc]), 'the second says the nonce is free');
  assert.deepEqual(third.calls, [], 'never shopping for a server that agrees');
  // The second server knows the payment: hold.
  r = await setup();
  const knows = r.ch.server('bsc-bnbchain');
  knows.knows.add(r.entry.hash);
  await held(r, await look(r, [knows.rpc]), 'the second knows the hash');
  // No second server answers, or none is offered: hold.
  r = await setup();
  await held(r, await look(r, [r.ch.server('bsc-bnbchain', { down: true }).rpc, r.ch.server('bsc-nodereal', { down: true }).rpc]), 'no second server answered');
  r = await setup();
  await held(r, await look(r, []), 'no second server offered');
  // A second server that is down is passed over for the next listed one, which agrees.
  r = await setup();
  const down = r.ch.server('bsc-bnbchain', { down: true });
  const next = r.ch.server('bsc-nodereal');
  assert.equal((await look(r, [down.rpc, next.rpc])).state, 'replaced');
  assert.deepEqual((await loadOutbox(r.app, { ethId: r.ethId, kv: r.kv }))[0].replacedUnseen.servers, ['bsc-defibit', 'bsc-nodereal']);
});

test('R-1: not deep yet: held; once the server in use has shown the nonce used for 64 blocks (watched, where it keeps no state that old), closed', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const ch = evmChain();
  const mine = ch.server('bsc-defibit', { window: 8 }); // keeps only 8 blocks of state
  const second = ch.server('bsc-bnbchain');
  const first = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv });
  ch.takeNonce(ch.head + 1);
  ch.head += 2;
  let e = await followOnce(app, mine.rpc, first.entry, { ethId, kv, now: later, others: [second.rpc] });
  assert.equal(e.state, 'pending', 'used two blocks ago: a reorg could still undo it');
  assert.equal(e.nonceUsedAt, ch.head, 'when this device first saw it used');
  ch.head += 40;
  e = await followOnce(app, mine.rpc, e, { ethId, kv, now: later, others: [second.rpc] });
  assert.equal(e.state, 'pending', '42 blocks: not yet');
  ch.head += 30;
  // Watched for 72 blocks on the server in use; the second shows the same 64 blocks back.
  e = await followOnce(app, mine.rpc, e, { ethId, kv, now: later, others: [second.rpc] });
  assert.equal(e.state, 'replaced');
  assert.equal(e.nonceUsedAt, null);
});

test('R-1 x FM-9: an old unproven "Replaced", reopened as "Not sure yet", is settled at its first look when two servers agree its nonce is used', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const ch = evmChain();
  for (let i = 0; i < 5; i++) ch.takeNonce(ch.head - 300 + i);
  const mine = ch.server('bsc-defibit');
  const second = ch.server('bsc-bnbchain');
  const { sk } = await ethKeyFromMnemonic(JUNK);
  const old = signTransaction({ chainId: 56n, nonce: 2n, to: ALICE, value: 1n, gasLimit: 21000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: GWEI }, sk);
  // As 0.1.1 wrote it (before D-04): the nonce alone decided "replaced", nothing named what took it.
  await addToOutbox(app, entry({ hash: old.hash, raw: old.raw, nonce: '2', chain: 'bsc', asset: 'BNB', amount: '1', state: 'replaced', createdAt: 1000, sentAt: 1001 }), { ethId, kv });
  const reopened = (await loadOutbox(app, { ethId, kv }))[0];
  assert.equal(reopened.state, 'pending');
  await assert.rejects(signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv }), (err) => err.code === 'in_doubt', 'held until its first look');
  const e = await followOnce(app, mine.rpc, reopened, { ethId, kv, now: later, others: [second.rpc] });
  assert.equal(e.state, 'replaced');
  assert.equal((await loadOutbox(app, { ethId, kv }))[0].state, 'replaced', 'and not reopened again');
  assert.equal((await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv })).sent, true);
});

test('R-1: the wallet asks the other listed servers of the chain, never the one in use, and only to settle a doubt', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const w = await ethWallet(app, { kv });
  const others = w.otherRpcs('bsc');
  assert.ok(others.length >= 1 && others.length <= 2);
  assert.ok(others.every((o) => o.host.chain === 'bsc' && o.host.id !== 'bsc-bnbchain' && RPC_HOSTS.bsc.includes(o.host)), 'never the default (BNB Chain official since PublicNode refuses receipts)');
  assert.ok(w.otherRpcs('ethereum').every((o) => o.host.chain === 'ethereum' && o.host.id !== 'stackwallet'));
  // followOpen hands them to the look (a stand-in pair here). The stand-in for the server in use has
  // its id (the default's), so the wallet keeps it rather than make a real client (no network here).
  const ch = evmChain();
  const mine = ch.server('bsc-bnbchain');
  const second = ch.server('bsc-nodereal');
  w._rpcs.bsc = mine.rpc;
  w.otherRpcs = () => [second.rpc];
  const first = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv });
  ch.takeNonce(ch.head + 1);
  ch.head += 300;
  await w.reloadOutbox();
  await w.followOpen();
  assert.equal(w.state.outbox.find((x) => x.hash === first.entry.hash).state, 'replaced');
  forgetEthWallet();
});

test('release audit 0.1.5 S2: a BNB Chain server refusing receipts holds up nothing on Ethereum; each entry keeps its own error, tagged with its chain', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const w = await ethWallet(app, { kv });
  // Ethereum (the server in use is Stack Wallet's: a stand-in with its id): a payment, then mined.
  const eth = fakeChain();
  const p = await prepareSend(eth.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1000n, balances: { eth: ETHER } });
  const ethSent = await signAndSend(app, eth.rpc, p, { ethId, kv, now: () => 1000 });
  eth.mine(ethSent.entry.hash);
  // BNB Chain, newer, so looked at first: a server that keeps receipts for paying users only.
  const ch = evmChain();
  const bnb = ch.server('bsc-bnbchain');
  bnb.rpc.getTransactionReceipt = async () => {
    throw new EthRpcError('receipts_refused', 'BNB Chain (official) no longer says whether a transaction went through.');
  };
  const bnbSent = await signAndSend(app, bnb.rpc, bnbPayment(), { ethId, kv, now: () => 2000 });
  w._rpcs.ethereum = eth.rpc;
  w._rpcs.bsc = bnb.rpc;
  await w.reloadOutbox();
  assert.deepEqual(w.state.outbox.map((e) => e.chain || 'ethereum'), ['bsc', 'ethereum'], 'the BNB Chain entry first, as the audit found it');
  await w.followOpen(); // never throws for one entry's trouble
  const byHash = (h) => w.state.outbox.find((e) => e.hash === h);
  assert.equal(byHash(ethSent.entry.hash).state, 'confirmed', 'the Ethereum payment was looked at and settled');
  assert.equal(byHash(bnbSent.entry.hash).state, 'pending', 'never confirmed without a receipt');
  const err = w.followError(bnbSent.entry.hash);
  assert.equal(err.code, 'receipts_refused');
  assert.equal(err.chain, 'bsc');
  assert.equal(err.hash, bnbSent.entry.hash);
  assert.equal(w.followError(ethSent.entry.hash), null);
  assert.deepEqual(w.followErrors('ethereum'), []);
  assert.equal(w.followErrors('bsc').length, 1);
  // The server answers receipts again: the error is gone at the next look.
  bnb.rpc.getTransactionReceipt = async () => null;
  await w.followOpen();
  assert.equal(w.followError(bnbSent.entry.hash), null);
  forgetEthWallet();
});

test('release audit 0.1.5 nit: a server that refuses receipts but has the transaction: "Sending" becomes "Waiting", never "Confirmed"; nothing is sent again', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const ch = evmChain();
  const s = ch.server('bsc-bnbchain');
  s.rpc.getTransactionReceipt = async () => {
    throw new EthRpcError('receipts_refused', 'BNB Chain (official) no longer says whether a transaction went through.');
  };
  const sent = await signAndSend(app, s.rpc, bnbPayment(), { ethId, kv });
  // As if the page had died after the broadcast answered: still "Sending" on this device.
  await updateOutbox(app, sent.entry.hash, { state: 'signed' }, { ethId, kv });
  const signed = (await loadOutbox(app, { ethId, kv }))[0];
  assert.equal(signed.state, 'signed');
  const before = s.calls.filter((c) => c === 'send').length;
  await assert.rejects(followOnce(app, s.rpc, signed, { ethId, kv }), (e) => e.code === 'receipts_refused', 'the screen still hears why');
  const after = (await loadOutbox(app, { ethId, kv }))[0];
  assert.equal(after.state, 'pending', 'the server has it: waiting for the network');
  assert.equal(after.receipt, null);
  assert.equal(s.calls.filter((c) => c === 'send').length, before, 'not sent again');
  // One the server does not know stays as it was.
  const unknown = { ...signed, hash: `0x${'77'.repeat(32)}` };
  await assert.rejects(followOnce(app, s.rpc, unknown, { ethId, kv }), (e) => e.code === 'receipts_refused');
});

test('a balance read under way is shared, never answered with the figures from before it; fresh reads again after it (e2e 2026-10-14: "Balance 0 ETH" for good)', async () => {
  const { app, kv } = await walletWithKey();
  const w = await ethWallet(app, { kv });
  let wei = 0n;
  const gates = [];
  const reads = [];
  /**
   * A stand-in Ethereum server (the default's id, so the wallet keeps it) whose balance answers wait for
   * open(). A read's figures are the chain's state at the block it asked for: taken when it asks for the
   * newest block, which is how the wallet starts a read (every figure from one block).
   */
  let atBlock = wei;
  const rpc = {
    host: { id: 'stackwallet', name: 'Stack Wallet', chain: 'ethereum' },
    async getBalance() {
      const at = atBlock;
      reads.push(at);
      await new Promise((r) => gates.push(r));
      return at;
    },
    async blockNumber() {
      atBlock = wei;
      return 100;
    },
    async multicall(calls) { return calls.map(() => ({ success: true, data: new Uint8Array(32) })); },
  };
  w._rpcs.ethereum = rpc;
  const open = async () => {
    while (!gates.length) await new Promise((r) => setTimeout(r, 1));
    gates.shift()();
  };
  // Home's read starts with 0 ETH; the balance changes; a swap screen opens meanwhile.
  const home = w.refreshChain('ethereum');
  wei = 2n * ETHER;
  const plain = w.refreshChain('ethereum');
  const swap = w.refreshChain('ethereum', { fresh: true });
  await open();
  assert.equal((await home).native, 0n);
  assert.equal((await plain).native, 0n, 'shares the read under way (not the figures from before it)');
  await open();
  assert.equal((await swap).native, 2n * ETHER, 'fresh: read again once that one was done');
  assert.deepEqual(reads, [0n, 2n * ETHER], 'two reads, not three');
  // refresh() shares a refresh under way too.
  w._rpcs.bsc = { ...rpc, host: { id: 'bsc-bnbchain', name: 'BNB Chain (official)', chain: 'bsc' }, async getBalance() { return 0n; } };
  app.prefs = { ...app.prefs, ethHistory: false };
  const r1 = w.refresh();
  const r2 = w.refresh();
  assert.equal(r1, r2, 'one refresh at a time, shared');
  await open();
  await r1;
  assert.equal(w.state.loading, false);
  forgetEthWallet();
});

test('S1: a permission still on its way is found (chain, token, spender), so it is followed and never asked for twice; settled ones are not', () => {
  const T = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  const P2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
  const a = (over) => entry({ kind: 'approve', token: T, spender: P2, asset: 'USDT', amount: '100', ...over });
  const list = [a({ hash: hx('a1'), state: 'pending' }), a({ hash: hx('a2'), state: 'confirmed' }), a({ hash: hx('a3'), state: 'signed', kind: 'approveReset', amount: '0' }), a({ hash: hx('a4'), state: 'pending', chain: 'bsc' }), a({ hash: hx('a5'), state: 'pending', token: '0x1111111111111111111111111111111111111111' }), entry({ hash: hx('a6'), state: 'pending' })];
  assert.deepEqual(openApprovals(list, { chain: 'ethereum', token: T.toUpperCase().replace('0X', '0x'), spender: P2 }).map((e) => e.hash), [hx('a1'), hx('a3')]);
  assert.deepEqual(openApprovals(list, { chain: 'bsc', token: T }).map((e) => e.hash), [hx('a4')]);
  assert.deepEqual(openApprovals(list, { chain: 'ethereum', token: T, spender: '0x2222222222222222222222222222222222222222' }), []);
  assert.deepEqual(openApprovals([], { chain: 'ethereum', token: T }), []);
});

test("N5: Stack Wallet's history index answer is capped like every server's", async () => {
  const huge = async () => new Response('x', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
  await assert.rejects(fetchHistory(ME, { fetch: huge }), (e) => e instanceof HistoryError && e.code === 'too_big');
});

test('N7: a broadcast the server took is "sent" even when this device cannot write it down; a refusal whose write fails is still a refusal', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1000n, balances: { eth: ETHER } });
  const first = await signAndSend(app, chain.rpc, p, { ethId, kv });
  // Storage fails from now on (quota, a locked wallet...).
  const brokenKv = { ...kv, get: kv.get, set: async () => { throw new Error('quota'); }, update: async () => { throw new Error('quota'); } };
  const again = { ...first.entry, state: 'signed', sentAt: null };
  const r = await broadcast(app, chain.rpc, again, { ethId, kv: brokenKv });
  assert.equal(r.sent, true, 'the server has it');
  assert.equal(r.entry.state, 'pending');
  chain.st.refuse = Object.assign(new Error('insufficient funds for gas'), { code: -32000 });
  const refused = await broadcast(app, chain.rpc, again, { ethId, kv: brokenKv });
  assert.equal(refused.sent, false);
  assert.ok(refused.entry.refusedAt, 'a refusal, kept in memory for the screen');
});

test('R-1 / XR: the doubt names the real ways out (it ends by itself; History from Stack Wallet when off), never removing the wallet', async () => {
  const unsure = entry({ state: 'pending', unsureSince: 6 });
  const t = doubtText(unsure, { historyOff: true });
  assert.match(t, /Turning on History from Stack Wallet/);
  assert.match(t, /ends by itself once a second Ethereum server also shows its place used for good/);
  // Removing the wallet forgets every guard on its open transactions (second audit, XR).
  assert.doesNotMatch(t, /remove|add it again/i);
  assert.doesNotMatch(doubtText(unsure), /History from Stack Wallet/, 'history on: nothing to turn on');
  assert.doesNotMatch(doubtText(entry({ state: 'pending', unsureSince: 6, chain: 'bsc', asset: 'BNB' }), { historyOff: true }), /History/, "BNB Chain has no history index");
  // The refusal before signing says it too, from the person's own settings.
  const { app, kv, ethId } = await walletWithKey();
  app.prefs = { ethHistory: false };
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const first = await signAndSend(app, chain.rpc, p, { ethId, kv });
  await updateOutbox(app, first.entry.hash, { unsureSince: 7 }, { ethId, kv });
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e.code === 'in_doubt' && /History from Stack Wallet/.test(e.message) && !/remove/i.test(e.message));
});

// ------------------------------------- RE2-5: a verified "Replaced" is not undone by the index alone

test('RE2-5: an unverified index row never overwrites a verified "Replaced"; it flips only once the server in use serves this transaction\'s receipt', async () => {
  const me = ME.toLowerCase();
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1000n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  const other = hx('d1');
  await updateOutbox(app, r.entry.hash, { state: 'replaced', replacedBy: other, replacedIn: 90 }, { ethId, kv });
  const hash = r.entry.hash;
  // Stack Wallet's index (a third party, asked plain) says this very hash was mined.
  const row = { hash, from: me, to: ALICE.toLowerCase(), value: 1000n, blockNumber: 95, timestamp: 1700000000, failed: false, fee: 21000n, nonce: 0 };
  const replaced = (await loadOutbox(app, { ethId, kv }))[0];
  assert.equal(settledByIndex(replaced, [row]), null, 'the index alone does not settle a proven "Replaced"');
  const shown = mergeActivity({ address: ME, outbox: [replaced], txs: [row], transfers: [] }).filter((i) => i.hash === hash);
  assert.deepEqual(shown.map((i) => i.state), ['replaced'], 'the list keeps what this device proved');
  // The wallet asks the server in use about it (slowly): no receipt there, it stays as it was.
  const w = await ethWallet(app, { kv });
  w._rpcs.ethereum = chain.rpc;
  w.state.history = { txs: [row], transfers: [], error: null, at: 1 };
  await w.settleFromIndex();
  assert.equal(w.state.outbox[0].state, 'replaced');
  await w.followOpen({ now: Date.now() });
  let e = (await loadOutbox(app, { ethId, kv }))[0];
  assert.equal(e.state, 'replaced');
  assert.equal(e.replacedBy, other, 'the replacement is still named');
  assert.ok(chain.st.calls.includes('eth_getTransactionReceipt'), 'asked the server in use');
  // The server in use serves its receipt: it was mined after all, and that is what counts.
  chain.mine(hash);
  e = await recheckClosed(app, chain.rpc, e, { ethId, kv, now: () => Date.now() + 2 * REJECTED_LOOK_MS });
  assert.equal(e.state, 'confirmed');
  assert.equal(e.replacedBy, null);
  assert.ok(e.receipt);
  forgetEthWallet();
});

// ------------------------------------- R-4: a broadcast with no answer is in doubt

test('R-4: a broadcast that got no answer holds the next transaction until one look finds it or sends it again', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const ch = evmChain();
  const mine = ch.server('bsc-defibit');
  // The server relays the bytes, but its answer is lost (re-audit PoC 3).
  const send = mine.rpc.sendRawTransaction;
  mine.rpc.sendRawTransaction = async (raw) => {
    await send(raw);
    throw new EthRpcError('network', 'Failed to fetch');
  };
  const first = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv });
  assert.equal(first.sent, false);
  assert.equal(first.entry.state, 'signed');
  assert.equal(first.entry.refusedAt, undefined, 'no refusal: the server never answered');
  assert.equal(inDoubt(await loadOutbox(app, { ethId, kv }), 'bsc').length, 1, 'in doubt: it may have left');
  mine.rpc.sendRawTransaction = send;
  await assert.rejects(signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv }), (e) => e.code === 'in_doubt' && /didn't answer when it was sent/.test(e.message));
  assert.equal(ch.pool.size, 1, 'nothing new signed: only the first is out there');
  // One look: the server has it. Waiting, no longer in doubt; the next takes the next nonce, knowingly.
  const e = await followOnce(app, mine.rpc, first.entry, { ethId, kv });
  assert.equal(e.state, 'pending');
  assert.equal(inDoubt(await loadOutbox(app, { ethId, kv }), 'bsc').length, 0);
  const second = await signAndSend(app, mine.rpc, bnbPayment(), { ethId, kv });
  assert.equal(second.sent, true);
  assert.equal(second.entry.nonce, '1');
  // Lost before it reached the server: one look sends the same bytes again, and the doubt ends.
  const { app: app2, kv: kv2, ethId: id2 } = await walletWithKey();
  const ch2 = evmChain();
  const other = ch2.server('bsc-defibit');
  const send2 = other.rpc.sendRawTransaction;
  other.rpc.sendRawTransaction = async () => {
    throw new EthRpcError('timeout', "didn't answer in time");
  };
  const lost = await signAndSend(app2, other.rpc, bnbPayment(), { ethId: id2, kv: kv2 });
  assert.equal(inDoubt(await loadOutbox(app2, { ethId: id2, kv: kv2 }), 'bsc').length, 1);
  other.rpc.sendRawTransaction = send2;
  assert.equal((await followOnce(app2, other.rpc, lost.entry, { ethId: id2, kv: kv2 })).state, 'pending');
  assert.equal(ch2.pool.size, 1, 'the same bytes, once');
  assert.equal(inDoubt(await loadOutbox(app2, { ethId: id2, kv: kv2 }), 'bsc').length, 0);
});

test('R-4, re-audit 3 RE3-5: a signed transaction with no answer on record is in doubt at once, whatever its age (its broadcast may be under way from another screen)', () => {
  const signed = entry({ hash: hx('e1'), state: 'signed', createdAt: 1000 });
  assert.deepEqual(inDoubt([signed], 'ethereum', 1000 + 5000).map((e) => e.hash), [hx('e1')], 'still waiting for its answer: a second signing would take the next nonce, and both could be mined');
  assert.deepEqual(inDoubt([signed], 'ethereum', 1000).map((e) => e.hash), [hx('e1')], 'from the moment it is signed');
  assert.deepEqual(inDoubt([signed], 'ethereum', 1000 + BROADCAST_ANSWER_MS + 1).map((e) => e.hash), [hx('e1')]);
  assert.deepEqual(inDoubt([{ ...signed, refusedAt: 1002 }], 'ethereum', 1003).map((e) => e.hash), [hx('e1')], 'a refusal: in doubt as before');
  assert.match(doubtText(signed, { now: 1000 + 5000 }), /is not settled yet: it is still being sent, and the Ethereum server hasn't answered yet\./, 'said as it is while it waits');
  assert.match(doubtText(signed, { now: 1000 + BROADCAST_ANSWER_MS + 1 }), /the Ethereum server didn't answer when it was sent, so it may have left/);
  assert.deepEqual(inDoubt([{ ...signed, error: 'Failed to fetch' }], 'ethereum', 1001).map((e) => e.hash), [hx('e1')], 'an error with no answer: at once');
  assert.deepEqual(inDoubt([{ ...signed, state: 'pending', sentAt: 1002 }], 'ethereum', 10 ** 9), [], 'taken by the server: not in doubt');
  assert.match(doubtText({ ...signed, error: 'Failed to fetch' }), /the Ethereum server didn't answer when it was sent, so it may have left/);
});

// ------------------------------------- R-7: "Not sent" is looked at again before the next signing

test('R-7: before signing, the recent "Not sent" ones of the chain are looked at again on the server in use: one it holds, or mined, stops the signing and is named', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  // Another server said "Not sent"; the slow re-check has just looked (nothing there then).
  await updateOutbox(app, r.entry.hash, { state: 'rejected', refusedAt: 5 }, { ethId, kv });
  chain.st.pool.delete(r.entry.hash);
  chain.st.pending = 0n;
  assert.equal((await recheckClosed(app, chain.rpc, (await loadOutbox(app, { ethId, kv }))[0], { ethId, kv })).state, 'rejected');
  // The person picks another server, which holds it: signed now, the next would take nonce 1 and both would go.
  chain.st.pool.set(r.entry.hash, r.entry.raw);
  chain.st.pending = 1n;
  const counts = () => chain.st.calls.filter((m) => m === 'eth_getTransactionCount').length;
  const before = counts();
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e instanceof SendError && e.code === 'in_doubt' && e.entry.hash === r.entry.hash && /showed "Not sent", but your Ethereum server has it after all: it is on its way/.test(e.message));
  assert.equal(counts(), before, 'refused before anything was signed');
  assert.equal((await loadOutbox(app, { ethId, kv })).find((e) => e.hash === r.entry.hash).state, 'pending', 'open again, followed');
  assert.deepEqual(chain.st.sends, [r.entry.raw], 'nothing new broadcast');
  // Told once: the person, knowing, may send again.
  assert.equal((await signAndSend(app, chain.rpc, p, { ethId, kv })).entry.nonce, '1');
  // Mined after all: said so, with its block.
  const two = await walletWithKey();
  const c2 = fakeChain();
  const p2 = await prepareSend(c2.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 2n, balances: { eth: ETHER } });
  const r2 = await signAndSend(two.app, c2.rpc, p2, { ethId: two.ethId, kv: two.kv });
  await updateOutbox(two.app, r2.entry.hash, { state: 'rejected', refusedAt: 5 }, { ethId: two.ethId, kv: two.kv });
  c2.mine(r2.entry.hash);
  await assert.rejects(signAndSend(two.app, c2.rpc, p2, { ethId: two.ethId, kv: two.kv }), (e) => e.code === 'in_doubt' && /it went through \(block 101\)/.test(e.message));
  assert.equal((await loadOutbox(two.app, { ethId: two.ethId, kv: two.kv }))[0].state, 'confirmed');
});

test('a "Not sent" whose place the chain now shows used, with nothing to show for it yet: signing waits, so nothing is paid twice', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  // Closed as "Not sent" a moment ago; the chain has since used its place (nonce 0), but this server's
  // index lags: neither the receipt nor the transaction can be seen.
  await updateOutbox(app, r.entry.hash, { state: 'rejected', refusedAt: Date.now() - 1000, lastRefusalAt: Date.now() - 1000 }, { ethId, kv });
  chain.st.pool.delete(r.entry.hash);
  chain.st.latest = 1n;
  chain.st.pending = 1n;
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e instanceof SendError && e.code === 'in_doubt' && /may have gone through after all/.test(e.message));
  assert.deepEqual(chain.st.sends, [r.entry.raw], 'nothing new broadcast');
  // Its place still free: it really was not sent, signing goes on.
  chain.st.latest = 0n;
  chain.st.pending = 0n;
  assert.equal((await signAndSend(app, chain.rpc, p, { ethId, kv })).sent, true);
});

test('a "Not sent" payment re-sent in its very place: once the server shows the re-sent one mined, signing goes on; until then, and for a "replaced" one, it waits', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  await updateOutbox(app, r.entry.hash, { state: 'rejected', refusedAt: Date.now() - 1000, lastRefusalAt: Date.now() - 1000 }, { ethId, kv });
  // The person sent it again (B): nonce 0 again, still 'pending' here.
  chain.st.pool.delete(r.entry.hash);
  chain.st.latest = 0n;
  chain.st.pending = 0n;
  const p2 = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 2n, balances: { eth: ETHER } });
  const b = await signAndSend(app, chain.rpc, p2, { ethId, kv });
  assert.equal(b.entry.nonce, '0');
  assert.notEqual(b.entry.hash, r.entry.hash);
  // The place is used, but by which? Nothing shows yet: wait (A may be the one mined, and B dropped).
  chain.st.pool.delete(b.entry.hash);
  chain.st.latest = 1n;
  chain.st.pending = 1n;
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e.code === 'in_doubt' && /may have gone through after all/.test(e.message));
  // Marked "replaced" (something else took B's place, maybe A): still waits.
  await updateOutbox(app, b.entry.hash, { state: 'replaced', replacedBy: null, replacedIn: null, replacedUnseen: { block: 100, servers: [] } }, { ethId, kv });
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e.code === 'in_doubt');
  // B open again and shown mined on this server: B used the place, A never went through.
  await updateOutbox(app, b.entry.hash, { state: 'pending', replacedUnseen: null }, { ethId, kv });
  chain.mine(b.entry.hash);
  const c = await signAndSend(app, chain.rpc, p, { ethId, kv });
  assert.equal(c.sent, true, 'not refused');
});

test('a used place explained by our own transaction, or one closed long ago, never holds up signing', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  await updateOutbox(app, r.entry.hash, { state: 'rejected', refusedAt: 5, lastRefusalAt: 5 }, { ethId, kv });
  chain.st.pool.delete(r.entry.hash);
  chain.st.latest = 1n;
  chain.st.pending = 1n;
  assert.equal((await signAndSend(app, chain.rpc, p, { ethId, kv })).sent, true, 'closed long ago: not waited for');
});

test('R-7: the look before signing: the server down refuses (nothing signed); old "Not sent" ones and other chains are not asked', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 1n, balances: { eth: ETHER } });
  const r = await signAndSend(app, chain.rpc, p, { ethId, kv });
  await updateOutbox(app, r.entry.hash, { state: 'rejected', refusedAt: 5 }, { ethId, kv });
  chain.st.pool.clear();
  chain.st.pending = chain.st.latest; // gone from the pool too (XN compares the pool with what this device follows)
  chain.st.down = 'eth_getTransactionReceipt';
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e.code === 'server' && /earlier transaction that showed "Not sent"/.test(e.message));
  chain.st.down = null;
  const receipts = () => chain.st.calls.filter((m) => m === 'eth_getTransactionReceipt').length;
  // On BNB Chain: not asked before an Ethereum signing.
  await updateOutbox(app, r.entry.hash, { chain: 'bsc', asset: 'BNB' }, { ethId, kv });
  let asked = receipts();
  assert.equal((await signAndSend(app, chain.rpc, p, { ethId, kv })).sent, true);
  assert.equal(receipts(), asked);
  // Past its re-check window: not asked either.
  await updateOutbox(app, r.entry.hash, { chain: 'ethereum', asset: 'ETH', createdAt: Date.now() - REJECTED_FOLLOW_MS - 1 }, { ethId, kv });
  asked = receipts();
  assert.equal((await signAndSend(app, chain.rpc, p, { ethId, kv })).sent, true);
  assert.equal(receipts(), asked);
});

test('R-7: trimming the outbox never drops a "Not sent" still inside its re-check window', () => {
  const now = 10 ** 12;
  const word64 = (i) => `0x${i.toString(16).padStart(64, '0')}`;
  const confirmed = Array.from({ length: OUTBOX_MAX + 20 }, (_, i) => entry({ hash: word64(i + 1), state: 'confirmed', createdAt: now - 1000 - i }));
  const recent = entry({ hash: hx('f0'), state: 'rejected', createdAt: now - 3 * 24 * 3600 * 1000 });
  const stale = entry({ hash: hx('f1'), state: 'rejected', createdAt: now - REJECTED_FOLLOW_MS - 1 });
  const open = entry({ hash: hx('f2'), state: 'pending', createdAt: now - REJECTED_FOLLOW_MS - 5 });
  const kept = trimOutbox([...confirmed, recent, stale, open], now);
  assert.ok(kept.includes(recent), 'still re-checked: kept');
  assert.ok(kept.includes(open), 'open: kept');
  assert.ok(!kept.includes(stale), 'past its window: may go');
  assert.equal(kept.length, OUTBOX_MAX);
});

// ------------------------------------- R-8: a lost waiting transaction is offered again, slowly

test('R-8: a waiting transaction the server lost is offered again with a growing wait, not on every look', async () => {
  const { app, kv, ethId } = await walletWithKey();
  const chain = fakeChain();
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 8n, balances: { eth: ETHER } });
  let e = (await signAndSend(app, chain.rpc, p, { ethId, kv })).entry;
  assert.equal(e.state, 'pending');
  const sends = () => chain.st.calls.filter((m) => m === 'eth_sendRawTransaction').length;
  const before = sends();
  let now = Date.now();
  // The status screen looks every 4 s for ten minutes; the server keeps losing it.
  for (let i = 0; i < 150; i++) {
    chain.st.pool.delete(e.hash);
    now += 4000;
    e = await followOnce(app, chain.rpc, e, { ethId, kv, now: () => now });
    assert.equal(e.state, 'pending', 'still waiting: the same bytes, never re-signed');
  }
  const offered = sends() - before;
  assert.ok(offered <= 12, `offered ${offered} times, not 150`);
  assert.ok(offered >= 5, 'but still offered again and again');
  // Held by the server again: the wait starts over the next time it is lost.
  chain.st.pool.set(e.hash, e.raw);
  now += 4000;
  e = await followOnce(app, chain.rpc, e, { ethId, kv, now: () => now });
  chain.st.pool.delete(e.hash);
  const again = sends();
  now += 4000;
  await followOnce(app, chain.rpc, e, { ethId, kv, now: () => now });
  assert.equal(sends(), again + 1, 'lost again: offered at once');
});

test('release audit 0.1.5: a second tap while a run is under way starts nothing (the Allow button)', async () => {
  const { oneAtATime } = await import('../../src/lib/dom.js');
  let runs = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const allow = oneAtATime(async () => {
    runs++;
    await gate;
    return 'done';
  });
  const first = allow();
  assert.equal(allow.running, true);
  assert.equal(await allow(), undefined, 'the second tap: nothing');
  assert.equal(runs, 1);
  release();
  assert.equal(await first, 'done');
  assert.equal(allow.running, false);
  await allow();
  assert.equal(runs, 2, 'a tap after it ended runs again');
  // A run that throws lets go too.
  const bad = oneAtATime(async () => {
    throw new Error('x');
  });
  await assert.rejects(bad());
  assert.equal(bad.running, false);
});

// ---------------------------------------------------------------- permissions followed by the chain's word

/**
 * A chain for one account and one token allowance, block by block, behind servers whose backends may
 * lag: chain.head moves; each backend answers at most up to its own head (a block past it is refused,
 * as a geth "header not found"); a backend asked for 'latest' answers its own head.
 * history: [{block, count, allowance}] ascending: the state from that block on.
 */
function approvalChain(history) {
  const at = (n) => [...history].reverse().find((x) => x.block <= n);
  const backend = (lag = 0) => {
    const own = () => Math.max(...history.map((x) => x.block)) - lag;
    const blockOf = (b) => {
      if (b === 'latest' || b === undefined) return own();
      if (b > own()) throw new EthRpcError(-32000, 'header not found');
      return b;
    };
    return {
      async blockNumber() { return own(); },
      async getTransactionCount(_owner, b) { return at(blockOf(b)).count; },
      allowance: async (b) => at(blockOf(b)).allowance,
    };
  };
  return { backend };
}

test('S1/S2 (verification 3): an earlier permission is on its way by the chain\'s word at ONE block: its nonce unused there and the allowance there below what it sets', async () => {
  const e = entry({ kind: 'approve', nonce: '5', amount: '100', state: 'pending' });
  const owner = ME;
  const ask = (b) => approvalOnItsWay(b, e, { owner, allowance: b.allowance });
  // Not mined: on its way. Mined (its nonce used): not. In effect: not.
  assert.equal(await ask(approvalChain([{ block: 10, count: 5n, allowance: 0n }]).backend()), true);
  assert.equal(await ask(approvalChain([{ block: 10, count: 5n, allowance: 0n }, { block: 11, count: 6n, allowance: 0n }]).backend()), false, 'mined, already used up by a swap');
  assert.equal(await ask(approvalChain([{ block: 10, count: 5n, allowance: 100n }]).backend()), false, 'in effect');
  // The reset step sets 0.
  const reset = entry({ kind: 'approveReset', nonce: '5', amount: '0', state: 'pending' });
  assert.equal(await approvalOnItsWay(approvalChain([{ block: 10, count: 5n, allowance: 0n }]).backend(), reset, { owner, allowance: async () => 0n }), false);
  // A server that cannot answer: still on its way (nothing offered twice on a guess).
  const down = { blockNumber: async () => { throw new Error('down'); } };
  assert.equal(await approvalOnItsWay(down, e, { owner, allowance: async () => 0n }), true);
});

test('audit L6: a permission whose failed receipt only one server shows is in doubt, never "used"', async () => {
  const { lookAtApproval } = await import('../../src/lib/eth/send.js');
  const e = entry({ hash: hx('c2'), kind: 'approve', nonce: '5', amount: '100', state: 'pending' });
  // Its place is used (count 6) and no allowance: the server shows it failed; no second one has said so yet.
  const chain = approvalChain([{ block: 12, count: 6n, allowance: 0n }]);
  const b = chain.backend();
  const seen = { ...e, failedSeen: { block: 12, said: 'none' } };
  const look = await lookAtApproval(b, e, { owner: ME, allowance: b.allowance, settle: async () => {}, current: () => seen });
  assert.deepEqual([look.done, look.unsure], [false, true]);
  // Two servers agree it failed: it is over.
  const failed = { ...e, state: 'failed' };
  const over = await lookAtApproval(b, e, { owner: ME, allowance: b.allowance, settle: async () => {}, current: () => failed });
  assert.deepEqual([over.done, over.success, over.state], [true, false, 'failed']);
});

test('blocker + S2 (verification 2/3): a block landing between the reads, or a backend behind another, never makes a permission in effect read as "used"', async () => {
  const { lookAtApproval } = await import('../../src/lib/eth/send.js');
  const e = entry({ hash: hx('c1'), kind: 'approve', nonce: '5', amount: '100', state: 'pending' });
  // The permission is mined in block 11.
  const chain = approvalChain([{ block: 10, count: 5n, allowance: 0n }, { block: 11, count: 6n, allowance: 100n }]);
  let lookedAgain = 0;
  const opts = (b) => ({ owner: ME, allowance: b.allowance, settle: async () => {}, current: () => (lookedAgain++, e) });
  // One backend: head 11, both reads at 11: in effect.
  const one = chain.backend();
  const look = await lookAtApproval(one, e, opts(one));
  assert.deepEqual([look.done, look.success, look.block], [true, true, 11]);
  assert.equal(lookedAgain, 0, 'decided from one block, the used branch never entered');
  // Load-balanced: the head and the count from a fresh backend, the allowance from one a block behind.
  // Before (reads not tied to a block): count 6 and allowance 0 -> "used", a second permission offered.
  // Now the stale backend is asked for block 11, which it does not have: an error, never "used".
  const fresh = chain.backend(0);
  const stale = chain.backend(1);
  const mixed = { blockNumber: fresh.blockNumber, getTransactionCount: fresh.getTransactionCount };
  await assert.rejects(lookAtApproval(mixed, e, { ...opts(stale), allowance: stale.allowance }), /header not found/);
  // And the follow pass takes that error as "look again".
  const r = await approvalPass({ rpc: mixed, entry: e, owner: ME, allowance: stale.allowance, follow: async (x) => x, settle: async () => {}, current: () => e });
  assert.equal(r.kind, 'retry');
});

test('the follow pass (both chains): receipt first, then the chain; each outcome as the settled entry says (S1/N2/N3 verification 3)', async () => {
  const base = entry({ hash: hx('d1'), kind: 'approve', nonce: '5', amount: '100', state: 'pending' });
  const run = (over) => approvalPass({ rpc: over.rpc, entry: base, owner: ME, allowance: over.allowance, follow: over.follow || (async (x) => x), settle: over.settle || (async () => {}), current: over.current || (() => base) });
  // Confirmed by its receipt: the allowance read AT the receipt's block. A backend behind that block
  // refuses it (look again) instead of answering the figure from before the permission (S1).
  const chain = approvalChain([{ block: 10, count: 5n, allowance: 0n }, { block: 11, count: 6n, allowance: 100n }]);
  const confirmed = { ...base, state: 'confirmed', receipt: { blockNumber: 11, status: 1 } };
  const ok = await run({ rpc: chain.backend(), allowance: chain.backend().allowance, follow: async () => confirmed });
  assert.deepEqual([ok.kind, ok.allowance], ['effect', 100n]);
  const behind = chain.backend(1);
  const retry = await run({ rpc: behind, allowance: behind.allowance, follow: async () => confirmed });
  assert.equal(retry.kind, 'retry', 'a lagging backend: looked at again, never the old figure');
  // Refused by the chain, replaced, never sent: gone, said as it is, with the allowance as read.
  for (const state of ['failed', 'replaced', 'rejected']) {
    const g = await run({ rpc: chain.backend(), allowance: chain.backend().allowance, follow: async () => ({ ...base, state }) });
    assert.deepEqual([g.kind, g.state], ['gone', state]);
  }
  // Receipts refused, nonce used at the head, permission in effect: in effect (the chain's word).
  const refused = async () => {
    throw Object.assign(new Error('NodeReal no longer says whether a transaction went through.'), { code: 'receipts_refused' });
  };
  const inEffect = await run({ rpc: chain.backend(), allowance: chain.backend().allowance, follow: refused });
  assert.equal(inEffect.kind, 'effect');
  // Nonce used, not in effect, the entry settling to "confirmed": it went through (then used up): the
  // allowance read again at the block that confirmed it (the BNB Chain screen's re-read after settling).
  const usedUp = approvalChain([{ block: 10, count: 5n, allowance: 0n }, { block: 11, count: 6n, allowance: 100n }, { block: 12, count: 7n, allowance: 0n }]);
  let settledTo = base;
  const after = await run({ rpc: usedUp.backend(), allowance: usedUp.backend().allowance, follow: refused, settle: async () => { settledTo = confirmed; }, current: () => settledTo });
  assert.deepEqual([after.kind, after.allowance], ['effect', 0n], 'it went through, and the allowance now (no older than its block) is what is left: used up');
  // Nonce used, not in effect, nothing better known: "used" (hedged words on screen).
  const used = await run({ rpc: usedUp.backend(), allowance: usedUp.backend().allowance, follow: refused });
  assert.deepEqual([used.kind, used.state], ['gone', 'used']);
  // Its server says its place was taken but shows nothing (unsureSince): on its way, never "used" (N2).
  const unsure = { ...base, unsureSince: 7 };
  const u = await run({ rpc: usedUp.backend(), allowance: usedUp.backend().allowance, follow: async () => unsure, current: () => unsure });
  assert.deepEqual([u.kind, u.unsure], ['waiting', true]);
  // Still on its way, receipts refused: waiting, and the refusal said.
  const pending = approvalChain([{ block: 10, count: 5n, allowance: 0n }]);
  const w8 = await run({ rpc: pending.backend(), allowance: pending.backend().allowance, follow: refused });
  assert.equal(w8.kind, 'waiting');
  assert.equal(w8.receiptsRefused.code, 'receipts_refused');
});

test('S1 (verification 3): the allowance before a new permission is read at a block no older than the one that confirmed the last', async () => {
  const chain = approvalChain([{ block: 10, count: 5n, allowance: 0n }, { block: 11, count: 6n, allowance: 100n }]);
  const fresh = chain.backend();
  assert.equal(await allowanceNotBefore(fresh, 11, fresh.allowance, { waitMs: 1 }), 100n);
  const behind = chain.backend(1);
  await assert.rejects(allowanceNotBefore(behind, 11, behind.allowance, { tries: 2, waitMs: 1 }), (e) => e.code === 'behind');
  let calls = 0;
  const catching = { blockNumber: async () => (++calls < 3 ? 10 : 11), allowance: fresh.allowance };
  assert.equal(await allowanceNotBefore(catching, 11, catching.allowance, { waitMs: 1 }), 100n, 'it waits for the backend to catch up');
});


test('S1 (final): a confirmed permission is read in effect on a server that keeps only recent state (never "exactly at" an old block)', async () => {
  // BNB Chain's public servers keep ~128 blocks of state: block 11 is long gone at head 300.
  const at = (n) => (n >= 11 ? 100n : 0n);
  const pruned = {
    blockNumber: async () => 300,
    getTransactionCount: async () => 6n,
    allowance: async (b) => {
      if (b < 300 - 128) throw new EthRpcError(-32000, 'missing trie node');
      return at(b);
    },
  };
  const base = entry({ hash: hx('e1'), kind: 'approve', nonce: '5', amount: '100', state: 'pending' });
  const confirmed = { ...base, state: 'confirmed', receipt: { blockNumber: 11, status: 1 } };
  const r = await approvalPass({ rpc: pruned, entry: base, owner: ME, allowance: pruned.allowance, follow: async () => confirmed, settle: async () => {}, current: () => confirmed });
  assert.deepEqual([r.kind, r.allowance], ['effect', 100n], 'read at the newest block, which is past block 11');
  // Seen in effect without a receipt (a server that keeps receipts to itself): the block is remembered.
  const remembered = [];
  const shown = await approvalPass({ rpc: pruned, entry: base, owner: ME, allowance: pruned.allowance, follow: async () => base, settle: async () => {}, current: () => base, remember: (b) => remembered.push(b) });
  assert.equal(shown.kind, 'effect');
  assert.deepEqual(remembered, [300]);
});

test('permissionMinBlock: the newest block a permission for that token (and spender) is known in effect: a confirmed receipt, or seen in effect', async () => {
  const { permissionMinBlock } = await import('../../src/lib/eth/permission.js');
  const T = '0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2';
  const P = '0x000000000022d473030f116ddee9f6b43ac78ba3';
  const list = [
    entry({ hash: hx('f1'), kind: 'approve', token: T, spender: P, state: 'confirmed', receipt: { blockNumber: 11 } }),
    entry({ hash: hx('f2'), kind: 'approve', token: T, spender: P, state: 'pending', seenInEffectAt: 15 }),
    entry({ hash: hx('f3'), kind: 'approve', token: T, spender: '0x2222222222222222222222222222222222222222', state: 'confirmed', receipt: { blockNumber: 90 } }),
    entry({ hash: hx('f4'), kind: 'approve', token: T, spender: P, state: 'confirmed', receipt: { blockNumber: 80 }, chain: 'bsc' }),
  ];
  assert.equal(permissionMinBlock(list, { chain: 'ethereum', token: T, spender: P }), 15);
  assert.equal(permissionMinBlock(list, { chain: 'bsc', token: T }), 80);
  assert.equal(permissionMinBlock([], { chain: 'ethereum', token: T }), 0);
  // A confirmed swap paying with that token used the permission up: a backend behind it still shows it.
  const swaps = [
    ...list,
    entry({ hash: hx('f5'), kind: 'swap', token: T, state: 'confirmed', receipt: { blockNumber: 120 } }),
    entry({ hash: hx('f6'), kind: 'swap', token: '0x3333333333333333333333333333333333333333', state: 'confirmed', receipt: { blockNumber: 500 } }),
    entry({ hash: hx('f7'), kind: 'swap', token: T, state: 'confirmed', receipt: { blockNumber: 130 }, chain: 'bsc' }),
    entry({ hash: hx('f8'), kind: 'swap', token: T, state: 'pending' }),
  ];
  assert.equal(permissionMinBlock(swaps, { chain: 'ethereum', token: T, spender: P }), 120, "a swap names no spender; another token's swap does not count");
  assert.equal(permissionMinBlock(swaps, { chain: 'bsc', token: T }), 130);
});

test('release verification 0.1.8: one signing at a time per chain: a second transaction while one is signed and sent is refused (busy) with nothing signed; another chain is not held', async () => {
  const { app, kv, ethId } = await walletWithKey();
  let release;
  const held = new Promise((r) => (release = r));
  const chain = fakeChain({ onSend: () => held });
  const p = await prepareSend(chain.rpc, { from: ME, asset: ETH, recipient: F.ALICE, amount: 10n ** 16n, balances: { eth: ETHER } });
  const first = signAndSend(app, chain.rpc, p, { ethId, kv });
  // The same payment again (a stale review), and a contract call, while the first is being broadcast.
  await assert.rejects(signAndSend(app, chain.rpc, p, { ethId, kv }), (e) => e instanceof SendError && e.code === 'busy' && /Another Ethereum transaction from this wallet is being signed and sent right now, so this one was not\./.test(e.message));
  await assert.rejects(signAndBroadcastCall(app, chain.rpc, p.tx, { kind: 'raw', asset: ETH, amount: 1n }, { ethId, kv }), (e) => e instanceof SendError && e.code === 'busy');
  // BNB Chain has its own queue: not held by Ethereum's.
  const bnb = evmChain().server('bsc-one');
  assert.equal((await signAndSend(app, bnb.rpc, bnbPayment(), { ethId, kv })).sent, true);
  release();
  const r = await first;
  assert.equal(r.sent, true);
  assert.equal((await loadOutbox(app, { ethId, kv })).filter((e) => (e.chain ?? 'ethereum') === 'ethereum').length, 1, 'one Ethereum transaction signed');
  // Once it has gone, the next one is signed.
  chain.mine(r.entry.hash);
  await followOnce(app, chain.rpc, r.entry, { ethId, kv });
  assert.equal((await signAndSend(app, chain.rpc, p, { ethId, kv })).sent, true);
});

test('PN: address poisoning: transfers of nothing (and 0 ETH sent here by others) never reach the history', () => {
  const me = ME.toLowerCase();
  const look = '0x70997970c51812dc3a010c7d01b50e0d17dc79c9'; // one character from ALICE
  const pad = (a) => `0x000000000000000000000000${a.slice(2)}`;
  const word = (n) => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
  const tok = TOKENS.find((t) => t.symbol === 'rsFIRO');
  const logs = { data: [
    { transactionHash: hx('a1'), address: tok.address, topics: [TRANSFER_TOPIC, pad(me), pad(look)], data: word(0), blockNumber: 10, logIndex: 0 },
    { transactionHash: hx('a2'), address: tok.address, topics: [TRANSFER_TOPIC, pad(look), pad(me)], data: word(0), blockNumber: 11, logIndex: 0 },
    { transactionHash: hx('a3'), address: tok.address, topics: [TRANSFER_TOPIC, pad(ALICE.toLowerCase()), pad(me)], data: word(5), blockNumber: 12, logIndex: 0 },
  ] };
  assert.deepEqual(parseTokenTransfers(logs, ME, tok).map((t) => t.hash), [hx('a3')]);
  const txs = { data: [
    { hash: hx('b1'), from: look, to: me, value: '0x0', blockNumber: 13 },
    { hash: hx('b2'), from: me, to: tok.address, value: '0x0', input: '0x095ea7b3', blockNumber: 14 },
    { hash: hx('b3'), from: ALICE.toLowerCase(), to: me, value: '0x5', blockNumber: 15 },
  ] };
  assert.deepEqual(parseTransactions(txs, ME).map((t) => t.hash), [hx('b2'), hx('b3')], 'our own 0-ETH call stays; theirs goes');
});

test('X-misc: the signed bytes are read back before anything is saved: signer, chain, nonce, payee, value, data, gas, fees', async () => {
  const { checkSigned } = await import('../../src/lib/eth/send.js');
  const { sk } = await ethKeyFromMnemonic('test test test test test test test test test test test junk');
  const want = { chainId: 1n, nonce: 7n, to: ALICE, value: 10n ** 16n, data: '0x', gasLimit: 21000n, maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: GWEI };
  const s = signTransaction(want, sk);
  assert.doesNotThrow(() => checkSigned(s, want, ME));
  for (const [k, v] of [['value', 10n ** 17n], ['nonce', 8n], ['chainId', 56n], ['to', ME], ['gasLimit', 21001n], ['maxFeePerGas', GWEI], ['data', '0x00']]) {
    assert.throws(() => checkSigned(s, { ...want, [k]: v }, ME), (e) => e.code === 'server' && /did not say what was reviewed/.test(e.message), k);
  }
  assert.throws(() => checkSigned(s, want, ALICE), /did not say what was reviewed/, 'another signer');
  assert.throws(() => checkSigned({ ...s, hash: `0x${'00'.repeat(32)}` }, want, ME), /did not say what was reviewed/, 'another hash');
  assert.throws(() => checkSigned({ ...s, raw: '0x02c0' }, want, ME), /could not be read back/);
  // A token transfer: its calldata comes as bytes (abi encodeCall), and passes as it is.
  const call = transferCall(RSFIRO, ALICE, 125n * 10n ** 7n);
  const tokenWant = { chainId: 1n, nonce: 8n, to: call.to, value: 0n, data: call.data, gasLimit: 60000n, maxFeePerGas: 30n * GWEI, maxPriorityFeePerGas: GWEI };
  const ts = signTransaction(tokenWant, sk);
  assert.doesNotThrow(() => checkSigned(ts, tokenWant, ME));
  assert.throws(() => checkSigned(ts, { ...tokenWant, data: transferCall(RSFIRO, ALICE, 1n).data }, ME), /did not say what was reviewed/);
});
