// Regenerates src/vendor/noble/ from the npm tarballs of five pinned packages:
// @noble/hashes, @noble/curves, @scure/base, @scure/bip32 and @scure/bip39.
//
//   node tools/vendor_noble.mjs          # runs `npm pack` for the pinned versions itself
//   node tools/vendor_noble.mjs <dir>    # or uses <dir>/<scope>-<name>-<version>.tgz
//
// Why it is there: the Ethereum wallet needs keccak-256, secp256k1, BIP39 and
// BIP32, and the PWA has no bundler and no runtime dependencies. These are
// small, audited, dependency-free ES modules by one author, so they are copied
// in as they are and served from this origin like the rest of the app.
//
// For each package: the tarball must match the pinned npm integrity (sha512);
// only the files reachable through static imports from the entry points the
// app uses are copied (and of BIP39's wordlists, English only); bare
// specifiers ('@noble/hashes/sha2.js') are rewritten to relative paths, and
// nothing else in any file is changed. A file that could make a request
// (fetch, XMLHttpRequest, WebSocket, …), evaluate code (eval, Function) or
// load code at run time (import()) is refused, and so the whole run fails.
// VENDOR.json records each file's SHA-256 next to its upstream one;
// test/unit/eth_vendor.test.mjs checks the committed files against it.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, rename, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGES = [
  {
    name: '@noble/hashes',
    version: '2.4.0',
    integrity: 'sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==',
    dir: 'noble-hashes',
    entries: ['sha3.js', 'sha2.js', 'hmac.js', 'pbkdf2.js', 'utils.js', 'blake2.js', 'scrypt.js'],
  },
  {
    name: '@noble/curves',
    version: '2.4.0',
    integrity: 'sha512-P4/62zrgfH33CneE3Dn4WhJVA22YUU0eR51wKIan4NVRvwsA0YnPTwWGpNbpuacSujmSFLvyzpyuR30+fbq2Ew==',
    dir: 'noble-curves',
    entries: ['secp256k1.js'],
  },
  {
    name: '@scure/base',
    version: '2.4.0',
    integrity: 'sha512-thZ1TuJwFwBblOhgsjDKvvGirBxNp+wSvY/DR6tJBJOTDhdAAcHJ8Vbr2eFnqaxeca4+t0i9KBf+uHYGWwZORg==',
    dir: 'scure-base',
    entries: [],
  },
  {
    name: '@scure/bip32',
    version: '2.4.0',
    integrity: 'sha512-i3DS0CptAocyvqE4n3SUkpzeQK4vJMFwWLofTwRiiKo2aWojBOfyMCgfKw9HVpO6fSY5AK86sHS/Uzn8kK9Few==',
    dir: 'scure-bip32',
    entries: ['index.js'],
  },
  {
    name: '@scure/bip39',
    version: '2.4.0',
    integrity: 'sha512-82dxFbZUYboyOf0AXiydsQrFQ5Q4h9mX+O2UkE91ROYmsc0BKMGZLwDmy96Jpa2+vrtoxomjUhy1RPIgH/r2nA==',
    dir: 'scure-bip39',
    entries: ['index.js', 'wordlists/english.js'],
  },
];

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(here, '..', 'src', 'vendor', 'noble');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const tarballName = (p) => `${p.name.slice(1).replace('/', '-')}-${p.version}.tgz`;

/**
 * Splits JavaScript source into code, comments and literals, keeping every
 * offset: returns `code` (comments blanked) and `bare` (comments and the
 * contents of strings, templates and regex literals blanked). Newlines stay,
 * so positions and line numbers match the source. Throws if the source
 * does not end where it started (outside any string or comment), which is how
 * a misread regex literal would show itself.
 */
