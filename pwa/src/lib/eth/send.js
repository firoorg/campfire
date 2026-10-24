// Sending a chain's coin (ETH, BNB) or a known token from this wallet, on Ethereum or BNB
// Chain (the chain is the server's: rpc.chain, lib/eth/chains.js): check the recipient,
// prepare the exact transaction and what it can cost, sign it with the key
// open for as short a time as possible, save it, then broadcast it, and
// follow it to a receipt.
//
// The order is the point (plan §2):
//   prepare  walletFees + estimateGas (+ an eth_call of the token transfer);
//            the fee shown "up to" is gasLimit x maxFeePerGas of the very
//            transaction that will be signed, so it can never be exceeded.
//   sign     withEthKey: chain id 1 checked again, nonce from 'pending',
//            signed, key zeroed.
//   save     {hash, raw, nonce} into the sealed outbox BEFORE broadcasting.
//   send     eth_sendRawTransaction. A network error leaves it 'signed':
//            the same bytes can be sent again safely, never re-signed. A
//            server that refuses the bytes may still have passed them on (or
//            be lying), so a refusal is not "never sent" at once: the entry
//            stays open (entry.refusedAt), its hash is checked and its bytes
//            offered again, and only after REFUSAL_WATCH_MS of refusals with
//            the hash unknown is it 'rejected'.
//   follow   receipts while the screen is visible and the wallet unlocked.
//            "Replaced" only with evidence: the server showing the transaction
//            that took our nonce, signed by this wallet's key (checked here, so
//            a server cannot make one up) and with a receipt. The account's
//            nonce having moved on is the server's word alone, and a server
//            that is wrong (or lying) about it would have the person pay again
//            while the first payment can still be mined; that is 'unsure'
//            (entry.unsureSince): kept open, the same bytes offered again, and
//            the screens say not to send it again yet. (The desktop app's
//            findReplacedPendingEthereumTransactions decides on the nonce alone.)
//            It ends once that server AND a second listed one both show the nonce used
//            NONCE_GONE_BLOCKS deep and neither knows the transaction: its bytes can no longer
//            be mined, and it is 'replaced' by a transaction neither can show (release re-audit R-1).

import { isAddress, toChecksumAddress } from './crypto.js';
import { encodeCall, abiDecode } from './abi.js';
import { signTransaction, verifyRpcTransaction, parseSignedTransaction } from './tx.js';
import { walletFees, gasWithHeadroom, EthRpcError, isRevert } from './rpc.js';
import { allowanceNotBefore as readNotBefore } from './permission.js';
import { withEthKey } from './vault.js';
import { addToOutbox, updateOutbox, loadOutbox, inDoubt, isOpen, entryChain, entryWords, REJECTED_FOLLOW_MS, BROADCAST_ANSWER_MS } from './outbox.js';
import { ALL_TOKENS, isNative } from './tokens.js';
import { chainOf, CHAINS } from './chains.js';
import { ADDRESSES } from './uniswap/constants.js';
import { PANCAKE, ROUTER_ITSELF } from './pancake.js';

/** The chain an RPC client serves (Ethereum for a client that does not say). */
export const chainOfRpc = (rpc) => (rpc && rpc.chain) || chainOf('ethereum');
import { formatUnits } from './units.js';
import { bytesToHex } from './hex.js';
import { t, sentences } from '../i18n.js';

/** wei as ETH for an "up to" figure: rounded up at 8 places, never understated. */
function ethUp(wei) {
  const cut = 10n ** 10n;
  return formatUnits(wei % cut === 0n ? wei : wei + (cut - (wei % cut)), 18);
}

/** A plain ETH payment to an account without code always uses exactly this. */
export const ETH_TRANSFER_GAS = 21000n;
const ZERO = '0x0000000000000000000000000000000000000000';

export class SendError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'not_enough' | 'no_gas' | 'would_fail' | 'recipient' | 'changed' | 'server' | 'in_doubt' | 'busy'
  }
}

/**
 * Why `input` cannot receive a payment from `own`, in words, or null.
 * {code, message}; code: 'empty' | 'format' | 'checksum' | 'own' | 'zero' | 'token' | 'contract'.
 */
export function recipientProblem(input, { own = null } = {}) {
  const a = String(input || '').trim();
  if (!a) return { code: 'empty', message: '' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
    if (/^[0-9a-fA-F]{40}$/.test(a)) return { code: 'format', message: t('An Ethereum address starts with 0x. Copy it again from the person you are paying.') };
    return { code: 'format', message: t("This isn't an Ethereum address (0x and 40 letters and digits). Copy it again from the person you are paying.") };
  }
  if (!isAddress(a)) return { code: 'checksum', message: t("This address doesn't add up: one character looks mistyped. Copy it again rather than typing it.") };
  const low = a.toLowerCase();
  if (low === ZERO) return { code: 'zero', message: t('This is the zero address: coins sent to it are gone for good.') };
  if (own && low === own.toLowerCase()) return { code: 'own', message: t("This is this wallet's own address. Paste the receiver's address.") };
  const token = ALL_TOKENS.find((token) => token.address === low);
  if (token) return { code: 'token', message: t('This is the {symbol} token\'s own contract. Coins sent to it are lost. Paste the receiver\'s address.', { symbol: token.symbol }) };
  const sink = SINKS.get(low);
  if (sink) return { code: 'contract', message: sink };
  return null;
}

/**
 * Contracts this wallet talks to that never take a plain payment (public audit, P12): coins sent to
 * one by Send are lost or stuck. Rosen's lock pays out only for a transfer carrying the bridge's
 * details (Bridge builds those); the swap contracts move only what a swap asks of them.
 */
const SINKS = new Map([
  ...Object.values(CHAINS).map((c) => [c.rosenLock, t('This is Rosen Bridge\'s lock address on {name}. Coins sent to it by a plain payment, without the bridge\'s details, are lost. To move rsFIRO back to FIRO, use Bridge.', { name: c.name })]),
  ...[ADDRESSES.universalRouter, ADDRESSES.permit2, ADDRESSES.v4PoolManager, ADDRESSES.v2Factory, ADDRESSES.v3Factory, ADDRESSES.v3QuoterV2, ADDRESSES.v4Quoter, ADDRESSES.v4StateView, ADDRESSES.multicall3].map((a) => [a, t("This is one of Uniswap's own contracts. Coins sent to it by a plain payment are lost. To swap, use Swap.")]),
  ...[PANCAKE.smartRouter, PANCAKE.factory, PANCAKE.deployer, PANCAKE.quoterV2, PANCAKE.pool, ROUTER_ITSELF].map((a) => [a, t("This is one of PancakeSwap's own contracts. Coins sent to it by a plain payment are lost. To swap, use Swap.")]),
]);

/** {to, value, data} of a payment of `amount` of `asset` (a chain's coin or a known token) to `recipient`. */
export function transferCall(asset, recipient, amount) {
  if (isNative(asset)) return { to: toChecksumAddress(recipient), value: amount, data: '0x' };
  if (!ALL_TOKENS.includes(asset)) throw new SendError('recipient', t('Only the tokens this wallet knows can be sent.'));
  return { to: toChecksumAddress(asset.address), value: 0n, data: encodeCall('transfer(address,uint256)', [recipient, amount]) };
}

function revertText(e) {
  const m = String((e && e.message) || '');
  return m.replace(/^execution reverted:?\s*/i, '').trim();
}

/** "X more is held for a transaction still on its way." when open transactions hold some of it; else null. */
export function heldWords(held, decimals, symbol) {
  return typeof held === 'bigint' && held > 0n ? t('{amount} {symbol} more is held for a transaction still on its way.', { amount: formatUnits(held, decimals), symbol }) : null;
}


