// Release audit 0.1.6 (two findings of the BEAM port's audit that apply here too):
//  - a contract's refusal is told by its words only ("execution reverted…"), never by code 3 alone:
//    MEV Blocker answers a call at a block it lacks with {"code":3,"message":"Unknown block"}. A
//    server without the block or its state is "couldn't check", never "the token refuses" / "would fail";
//  - what this wallet's open transactions already promised (their coin or tokens, and their fee at
//    most) is taken off what a new payment may use: a balance read at 'latest' still holds them, and
//    a second payment built on it fails on chain with its fee lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EthRpcError, isRevert } from '../../src/lib/eth/rpc.js';
import { chainOf } from '../../src/lib/eth/chains.js';
import { promised, openSwapOf } from '../../src/lib/eth/outbox.js';
import { prepareSend, prepareCall, SendError } from '../../src/lib/eth/send.js';
import { EthWallet } from '../../src/lib/eth/wallet.js';
import { RSFIRO_BSC, BNB, tokenBySymbol } from '../../src/lib/eth/tokens.js';
import { bigIntToBytes } from '../../src/lib/eth/hex.js';

const ME = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const TO = '0x1234567890123456789012345678901234567890';
const GWEI = 10n ** 9n;
const BNB_1 = 10n ** 18n;

test('a revert is told by its words, never by code 3 alone; a server without the block or its state, any code, is not one', () => {
  const said = (code, message) => {
    const e = new EthRpcError(code, message);
    return [isRevert(e), e.isMissingState];
  };
  assert.deepEqual(said(3, 'Unknown block'), [false, true], 'MEV Blocker at a block it lacks');
  assert.deepEqual(said(3, 'execution reverted'), [true, false]);
  assert.deepEqual(said(-32000, 'execution reverted: STF'), [true, false]);
  assert.deepEqual(said(-32015, 'Reverted 0x08c379a0'), [true, false]);
  assert.deepEqual(said(-32000, 'header not found'), [false, true]);
  assert.deepEqual(said(-32000, 'missing trie node 4f2a… (path )'), [false, true]);
  assert.deepEqual(said(-32602, 'block not found'), [false, true]);
  assert.deepEqual(said(429, 'too many requests'), [false, false]);
  // USDT's overflow check (S3): every listed Ethereum server says it one of these two ways.
  assert.deepEqual(said(-32003, 'EVM error: InvalidFEOpcode'), [true, false]);
  assert.deepEqual(said(-32000, 'invalid opcode: INVALID'), [true, false]);
  assert.deepEqual(said(3, 'execution reverted: header not found'), [false, true], 'a server\'s trouble wins over the word');
  assert.equal(isRevert(new EthRpcError('network', 'revert')), false, 'this side\'s errors are never a revert');
  assert.equal(isRevert(new Error('execution reverted')), false);
});

/** A BNB Chain server: fees, the estimate (or its error), the token's eth_call (or its error), code at an address. */
function bscServer({ estimate = 52000n, call = true, code = new Uint8Array(0) } = {}) {
  return {
    host: { name: 'BNB Chain', id: 'bsc-bnbchain', chain: 'bsc' },
    chain: chainOf('bsc'),
    call: async (m) => (m === 'eth_gasPrice' ? '0x3b9aca00' : Promise.reject(new EthRpcError(-32601, `${m} not here`))),
    estimateGas: async () => (estimate instanceof Error ? Promise.reject(estimate) : estimate),
    ethCall: async () => (call instanceof Error ? Promise.reject(call) : bigIntToBytes(1n, 32)),
    getCode: async () => code,
  };
}
const balances = { eth: BNB_1, rsFIRO: 10n ** 10n };
const UNKNOWN = new EthRpcError(3, 'Unknown block');

