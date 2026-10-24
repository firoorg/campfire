// The first screen loads no Ethereum code (the e2e eth suite checks it in a browser; this finds
// the import that broke it in a second). Walks the static imports from src/app.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function eagerGraph(entry) {
  const from = new Map();
  const walk = (f, parent) => {
    if (from.has(f)) return;
    from.set(f, parent);
    for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gm)) {
      const p = m[1] || m[2];
      if (p.startsWith('.')) walk(resolve(dirname(f), p), f);
    }
  };
  walk(entry, null);
  return from;
}

test('no Ethereum code, no curve library, no Ethereum screen is imported eagerly from app.js', () => {
  const from = eagerGraph(resolve(src, 'app.js'));
  const bad = [...from.keys()].filter((f) => /\/lib\/eth\/(?!record\.js)|\/vendor\/noble\/noble-curves\/|\/screens\/eth_(?!screens)/.test(f));
  const chains = bad.map((f) => {
    const c = [];
    for (let x = f; x; x = from.get(x)) c.unshift(relative(src, x));
    return c.join(' -> ');
  });
  assert.deepEqual(chains, []);
});
