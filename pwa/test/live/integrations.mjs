// Live checks of the wallet's outside services, through the wallet's own client code, spending
// nothing:
//   Buy FIRO    buyfiro.app in SANDBOX mode: assets, limits, a quote, an order, its states.
//   Sell FIRO   buyfiro.app's sell API in SANDBOX mode (every request: sandbox=true in the URL, and
//               in the body of an order): health, payout chains and tokens, limits, quotes (the
//               smallest sell refused by the quote's own figure), a Spark and a transparent order,
//               the order as it is, every state the sandbox can be forced into, an unknown order.
//   NEAR Intents 1Click: the token list, a dry quote, then a real (signed) quote whose signature
//               the wallet checks. A real quote is only an offer: nothing happens unless paid.
//               $1,200: NEAR's temporary minimum is $1,000 (buyfiro.app/limits says it too), and exactly $1,000 falls just short on the BNB route.
//   ETH / BNB   every server the wallet offers: right chain, a balance, rsFIRO's balanceOf, and
//               PancakeSwap's rsFIRO price on BNB Chain.
//
//   node test/live/integrations.mjs              everything
//   node test/live/integrations.mjs buy sell     only those sections (buy, sell, intents, evm)
//
// buyfiro.app sits behind Cloudflare, which refuses library User-Agents: its requests carry a
// browser's (a browser sends its own; Node's default is refused).
import { BuyClient, BuyAmount, isFinalState } from '../../src/lib/buy/buyfiro.js';
import { SellClient, DEFAULT_PAYOUT, FORCEABLE, isFinalState as sellIsFinal } from '../../src/lib/sell/sellfiro.js';
import { OneClickClient } from '../../src/lib/intents/oneclick.js';
import { problemWords } from '../../src/lib/intents/words.js';
import { EthRpc } from '../../src/lib/eth/rpc.js';
import { ETH_RPC_HOSTS, BSC_RPC_HOSTS } from '../../src/lib/eth/hosts.js';
import { RSFIRO_BSC, RSFIRO as RSFIRO_ETH } from '../../src/lib/eth/tokens.js';
import { quoteSwap } from '../../src/lib/eth/pancake.js';
import { ethKeyFromMnemonic } from '../../src/lib/eth/crypto.js';
import { FiroKeys } from '../../src/lib/firo/keys.js';
import { network as firoNetwork } from '../../src/lib/firo/params.js';

// Addresses for sandbox orders and quotes (no money moves): those of BIP39's public test phrase,
// never a real wallet's (public audit, H1).
const PUBLIC_TEST_WORDS = `${'abandon '.repeat(11)}about`;
const EVM = (await ethKeyFromMnemonic(PUBLIC_TEST_WORDS)).address;
const FIRO_T = (await FiroKeys.fromMnemonic(PUBLIC_TEST_WORDS, '', firoNetwork('main'))).address(0, 0).address;

const only = process.argv.slice(2);
let section = null;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
/** Node's fetch with a browser's User-Agent, for buyfiro.app (Cloudflare). */
const uaFetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...(init.headers || {}), 'user-agent': UA } });

const results = [];
async function check(name, fn) {
  if (only.length && !only.includes(section)) return;
  const t = Date.now();
  try {
    const said = await fn();
    results.push([true, name]);
    console.log(`ok   ${name} (${Date.now() - t} ms)${said ? `: ${said}` : ''}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL ${name}: ${e && e.code ? `${e.code} ` : ''}${e && e.message}`);
  }
}

// ---- Buy FIRO (sandbox)
section = 'buy';
const buy = new BuyClient({ fetch: uaFetch, sandbox: true });
let asset = null;
let order = null;
await check('buyfiro: assets', async () => {
  const list = await buy.assets();
  asset = list.find((a) => a.symbol === 'ETH' && a.blockchain === 'eth') || list[0];
  if (!asset) throw new Error('no assets');
  return `${list.length} assets; using ${asset.symbol} on ${asset.blockchain}`;
});
await check('buyfiro: limits', async () => JSON.stringify(await buy.limits()).slice(0, 120));
// The sandbox offers BTC and ETH at fixed prices; 0.5 ETH is above every minimum.
const amount = asset ? BuyAmount.parse('0.5', asset.decimals).amount : null;
await check('buyfiro: quote 0.5 ETH', async () => {
  const q = await buy.quote({ assetId: asset.assetId, amount, refundAddress: EVM });
  return `about ${Number(q.estimateSats) / 1e8} FIRO`;
});
await check('buyfiro: sandbox order', async () => {
  order = await buy.order({ assetId: asset.assetId, amount, walletAddress: FIRO_T, refundAddress: EVM });
  if (order.walletAddress !== FIRO_T) throw new Error('order pays elsewhere');
  return `deposit address issued, payable=${order.payable}`;
});
for (const st of ['delivered', 'refunded', 'failed', 'expired']) {
  await check(`buyfiro: order state ${st}`, async () => {
    const s = await buy.status(order.depositAddress, { forceState: st });
    if (!isFinalState(s.state)) throw new Error(`state ${s.state} is not final`);
    return s.state;
  });
}
await check('buyfiro: order state as it is', async () => (await buy.status(order.depositAddress)).state);

