// An address's past transactions, from Stack Wallet's history index
// (GET /export on eth2.stackwallet.com, the desktop app's
// lib/services/ethereum/ethereum_api.dart), merged with what this device sent
// (lib/eth/outbox.js). Asked only while Settings -> Ethereum -> "History from
// Stack Wallet" is on; with it off, only this device's own transactions show.
//
// What the index answers is untrusted: every field is checked, anything that
// does not parse is dropped, and amounts are exact BigInts. The fee is
// gasUsed x effectiveGasPrice (both small integers), not the index's
// gasCost, which arrives as a JSON number and loses digits above 2^53 wei.
//
// The index answers at most PAGE transactions per request, oldest first;
// later pages start at the last block seen (firstBlock), as the desktop app
// does. Token movements come from one request per known token (`emitter`):
// only Transfer events naming this address, only for the tokens in
// lib/eth/tokens.js.

import { historyUrl } from './hosts.js';
import { readTextCapped, MAX_ANSWER_BYTES } from './rpc.js';
import { ETH, TOKENS, nativeFor, tokensFor } from './tokens.js';
import { entryChain } from './outbox.js';
import { t } from '../i18n.js';

export const PAGE = 250;
export const MAX_PAGES = 8;
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

export class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'network' | 'timeout' | 'http' | 'bad_response'
  }
}

function uint(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === 'string' && /^\d{1,78}$/.test(v)) return BigInt(v);
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  return null;
}

