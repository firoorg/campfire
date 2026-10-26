// A stand-in for GitHub Pages (https://vsnation.github.io/campfire-firo-pwa/):
// static files only, under a sub-path, with NO security headers (no COOP/COEP,
// no CSP), Cache-Control: max-age=600 like Pages, and Pages' 404 HTML page for
// everything else. The app must make itself cross-origin isolated through its
// service worker.
//
// fakeBackend (default true): <base>__dev/flags answers {fakeBackend: true}, so a build whose
// engine is the real one (lib/chain.js) runs the stand-in here and the suites need no network.
// devHooks: also POST <base>__dev/result, for an in-page self-test (Safari on the iOS Simulator
// cannot be driven otherwise).
import http from 'node:http';
import { readFile, stat, appendFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { mimeFor } from '../../tools/headers.mjs';

const PAGES_404 = '<!DOCTYPE html><html><head><title>Page not found · GitHub Pages</title></head><body><h1>404</h1><p><strong>File not found</strong></p></body></html>';

export function startStaticHost({ root, port, base = '/campfire-firo-pwa/', devHooks = false, fakeBackend = true, resultFile = null }) {
  const opts = { delayMs: 0 }; // a slower line, to watch the first run
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    requests.push({ method: req.method, path, sw: String(req.headers['service-worker'] || ''), dest: String(req.headers['sec-fetch-dest'] || '') });
    const notFound = () => {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : PAGES_404);
    };
    if (path === base.slice(0, -1)) {
      res.writeHead(301, { Location: base });
      return res.end();
    }
    if (!path.startsWith(base)) return notFound();
    const rel = decodeURIComponent(path.slice(base.length));
    if ((devHooks || fakeBackend) && rel === '__dev/flags') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ selftest: Boolean(devHooks), fakeBackend: Boolean(fakeBackend) }));
    }
    if (devHooks && rel === '__dev/result' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const line = Buffer.concat(chunks).toString('utf8');
      if (resultFile) await appendFile(resultFile, `${line}\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const full = normalize(join(root, rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel));
    if (!full.startsWith(root + sep)) return notFound();
    try {
      const st = await stat(full);
      if (!st.isFile()) return notFound();
      res.writeHead(200, { 'Content-Type': mimeFor(full), 'Content-Length': st.size, 'Cache-Control': 'max-age=600' });
      if (req.method === 'HEAD') return res.end();
      res.end(await readFile(full));
    } catch {
      notFound();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://localhost:${port}${base}`,
        requests,
        setDelay: (ms) => (opts.delayMs = ms),
        stop: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      }),
    );
  });
}