// ---- Sell FIRO (sandbox)
section = 'sell';
const sell = new SellClient({ fetch: uaFetch, sandbox: true });
const payout = { ...DEFAULT_PAYOUT, address: EVM };
let sellOrder = null;
await check('sell: health', async () => {
  const h = await sell.health();
  if (!h.healthy) throw new Error('not healthy');
  return `Spark deposits ${h.sparkDeposits ? 'on' : 'off'}`;
});
await check('sell: payout chains (USDT on BNB Chain recommended)', async () => {
  const { chains, recommended } = await sell.payoutChains();
  if (!chains.some((c) => c.chainId === 56)) throw new Error('no BNB Chain');
  if (!recommended || recommended.chainId !== 56 || recommended.token.toLowerCase() !== DEFAULT_PAYOUT.token.toLowerCase()) throw new Error(`recommended ${JSON.stringify(recommended)}`);
  return `${chains.length} chains: ${chains.map((c) => c.name).join(', ')}`;
});
await check('sell: payout tokens, USDT on BNB Chain', async () => {
  const { tokens } = await sell.payoutTokens(56, { symbol: 'USDT' });
  if (!tokens.some((t) => t.token.toLowerCase() === DEFAULT_PAYOUT.token.toLowerCase())) throw new Error("Tether's USDT is not among them");
  const all = await sell.payoutTokens(56);
  return `${tokens.length} called USDT; ${all.tokens.length} listed (first: ${all.tokens.slice(0, 3).map((t) => t.symbol).join(', ')})`;
});
await check('sell: limits for USDT on BNB Chain', async () => {
  const l = await sell.limits(payout);
  if (!(l.minimumFiro > 0) || !(l.maximumFiro > l.minimumFiro)) throw new Error(JSON.stringify(l));
  return `${l.minimumFiro} to ${l.maximumFiro} FIRO (${l.route})`;
});
await check('sell: quote 500 FIRO', async () => {
  const q = await sell.quote({ amount: 500n * 100000000n, payout });
  return `about $${q.receiveUsd} (${q.route}); limits ${q.minimumFiro} to ${q.maximumFiro} FIRO`;
});
await check('sell: under the smallest sell is refused, by the figure the quote names', async () => {
  try {
    await sell.quote({ amount: 100n * 100000000n, payout });
  } catch (e) {
    if (e.code === 'amount_below_minimum' && e.minimumFiro > 0) return `amount_below_minimum, ${e.minimumFiro} FIRO`;
    throw e;
  }
  throw new Error('100 FIRO was priced');
});
await check('sell: sandbox order, Spark deposit', async () => {
  sellOrder = await sell.order({ amount: 500n * 100000000n, payout, depositKind: 'spark' });
  if (!sellOrder.orderId.startsWith('sbx_') || sellOrder.payable) throw new Error(`${sellOrder.orderId} payable=${sellOrder.payable}`);
  return `${sellOrder.orderId}, deposit ${sellOrder.depositAddress} / ${sellOrder.sparkDepositAddress}, payable=${sellOrder.payable}`;
});
await check('sell: sandbox order, transparent deposit', async () => {
  const o = await sell.order({ amount: 300n * 100000000n, payout, depositKind: 'firo' });
  if (o.sparkDepositAddress !== null) throw new Error('a Spark address for a transparent deposit');
  return `${o.orderId}, payable=${o.payable}`;
});
await check('sell: order state as it is', async () => (await sell.status(sellOrder.orderId)).state);
for (const st of FORCEABLE) {
  await check(`sell: order state ${st}`, async () => {
    const s = await sell.status(sellOrder.orderId, { forceState: st });
    if (s.state !== st) throw new Error(`asked ${st}, got ${s.rawState}`);
    if (s.terminal !== sellIsFinal(st)) throw new Error(`terminal ${s.terminal}`);
    return `${s.state}${s.terminal ? ' (final)' : ''}${s.payoutTxid ? `, payout ${s.payoutTxid}` : ''}`;
  });
}
// Any "sbx_…" id is a sandbox order (its states are a function of the id and the clock): ask for another.
await check('sell: an unknown order is order_not_found', async () => {
  try {
    await sell.status('sell_0_no_such_order');
  } catch (e) {
    if (e.code === 'order_not_found') return 'order_not_found';
    throw e;
  }
  throw new Error('found');
});

