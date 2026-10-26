// Campfire dev server. Node only, no dependencies.
//
//   node tools/serve.mjs [--port 8780] [--root dist|dist-fake|src|<dir>] [--fake-backend]
//                        [--selftest] [--result-file <path>] [--quiet] [--verbose]
//
// - Serves --root (default dist/) with the production headers (tools/headers.mjs
//   headersFor(): the page policy, the loader's own, CORS on the app's files).
//   The root may be a symlink; it is resolved on every request, so tests can
//   switch releases by re-pointing it.
// - Listens on loopback only and refuses Host headers that are not loopback
//   (DNS rebinding).
// - --fake-backend: /__dev/flags answers {fakeBackend: true}, which lib/chain.js
//   reads on localhost to run the stand-in engine (lib/backend_fake.js) even in a
//   build whose engine is the real one: the browser suites run without the network.
// - --selftest enables /__dev/flags and POST /__dev/result (an in-page test
//   reports back there; printed as SELFTEST_RESULT, appended to --result-file).
// Without either flag /__dev/* answers 404, which is what any production host does.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath, writeFile } from 'node:fs/promises';
import { join, normalize, sep, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS, headersFor, mimeFor } from './headers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pwaRoot = join(here, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const port = Number(arg('port', process.env.PORT || 8780));
const rootArg = arg('root', 'dist');
const rootDir = rootArg === 'dist' || rootArg === 'dist-fake' || rootArg === 'src' ? join(pwaRoot, rootArg) : resolve(String(rootArg));
const selftest = Boolean(arg('selftest', false));
const fakeBackend = Boolean(arg('fake-backend', false));
const resultFile = arg('result-file', null);
const quiet = Boolean(arg('quiet', false));
const verbose = Boolean(arg('verbose', false));

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function log(...a) {
  if (!quiet) console.log(new Date().toISOString().slice(11, 19), ...a);
}

function baseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, 'Cache-Control': 'no-cache', ...extra };
}

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = Buffer.from(body);
  res.writeHead(code, baseHeaders({ 'Content-Type': type, 'Content-Length': buf.length, ...extra }));
  res.end(buf);
}

async function serveFile(req, res, pathname) {
  let root;
  try {
    root = await realpath(rootDir);
  } catch {
    return send(res, 500, `root ${rootArg} does not exist (run npm run build)`);
  }
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = normalize(join(root, rel));
  if (!full.startsWith(root + sep)) return send(res, 403, 'forbidden');
  let st;
  try {
    st = await stat(full);
  } catch {
    return send(res, 404, 'not found');
  }
  if (!st.isFile()) return send(res, 404, 'not found');
  res.writeHead(200, { ...headersFor(pathname), 'Cache-Control': 'no-cache', 'Content-Type': mimeFor(full), 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).pipe(res);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = (host) =>
  http.createServer(async (req, res) => {
    try {
      const hostHeader = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.has(hostHeader)) return send(res, 421, 'loopback only');
      const url = new URL(req.url, `http://localhost:${port}`);
      const p = url.pathname;
      if (verbose) res.on('finish', () => log(req.method, p, res.statusCode, String(req.headers['user-agent'] || '').slice(0, 40)));
      if (p === '/__dev/flags') {
        if ((!selftest && !fakeBackend) || req.method !== 'GET') return send(res, 404, 'not found');
        return send(res, 200, JSON.stringify({ selftest, fakeBackend }), 'application/json', { 'Cache-Control': 'no-store' });
      }
      if (p === '/__dev/result') {
        if (!selftest || req.method !== 'POST') return send(res, 404, 'not found');
        const body = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(res, 400, 'bad json');
        }
        const line = JSON.stringify(parsed);
        console.log(`SELFTEST_RESULT ${line}`);
        if (resultFile) await writeFile(String(resultFile), line + '\n', { flag: 'a' });
        return send(res, 200, '{"ok":true}', 'application/json');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
      return serveFile(req, res, p);
    } catch (e) {
      log('error', e.message);
      if (!res.headersSent) send(res, 500, 'server error');
      else res.destroy();
    }
  }).listen(port, host, () => log(`Campfire dev server: http://localhost:${port}/ (root ${rootDir}, ${host}${selftest ? ', selftest on' : ''}${fakeBackend ? ', fake backend' : ''})`));

server('127.0.0.1');
server('::1').on('error', () => {}); // no IPv6 loopback: fine
