// Where "Check for updates" looks for a newer signed release, and how it picks
// one. Shared by the service worker (the build inlines this file into sw.js,
// after lib/release.js, whose names it uses), the page (an address the person
// adds) and the unit tests. The only import is lib/release.js; the build drops
// that line when inlining.
//
// Every source is held to the same checks (lib/release.js): the signature under
// the key built into the app, the manifest hash, every file's size and SHA-256,
// the app id, and a version strictly newer than the one installed. So where the
// bytes come from does not decide what runs; it only decides whether an update
// can be found at all once the app's own address is gone.
//
// Sources: this app's own address, then the copies below (or the list the
// installed, signed release names), then an address the person added. A tapped
// check asks every one of them (at once, each with its own time limit) and keeps
// the newest signed release; on a tie, the own address's copy. So an address
// that keeps serving an old signed release (frozen, or taken over) cannot hide a
// newer one that a copy has. A source that does not answer, sends no CORS
// headers, sends something unsigned or altered, or is behind the installed
// version is noted. Each answer carries its signed release date (created), so
// the page can say when the newest release it found is old.
import { compareVersions, ReleaseError, RELEASE_APP_ID, verifyReleaseSignature, verifyManifest } from './release.js';

// Public copies of the published release: the signed build of each release is pushed to the
// `release` branch of github.com/vsnation/campfire-firo-pwa (its main branch holds the source),
// which GitHub Pages also serves. Each serves every file with Access-Control-Allow-Origin: *.
// They serve updates only: the app refuses to run from any of them (lib/shared_host.js, H9).
// Fresher first: raw.githubusercontent.com caches 5 min, GitHub Pages 10 min, jsDelivr up to 12 h.
// tools/build.mjs writes this list into release.json (signed), and the loader
// prefers the installed release's list, so a release can change it without a
// new loader.
export const BUILTIN_SOURCES = Object.freeze([
  'https://raw.githubusercontent.com/vsnation/campfire-firo-pwa/release/',
  'https://vsnation.github.io/campfire-firo-pwa/',
  'https://cdn.jsdelivr.net/gh/vsnation/campfire-firo-pwa@release/',
]);

export const MAX_SOURCE_LENGTH = 2000;
export const MAX_RELEASE_SOURCES = 10;
export const MAX_ADDED_SOURCES = 3;

/**
 * An address the person typed or pasted, as the folder a copy is served from:
 * https only, no user name or password, no query or fragment, a trailing slash.
 * An address typed without a scheme ("example.org/campfire") gets https, and
 * a link to the copy's index.html or release.json means its folder.
 * Returns {ok: true, url} or {ok: false, reason}.
 */
export function normalizeSource(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { ok: false, reason: 'Paste the address of a copy of Campfire.' };
  if (s.length > MAX_SOURCE_LENGTH) return { ok: false, reason: 'That address is too long.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "That isn't a web address." };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Use an address that starts with https://.' };
  if (u.username || u.password) return { ok: false, reason: 'Leave out the user name and password: the address must work without them.' };
  if (!u.hostname) return { ok: false, reason: "That isn't a web address." };
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/\/(index\.html|release\.json|release\.sig|manifest\.json)$/i, '/');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return { ok: true, url: u.href };
}

/** The list a signed release names (release.json update_sources), cleaned; null when it names none. */
export function releaseSources(release) {
  if (!release || !Array.isArray(release.update_sources)) return null;
  const out = [];
  for (const s of release.update_sources.slice(0, MAX_RELEASE_SOURCES)) {
    if (typeof s !== 'string') continue;
    const n = normalizeSource(s);
    if (n.ok && !out.includes(n.url)) out.push(n.url);
  }
  return out;
}

/**
 * Every place to ask, in order, each once: {url, host, kind: 'own'|'builtin'|'added', own}.
 * own is the app's own folder (the service worker's scope).
 */
export function updateSources({ own, builtins = BUILTIN_SOURCES, added = [] }) {
  const out = [];
  const seen = new Set();
  const push = (url, kind) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, host: new URL(url).host, kind, own: kind === 'own' });
  };
  push(new URL(own).href, 'own');
  for (const b of builtins || []) {
    const n = normalizeSource(b);
    if (n.ok) push(n.url, 'builtin');
  }
  for (const a of (added || []).slice(0, MAX_ADDED_SOURCES)) {
    if (typeof a !== 'string') continue;
    const n = normalizeSource(a);
    if (n.ok) push(n.url, 'added');
  }
  return out;
}

