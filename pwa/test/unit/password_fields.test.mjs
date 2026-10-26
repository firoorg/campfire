// The wallet password is never offered to the browser's password manager (audit A-4). A password
// saved there sits in the same browser profile as the wallet it opens: whoever copies the profile
// (an infostealer, a backup) reads both. autocomplete="current-password" / "new-password" are the
// invitation to save it; every password field says "off" instead, as the backup file's always did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function sources() {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'vendor') walk(join(d, e.name));
      } else if (e.name.endsWith('.js')) files.push(join(d, e.name));
    }
  };
  walk(src);
  return files;
}

test('no field asks the browser to save or fill a password (current-password / new-password)', () => {
  const bad = [];
  for (const f of sources()) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/['"](current|new)-password['"]/.test(line)) bad.push(`${f.slice(src.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("every password field says autocomplete off (a browser may still offer to save: the screens say why to say no)", () => {
  const bad = [];
  for (const f of sources()) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/type:\s*'password'/.test(line) && !/autocomplete:\s*'off'/.test(line)) bad.push(`${f.slice(src.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});
