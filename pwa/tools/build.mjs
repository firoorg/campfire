// Builds a signed Campfire (Firo) release.
//
//   node tools/build.mjs [--out dist] [--version 1.2.3] [--key <private jwk>]
//                        [--mirrors <url,url,...>|none] [--write-deploy] [--publish]
//   Test-only: [--loader-note <text>] [--loader-api <n>] [--engine fake]
//              [--key <private jwk> --public <public jwk>] [--published <json>] [--test-hooks]
//   --engine fake: a build for the browser suites, whose lib/chain.js picks the stand-in Firo
//   engine (lib/backend_fake.js: no network, sample data). Never for a release: release.json
//   says engine "fake", the loader installs it only on a test host, and it is built into
//   dist-fake/ (never dist/).
//   window.__campfire, the browser suites' view of the app (src/app.js between <test-hooks>
//   markers), is left out of real-engine builds; --test-hooks keeps it for local checks against
//   one (never with --publish). Stand-in builds always keep it.
//   --public: sign with a throwaway key pair instead of the release key (the unit tests make one
//   in a temporary folder). Its public half goes into the build, so only that build's own loader
//   trusts it; every install of Campfire refuses it. It needs --key, so the release key is never
//   read for such a build.
//
// 1. Copies src/ into --out, filling in the version and the release public key
//    (lib/version.js, sw.js), and inlining lib/release.js, lib/update_sources.js,
//    lib/server_address.js, lib/evm_server_address.js and lib/evm_server_check.js
//    into sw.js (tools/loader_source.mjs). The service worker is written under
//    a content-addressed name, sw-<first 16 hex of its SHA-256>.js, and that
//    name goes into lib/version.js (LOADER). It carries nothing per-release,
//    so the name only changes when the loader's code does.
// 2. Writes manifest.json (every file with size and SHA-256), release.json
//    (version, manifest hash, the loader's name and loader_compat, and the
//    update sources: --mirrors, or BUILTIN_SOURCES of lib/update_sources.js)
//    and release.sig (ECDSA P-256 / SHA-256 over release.json, base64 of r||s).
//    loader_compat hashes what the loader does to pages (security headers,
//    MIME types, the own servers' rules of lib/server_address.js,
//    lib/evm_server_address.js and lib/evm_server_check.js, LOADER_API); a
//    release from a copy other than the app's own address installs only where
//    the running loader has the same value (lib/update_sources.js
//    loaderCompatible()). The build prints it: a release meant to reach
//    installs whose address is gone must keep it.
//    --loader-note adds a comment to the loader (a release whose loader differs
//    only in its bytes) and --loader-api builds another contract level (a
//    release the older loader cannot run): tests use them, releases do not.
// 3. Writes _headers for static hosts, and fails if deploy/_headers or
//    deploy/nginx.conf disagree with tools/headers.mjs.
// 4. One version, one build (tools/published.mjs): a real-engine release whose version
//    deploy/published.json lists with another manifest is refused before it is signed (raise the
//    version). --publish records the build it makes there; commit that file with the deploy.
//    --published points the check at another list (the unit tests, with a test key).
// The private key (default ~/.config/campfire-firo/pwa_release_key.jwk, or
// $CAMPFIRE_FIRO_RELEASE_KEY, or --key) never enters the output and is never printed. Only a
// build signed with the release key reads it: the unit tests sign with a throwaway pair (--public).
import { webcrypto, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, readdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nginxHeaderLines, renderHeaders } from './headers.mjs';
import { loaderSource } from './loader_source.mjs';
import { parsePublished, publishedConflict, withPublished, renderPublished } from './published.mjs';
import { BUILTIN_SOURCES, normalizeSource } from '../src/lib/update_sources.js';
import { RELEASE_APP_ID } from '../src/lib/release.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1];
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = arg('version', pkg.version);
const engine = arg('engine', 'real');
if (engine !== 'real' && engine !== 'fake') throw new Error('--engine must be real or fake');
// A stand-in build is signed like a release, so it never goes where a release is deployed from.
// --dev: your own build, signed with the pair keygen.mjs makes by default (outside the repo), into
// dist-dev/; no install of Campfire's releases accepts it, and it never touches the release key.
const dev = process.argv.includes('--dev');
const devConf = join(homedir(), '.config', 'campfire-firo');
const out = resolve(process.cwd(), arg('out', join(root, dev ? 'dist-dev' : engine === 'fake' ? 'dist-fake' : 'dist')));
if (engine === 'fake' && out === resolve(root, 'dist')) throw new Error('--engine fake never builds into dist/ (the folder a release is deployed from): leave out --out for dist-fake/, or name a test folder');
const committedPubPath = join(root, 'keys', 'release_public.jwk');
const pubArg = arg('public', dev ? join(devConf, 'dev_public.jwk') : null);
if (pubArg !== null && !dev && arg('key', null) === null) throw new Error('--public needs --key: a test build is signed with its own throwaway pair, never the release key');
if (dev && process.argv.includes('--publish')) throw new Error('--dev: your own build is never published');
const pubPath = pubArg === null ? committedPubPath : resolve(process.cwd(), pubArg);
const keyPath = arg('key', dev ? join(devConf, 'dev_key.jwk') : process.env.CAMPFIRE_FIRO_RELEASE_KEY || join(homedir(), '.config', 'campfire-firo', 'pwa_release_key.jwk'));
const quiet = process.argv.includes('--quiet');
const log = (...a) => quiet || console.log('build:', ...a);

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must look like 1.2.3, got ${version}`);
const mirrorsArg = arg('mirrors', null);
const updateSourcesList = mirrorsArg === null ? [...BUILTIN_SOURCES] : mirrorsArg === 'none' ? [] : mirrorsArg.split(',').map((u) => {
  const n = normalizeSource(u);
  if (!n.ok || n.url !== u.trim()) throw new Error(`--mirrors: ${u} is not an https folder address ending in /`);
  return n.url;
});
const publishedArg = arg('published', null);
const publishedPath = publishedArg === null ? join(root, 'deploy', 'published.json') : resolve(process.cwd(), publishedArg);
const publish = process.argv.includes('--publish');
if (publish && engine !== 'real') throw new Error('--publish: a stand-in build is never published');
const keepHooks = engine === 'fake' || process.argv.includes('--test-hooks');
if (publish && process.argv.includes('--test-hooks')) throw new Error('--publish with --test-hooks: a release never carries the test hooks');
const loaderNote = arg('loader-note', null);
if (loaderNote !== null && !/^[A-Za-z0-9 ._-]{1,80}$/.test(loaderNote)) throw new Error('--loader-note: letters, digits, space . _ - only');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ---- keys
const publicJwk = JSON.parse(await readFile(pubPath, 'utf8'));
const pub = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
const committedPub = JSON.parse(await readFile(committedPubPath, 'utf8'));
// Signed with a key other than the committed one: a test build, which no install of Campfire accepts.
const testKey = pub.x !== committedPub.x || pub.y !== committedPub.y;
let privJwk;
try {
  privJwk = JSON.parse(await readFile(keyPath, 'utf8'));
} catch {
  throw new Error(dev ? 'your build key was not found: create it with node tools/keygen.mjs' : 'release private key not found (pass --key, or build your own with --dev after node tools/keygen.mjs)');
}
if (privJwk.x !== pub.x || privJwk.y !== pub.y) throw new Error(`the private key does not belong to ${testKey ? 'the --public key' : 'keys/release_public.jwk'}`);
// The published list speaks for the release key: a test-key build is held to it only when a test names its own list.
const checkPublished = engine === 'real' && (!testKey || publishedArg !== null);
if (publish && !checkPublished) throw new Error('--publish: only a release signed with the release key is published');
const signKey = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: privJwk.x, y: privJwk.y, d: privJwk.d, ext: false }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
privJwk = null;

// ---- copy
async function walk(dir) {
  const outList = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) outList.push(...(await walk(p)));
    else if (e.isFile()) outList.push(p);
  }
  return outList;
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const srcDir = join(root, 'src');
// The loader first: its name goes into lib/version.js (tools/loader_source.mjs fills it in).
const { source: swSrc, loaderCompat } = await loaderSource({ srcDir, pub, loaderApi: arg('loader-api', null), note: loaderNote });
const LOADER_NAME = `sw-${sha256(Buffer.from(swSrc)).slice(0, 16)}.js`;
await writeFile(join(out, LOADER_NAME), swSrc);

for (const f of await walk(srcDir)) {
  const rel = relative(srcDir, f).split(sep).join('/');
  const dst = join(out, rel);
  await mkdir(dirname(dst), { recursive: true });
  if (rel === 'sw.js') {
    continue; // written above under its content-addressed name
  } else if (rel === 'lib/chain.js' && engine === 'fake') {
    const s = await readFile(f, 'utf8');
    const t = s.replace("export const ENGINE = 'real';", "export const ENGINE = 'fake';");
    if (t === s) throw new Error("lib/chain.js: ENGINE = 'real' not found for --engine fake");
    await writeFile(dst, t);
  } else if (rel === 'app.js' && !keepHooks) {
    const s = await readFile(f, 'utf8');
    const a = s.indexOf('// <test-hooks>');
    const b = s.indexOf('// </test-hooks>');
    if (a < 0 || b < a || s.indexOf('// <test-hooks>', a + 1) >= 0) throw new Error('app.js: one // <test-hooks> ... // </test-hooks> block expected');
    const end = s.indexOf('\n', b);
    await writeFile(dst, `${s.slice(0, a)}// (test hooks left out of this build)${end < 0 ? '' : s.slice(end)}`);
  } else if (rel === 'lib/version.js') {
    let s = await readFile(f, 'utf8');
    s = s
      .replace("export const APP_VERSION = '__BUILD_VERSION__';", `export const APP_VERSION = ${JSON.stringify(version)};`)
      .replace('/*__RELEASE_PUBLIC_JWK__*/ null', JSON.stringify(pub))
      .replace("export const LOADER = '__LOADER__';", `export const LOADER = ${JSON.stringify(LOADER_NAME)};`)
      .replace("export const LOADER_COMPAT = '__LOADER_COMPAT__';", `export const LOADER_COMPAT = ${JSON.stringify(loaderCompat)};`);
    if (s.includes('/*__') || s.includes('__LOADER__') || s.includes('__LOADER_COMPAT__')) throw new Error('version.js: a placeholder was not filled');
    await writeFile(dst, s);
  } else {
    await copyFile(f, dst);
  }
}
// ---- manifest, release, signature
const files = [];
for (const f of (await walk(out)).sort()) {
  const rel = relative(out, f).split(sep).join('/');
  const b = await readFile(f);
  files.push({ path: rel, sha256: sha256(b), size: b.length });
}
const manifest = { app: RELEASE_APP_ID, version, files };
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n');
await writeFile(join(out, 'manifest.json'), manifestBytes);
let published = null;
if (checkPublished) {
  published = parsePublished(await readFile(publishedPath, 'utf8').catch(() => ''));
  const conflict = publishedConflict(published, { version, manifest_sha256: sha256(manifestBytes) });
  if (conflict) {
    await rm(out, { recursive: true, force: true }); // nothing half-built and unsigned is left to deploy
    throw new Error(conflict);
  }
}
const release = {
  app: RELEASE_APP_ID,
  version,
  created: new Date().toISOString(),
  manifest_sha256: sha256(manifestBytes),
  file_count: files.length,
  loader: LOADER_NAME,
  loader_compat: loaderCompat,
  update_sources: updateSourcesList,
  // The stand-in engine's builds say so: the loader installs them only on a test host.
  engine,
};
const releaseBytes = Buffer.from(JSON.stringify(release, null, 1) + '\n');
await writeFile(join(out, 'release.json'), releaseBytes);
const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, releaseBytes));
await writeFile(join(out, 'release.sig'), Buffer.from(sig).toString('base64') + '\n');
if (publish) {
  await writeFile(publishedPath, renderPublished(withPublished(published, release)));
  log(`recorded ${version} in ${relative(process.cwd(), publishedPath)}: commit it with the deploy`);
}

