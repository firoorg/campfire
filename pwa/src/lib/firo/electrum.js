// ElectrumX JSON-RPC over a secure WebSocket, for Firo's servers
// (wss://electrumx{,01,02,03}.firo.org:50004). One connection at a time; the
// same code runs in browsers and in Node 22 (global WebSocket).
//
//   - `server.version` is sent first on every connection: ElectrumX 1.19
//     refuses anything else before it.
//   - Requests made while (re)connecting wait for the connection; each has
//     its own timeout either way.
//   - Batches go out as one JSON-RPC array.
//   - A ping keeps idle connections alive and finds dead ones.
//   - A lost connection is re-made with exponential backoff, moving through
//     the server list; header and script-hash subscriptions are renewed.
//
// Privacy: every server sees the IP address together with whatever it is
// asked. One server at a time, so the queries of one wallet are not spread
// over all of them, and nothing is retried on a second server behind the
// person's back except by the failover itself.

/** The largest single answer accepted from a server (audit D-13). */
import { t } from '../i18n.js';

export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export class ElectrumError extends Error {
  /**
   * code: 'offline' (no server reachable / connection lost), 'timeout',
   * 'server' (the server answered with an error; `rpcCode` holds its code),
   * 'bad_response', 'closed' (close() was called).
   * written: for a request that got no answer, whether its bytes had been handed to a socket (the
   * server may have acted on it: a broadcast may have been relayed). False: it never left this page.
   */
  constructor(code, message, { rpcCode = null, data = null, written = false } = {}) {
    super(message);
    this.code = code;
    this.rpcCode = rpcCode;
    this.data = data;
    this.written = Boolean(written);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class ElectrumClient {
  /**
   * @param {object} o
   * @param {string[]} o.servers wss:// URLs in order of preference
   * @param {Function} [o.WebSocket] constructor (tests pass a fake)
   */
  constructor({
    servers,
    WebSocket: WS = globalThis.WebSocket,
    clientName = 'Campfire',
    protocolVersion = '1.4',
    timeoutMs = 30000,
    connectTimeoutMs = 12000,
    pingIntervalMs = 60000,
    maxBatch = 50,
    reconnect = true,
    backoffInitialMs = 1000,
    backoffMaxMs = 60000,
    random = Math.random,
  } = {}) {
    if (!Array.isArray(servers) || servers.length === 0) throw new Error(t('At least one server is needed.'));
    for (const s of servers) if (typeof s !== 'string' || !/^wss?:\/\//.test(s)) throw new Error(t('Not a WebSocket URL: {s}', { s }));
    if (typeof WS !== 'function') throw new Error(t('No WebSocket available.'));
    this.servers = servers.slice();
    this.WS = WS;
    this.clientName = clientName;
    this.protocolVersion = protocolVersion;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.pingIntervalMs = pingIntervalMs;
    this.maxBatch = maxBatch;
    this.reconnect = reconnect;
    this.backoffInitialMs = backoffInitialMs;
    this.backoffMaxMs = backoffMaxMs;
    this.random = random;

    this._ws = null;
    this._ready = false; // handshake done
    this._closed = false;
    this._index = 0; // server in use / to try next
    this._failuresInRound = 0;
    this._backoff = backoffInitialMs;
    this._id = 0;
    this._pending = new Map(); // id → {resolve, reject, timer, written}
    this._queue = []; // payloads waiting for the handshake (never a broadcast: see broadcast())
    this._listeners = new Map();
    this._headerSub = false;
    this._shSubs = new Map(); // scripthash → last status
    this._connecting = null;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this.serverVersion = null;
    this.lastHeader = null;
  }

  // ------------------------------------------------------------ state, events

  get connected() {
    return this._ready;
  }

  /** The URL of the server in use, or null. */
  get server() {
    return this._ready ? this.servers[this._index] : null;
  }

  /** The URL of the server in use or, while (re)connecting, the one being tried or tried next; null once closed. */
  get target() {
    return this._closed ? null : this.servers[this._index];
  }

  /** on('status' | 'header' | 'scripthash' | 'error', fn) → off() */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, ...args) {
    for (const fn of this._listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch {
        // a listener's problem is not the connection's
      }
    }
  }

  _status() {
    this._emit('status', { connected: this._ready, server: this.server });
  }

  // ------------------------------------------------------------ connecting

  /**
   * Connects to the first server that answers, trying each once; resolves
   * when the handshake is done. Rejects ElectrumError('offline') when none
   * answers (with reconnect on, it keeps trying in the background).
   */
  connect() {
    if (this._closed) return Promise.reject(new ElectrumError('closed', t('The connection was closed.')));
    if (this._ready) return Promise.resolve();
    if (this._connecting) return this._connecting;
    this._connecting = this._connectRound().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _connectRound() {
    let lastError = null;
    for (let i = 0; i < this.servers.length; i++) {
      if (this._closed) throw new ElectrumError('closed', t('The connection was closed.'));
      try {
        await this._open(this.servers[this._index]);
        this._failuresInRound = 0;
        this._backoff = this.backoffInitialMs;
        return;
      } catch (e) {
        lastError = e;
        this._index = (this._index + 1) % this.servers.length;
      }
    }
    if (this.reconnect && !this._closed) this._scheduleReconnect();
    throw new ElectrumError('offline', (lastError ? t('No Firo node could be reached ({error}).', { error: lastError.message }) : t('No Firo node could be reached.')));
  }

  _open(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      let handshakeId = null;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (handshakeId !== null) this._pending.delete(handshakeId);
        try {
          ws?.close();
        } catch {
          // already closed
        }
        if (this._ws === ws) this._ws = null;
        reject(new ElectrumError('offline', msg));
      };
      const timer = setTimeout(() => fail(t('{url} did not answer in time', { url: hostOf(url) })), this.connectTimeoutMs);
      try {
        ws = new this.WS(url);
      } catch (e) {
        fail(`${hostOf(url)}: ${e.message}`);
        return;
      }
      this._ws = ws;
      ws.onmessage = (ev) => this._onMessage(ws, ev.data);
      ws.onerror = () => {
        if (!settled) fail(t('{url} could not be reached', { url: hostOf(url) }));
      };
      ws.onclose = () => {
        if (!settled) fail(t('{url} closed the connection', { url: hostOf(url) }));
        else this._onClose(ws);
      };
      ws.onopen = () => {
        // The handshake goes out before anything queued.
        const id = ++this._id;
        handshakeId = id;
        this._pending.set(id, {
          resolve: (v) => {
            if (settled) return;
            if (!Array.isArray(v) || typeof v[0] !== 'string') {
              fail(t('{url} gave an odd server.version answer', { url: hostOf(url) }));
              return;
            }
            settled = true;
            clearTimeout(timer);
            this.serverVersion = v;
            this._ready = true;
            this._afterHandshake();
            resolve();
          },
          reject: (e) => fail(t('{url} refused the handshake: {message}', { url: hostOf(url), message: e.message })),
          timer: null,
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'server.version', params: [this.clientName, this.protocolVersion] }));
      };
    });
  }

  _afterHandshake() {
    this._status();
    const q = this._queue;
    this._queue = [];
    for (const payload of q) this._send(payload);
    // Renew subscriptions after a reconnect; their answers update listeners.
    if (this._headerSub) {
      this.request('blockchain.headers.subscribe', []).then(
        (h) => this._onHeader(h),
        () => {},
      );
    }
    for (const sh of this._shSubs.keys()) {
      this.request('blockchain.scripthash.subscribe', [sh]).then(
        (status) => this._onScripthash(sh, status),
        () => {},
      );
    }
    this._startPing();
  }

  _onClose(ws) {
    if (this._ws !== ws) return;
    this._ws = null;
    const wasReady = this._ready;
    this._ready = false;
    this._stopPing();
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      // Written before the loss: the node may have acted on it before it went (audit FM-1).
      p.reject(new ElectrumError('offline', t('The connection to the Firo node was lost.'), { written: p.written }));
      this._pending.delete(id);
    }
    if (wasReady) this._status();
    if (this.reconnect && !this._closed) {
      // The next try starts from the next server: this one just failed us.
      this._index = (this._index + 1) % this.servers.length;
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._closed) return;
    const jitter = 0.5 + this.random(); // 0.5x – 1.5x
    const delay = Math.min(this.backoffMaxMs, Math.round(this._backoff * jitter));
    this._backoff = Math.min(this.backoffMaxMs, this._backoff * 2);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
    this._reconnectTimer?.unref?.(); // Node: a pending retry alone does not keep the process alive
  }

  _startPing() {
    this._stopPing();
    if (!this.pingIntervalMs) return;
    this._pingTimer = setInterval(() => {
      if (!this._ready) return;
      this.request('server.ping', [], { timeoutMs: Math.min(this.timeoutMs, 15000) }).catch((e) => {
        // A server that does not answer a ping is gone: drop it and fail over.
        if (e.code === 'timeout') this._drop();
      });
    }, this.pingIntervalMs);
    this._pingTimer?.unref?.();
  }

  _stopPing() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  /** Closes the socket; reconnect (if on) moves to the next server. */
  _drop() {
    const ws = this._ws;
    if (!ws) return;
    try {
      ws.close();
    } catch {
      // ignore
    }
    this._onClose(ws);
  }

  /** Disconnect for good: pending requests fail with 'closed', no reconnect. */
  close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._stopPing();
    const ws = this._ws;
    this._ws = null;
    this._ready = false;
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new ElectrumError('closed', t('The connection was closed.'), { written: p.written }));
      this._pending.delete(id);
    }
    this._queue = [];
    this._shSubs.clear();
    this._headerSub = false;
    try {
      ws?.close();
    } catch {
      // ignore
    }
    this._status();
  }

  // ------------------------------------------------------------ messages

  /**
   * Hands a payload to the socket, or (queue: true) keeps it for the next handshake. -> whether it
   * was handed to a socket now. The requests in it are marked written once handed over.
   */
  _send(payload, { queue = true } = {}) {
    if (!this._ready || !this._ws) {
      if (queue) this._queue.push(payload);
      if (!this._closed && !this._connecting && !this._reconnectTimer) this.connect().catch(() => {});
      return false;
    }
    try {
      this._ws.send(JSON.stringify(payload));
    } catch {
      if (queue) this._queue.push(payload);
      this._drop();
      return false;
    }
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      const p = this._pending.get(item.id);
      if (p) p.written = true;
    }
    return true;
  }

  /** Takes request `id` out of the queue (its time ran out, or it may not wait for a connection). */
  _unqueue(id) {
    const out = [];
    for (const payload of this._queue) {
      if (!Array.isArray(payload)) {
        if (payload.id !== id) out.push(payload);
        continue;
      }
      const rest = payload.filter((x) => x.id !== id);
      if (rest.length) out.push(rest);
    }
    this._queue = out;
  }

  _onMessage(ws, data) {
    if (ws !== this._ws) return;
    // One answer is at most a sector of Spark coins (a few MB); anything near this is not a Firo
    // server's answer and would only exhaust the device (audit D-13).
    const size = typeof data === 'string' ? data.length : data?.byteLength ?? 0;
    if (size > MAX_MESSAGE_BYTES) {
      this._emit('error', new ElectrumError('bad_response', t('The server sent an answer far too large to be real.')));
      try {
        ws.close();
      } catch {
        /* closing */
      }
      return;
    }
    let m;
    try {
      m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      this._emit('error', new ElectrumError('bad_response', t('The server sent something that is not JSON.')));
      return;
    }
    for (const item of Array.isArray(m) ? m : [m]) this._onItem(item);
  }

  _onItem(m) {
    if (!m || typeof m !== 'object') return;
    if (m.id === undefined || m.id === null) {
      if (m.method === 'blockchain.headers.subscribe' && Array.isArray(m.params)) this._onHeader(m.params[0]);
      else if (m.method === 'blockchain.scripthash.subscribe' && Array.isArray(m.params)) this._onScripthash(m.params[0], m.params[1]);
      return;
    }
    const p = this._pending.get(m.id);
    if (!p) return;
    this._pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) {
      const e = m.error;
      const msg = typeof e === 'string' ? e : typeof e.message === 'string' ? e.message : t('Server error');
      p.reject(new ElectrumError('server', msg, { rpcCode: typeof e.code === 'number' ? e.code : null }));
    } else if (!('result' in m)) {
      p.reject(new ElectrumError('bad_response', t('An answer without a result.')));
    } else {
      p.resolve(m.result);
    }
  }

  _onHeader(h) {
    if (!h || typeof h.height !== 'number' || typeof h.hex !== 'string') return;
    this.lastHeader = h;
    this._emit('header', h);
  }

  _onScripthash(sh, status) {
    if (typeof sh !== 'string' || !this._shSubs.has(sh)) return;
    this._shSubs.set(sh, status ?? null);
    this._emit('scripthash', sh, status ?? null);
  }

  _register(id, timeoutMs, method) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this._pending.get(id);
        if (!p) return;
        this._pending.delete(id);
        // Still waiting for a connection: it never goes out now (audit FM-1: a broadcast the
        // caller was told had failed left on the next handshake).
        if (!p.written) this._unqueue(id);
        reject(new ElectrumError('timeout', t('The server did not answer {method} in time.', { method }), { written: p.written }));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, written: false });
    });
  }

  // ------------------------------------------------------------ requests

  /**
   * One call → its result; rejects ElectrumError. queue: false = only on the connection there is
   * now; without one it is refused at once ('offline', written: false) instead of waiting.
   */
  request(method, params = [], { timeoutMs = this.timeoutMs, queue = true } = {}) {
    if (this._closed) return Promise.reject(new ElectrumError('closed', t('The connection was closed.')));
    const id = ++this._id;
    const p = this._register(id, timeoutMs, method);
    if (!this._send({ jsonrpc: '2.0', id, method, params }, { queue }) && !queue) {
      const entry = this._pending.get(id);
      if (entry && !entry.written) {
        clearTimeout(entry.timer);
        this._pending.delete(id);
        entry.reject(new ElectrumError('offline', t('Not connected to a Firo node.'), { written: false }));
      }
    }
    return p;
  }

  /**
   * Several calls as JSON-RPC batches of at most maxBatch: [[method, params], …]
   * → results in order, each a value or an ElectrumError (never rejects for
   * one failed call).
   */
  async batch(calls, { timeoutMs = this.timeoutMs } = {}) {
    if (this._closed) throw new ElectrumError('closed', t('The connection was closed.'));
    const out = [];
    for (let i = 0; i < calls.length; i += this.maxBatch) {
      const part = calls.slice(i, i + this.maxBatch);
      // Closed meanwhile (a Lock, another wallet, another node): the rest fail now, unsent. Queued,
      // each part waited out its timeout, so reading a set's blocks held a Lock, and the next sync
      // or Rescan behind it, for many minutes.
      if (this._closed) {
        for (let j = 0; j < part.length; j++) out.push(new ElectrumError('closed', t('The connection was closed.')));
        continue;
      }
      const payload = [];
      const promises = [];
      for (const [method, params = []] of part) {
        const id = ++this._id;
        promises.push(this._register(id, timeoutMs, method).catch((e) => e));
        payload.push({ jsonrpc: '2.0', id, method, params });
      }
      this._send(payload);
      out.push(...(await Promise.all(promises)));
    }
    return out;
  }

  // ------------------------------------------------------------ subscriptions

  /** Subscribes to new blocks; resolves with the tip {height, hex}. Notifications arrive as 'header'. */
  async subscribeHeaders() {
    this._headerSub = true;
    const h = await this.request('blockchain.headers.subscribe', []);
    if (!h || typeof h.height !== 'number' || typeof h.hex !== 'string') throw new ElectrumError('bad_response', t('Bad header.'));
    this._onHeader(h);
    return h;
  }

  /** Subscribes to a script hash; resolves with its status (null = no history). Changes arrive as 'scripthash'. */
  async subscribeScripthash(sh) {
    checkScripthash(sh);
    this._shSubs.set(sh, null);
    const status = await this.request('blockchain.scripthash.subscribe', [sh]);
    if (this._shSubs.has(sh)) this._shSubs.set(sh, status ?? null);
    return status ?? null;
  }

  /** Many subscriptions in batches: {scripthash: status}. */
  async subscribeScripthashes(list) {
    for (const sh of list) {
      checkScripthash(sh);
      this._shSubs.set(sh, null);
    }
    const res = await this.batch(list.map((sh) => ['blockchain.scripthash.subscribe', [sh]]));
    const out = {};
    list.forEach((sh, i) => {
      if (res[i] instanceof Error) throw res[i];
      out[sh] = res[i] ?? null;
      this._shSubs.set(sh, out[sh]);
    });
    return out;
  }

  async unsubscribeScripthash(sh) {
    this._shSubs.delete(sh);
    if (!this._ready) return;
    try {
      await this.request('blockchain.scripthash.unsubscribe', [sh]);
    } catch {
      // the server forgets it with the connection anyway
    }
  }

  get subscribedScripthashes() {
    return [...this._shSubs.keys()];
  }

  // ------------------------------------------------------------ typed calls

  /** [{tx_hash, height}] — height 0 or -1 for the mempool. */
  async getHistory(sh) {
    checkScripthash(sh);
    return checkHistory(await this.request('blockchain.scripthash.get_history', [sh]));
  }

  /** [{tx_hash, tx_pos, height, value}] */
  async listUnspent(sh) {
    checkScripthash(sh);
    const r = await this.request('blockchain.scripthash.listunspent', [sh]);
    if (!Array.isArray(r)) throw new ElectrumError('bad_response', t('listunspent: expected a list.'));
    for (const u of r) {
      if (!u || !HEX64.test(u.tx_hash) || !Number.isInteger(u.tx_pos) || !Number.isInteger(u.height) || !Number.isSafeInteger(u.value) || u.value < 0) {
        throw new ElectrumError('bad_response', t('listunspent: bad entry.'));
      }
    }
    return r;
  }

  /** Raw transaction hex, or the server's verbose JSON (which carries `hex`, height, time and input values). */
  async getTransaction(txid, verbose = false) {
    if (!HEX64.test(txid)) throw new ElectrumError('bad_response', t('Not a txid.'));
    const r = await this.request('blockchain.transaction.get', verbose ? [txid, true] : [txid]);
    if (verbose ? !r || typeof r.hex !== 'string' : typeof r !== 'string') throw new ElectrumError('bad_response', t('transaction.get: bad answer.'));
    return r;
  }

  /**
   * Sends a signed transaction; resolves with the txid the server reports. Never queued for a later
   * connection (audit FM-1): without one it is refused at once, unwritten. An error without an
   * answer carries `written` (the node may have relayed it); an error answer is code 'server'.
   */
  async broadcast(rawHex) {
    const r = await this.request('blockchain.transaction.broadcast', [rawHex], { queue: false });
    // No text at all (null, a number): the node had the bytes and said nothing usable: it may have
    // left (audit of 0.1.8, X3: taken for a refusal, then forgotten). Text that is not a txid is the
    // node's error (older ElectrumX answers errors so). A txid in capitals is still its txid.
    if (typeof r !== 'string') throw new ElectrumError('bad_response', t('The server answered without a transaction id.'));
    if (!/^[0-9a-f]{64}$/i.test(r)) throw new ElectrumError('server', r);
    return r.toLowerCase();
  }

  /** FIRO per kB for confirmation within `blocks`, as BigInt sat/kB; null if the server has no estimate (-1). */
  async estimateFee(blocks = 2) {
    return coinPerKbToSat(await this.request('blockchain.estimatefee', [blocks]));
  }

  /** The server's minimum relay fee, sat/kB. */
  async relayFee() {
    const v = coinPerKbToSat(await this.request('blockchain.relayfee', []));
    if (v === null) throw new ElectrumError('bad_response', t('relayfee: bad answer.'));
    return v;
  }

  /** Block header hex at `height`. */
  async blockHeader(height) {
    const r = await this.request('blockchain.block.header', [height]);
    if (typeof r !== 'string') throw new ElectrumError('bad_response', t('block.header: bad answer.'));
    return r;
  }

  /** blockchain.transaction.get_merkle: the branch proving `txid` is in the block at `height`. -> {merkle: [hex], pos} */
  async getMerkle(txid, height) {
    if (!HEX64.test(String(txid))) throw new ElectrumError('bad_request', t('Not a txid.'));
    const r = checkMerkle(await this.request('blockchain.transaction.get_merkle', [txid, height]));
    if (r instanceof Error) throw r;
    return r;
  }

  /** getMerkle for many [[txid, height]] in batches -> [{merkle, pos} | ElectrumError], each in its place. */
  async getMerkles(list) {
    for (const [item] of list) if (!HEX64.test(String(item))) throw new ElectrumError('bad_request', t('Not a txid.'));
    const res = await this.batch(list.map(([item, h]) => ['blockchain.transaction.get_merkle', [item, h]]));
    return res.map((r) => (r instanceof Error ? r : checkMerkle(r)));
  }

  /** Block headers at `heights` in batches -> [hex | ElectrumError], each in its place. */
  async blockHeaders(heights) {
    const res = await this.batch(heights.map((h) => ['blockchain.block.header', [h]]));
    return res.map((r) => (r instanceof Error || typeof r === 'string' ? r : new ElectrumError('bad_response', t('block.header: bad answer.'))));
  }

  /**
   * blockchain.block.txids: every txid of the blocks at `heights` (display hex), in block order.
   * -> Map height → [txid]. The same question for every wallet: it places a set's coins in their
   * blocks so the set's hash can be recomputed (audit D-09).
   */
  async blockTxids(heights) {
    const res = await this.batch(heights.map((h) => ['blockchain.block.txids', [h]]));
    const out = new Map();
    heights.forEach((h, i) => {
      const r = res[i];
      if (r instanceof Error) throw r;
      if (!Array.isArray(r) || r.length === 0 || r.length > 100000 || !r.every((x) => typeof x === 'string' && HEX64.test(x))) throw new ElectrumError('bad_response', t('block.txids: bad answer.'));
      out.set(h, r);
    });
    return out;
  }

  async txidFromPos(height, pos) {
    const r = await this.request('blockchain.transaction.id_from_pos', [height, pos]);
    if (!HEX64.test(r)) throw new ElectrumError('bad_response', t('id_from_pos: bad answer.'));
    return r;
  }

  // Firo's Spark calls. firod parses every number from a string, so they go as strings.

  async sparkLatestCoinId() {
    const r = await this.request('spark.getsparklatestcoinid', []);
    if (!Number.isInteger(r) || r < 0) throw new ElectrumError('bad_response', t('getsparklatestcoinid: bad answer.'));
    return r;
  }

  /** {blockHash, setHash (base64), size} of a coin group. */
  async sparkSetMeta(groupId) {
    const r = await this.request('spark.getsparkanonymitysetmeta', [String(groupId)]);
    if (!r || typeof r.blockHash !== 'string' || typeof r.setHash !== 'string' || !Number.isInteger(r.size) || r.size < 0) {
      throw new ElectrumError('bad_response', t('getsparkanonymitysetmeta: bad answer.'));
    }
    return r;
  }

  /** Coins [start, end) of a group as of `blockHash` (base64), newest first: [[coin, txHash, context] (base64)]. */
  async sparkSetSector(groupId, blockHash, start, end, { timeoutMs = Math.max(this.timeoutMs, 90000) } = {}) {
    const r = await this.request('spark.getsparkanonymitysetsector', [String(groupId), blockHash, String(start), String(end)], { timeoutMs });
    if (!r || !Array.isArray(r.coins)) throw new ElectrumError('bad_response', t('getsparkanonymitysetsector: bad answer.'));
    for (const c of r.coins) {
      if (!Array.isArray(c) || c.length !== 3 || !c.every((x) => typeof x === 'string')) throw new ElectrumError('bad_response', t('getsparkanonymitysetsector: bad coin.'));
    }
    return r.coins;
  }

  /** Used linking tags after the first `startNumber`: [[tag, txid] (base64)], oldest first. */
  async sparkUsedTags(startNumber, { timeoutMs = Math.max(this.timeoutMs, 120000) } = {}) {
    const r = await this.request('spark.getusedcoinstagstxhashes', [String(startNumber)], { timeoutMs });
    if (!r || !Array.isArray(r.tagsandtxids)) throw new ElectrumError('bad_response', t('getusedcoinstagstxhashes: bad answer.'));
    for (const item of r.tagsandtxids) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') throw new ElectrumError('bad_response', t('getusedcoinstagstxhashes: bad entry.'));
    }
    return r.tagsandtxids;
  }

  /** Spark txids in the mempool (base64, internal byte order). */
  async sparkMempoolTxids() {
    const r = await this.request('spark.getmempoolsparktxids', []);
    if (!Array.isArray(r) || !r.every((x) => typeof x === 'string')) throw new ElectrumError('bad_response', t('getmempoolsparktxids: bad answer.'));
    return r;
  }

  /** Spark data of mempool transactions; `txids` are display hex. */
  async sparkMempoolTxs(txids) {
    for (const item of txids) if (!HEX64.test(item)) throw new ElectrumError('bad_response', t('Not a txid.'));
    const r = await this.request('spark.getmempoolsparktxs', [{ txids }]);
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new ElectrumError('bad_response', t('getmempoolsparktxs: bad answer.'));
    return r;
  }

  /**
   * Every registered Spark name, the same list for every wallet: [{name, address, validUntil,
   * additionalInfo}]. firod lists each name's expiry block and, when it has one, its extra
   * information (none listed = none). A server whose list carries no expiry: both null (unknown).
   */
  async sparkNames() {
    const r = await this.request('spark.getsparknames', []);
    if (!Array.isArray(r)) throw new ElectrumError('bad_response', t('getsparknames: bad answer.'));
    return r
      .filter((e) => e && typeof e.name === 'string' && typeof e.address === 'string')
      .map((e) => {
        const known = Number.isSafeInteger(e.validUntil) && e.validUntil > 0;
        return { name: e.name, address: e.address, validUntil: known ? e.validUntil : null, additionalInfo: typeof e.additionalInfo === 'string' ? e.additionalInfo : known ? '' : null };
      });
  }

  /**
   * One name's record: {address, validUntil (block height), additionalInfo}, or null. This tells
   * the server which name the wallet cares about: for its own names, only when the person asks
   * (audit D-10); for a name about to be paid, on a second server (audit D-02).
   */
  async sparkNameData(name) {
    let r;
    try {
      r = await this.request('spark.getsparknamedata', [name]);
    } catch (e) {
      // An unknown name is an error answer from the server ('server'; 'rpc' kept for older clients).
      if (e && (e.code === 'server' || e.code === 'rpc')) return null;
      throw e;
    }
    if (!r || typeof r.address !== 'string') return null;
    return { address: r.address, validUntil: Number(r.validUntil) || null, additionalInfo: typeof r.additionalInfo === 'string' ? r.additionalInfo : '' };
  }
}

function checkMerkle(r) {
  if (!r || !Array.isArray(r.merkle) || !Number.isSafeInteger(r.pos) || r.pos < 0 || r.merkle.length > 40 || r.merkle.some((x) => !HEX64.test(String(x)))) return new ElectrumError('bad_response', t('get_merkle: bad answer.'));
  return { merkle: r.merkle, pos: r.pos };
}

function checkScripthash(sh) {
  if (typeof sh !== 'string' || !HEX64.test(sh)) throw new ElectrumError('bad_response', t('Not a script hash.'));
}

function checkHistory(r) {
  if (!Array.isArray(r)) throw new ElectrumError('bad_response', t('get_history: expected a list.'));
  for (const h of r) {
    if (!h || !HEX64.test(h.tx_hash) || !Number.isInteger(h.height)) throw new ElectrumError('bad_response', t('get_history: bad entry.'));
  }
  return r;
}

/**
 * ElectrumX gives fees in coins per kB as a JSON float (1.008e-05). Converted
 * through its decimal text, not float arithmetic. -1 (no estimate) → null.
 */
export function coinPerKbToSat(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0) return null;
  const s = v.toFixed(8); // at most 8 decimals are meaningful
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 100000000n + BigInt((f + '00000000').slice(0, 8));
}
