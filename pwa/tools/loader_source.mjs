// The loader's source as the build writes it: src/sw.js with its placeholders filled in and
// lib/release.js, lib/update_sources.js, lib/server_address.js, lib/evm_server_address.js and
// lib/evm_server_check.js inlined where marked. One
// function, used by tools/build.mjs and by the unit tests that run the loader's own code
// (test/unit/helpers/sw_sandbox.mjs), so both see the same bytes.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SECURITY_HEADERS, MIME } from './headers.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * srcDir: the src/ folder; pub: the public JWK built in; loaderApi: another page <-> loader
 * contract level (tests), else sw.js's own; note: a comment appended (tests).
 * Returns { source, loaderApi, loaderCompat }.
 */
export async function loaderSource({ srcDir, pub, loaderApi = null, note = null }) {
  const releaseJs = (await readFile(join(srcDir, 'lib', 'release.js'), 'utf8')).replace(/^export /gm, '');
  // Inlined after release.js, whose names it imports: that one import line goes.
  const updateSourcesJs = (await readFile(join(srcDir, 'lib', 'update_sources.js'), 'utf8')).replace(/^import \{[^}]*\} from '\.\/release\.js';\n/m, '').replace(/^export /gm, '');
  if (/^import /m.test(updateSourcesJs)) throw new Error('lib/update_sources.js may import only from ./release.js: it is inlined into the service worker');
  const serverAddressJs = (await readFile(join(srcDir, 'lib', 'server_address.js'), 'utf8')).replace(/^export /gm, '');
  if (/^import /m.test(serverAddressJs)) throw new Error('lib/server_address.js must not import anything: it is inlined into the service worker');
  const evmAddressJs = (await readFile(join(srcDir, 'lib', 'evm_server_address.js'), 'utf8')).replace(/^export /gm, '');
  if (/^import /m.test(evmAddressJs)) throw new Error('lib/evm_server_address.js must not import anything: it is inlined into the service worker');
  const evmCheckJs = (await readFile(join(srcDir, 'lib', 'evm_server_check.js'), 'utf8')).replace(/^export /gm, '');
  if (/^import /m.test(evmCheckJs)) throw new Error('lib/evm_server_check.js must not import anything: it is inlined into the service worker');

  const swRaw = await readFile(join(srcDir, 'sw.js'), 'utf8');
  for (const mark of ['/*__INLINE_RELEASE_JS__*/', '/*__INLINE_UPDATE_SOURCES_JS__*/', '/*__INLINE_SERVER_ADDRESS_JS__*/', '/*__INLINE_EVM_SERVER_JS__*/'])
    if (!swRaw.includes(mark)) throw new Error(`sw.js: ${mark} not found`);
  const apiMatch = swRaw.match(/const LOADER_API = \/\*__LOADER_API__\*\/ (\d+);/);
  if (!apiMatch) throw new Error('sw.js: LOADER_API placeholder not found');
  const api = loaderApi === null ? Number(apiMatch[1]) : Number(loaderApi);
  if (!Number.isSafeInteger(api) || api < 1) throw new Error('--loader-api must be a positive integer');
  // What the loader does to the pages it serves. Equal values: a page of one release runs the same under either loader.
  // The own servers' rules (Firo's, and Ethereum's / BNB Chain's with the check run before one is saved) are part of it.
  const loaderCompat = sha256(Buffer.from(JSON.stringify({ api, headers: SECURITY_HEADERS, mime: MIME, server: serverAddressJs, evmServer: evmAddressJs, evmCheck: evmCheckJs })));
  let source = swRaw
    .replace(apiMatch[0], `const LOADER_API = ${api};`)
    .replace('/*__LOADER_COMPAT__*/ null', JSON.stringify(loaderCompat))
    .replace('/*__RELEASE_PUBLIC_JWK__*/ null', JSON.stringify(pub))
    .replace('/*__SECURITY_HEADERS__*/ {}', JSON.stringify(SECURITY_HEADERS))
    .replace('/*__MIME__*/ {}', JSON.stringify(MIME))
    .replace('/*__INLINE_RELEASE_JS__*/', () => `// ---- inlined from lib/release.js\n${releaseJs}\n// ---- end of lib/release.js`)
    .replace('/*__INLINE_UPDATE_SOURCES_JS__*/', () => `// ---- inlined from lib/update_sources.js\n${updateSourcesJs}\n// ---- end of lib/update_sources.js`)
    .replace('/*__INLINE_SERVER_ADDRESS_JS__*/', () => `// ---- inlined from lib/server_address.js\n${serverAddressJs}\n// ---- end of lib/server_address.js`)
    .replace('/*__INLINE_EVM_SERVER_JS__*/', () => `// ---- inlined from lib/evm_server_address.js\n${evmAddressJs}\n// ---- end of lib/evm_server_address.js\n// ---- inlined from lib/evm_server_check.js\n${evmCheckJs}\n// ---- end of lib/evm_server_check.js`);
  if (note !== null) source += `// ${note}\n`;
  if (/__[A-Z_]+__/.test(source.replace(/__campfire_(state|install|server|evm)/g, ''))) throw new Error('sw.js: a placeholder was not filled');
  return { source, loaderApi: api, loaderCompat };
}
