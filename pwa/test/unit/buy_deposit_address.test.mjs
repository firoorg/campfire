// D-16: buyfiro.app's deposit address must be an address of the coin's own chain before it is
// shown to be paid (lib/buy/deposit_address.js). Real, well-known addresses where they exist;
// otherwise addresses built here with each chain's version bytes and checksum; each one also
// mistyped (refused) and tried on the other chains (refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDepositAddressOf, isEvmAddress, knownChain, EVM_CHAINS } from '../../src/lib/buy/deposit_address.js';
import { bech32, bech32m, base58, base58xrp, createBase58check } from '../../src/vendor/noble/scure-base/index.js';
import { sha256 } from '../../src/vendor/noble/noble-hashes/sha2.js';
import { EVM_CHAINS as BUY_EVM_CHAINS } from '../../src/lib/buy/buyfiro.js';

const b58c = createBase58check(sha256);
const bytes = (n, from = 0x31) => Uint8Array.from({ length: n }, (_, i) => (from + i * 7) & 0xff);
const b58 = (prefix, n = 20) => b58c.encode(Uint8Array.from([...prefix, ...bytes(n)]));
const segwit = (hrp, v, n) => (v === 0 ? bech32 : bech32m).encode(hrp, [v, ...(v === 0 ? bech32 : bech32m).toWords(bytes(n))]);
const xrpOf = () => {
  const payload = Uint8Array.from([0, ...bytes(20)]);
  return base58xrp.encode(Uint8Array.from([...payload, ...sha256(sha256(payload)).subarray(0, 4)]));
};

/** Valid addresses per chain. */
const VALID = {
  btc: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', segwit('bc', 0, 32)],
  ltc: [b58([0x30]), b58([0x32]), segwit('ltc', 0, 20)],
  doge: [b58([0x1e]), b58([0x16])],
  dash: [b58([0x4c]), b58([0x10])],
  bch: ['bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
  zec: [b58([0x1c, 0xb8]), b58([0x1c, 0xbd]), bech32m.encode('tex', bech32m.toWords(bytes(20)))],
  tron: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', b58([0x41])],
  sol: ['So11111111111111111111111111111111111111112', base58.encode(bytes(32))],
  xrp: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', xrpOf()],
  eth: ['0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0x52908400098527886E0F7030069857D2E4169EE7', '0xdac17f958d2ee523a2206206994597c13d831ec7'],
  ton: ['EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N', `0:${'ab'.repeat(32)}`],
  stellar: [`G${'A'.repeat(55)}`],
  sui: [`0x${'5f'.repeat(32)}`],
  near: [`${'a1'.repeat(32)}`, 'campfire.near'],
};

test('every chain: its own addresses pass; mistyped, or another chain\'s, they do not', () => {
  for (const [chain, list] of Object.entries(VALID)) {
    for (const a of list) {
      assert.equal(isDepositAddressOf(a, chain), true, `${chain}: ${a}`);
      // One character changed (to another of the same alphabet) breaks the checksum or the shape.
      if (['btc', 'ltc', 'doge', 'dash', 'zec', 'tron', 'xrp'].includes(chain) || (chain === 'eth' && /[a-f]/.test(a.slice(2)) && /[A-F]/.test(a))) {
        const i = a.length - 3;
        const swapped = a.slice(0, i) + (a[i] === 'q' ? 'p' : a[i] === 'Q' ? 'P' : a[i] === '2' ? '3' : a[i] === 'a' ? 'b' : a[i] === 'A' ? 'B' : a[i] === 'z' ? 'y' : a[i] === 'r' ? 's' : a[i] === 'x' ? 'w' : '2') + a.slice(i + 1);
        assert.equal(isDepositAddressOf(swapped, chain), false, `${chain} mistyped: ${swapped}`);
      }
      for (const other of Object.keys(VALID)) {
        if (other === chain || (chain === 'btc' && other === 'bch' && /^[13]/.test(a))) continue;
        if (VALID[other].includes(a)) continue;
        // Tron, Solana and others are shapes; check only the chains with a checksum or a prefix.
        if (['btc', 'ltc', 'doge', 'dash', 'zec', 'tron', 'xrp', 'eth', 'sui'].includes(other)) assert.equal(isDepositAddressOf(a, other), false, `${chain} address taken as ${other}: ${a}`);
      }
    }
  }
});

test('Ethereum-like chains share one rule: 0x and 40 hex digits, the EIP-55 checksum when mixed case', () => {
  assert.equal(BUY_EVM_CHAINS, EVM_CHAINS, 'one list');
  for (const c of EVM_CHAINS) assert.equal(isDepositAddressOf('0x52908400098527886E0F7030069857D2E4169EE7', c), true, c);
  assert.equal(isEvmAddress('0x52908400098527886E0F7030069857D2E4169Ee7'), false, 'one letter in the wrong case');
  assert.equal(isEvmAddress('0x52908400098527886e0f7030069857d2e4169ee'), false, '39 digits');
  assert.equal(isDepositAddressOf('0x52908400098527886E0F7030069857D2E4169EE7', 'hypercore'), true);
});

test('an unknown chain gets the loose check; nothing with spaces, controls or under 20 characters', () => {
  assert.equal(knownChain('kaia'), false);
  assert.equal(isDepositAddressOf('0x52908400098527886E0F7030069857D2E4169EE7', 'kaia'), true);
  assert.equal(isDepositAddressOf('short', 'kaia'), false);
  assert.equal(isDepositAddressOf('an address with spaces in it', 'kaia'), false);
  assert.equal(isDepositAddressOf(`abc‮def${'1'.repeat(20)}`, 'kaia'), false, 'no hidden direction marks');
  assert.equal(isDepositAddressOf(null, 'btc'), false);
  assert.equal(isDepositAddressOf('', 'btc'), false);
});
