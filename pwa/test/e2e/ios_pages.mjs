// GitHub Pages, emulated, in Safari on the iOS Simulator: a static host under
// /campfire-firo-pwa/ with no security headers (static_host.mjs; its __dev/flags
// selects the stand-in engine, lib/chain.js).
//
//   node test/e2e/ios_pages.mjs        (SIM_UDID=<udid>; default: iPhone 17)
//
// 1. Clears Safari's website data on the Simulator (a phone that never saw the app).
// 2. First open as a timeline (ios_firstrun.mjs --no-erase): setup screen -> Welcome,
//    with a contact sheet of the screenshots.
// 3. A screenshot of the installed copy after a reload (served by the verified copy).
// BEAM Campfire's in-page self-test is gone with its engine; driving the wallet in Safari is a
// TODO (the Simulator cannot be scripted like Chrome).
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PWA, sleep, SHOTS } from './harness.mjs';
import { startStaticHost } from './static_host.mjs';

const PORT = 8798;
const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(PWA, 'package.json'), 'utf8'));
const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const devices = Object.values(JSON.parse(simctl('list', 'devices', 'available', '--json')).devices).flat();
const udid = process.env.SIM_UDID || (devices.find((d) => d.name === 'iPhone 17') || devices.find((d) => /iPhone/.test(d.name))).udid;

function clearSafari() {
  spawnSync('xcrun', ['simctl', 'boot', udid], { stdio: 'ignore' });
  spawnSync('xcrun', ['simctl', 'bootstatus', udid, '-b'], { stdio: 'ignore' });
  spawnSync('xcrun', ['simctl', 'terminate', udid, 'com.apple.mobilesafari'], { stdio: 'ignore' });
  const data = simctl('get_app_container', udid, 'com.apple.mobilesafari', 'data').trim();
  for (const d of ['Library/WebKit/com.apple.mobilesafari/WebsiteData', 'Library/Caches/com.apple.mobilesafari', 'Library/Caches/WebKit']) rmSync(join(data, d), { recursive: true, force: true });
}

const tmp = mkdtempSync(join(tmpdir(), 'campfire-ios-pages-'));
let host = null;
try {
  const rel = join(tmp, 'rel');
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', rel, '--version', pkg.version, '--quiet', '--engine', 'fake'], { cwd: PWA });
  host = await startStaticHost({ root: rel, port: PORT });
  console.log(`# Pages emulation ${host.url} (no security headers), release ${pkg.version}`);
  clearSafari();
  const out = join(SHOTS, 'ios-pages-firstrun');
  // Not spawnSync: the static host lives in this process and must keep answering meanwhile.
  const stdout = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [join(here, 'ios_firstrun.mjs'), host.url, '--udid', udid, '--no-erase', '--out', out, '--times', '1,2,3,4,5,6,8,10,12,15,20,25,30'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    c.stdout.on('data', (d) => (buf += d));
    c.on('error', reject);
    c.on('exit', () => resolve(buf));
  });
  process.stdout.write(stdout.split('\n').filter((l) => l.startsWith('#')).join('\n') + '\n');
  const firstRun = host.requests.filter((q) => q.path.includes('/sw-')).length;
  console.log(`# first open: ${host.requests.length} requests to the static host (loader fetches ${firstRun})`);

  simctl('openurl', udid, host.url);
  await sleep(8000);
  spawnSync('xcrun', ['simctl', 'io', udid, 'screenshot', join(SHOTS, 'ios-pages-reopened.png')], { stdio: 'ignore' });
  const after = host.requests.length;
  console.log(`# reopened: screenshot ${join(SHOTS, 'ios-pages-reopened.png')}; ${after} requests to the static host in all`);
} catch (e) {
  console.error(`ios pages run: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (host) await host.stop();
  rmSync(tmp, { recursive: true, force: true });
}
