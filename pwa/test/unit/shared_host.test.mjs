// The app never runs from a host many people's pages share (public audit, H9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedHost } from '../../src/lib/shared_host.js';

test("GitHub Pages, raw GitHub and jsDelivr are shared hosts; the app's own addresses are not", () => {
  for (const h of ['vsnation.github.io', 'someone.github.io', 'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'fastly.jsdelivr.net']) assert.equal(sharedHost(h), true, h);
  for (const h of ['pwa.buyfiro.app', 'localhost', '127.0.0.1', 'github.io.example.com', '']) assert.equal(sharedHost(h), false, h);
});
