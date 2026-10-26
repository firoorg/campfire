import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(process.argv[2] + '/');
const { chromium } = require('playwright-core');
const base = 'http://localhost:8899';
const modes = ['down', '404', 'parking', 'hostile', 'csd-storage', 'csd-404'];
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (const m of modes) {
  await fetch(base + '/__mode?m=normal');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swlab-'));
  const ctx = await chromium.launchPersistentContext(dir, { executablePath: chrome, headless: true });
  const p = await ctx.newPage();
  await p.goto(base + '/?step=install'); await sleep(3000);
  await fetch(base + '/__mode?m=' + m);
  await p.goto(base + '/?step=update').catch(e => console.log('nav err', e.message.slice(0, 80))); await sleep(4000);
  const p2 = await ctx.newPage();
  await p2.goto(base + '/?step=reopen').catch(e => console.log('nav err', e.message.slice(0, 80))); await sleep(3000);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('done', m);
}