test('prepareSend: "Unknown block" (code 3) is the server\'s trouble, thrown as it is; only a revert is "would fail" or "refuses"', async () => {
  const send = (rpc, asset = RSFIRO_BSC, amount = 10n ** 8n) => prepareSend(rpc, { from: ME, asset, recipient: TO, amount, balances });
  await assert.rejects(send(bscServer({ estimate: UNKNOWN })), (e) => e === UNKNOWN, 'never "would fail" on a server that lacks the block');
  await assert.rejects(send(bscServer({ estimate: new EthRpcError(3, 'execution reverted: BEP20: transfer amount exceeds balance') })), (e) => e instanceof SendError && e.code === 'would_fail' && /would fail \(BEP20: transfer amount exceeds balance\)\. Nothing was sent\.$/.test(e.message));
  await assert.rejects(send(bscServer({ call: UNKNOWN })), (e) => e === UNKNOWN, 'the exact call at a block the server lacks: its trouble');
  await assert.rejects(send(bscServer({ call: new EthRpcError(-32000, 'execution reverted') })), (e) => e instanceof SendError && /contract refuses this transfer/.test(e.message));
  // The coin to an account without code: exactly 21,000 gas, whatever the server's trouble with the estimate.
  const coin = await send(bscServer({ estimate: new EthRpcError(429, 'too many requests') }), BNB, 10n ** 16n);
  assert.equal(coin.tx.gasLimit, 21000n);
  // To a contract, a busy server is never taken for a refusal, nor for 21,000.
  await assert.rejects(send(bscServer({ estimate: new EthRpcError(429, 'too many requests'), code: new Uint8Array([0x60]) }), BNB, 10n ** 16n), (e) => e instanceof EthRpcError && e.code === 429);
});

test('prepareCall: always measured; a revert is "would fail", a server without the block or state throws its own error', async () => {
  const prep = (rpc) => prepareCall(rpc, { from: ME, to: RSFIRO_BSC.address, data: '0x095ea7b3' });
  assert.equal((await prep(bscServer({ estimate: 46000n }))).gas, 46000n);
  await assert.rejects(prep(bscServer({ estimate: UNKNOWN })), (e) => e === UNKNOWN);
  await assert.rejects(prep(bscServer({ estimate: new EthRpcError(-32000, 'missing trie node 4f2a') })), (e) => e instanceof EthRpcError && !(e instanceof SendError));
  await assert.rejects(prep(bscServer({ estimate: new EthRpcError(3, 'execution reverted') })), (e) => e instanceof SendError && e.code === 'would_fail');
  // No "typical gas" way around the estimate any more.
  await assert.rejects(prepareCall(bscServer({ estimate: UNKNOWN }), { from: ME, to: TO, data: '0x', estimate: false, typicalGas: 200000n }), (e) => e === UNKNOWN);
});

/** An outbox: open and settled transactions on both chains. */
function outbox() {
  const e = (over) => ({ hash: `0x${String(over.n).padStart(64, '0')}`, from: ME, nonce: String(over.n), gasLimit: '21000', maxFeePerGas: String(GWEI), state: 'pending', chain: 'bsc', ...over });
  return [
    e({ n: 1, asset: 'BNB', token: null, amount: String(BNB_1 / 2n) }), // a payment of 0.5 BNB, on its way
    e({ n: 2, kind: 'approve', asset: 'rsFIRO', token: RSFIRO_BSC.address, amount: '100000000', gasLimit: '60000' }), // a permission: its fee only
    e({ n: 3, kind: 'swap', asset: 'rsFIRO', token: RSFIRO_BSC.address.toUpperCase().replace('0X', '0x'), amount: '3000000000', gasLimit: '200000', state: 'signed' }),
    e({ n: 0, asset: 'BNB', token: null, amount: String(BNB_1), state: 'confirmed', receipt: { blockNumber: 90, status: 1 } }), // mined long ago: in the balance already
    e({ n: 5, asset: 'ETH', token: null, amount: String(BNB_1), chain: 'ethereum' }), // another chain
  ];
}