/** A payment past what is free, in words: `have` free, `held` promised to transactions still on their way. */
function moreThanFree(have, held, decimals, symbol) {
  if (typeof held === 'bigint' && held > 0n) return sentences(t('That\'s more than you can send now: {amount} {symbol} is free.', { amount: formatUnits(have, decimals), symbol }), heldWords(held, decimals, symbol));
  return t('That\'s more than you have ({amount} {symbol}).', { amount: formatUnits(have, decimals), symbol });
}

/**
 * Builds the transaction and its costs. balances: {eth: wei, [symbol]: units}, what may be spent:
 * the wallet's spendable() (its balances less what open transactions hold, their .held, for the words).
 * Returns {asset, recipient, amount, tx:{to, value, data, gasLimit,
 * maxFeePerGas, maxPriorityFeePerGas}, gas, fees:{likely, upTo, baseFee, tip},
 * preparedAt}. Throws SendError with the reason in words.
 */
export async function prepareSend(rpc, { from, asset, recipient, amount, balances, now = Date.now() }) {
  const problem = recipientProblem(recipient, { own: from });
  if (problem) throw new SendError('recipient', problem.message || t('Enter the address to send to.'));
  if (typeof amount !== 'bigint' || amount <= 0n) throw new SendError('not_enough', t('The amount must be more than zero.'));
  const chain = chainOfRpc(rpc);
  const coin = chain.native.symbol;
  if ((asset.chain || 'ethereum') !== chain.key) throw new SendError('recipient', t('{symbol} is not on {name}.', { symbol: asset.symbol, name: chain.name }));
  const isEth = isNative(asset);
  const have = isEth ? balances.eth : balances[asset.symbol];
  const held = balances.held || {};
  const heldCoin = held.eth ?? 0n;
  if (have == null) throw new SendError('server', t('The balance is not known yet. Try again in a moment.'));
  if (!isEth && amount > have) throw new SendError('not_enough', moreThanFree(have, held[asset.symbol], asset.decimals, asset.symbol));
  if (isEth && amount > have) throw new SendError('not_enough', moreThanFree(have, heldCoin, 18, coin));

  const call = transferCall(asset, recipient, amount);
  const fees = await walletFees(rpc);
  let estimate;
  try {
    estimate = await rpc.estimateGas({ from, to: call.to, data: call.data, value: call.value });
  } catch (e) {
    if (!(e instanceof EthRpcError) || typeof e.code !== 'number') throw e; // the server, not the transaction
    if (isEth && /insufficient funds/i.test(e.message)) throw new SendError('not_enough', t('There is not enough {coin} for the amount and the network fee.', { coin }));
    if (isRevert(e)) throw new SendError('would_fail', (revertText(e) ? t('{name} says this payment would fail ({reason}). Nothing was sent.', { name: chain.name, reason: revertText(e) }) : t('{name} says this payment would fail. Nothing was sent.', { name: chain.name })));
    // The server could not say (busy, a block it lacks): to an account without code a payment of the
    // coin takes exactly 21,000 gas and cannot be refused; anything else is the server's trouble.
    if (isEth && (await rpc.getCode(call.to)).length === 0) estimate = ETH_TRANSFER_GAS;
    else throw e;
  }
  if (!isEth) {
    // The exact call, as it will run: a token that answers false (or reverts) would take the fee and move nothing.
    let out;
    try {
      out = await rpc.ethCall({ from, to: call.to, data: call.data });
    } catch (e) {
      if (!isRevert(e)) throw e; // the server could not say: its trouble, never "the contract refuses"
      throw new SendError('would_fail', (revertText(e) ? t('The {symbol} contract refuses this transfer ({reason}). Nothing was sent.', { symbol: asset.symbol, reason: revertText(e) }) : t('The {symbol} contract refuses this transfer. Nothing was sent.', { symbol: asset.symbol })));
    }
    if (out.length > 0 && (out.length !== 32 || abiDecode('bool', out)[0] !== true)) throw new SendError('would_fail', t('The {symbol} contract refuses this transfer. Nothing was sent.', { symbol: asset.symbol }));
  }
  const gasLimit = estimate === ETH_TRANSFER_GAS && isEth ? ETH_TRANSFER_GAS : gasWithHeadroom(estimate);
  const upTo = gasLimit * fees.maxFeePerGas;
  let likely = estimate * (fees.baseFee + fees.maxPriorityFeePerGas);
  if (likely > upTo) likely = upTo;
  const eth = balances.eth ?? 0n;
  if (isEth && amount + upTo > eth) {
    const max = eth > upTo ? eth - upTo : 0n;
    throw new SendError('not_enough', (heldCoin > 0n ? sentences(t('With the network fee (up to {fee} {coin}) that\'s more than you can send now. You can send up to {amount} {coin}.', { fee: ethUp(upTo), coin, amount: formatUnits(max, 18) }), heldWords(heldCoin, 18, coin)) : t('With the network fee (up to {fee} {coin}) that\'s more than you have. You can send up to {amount} {coin}.', { fee: ethUp(upTo), coin, amount: formatUnits(max, 18) })));
  }
  if (!isEth && upTo > eth) throw new SendError('no_gas', (heldCoin > 0n ? sentences(t('The network fee is paid in {coin}: up to {fee} {coin}, and this wallet has {amount} {coin} free on {chainName}.', { coin, fee: ethUp(upTo), amount: formatUnits(eth, 18), chainName: chain.name }), heldWords(heldCoin, 18, coin)) : t('The network fee is paid in {coin}: up to {fee} {coin}, and this wallet has {amount} {coin} on {chainName}.', { coin, fee: ethUp(upTo), amount: formatUnits(eth, 18), chainName: chain.name })));
  return {
    asset,
    recipient: toChecksumAddress(recipient),
    amount,
    tx: { to: call.to, value: call.value, data: call.data, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas },
    gas: estimate,
    fees: { likely, upTo, baseFee: fees.baseFee, tip: fees.maxPriorityFeePerGas, capped: fees.capped === true },
    preparedAt: now,
  };
}

/** The most that can be sent: all of a token, or the coin's balance less the fee at most. */
export function maxSendable(asset, balances, upToFee) {
  if (!isNative(asset)) return balances[asset.symbol] ?? 0n;
  const eth = balances.eth ?? 0n;
  return eth > upToFee ? eth - upToFee : 0n;
}

/** Whether a fresh preparation costs more than the one the person reviewed. */
export function costRose(reviewed, fresh) {
  return fresh.fees.upTo > reviewed.fees.upTo || fresh.tx.gasLimit !== reviewed.tx.gasLimit || fresh.tx.to !== reviewed.tx.to || fresh.tx.value !== reviewed.tx.value;
}

function serverRefused(e) {
  return e instanceof EthRpcError && typeof e.code === 'number';
}

/**
 * How long bytes a server refused stay open (entry.refusedAt), their hash checked and the bytes
 * offered again, before they count as never sent ('rejected'): 30 minutes.
 */
export const REFUSAL_WATCH_MS = 30 * 60 * 1000;
/** Refused bytes are offered again after this wait, doubling with each refusal up to the most (FM-8). */
export const RESEND_WAIT_MS = 4000;
export const RESEND_WAIT_MAX_MS = 2 * 60 * 1000;
/** "Not sent" needs the look before to have been a refusal too, at most this long ago (FM-8). */
export const TWO_LOOKS_MS = 10 * 60 * 1000;

/** The wait before refused bytes go again, after `refusals` refusals. */
export function resendWait(refusals) {
  return Math.min(RESEND_WAIT_MS * 2 ** Math.max(0, (refusals || 1) - 1), RESEND_WAIT_MAX_MS);
}

/**
 * Whether an entry refused since `refusedAt` is now never sent: refused for REFUSAL_WATCH_MS, and
 * the look before this one (lastRefusalAt) was a refusal too, recently: never on one look after a
 * gap (the wallet locked, the page hidden) (FM-8).
 */
