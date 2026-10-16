// EVM JSON-RPC (Ethereum or BNB Chain) over one server the person chose for
// that chain - one of hosts.js, or their own (hosts.js ownServerEntry: its
// address checked by lib/evm_server_address.js, its origin allowed by the
// service worker) - and no other: no fallback, because every server sees the
// IP address together with the address it is asked about. (The one second
// opinion, a swap's price, asks another listed server no question about the
// address: lib/eth/second_opinion.js.)
//
// Requests carry no cookies or credentials (credentials:'omit'), skip the
// HTTP cache (cache:'no-store': balances and nonces must be fresh), refuse
// redirects, send no referrer, and time out. Results are checked before they
// are used: ids must match, quantities must be hex, a broadcast's hash must
// be keccak256 of the bytes sent. A port of the desktop app's
// lib/wallets/ethereum/uniswap/eth_rpc.dart, plus the wallet calls.

import { ethRpcHost, rpcUrl } from './hosts.js';
import { chainOf } from './chains.js';
import { encodeCall, abiDecode } from './abi.js';
import { keccak256, normAddress } from './crypto.js';
import { bytesToHex, hexToBytes, toBytes, toQuantity, fromQuantity, fromQuantityNumber, bigIntToBytes, toBigInt } from './hex.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
/** The lowest tip walletFees() offers: 0.01 gwei. */
export const MIN_TIP_WEI = 10000000n;
/** Default widest eth_getLogs window; wider requests are refused before they are sent. */
export const MAX_LOG_RANGE = 10000;

/**
 * The most one answer may be (release audit 0.1.5, N5): a BNB Chain block with every transaction is a
 * few MB and a log search far less; a server that sends more is cut off instead of filling memory.
 */
export const MAX_ANSWER_BYTES = 32 * 1024 * 1024;

/** A response's body as text, refused once it is larger than `max` bytes (announced or read). */
export async function readTextCapped(res, max, tooBig) {
  const announced = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(announced) && announced > max) throw tooBig();
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    if (t.length > max) throw tooBig();
    return t;
  }
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      throw tooBig();
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A server's words for a block, or the state at a block, it does not have. */
const MISSING_STATE = /unknown block|header not found|block not found|missing trie node|state (?:is )?not available|state histor|pruned/i;

/** Whether `e` is a contract's refusal (EthRpcError.isRevert): false for anything else, a server's trouble included. */
export function isRevert(e) {
  return e instanceof EthRpcError && e.isRevert;
}

export class EthRpcError extends Error {
  /**
   * code: the server's JSON-RPC error code (a number), or one of 'network',
   * 'timeout', 'http', 'busy', 'bad_response', 'wrong_chain', 'range',
   * 'hash_mismatch', 'receipts_refused' (the server keeps receipts for paying users), 'too_big' (an
   * answer past MAX_ANSWER_BYTES), 'unusable' (an own server's saved address the rules no longer
   * take) for problems found on this side.
   */
  constructor(code, message, data = null) {
    super(message);
    this.code = code;
    this.data = data;
  }

  /** The server refused a log search because the block range is too long. */
  get isRangeTooLong() {
    if (this.code === 'range') return true;
    if (typeof this.code !== 'number') return false;
    const m = this.message.toLowerCase();
    return (
      m.includes('range') ||
      (m.includes('block') && (m.includes('limit') || m.includes('max'))) ||
      m.includes('too many') ||
      m.includes('exceed') ||
      m.includes('archive') ||
      m.includes('10000') ||
      m.includes('query returned more than')
    );
  }

  /**
   * The contract's own refusal ("execution reverted…"): told by the words only, never by the code
   * (release audit 0.1.6: MEV Blocker answers a call at a block it lacks with code 3, "Unknown block",
   * the code geth gives a revert). A server without the block or its state ("unknown block", "header
   * not found", "missing trie node"…, any code) could not run the call: it says nothing about it.
   * USDT's overflow check ends on an invalid opcode, said "invalid opcode: INVALID" or "EVM error:
   * InvalidFEOpcode" by every listed Ethereum server: also the contract's own refusal (release audit
   * 0.1.6, S3: it read as the server's trouble on every server).
   */
  get isRevert() {
    if (typeof this.code !== 'number') return false;
    const m = String(this.message || '');
    return /execution reverted|\brevert|invalid opcode|InvalidFEOpcode/i.test(m) && !MISSING_STATE.test(m);
  }

