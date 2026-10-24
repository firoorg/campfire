// The loader's sentences (sw.js and what is inlined into it: lib/release.js, lib/update_sources.js,
// lib/server_address.js, lib/evm_server_address.js, lib/evm_server_check.js) stay English in those
// files (changing their bytes renames the loader or changes its loader_compat); the screens show them
// through lib/loader_words.js loaderText(). This lists every word-like literal of those files: each has
// its templates there, or the reason it is never shown. A new sentence in those files fails here until
// it is listed and has a template.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource } from '../../tools/i18n_scan.mjs';
import { LOADER_WORDS, loaderTemplate, loaderText } from '../../src/lib/loader_words.js';
import { activateLanguage, t } from '../../src/lib/i18n.js';
import { normalizeServerAddress, SERVER_EXAMPLE } from '../../src/lib/server_address.js';
import { normalizeEvmServer, EVM_SERVER_EXAMPLE } from '../../src/lib/evm_server_address.js';
import { verifyManifest, verifyFile, ReleaseError, RELEASE_APP_ID } from '../../src/lib/release.js';
import { normalizeSource } from '../../src/lib/update_sources.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const FILES = ['lib/release.js', 'lib/update_sources.js', 'lib/server_address.js', 'lib/evm_server_address.js', 'lib/evm_server_check.js', 'sw.js'];
const same = (s) => [s];
const DETAIL = "a check's detail, never shown as the reason";

