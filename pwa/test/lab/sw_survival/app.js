const step = new URLSearchParams(location.search).get('step') || 'check';
const out = (o) => { document.getElementById('s').textContent = JSON.stringify(o); navigator.sendBeacon('/__report', JSON.stringify(Object.assign({ step, ua: /iPhone/.test(navigator.userAgent) ? 'iOS' : 'chrome' }, o))); };
const idb = () => new Promise((res) => { const r = indexedDB.open('lab', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
const get = async () => { const db = await idb(); if (!db) return 'no-db'; return new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('wallet'); q.onsuccess = () => r(q.result ?? null); q.onerror = () => r('err'); }); };
const put = async (v) => { const db = await idb(); return new Promise(r => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, 'wallet'); t.oncomplete = () => r(); }); };
const state = async () => { const reg = await navigator.serviceWorker.getRegistration(); return { controlled: !!navigator.serviceWorker.controller, reg: !!reg, active: reg && reg.active ? reg.active.state : null, waiting: !!(reg && reg.waiting), caches: await caches.keys(), wallet: await get() }; };
(async () => {
  if (step === 'install') {
    await put('wallet-secret-123');
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    await new Promise(r => setTimeout(r, 1500));
    out(Object.assign({ phase: 'installed' }, await state()));
  } else if (step === 'update') {
    const reg = await navigator.serviceWorker.getRegistration();
    let upd = 'no-reg';
    if (reg) { try { await reg.update(); upd = 'resolved'; } catch (e) { upd = 'threw: ' + e.name; } }
    await new Promise(r => setTimeout(r, 2500));
    out(Object.assign({ phase: 'after-update', upd }, await state()));
  } else {
    out(Object.assign({ phase: 'reopen' }, await state()));
  }
})();