export function splitJs(src) {
  const code = src.split('');
  const bare = src.split('');
  const blank = (arr, from, to) => {
    for (let i = from; i < to; i++) if (arr[i] !== '\n') arr[i] = ' ';
  };
  const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
  let i = 0;
  let prev = ''; // last significant character outside comments
  let prevWord = '';
  const braces = []; // for each open `${`, the brace depth to return to its template at
  let depth = 0;
  const n = src.length;
  const readString = (q) => {
    const start = i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') i++;
      else if (src[i] === '\n') throw new Error(`unterminated string at ${start}`);
      i++;
    }
    if (i >= n) throw new Error(`unterminated string at ${start}`);
    blank(bare, start + 1, i);
    i++;
  };
  // Reads template text up to its end or the next `${`; returns true at `${`.
  const readTemplate = () => {
    const start = i;
    while (i < n) {
      if (src[i] === '\\') i += 2;
      else if (src[i] === '`') {
        blank(bare, start, i);
        i++;
        return false;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        blank(bare, start, i);
        i += 2;
        return true;
      } else i++;
    }
    throw new Error(`unterminated template at ${start}`);
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i++;
      blank(code, start, i);
      blank(bare, start, i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`unterminated comment at ${i}`);
      blank(code, i, end + 2);
      blank(bare, i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      readString(c);
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === '`') {
      i++;
      if (readTemplate()) {
        braces.push(depth);
        depth++;
        prev = '{';
      } else prev = '`';
      prevWord = '';
      continue;
    }
    if (c === '/') {
      const isRegex = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(prevWord);
      if (isRegex) {
        const start = i++;
        let inClass = false;
        while (i < n) {
          const r = src[i];
          if (r === '\\') i += 2;
          else if (r === '\n') throw new Error(`unterminated regex at ${start}`);
          else if (inClass) {
            if (r === ']') inClass = false;
            i++;
          } else if (r === '[') {
            inClass = true;
            i++;
          } else if (r === '/') break;
          else i++;
        }
        blank(bare, start + 1, i);
        i++;
        while (i < n && /[a-z]/.test(src[i])) i++;
        prev = '/';
        prevWord = '';
        continue;
      }
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (braces.length && braces[braces.length - 1] === depth) {
        braces.pop();
        i++;
        if (readTemplate()) {
          braces.push(depth);
          depth++;
          prev = '{';
        } else prev = '`';
        prevWord = '';
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i, i + 64));
      prevWord = m[0];
      prev = 'a';
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9A-Za-z_.]+/.exec(src.slice(i, i + 128));
      prev = '0';
      prevWord = '';
      i += m[0].length;
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      prevWord = '';
    }
    i++;
  }
  if (braces.length || depth !== 0) throw new Error('unbalanced braces: the source was misread');
  return { code: code.join(''), bare: bare.join('') };
}

/** Static import/export-from specifiers, with their offsets, in comment-free code. */
export function findImports(code) {
  const out = [];
  const re = /(?<![.\w$])(?:import|export)\s*(?:[^'";]*?[\s}*]from\s*)?(['"])([^'"\n]+)\1/g;
  for (const m of code.matchAll(re)) {
    const spec = m[2];
    out.push({ spec, index: m.index + m[0].length - 1 - spec.length });
  }
  return out;
}