// Source text (as the scanner gives it: {…} where a value goes) -> its templates in LOADER_WORDS, or a
// string: why it is never shown to a person.
const MAP = {
  // lib/release.js
  'Release key must be a public P-256 JWK.': same('Release key must be a public P-256 JWK.'),
  'The release signature is not readable.': same('The release signature is not readable.'),
  'This update is not signed with the Campfire release key.': same('This update is not signed with the Campfire release key.'),
  'release.json is not JSON.': same('release.json is not JSON.'),
  'release.json is missing fields.': same('release.json is missing fields.'),
  "This update's file list is not the one that was signed.": same("This update's file list is not the one that was signed."),
  'manifest.json does not belong to this release.': same('manifest.json does not belong to this release.'),
  'File count differs from the signed release.': same('File count differs from the signed release.'),
  'Bad file path in manifest: {…}': ['Bad file path in manifest: {path}'],
  'Duplicate path {…}': ['Duplicate path {path}'],
  'Bad entry for {…}': ['Bad entry for {path}'],
  'A file in this update ({…}) is not the one that was signed.': ['A file in this update ({path}) is not the one that was signed.'],
  // lib/update_sources.js
  'Paste the address of a copy of Campfire.': same('Paste the address of a copy of Campfire.'),
  'That address is too long.': same('That address is too long.'),
  "That isn't a web address.": same("That isn't a web address."),
  'Use an address that starts with https://.': same('Use an address that starts with https://.'),
  'Leave out the user name and password: the address must work without them.': same('Leave out the user name and password: the address must work without them.'),
  'No Campfire release is published at this address.': same('No Campfire release is published at this address.'),
  'unknown error': same('unknown error'),
  'A different release claims version {…}.': ['A different release claims version {version}.'],
  // lib/server_address.js ({example}: SERVER_EXAMPLE) and lib/evm_server_address.js (EVM_SERVER_EXAMPLE)
  "Type your server's address, for example {…}.": ["Type your server's address, for example {example}."],
  'A browser reaches ElectrumX over a secure WebSocket (wss) only. Type the host and its wss port, like {…}.': ['A browser reaches ElectrumX over a secure WebSocket (wss) only. Type the host and its wss port, like {example}.'],
  'Leave out {…} and type only the host and port, like {…}.': ['Leave out {scheme} and type only the host and port, like {example}.'],
  'Leave out the user name and password: type only the host and port, like {…}.': ['Leave out the user name and password: type only the host and port, like {example}.'],
  'Leave out everything after the port: type only the host and port, like {…}.': ['Leave out everything after the port: type only the host and port, like {example}.'],
  'An address has no spaces. It looks like {…}.': ['An address has no spaces. It looks like {example}.'],
  "IPv6 addresses can't be used here. Use the server's host name or its IPv4 address.": same("IPv6 addresses can't be used here. Use the server's host name or its IPv4 address."),
  'The port must be a number from 1 to 65535.': same('The port must be a number from 1 to 65535.'),
  'That is not a host name or an IPv4 address. It looks like {…}.': ['That is not a host name or an IPv4 address. It looks like {example}.'],
  'not a server address': 'serverOrigin() / evmServerOrigin() are only called with an address already checked: an internal error',
  'Use an address that starts with https:// (or http:// for a node on this device: localhost or 127.0.0.1).': same('Use an address that starts with https:// (or http:// for a node on this device: localhost or 127.0.0.1).'),
  'That address is too long for a server address.': same('That address is too long for a server address.'),
  'An address has no spaces or backslashes. Paste it as your provider gives it.': same('An address has no spaces or backslashes. Paste it as your provider gives it.'),
  'Leave out any user name and password (the part before @): Campfire sends none.': same('Leave out any user name and password (the part before @): Campfire sends none.'),
  'Leave out the # and everything after it.': same('Leave out the # and everything after it.'),
  'That is not a server address. It looks like {…}.': ['That is not a server address. It looks like {example}.'],
  "IPv6 addresses can't be used here (the browser's rules cannot name them). Use the server's host name.": same("IPv6 addresses can't be used here (the browser's rules cannot name them). Use the server's host name."),
  'The port (after the colon) must be a number from 1 to 65535.': same('The port (after the colon) must be a number from 1 to 65535.'),
  'Use https://. Only a node on this device (localhost or 127.0.0.1) may use http://.': same('Use https://. Only a node on this device (localhost or 127.0.0.1) may use http://.'),
  "Saved as localhost: the same node on this device ([::1] cannot be named in the browser's rules).": same("Saved as localhost: the same node on this device ([::1] cannot be named in the browser's rules)."),
  'The part after the host may hold plain letters, digits and punctuation only.': same('The part after the host may hold plain letters, digits and punctuation only.'),
  'Leave out "./" and "../" in the address: type it as your provider gives it.': same('Leave out "./" and "../" in the address: type it as your provider gives it.'),
  'That address has parts a browser would change. Type it as your provider gives it.': same('That address has parts a browser would change. Type it as your provider gives it.'),
  'not an origin': 'cspWithEvmServers() refuses anything but an origin: an internal error',
  // lib/evm_server_check.js: a check's detail (the server's trouble), never the reason shown
  'not a check request: {…}': DETAIL,
  'no answer in time': DETAIL,
  'not reachable': DETAIL,
  'too many requests': DETAIL,
  'stopped answering': DETAIL,
  'an answer far larger than any check needs': DETAIL,
  'not a JSON-RPC answer (HTTP {…})': DETAIL,
  'not a JSON-RPC answer': DETAIL,
  'an answer without a result': DETAIL,
  // sw.js
  'use strict': 'a directive',
  ' from {…}': 'a part of the sentences below (where = own ? "" : " from host"): their templates cover both forms',
  'Could not download {…}{…}.': ['Could not download {path}.', 'Could not download {path} from {host}.'],
  '{…}{…}: HTTP {…}': ['{path}: HTTP {status}', '{path} from {host}: HTTP {status}'],
  '{…}{…} is far larger than a Campfire release file.': ['{path} is far larger than a Campfire release file.', '{path} from {host} is far larger than a Campfire release file.'],
  'The download of {…}{…} was interrupted.': ['The download of {path} was interrupted.', 'The download of {path} from {host} was interrupted.'],
  'This is a test build of Campfire (sample balances, no Firo network), not a release.': same('This is a test build of Campfire (sample balances, no Firo network), not a release.'),
  'Not a chain this wallet holds coins on.': same('Not a chain this wallet holds coins on.'),
  'Another server is being checked. Try again in a moment.': same('Another server is being checked. Try again in a moment.'),
};
// Sentences the loader writes that the scanner does not see as words (a property named reason).
const EXTRA = ['unknown request'];

test("every sentence of the loader's code is listed: templates for the shown ones, a reason for the rest", () => {
  const found = new Set();
  for (const f of FILES) {
    for (const it of scanSource(readFileSync(join(src, f), 'utf8'), f).items) if (it.kind === 'text') found.add(it.value);
  }
  assert.deepEqual([...found].filter((x) => !(x in MAP)), [], 'new sentences: list them here and give them templates in lib/loader_words.js');
  assert.deepEqual(Object.keys(MAP).filter((x) => !found.has(x)), [], 'listed here but gone from the files');
  const templates = new Set(Object.values(MAP).filter(Array.isArray).flat().concat(EXTRA));
  assert.deepEqual([...templates].filter((x) => !LOADER_WORDS.includes(x)), [], 'missing from LOADER_WORDS');
  assert.deepEqual(LOADER_WORDS.filter((x) => !templates.has(x)), [], 'in LOADER_WORDS but written by nothing');
  assert.ok(readFileSync(join(src, 'sw.js'), 'utf8').includes("reason: 'unknown request'"));
});

