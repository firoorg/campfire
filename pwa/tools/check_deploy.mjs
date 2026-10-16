// Checks a deployment from the outside, the way a phone sees it. Read-only: GET requests only.
//
//   node tools/check_deploy.mjs <https://address/of/the/app/> [--public <jwk>] [--concurrency 6]
//
// Run it after every deploy: the build cannot see what the host or its CDN does to the files.
//   - release.json, release.sig and manifest.json verify the way the loader verifies them
//     (lib/update_sources.js readRelease: the signature under keys/release_public.jwk, the
//     manifest hash, the app id), and the release may run at that address (no stand-in-engine
//     build on a public host: engineAllowed);
//   - every file of the manifest is served with its signed size and SHA-256, the loader under its
//     content-addressed name (sw-<first 16 hex of its SHA-256>.js, named by release.json and
//     lib/version.js);
//   - every response carries the headers the app must be served with (tools/headers.mjs
//     headersFor: the page policy, or the loader's own) and Cache-Control: no-cache, unchanged
//     (a CDN that rewrites it to max-age makes first visits mix an old and a new release);
//   - a path that is not in the release gets a 404 with the same security headers (CORS and
//     caching aside).
// Exits 1 on any problem, listing each; prints nothing secret (there is nothing secret here).
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { headersFor, mimeFor } from './headers.mjs';
import { readRelease, engineAllowed } from '../src/lib/update_sources.js';
import { verifyFile } from '../src/lib/release.js';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const TIMEOUT_MS = 60000;

/** The headers a response must carry for `rel` (a path under the app's folder). */
export function expectedHeaders(rel) {
  return { ...headersFor(rel), 'Cache-Control': 'no-cache' };
}

/** Differences between what a response carried and what it must carry: ["Name: got X, want Y"]. */
export function headerProblems(rel, headers) {
  const out = [];
  for (const [k, want] of Object.entries(expectedHeaders(rel))) {
    const got = headers.get(k);
    if (got === null) out.push(`${k}: missing (want ${want})`);
    else if (got !== want) out.push(`${k}: ${got} (want ${want})`);
  }
  return out;
}

/** The MIME type without parameters ("text/javascript; charset=utf-8" -> "text/javascript"). */
const baseType = (t) => String(t || '').split(';')[0].trim().toLowerCase();

/**
 * base: the app's folder (https://…/ with the trailing slash). publicJwk: the release key.
 * fetchImpl(url): a GET. Returns { ok, problems: [string], release, files }.
 */