function refusedLongEnough(entry, item) {
  const since = entry.refusedAt;
  return since != null && item - since >= REFUSAL_WATCH_MS && entry.lastRefusalAt != null && item - entry.lastRefusalAt <= TWO_LOOKS_MS;
}

/**
 * Why `e` (inDoubt) holds up the next transaction on its chain, and the ways out. One whose nonce
 * a server says is used (unsureSince) can stay so where no listed server can show what took it,
 * so the exits that always work are named too (release re-audit R-1): History from Stack Wallet
 * finds a transaction another wallet sent (Ethereum, when it is off: historyOff), and removing
 * the Ethereum & BNB wallet and adding it again clears what this device follows.
 */
export function doubtText(e, { historyOff = false, now = Date.now() } = {}) {
  const key = entryChain(e);
  const chain = CHAINS[key].name;
  const why = e.unsureSince
    ? t('the {chain} server says another transaction took its place but can\'t show it', { chain })
    : e.failedSeen
      ? t('your {chain} server says it failed, and no second server has confirmed that yet', { chain })
      : e.state === 'signed' && e.refusedAt
      ? t('the {chain} server refused it, but may have passed it on first', { chain })
      : e.state === 'signed' && !e.sentAt && !e.error && now - e.createdAt <= BROADCAST_ANSWER_MS
        ? t('it is still being sent, and the {chain} server hasn\'t answered yet', { chain }) // re-audit 3 RE3-5: its broadcast is under way
        : t('the {chain} server didn\'t answer when it was sent, so it may have left', { chain });
  const text = t('Your earlier transaction on {chain}, {e}, is not settled yet: {why}. A new one could go through together with it, so Firo PWA signs nothing new on {chain} until it is. Wait (Firo PWA keeps checking it), or choose another {chain} server in the Ethereum & BNB settings to check it there.', { chain, e: entryWords(e), why });
  if (!e.unsureSince) return text;
  // Never "remove the wallet and add it again": that forgets every guard on this wallet's open
  // transactions, and a payment sent again could then go through twice (second audit, XR).
  const history = historyOff && key === 'ethereum' ? t('Turning on History from Stack Wallet there lets Firo PWA find what took its place.') : null;
  return sentences(text, t('It ends by itself once a second {chain} server also shows its place used for good.', { chain }), history);
}

/** An earlier "Not sent" the server in use has after all (R-7), in words: what became of it, and to look first. */
export function revivedText(e) {
  const chain = CHAINS[entryChain(e)].name;
  const height = e.receipt && e.receipt.blockNumber != null ? Number(e.receipt.blockNumber).toLocaleString('en-US') : null;
  const what = e.state === 'confirmed' ? (height ? t('it went through (block {height})', { height }) : t('it went through')) : e.state === 'failed' ? (height ? t('it reached {chain} and failed there (block {height}), so only its network fee was spent', { chain, height }) : t('it reached {chain} and failed there, so only its network fee was spent', { chain })) : t('it is on its way');
  return t('Your earlier transaction on {chain}, {e}, showed "Not sent", but your {chain} server has it after all: {what}. Look at it before you send again: if this one is the same payment, it has already gone.', { chain, e: entryWords(e), what });
}

/** How long after a "Not sent" a used place with no transaction to show keeps new signing waiting. */
export const PLACE_UNEXPLAINED_MS = 10 * 60 * 1000;

/**
 * A "Not sent" entry whose place (nonce) the chain now shows used, while neither its receipt nor the
 * transaction can be seen and no other transaction of this wallet is known to have taken that place:
 * it may well have gone through, and a server whose index lags cannot show it yet. Signing waits for
 * a while (PLACE_UNEXPLAINED_MS after it was closed), so nobody pays again for a payment that went
 * through (release audit 0.1.6 port of the web wallet's SF2). A server that cannot say: wait too.
 */
async function refuseWhilePlaceUnexplained(rpc, x, list, { chain, now }) {
  const closedAt = x.lastRefusalAt ?? x.refusedAt ?? x.createdAt;
  // A clock set back further than the window: not taken for a fresh close (it would hold signing up).
  const age = closedAt == null ? null : now - closedAt;
  if (age == null || age >= PLACE_UNEXPLAINED_MS || age < -PLACE_UNEXPLAINED_MS) return;
  let n;
  try {
    n = BigInt(x.nonce);
  } catch {
    return;
  }
  const sameNonce = (e) => {
    try {
      return BigInt(e.nonce) === n;
    } catch {
      return false;
    }
  };
  const siblings = list.filter((e) => e.hash !== x.hash && entryChain(e) === chain.key && sameNonce(e));
  // Another of this wallet's transactions mined in that very place (its receipt kept): that one used
  // it, so this one never went through. Never a 'replaced' one (something else took its place, maybe
  // this very one), never one merely open (audit 0.1.7 verification, B1).
  if (siblings.some((e) => (e.state === 'confirmed' || e.state === 'failed') && e.receipt)) return;
  // Replaced by a known transaction of this key, mined in that place, that is not this one: that one used it.
  if (siblings.some((e) => e.state === 'replaced' && e.replacedBy && String(e.replacedBy).toLowerCase() !== String(x.hash).toLowerCase() && e.replacedIn != null)) return;
  const server = rpc.host && rpc.host.name ? rpc.host.name : t('The {name} server', { name: chain.name });
  let mined;
  try {
    mined = await rpc.getTransactionCount(x.from, 'latest');
  } catch {
    throw new SendError('server', t('{server} didn\'t answer while Firo PWA checked an earlier transaction that showed "Not sent". Try again in a moment.', { server }));
  }
  if (mined <= n) return; // its place is still free: it really was not sent
  // One still open in that place (a payment re-sent in its very place) that this server shows mined:
  // that one used it, and at most one of the two can ever be mined (audit 0.1.7, S3).
  for (const e of siblings.filter((y) => y.state === 'pending' || y.state === 'signed')) {
    const rc = await rpc.getTransactionReceipt(e.hash).catch(() => null);
    if (rc && rc.blockNumber != null) return;
  }
  throw Object.assign(
    new SendError('in_doubt', t('A transaction that showed "Not sent" may have gone through after all: its place on {name} is now used, but {server} can\'t show it yet. For the next few minutes nothing new is sent, so nothing is paid twice. Look for it in your activity (or on another server) before you pay again, then try again.', { name: chain.name, server })),
    { entry: x },
  );
}

/**
 * Refuses, before anything is signed, while a transaction of this wallet on rpc's chain is in doubt
 * (audit BM-1). First the recent "Not sent" ones of the chain are looked at again on this very
 * server (release re-audit R-7): after a server switch, one the new server holds is open again only
 * at the next slow look, and a payment signed before it would take the next nonce, both going
 * through. One found mined or held stops this signing once, named; a server that cannot answer
 * stops it too (nothing is signed on a guess).
 */
async function refuseWhileInDoubt(app, rpc, { ethId, kv, now = () => Date.now() }) {
  const chain = chainOfRpc(rpc);
  const item = now();
  const list = await loadOutbox(app, { ethId, kv });
  for (const x of list.filter((e) => e.state === 'rejected' && entryChain(e) === chain.key && item - e.createdAt < REJECTED_FOLLOW_MS)) {
    let next;
    try {
      next = await recheckClosed(app, rpc, x, { ethId, kv, now, force: true });
    } catch {
      throw new SendError('server', (rpc.host && rpc.host.name ? t('{server} didn\'t answer while Firo PWA checked an earlier transaction that showed "Not sent". Try again in a moment.', { server: rpc.host.name }) : t('The {chainName} server didn\'t answer while Firo PWA checked an earlier transaction that showed "Not sent". Try again in a moment.', { chainName: chain.name })));
    }
    if (next.state !== 'rejected') throw Object.assign(new SendError('in_doubt', revivedText(next)), { entry: next });
    await refuseWhilePlaceUnexplained(rpc, x, list, { chain, now: item });
  }
  const e = inDoubt(list, chain.key)[0];
  const historyOff = Boolean(app && app.prefs && app.prefs.ethHistory === false);
  if (e) throw Object.assign(new SendError('in_doubt', doubtText(e, { historyOff, now: item })), { entry: e });
}