function blockNo(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function direction(from, to, me) {
  if (from === me && to === me) return 'self';
  return from === me ? 'out' : 'in';
}

/**
 * The index's transaction list for `address` -> [{hash, blockNumber,
 * timestamp, from, to, value, fee, failed, nonce, contractCall}], skipping
 * entries that do not name the address or do not parse.
 */
export function parseTransactions(json, address) {
  const me = address.toLowerCase();
  const list = json && Array.isArray(json.data) ? json.data : null;
  if (!list) throw new HistoryError('bad_response', t("The history index's answer has no list."));
  const out = [];
  for (const tx of list) {
    if (!tx || typeof tx !== 'object' || !HASH.test(tx.hash) || !ADDR.test(tx.from) || !(tx.to === null || ADDR.test(tx.to))) continue;
    const from = tx.from.toLowerCase();
    const to = tx.to ? tx.to.toLowerCase() : null;
    if (from !== me && to !== me) continue;
    const value = uint(tx.value);
    if (value === null) continue;
    // Nothing sent to this address by someone else: never listed (public audit, PN). Address
    // poisoning sends such transactions from a look-alike address, for it to be copied from the
    // history next time.
    if (value === 0n && from !== me) continue;
    const receipt = tx.receipt && typeof tx.receipt === 'object' ? tx.receipt : null;
    const gasUsed = uint(receipt && receipt.gasUsed != null ? receipt.gasUsed : tx.gasUsed);
    const price = uint(receipt && receipt.effectiveGasPrice != null ? receipt.effectiveGasPrice : tx.gasPrice);
    const blockNumber = blockNo(tx.blockNumber);
    out.push({
      hash: tx.hash.toLowerCase(),
      blockNumber,
      timestamp: Number.isSafeInteger(tx.timestamp) && tx.timestamp > 0 ? tx.timestamp : null,
      from,
      to,
      value,
      fee: gasUsed !== null && price !== null ? gasUsed * price : null,
      failed: Boolean(receipt && receipt.status === 0) || tx.isError === true,
      nonce: Number.isSafeInteger(tx.nonce) ? tx.nonce : null,
      contractCall: typeof tx.input === 'string' && tx.input.length > 2,
    });
  }
  return out;
}

function topicAddress(topic) {
  if (typeof topic !== 'string' || !WORD.test(topic) || !/^0x0{24}/i.test(topic)) return null;
  return `0x${topic.slice(26).toLowerCase()}`;
}

/**
 * The index's logs of `token` about `address` -> its Transfer events that move
 * the token to or from the address: [{hash, blockNumber, timestamp, logIndex,
 * from, to, amount, token}]. Approvals and other events are skipped.
 */
export function parseTokenTransfers(json, address, token) {
  const me = address.toLowerCase();
  const list = json && Array.isArray(json.data) ? json.data : null;
  if (!list) throw new HistoryError('bad_response', t("The history index's answer has no list."));
  const out = [];
  for (const l of list) {
    if (!l || typeof l !== 'object' || !HASH.test(l.transactionHash) || typeof l.address !== 'string' || l.address.toLowerCase() !== token.address) continue;
    if (!Array.isArray(l.topics) || l.topics.length !== 3 || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    if (!from || !to || (from !== me && to !== me)) continue;
    if (typeof l.data !== 'string' || !WORD.test(l.data)) continue;
    // A transfer of nothing moves nothing: never listed. Anyone can make the token log one, from this
    // address too (transferFrom of 0), to a look-alike address to be copied next time (PN).
    if (BigInt(l.data) === 0n) continue;
    out.push({
      hash: l.transactionHash.toLowerCase(),
      blockNumber: blockNo(l.blockNumber),
      timestamp: Number.isSafeInteger(l.timestamp) && l.timestamp > 0 ? l.timestamp : null,
      logIndex: Number.isSafeInteger(l.logIndex) ? l.logIndex : 0,
      from,
      to,
      amount: BigInt(l.data),
      token,
    });
  }
  return out;
}

/**
 * One list for the screen, newest first. Each item: {hash, at (ms or null),
 * blockNumber, direction 'in'|'out'|'self', asset (ETH or a token), amount,
 * counterparty, fee (wei, only what this address paid), state, local}.
 * state: 'confirmed' | 'failed' | an outbox state for what is still open.
 * A transaction this device sent is shown once: the outbox entry, completed
 * with what the index knows. A token transfer replaces its 0-ETH call.
 */
export function mergeActivity({ address, outbox = [], txs = [], transfers = [], chain = 'ethereum' }) {
  const me = address.toLowerCase();
  // The index is Ethereum's: on another chain only what this device sent is known.
  if (chain !== 'ethereum') {
    txs = [];
    transfers = [];
  }
  outbox = outbox.filter((e) => entryChain(e) === chain);
  const native = nativeFor(chain);
  const tokens = tokensFor(chain);
  const byHash = new Map();
  const fees = new Map();
  for (const tx of txs) {
    if (tx.from === me && tx.fee !== null) fees.set(tx.hash, tx.fee);
    if (tx.value === 0n && tx.contractCall) continue; // a contract call: shown through its token transfer, if any
    byHash.set(`${tx.hash}:eth`, {
      hash: tx.hash,
      at: tx.timestamp ? tx.timestamp * 1000 : null,
      blockNumber: tx.blockNumber,
      direction: direction(tx.from, tx.to, me),
      asset: ETH,
      amount: tx.value,
      counterparty: tx.from === me ? tx.to : tx.from,
      fee: tx.from === me ? tx.fee : null,
      state: tx.failed ? 'failed' : 'confirmed',
      local: false,
    });
  }
  for (const x of transfers) {
    byHash.set(`${x.hash}:${x.token.address}:${x.logIndex}`, {
      hash: x.hash,
      at: x.timestamp ? x.timestamp * 1000 : null,
      blockNumber: x.blockNumber,
      direction: direction(x.from, x.to, me),
      asset: x.token,
      amount: x.amount,
      counterparty: x.from === me ? x.to : x.from,
      fee: x.from === me ? fees.get(x.hash) ?? null : null,
      state: 'confirmed',
      local: false,
    });
  }
  // What this device sent replaces whatever the index said about the same hash, except "Not sent"
  // ('rejected': one server's word) against the index having seen it mined: the index wins (audit
  // BM-2). A 'replaced' stays (RE2-5): proven, it is undone only by the server's receipt.
  for (const e of outbox) {
    const keys = [...byHash.keys()].filter((k) => k.startsWith(`${e.hash}:`));
    if (e.state === 'rejected' && keys.some((k) => byHash.get(k).blockNumber != null)) continue;
    for (const k of keys) byHash.delete(k);
    const asset = e.token ? tokens.find((token2) => token2.address === e.token.toLowerCase()) || null : native;
    if (!asset) continue;
    const r = e.receipt;
    byHash.set(`${e.hash}:local`, {
      hash: e.hash,
      at: e.createdAt,
      blockNumber: r ? r.blockNumber : null,
      direction: e.to.toLowerCase() === me ? 'self' : 'out',
      asset,
      amount: BigInt(e.amount),
      counterparty: e.to.toLowerCase(),
      fee: r && r.gasUsed && r.effectiveGasPrice ? BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice) : null,
      state: e.state,
      local: true,
      // A Uniswap swap or approval sent from this device (lib/eth/uniswap_app.js): what it was for.
      kind: typeof e.kind === 'string' ? e.kind : null,
      swapOut: typeof e.tokenOutSymbol === 'string' ? e.tokenOutSymbol : null,
      // A payment another feature asked for (lib/eth/send_raw.js): what it was, in its words.
      label: typeof e.label === 'string' ? e.label.slice(0, 80) : null,
      // Open but in doubt (lib/eth/send.js): 'unsure' (its nonce said used, nothing shown) or 'refused'.
      doubt: e.state !== 'signed' && e.state !== 'pending' ? null : e.unsureSince ? 'unsure' : e.refusedAt && e.state === 'signed' ? 'refused' : null,
    });
  }
  const items = [...byHash.values()].map((i) => ({ ...i, chain }));
  // Open ones first, then by block (newest), then by time.
  const open = (i) => (i.state === 'signed' || i.state === 'pending' ? 1 : 0);
  items.sort((a, b) => open(b) - open(a) || (b.blockNumber ?? Infinity) - (a.blockNumber ?? Infinity) || (b.at ?? 0) - (a.at ?? 0));
  return items;
}

async function getJson(url, { fetch: fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors', signal: ctrl.signal });
    } catch {
      if (ctrl.signal.aborted) throw new HistoryError('timeout', t("Stack Wallet's history index didn't answer in time."));
      throw new HistoryError('network', t("Stack Wallet's history index could not be reached."));
    }
    if (!res.ok) throw new HistoryError('http', t('Stack Wallet\'s history index answered HTTP {status}.', { status: res.status }));
    // Capped like every answer from a server (release audit 0.1.5, N5).
    let text;
    try {
      text = await readTextCapped(res, MAX_ANSWER_BYTES, () => new HistoryError('too_big', t("Stack Wallet's history index answered with far more than any history needs.")));
    } catch (e) {
      if (e instanceof HistoryError) throw e;
      throw new HistoryError(ctrl.signal.aborted ? 'timeout' : 'network', t("Stack Wallet's history index stopped answering."));
    }
    // An address with nothing gets an empty body, not an empty list (as the desktop app notes).
    if (!text.trim()) return { data: [] };
    try {
      return JSON.parse(text);
    } catch {
      throw new HistoryError('bad_response', t("Stack Wallet's history index did not answer with JSON."));
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything the index knows about `address`: {txs, transfers}. Throws a
 * HistoryError when the index cannot be asked; the caller still shows the
 * outbox.
 */
export async function fetchHistory(address, { fetch, timeoutMs, tokens = TOKENS } = {}) {
  const opts = { fetch, timeoutMs };
  const txs = [];
  const seen = new Set();
  let firstBlock = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await getJson(historyUrl(address, { firstBlock }), opts);
    const raw = Array.isArray(json && json.data) ? json.data.length : 0;
    let last = firstBlock;
    for (const tx of parseTransactions(json, address)) {
      if (tx.blockNumber !== null && tx.blockNumber > last) last = tx.blockNumber;
      if (seen.has(tx.hash)) continue;
      seen.add(tx.hash);
      txs.push(tx);
    }
    if (raw < PAGE || last === firstBlock) break;
    firstBlock = last;
  }
  const transfers = (await Promise.all(tokens.map(async (token) => parseTokenTransfers(await getJson(historyUrl(address, { emitter: token.address }), opts), address, token)))).flat();
  return { txs, transfers };
}