export async function checkDeploy({ base, publicJwk, fetchImpl = fetch, concurrency = 6, onProgress = null }) {
  const root = new URL(base);
  if (!root.pathname.endsWith('/')) root.pathname += '/';
  const problems = [];
  const get = async (rel) => {
    const r = await fetchImpl(new URL(rel, root).href, { method: 'GET', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'campfire-check-deploy/1' } });
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, bytes };
  };
  const look = (rel, res) => {
    for (const p of headerProblems(rel, res.headers)) problems.push(`${rel}: ${p}`);
  };

  // The three release files, verified like the loader does.
  const meta = {};
  let rel = null;
  try {
    rel = await readRelease(async (p) => {
      const res = await get(p);
      meta[p] = res;
      if (res.status !== 200) throw Object.assign(new Error(`${p}: HTTP ${res.status}`), { code: 'unreachable' });
      return res.bytes;
    }, publicJwk);
  } catch (e) {
    problems.push(`release: ${e.message}`);
    for (const [p, res] of Object.entries(meta)) look(p, res);
    return { ok: false, problems, release: null, files: 0 };
  }
  for (const [p, res] of Object.entries(meta)) look(p, res);
  const { release, manifest } = rel;
  if (!engineAllowed(release, root.hostname)) problems.push(`release.json: engine "${release.engine}" is a test build (sample balances, no Firo network); installs refuse it here`);

  // Every file, with its signed size and SHA-256 and the right headers.
  let next = 0;
  let done = 0;
  const byPath = new Map();
  const worker = async () => {
    while (next < manifest.files.length) {
      const f = manifest.files[next++];
      let res;
      try {
        res = await get(f.path);
      } catch (e) {
        problems.push(`${f.path}: ${e.message}`);
        continue;
      }
      if (res.status !== 200) problems.push(`${f.path}: HTTP ${res.status}`);
      else {
        try {
          await verifyFile(f, res.bytes);
          byPath.set(f.path, res.bytes);
        } catch {
          problems.push(`${f.path}: not the signed file (${res.bytes.length} bytes, SHA-256 ${sha256(res.bytes).slice(0, 16)}…; signed ${f.size} bytes, ${f.sha256.slice(0, 16)}…)`);
        }
        if (baseType(res.headers.get('content-type')) !== baseType(mimeFor(f.path))) problems.push(`${f.path}: Content-Type ${res.headers.get('content-type')} (want ${mimeFor(f.path)})`);
      }
      look(f.path, res);
      done++;
      if (onProgress) onProgress(done, manifest.files.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, manifest.files.length)) }, worker));

  // The loader: named in release.json and lib/version.js, in the manifest, named after its bytes.
  const loader = release.loader;
  if (typeof loader !== 'string' || !/^sw-[0-9a-f]{16}\.js$/.test(loader)) problems.push(`release.json: loader ${loader} is not a loader name`);
  else {
    if (!manifest.files.some((f) => f.path === loader)) problems.push(`manifest.json: the loader ${loader} is not in it`);
    const bytes = byPath.get(loader);
    if (bytes && !sha256(bytes).startsWith(loader.slice(3, 19))) problems.push(`${loader}: its bytes do not hash to its name`);
    const versionJs = byPath.get('lib/version.js');
    const named = versionJs ? (new TextDecoder().decode(versionJs).match(/LOADER = "(sw-[0-9a-f]+\.js)"/) || [])[1] : null;
    if (versionJs && named !== loader) problems.push(`lib/version.js names loader ${named}, release.json ${loader}`);
  }

  // A path outside the release: 404, with the security headers too.
  const missing = `__campfire_check_deploy_${Date.now().toString(36)}.txt`;
  try {
    const res = await get(missing);
    if (res.status !== 404) problems.push(`${missing}: HTTP ${res.status} (want 404 for a path that is not in the release)`);
    // The security headers matter on an error page too; caching and CORS do not.
    for (const p of headerProblems(missing, res.headers)) if (!/^(Cache-Control|Access-Control-Allow-Origin):/.test(p)) problems.push(`a 404: ${p}`);
  } catch (e) {
    problems.push(`a 404: ${e.message}`);
  }
  return { ok: problems.length === 0, problems, release, files: manifest.files.length };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? def : args[i + 1];
  };
  const base = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!base || !/^https?:\/\//.test(base)) {
    console.error('usage: node tools/check_deploy.mjs <https://address/of/the/app/> [--public <jwk>] [--concurrency 6]');
    process.exit(2);
  }
  const pubPath = resolve(process.cwd(), opt('public', join(here, '..', 'keys', 'release_public.jwk')));
  const publicJwk = JSON.parse(await readFile(pubPath, 'utf8'));
  const r = await checkDeploy({ base, publicJwk, concurrency: Number(opt('concurrency', 6)), onProgress: (d, n) => d % 50 === 0 && console.log(`check-deploy: ${d} of ${n} files`) });
  if (r.release) console.log(`check-deploy: ${base} serves ${r.release.app} ${r.release.version} (${r.files} files, engine ${r.release.engine || 'real'}, created ${r.release.created})`);
  for (const p of r.problems) console.log(`PROBLEM ${p}`);
  console.log(r.ok ? 'check-deploy: OK' : `check-deploy: ${r.problems.length} problem(s)`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
