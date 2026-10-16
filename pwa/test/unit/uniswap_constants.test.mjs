// The Uniswap addresses and numbers: what can be checked offline (topics and selectors are the
// keccak of their signatures, the addresses are the ones the rest of the Ethereum code uses), and
// the shipped pool list (known_pools.json): it parses, has no pool twice, covers every pool
// between two route bases, and pins every rsFIRO pool (found on chain from rsFIRO's first block,
// 25,559,054, up to the list's block).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADDRESSES, DEPLOY_BLOCKS, TOPICS, V3_FEE_TICK_SPACING, V4_PROBE_KEYS, V4_DYNAMIC_FEE_FLAG, UR_COMMAND, V4_ACTION, UR_CONSTANTS, ROUTE_BASES, ETH_CHAIN_ID, NATIVE_ETH, WETH } from '../../src/lib/eth/uniswap/constants.js';
import { PERMIT2_ADDRESS } from '../../src/lib/eth/tx.js';
import { MULTICALL3 } from '../../src/lib/eth/rpc.js';
import { RSFIRO, TOKENS } from '../../src/lib/eth/tokens.js';
import { ETHEREUM, BSC, chainOf, SIGNABLE_CHAIN_IDS } from '../../src/lib/eth/chains.js';
import { eventTopic, selectorHex } from '../../src/lib/eth/abi.js';
import { parseKnownPools } from '../../src/lib/eth/uniswap/discovery.js';
import { parseDartKnownPools, JSON_FILE } from '../../tools/uniswap_pools.mjs';

test('every Uniswap address is lowercase and the same as the rest of the Ethereum code', () => {
  for (const [k, v] of Object.entries(ADDRESSES)) assert.match(v, /^0x[0-9a-f]{40}$/, `${k} lowercase`);
  assert.equal(ADDRESSES.permit2, PERMIT2_ADDRESS.toLowerCase());
  assert.equal(ADDRESSES.multicall3, MULTICALL3.toLowerCase());
  assert.equal(ETH_CHAIN_ID, 1);
  assert.equal(ETHEREUM.chainId, ETH_CHAIN_ID);
});

test('topics and selectors are the keccak of their signatures; fee tiers and probe keys are well formed', () => {
  assert.equal(TOPICS.v2PairCreated, eventTopic('PairCreated(address,address,address,uint256)'));
  assert.equal(TOPICS.v3PoolCreated, eventTopic('PoolCreated(address,address,uint24,int24,address)'));
  assert.equal(TOPICS.v4Initialize, eventTopic('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'));
  assert.equal(TOPICS.erc20Transfer, eventTopic('Transfer(address,address,uint256)'));
  assert.equal(selectorHex('execute(bytes,bytes[],uint256)'), '0x3593564c');
  assert.deepEqual(V3_FEE_TICK_SPACING.map((x) => [...x]), [[100, 1], [500, 10], [3000, 60], [10000, 200]]);
  for (const k of V4_PROBE_KEYS) assert.ok(Number.isInteger(k.fee) && Number.isInteger(k.tickSpacing) && k.tickSpacing > 0);
  assert.equal(V4_DYNAMIC_FEE_FLAG, 0x800000);
  for (const v of Object.values(DEPLOY_BLOCKS)) assert.ok(Number.isSafeInteger(v) && v > 0);
  assert.ok(Object.values(UR_COMMAND).every(Number.isInteger) && Object.values(V4_ACTION).every(Number.isInteger));
  assert.equal(UR_CONSTANTS.contractBalance, 1n << 255n);
  assert.equal(UR_CONSTANTS.openDelta, 0n);
});

test('the route bases: ETH, WETH and the stable and bitcoin tokens; rsFIRO is a token, not a base', () => {
  assert.deepEqual([...ROUTE_BASES], [NATIVE_ETH, WETH, ...['USDC', 'USDT', 'DAI', 'WBTC'].map((s) => TOKENS.find((t) => t.symbol === s).address)]);
  assert.ok(!ROUTE_BASES.includes(RSFIRO.address));
  // The chains: Ethereum and BNB Chain, each with its rsFIRO, signable and nothing else.
  assert.equal(BSC.chainId, 56);
  assert.equal(BSC.rsfiro, '0x13cdb5f7f398f6af2cc3b34eb04476af3488853f');
  assert.equal(ETHEREUM.rsfiro, RSFIRO.address);
  assert.equal(chainOf(56), BSC);
  assert.equal(chainOf('ethereum'), ETHEREUM);
  assert.throws(() => chainOf(137));
  assert.deepEqual(SIGNABLE_CHAIN_IDS, [1n, 56n]);
});

test('known_pools.json: parses, no pool twice, every base pair covered, every rsFIRO pool pinned', () => {
  const shipped = readFileSync(JSON_FILE, 'utf8');
  const json = JSON.parse(shipped);
  const known = parseKnownPools(json);
  assert.equal(known.block, 26155432);
  assert.equal(new Set(known.pools.map((p) => p.id)).size, known.pools.length, 'no pool twice');
  const bases = new Set(ROUTE_BASES);
  const rs = known.pools.filter((p) => p.currency0 === RSFIRO.address || p.currency1 === RSFIRO.address);
  for (const p of known.pools) assert.ok((bases.has(p.currency0) && bases.has(p.currency1)) || rs.includes(p), `${p.id} is a base pair or an rsFIRO pool`);
  assert.deepEqual(
    ['v2', 'v3', 'v4'].map((v) => rs.filter((p) => p.version === v).length),
    [0, 3, 6],
  );
  // The pool the swap mostly uses: rsFIRO/WETH, 0.3%.
  assert.ok(rs.some((p) => p.version === 'v3' && p.pool === '0x385cd0e67ceae18d38c415bb01df62bace0c25ba' && p.currency1 === WETH && p.fee === 3000));
  assert.ok(shipped.length < 64 * 1024, `${shipped.length} bytes`);
});

test('the pool list parser refuses what it does not understand', () => {
  const ok = "const int kUniKnownPoolsBlock = 5;\nconst List<Map<String, Object>> kUniKnownPools = [\n  {\n    'v': 'v2',\n    'pair': '0x231b7589426ffe1b75405526fc32ac09d44364c4',\n    'c0': '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',\n    'c1': '0x6b175474e89094c44da98b954eedeac495271d0f',\n  },\n];\n";
  assert.equal(parseDartKnownPools(ok).pools.length, 1);
  assert.throws(() => parseDartKnownPools(ok.replace("'v2'", "'v5'")));
  assert.throws(() => parseDartKnownPools(ok.replace('0x231b', '0xZZ1b')));
  assert.throws(() => parseDartKnownPools(ok.replace("'c0': '0x2260", "'c0': '0x9260")), /out of order/);
  assert.throws(() => parseDartKnownPools(ok.replace("    'c1'", "    'fee': 3,\n    'c1'")));
  assert.throws(() => parseKnownPools({ format: 2, block: 1, currencies: [], hooks: [], pools: [] }));
  assert.throws(() => parseKnownPools({ format: 1, block: 1, currencies: [], hooks: [], pools: [[4, 0, 1, 3000, 60, 0]] }));
});