/**
 * The nonce for a new transaction from `address` on rpc's chain (second audit, XN). The server's
 * 'pending' count alone put a new payment in the place of one still on its way whenever that server
 * had not seen it (a load-balanced backend, a server just switched to): one silently displaced the
 * other. Now never below one past this wallet's open transactions on the chain. And a server whose
 * pool holds more of this wallet's transactions than this device follows ('pending' above 'latest'
 * by more than the open ones in between) may hold one that showed "Not sent", which the person's
 * retry would then pay again: nothing is signed until those are in a block.
 */
async function nextNonce(app, rpc, address, { ethId, kv }) {
  const chain = chainOfRpc(rpc);
  const pending = await rpc.getTransactionCount(address, 'pending');
  const latest = await rpc.getTransactionCount(address, 'latest');
  const mine = (e) => isOpen(e) && entryChain(e) === chain.key && String(e.from).toLowerCase() === String(address).toLowerCase() && e.nonce != null;
  const open = (await loadOutbox(app, { ethId, kv })).filter(mine).map((e) => BigInt(e.nonce));
  // Places, not entries: two entries at one nonce (a resend, a replacement) fill one place (audit L4).
  const followed = new Set(open.filter((n) => n >= latest && n < pending).map(String)).size;
  if (pending > latest && BigInt(followed) < pending - latest) {
    const server = rpc.host && rpc.host.name ? rpc.host.name : t('The {name} server', { name: chain.name });
    throw new SendError('in_doubt', t('{server} holds a transaction from this wallet that this device isn\'t following: one that showed "Not sent" may have left after all, or another device with the same words sent one. Nothing new is signed on {name} until it is in a block, so nothing is paid twice. Try again in a minute.', { server, name: chain.name }));
  }
  // From the server's count, past the places of this device's open transactions (XN: a lagging
  // count reused one), and only those next to it: one far above the count is never a floor (audit
  // V1: one server's inflated count, once signed at, put every later payment on the chain after a
  // gap no block can fill, on any server). A place a mined one used is the network's to refuse.
  const taken = new Set(open.map(String));
  let next = pending;
  while (taken.has(String(next))) next += 1n;
  return next;
}

// One signing at a time per chain in this page (release verification 0.1.8), a backstop under the
// screens' own guards: from the doubt check to the end of the broadcast, a second transaction on the
// same chain is refused before anything is signed. Two at once read the same 'pending' nonce (one
// replaces the other), or, one after the other from a stale review, the next one: both mined, the
// same payment twice.
const signingOn = new Set();

/** Takes the chain's one signing: a function that lets it go. Throws SendError 'busy' while another is under way. */
function oneSigning(chain) {
  if (signingOn.has(chain.key)) throw new SendError('busy', t('Another {name} transaction from this wallet is being signed and sent right now, so this one was not. Try again once it has gone.', { name: chain.name }));
  signingOn.add(chain.key);
  return () => signingOn.delete(chain.key);
}

/**
 * Signs `prepared` (already reviewed and confirmed by the person), saves it,
 * broadcasts it. Returns {entry, sent, error}: sent false with error when the
 * broadcast did not go through. The entry stays open ('signed') either way:
 * a refusal sets entry.refusedAt, and only following it decides it was never
 * sent ('rejected').
 */
export async function signAndSend(app, rpc, prepared, opts = {}) {
  const done = oneSigning(chainOfRpc(rpc));
  try {
    return await signAndSendOne(app, rpc, prepared, opts);
  } finally {
    done();
  }
}

/**
 * The signed bytes, read back as any node will read them, must say exactly what was meant: signed by
 * this wallet, on this chain, at this nonce, to this address, this value, this data, this gas and
 * these fees, and their hash the one recorded (X-misc: the check before compared the signer with the
 * address of the very key that signed, so it could never fail). Throws SendError before anything is saved.
 */
/** Calldata as lower-case hex, whether it came as a hex string or as bytes. */
const hexOf = (d) => (d == null || d === '' ? '0x' : typeof d === 'string' ? d.toLowerCase() : bytesToHex(d).toLowerCase());

export function checkSigned(s, want, address) {
  let p;
  try {
    p = parseSignedTransaction(s.raw);
  } catch {
    throw new SendError('server', t('The signed transaction could not be read back, so nothing was sent.'));
  }
  const tx2 = p.tx;
  const same =
    p.from.toLowerCase() === String(address).toLowerCase() &&
    p.hash === s.hash &&
    tx2.chainId === BigInt(want.chainId) &&
    tx2.nonce === BigInt(want.nonce) &&
    tx2.to.toLowerCase() === String(want.to).toLowerCase() &&
    tx2.value === BigInt(want.value ?? 0n) &&
    tx2.data.toLowerCase() === hexOf(want.data) &&
    tx2.gasLimit === BigInt(want.gasLimit) &&
    tx2.maxFeePerGas === BigInt(want.maxFeePerGas) &&
    tx2.maxPriorityFeePerGas === BigInt(want.maxPriorityFeePerGas) &&
    tx2.accessList.length === 0;
  if (!same) throw new SendError('server', t('The signed transaction did not say what was reviewed, so nothing was sent.'));
}

async function signAndSendOne(app, rpc, prepared, { ethId, kv, now = () => Date.now() } = {}) {
  await refuseWhileInDoubt(app, rpc, { ethId, kv, now });
  const signed = await withEthKey(
    app,
    async ({ sk, address }) => {
      await (rpc.assertChain ? rpc.assertChain() : rpc.assertMainnet());
      const nonce = await nextNonce(app, rpc, address, { ethId, kv });
      const want = { chainId: BigInt(chainOfRpc(rpc).chainId), nonce, ...prepared.tx };
      const s = signTransaction(want, sk);
      checkSigned(s, want, address);
      return s;
    },
    kv,
  );
  let entry = {
    hash: signed.hash,
    raw: signed.raw,
    nonce: String(signed.nonce),
    from: signed.from,
    to: prepared.recipient,
    asset: prepared.asset.symbol,
    token: isNative(prepared.asset) ? null : prepared.asset.address,
    chain: chainOfRpc(rpc).key,
    amount: String(prepared.amount),
    gasLimit: String(prepared.tx.gasLimit),
    maxFeePerGas: String(prepared.tx.maxFeePerGas),
    maxPriorityFeePerGas: String(prepared.tx.maxPriorityFeePerGas),
    createdAt: now(),
    sentAt: null,
    state: 'signed',
    receipt: null,
    error: null,
  };
  await addToOutbox(app, entry, { ethId, kv });
  return broadcast(app, rpc, entry, { ethId, kv, now });
}

/**
 * A contract call ready to sign, on the rpc's chain: {tx: {to, value, data, gasLimit,
 * maxFeePerGas, maxPriorityFeePerGas}, gas, fees: {likely, upTo}}. The gas is estimated for this
 * very call from `from`, always: a call whose estimate fails is never built on a typical figure
 * (release audit 0.1.6). One the chain says would fail is refused in words (SendError); a server
 * that could not say (busy, a block it lacks) throws its EthRpcError, never "would fail".
 */
