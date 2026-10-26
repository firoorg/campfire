// A fake WebSocket and ElectrumX for the Firo tests: each URL maps to a
// server whose handler answers JSON-RPC calls; tests can refuse connections,
// drop them, push notifications and look at what the client sent.

export class FakeNet {
  constructor() {
    this.servers = new Map(); // url → FakeServer
    this.sockets = [];
    const net = this;
    this.WebSocket = class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        net.sockets.push(this);
        const server = net.servers.get(url);
        queueMicrotask(() => {
          if (!server || server.refuse) {
            this.readyState = 3;
            this.onerror?.({});
            this.onclose?.({});
            return;
          }
          if (server.silent) return; // never opens
          const open = () => {
            this.server = server;
            server.sockets.add(this);
            this.readyState = 1;
            this.onopen?.({});
          };
          // A slow link: the open (TLS, then the handshake) takes openDelayMs; one closed meanwhile never opens.
          if (server.openDelayMs > 0) setTimeout(() => this.readyState === 0 && open(), server.openDelayMs);
          else open();
        });
      }

      send(text) {
        if (this.readyState !== 1) throw new Error('not open');
        this.sent.push(text);
        this.server.receive(this, text);
      }

      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.server?.sockets.delete(this);
        queueMicrotask(() => this.onclose?.({}));
      }

      /** Server side: deliver a message to the client. */
      deliver(obj) {
        if (this.readyState !== 1) return;
        const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
        queueMicrotask(() => this.onmessage?.({ data: text }));
      }
    };
  }

  /** handler(method, params, socket) → result | throws {code, message} | returns FakeNet.NO_ANSWER */
  addServer(url, handler, opts = {}) {
    const s = new FakeServer(url, handler, opts);
    this.servers.set(url, s);
    return s;
  }
}

FakeNet.NO_ANSWER = Symbol('no answer');
/** An answer with neither a result nor an error (a broken or lying node). */
FakeNet.NO_RESULT = Symbol('no result');

export class FakeServer {
  constructor(url, handler, { refuse = false, silent = false, openDelayMs = 0, requireVersionFirst = true } = {}) {
    this.url = url;
    this.handler = handler;
    this.refuse = refuse;
    this.silent = silent;
    this.openDelayMs = openDelayMs; // ms before a new connection opens (a slow link); may change at any time
    this.requireVersionFirst = requireVersionFirst;
    this.sockets = new Set();
    this.calls = []; // {method, params, batch}
    this.messages = 0;
  }

  receive(socket, text) {
    this.messages++;
    const body = JSON.parse(text);
    const answer = (req) => {
      this.calls.push({ method: req.method, params: req.params, batch: Array.isArray(body) });
      if (this.requireVersionFirst && !socket.versioned && req.method !== 'server.version') {
        return { jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'server.version must be first' } };
      }
      if (req.method === 'server.version') socket.versioned = true;
      try {
        const r = this.handler(req.method, req.params, socket);
        if (r === FakeNet.NO_ANSWER) return null;
        if (r === FakeNet.NO_RESULT) return { jsonrpc: '2.0', id: req.id };
        return { jsonrpc: '2.0', id: req.id, result: r === undefined ? null : r };
      } catch (e) {
        return { jsonrpc: '2.0', id: req.id, error: { code: e.code ?? -32000, message: e.message } };
      }
    };
    if (Array.isArray(body)) {
      const out = body.map(answer).filter(Boolean);
      if (out.length) socket.deliver(out);
    } else {
      const out = answer(body);
      if (out) socket.deliver(out);
    }
  }

  /** Push a notification to every connected client. */
  notify(method, params) {
    for (const s of this.sockets) s.deliver({ jsonrpc: '2.0', method, params });
  }

  /** Drop every connection (the server went away). */
  dropAll() {
    for (const s of [...this.sockets]) s.close();
  }

  methods() {
    return this.calls.map((c) => c.method);
  }
}

/** A default Electrum handler: version, ping, headers; extra methods from `table`. */
export function electrumHandler(table = {}, { height = 1000, hex = '00'.repeat(120) } = {}) {
  return (method, params, socket) => {
    if (method === 'server.version') return ['ElectrumX 1.19.0', '1.4'];
    if (method === 'server.ping') return null;
    if (method === 'blockchain.headers.subscribe') return { height, hex };
    const f = table[method];
    if (typeof f === 'function') return f(params, socket);
    if (f !== undefined) return f;
    throw Object.assign(new Error(`unknown method ${method}`), { code: -32601 });
  };
}