  /** A server without the block or the state the call was asked at (any code): ask again, or another server. */
  get isMissingState() {
    return typeof this.code === 'number' && MISSING_STATE.test(String(this.message || ''));
  }

  /** The largest range the message names ("max block range 100000", "up to a 10 block range"), if any. */
  get suggestedRange() {
    const ns = [...this.message.matchAll(/(\d[\d,]*)/g)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isSafeInteger(n) && n >= 10 && n <= 5000000);
    return ns.length ? Math.min(...ns) : null;
  }
}

const TAGS = new Set(['latest', 'pending', 'safe', 'finalized', 'earliest']);

function blockParam(b) {
  if (typeof b === 'string' && TAGS.has(b)) return b;
  return toQuantity(b);
}

function txObject({ from, to, data, value }) {
  const o = {};
  if (from) o.from = normAddress(from);
  if (to) o.to = normAddress(to);
  if (data !== undefined) o.data = bytesToHex(toBytes(data));
  if (value !== undefined && toBigInt(value) > 0n) o.value = toQuantity(value);
  return o;
}

function dataResult(r, what) {
  if (typeof r !== 'string') throw new EthRpcError('bad_response', `${what}: expected hex data`);
  try {
    return hexToBytes(r);
  } catch {
    throw new EthRpcError('bad_response', `${what}: expected hex data`);
  }
}

function quantityResult(r, what) {
  try {
    return fromQuantity(r);
  } catch {
    throw new EthRpcError('bad_response', `${what}: expected a hex quantity`);
  }
}

function parseLog(l) {
  if (!l || typeof l.address !== 'string' || !Array.isArray(l.topics)) throw new EthRpcError('bad_response', 'bad log entry');
  return {
    address: l.address.toLowerCase(),
    topics: l.topics.map((t) => String(t).toLowerCase()),
    data: dataResult(l.data, 'log data'),
    blockNumber: l.blockNumber == null ? null : fromQuantityNumber(l.blockNumber),
    transactionHash: l.transactionHash ? String(l.transactionHash).toLowerCase() : null,
    logIndex: l.logIndex == null ? null : fromQuantityNumber(l.logIndex),
    removed: l.removed === true,
  };
}

/** A server's words for "receipts are for paying users only" (PublicNode's, and the usual ones). */
const RECEIPTS_FOR_PAYING_USERS = /archive requests require|personal token|api key|upgrade your plan/i;

export class EthRpc {
  /**
   * host: an entry of hosts.js (ETH_RPC_HOSTS, BSC_RPC_HOSTS) or its id, or the person's own
   * server's entry (ownServerEntry). `fetch` and `timeoutMs` are for tests and slow links; the URL
   * can only come from the list or from that checked entry (rpcUrl).
   * chain: the chain that server serves (lib/eth/chains.js).
   */
  constructor(host, { fetch: fetchImpl, timeoutMs = 20000, maxBatch = 25, gate = null, maxBytes = MAX_ANSWER_BYTES } = {}) {
    this.host = typeof host === 'string' ? ethRpcHost(host) : host;
    // The person's own server whose saved address the rules no longer take: refused, said so (N2).
    this.url = this.host && this.host.unusable ? null : rpcUrl(this.host);
    this.maxBytes = maxBytes;
    // Awaited before each request, before its time starts (lib/eth/wallet.js holds BNB Chain's
    // requests until the person was told its server changed).
    this._gate = gate;
    this.chain = chainOf(this.host.chain || 'ethereum');
    this.timeoutMs = timeoutMs;
    this.maxBatch = maxBatch;
    this._fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this._id = 0;
  }