export async function prepareCall(rpc, { from, to, data, value = 0n }) {
  const chain = chainOfRpc(rpc);
  const fees = await walletFees(rpc);
  let gas;
  try {
    gas = await rpc.estimateGas({ from, to, data, value });
  } catch (e) {
    if (!(e instanceof EthRpcError) || typeof e.code !== 'number') throw e;
    if (/insufficient funds/i.test(e.message)) throw new SendError('not_enough', t('There is not enough {symbol} for this and its network fee.', { symbol: chain.native.symbol }));
    if (isRevert(e)) throw new SendError('would_fail', (revertText(e) ? t('{name} says this would fail ({reason}). Nothing was sent.', { name: chain.name, reason: revertText(e) }) : t('{name} says this would fail. Nothing was sent.', { name: chain.name })));
    throw e;
  }
  const gasLimit = gasWithHeadroom(gas);
  const upTo = gasLimit * fees.maxFeePerGas;
  let likely = gas * (fees.baseFee + fees.maxPriorityFeePerGas);
  if (likely > upTo) likely = upTo;
  return { tx: { to: toChecksumAddress(to), value, data, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }, gas, fees: { likely, upTo, capped: fees.capped === true, baseFee: fees.baseFee, tip: fees.maxPriorityFeePerGas } };
}

/**
 * Signs a prepared contract call (already reviewed and confirmed), saves it to the outbox,
 * broadcasts it: the way a swap, an approval or a raw call leaves this device, on any chain.
 * meta: {kind, asset (what leaves: a chain's coin or a token), amount (bigint), recipient (who
 * gets it, when that is not the contract called: a token transfer's receiver), extra}.
 * Returns broadcast()'s {entry, sent, error}.
 */
export async function signAndBroadcastCall(app, rpc, tx, meta, opts = {}) {
  const done = oneSigning(chainOfRpc(rpc));
  try {
    return await signAndBroadcastOne(app, rpc, tx, meta, opts);
  } finally {
    done();
  }
}

async function signAndBroadcastOne(app, rpc, tx, meta, { ethId, kv, now = () => Date.now() } = {}) {
  const chain = chainOfRpc(rpc);
  await refuseWhileInDoubt(app, rpc, { ethId, kv, now });
  const signed = await withEthKey(
    app,
    async ({ sk, address }) => {
      await (rpc.assertChain ? rpc.assertChain() : rpc.assertMainnet());
      const nonce = await nextNonce(app, rpc, address, { ethId, kv });
      const want = { chainId: BigInt(chain.chainId), nonce, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
      const s = signTransaction(want, sk);
      checkSigned(s, want, address);
      return s;
    },
    kv,
  );
  const entry = {
    hash: signed.hash,
    raw: signed.raw,
    nonce: String(signed.nonce),
    from: signed.from,
    to: toChecksumAddress(meta.recipient || tx.to),
    asset: meta.asset.symbol,
    token: isNative(meta.asset) ? null : meta.asset.address,
    amount: String(meta.amount),
    gasLimit: String(tx.gasLimit),
    maxFeePerGas: String(tx.maxFeePerGas),
    maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas),
    createdAt: now(),
    sentAt: null,
    state: 'signed',
    receipt: null,
    error: null,
    kind: meta.kind,
    chain: chain.key,
    ...(meta.extra || {}),
  };
  await addToOutbox(app, entry, { ethId, kv });
  return broadcast(app, rpc, entry, { ethId, kv, now });
}

/**
 * Sends an entry's saved bytes (again). Never re-signs. A server's refusal of bytes it was never
 * seen to hold is not final at once (entry.refusedAt): it may have passed them on before
 * refusing, or be lying. giveUp: the caller has just checked that the hash is unknown and the
 * nonce still free (followOnce), so once the bytes have been refused for REFUSAL_WATCH_MS they
 * are 'rejected': never sent.
 */
export async function broadcast(app, rpc, entry, { ethId, kv, now = () => Date.now(), giveUp = false } = {}) {
  try {
    await rpc.sendRawTransaction(entry.raw);
    const patch = { state: entry.state === 'signed' ? 'pending' : entry.state, sentAt: entry.sentAt || now(), error: null, refusedAt: null, lastRefusalAt: null, refusals: 0, nonceUsedAt: null };
    let e;
    try {
      e = (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
    } catch {
      // The server has it, whatever this device could write down (release audit 0.1.5, N7): never a
      // refusal, never "nothing was sent". The entry stays 'signed' in storage and its next look
      // finds it known to the server.
      e = { ...entry, ...patch };
    }
    return { entry: e, sent: true, error: null };
  } catch (err) {
    // A nonce already used is followOnce's to settle (mined, replaced or unsure), never a refusal.
    const nonceGone = serverRefused(err) && /nonce too low|already used|replacement/i.test(err.message);
    let patch = { error: err.message };
    if (serverRefused(err) && !nonceGone && entry.state === 'signed') {
      const item = now();
      const since = entry.refusedAt || item;
      const looks = { refusedAt: since, lastRefusalAt: item, refusals: (entry.refusals || 0) + 1 };
      patch = giveUp && refusedLongEnough(entry, item) ? { state: 'rejected', error: err.message, ...looks } : { error: err.message, ...looks };
    }
    // The server may have passed the bytes on before refusing: a failed write here is no reason to
    // say otherwise (the entry, saved before sending, is followed as it is).
    const e = (await updateOutbox(app, entry.hash, patch, { ethId, kv }).catch(() => null)) || { ...entry, ...patch };
    return { entry: e, sent: false, error: err };
  }
}

/**
 * What happened to a sent transaction, from: its receipt (or null), the
 * account's mined nonce count (asked BEFORE the receipt, so a transaction
 * mined in between still shows as mined), whether the server knows it and
 * whether it says it is in a block.
 *   'confirmed' | 'failed'  mined, status 1 / 0
 *   'pending'               in a block, receipt not served yet; or known and waiting
 *   'unsure'                not in any block, yet the server says nonce `nonce` is used up:
 *                           replaced, or the server is behind, confused or lying. Never
 *                           'replaced' on this alone (followOnce looks for the evidence).
 *   'unknown'               the server has never seen it: send the bytes again
 */
export function classify({ receipt, minedNonce, nonce, known, inBlock = false }) {
  if (receipt) return receipt.status === 1 ? 'confirmed' : 'failed';
  if (inBlock) return 'pending';
  if (minedNonce > BigInt(nonce)) return 'unsure';
  if (!known) return 'unknown';
  return 'pending';
}

/**
 * How many blocks deep an open transaction's nonce must be used, on the server in use and on a
 * second listed server that knows nothing of it either, before it is closed as replaced by a
 * transaction neither can show (release re-audit R-1): its bytes can no longer be mined then,
 * short of a reorg that deep. BNB Chain's blocks come faster and it reorganises more often.
 */
export const NONCE_GONE_BLOCKS = Object.freeze({ ethereum: 32, bsc: 64 });

// A waiting ('pending') transaction the server lost, offered again: hash -> {n: times, at: last (ms)} (R-8).
const lostResends = new Map();

/** At most one search for what took an open transaction's nonce per this long (it can take ~50 requests). */
export const NONCE_LOOK_MS = 60000;
/** How far back the search doubles its step: 2^26 blocks, years of Ethereum, months of BNB Chain. */
export const NONCE_SEARCH_STEPS = 26;
const lastLook = new Map(); // entry hash -> when its nonce was last looked into (ms)

/**
 * The lowest block at whose end `from` had sent more than `nonce` transactions: where the
 * transaction with that nonce was mined. null when the server contradicts itself. Asks for the
 * account's count at past blocks, which a server without old state refuses (it throws then).
 */
async function nonceBlock(rpc, from, nonce, maxSteps) {
  const head = await rpc.blockNumber();
  if ((await rpc.getTransactionCount(from, head)) <= nonce) return null;
  let hi = head;
  let lo = null;
  for (let i = 0, step = 1; i < maxSteps && hi > 0; i++, step *= 2) {
    const b = Math.max(0, hi - step);
    if ((await rpc.getTransactionCount(from, b)) <= nonce) {
      lo = b;
      break;
    }
    hi = b;
  }
  if (lo === null) return null;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await rpc.getTransactionCount(from, mid)) > nonce) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The mined transaction that used `entry`'s nonce, as evidence: the server must show it, and
 * it must check out (tx.js verifyRpcTransaction: signed by this wallet's key, this nonce, this
 * chain) and have a receipt. Looked for among `candidates` (hashes the wallet already knows:
 * another outbox entry with the same nonce, the history index) and then in the block where the
 * account's count passed the nonce. Returns {hash, blockNumber, ours} (ours: it is this very
 * transaction, in a block whose receipt the server has not served yet), or null.
 */
