// SPDX-License-Identifier: MIT
// A minimal ElectrumX JSON-RPC client over WebSocket, for the Spark benchmarks only
// (the wallet's real client belongs to the core stream). Works with Node >= 22's global
// WebSocket and in browsers. ElectrumX >= 1.19 wants server.version first.

export class ElectrumWs {
  static async connect(url, { client = 'campfire-pwa-spark-bench', protocol = '1.4', timeoutMs = 20000 } = {}) {
    const e = new ElectrumWs(url, timeoutMs);
    await e.opened;
    e.version = await e.request('server.version', [client, protocol]);
    return e;
  }

  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.bytesIn = 0;
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (ev) => reject(new Error(`WebSocket ${url}: ${ev?.message || 'error'}`));
    });
    this.ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      this.bytesIn += text.length;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    };
    this.ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
    };
  }

  request(method, params = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

export function b64(s) {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
