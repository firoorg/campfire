// Ports of the desktop app's test/eth/uniswap/uniswap_math_test.dart and
// uniswap_abi_test.dart: pool prices and v2's formula against what mainnet
// said on 2026-10-09, and the bytes the swap sends pinned against Foundry's
// `cast abi-encode` / `cast calldata` (the hex is the Dart test's, produced
// by cast).
import test from 'node:test';
import assert from 'node:assert/strict';
import { UniPoolState } from '../../src/lib/eth/uniswap/discovery.js';
import { v2AmountOut, poolDepth } from '../../src/lib/eth/uniswap/quoter.js';
import { UniV4Pool, UniV2Pool, UniV3Pool, UniHop, UniToken, ETH_TOKEN, poolFromJson, v3Path, sortCurrencies, topicOfAddress, addressOfTopic, minimumOf } from '../../src/lib/eth/uniswap/models.js';
import { ADDRESSES, UR_CONSTANTS } from '../../src/lib/eth/uniswap/constants.js';
import { buildPermitSingle, permitRouterInput, checkPermitSignature, allowanceCovers, approvePermit2Call } from '../../src/lib/eth/uniswap/permit2.js';
import { abiEncode, abiDecode, encodeCall } from '../../src/lib/eth/abi.js';
import { permit2DomainSeparator, signPermitSingle, permitSingleDigest } from '../../src/lib/eth/tx.js';
import { privateKeyToAddress } from '../../src/lib/eth/crypto.js';
import { bytesToHex, hexToBytes } from '../../src/lib/eth/hex.js';

