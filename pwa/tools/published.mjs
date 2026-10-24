// Which version was published as which build (deploy/published.json, committed).
//
// Two different signed releases with the same version break every install that has one of them:
// the other is refused ("A different release claims version 0.1.0") and nothing newer can
// follow it under that number. So tools/build.mjs refuses to sign a version listed here with any
// other build (its manifest hash differs), and `--publish` records the build it makes. A rebuild
// of the very same sources gives the same manifest and is allowed.

export const PUBLISHED_ABOUT =
  'Every release signed with the Campfire (Firo) release key and published, by version. tools/build.mjs refuses to sign a listed version with any other build (another manifest hash): raise the version instead. node tools/build.mjs --publish adds the build it makes.';

/** The parsed file, or an empty list when there is none yet. Throws on a file that is not one. */
export function parsePublished(text) {
  if (text == null || String(text).trim() === '') return { about: PUBLISHED_ABOUT, releases: {} };
  const p = JSON.parse(text);
  if (!p || typeof p !== 'object' || !p.releases || typeof p.releases !== 'object' || Array.isArray(p.releases)) throw new Error('deploy/published.json: no "releases" map');
  for (const [v, r] of Object.entries(p.releases)) {
    if (!/^\d+\.\d+\.\d+$/.test(v) || !r || !/^[0-9a-f]{64}$/.test(r.manifest_sha256 || '')) throw new Error(`deploy/published.json: bad entry ${v}`);
  }
  return p;
}

/** null when `version` may be signed with this manifest; else why not, in words. */
export function publishedConflict(published, { version, manifest_sha256: sha }) {
  const had = published.releases[version];
  if (!had || had.manifest_sha256 === sha) return null;
  return `version ${version} was already published as another build (manifest ${had.manifest_sha256.slice(0, 16)}…${had.created ? `, ${had.created}` : ''}); this build's manifest is ${sha.slice(0, 16)}…. Raise "version" in package.json (or pass --version) and build again.`;
}

/** The list with this release recorded (unchanged when the same build is already there). */
export function withPublished(published, release) {
  const had = published.releases[release.version];
  if (had && had.manifest_sha256 === release.manifest_sha256) return published;
  const conflict = publishedConflict(published, release);
  if (conflict) throw new Error(conflict);
  const entry = { manifest_sha256: release.manifest_sha256, created: release.created, loader: release.loader, file_count: release.file_count };
  return { about: published.about || PUBLISHED_ABOUT, releases: { ...published.releases, [release.version]: entry } };
}

export const renderPublished = (p) => JSON.stringify(p, null, 1) + '\n';