test('a sentence is matched back to its own template with its values, the longest template first', () => {
  const fill = (tpl) => tpl.replace(/\{(\w+)\}/g, (m, k) => ({ path: 'lib/app.js', host: 'mirror.test:8812', status: '503', example: SERVER_EXAMPLE, scheme: 'https://', version: '0.1.12' })[k]);
  for (const tpl of LOADER_WORDS) {
    const s = fill(tpl);
    const r = loaderTemplate(s);
    assert.ok(r, s);
    assert.equal(r.template, tpl, s);
    assert.equal(loaderText(s), s, 'English: the same sentence');
  }
  assert.deepEqual(loaderTemplate('Could not download app.js from mirror.test:8812.'), { template: 'Could not download {path} from {host}.', params: { path: 'app.js', host: 'mirror.test:8812' } });
  assert.equal(loaderTemplate('Something a Firo node said.'), null);
  assert.equal(loaderText('Something a Firo node said.'), 'Something a Firo node said.');
  assert.equal(loaderText(undefined), undefined);
});

test('what the inlined code really writes has a template: server addresses, manifests, files', async () => {
  for (const bad of ['', 'ws://n.example:50004', 'https://n.example:50004', 'u:p@n.example:50004', 'n.example:50004/x', 'n example:50004', '[::1]:50004', 'n.example:99999', 'bad_host!:50004']) {
    const r = normalizeServerAddress(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(loaderTemplate(r.error), `${bad}: ${r.error}`);
  }
  for (const bad of ['', 'x'.repeat(5000), 'https://a b.example.com', 'wss://e.example.com', 'javascript:alert(1)', 'https://u:p@e.example.com', 'https://e.example.com/#x', 'https://', 'https://[2001:db8::1]', 'https://e.example.com:0', 'http://e.example.com', 'https://-e.example.com', 'https://e.example.com/ключ', 'https://e.example.com/../x', 'https://e.example.com/a"b']) {
    const r = normalizeEvmServer(bad);
    assert.equal(r.ok, false, bad.slice(0, 40));
    assert.ok(loaderTemplate(r.error), `${bad.slice(0, 40)}: ${r.error}`);
  }
  assert.ok(loaderTemplate(normalizeEvmServer('http://[::1]:8545').note));
  for (const bad of ['', 'x'.repeat(5000), 'http://copy.example/', 'https://u:p@copy.example/', 'https://']) {
    const r = normalizeSource(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(loaderTemplate(r.reason), `${bad.slice(0, 20)}: ${r.reason}`);
  }
  const release = { app: RELEASE_APP_ID, version: '1.0.0', manifest_sha256: '0'.repeat(64) };
  await assert.rejects(verifyManifest(release, new TextEncoder().encode('{}')), (e) => e instanceof ReleaseError && Boolean(loaderTemplate(e.message)));
  await assert.rejects(verifyFile({ path: 'app.js', size: 3, sha256: '0'.repeat(64) }, new Uint8Array(2)), (e) => Boolean(loaderTemplate(e.message)));
});

test('in another language the template is translated and the values put back as text', async () => {
  const catalog = {
    'Could not download {path} from {host}.': 'Не удалось скачать {path} с {host}.',
    'An address has no spaces. It looks like {example}.': 'В адресе нет пробелов. Он выглядит так: {example}.',
  };
  const fetchImpl = async () => ({ ok: true, json: async () => catalog });
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const doc = { documentElement: { setAttribute() {} } };
  try {
    await activateLanguage('ru', { storage, doc, fetchImpl, notify: false });
    assert.equal(loaderText('Could not download app.js from <b>x</b>.'), 'Не удалось скачать app.js с <b>x</b>.');
    assert.equal(loaderText(normalizeServerAddress('n example:50004').error), `В адресе нет пробелов. Он выглядит так: ${SERVER_EXAMPLE}.`);
    assert.equal(loaderText(`Type your server's address, for example https://evil.example.org.`), `Type your server's address, for example https://evil.example.org.`, 'another example is not taken for a template');
    assert.equal(loaderText(normalizeEvmServer('').error), normalizeEvmServer('').error, 'not in this test catalog: English');
    assert.equal(loaderText('Could not download app.js.'), 'Could not download app.js.', 'not translated yet: English');
    assert.equal(t('Reload'), 'Reload');
  } finally {
    await activateLanguage('en', { storage, doc, notify: false });
  }
});