// ---- static host headers
const headersText = renderHeaders();
await writeFile(join(out, '_headers'), headersText);
const committed = await readFile(join(root, 'deploy', '_headers'), 'utf8').catch(() => '');
if (committed !== headersText) {
  if (process.argv.includes('--write-deploy')) {
    await writeFile(join(root, 'deploy', '_headers'), headersText);
    log('updated deploy/_headers');
  } else throw new Error('deploy/_headers differs from tools/headers.mjs (run with --write-deploy)');
}
const nginx = await readFile(join(root, 'deploy', 'nginx.conf'), 'utf8').catch(() => '');
for (const line of nginxHeaderLines()) {
  if (!nginx.includes(line)) throw new Error(`deploy/nginx.conf is missing: ${line}`);
}

let total = 0;
for (const f of files) total += f.size;
if (engine === 'fake') log('engine: the STAND-IN (lib/backend_fake.js) - a test build, never a release');
if (testKey) log('signed with a TEST key (--public): no install of Campfire accepts this build');
log(`v${version}: ${files.length} files, ${(total / 1e6).toFixed(2)} MB, loader ${LOADER_NAME} (compat ${loaderCompat.slice(0, 16)}…), manifest ${release.manifest_sha256.slice(0, 16)}…, ${updateSourcesList.length} update copies, signed -> ${relative(process.cwd(), out) || '.'}`);