test('promised: the coin and tokens of open transactions, and each one\'s fee at most; a permission moves no tokens; settled or other-chain ones never count', () => {
  const p = promised(outbox(), 'bsc');
  assert.equal(p.native, BNB_1 / 2n + (21000n + 60000n + 200000n) * GWEI);
  assert.deepEqual([...p.tokens], [[RSFIRO_BSC.address, 3000000000n]]);
  assert.equal(promised(outbox(), 'ethereum').native, BNB_1 + 21000n * GWEI);
  assert.equal(openSwapOf(outbox(), { chain: 'bsc', token: RSFIRO_BSC.address }).nonce, '3', 'an open swap paying rsFIRO (any address case)');
  assert.equal(openSwapOf(outbox(), { chain: 'bsc', token: null }), null, 'none paying BNB');
  assert.equal(openSwapOf(outbox(), { chain: 'ethereum', token: RSFIRO_BSC.address }), null);
});

/** The real wallet's figures over a scripted state. */
function walletWith(list, { bnb = BNB_1, rsfiro = 10n ** 10n } = {}) {
  const w = Object.create(EthWallet.prototype);
  w.state = { outbox: list, address: ME, chains: { bsc: { native: bnb, tokens: new Map([['rsFIRO', rsfiro], ['USDT', null]]), checkedAt: 1 }, ethereum: { native: 0n, tokens: new Map(), checkedAt: 1 } } };
  return w;
}