/** What makes a file unfit to vendor: request APIs, eval, Function, import(). */
export function forbiddenUses(src) {
  const { code, bare } = splitJs(src);
  const found = [];
  for (const m of bare.matchAll(/\b(fetch|XMLHttpRequest|WebSocket|importScripts|EventSource|sendBeacon)\b/g)) found.push(m[1]);
  // A call to eval. A method that happens to be named eval (`eval(a, x) {` in
  // curves' abstract/fft.js, called as `poly.eval(…)`) is not one.
  for (const m of bare.matchAll(/(?<![.\w$])eval\s*\(/g)) {
    const close = bare.indexOf(')', m.index);
    if (close > 0 && /^[ \t]*\{/.test(bare.slice(close + 1))) continue;
    found.push('eval');
  }
  if (/(?<![.\w$])Function\s*\(/.test(bare)) found.push('Function');
  if (/(?<![.\w$])import\s*\(/.test(code)) found.push('import()');
  // test/unit/config.test.mjs applies this to the raw text of src/vendor/; it must pass there too.
  const raw = /\b(fetch\(|XMLHttpRequest|WebSocket|importScripts|sendBeacon|EventSource)/.exec(src);
  if (raw) found.push(`raw:${raw[1]}`);
  return [...new Set(found)];
}

function resolveBare(spec, byName) {
  const m = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(spec);
  const pkg = m && byName.get(m[1]);
  if (!pkg) throw new Error(`import of a package that is not vendored: ${spec}`);
  const sub = m[2] ? `.${m[2]}` : '.';
  const exp = pkg.meta.exports;
  let target;
  if (exp && typeof exp === 'object') {
    const e = exp[sub];
    target = typeof e === 'string' ? e : e && (e.import || e.default);
  } else target = sub === '.' ? pkg.meta.module || pkg.meta.main || 'index.js' : sub;
  if (typeof target !== 'string') throw new Error(`${spec}: not exported by ${pkg.name}`);
  return { pkg, file: posix.normalize(target).replace(/^\.\//, '') };
}

async function main() {
  const given = process.argv[2];
  const tmp = await mkdtemp(join(tmpdir(), 'noble-'));
  try {
    const packDir = given || join(tmp, 'pack');
    if (!given) {
      await mkdir(packDir);
      for (const p of PACKAGES) execFileSync('npm', ['pack', `${p.name}@${p.version}`, '--pack-destination', packDir, '--silent'], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    const byName = new Map();
    for (const p of PACKAGES) {
      const bytes = await readFile(join(packDir, tarballName(p)));
      const got = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      if (got !== p.integrity) throw new Error(`${tarballName(p)} is not ${p.name} ${p.version} (integrity ${got})`);
      const root = join(tmp, p.dir);
      await mkdir(root);
      execFileSync('tar', ['-xzf', join(packDir, tarballName(p)), '-C', root]);
      const pkgRoot = join(root, 'package');
      const meta = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
      if (meta.name !== p.name || meta.version !== p.version) throw new Error(`${tarballName(p)}: unexpected package.json`);
      if (meta.license !== 'MIT') throw new Error(`${p.name}: license is ${meta.license}, expected MIT`);
      byName.set(p.name, { ...p, root: pkgRoot, meta, files: new Map() });
    }

    // Walk the import graph from the entry points.
    const queue = [];
    for (const p of byName.values()) for (const e of p.entries) queue.push({ pkg: p, file: e });
    while (queue.length) {
      const { pkg, file } = queue.shift();
      if (pkg.files.has(file)) continue;
      if (file.startsWith('../') || posix.isAbsolute(file)) throw new Error(`${pkg.name}: path outside the package: ${file}`);
      const src = await readFile(join(pkg.root, ...file.split('/')), 'utf8');
      const bad = forbiddenUses(src);
      if (bad.length) throw new Error(`refused ${pkg.name}/${file}: uses ${bad.join(', ')}`);
      const { code } = splitJs(src);
      const rewrites = [];
      for (const imp of findImports(code)) {
        let target;
        if (imp.spec.startsWith('./') || imp.spec.startsWith('../')) {
          target = { pkg, file: posix.normalize(posix.join(posix.dirname(file), imp.spec)) };
        } else {
          target = resolveBare(imp.spec, byName);
          let rel = posix.relative(posix.dirname(`${pkg.dir}/${file}`), `${target.pkg.dir}/${target.file}`);
          if (!rel.startsWith('.')) rel = `./${rel}`;
          rewrites.push({ index: imp.index, from: imp.spec, to: rel });
        }
        queue.push(target);
      }
      let out = src;
      for (const r of [...rewrites].sort((a, b) => b.index - a.index)) {
        if (out.slice(r.index, r.index + r.from.length) !== r.from) throw new Error(`${pkg.name}/${file}: specifier offset mismatch`);
        out = out.slice(0, r.index) + r.to + out.slice(r.index + r.from.length);
      }
      pkg.files.set(file, { src, out, rewrites: rewrites.map(({ from, to }) => ({ from, to })) });
    }

    // Write into a fresh directory, then swap it in.
    const stage = join(dirname(OUT_DIR), '.noble.tmp');
    await rm(stage, { recursive: true, force: true });
    const record = {
      comment: 'Generated by tools/vendor_noble.mjs. Each file is the upstream file from the npm tarball (pinned by integrity) with only its bare import specifiers rewritten to relative paths; sha256 is of the file here, upstream_sha256 of the file in the tarball.',
      packages: [],
    };
    let total = 0;
    let count = 0;
    for (const p of byName.values()) {
      const files = [];
      const license = await readFile(join(p.root, 'LICENSE'));
      const items = [...p.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [file, f] of items) {
        const dst = join(stage, p.dir, ...file.split('/'));
        await mkdir(dirname(dst), { recursive: true });
        await writeFile(dst, f.out);
        const b = Buffer.from(f.out);
        total += b.length;
        count++;
        files.push({ path: file, sha256: sha256(b), upstream_sha256: sha256(Buffer.from(f.src)), size: b.length, ...(f.rewrites.length ? { rewrites: f.rewrites } : {}) });
      }
      await mkdir(join(stage, p.dir), { recursive: true });
      await writeFile(join(stage, p.dir, 'LICENSE'), license);
      files.push({ path: 'LICENSE', sha256: sha256(license), upstream_sha256: sha256(license), size: license.length });
      record.packages.push({ package: p.name, version: p.version, integrity: p.integrity, license: p.meta.license, dir: p.dir, entries: p.entries, files });
    }
    await writeFile(join(stage, 'VENDOR.json'), JSON.stringify(record, null, 1) + '\n');
    await rm(OUT_DIR, { recursive: true, force: true });
    await rename(stage, OUT_DIR);
    console.log(`wrote ${relative(process.cwd(), OUT_DIR) || '.'}: ${count} modules, ${total} bytes`);
    for (const p of record.packages) console.log(`  ${p.package}@${p.version}: ${p.files.length - 1} file(s)`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