export async function findNonceTaker(rpc, entry, { candidates = [], maxSteps = NONCE_SEARCH_STEPS } = {}) {
  const me = entry.from.toLowerCase();
  const nonce = BigInt(entry.nonce);
  const chainId = BigInt(chainOfRpc(rpc).chainId);
  const ownTx = (item) => {
    const v = verifyRpcTransaction(item);
    return v && v.from.toLowerCase() === me && v.nonce === nonce && v.chainId === chainId ? v : null;
  };
  const mined = async (hash) => rpc.getTransactionReceipt(hash).catch(() => null);
  for (const c of new Set(candidates.map((h) => String(h).toLowerCase()))) {
    if (c === entry.hash) continue;
    const item = await rpc.getTransactionByHash(c).catch(() => null);
    const v = item && item.blockHash ? ownTx(item) : null;
    const receipt = v ? await mined(v.hash) : null;
    if (receipt) return { hash: v.hash, blockNumber: receipt.blockNumber, ours: false };
  }
  const n = await nonceBlock(rpc, entry.from, nonce, maxSteps);
  if (n === null) return null;
  const block = await rpc.getBlockByNumber(n, true);
  for (const item of (block && block.transactions) || []) {
    const v = ownTx(item);
    if (!v) continue;
    if (v.hash === entry.hash) return { hash: v.hash, blockNumber: n, ours: true };
    const receipt = await mined(v.hash);
    return receipt ? { hash: v.hash, blockNumber: receipt.blockNumber, ours: false } : null;
  }
  return null;
}

/** The account's transaction count at block `n`, or -1 when the server cannot say (no state that old). */
function countAt(rpc, from, n) {
  return rpc.getTransactionCount(from, Math.max(0, n)).catch(() => -1n);
}

/**
 * What a second listed server says of an entry whose nonce the server in use calls used:
 * 'gone' (the nonce used `depth` blocks deep, its hash unknown, no receipt), 'not-gone' (it sees
 * otherwise), or 'no-answer' (down, on another chain, or no state `depth` blocks back).
 */
async function nonceGoneOn(rpc, entry, depth) {
  const nonce = BigInt(entry.nonce);
  try {
    await rpc.assertChain();
    const head = await rpc.blockNumber();
    if ((await rpc.getTransactionCount(entry.from, 'latest')) <= nonce) return 'not-gone';
    if (await rpc.getTransactionReceipt(entry.hash)) return 'not-gone';
    if (await rpc.getTransactionByHash(entry.hash)) return 'not-gone';
    const past = await countAt(rpc, entry.from, head - depth);
    if (past < 0n) return 'no-answer';
    return past > nonce ? 'gone' : 'not-gone';
  } catch {
    return 'no-answer';
  }
}

/**
 * Release re-audit R-1: an open entry whose nonce the server in use says is used, which that
 * server cannot show the taker of and does not know itself, held every new transaction on its
 * chain for ever where no server keeps the old state the search needs. It is closed as
 * 'replaced' by a transaction neither server can show (replacedBy null, replacedUnseen) once:
 *   - the server in use shows the nonce used NONCE_GONE_BLOCKS deep: its count at that block
 *     already passed it, or this device has seen it used for that many blocks (nonceUsedAt);
 *   - the first other listed server that answers (`others`) shows the same, and knows neither the
 *     transaction nor a receipt for it.
 * A second server that sees otherwise keeps the hold (no third is asked to outvote it).
 * Returns the entry: closed, or with nonceUsedAt recorded.
 */
async function closeIfNonceGone(app, rpc, entry, { ethId, kv, others }) {
  const depth = NONCE_GONE_BLOCKS[chainOfRpc(rpc).key];
  let head;
  try {
    head = await rpc.blockNumber();
  } catch {
    return entry;
  }
  let e = entry;
  if (e.nonceUsedAt == null) e = (await updateOutbox(app, e.hash, { nonceUsedAt: head }, { ethId, kv })) || { ...e, nonceUsedAt: head };
  const deep = head - e.nonceUsedAt >= depth || (await countAt(rpc, e.from, head - depth)) > BigInt(e.nonce);
  if (!deep) return e;
  for (const other of (typeof others === 'function' ? others() : others) || []) {
    const said = await nonceGoneOn(other, e, depth);
    if (said === 'no-answer') continue;
    if (said !== 'gone') return e;
    const patch = { state: 'replaced', replacedBy: null, replacedIn: null, replacedUnseen: { block: head, servers: [rpc.host.id, other.host.id] }, unsureSince: null, refusedAt: null, nonceUsedAt: null };
    return (await updateOutbox(app, e.hash, patch, { ethId, kv })) || { ...e, ...patch };
  }
  return e;
}

/** How deep a failed receipt must be on the person's own server (no other is asked) before it counts. */
export const FAILED_ALONE_DEPTH = Object.freeze({ ethereum: 12, bsc: 30 });

/**
 * Whether a failed receipt from the server in use is to be believed (second audit, X7). "Failed"
 * tells the person nothing was paid and frees the amount, so they may pay again: one server's word
 * was enough before, and a wrong one meant paying twice. The other listed servers are asked one at a
 * time, and no more once one has answered either way (each one asked learns the address: audit L5):
 * 'agreed' when it shows the same failed receipt; 'disagree' when it shows it succeeded;
 * 'unseen' / 'no-answer' while none can confirm it yet. With the person's own server (no listed
 * server is asked, so none learns the address) its word counts once the block is FAILED_ALONE_DEPTH
 * deep; until then 'alone'.
 */
async function failureVerdict(rpc, entry, receipt, others) {
  const list = (typeof others === 'function' ? others() : others) || [];
  let answered = 0;
  // One at a time, and no more once one has answered it either way: each server asked sees the
  // transaction, and so the address (audit L5: every listed server was asked).
  for (const other of list) {
    try {
      await other.assertChain();
      const r = await other.getTransactionReceipt(entry.hash);
      answered++;
      if (r && r.status === 1) return 'disagree';
      if (r && r.status === 0) return 'agreed';
    } catch {
      // No answer from this one: the next is asked.
    }
  }
  if (list.length) return answered ? 'unseen' : 'no-answer';
  try {
    const head = await rpc.blockNumber();
    return head - Number(receipt.blockNumber) >= FAILED_ALONE_DEPTH[entryChain(entry)] ? 'agreed' : 'alone';
  } catch {
    return 'alone';
  }
}

/**
 * One look at an open entry: asks the server, updates the outbox, sends the
 * same bytes again when the server has forgotten them. Returns the entry.
 * candidates: hashes that may have taken this entry's nonce (findNonceTaker()).
 * others: clients of other listed servers of the chain (or a function giving them), asked only
 * to settle an entry whose nonce the server in use calls used (closeIfNonceGone, R-1), and to
 * confirm a failed receipt before the payment is shown as failed (failureVerdict, X7).
 */