test('spendable: the balances less what open transactions hold (never below zero, a figure not read stays null); a second payment past it is refused, said as held', async () => {
  const w = walletWith(outbox());
  const s = w.spendable('bsc');
  const heldBnb = BNB_1 / 2n + 281000n * GWEI;
  assert.equal(s.eth, BNB_1 - heldBnb);
  assert.equal(s.rsFIRO, 10n ** 10n - 3000000000n);
  assert.equal(s.USDT, null, 'not read: unknown, never 0');
  assert.equal(s.held.eth, heldBnb);
  assert.deepEqual(Object.keys(s), ['eth', 'rsFIRO', 'USDT'], 'held is not one of the balances');
  assert.equal(w.spendableOf('bsc', BNB), s.eth);
  assert.equal(w.heldOf('bsc', RSFIRO_BSC), 3000000000n);
  assert.equal(walletWith(outbox(), { rsfiro: 10n ** 9n }).spendableOf('bsc', RSFIRO_BSC), 0n, 'never below zero');
  // 0.6 BNB more, the balance read at 'latest' still holding the 0.5 on its way: refused before anything is signed.
  await assert.rejects(prepareSend(bscServer({ estimate: 21000n }), { from: ME, asset: BNB, recipient: TO, amount: (BNB_1 * 6n) / 10n, balances: s }), (e) => e instanceof SendError && e.code === 'not_enough' && /^That's more than you can send now: 0\.4997\d* BNB is free\. 0\.5002\d* BNB more is held for a transaction still on its way\.$/.test(e.message));
  // rsFIRO: the 30 on their way are not there to send again.
  await assert.rejects(prepareSend(bscServer(), { from: ME, asset: RSFIRO_BSC, recipient: TO, amount: 8000000000n, balances: s }), (e) => e instanceof SendError && /70 rsFIRO is free\. 30 rsFIRO more is held/.test(e.message));
  assert.ok(await prepareSend(bscServer(), { from: ME, asset: RSFIRO_BSC, recipient: TO, amount: 7000000000n, balances: s }), 'what is free can be sent');
  assert.ok(tokenBySymbol('rsFIRO', 'bsc'));
});

// --------------------------------------- mined but still open (a server that keeps receipts to itself)

test('the mined count, when known: an entry below it is mined (in the balance already) and neither holds nor blocks; one at or above it still does; unknown keeps counting every open one', () => {
  const list = outbox(); // bsc: nonces 1 (0.5 BNB), 2 (a permission), 3 (a sale of rsFIRO), all open
  // Mined count 3: 1 and 2 are mined (their entries never closed: receipts refused); 3 is truly on its way.
  const p3 = promised(list, 'bsc', { mined: 3n });
  assert.equal(p3.native, 200000n * GWEI, 'only the sale\'s fee');
  assert.deepEqual([...p3.tokens], [[RSFIRO_BSC.address, 3000000000n]]);
  assert.equal(openSwapOf(list, { chain: 'bsc', token: RSFIRO_BSC.address, mined: 3n }).nonce, '3', 'truly on its way: still holds the next sale');
  // Mined count 4: the sale is mined too; its entry stays open for good on such a server, and holds nothing.
  const p4 = promised(list, 'bsc', { mined: 4n });
  assert.equal(p4.native, 0n);
  assert.equal(p4.tokens.size, 0);
  assert.equal(openSwapOf(list, { chain: 'bsc', token: RSFIRO_BSC.address, mined: 4n }), null, 'a mined sale no longer holds the permission');
  // Not known: every open entry counts (never an overstated balance).
  assert.deepEqual(promised(list, 'bsc', { mined: null }), promised(list, 'bsc'));
  assert.ok(openSwapOf(list, { chain: 'bsc', token: RSFIRO_BSC.address }));
});

test('S1: a transaction that confirmed (or failed) AFTER the balances were read still holds until the next read; one before it does not', () => {
  const e = (over) => ({ hash: `0x${String(over.n).padStart(64, '0')}`, from: ME, nonce: String(over.n), gasLimit: '21000', maxFeePerGas: String(GWEI), chain: 'bsc', asset: 'BNB', token: null, amount: String(BNB_1), ...over });
  const fee = 21000n * GWEI;
  // Read with mined count 5 at block 100: nonce 5 confirmed after it (the follow-up closed it between the read and the screen).
  const after = [e({ n: 5, state: 'confirmed', receipt: { blockNumber: 101, status: 1 } })];
  assert.equal(promised(after, 'bsc', { mined: 5n, block: 100 }).native, BNB_1 + fee, 'the balance read before it still holds that BNB');
  assert.equal(promised(after, 'bsc', { mined: 6n, block: 101 }).native, 0n, 'the next read has it: free');
  // A receipt at or before the read that the count disagrees with: a reorganisation, mined again soon, so
  // still held; past 64 blocks it is gone and never held for good (release audit 0.1.7, S4).
  assert.equal(promised(after, 'bsc', { mined: 5n, block: 101 }).native, BNB_1 + fee, 'reorganised at the tip: still held');
  assert.equal(promised(after, 'bsc', { mined: 5n, block: 101 + 64 }).native, BNB_1 + fee, 'within the depth: still held');
  assert.equal(promised(after, 'bsc', { mined: 5n, block: 101 + 65 }).native, 0n, 'past the depth: never held for good');
  // No count read: its receipt's block against the read's.
  assert.equal(promised(after, 'bsc', { block: 100 }).native, BNB_1 + fee, 'mined after the read');
  assert.equal(promised(after, 'bsc', { block: 101 }).native, 0n, 'mined at the read');
  // No receipt block known: the count decides.
  const noBlock = [e({ n: 5, state: 'confirmed' })];
  assert.equal(promised(noBlock, 'bsc', { mined: 5n, block: 100 }).native, BNB_1 + fee);
  assert.equal(promised(noBlock, 'bsc', { mined: 6n, block: 100 }).native, 0n);
  // The count not known: the receipt's block against the read's.
  assert.equal(promised(after, 'bsc', { mined: null, block: 100 }).native, BNB_1 + fee);
  assert.equal(promised(after, 'bsc', { mined: null, block: 101 }).native, 0n);
  assert.equal(promised(after, 'bsc', { mined: null, block: null }).native, 0n, 'nothing known: a settled one never holds for good');
  // A failed one spent only its fee.
  const failed = [e({ n: 5, state: 'failed', receipt: { blockNumber: 101, status: 0 } })];
  assert.equal(promised(failed, 'bsc', { mined: 5n, block: 100 }).native, fee);
  // Replaced or rejected ones never hold.
  assert.equal(promised([e({ n: 5, state: 'replaced' }), e({ n: 6, state: 'rejected' })], 'bsc', { mined: 5n, block: 100 }).native, 0n);
  // A swap mined after the read still blocks the next one until a read that has it.
  const swap = [e({ n: 5, kind: 'swap', token: RSFIRO_BSC.address, asset: 'rsFIRO', state: 'confirmed', receipt: { blockNumber: 101, status: 1 } })];
  assert.ok(openSwapOf(swap, { chain: 'bsc', token: RSFIRO_BSC.address, mined: 5n, block: 100 }));
  assert.equal(openSwapOf(swap, { chain: 'bsc', token: RSFIRO_BSC.address, mined: 6n, block: 101 }), null);
});

test('S2: a swap or permission mined but never closed (receipt kept back) pins the next decision to the read that has it', async () => {
  const { permissionMinBlock, walletPermissionFloor } = await import('../../src/lib/eth/permission.js');
  const e = (over) => ({ hash: `0x${String(over.n).padStart(64, '0')}`, from: ME, nonce: String(over.n), gasLimit: '21000', maxFeePerGas: String(GWEI), chain: 'bsc', state: 'pending', ...over });
  // A sale of rsFIRO, nonce 5, still 'pending' (its receipt kept back), mined as the count 6 read at block 120 says.
  const list = [e({ n: 5, kind: 'swap', token: RSFIRO_BSC.address, asset: 'rsFIRO', amount: '1' })];
  assert.equal(permissionMinBlock(list, { chain: 'bsc', token: RSFIRO_BSC.address }), 0, 'without the count: nothing to go on');
  assert.equal(permissionMinBlock(list, { chain: 'bsc', token: RSFIRO_BSC.address, mined: 6n, block: 120 }), 120, 'mined: read no older than the block that showed it');
  assert.equal(permissionMinBlock(list, { chain: 'bsc', token: RSFIRO_BSC.address, mined: 5n, block: 120 }), 0, 'not mined yet: the hold covers it, no floor');
  // A confirmed one keeps its receipt's block; the higher of the two wins.
  const both = [...list, e({ n: 4, kind: 'approve', token: RSFIRO_BSC.address, spender: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', state: 'confirmed', receipt: { blockNumber: 110, status: 1 } })];
  assert.equal(permissionMinBlock(both, { chain: 'bsc', token: RSFIRO_BSC.address, mined: 6n, block: 120 }), 120);
  assert.equal(permissionMinBlock(both, { chain: 'bsc', token: RSFIRO_BSC.address }), 110);
  // The wallet's helper reads the count and the block from its last balance read on that chain.
  const w = { state: { outbox: list, chains: { bsc: { minedNonce: 6n, block: 120 } } } };
  assert.equal(walletPermissionFloor(w, 'bsc', RSFIRO_BSC.address), 120);
  assert.equal(walletPermissionFloor({ state: { outbox: list, chains: {} } }, 'bsc', RSFIRO_BSC.address), 0);
  // Failed or "Not sent": changed nothing, no floor. Replaced: the one that took its place may have
  // changed the permission, so its block (or the newest one seen) is the floor (release audit 0.1.7).
  const sp = '0x13f4ea83d0bd40e75c8222255bc855a974568dd4';
  const closed = (state, extra = {}) => [e({ n: 3, kind: 'approve', token: RSFIRO_BSC.address, spender: sp, state, ...extra })];
  assert.equal(permissionMinBlock(closed('failed'), { chain: 'bsc', token: RSFIRO_BSC.address, mined: 6n, block: 120 }), 0);
  assert.equal(permissionMinBlock(closed('rejected'), { chain: 'bsc', token: RSFIRO_BSC.address, mined: 6n, block: 120 }), 0);
  assert.equal(permissionMinBlock(closed('replaced', { replacedIn: 115 }), { chain: 'bsc', token: RSFIRO_BSC.address }), 115);
  assert.equal(permissionMinBlock(closed('replaced', { replacedUnseen: { block: 118 } }), { chain: 'bsc', token: RSFIRO_BSC.address }), 118);
  assert.equal(permissionMinBlock(closed('replaced'), { chain: 'bsc', token: RSFIRO_BSC.address, mined: 6n, block: 120 }), 0, 'a replaced one without its block known: its own block is never pinned for good');
});

test('the wallet: its mined count read with the balances; spendable and openSwap use it; a server that cannot say leaves it unknown', async () => {
  const pending = walletWith(outbox());
  pending.state.chains.bsc.minedNonce = 3n;
  assert.equal(pending.spendable('bsc').eth, BNB_1 - 200000n * GWEI, 'mined ones are in the balance once');
  assert.equal(pending.openSwap('bsc', RSFIRO_BSC.address).nonce, '3');
  const settled = walletWith(outbox());
  settled.state.chains.bsc.minedNonce = 4n;
  assert.equal(settled.spendable('bsc').eth, BNB_1, 'nothing taken off twice');
  assert.equal(settled.spendableOf('bsc', RSFIRO_BSC), 10n ** 10n);
  assert.equal(settled.openSwap('bsc', RSFIRO_BSC.address), null);
  assert.equal(walletWith(outbox()).openSwap('bsc', RSFIRO_BSC.address).nonce, '3', 'unknown: held');

  // The read: balances and the mined count from the server in use, all at ONE block (the newest), so a
  // load-balanced server cannot answer them from backends a block apart.
  const read = async (count, { missingOnce = false } = {}) => {
    const w = Object.create(EthWallet.prototype);
    w.state = { address: ME, outbox: [], chains: { bsc: { native: null, tokens: new Map(), block: null, minedNonce: 5n, checkedAt: null, loading: false, error: null } } };
    w.listeners = new Set();
    const tokens = (await import('../../src/lib/eth/tokens.js')).tokensFor('bsc');
    const asked = [];
    let missing = missingOnce;
    w.rpcFor = () => ({
      getBalance: async (address, block) => {
        asked.push(['balance', block]);
        if (missing) {
          missing = false;
          throw new EthRpcError(-32000, 'missing trie node abc');
        }
        return BNB_1;
      },
      blockNumber: async () => 100,
      multicall: async (calls, opts) => {
        asked.push(['tokens', opts && opts.block]);
        return tokens.map(() => ({ success: true, data: bigIntToBytes(7n, 32) }));
      },
      getTransactionCount: async (address, block) => {
        asked.push(['count', block]);
        if (count instanceof Error) throw count;
        return count;
      },
    });
    const c = await w._readChain('bsc');
    return [c.native, c.minedNonce, c.error, c.block, asked];
  };
  const [native, mined, error, block, asked] = await read(9n);
  assert.deepEqual([native, mined, error, block], [BNB_1, 9n, null, 100]);
  assert.deepEqual(new Set(asked.map(([, b]) => b)), new Set([100]), 'balance, tokens and count all at block 100');
  assert.deepEqual((await read(new EthRpcError(429, 'too many requests'))).slice(0, 3), [BNB_1, null, null], 'its trouble never fails the balances; the count is unknown again, never an old one');
  // A backend without block 100 yet: asked once more, at 97, all three again at one block.
  const again = await read(9n, { missingOnce: true });
  assert.deepEqual(again.slice(0, 3), [BNB_1, 9n, null]);
  assert.deepEqual(new Set(again[4].slice(-3).map(([, b]) => b)), new Set([97]), 'the second try reads everything at 97');
});
