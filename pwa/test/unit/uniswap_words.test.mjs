// What the Buy rsFIRO / Uniswap screens say about a swap (lib/eth/uniswap_words.js): the
// rate, a pool's fee, the route as people read it (the desktop app's
// uniRouteText / uniRouteNote), fees "about" and "at most" (never
// understated); and a swap or an approval sent from this device shown as one
// in the Ethereum activity list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { amt, amtShown, short, ethAbout, ethAtMost, bipsText, feeText, rateText, routeText, routeNote, poolCount } from '../../src/lib/eth/uniswap_words.js';
import { ETH_TOKEN, UniToken, UniV3Pool, UniV4Pool, UniHop, UniRoute, UniPart, UniQuote } from '../../src/lib/eth/uniswap/models.js';
import { NATIVE_ETH, WETH } from '../../src/lib/eth/uniswap/constants.js';
import { RSFIRO as RSFIRO_ENTRY, TOKENS } from '../../src/lib/eth/tokens.js';
import { mergeActivity } from '../../src/lib/eth/history.js';
import { toChecksumAddress } from '../../src/lib/eth/crypto.js';
import { SWAP_TOKENS, RSFIRO_TOKEN, DEFAULT_RECEIVE, walletAsset } from '../../src/lib/eth/uniswap_app.js';

const RSFIRO = new UniToken(RSFIRO_ENTRY);
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const NO_HOOK = NATIVE_ETH;
const HOOK = '0x1111111111111111111111111111111111110040';

const v4 = (c0, c1, fee, hooks = NO_HOOK) => new UniV4Pool({ currency0: c0, currency1: c1, fee, tickSpacing: 60, hooks });
const part = (hops, amountIn, amountOut) => new UniPart({ route: new UniRoute(hops), amountIn, amountOut, hopOutputs: hops.map(() => amountOut), gas: 100000n });

const direct = v4(NATIVE_ETH, RSFIRO.address, 10000);
const hooked = v4(NATIVE_ETH, RSFIRO.address, 3000, HOOK);
const ethUsdc = new UniV3Pool({ pool: '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', currency0: USDC, currency1: WETH, fee: 500, tickSpacing: 10 });
const usdcRs = v4(RSFIRO.address, USDC, 3000);

const single = new UniQuote({ tokenIn: ETH_TOKEN, tokenOut: RSFIRO, amountIn: 10n ** 16n, parts: [part([new UniHop(direct, NATIVE_ETH, RSFIRO.address)], 10n ** 16n, 25670000000n)], gasEstimate: 150000n, priceImpact: 0.004, block: 1 });
const split = new UniQuote({
  tokenIn: ETH_TOKEN,
  tokenOut: RSFIRO,
  amountIn: 10n ** 18n,
  parts: [part([new UniHop(direct, NATIVE_ETH, RSFIRO.address)], 7n * 10n ** 17n, 17000000000000n), part([new UniHop(ethUsdc, WETH, USDC), new UniHop(usdcRs, USDC, RSFIRO.address)], 3n * 10n ** 17n, 7000000000000n)],
  gasEstimate: 300000n,
  block: 1,
});

test('amounts, fees and price protection in words', () => {
  assert.equal(amt(1234567800n, RSFIRO), '12.345678 rsFIRO');
  assert.equal(short(25670000000n, RSFIRO), '256.7 rsFIRO');
  assert.equal(ethAbout(123456789012345n), '0.0001234 ETH');
  assert.equal(ethAtMost(123456789012345n), '0.00012346 ETH', 'rounded up, never understated');
  assert.equal(ethAtMost(10n ** 16n), '0.01 ETH');
  assert.equal(bipsText(50), '0.5%');
  assert.equal(bipsText(100), '1%');
  assert.equal(feeText(3000), '0.3%');
  assert.equal(feeText(100), '0.01%');
  assert.equal(feeText(10000), '1%');
  assert.equal(feeText(null), 'set by its hook');
  // ETH to 8 places, as the wallet shows it: "≈" when digits are hidden, never on a floor.
  assert.equal(amtShown(4914523606051254n, ETH_TOKEN), '≈0.00491452 ETH');
  assert.equal(amtShown(4914523606051254n, ETH_TOKEN, { floor: true }), '0.00491452 ETH');
  assert.equal(amtShown(10n ** 16n, ETH_TOKEN), '0.01 ETH');
  assert.equal(amtShown(161063730482n, RSFIRO), '1,610.63730482 rsFIRO');
});

