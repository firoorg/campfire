// Creates a signing key pair (ECDSA P-256).
//
//   node tools/keygen.mjs                 a pair for your own builds (build.mjs --dev): private
//                                         ~/.config/campfire-firo/dev_key.jwk, public dev_public.jwk
//                                         beside it, both outside the repo
//   node tools/keygen.mjs --release       the release pair: private ~/.config/campfire-firo/
//                                         pwa_release_key.jwk ($CAMPFIRE_FIRO_RELEASE_KEY overrides),
//                                         public keys/release_public.jwk (committed), only when that
//                                         file does not exist yet
//   --private <path> --public <path>      other paths
//
// Never overwrites a private key, never prints one, and never replaces the committed release public
// key (public audit, H5: run as the README said, it silently put a contributor's key in its place).
// Campfire for Firo has its own release key pair: never BEAM Campfire's.
import { webcrypto } from 'node:crypto';
import { writeFile, mkdir, access, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? def : process.argv[i + 1];
}
const release = process.argv.includes('--release');
const conf = join(homedir(), '.config', 'campfire-firo');
const releasePub = join(here, '..', 'keys', 'release_public.jwk');
const privPath = arg('private', release ? process.env.CAMPFIRE_FIRO_RELEASE_KEY || join(conf, 'pwa_release_key.jwk') : join(conf, 'dev_key.jwk'));
const pubPath = arg('public', release ? releasePub : join(conf, 'dev_public.jwk'));

// The committed release public key is replaced by no one: a new one is a decision, made by hand.
if (pubPath === releasePub) {
  try {
    await access(releasePub);
    console.error('keygen: keys/release_public.jwk already exists; the release key is never replaced here. For your own builds, run without --release.');
    process.exit(1);
  } catch {
    /* no release key yet: this is the first */
  }
}

try {
  await access(privPath);
  console.error(`keygen: ${privPath} already exists; not overwriting it.`);
  process.exit(1);
} catch {
  /* good: no key yet */
}

const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const priv = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
const pub = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
const publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y, use: 'sig', alg: 'ES256', key_ops: ['verify'] };

await mkdir(dirname(privPath), { recursive: true, mode: 0o700 });
await writeFile(privPath, JSON.stringify({ kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }) + '\n', { mode: 0o600, flag: 'wx' });
await chmod(privPath, 0o600);
await mkdir(dirname(pubPath), { recursive: true });
await writeFile(pubPath, JSON.stringify(publicJwk, null, 2) + '\n', { flag: 'wx' });
console.log(`keygen: private key written (0600) to the configured path; public key: ${pubPath}${release ? '' : '\n        build with: node tools/build.mjs --dev'}`);
