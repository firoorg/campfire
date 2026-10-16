// Every module of the app parses, and every name it imports from another of the app's modules is
// exported there. The browser suites find either mistake only on the screen that loads the module;
// this finds it in a second, for every module (a quote inside a string, an export cut by an edit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function modules(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'vendor') out.push(...modules(p));
    } else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = modules(src);

test('every module parses', () => {
  // One process: each file compiled as an ES module (parsed, not run).
  const script = `
    const vm = require('node:vm'); const fs = require('node:fs');
    const bad = [];
    for (const f of JSON.parse(process.argv[1])) {
      const code = fs.readFileSync(f, 'utf8');
      try { new vm.SourceTextModule(code, { identifier: f }); }
      catch (e) {
        // A classic script (theme-boot.js, loader-watch.js): parsed as a script instead.
        try { new vm.Script(code, { filename: f }); } catch { bad.push(f + ': ' + e.message); }
      }
    }
    process.stdout.write(JSON.stringify(bad));`;
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', script, JSON.stringify(files)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => relative(src, x)), []);
});

/** The names a module exports: export function/class/const/let/var, export { a, b as c }, export default. */
function exportsOf(code) {
  const names = new Set();
  for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of code.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) {
    const n = part.trim().split(/\s+as\s+/).pop().trim();
    if (n) names.add(n);
  }
  if (/^export\s+default\b/m.test(code)) names.add('default');
  return names;
}

test("every named import from the app's own modules is exported there", () => {
  const missing = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    for (const m of code.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/gm)) {
      const target = resolve(dirname(f), m[2]);
      let have;
      try {
        have = exportsOf(readFileSync(target, 'utf8'));
      } catch {
        missing.push(`${relative(src, f)}: ${m[2]} does not exist`);
        continue;
      }
      if (target.includes(`${join('src', 'vendor')}`)) continue;
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/)[0].trim();
        if (n && !have.has(n)) missing.push(`${relative(src, f)}: '${n}' is not exported by ${relative(src, target)}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
