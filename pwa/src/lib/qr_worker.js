// Reads QR codes from camera frames, off the page's thread. A classic worker,
// so jsQR (vendored as published, src/vendor/jsqr/) loads as it was written.
// It gets pixels and answers with text; it reaches nothing (the page's CSP
// applies to it: scripts from this origin only, no network but the origin).
/* global importScripts, jsQR */
importScripts('../vendor/jsqr/jsQR.js');

self.onmessage = (e) => {
  const m = e.data || {};
  let text = null;
  try {
    if (m.data && m.width > 0 && m.height > 0) {
      const r = jsQR(new Uint8ClampedArray(m.data), m.width, m.height, { inversionAttempts: m.thorough ? 'attemptBoth' : 'dontInvert' });
      text = r && typeof r.data === 'string' ? r.data : null;
    }
  } catch {
    text = null;
  }
  self.postMessage({ id: m.id, text });
};
