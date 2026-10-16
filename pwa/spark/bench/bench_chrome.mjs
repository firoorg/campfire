// SPDX-License-Identifier: MIT
// Runs bench_page.js in headless Google Chrome: the real client, module workers and
// spark.wasm, served with the app's CSP (no 'unsafe-eval') and cross-origin isolation (so
// performance.measureUserAgentSpecificMemory() is available). Reports CSP violations.
// Needs: installed Google Chrome; playwright-core (default: BEAM Campfire's pwa/node_modules).
// Usage: node pwa/spark/bench/bench_chrome.mjs [--workers 4] [--identify 11] [--spend 10]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const pwa = fileURLToPath(new URL('../../', import.meta.url));
const data = arg('dir', join(process.env.FIRO_DEPS || join(homedir(), 'Desktop', 'Firo', 'deps'), 'spark-bench'));
const playwrightFrom = process.env.PLAYWRIGHT_CORE || join(homedir(), 'Desktop', 'Beam', 'campfire-beam', 'pwa', 'node_modules', 'playwright-core');
const chromePath = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { chromium } = createRequire(import.meta.url)(playwrightFrom);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.bin': 'application/octet-stream' };
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'";

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    let file;
    if (url.pathname.startsWith('/data/')) file = join(data, normalize(url.pathname.slice(6)));
    else if (url.pathname.startsWith('/pwa/')) file = join(pwa, normalize(url.pathname.slice(5)));
    if (!file || (!file.startsWith(pwa) && !file.startsWith(data + sep))) throw new Error('not found');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  const violations = [];
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.exposeFunction('__cspViolation', (v) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolation(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const q = `?workers=${arg('workers', '4')}&identify=${arg('identify', '11')}&spend=${arg('spend', '10')}`;
  await page.goto(`${base}/pwa/spark/bench/bench.html${q}`);
  await page.waitForFunction(() => window.__bench, null, { timeout: 10 * 60 * 1000, polling: 500 });
  const bench = await page.evaluate(() => window.__bench);
  const version = browser.version();
  console.log(JSON.stringify({ chrome: version, ...bench, cspViolations: violations, consoleErrors }, null, 2));
  if (!bench.ok || violations.length) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
