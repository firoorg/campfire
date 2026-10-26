// The vendored noble/scure code is exactly what tools/vendor_noble.mjs wrote
// from the pinned tarballs, closed under its own imports, and makes no
// requests of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { PACKAGES, OUT_DIR, splitJs, findImports, forbiddenUses } from '../../tools/vendor_noble.mjs';

const vendor = JSON.parse(readFileSync(join(OUT_DIR, 'VENDOR.json'), 'utf8'));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

test('VENDOR.json pins the same five packages, versions and integrities as the tool', () => {
  assert.deepEqual(
    vendor.packages.map((p) => [p.package, p.version, p.integrity, p.dir, p.license]),
    PACKAGES.map((p) => [p.name, p.version, p.integrity, p.dir, 'MIT']),
  );
});

test('every vendored file matches its recorded SHA-256, and nothing else is there', () => {
  const listed = new Set(['VENDOR.json']);
  for (const p of vendor.packages) {
    for (const f of p.files) {
      const rel = `${p.dir}/${f.path}`;
      listed.add(rel);
      const b = readFileSync(join(OUT_DIR, ...rel.split('/')));
      assert.equal(sha256(b), f.sha256, rel);
      assert.equal(b.length, f.size, rel);
      // A file is changed only where an import was rewritten.
      if (!f.rewrites) assert.equal(f.sha256, f.upstream_sha256, rel);
    }
    assert.ok(p.files.some((f) => f.path === 'LICENSE'), `${p.package} LICENSE`);
  }
  const present = walk(OUT_DIR).map((f) => relative(OUT_DIR, f).split(sep).join('/'));
  assert.deepEqual(present.sort(), [...listed].sort());
});

test('the import graph is closed: every import is relative and lands on a vendored file', () => {
  const files = new Set(vendor.packages.flatMap((p) => p.files.map((f) => `${p.dir}/${f.path}`)));
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const { code } = splitJs(readFileSync(join(OUT_DIR, ...rel.split('/')), 'utf8'));
    for (const imp of findImports(code)) {
      assert.match(imp.spec, /^\.\.?\//, `${rel} imports ${imp.spec}`);
      const target = posix.normalize(posix.join(posix.dirname(rel), imp.spec));
      assert.ok(files.has(target), `${rel} imports ${imp.spec}, which is not vendored`);
    }
  }
});

test('no vendored file makes a request, evaluates code or loads code at run time', () => {
  for (const f of walk(OUT_DIR).filter((f) => f.endsWith('.js'))) assert.deepEqual(forbiddenUses(readFileSync(f, 'utf8')), [], f);
});

test('only the English BIP39 wordlist is shipped', () => {
  const lists = readdirSync(join(OUT_DIR, 'scure-bip39', 'wordlists'));
  assert.deepEqual(lists, ['english.js']);
});

test('the scanner: finds what it must and ignores comments, strings and methods named eval', () => {
  assert.deepEqual(forbiddenUses('const r = await fetch(url);'), ['fetch', 'raw:fetch(']);
  assert.deepEqual(forbiddenUses('const f = globalThis.fetch;'), ['fetch']);
  assert.deepEqual(forbiddenUses('new WebSocket(u)'), ['WebSocket', 'raw:WebSocket']);
  assert.deepEqual(forbiddenUses('x = eval("1")'), ['eval']);
  assert.deepEqual(forbiddenUses('x = new Function("return 1")'), ['Function']);
  assert.deepEqual(forbiddenUses("const m = await import('./x.js');"), ['import()']);
  // The BIP39 word "fetch" in a template, a comment mentioning eval(…), and fft.js's
  // `eval(a, x) {` method (called as poly.eval(…)) are not uses.
  assert.deepEqual(forbiddenUses('const w = `abandon\nfetch\nzoo`;'), []);
  assert.deepEqual(forbiddenUses('// same as eval(a, b)\nconst y = 1;'), []);
  assert.deepEqual(forbiddenUses('const poly = {\n  eval(a, x, brp = false) {\n    return a;\n  },\n};\npoly.eval(1, 2);'), []);
  // Regex literals and divisions are told apart, so a quote inside a regex does not derail it.
  const src = "const re = /['\"]/g; const q = a / b / c; const s = 'fetch';";
  const { bare } = splitJs(src);
  assert.equal(bare.length, src.length);
  assert.ok(bare.includes('const q = a / b / c;') && !bare.includes('fetch'));
  assert.throws(() => splitJs('const s = "unterminated'), /unterminated/);
});

test('findImports: static imports and re-exports, not dynamic ones or comments', () => {
  const { code } = splitJs("import { a } from './a.js';\nimport * as b from \"@noble/hashes/sha2.js\";\n// import x from './no.js';\nexport { c } from './c.js';\nimport './side.js';\nexport const d = 'not-a-spec';");
  assert.deepEqual(findImports(code).map((i) => i.spec), ['./a.js', '@noble/hashes/sha2.js', './c.js', './side.js']);
});