  async _post(payload) {
    if (!this.url) throw new EthRpcError('unusable', `The address saved for your own ${this.chain.name} server is not one Firo PWA can use any more. Pick a server again.`);
    if (this._gate) await this._gate();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      let res;
      try {
        res = await this._fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          signal: ctrl.signal,
        });
      } catch (e) {
        if (ctrl.signal.aborted) throw new EthRpcError('timeout', `${this.host.name} didn't answer in time.`);
        throw new EthRpcError('network', `${this.host.name} could not be reached.`);
      }
      if (res.status === 429) throw new EthRpcError('busy', `${this.host.name} is busy (too many requests).`);
      let text;
      try {
        text = await readTextCapped(res, this.maxBytes, () => new EthRpcError('too_big', `${this.host.name} answered with far more than any request needs.`));
      } catch (e) {
        if (e instanceof EthRpcError) throw e;
        throw new EthRpcError(ctrl.signal.aborted ? 'timeout' : 'network', `${this.host.name} stopped answering.`);
      }
      if (!text) throw new EthRpcError('http', `Empty answer from ${this.host.name} (HTTP ${res.status}).`);
      try {
        return JSON.parse(text);
      } catch {
        throw new EthRpcError('http', `${this.host.name} did not answer with JSON (HTTP ${res.status}).`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  static _result(m, id) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new EthRpcError('bad_response', 'Not a JSON-RPC answer.');
    if (id !== undefined && m.id !== id) throw new EthRpcError('bad_response', 'The answer is for another request.');
    if (m.error) {
      const e = m.error;
      throw new EthRpcError(typeof e.code === 'number' ? e.code : -1, typeof e.message === 'string' ? e.message : 'RPC error', typeof e.data === 'string' ? e.data : null);
    }
    if (!('result' in m)) throw new EthRpcError('bad_response', 'A JSON-RPC answer without a result.');
    return m.result;
  }

  async call(method, params = []) {
    const id = ++this._id;
    return EthRpc._result(await this._post({ jsonrpc: '2.0', id, method, params }), id);
  }

  /**
   * Several requests in few round trips: [[method, params], …] → results in
   * order, each a value or an EthRpcError. Falls back to one by one when the
   * server does not take batches.
   */
  async batch(requests) {
    const out = [];
    for (let i = 0; i < requests.length; i += this.maxBatch) {
      const part = requests.slice(i, i + this.maxBatch);
      const first = this._id + 1;
      const payload = part.map(([method, params = []]) => ({ jsonrpc: '2.0', id: ++this._id, method, params }));
      const answer = await this._post(payload);
      if (!Array.isArray(answer)) {
        for (const [method, params] of part) out.push(await this.call(method, params).catch((e) => e));
        continue;
      }
      const byId = new Map(answer.filter((a) => a && typeof a === 'object').map((a) => [a.id, a]));
      part.forEach((_, j) => {
        const item = byId.get(first + j);
        if (!item) out.push(new EthRpcError('bad_response', 'No answer in the batch.'));
        else {
          try {
            out.push(EthRpc._result(item));
          } catch (e) {
            out.push(e);
          }
        }
      });
    }
    return out;
  }

  async chainId() {
    return quantityResult(await this.call('eth_chainId'), 'eth_chainId');
  }

  /** That the server is on its own chain (Ethereum 1, BNB Chain 56). Asks again every time: call right before signing. */
  async assertChain() {
    const id = await this.chainId();
    if (id !== BigInt(this.chain.chainId)) throw new EthRpcError('wrong_chain', `${this.host.name} is not on ${this.chain.name} (chain id ${id}).`);
  }

  /** The same check, by its old name. */
  async assertMainnet() {
    return this.assertChain();
  }

  async blockNumber() {
    return fromQuantityNumber(await this.call('eth_blockNumber'));
  }

  async getBalance(address, block = 'latest') {
    return quantityResult(await this.call('eth_getBalance', [normAddress(address), blockParam(block)]), 'eth_getBalance');
  }

  /** The nonce for the next transaction: counts pending ones too, by default. */
  async getTransactionCount(address, block = 'pending') {
    return quantityResult(await this.call('eth_getTransactionCount', [normAddress(address), blockParam(block)]), 'eth_getTransactionCount');
  }

  async getCode(address, block = 'latest') {
    return dataResult(await this.call('eth_getCode', [normAddress(address), blockParam(block)]), 'eth_getCode');
  }

  /** eth_call → returned bytes. Reverts come back as EthRpcError with the revert data in .data. */
  async ethCall({ to, data, from, value }, block = 'latest') {
    return dataResult(await this.call('eth_call', [txObject({ from, to, data, value }), blockParam(block)]), 'eth_call');
  }

  async estimateGas({ from, to, data, value }) {
    return quantityResult(await this.call('eth_estimateGas', [txObject({ from, to, data, value })]), 'eth_estimateGas');
  }

  /**
   * Broadcasts signed bytes and returns their hash, which must be
   * keccak256(raw). Sending the same bytes twice is safe: a server that
   * already has them says so, and that counts as sent.
   */
  async sendRawTransaction(raw) {
    const bytes = toBytes(raw);
    const hash = bytesToHex(keccak256(bytes));
    let r;
    try {
      r = await this.call('eth_sendRawTransaction', [bytesToHex(bytes)]);
    } catch (e) {
      if (e instanceof EthRpcError && typeof e.code === 'number' && /already known|known transaction|already imported/i.test(e.message)) return hash;
      throw e;
    }
    if (typeof r !== 'string' || r.toLowerCase() !== hash) throw new EthRpcError('hash_mismatch', `${this.host.name} answered with a different transaction hash.`);
    return hash;
  }

  async getTransactionByHash(hash) {
    const r = await this.call('eth_getTransactionByHash', [bytesToHex(toBytes(hash))]);
    if (r !== null && (typeof r !== 'object' || String(r.hash).toLowerCase() !== String(hash).toLowerCase())) throw new EthRpcError('bad_response', 'The transaction answered is not the one asked for.');
    return r;
  }

  /**
   * Block `block` (a number or a tag) with its transactions as objects (full) or hashes; null
   * when the server has no such block. What the transactions say is the server's word: check
   * them (tx.js verifyRpcTransaction) before acting on one.
   */
  async getBlockByNumber(block, full = false) {
    const r = await this.call('eth_getBlockByNumber', [blockParam(block), Boolean(full)]);
    if (r === null) return null;
    if (typeof r !== 'object' || !Array.isArray(r.transactions)) throw new EthRpcError('bad_response', 'The block answered has no transaction list.');
    return r;
  }

  /**
   * null while pending or unknown; else {status 1|0, blockNumber, gasUsed, effectiveGasPrice, logs, …}.
   * A server that keeps receipts for paying users only (PublicNode on BNB Chain since 2026-10: "Archive
   * requests require a personal token", even for a transaction 3 blocks old) is never replaced by
   * another one here: only the server the person picked sees their address (hosts.js). It is named as
   * such ('receipts_refused'), so the payment screen can say so and offer to pick another server
   * (release audit 0.1.5, B1), instead of waiting forever (live test, 2026-10-14).
   */
  async getTransactionReceipt(hash) {
    try {
      return await this._receipt(hash);
    } catch (e) {
      if (e instanceof EthRpcError && RECEIPTS_FOR_PAYING_USERS.test(e.message)) throw new EthRpcError('receipts_refused', `${this.host.name} no longer says whether a transaction went through.`);
      throw e;
    }
  }

  async _receipt(hash) {
    const h = bytesToHex(toBytes(hash));
    const r = await this.call('eth_getTransactionReceipt', [h]);
    if (r === null) return null;
    if (typeof r !== 'object' || String(r.transactionHash).toLowerCase() !== h) throw new EthRpcError('bad_response', 'The receipt answered is not for this transaction.');
    const status = quantityResult(r.status, 'receipt status');
    if (status !== 0n && status !== 1n) throw new EthRpcError('bad_response', 'Bad receipt status.');
    return {
      transactionHash: h,
      status: Number(status),
      blockNumber: fromQuantityNumber(r.blockNumber),
      blockHash: r.blockHash ? String(r.blockHash).toLowerCase() : null,
      from: r.from ? String(r.from).toLowerCase() : null,
      to: r.to ? String(r.to).toLowerCase() : null,
      gasUsed: quantityResult(r.gasUsed, 'gasUsed'),
      effectiveGasPrice: r.effectiveGasPrice == null ? null : quantityResult(r.effectiveGasPrice, 'effectiveGasPrice'),
      logs: Array.isArray(r.logs) ? r.logs.map(parseLog) : [],
    };
  }

  /** One 32-byte storage word. `slot` is a bigint or 32-byte hex. */
  async getStorageAt(address, slot, block = 'latest') {
    const key = typeof slot === 'bigint' || typeof slot === 'number' ? bigIntToBytes(toBigInt(slot), 32) : toBytes(slot);
    if (key.length !== 32) throw new EthRpcError('bad_response', 'A storage slot is 32 bytes.');
    const r = dataResult(await this.call('eth_getStorageAt', [normAddress(address), bytesToHex(key), blockParam(block)]), 'eth_getStorageAt');
    if (r.length > 32) throw new EthRpcError('bad_response', 'A storage word is 32 bytes.');
    const out = new Uint8Array(32);
    out.set(r, 32 - r.length);
    return out;
  }

  async feeHistory(blockCount, newest = 'latest', percentiles = []) {
    const r = await this.call('eth_feeHistory', [toQuantity(blockCount), blockParam(newest), percentiles]);
    if (!r || !Array.isArray(r.baseFeePerGas)) throw new EthRpcError('bad_response', 'eth_feeHistory: no base fees.');
    return r;
  }

  /**
   * eth_getLogs over fromBlock…toBlock (numbers). Refused here, without asking,
   * when the window is wider than maxRange: no unbounded searches.
   */
  async getLogs({ address, topics = [], fromBlock, toBlock }, { maxRange = MAX_LOG_RANGE } = {}) {
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) throw new EthRpcError('range', 'A log search needs a block range.');
    if (toBlock - fromBlock + 1 > maxRange) throw new EthRpcError('range', `A log search covers at most ${maxRange} blocks.`);
    const filter = { fromBlock: toQuantity(fromBlock), toBlock: toQuantity(toBlock), topics };
    if (address) filter.address = Array.isArray(address) ? address.map(normAddress) : normAddress(address);
    const r = await this.call('eth_getLogs', [filter]);
    if (!Array.isArray(r)) throw new EthRpcError('bad_response', 'eth_getLogs: expected a list.');
    return r.map(parseLog);
  }

  /**
   * Logs of a long range in chunks the server accepts (from its own error
   * message, else 10,000 then 1,000 blocks), at most `maxRequests` requests.
   * Never throws for a refused range: returns what it found, with
   * `complete:false` and `scannedTo`, so a later search can carry on.
   */
  async getLogsChunked({ address, topics = [], fromBlock, toBlock }, { maxRequests = 40, range = MAX_LOG_RANGE } = {}) {
    const logs = [];
    let start = fromBlock;
    let size = Math.min(range, MAX_LOG_RANGE);
    let requests = 0;
    while (start <= toBlock) {
      if (requests >= maxRequests) return { logs, scannedTo: start - 1, complete: false, refused: null };
      const end = Math.min(toBlock, start + size - 1);
      requests++;
      try {
        logs.push(...(await this.getLogs({ address, topics, fromBlock: start, toBlock: end }, { maxRange: size })));
        start = end + 1;
      } catch (e) {
        if (!(e instanceof EthRpcError) || !e.isRangeTooLong) throw e;
        const suggested = e.suggestedRange;
        const next = suggested && suggested < size ? suggested : size > 1000 ? 1000 : 0;
        // A server that searches only a few blocks at a time cannot cover a
        // useful history; stop and let the caller say so.
        if (next < 1000) return { logs, scannedTo: start - 1, complete: false, refused: e };
        size = next;
      }
    }
    return { logs, scannedTo: toBlock, complete: true, refused: null };
  }

  /**
   * Read-only calls through Multicall3.aggregate3, each allowed to fail on
   * its own → [{success, data}] in order. `chunk` calls per eth_call keeps
   * each under the server's gas cap; `parallel` requests at a time.
   */
  async multicall(calls, { chunk = 40, parallel = 4, block = 'latest' } = {}) {
    const parts = [];
    for (let i = 0; i < calls.length; i += chunk) parts.push(calls.slice(i, i + chunk));
    const results = new Array(parts.length);
    const run = async (i) => {
      const data = encodeCall('aggregate3((address,bool,bytes)[])', [parts[i].map((c) => [c.to, true, toBytes(c.data)])]);
      const raw = await this.ethCall({ to: MULTICALL3, data }, block);
      const [decoded] = abiDecode('(bool,bytes)[]', raw);
      if (decoded.length !== parts[i].length) throw new EthRpcError('bad_response', 'Multicall3 answered a different number of calls.');
      results[i] = decoded.map(([success, d]) => ({ success, data: d }));
    };
    for (let i = 0; i < parts.length; i += parallel) {
      const batch = [];
      for (let j = i; j < i + parallel && j < parts.length; j++) batch.push(run(j));
      await Promise.all(batch);
    }
    return results.flat();
  }
}