// ---- NEAR Intents (1Click)
section = 'intents';
const oc = new OneClickClient({ fetch: globalThis.fetch });
let usdc = null;
await check('near intents: tokens', async () => {
  const list = await oc.tokens();
  usdc = list.find((t) => t.symbol === 'USDC' && t.blockchain === 'arb') || list.find((t) => t.symbol === 'USDC');
  return `${list.length} tokens; paying with ${usdc.symbol} on ${usdc.blockchain}`;
});
for (const destination of ['ethereum', 'bsc']) {
  await check(`near intents: dry quote 1,200 USDC -> ${destination === 'bsc' ? 'BNB' : 'ETH'}`, async () => {
    const q = await oc.quote({ origin: usdc, amountIn: 1200n * 10n ** BigInt(usdc.decimals), recipient: EVM, refundTo: EVM, dry: true, destination });
    return `about ${Number(q.amountOut) / 1e18} ${destination === 'bsc' ? 'BNB' : 'ETH'}`;
  });
}
await check("near intents: below NEAR's minimum the wallet names it, and its suggested amount quotes", async () => {
  let words = null;
  try {
    await oc.quote({ origin: usdc, amountIn: 500n * 10n ** BigInt(usdc.decimals), recipient: EVM, refundTo: EVM, dry: true, destination: 'bsc' });
    return 'NEAR took $500: its minimum is gone';
  } catch (e) {
    words = problemWords(e, { coin: usdc, into: 'BNB' });
  }
  if (words.fix !== 'useMinimum' || words.minimum == null) throw new Error(`said: ${words.title} ${words.detail}`);
  const q = await oc.quote({ origin: usdc, amountIn: words.minimum, recipient: EVM, refundTo: EVM, dry: true, destination: 'bsc' });
  return `"${words.title}" -> "${words.fixLabel}" -> about ${Number(q.amountOut) / 1e18} BNB`;
});
await check('near intents: signed quote (signature checked by the wallet)', async () => {
  const q = await oc.quote({ origin: usdc, amountIn: 1200n * 10n ** BigInt(usdc.decimals), recipient: EVM, refundTo: EVM, dry: false, destination: 'bsc' });
  if (!q.depositAddress) throw new Error('no deposit address');
  return 'signed by NEAR Intents, deposit address issued';
});

// ---- ETH and BNB servers
section = 'evm';
for (const [chain, hosts, token] of [
  ['ethereum', ETH_RPC_HOSTS, RSFIRO_ETH],
  ['bsc', BSC_RPC_HOSTS, RSFIRO_BSC],
]) {
  for (const host of hosts) {
    await check(`${chain}: ${host.host}`, async () => {
      const rpc = new EthRpc(host, { fetch: globalThis.fetch });
      await rpc.assertChain();
      const [height, wei, rs] = await Promise.all([rpc.blockNumber(), rpc.getBalance(EVM), rpc.ethCall({ to: token.address, data: `0x70a08231${EVM.slice(2).toLowerCase().padStart(64, '0')}` })]);
      return `block ${height}, balance ${Number(wei) / 1e18}, rsFIRO ${Number(BigInt(`0x${Buffer.from(rs).toString('hex') || '0'}`)) / 1e8}`;
    });
  }
}
await check('bsc: PancakeSwap quote 0.1 BNB -> rsFIRO', async () => {
  const rpc = new EthRpc(BSC_RPC_HOSTS[0], { fetch: globalThis.fetch });
  const q = await quoteSwap(rpc, { side: 'buy', amountIn: 10n ** 17n });
  return `${Number(q.amountOut) / 1e8} rsFIRO`;
});

const bad = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