export async function followOnce(app, rpc, entry, { ethId, kv, candidates = [], others = [], now = () => Date.now() } = {}) {
  if (entry.state !== 'signed' && entry.state !== 'pending') return entry;
  const minedNonce = await rpc.getTransactionCount(entry.from, 'latest');
  let receipt;
  try {
    receipt = await rpc.getTransactionReceipt(entry.hash);
  } catch (e) {
    if (!e || e.code !== 'receipts_refused') throw e;
    // A server that keeps receipts for paying users can still show the transaction itself: then
    // it has it, and "Sending" turns into "Waiting for the network" (release audit 0.1.5, nit).
    // Never more than that: without a receipt nothing is 'confirmed' or 'failed', and nothing is
    // sent again or closed on this look. The refusal goes on to the screen, which says so.
    const tx = await rpc.getTransactionByHash(entry.hash).catch(() => null);
    if (tx && entry.state === 'signed') await updateOutbox(app, entry.hash, { state: 'pending', unsureSince: null, refusedAt: null, nonceUsedAt: null }, { ethId, kv });
    throw e;
  }
  const tx = receipt ? null : await rpc.getTransactionByHash(entry.hash);
  let state = classify({ receipt, minedNonce, nonce: entry.nonce, known: Boolean(receipt || tx), inBlock: Boolean(tx && tx.blockHash) });
  if (state !== 'unknown') lostResends.delete(entry.hash);
  if (state === 'failed') {
    // Failed on the server's word: held open, and new signing on the chain waits, until a second
    // server shows the same (X7).
    const said = await failureVerdict(rpc, entry, receipt, others);
    if (said !== 'agreed') {
      const seen = { block: receipt.blockNumber, said };
      const f = entry.failedSeen;
      if (entry.state === 'pending' && f && f.block === seen.block && f.said === said) return entry;
      const patch = { state: 'pending', failedSeen: seen, unsureSince: null, refusedAt: null, nonceUsedAt: null };
      return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
    }
  }
  if (state === 'unsure') {
    const item = now();
    if (item - (lastLook.get(entry.hash) ?? -Infinity) < NONCE_LOOK_MS) return entry; // looked a moment ago: nothing new to prove
    lastLook.set(entry.hash, item);
    const taker = await findNonceTaker(rpc, entry, { candidates }).catch(() => null);
    if (taker && taker.ours) state = 'pending'; // ours is in that block: its receipt is on its way
    else if (taker) {
      lastLook.delete(entry.hash);
      const patch = { state: 'replaced', replacedBy: taker.hash, replacedIn: taker.blockNumber, unsureSince: null, refusedAt: null, nonceUsedAt: null };
      return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
    } else {
      // The server's word alone. The payment stays open and its same bytes are offered again:
      // a server that lost them takes them back, one whose nonce really moved on refuses them.
      const r = await broadcast(app, rpc, entry, { ethId, kv, now });
      let sent = r.entry;
      if (sent.state !== 'signed' && sent.state !== 'pending') return sent;
      // Refused, unknown here, no receipt: two servers' word that its nonce is used for good ends it (R-1).
      if (!r.sent && !receipt && !tx) {
        sent = await closeIfNonceGone(app, rpc, sent, { ethId, kv, others });
        if (sent.state === 'replaced') {
          lastLook.delete(entry.hash);
          return sent;
        }
      }
      if (sent.unsureSince) return sent;
      return (await updateOutbox(app, entry.hash, { unsureSince: item }, { ethId, kv })) || { ...sent, unsureSince: item };
    }
  }
  lastLook.delete(entry.hash);
  // Unknown to the server and its nonce still free: the bytes go again, and a refusal that has
  // lasted REFUSAL_WATCH_MS ends it as never sent. Refused bytes go again only after a growing
  // wait (FM-8: not every look); in between, this look still counts towards the verdict.
  if (state === 'unknown') {
    const item = now();
    // Its nonce is free again here: whatever was seen of it being used no longer counts (R-1).
    if (entry.nonceUsedAt != null) entry = (await updateOutbox(app, entry.hash, { nonceUsedAt: null }, { ethId, kv })) || { ...entry, nonceUsedAt: null };
    if (entry.refusedAt && entry.state === 'signed' && entry.lastRefusalAt != null && item - entry.lastRefusalAt < resendWait(entry.refusals)) {
      if (!refusedLongEnough(entry, item)) return entry;
      return (await updateOutbox(app, entry.hash, { state: 'rejected' }, { ethId, kv })) || { ...entry, state: 'rejected' };
    }
    // One the server took and then lost goes again with the same growing wait, not every look (R-8).
    if (entry.state === 'pending') {
      const lost = lostResends.get(entry.hash);
      if (lost && item - lost.at < resendWait(lost.n)) return entry;
      lostResends.set(entry.hash, { n: lost ? lost.n + 1 : 1, at: item });
    }
    return (await broadcast(app, rpc, entry, { ethId, kv, now, giveUp: true })).entry;
  }
  if (state === 'pending') return entry.state === 'pending' && !entry.unsureSince && !entry.refusedAt && entry.nonceUsedAt == null && !entry.failedSeen ? entry : (await updateOutbox(app, entry.hash, { state: 'pending', unsureSince: null, refusedAt: null, nonceUsedAt: null, failedSeen: null }, { ethId, kv })) || entry;
  const patch = { state, unsureSince: null, refusedAt: null, nonceUsedAt: null, failedSeen: null };
  if (receipt) patch.receipt = { blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: String(receipt.gasUsed), effectiveGasPrice: receipt.effectiveGasPrice == null ? null : String(receipt.effectiveGasPrice) };
  return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
}

/**
 * Whether a permission this wallet sent (an approve or approveReset entry) is still on its way, by
 * the chain's own word as the server in use reads it now (release audit 0.1.5, S1): its nonce not
 * used yet AND the token's allowance not yet what it sets. Mined (and perhaps already used by a swap),
 * replaced, or in effect: no longer on its way, whatever the outbox still says (a server that keeps
 * receipts for paying users never lets the entry close by itself). Both reads are of ONE block, the
 * server's newest (a load-balanced server may answer each request from another backend: one behind
 * then refuses that block instead of answering older figures). allowance(block): the token's
 * allowance for the entry's spender at `block`. A read that fails: still on its way (nothing is
 * offered twice on a guess).
 */
export async function approvalOnItsWay(rpc, entry, { owner, allowance }) {
  try {
    const head = await rpc.blockNumber();
    const mined = await rpc.getTransactionCount(owner, head);
    if (mined > BigInt(entry.nonce)) return false;
    const now = await allowance(head);
    return entry.kind === 'approveReset' ? now !== 0n : now < BigInt(entry.amount);
  } catch {
    return true;
  }
}

/**
 * One look at a permission being followed, by the chain's word as the server in use reads it now:
 * {done: false} while it is on its way; {done: true, success: true} once it is in effect (or its
 * entry confirmed); {done: true, success: false, state} once its place is taken without it: the
 * settled entry's own state ('failed', 'replaced', 'rejected'), or 'used' (its nonce used and the
 * permission not in effect: mined and used up by a swap since, refused by the chain where the server
 * keeps receipts to itself, or taken by a transaction no server shows).
 *
 * Both reads are of one block, the server's newest (release audit 0.1.5): the account's mined count
 * and the allowance AT that block, so neither a block landing between them nor a load-balanced
 * backend behind the other can pair a used nonce with the allowance from before the permission (one
 * without that block refuses: an error, which the caller takes as "look again", never as 'used').
 * A used nonce is never the verdict alone: the entry is settled (settle()) and read again
 * (current()) first; and while its server says its place was taken but cannot show by what
 * (unsureSince), it stays on its way: lib/eth/send.js settles that case (R-1), never this look.
 */