/**
 * EIP-1559 fees for a transaction this wallet sends, as the desktop app's
 * walletFees(): eth_feeHistory(5, latest, [50]); the next block's base fee
 * (the last entry), the median of the five 50th-percentile tips (at least
 * 0.01 gwei), and room for the base fee to double before it is mined:
 * maxFeePerGas = 2 × base + tip.
 */
export async function walletFees(rpc) {
  const chain = rpc.chain || chainOf('ethereum');
  if (chain.fees === 'gasPrice') {
    // BNB Chain: base fee 0; the gas price the network asks now, never below the chain's floor, as both caps.
    let price = quantityResult(await rpc.call('eth_gasPrice'), 'eth_gasPrice');
    if (price < chain.minTipWei) price = chain.minTipWei;
    // Never above the chain's ceiling: all of it is paid, so a server inflating it takes that much more (P6).
    const capped = chain.maxTipWei != null && price > chain.maxTipWei;
    if (capped) price = chain.maxTipWei;
    return { baseFee: 0n, maxPriorityFeePerGas: price, maxFeePerGas: price, capped };
  }
  const r = await rpc.feeHistory(5, 'latest', [50]);
  const bases = r.baseFeePerGas.map((b) => quantityResult(b, 'baseFeePerGas'));
  if (!bases.length) throw new EthRpcError('bad_response', 'eth_feeHistory: no base fees.');
  const next = bases[bases.length - 1];
  const tips = (Array.isArray(r.reward) ? r.reward : [])
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => quantityResult(row[0], 'reward'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const floor = chain.minTipWei > MIN_TIP_WEI ? chain.minTipWei : MIN_TIP_WEI;
  let tip = tips.length ? tips[Math.floor(tips.length / 2)] : floor;
  if (tip < floor) tip = floor;
  // The tip is paid in full, unlike the base fee the chain sets: never above the chain's ceiling (P6).
  const capped = chain.maxTipWei != null && tip > chain.maxTipWei;
  if (capped) tip = chain.maxTipWei;
  return { baseFee: next, maxPriorityFeePerGas: tip, maxFeePerGas: next * 2n + tip, capped };
}

/** A gas limit for an estimate: a quarter more, and at least 20,000 more (the desktop app's gasWithHeadroom). */
export function gasWithHeadroom(estimate) {
  const e = toBigInt(estimate);
  const more = (e * 125n) / 100n;
  return more - e < 20000n ? e + 20000n : more;
}
