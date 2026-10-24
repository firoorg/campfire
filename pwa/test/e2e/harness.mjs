// Shared e2e plumbing: the dev server (with the stand-in Firo engine unless told otherwise), the
// installed Google Chrome (no browser downloads), request/console recording, the virtual
// authenticator.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { FIRO_SERVER_HOSTS, FIRO_WSS_PORT } from '../../src/lib/servers.js';

const here = dirname(fileURLToPath(import.meta.url));
export const PWA = join(here, '..', '..');
export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const SHOTS = process.env.CAMPFIRE_SHOTS || join(tmpdir(), 'campfire-firo-shots');
// Firo's ElectrumX servers (host:port): the only WebSockets a wallet may open (the stand-in opens none).
export const NODE_HOSTS = FIRO_SERVER_HOSTS.map((h) => `${h}:${FIRO_WSS_PORT}`);

/** The dev server; fakeBackend (default): localhost builds get the stand-in engine (lib/chain.js). */
export async function startServer({ root = 'dist', port = 8781, selftest = false, fakeBackend = true, extra = [] } = {}) {
  const args = [join(PWA, 'tools', 'serve.mjs'), '--port', String(port), '--root', root, ...(selftest ? ['--selftest'] : []), ...(fakeBackend ? ['--fake-backend'] : []), ...extra];
  const proc = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  proc.stdout.on('data', (d) => out.push(String(d)));
  proc.stderr.on('data', (d) => out.push(String(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('dev server did not start')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('dev server')) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.on('exit', (c) => reject(new Error(`dev server exited ${c}: ${out.join('')}`)));
  });
  return { proc, url: `http://localhost:${port}/`, output: out, stop: () => proc.kill() };
}

export async function launch() {
  return chromium.launch({ executablePath: CHROME, headless: process.env.HEADED ? false : true, args: ['--disable-features=AutofillServerCommunication'] });
}

/**
 * A page that records: console messages, page errors, CSP violations, every
 * request host and every WebSocket URL.
 */
export async function recordedPage(context, { label = 'page', echo = false } = {}) {
  const page = await context.newPage();
  const rec = { console: [], errors: [], csp: [], requests: [], websockets: [], label };
  page.on('console', (m) => {
    const t = m.text();
    rec.console.push({ type: m.type(), text: t });
    if (/Content Security Policy/i.test(t)) rec.csp.push(t);
    if (echo) console.log(`[${label}:${m.type()}] ${t.slice(0, 300)}`);
  });
  page.on('pageerror', (e) => rec.errors.push(String(e && e.message)));
  // Requests from the page, its workers and the service worker all reach the context.
  if (!context.__campfireRecorders) {
    context.__campfireRecorders = [];
    context.on('request', (r) => context.__campfireRecorders.forEach((x) => x.requests.push(r.url())));
  }
  context.__campfireRecorders.push(rec);
  page.on('websocket', (ws) => rec.websockets.push(ws.url()));
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { page, rec };
}

/** Hosts other than the app origin and Firo's servers that the page contacted. */
export function foreignHosts(rec, origin, allowedNodes = NODE_HOSTS) {
  const o = new URL(origin);
  const bad = new Set();
  for (const u of [...rec.requests, ...rec.websockets]) {
    let url;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') continue;
    if (url.host === o.host && (url.protocol === 'http:' || url.protocol === 'https:')) continue;
    if (url.protocol === 'wss:' && allowedNodes.includes(url.host)) continue;
    bad.add(`${url.protocol}//${url.host}`);
  }
  return [...bad];
}

export async function addVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

export async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const p = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitScreen(page, name, timeout = 30000) {
  await page.waitForFunction((n) => document.getElementById('app')?.dataset.screen === n, name, { timeout });
}

export async function readSync(page) {
  return page.evaluate(() => window.__campfire && window.__campfire.sync());
}

/** The stand-in engine's test controls (lib/backend_fake.js), in the page. */
export const fake = {
  credit: (page, o) => page.evaluate((x) => globalThis.__firoFake && globalThis.__firoFake.credit(x), o),
  mine: (page) => page.evaluate(() => globalThis.__firoFake && globalThis.__firoFake.mine()),
  offline: (page, on = true) => page.evaluate((v) => globalThis.__firoFake && globalThis.__firoFake.offline(v), on),
  speed: (page, ms) => page.evaluate((v) => globalThis.__firoFake && globalThis.__firoFake.speed(v), ms),
};
