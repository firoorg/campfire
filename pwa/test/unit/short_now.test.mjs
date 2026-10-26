// Just before a permission is signed, what the wallet can spend is read again (lib/eth/short_now.js):
// a permission for a swap that can no longer happen would pay its network fee for nothing (the BEAM
// web wallet's release audit, SF1, ported). The real wallet's figures over a scripted read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RSFIRO } from '../../src/lib/eth/tokens.js';

const { EthWallet } = await import('../../src/lib/eth/wallet.js');
const { shortNow } = await import('../../src/lib/eth/short_now.js');

const ME = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ETHER = 10n ** 18n;

/** A wallet whose next read (refreshChain) finds `next`: {eth, rsfiro, error}. */
function walletReading(next, outbox = []) {
  const w = Object.create(EthWallet.prototype);
  w.reads = [];
  return Object.assign(w, {
    state: { outbox, address: ME, chains: { ethereum: { native: ETHER, tokens: new Map([['rsFIRO', 10n ** 10n]]), checkedAt: 1, block: 100, minedNonce: 0n } } },
    refreshChain: async (k, opts) => {
      w.reads.push({ k, fresh: Boolean(opts && opts.fresh) });
      const c = w.state.chains[k];
      if (next.error) c.error = { message: next.error };
      else {
        c.error = null;
        if (next.eth !== undefined) c.native = next.eth;
        if (next.rsfiro !== undefined) c.tokens = new Map([['rsFIRO', next.rsfiro]]);
      }
      return c;
    },
  });
}

test('enough of the token and of ETH for the fees: nothing to say; the balances were read again, fresh', async () => {
  const w = walletReading({});
  assert.equal(await shortNow(w, 'ethereum', { asset: RSFIRO, amount: 10n ** 9n, fees: 10n ** 15n }), null);
  assert.deepEqual(w.reads, [{ k: 'ethereum', fresh: true }]);
});

test('the token spent meanwhile (another device): said, with what can be used now', async () => {
  const w = walletReading({ rsfiro: 5n * 10n ** 8n });
  const why = await shortNow(w, 'ethereum', { asset: RSFIRO, amount: 10n ** 9n, fees: 10n ** 15n });
  assert.match(why, /^Not enough rsFIRO for this swap: 5 can be used now, and it needs 10\./);
});

test('ETH for the fees gone: said; what open transactions hold is left out', async () => {
  const w = walletReading({ eth: 2n * 10n ** 15n }, [{ hash: `0x${'11'.repeat(32)}`, chain: 'ethereum', state: 'pending', kind: 'send', nonce: '0', amount: String(15n * 10n ** 14n), gasLimit: '21000', maxFeePerGas: '1000000000' }]);
  const why = await shortNow(w, 'ethereum', { asset: RSFIRO, amount: 10n ** 9n, fees: 10n ** 15n });
  assert.match(why, /^Not enough ETH for the permission's network fee/);
});

test('a read that fails, or a balance not known: never "enough" on a guess', async () => {
  assert.match(await shortNow(walletReading({ error: 'too many requests' }), 'ethereum', { asset: RSFIRO, amount: 1n, fees: 1n }), /^Couldn't read your balance just before signing: too many requests/);
  assert.match(await shortNow(walletReading({ rsfiro: null }), 'ethereum', { asset: RSFIRO, amount: 1n, fees: 1n }), /^Couldn't read your rsFIRO balance/);
});

test('freeNow: what can be spent after a fresh read; a failed read throws, never the old figures', async () => {
  const { freeNow } = await import('../../src/lib/eth/short_now.js');
  const w = walletReading({ rsfiro: 7n });
  assert.equal((await freeNow(w, 'ethereum')).rsFIRO, 7n);
  await assert.rejects(freeNow(walletReading({ error: 'timeout' }), 'ethereum'), (e) => e.code === 'server' && /just before signing: timeout/.test(e.message));
});

test('paying with the coin itself: the amount and the fees together', async () => {
  const { nativeFor } = await import('../../src/lib/eth/tokens.js');
  const eth = nativeFor('ethereum');
  const w = walletReading({ eth: 10n ** 16n });
  assert.equal(await shortNow(w, 'ethereum', { asset: eth, amount: 9n * 10n ** 15n, fees: 10n ** 15n, forWhat: 'this payment' }), null);
  assert.match(await shortNow(w, 'ethereum', { asset: eth, amount: 9n * 10n ** 15n, fees: 10n ** 15n + 1n, forWhat: 'this payment' }), /^Not enough ETH for this payment/);
});
