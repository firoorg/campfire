// The Spark spend key does not outlive Lock as a string in memory (audit A-2 / B-4): the adapter's
// view-key cache is keyed by a SHA-256 fingerprint, not by the key's hex. A V8 heap snapshot after
// the key bytes are wiped and garbage collected is searched for the key's hex (ropes included);
// the "sanity" run holds a copy on purpose, so the probe is shown to find one when it is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('../support/heap_key_probe.mjs', import.meta.url));
function copies(mode) {
  const out = mkdtempSync(join(tmpdir(), 'campfire-heap-'));
  try {
    const text = execFileSync(process.execPath, ['--expose-gc', probe, mode], { env: { ...process.env, OUT: out }, encoding: 'utf8' });
    const m = /present as (\d+) flat string\(s\) and (\d+) rope\(s\)/.exec(text);
    assert.ok(m, text);
    return Number(m[1]) + Number(m[2]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('after Lock wipes it, the spend key is nowhere in the heap', { timeout: 120000 }, () => {
  assert.equal(copies('test'), 0);
});

test('the probe finds a copy that is still held (so a 0 above means something)', { timeout: 120000 }, () => {
  assert.ok(copies('sanity') >= 1);
});