// An 8-decimal ERC-20 that sorts after WETH (the vectors were made with this address).
const TKN = '0xe5acbb03d73267c03349c76ead672ee4d941f499';
const ZERO = '0x0000000000000000000000000000000000000000';
// Anvil's well-known key 0: a test key, public by design.
const ANVIL_KEY_0 = hexToBytes('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

const close = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('a v4 price from sqrtPriceX96 (2^96 must not overflow)', () => {
  const s = new UniPoolState({ sqrtPriceX96: 452332567505986722683818525n, liquidity: 1n });
  // Raw TKN per wei: (sqrtP / 2^96)^2 = 3.2595e-5, ~325,950 TKN per ETH after 18 → 8 decimals.
  close(s.price0to1, 3.2595e-5, 1e-8);
  assert.ok(Number.isFinite(s.price0to1));
});

test('a v2 price from reserves', () => {
  const s = new UniPoolState({ reserve0: 403461114461472693n, reserve1: 13022386628314n });
  close(s.price0to1, 13022386628314 / 403461114461472693, 1e-12);
  assert.equal(s.isLive, true);
  assert.equal(new UniPoolState({ reserve0: 0n, reserve1: 5n }).isLive, false);
  assert.equal(new UniPoolState({ sqrtPriceX96: 5n, liquidity: 0n }).isLive, false);
  assert.equal(new UniPoolState({}).isLive, false);
});

test("v2's getAmountOut, as the router answered", () => {
  // V2 router getAmountsOut(0.01 ETH, [WETH, TKN]) = 314038276614.
  assert.equal(v2AmountOut(10n ** 16n, 403461114461472693n, 13022386628314n), 314038276614n);
  assert.equal(v2AmountOut(0n, 1n, 1n), 0n);
});

test('depth is comparable within a pair', () => {
  assert.equal(poolDepth(new UniPoolState({ reserve0: 4n * 10n ** 18n, reserve1: 9n * 10n ** 18n })), 6n * 10n ** 18n);
  assert.equal(poolDepth(new UniPoolState({ sqrtPriceX96: 1n, liquidity: 77n })), 77n);
});

test('v4 ExactInputSingleParams, as one dynamic tuple', () => {
  const got = abiEncode('((address,address,uint24,int24,address),bool,uint128,uint128,bytes)', [[[ZERO, TKN, 10000, 200, ZERO], true, 10000000000000000n, 1n, new Uint8Array(0)]]);
  assert.equal(
    bytesToHex(got),
    '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e5acbb03d73267c03349c76ead672ee4d941f499000000000000000000000000000000000000000000000000000000000000271000000000000000000000000000000000000000000000000000000000000000c800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000000',
  );
});

test('bytes + bytes[]', () => {
  const got = abiEncode('bytes,bytes[]', [hexToBytes('0x060c0f'), [hexToBytes('0x1234'), new Uint8Array(0)]]);
  assert.equal(
    bytesToHex(got),
    '0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003060c0f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000212340000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  );
});

test('v2 swap input with CONTRACT_BALANCE and a path', () => {
  const got = abiEncode('address,uint256,uint256,address[],bool', [UR_CONSTANTS.addressThis, UR_CONSTANTS.contractBalance, 5n, [TKN, ADDRESSES.weth], false]);
  assert.equal(
    bytesToHex(got),
    '0x00000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000e5acbb03d73267c03349c76ead672ee4d941f499000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  );
});

test('negative int24 round-trips', () => {
  const got = abiEncode('int24,int24', [-887220n, 200n]);
  assert.equal(bytesToHex(got), '0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2764c00000000000000000000000000000000000000000000000000000000000000c8');
  assert.deepEqual(abiDecode('int24,int24', got), [-887220n, 200n]);
});

test('Multicall3 aggregate3 calldata', () => {
  const got = encodeCall('aggregate3((address,bool,bytes)[])', [
    [
      [TKN, true, hexToBytes('0x313ce567')],
      [ZERO, false, new Uint8Array(0)],
    ],
  ]);
  assert.equal(
    bytesToHex(got),
    '0x82ad56cb00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000e5acbb03d73267c03349c76ead672ee4d941f499000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000004313ce567000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000',
  );
});

test('PERMIT2_PERMIT input: the permit inline, then the signature', () => {
  const permit = { token: TKN, amount: 100000000000n, expiration: 1791555705, nonce: 0, spender: ADDRESSES.universalRouter, sigDeadline: 1791555705n };
  assert.equal(
    bytesToHex(permitRouterInput(permit, new Uint8Array(65).fill(0xab))),
    '0x000000000000000000000000e5acbb03d73267c03349c76ead672ee4d941f499000000000000000000000000000000000000000000000000000000174876e800000000000000000000000000000000000000000000000000000000006ac8f879000000000000000000000000000000000000000000000000000000000000000000000000000000000000000066a9893cc07d91d95644aedd05d03f95e1dba8af000000000000000000000000000000000000000000000000000000006ac8f87900000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000041ababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab00000000000000000000000000000000000000000000000000000000000000',
  );
});

test("Permit2's domain separator is the one on mainnet", () => {
  assert.equal(bytesToHex(permit2DomainSeparator()), '0x866a5aba21966af95d6c7ab78eb2b2fc913915c28be3b9aa07cc04ff903e3f28');
});

test('a v4 pool id is keccak(abi.encode(PoolKey))', () => {
  const pool = new UniV4Pool({ currency0: ZERO, currency1: TKN, fee: 10000, tickSpacing: 200, hooks: ZERO });
  assert.equal(pool.id, '0xce7ff1b044aaee5bf9e632a3b537e10fbca0222004ee50348d492c1e5b54419c');
  assert.equal(pool.hasHooks, false);
  assert.equal(pool.fee, 10000);
  const dynamic = new UniV4Pool({ currency0: ZERO, currency1: TKN, fee: 0x800000, tickSpacing: 60, hooks: '0x0e6690b6bbcc55a8b7c7da2f0ee43e2e2bf840c0' });
  assert.equal(dynamic.fee, null);
  assert.equal(dynamic.hasHooks, true);
  assert.notEqual(dynamic.id, pool.id);
  assert.equal(poolFromJson(pool.toJson()).id, pool.id);
});

test('decodes what it encodes, nested and dynamic', () => {
  const types = '(address,bool,bytes)[],uint256,(int24,(address,bytes))';
  const decoded = abiDecode(
    types,
    abiEncode(types, [
      [
        [TKN, true, hexToBytes('0xdeadbeef')],
        [ZERO, false, new Uint8Array(0)],
      ],
      42n,
      [-5n, [ADDRESSES.weth, hexToBytes('0x01')]],
    ]),
  );
  assert.equal(decoded[1], 42n);
  assert.equal(decoded[0][0][0].toLowerCase(), TKN);
  assert.deepEqual(decoded[0][0][2], hexToBytes('0xdeadbeef'));
  assert.equal(decoded[0][1][1], false);
  assert.equal(decoded[2][0], -5n);
  assert.equal(decoded[2][1][0].toLowerCase(), ADDRESSES.weth);
});

test('v3 path packs fees in three bytes', () => {
  assert.equal(bytesToHex(v3Path([TKN, ADDRESSES.weth], [3000])), `0x${TKN.slice(2)}000bb8${ADDRESSES.weth.slice(2)}`);
});

test('uint out of range is refused', () => {
  assert.throws(() => abiEncode('uint8', [256n]));
  assert.throws(() => abiEncode('uint160', [1n << 160n]));
});

test('models: ETH and WETH are one asset in two forms; pools sort their currencies', () => {
  const weth = new UniToken({ address: ADDRESSES.weth, symbol: 'WETH', decimals: 18 });
  assert.deepEqual(ETH_TOKEN.poolCurrencies, [ZERO, ADDRESSES.weth]);
  assert.deepEqual(weth.poolCurrencies, [ZERO, ADDRESSES.weth]);
  assert.ok(ETH_TOKEN.sameAsset(weth));
  assert.deepEqual(new UniToken({ address: TKN.toUpperCase().replace('0X', '0x'), symbol: 'TKN', decimals: 8 }).poolCurrencies, [TKN]);
  assert.deepEqual(sortCurrencies(TKN, ADDRESSES.weth), [ADDRESSES.weth, TKN]);
  assert.throws(() => new UniV2Pool({ pair: TKN, currency0: TKN, currency1: ADDRESSES.weth }), /order/);
  assert.throws(() => new UniV3Pool({ pool: TKN, currency0: ZERO, currency1: TKN, fee: 3000, tickSpacing: 60 }), /native/);
  const v2 = new UniV2Pool({ pair: '0xc821395f890913b9ce7415b36db10ddc5281c53a', currency0: ADDRESSES.weth, currency1: TKN });
  assert.equal(new UniHop(v2, TKN, ADDRESSES.weth).zeroForOne, false);
  assert.throws(() => new UniHop(v2, ZERO, TKN), /cross its pool/);
  assert.equal(addressOfTopic(topicOfAddress(TKN)), TKN);
  assert.equal(minimumOf(10000n, 100), 9900n);
  assert.equal(minimumOf(9999n, 50), 9949n, 'rounded down');
  assert.throws(() => minimumOf(1n, 10000));
});

test('Permit2: a permit for exactly the amount, 30 minutes, signed r ‖ s ‖ v by the owner', () => {
  const owner = privateKeyToAddress(ANVIL_KEY_0);
  const now = 1791555000;
  const p = buildPermitSingle({ token: TKN, amount: 25000000000n, nonce: 4, now, life: 1800 });
  assert.deepEqual({ ...p }, { token: TKN, amount: 25000000000n, expiration: now + 1800, nonce: 4, spender: ADDRESSES.universalRouter, sigDeadline: BigInt(now + 1800) });
  const sig = signPermitSingle(p, ANVIL_KEY_0);
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  assert.deepEqual(checkPermitSignature(p, sig, owner), sig);
  // v first (v ‖ r ‖ s) is refused, as is another signer or another permit.
  assert.throws(() => checkPermitSignature(p, Uint8Array.of(sig[64], ...sig.subarray(0, 64)), owner), /r ‖ s ‖ v|verify/);
  assert.throws(() => checkPermitSignature(p, sig, '0x0000000000000000000000000000000000000bad'), /another key/);
  assert.throws(() => checkPermitSignature({ ...p, amount: p.amount + 1n }, sig, owner), /another key/);
  assert.throws(() => checkPermitSignature(p, sig.subarray(0, 64), owner), /65 bytes/);
  assert.equal(permitSingleDigest(p).length, 32);
  assert.throws(() => buildPermitSingle({ token: TKN, amount: 0n, nonce: 0, now, life: 1800 }));
  assert.throws(() => buildPermitSingle({ token: TKN, amount: 1n << 160n, nonce: 0, now, life: 1800 }));
  // Covers: enough, and not about to expire.
  assert.equal(allowanceCovers({ amount: 10n, expiration: now + 600 }, 10n, now), true);
  assert.equal(allowanceCovers({ amount: 9n, expiration: now + 600 }, 10n, now), false);
  assert.equal(allowanceCovers({ amount: 10n, expiration: now + 100 }, 10n, now), false);
  // The approval is approve(Permit2, exactly the amount).
  assert.equal(bytesToHex(approvePermit2Call(123n)), bytesToHex(encodeCall('approve(address,uint256)', [ADDRESSES.permit2, 123n])));
});