export async function lookAtApproval(rpc, entry, { owner, allowance, settle, current }) {
  const covers = (v) => (entry.kind === 'approveReset' ? v === 0n : v >= BigInt(entry.amount));
  const head = await rpc.blockNumber();
  const mined = await rpc.getTransactionCount(owner, head);
  const now = await allowance(head);
  if (covers(now)) {
    await settle();
    return { done: true, success: true, allowance: now, block: head };
  }
  if (mined <= BigInt(entry.nonce)) return { done: false, allowance: now, block: head };
  await settle();
  const e = current();
  if (e && e.state === 'confirmed') return { done: true, success: true, allowance: null, block: head };
  if (e && (e.state === 'failed' || e.state === 'replaced' || e.state === 'rejected')) return { done: true, success: false, state: e.state, allowance: now, block: head };
  // A failed receipt one server shows and no second one has confirmed is in doubt too (X7; audit
  // L6: it ended the permission as "used" on that one server's word).
  if (e && (e.unsureSince || e.failedSeen)) return { done: false, unsure: true, allowance: now, block: head };
  return { done: true, success: false, state: 'used', allowance: now, block: head };
}

/**
 * One pass of following a permission (outbox entry `entry`) on the server in use: its receipt
 * first (follow(entry) -> the entry as the outbox has it after one look; it throws as the look does,
 * receipts refused included), then the chain's word (lookAtApproval). Never throws. Returns
 *   {kind: 'effect', entry, allowance}  in effect; allowance read at the server's newest block once it
 *                                       is no older than the block that put it in effect
 *   {kind: 'gone', state, entry, allowance} it will not take effect (failed, replaced, rejected,
 *                                       used); allowance read the same way, or null
 *   {kind: 'waiting', entry, receiptsRefused, unsure} on its way (said as the entry says)
 *   {kind: 'retry', entry}             a read failed (a backend behind the block asked for, say)
 * allowance(block): the allowance at a block (a number). remember(block): called with the block at
 * which the chain showed the permission in effect without a receipt (the screens keep it with the
 * entry as seenInEffectAt, so later reads wait for it too: lib/eth/permission.js permissionMinBlock).
 *
 * "No older than", never "exactly at": a server that keeps only recent state (about a minute of BNB
 * Chain, half an hour of Ethereum) refuses a block that old, and a permission confirmed while the app
 * slept would then never be read in effect (release audit 0.1.5, final S1).
 */
export async function approvalPass({ rpc, entry, owner, allowance, follow, settle, current, remember = null }) {
  const blockOf = (x) => (x && x.receipt && Number.isSafeInteger(Number(x.receipt.blockNumber)) ? Number(x.receipt.blockNumber) : 0);
  const readFrom = (minBlock) => readNotBefore(rpc, minBlock, allowance, { tries: 1 });
  let e = entry;
  let receiptsRefused = null;
  try {
    e = (await follow(entry)) || current() || entry;
  } catch (err) {
    if (err && err.code === 'receipts_refused') receiptsRefused = err;
    e = current() || entry;
  }
  if (e.state === 'confirmed') {
    try {
      return { kind: 'effect', entry: e, allowance: await readFrom(blockOf(e)) };
    } catch {
      return { kind: 'retry', entry: e };
    }
  }
  if (e.state === 'failed' || e.state === 'replaced' || e.state === 'rejected') return { kind: 'gone', state: e.state, entry: e, allowance: await readFrom(blockOf(e)).catch(() => null) };
  try {
    const look = await lookAtApproval(rpc, e, { owner, allowance, settle: () => settle(e), current: () => current() || e });
    const now = current() || e;
    if (look.done && look.success) {
      if (look.allowance !== null) {
        if (remember && !(now.state === 'confirmed' && now.receipt)) await remember(look.block);
        return { kind: 'effect', entry: now, allowance: look.allowance };
      }
      try {
        return { kind: 'effect', entry: now, allowance: await readFrom(Math.max(blockOf(now), look.block)) };
      } catch {
        return { kind: 'retry', entry: now };
      }
    }
    if (look.done) return { kind: 'gone', state: look.state, entry: now, allowance: look.allowance };
    return { kind: 'waiting', entry: now, receiptsRefused, unsure: Boolean(look.unsure || now.unsureSince) };
  } catch {
    return { kind: receiptsRefused ? 'waiting' : 'retry', entry: current() || e, receiptsRefused, unsure: Boolean(e.unsureSince) };
  }
}

export { allowanceNotBefore } from './permission.js';

/**
 * How often a 'rejected' entry is looked at again (audit BM-2): its verdict is one server's word
 * after half an hour of refusals, and that server may have passed the bytes on, or be wrong.
 */
export const REJECTED_LOOK_MS = 10 * 60 * 1000;
/** ... for this long after it was signed (lib/eth/outbox.js, which keeps them that long). */
export { REJECTED_FOLLOW_MS };
const lastClosedLook = new Map();

/**
 * One slow look at a 'rejected' entry: mined after all (its receipt) is 'confirmed' / 'failed';
 * known to the server again is open again ('pending'); otherwise it stays as it is. Also, for a
 * 'replaced' one the history index says was mined (release re-audit RE2-5): only its receipt,
 * served by this server, undoes the replacement; the index's word alone never does. Asks the
 * server at most once per REJECTED_LOOK_MS per entry, unless `force` (right before a signing, R-7).
 * Returns the entry.
 */
export async function recheckClosed(app, rpc, entry, { ethId, kv, now = () => Date.now(), force = false } = {}) {
  if (entry.state !== 'rejected' && entry.state !== 'replaced') return entry;
  const item = now();
  const last = lastClosedLook.get(entry.hash);
  if (last === undefined) lastClosedLook.set(entry.hash, item);
  else if (!force && item - last < REJECTED_LOOK_MS) return entry;
  lastClosedLook.set(entry.hash, item);
  const receipt = await rpc.getTransactionReceipt(entry.hash);
  if (receipt) {
    const patch = { state: receipt.status === 1 ? 'confirmed' : 'failed', refusedAt: null, unsureSince: null, replacedBy: null, replacedIn: null, replacedUnseen: null, receipt: { blockNumber: receipt.blockNumber, status: receipt.status, gasUsed: String(receipt.gasUsed), effectiveGasPrice: receipt.effectiveGasPrice == null ? null : String(receipt.effectiveGasPrice) } };
    return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
  }
  if (entry.state === 'rejected' && (await rpc.getTransactionByHash(entry.hash))) {
    const patch = { state: 'pending', refusedAt: null, unsureSince: null, error: null };
    return (await updateOutbox(app, entry.hash, patch, { ethId, kv })) || { ...entry, ...patch };
  }
  return entry;
}

/**
 * What the history index (Ethereum's) teaches about an entry this device closed as 'rejected': the
 * index saw that very hash mined, so it was (audit BM-2): "Not sent" was one server's word. Never
 * about a 'replaced' one (release re-audit RE2-5): that verdict rests on evidence (the replacing
 * transaction signed by this key, with a receipt; or two servers, R-1), and an unverified index
 * row must not turn a payment that never happened into "Confirmed"; recheckClosed asks the server
 * in use for its receipt instead. The patch, or null.
 */
export function settledByIndex(entry, txs = []) {
  if (entry.state !== 'rejected' || entryChain(entry) !== 'ethereum') return null;
  const item = txs.find((x) => x.hash === entry.hash.toLowerCase() && x.blockNumber != null);
  if (!item) return null;
  return { state: item.failed ? 'failed' : 'confirmed', receipt: { blockNumber: item.blockNumber, status: item.failed ? 0 : 1, gasUsed: null, effectiveGasPrice: null }, refusedAt: null, unsureSince: null };
}

/** The fee an entry paid (mined) or may pay at most (open): {wei, final}. */
export function entryFee(entry) {
  const r = entry.receipt;
  if (r && r.gasUsed && r.effectiveGasPrice) return { wei: BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), final: true };
  return { wei: BigInt(entry.gasLimit || 0) * BigInt(entry.maxFeePerGas || 0), final: false };
}