// Hosts that are never a public deployment: localhost and RFC 2606's reserved .test names. The
// same rule as lib/chain.js isTestHost (test/unit/release_engine.test.mjs checks they agree);
// a copy here because this file is inlined into the loader, which imports nothing.
const TEST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isTestHostname = (host) => TEST_HOSTS.has(host) || /\.test$/.test(String(host || ''));

/**
 * Whether a release may be installed at this address (hostname: the loader's own). A build with
 * the stand-in engine (release.json engine: 'fake', tools/build.mjs --engine fake: sample
 * balances, no Firo network) is signed like a release, so the signature alone cannot keep it off
 * a real address: it installs only on a test host. A release that names no engine predates the
 * field and is real.
 */
export function engineAllowed(release, hostname) {
  const engine = release && release.engine !== undefined ? release.engine : 'real';
  return engine === 'real' || isTestHostname(hostname);
}

/**
 * Whether a release can run under the loader that is running now. A service
 * worker can only come from the app's own address, so a release from anywhere
 * else runs under the current loader until that address answers again. That
 * is safe when the release ships this very loader, or one that serves pages
 * exactly as this one does: the same security headers, MIME types and
 * page <-> loader contract (the build hashes those into
 * loader_compat; sw.js holds its own value).
 */
export function loaderCompatible(release, loader) {
  if (!release || !loader || typeof release.loader !== 'string') return false;
  if (release.loader === loader.name) return true;
  return typeof release.loader_compat === 'string' && Boolean(loader.compat) && release.loader_compat === loader.compat;
}

/**
 * release.json, its signature and manifest.json from one source, verified.
 * get(path) returns the bytes. Something that is not this app's release.json
 * at all (a parking page, another app, an error page) means there is no
 * release there: 'unreachable', not 'refused'. A release.json that names this
 * app but fails the signature or the manifest hash is refused.
 */
export async function readRelease(get, publicJwk) {
  const relBytes = await get('release.json');
  let claimed = null;
  try {
    claimed = JSON.parse(new TextDecoder().decode(relBytes));
  } catch {
    claimed = null;
  }
  if (!claimed || claimed.app !== RELEASE_APP_ID) throw new ReleaseError('unreachable', 'No Campfire release is published at this address.');
  const sig = new TextDecoder().decode(await get('release.sig'));
  const release = await verifyReleaseSignature(relBytes, sig, publicJwk);
  const manifest = await verifyManifest(release, await get('manifest.json'));
  return { release, manifest };
}

const reasonOf = (e) => String((e && e.message) || e || 'unknown error');
const isUnreachable = (e) => !e || !e.code || e.code === 'unreachable';
/** A release's signed date (release.json created) when it is one; else null. */
export const createdOf = (release) => (release && typeof release.created === 'string' && Number.isFinite(Date.parse(release.created)) ? release.created : null);

/**
 * Asks every source, keeps the newest signed release and stages it.
 * installed/pending: {version, manifestSha} (installed also {created}, pending
 * also {from}); loader: {name, compat}. fetchRelease(source) -> {release,
 * manifest}; stage(source, rel) downloads and verifies every file (and throws
 * on the first that fails). onSource(source) when a source is asked,
 * onAnswer(source) when it has answered (or failed to).
 *
 * The newest version newer than the installed one is staged, from the own
 * address when it has it, else from the first copy in order that has it; when
 * that fails, the next source with it, then older ones. Nothing is staged from
 * a source other than the own address when the release could not run under the
 * current loader.
 *
 * Returns {result, version?, reason?, from?: {host, own}, newest: {version,
 * created}, ownVersion?, tried: [...] (in source order)}, where result is
 * 'ready' (a newer release is verified and waiting for Update), 'none'
 * (nothing newer anywhere that answered), 'needs_own_address' (newer, but only
 * installable from the own address), 'refused' (a newer release could not be
 * had intact, or only altered or unsigned releases answered) or 'unreachable'
 * (no release answered at all). newest is the newest signed release any source
 * (or the installed copy) knows of, with its date; ownVersion is what the own
 * address served, when it served a signed release.
 */
