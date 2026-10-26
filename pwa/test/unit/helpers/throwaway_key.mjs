// A signing key pair made for one test run, in its own temporary folder, for the unit tests that
// run tools/build.mjs (--key <private> --public <public>). The release key is never read by a
// test: only a release build reads it.
//
// Those tests build the whole app, so they run only when asked: CAMPFIRE_SIGN_TESTS=1.
import { webcrypto } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SIGN_TESTS = process.env.CAMPFIRE_SIGN_TESTS === '1';
export const SIGN_SKIP = !SIGN_TESTS && 'runs tools/build.mjs: set CAMPFIRE_SIGN_TESTS=1 (it signs with a throwaway key)';

/** { dir, args: ['--key', private, '--public', public], pub, d, cleanup() } */
export async function throwawayKey() {
  const dir = mkdtempSync(join(tmpdir(), 'campfire-testkey-'));
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const pub = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y };
  const privPath = join(dir, 'test_release_key.jwk');
  const pubPath = join(dir, 'test_release_public.jwk');
  writeFileSync(privPath, JSON.stringify({ ...pub, d: priv.d }) + '\n', { mode: 0o600 });
  writeFileSync(pubPath, JSON.stringify(pub) + '\n');
  return { dir, args: ['--key', privPath, '--public', pubPath], pub, d: priv.d, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
