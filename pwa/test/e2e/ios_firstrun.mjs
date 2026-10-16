// The first open on an iPhone, as a timeline: erase a Simulator (a clean
// Safari, like a phone that never saw the app), boot it, open the URL in
// Safari, and take screenshots at fixed times after the open. Writes the
// frames and a contact sheet; prints the paths.
//
//   node test/e2e/ios_firstrun.mjs <url> [--udid <udid>] [--out <dir>] [--times 2,4,6,...] [--no-erase] [--log <dev-server log>]
//
// --log: the dev server's --verbose output; requests to the app during the run
// are summarised (first and last file, count), which times the install itself.
// Erases the chosen Simulator: never point it at a device with anything you need.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { CHROME, sleep } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? def : args[i + 1];
};
const url = args.find((a) => /^https?:\/\//.test(a));
if (!url) throw new Error('usage: ios_firstrun.mjs <url> [--udid U] [--out DIR] [--times 2,4,...]');
const times = String(opt('times', '2,4,6,9,12,16,20,25,30,40,50,60')).split(',').map(Number);
const out = opt('out', join(tmpdir(), `campfire-firstrun-${Date.now()}`));
const logFile = opt('log', null);
const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });

const devices = JSON.parse(simctl('list', 'devices', 'available', '--json')).devices;
const phones = Object.entries(devices).flatMap(([rt, ds]) => ds.filter((d) => /iPhone/.test(d.name)).map((d) => ({ ...d, rt })));
const dev = phones.find((d) => d.udid === opt('udid', '')) || phones.find((d) => d.name === 'iPhone 17') || phones[0];
mkdirSync(out, { recursive: true });
console.log(`# device ${dev.name} (${dev.rt.split('.').pop()}) ${dev.udid}`);

if (!args.includes('--no-erase')) {
  spawnSync('xcrun', ['simctl', 'shutdown', dev.udid], { stdio: 'ignore' });
  simctl('erase', dev.udid);
}
spawnSync('xcrun', ['simctl', 'boot', dev.udid], { stdio: 'ignore' });
spawnSync('xcrun', ['simctl', 'bootstatus', dev.udid, '-b'], { stdio: 'ignore' });
await sleep(3000); // let SpringBoard settle so Safari's launch is not counted as the app's time

const logStart = logFile && existsSync(logFile) ? readFileSync(logFile, 'utf8').length : 0;
const t0 = Date.now();
const t0utc = new Date(t0).toISOString().slice(11, 19);
simctl('openurl', dev.udid, url);
const frames = [];
for (const t of times) {
  const wait = t0 + t * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  const f = join(out, `t${String(t).padStart(3, '0')}.png`);
  spawnSync('xcrun', ['simctl', 'io', dev.udid, 'screenshot', f], { stdio: 'ignore' });
  frames.push({ t, f });
}

let summary = null;
if (logFile && existsSync(logFile)) {
  const lines = readFileSync(logFile, 'utf8').slice(logStart).split('\n').filter((l) => /^\d\d:\d\d:\d\d (GET|HEAD) \//.test(l) && /iPhone/.test(l));
  const sec = (l) => {
    const [h, m, s] = l.slice(0, 8).split(':').map(Number);
    return h * 3600 + m * 60 + s;
  };
  if (lines.length) {
    const first = sec(lines[0]);
    const [h0, m0, s0] = t0utc.split(':').map(Number);
    summary = {
      openedAtUtc: t0utc,
      firstRequestAfterOpenSec: first - (h0 * 3600 + m0 * 60 + s0),
      requests: lines.length,
      firstRequest: lines[0].slice(0, 8),
      lastRequest: lines[lines.length - 1].slice(0, 8),
      spanSec: sec(lines[lines.length - 1]) - first,
      reloadsOfIndex: lines.filter((l) => / GET \/ /.test(l)).length,
    };
  }
}

// Contact sheet: the frames in a grid, labelled with their time.
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px -apple-system,Helvetica,sans-serif;background:#fff}
.g{display:grid;grid-template-columns:repeat(${Math.min(7, frames.length)},200px)}.c{position:relative}.c img{width:200px;display:block}
.c b{position:absolute;left:4px;top:2px;background:#fff;padding:0 3px}</style><div class="g">${frames.map((x) => `<div class="c"><img src="file://${x.f}"><b>${x.t} s</b></div>`).join('')}</div>`;
const page = join(out, 'sheet.html');
writeFileSync(page, html);
const b = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--allow-file-access-from-files'] });
const p = await b.newPage({ viewport: { width: 200 * Math.min(7, frames.length), height: 600 } });
await p.goto(`file://${page}`);
await p.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
await p.screenshot({ path: join(out, 'sheet.png'), fullPage: true });
await b.close();
console.log(`# frames and sheet: ${out}/sheet.png`);
if (summary) console.log(`# dev server saw (iPhone UA): ${JSON.stringify(summary)}`);
