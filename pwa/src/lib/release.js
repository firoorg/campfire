// Signed releases. Shared by the service worker (the build inlines this file
// into sw.js), the build (which signs) and the unit tests. No imports, so it
// can be inlined; only WebCrypto, available in browsers, workers and Node 22.
//
// A deployment carries three files:
//   manifest.json  {"app","version","files":[{"path","sha256","size"}, ...]}
//   release.json   {"app","version","created","manifest_sha256","file_count",
//                   "loader","loader_compat","update_sources","engine"}
//   release.sig    base64 of the ECDSA P-256 / SHA-256 signature (IEEE P1363,
//                  r||s, 64 bytes, the format WebCrypto produces and Safari
//                  verifies) over the exact bytes of release.json.
// The app trusts a release only when the signature verifies under the public
// key built into it, manifest.json hashes to manifest_sha256, and every file
// matches its size and SHA-256.

export const RELEASE_APP_ID = 'campfire-firo-pwa';

export class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'bad_signature' | 'malformed' | 'manifest_mismatch' | 'file_mismatch' | 'downgrade' | 'test_build' | 'unreachable'
  }
}

export function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

export async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

function b64ToBytes(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importReleaseKey(publicJwk) {
  if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || publicJwk.d)
    throw new ReleaseError('malformed', 'Release key must be a public P-256 JWK.');
  const { kty, crv, x, y } = publicJwk;
  return crypto.subtle.importKey('jwk', { kty, crv, x, y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** Compares "1.2.3" style versions. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Verifies release.json bytes against release.sig with the embedded key.
 * Returns the parsed release object.
 */
export async function verifyReleaseSignature(releaseBytes, sigText, publicJwk) {
  const key = await importReleaseKey(publicJwk);
  let sig;
  try {
    sig = b64ToBytes(sigText);
  } catch {
    throw new ReleaseError('bad_signature', 'The release signature is not readable.');
  }
  const ok = sig.length === 64 && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, releaseBytes));
  if (!ok) throw new ReleaseError('bad_signature', 'This update is not signed with the Campfire release key.');
  let rel;
  try {
    rel = JSON.parse(new TextDecoder().decode(releaseBytes));
  } catch {
    throw new ReleaseError('malformed', 'release.json is not JSON.');
  }
  if (rel.app !== RELEASE_APP_ID || typeof rel.version !== 'string' || !/^[0-9a-f]{64}$/.test(rel.manifest_sha256 || ''))
    throw new ReleaseError('malformed', 'release.json is missing fields.');
  return rel;
}

/** Checks manifest.json bytes against a verified release; returns the manifest. */
export async function verifyManifest(release, manifestBytes) {
  const h = await sha256Hex(manifestBytes);
  if (h !== release.manifest_sha256) throw new ReleaseError('manifest_mismatch', "This update's file list is not the one that was signed.");
  const m = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (m.app !== RELEASE_APP_ID || m.version !== release.version || !Array.isArray(m.files))
    throw new ReleaseError('malformed', 'manifest.json does not belong to this release.');
  if (typeof release.file_count === 'number' && release.file_count !== m.files.length)
    throw new ReleaseError('manifest_mismatch', 'File count differs from the signed release.');
  const seen = new Set();
  for (const f of m.files) {
    if (typeof f.path !== 'string' || !/^[A-Za-z0-9._\-/]+$/.test(f.path) || f.path.includes('..') || f.path.startsWith('/'))
      throw new ReleaseError('malformed', `Bad file path in manifest: ${f.path}`);
    if (seen.has(f.path)) throw new ReleaseError('malformed', `Duplicate path ${f.path}`);
    seen.add(f.path);
    if (!/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0)
      throw new ReleaseError('malformed', `Bad entry for ${f.path}`);
  }
  return m;
}

/** Checks one downloaded file against its manifest entry. */
export async function verifyFile(entry, bytes) {
  const len = bytes.byteLength;
  if (len !== entry.size) throw new ReleaseError('file_mismatch', `A file in this update (${entry.path}) is not the one that was signed.`);
  const h = await sha256Hex(bytes);
  if (h !== entry.sha256) throw new ReleaseError('file_mismatch', `A file in this update (${entry.path}) is not the one that was signed.`);
}