test('the rate and the route, as the desktop app says them', () => {
  assert.equal(rateText(single), '1 ETH ≈ 25,670 rsFIRO');
  assert.equal(routeText(single), 'ETH → rsFIRO');
  assert.equal(routeNote(single), 'Uniswap v4 · 1%');
  assert.equal(poolCount(single), 1);
  assert.equal(routeText(split), 'Split over 2 routes');
  assert.equal(routeNote(split), '70% v4 · 1%, 30% via USDC (v3 · 0.05% then v4 · 0.3%)');
  assert.equal(poolCount(split), 3);
  const withHook = new UniQuote({ tokenIn: ETH_TOKEN, tokenOut: RSFIRO, amountIn: 1n, parts: [part([new UniHop(hooked, NATIVE_ETH, RSFIRO.address)], 1n, 1n)], gasEstimate: 1n, block: 1 });
  assert.equal(routeNote(withHook), 'Uniswap v4 · 0.3% · hook');
});

test('the swap screen offers ETH and the tokens the wallet knows, ETH -> rsFIRO first', () => {
  assert.deepEqual(SWAP_TOKENS.map((t) => t.symbol), ['ETH', ...TOKENS.map((t) => t.symbol)]);
  assert.equal(RSFIRO_TOKEN.address, RSFIRO_ENTRY.address);
  assert.equal(RSFIRO_TOKEN.decimals, 8);
  assert.equal(DEFAULT_RECEIVE, RSFIRO_TOKEN);
  assert.equal(walletAsset(ETH_TOKEN).symbol, 'ETH');
  assert.equal(walletAsset(RSFIRO_TOKEN), RSFIRO_ENTRY);
});

test('a swap and an approval sent from this device show as what they were', () => {
  const me = '0x2222222222222222222222222222222222222222';
  const base = { raw: '0x02', nonce: '0', from: me, gasLimit: '1', maxFeePerGas: '1', maxPriorityFeePerGas: '1', sentAt: 1, error: null };
  const swap = { ...base, hash: `0x${'aa'.repeat(32)}`, to: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', asset: 'ETH', token: null, amount: String(10n ** 16n), createdAt: 2, state: 'confirmed', receipt: { blockNumber: 5, status: 1, gasUsed: '100', effectiveGasPrice: '2' }, kind: 'swap', tokenOut: RSFIRO_ENTRY.address, tokenOutSymbol: 'rsFIRO' };
  const approve = { ...base, hash: `0x${'bb'.repeat(32)}`, to: toChecksumAddress(RSFIRO_ENTRY.address), asset: 'rsFIRO', token: RSFIRO_ENTRY.address, amount: '100', createdAt: 1, state: 'pending', receipt: null, kind: 'approve' };
  const items = mergeActivity({ address: me, outbox: [swap, approve] });
  const s = items.find((i) => i.hash === swap.hash);
  assert.equal(s.kind, 'swap');
  assert.equal(s.swapOut, 'rsFIRO');
  assert.equal(s.asset.symbol, 'ETH');
  assert.equal(s.fee, 200n);
  const a = items.find((i) => i.hash === approve.hash);
  assert.equal(a.kind, 'approve');
  assert.equal(a.swapOut, null);
  assert.equal(items[0].hash, approve.hash, 'open first');
  // A plain payment carries no kind.
  const pay = mergeActivity({ address: me, outbox: [{ ...swap, kind: undefined, tokenOutSymbol: undefined }] })[0];
  assert.equal(pay.kind, null);
});