export async function findUpdate({ sources, installed, pending = null, loader, fetchRelease, stage, onSource = null, onAnswer = null }) {
  const notes = new Array(sources.length).fill(null);
  const note = (i, outcome, extra = {}) => {
    const src = sources[i];
    notes[i] = { host: src.host, kind: src.kind, own: src.own, outcome, ...extra };
    return notes[i];
  };
  const from = (t) => ({ host: t.host, own: t.own });
  const answers = await Promise.all(
    sources.map(async (src) => {
      if (onSource) await onSource(src);
      try {
        return { rel: await fetchRelease(src) };
      } catch (e) {
        return { error: e };
      } finally {
        if (onAnswer) await onAnswer(src);
      }
    }),
  );

  let newest = { version: installed.version, created: installed.created || null };
  let ownVersion;
  let refused = null; // a fetch refused: unsigned, altered list, a look-alike of the installed version
  let same = null;
  let behind = false;
  const candidates = [];
  answers.forEach((a, i) => {
    const src = sources[i];
    if (a.error) {
      const t = note(i, isUnreachable(a.error) ? 'unreachable' : 'refused', { reason: reasonOf(a.error) });
      if (t.outcome === 'refused' && !refused) refused = t;
      return;
    }
    const v = a.rel.release.version;
    const created = createdOf(a.rel.release);
    if (src.own) ownVersion = v;
    const cmp = compareVersions(v, newest.version);
    if (cmp > 0 || (cmp === 0 && created && (!newest.created || src.own))) newest = { version: v, created };
    const vs = compareVersions(v, installed.version);
    if (vs < 0) {
      note(i, 'older', { version: v });
      behind = true;
    } else if (vs === 0 && a.rel.release.manifest_sha256 !== installed.manifestSha) {
      const t = note(i, 'refused', { version: v, reason: `A different release claims version ${v}.` });
      if (!refused) refused = t;
    } else if (vs === 0) {
      const t = note(i, 'same', { version: v });
      if (!same || (src.own && !same.own)) same = t;
    } else {
      note(i, 'not_needed', { version: v }); // newer; replaced below by what happened to it
      candidates.push({ i, src, rel: a.rel, v });
    }
  });
  // Newest first; for one version the own address first, then the copies in order.
  candidates.sort((a, b) => compareVersions(b.v, a.v) || Number(b.src.own) - Number(a.src.own) || a.i - b.i);

  let blocked = null;
  let failedNewer = null;
  for (const c of candidates) {
    const { i, src, rel, v } = c;
    if (pending && pending.version === v && pending.manifestSha === rel.release.manifest_sha256) {
      const t = note(i, 'ready', { version: v });
      return { result: 'ready', version: v, from: pending.from || from(t), newest, ownVersion, tried: notes };
    }
    if (!src.own && !loaderCompatible(rel.release, loader)) {
      const t = note(i, 'needs_own_address', { version: v });
      if (!blocked) blocked = t;
      continue;
    }
    try {
      await stage(src, rel);
    } catch (e) {
      const t = note(i, isUnreachable(e) ? 'unreachable' : 'refused', { version: v, reason: reasonOf(e) });
      if (t.outcome === 'refused' && !failedNewer) failedNewer = t;
      continue;
    }
    const t = note(i, 'ready', { version: v });
    return { result: 'ready', version: v, from: from(t), created: createdOf(rel.release), newest, ownVersion, tried: notes };
  }
  if (blocked) return { result: 'needs_own_address', version: blocked.version, from: from(blocked), newest, ownVersion, tried: notes };
  // A newer signed release exists but could not be had intact: not "up to date".
  if (failedNewer) return { result: 'refused', version: failedNewer.version || null, reason: failedNewer.reason, from: from(failedNewer), newest, ownVersion, tried: notes };
  if (same) return { result: 'none', version: installed.version, from: from(same), newest, ownVersion, tried: notes };
  if (refused) return { result: 'refused', version: refused.version || null, reason: refused.reason, from: from(refused), newest, ownVersion, tried: notes };
  if (behind) return { result: 'none', version: installed.version, newest, ownVersion, tried: notes };
  return { result: 'unreachable', newest, tried: notes };
}
