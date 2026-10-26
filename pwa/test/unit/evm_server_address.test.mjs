// The person's own Ethereum / BNB Chain server's address (lib/evm_server_address.js): what is taken,
// what is refused and why, and that only an origin - never a path, a query, credentials or a
// wildcard - can reach a Content-Security-Policy. The same file runs inside the service worker
// (inlined by tools/loader_source.mjs), so these are the rules the worker applies too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvmServer, evmServerOrigin, cspWithEvmServers, cleanEvmOrigins, ownEvmServerOf, EVM_SERVER_CHAINS, EVM_SERVER_PREFS, EVM_OWN, MAX_EVM_SERVER_URL } from '../../src/lib/evm_server_address.js';

const ok = (input) => {
  const n = normalizeEvmServer(input);
  assert.equal(n.ok, true, `${input}: ${n.error}`);
  return n;
};
const refused = (input, code) => {
  const n = normalizeEvmServer(input);
  assert.equal(n.ok, false, `${input} should be refused`);
  if (code) assert.equal(n.code, code, `${input}: ${n.code} (${n.error})`);
  assert.ok(typeof n.error === 'string' && n.error.length > 10 && !/undefined|null/.test(n.error), `${input}: a plain sentence`);
  return n;
};

test('https addresses as providers give them: host, port, path and query kept exactly; the origin is scheme, host and port', () => {
  for (const [input, url, origin] of [
    ['https://eth.example.com', 'https://eth.example.com/', 'https://eth.example.com'],
    ['  https://ETH.Example.COM/  ', 'https://eth.example.com/', 'https://eth.example.com'],
    ['https://eth.example.com:8545', 'https://eth.example.com:8545/', 'https://eth.example.com:8545'],
    ['https://eth.example.com:443/rpc', 'https://eth.example.com/rpc', 'https://eth.example.com'],
    ['https://mainnet.example.org/v3/0123456789abcdef', 'https://mainnet.example.org/v3/0123456789abcdef', 'https://mainnet.example.org'],
    ['https://lb.example.net/ogrpc?network=ethereum&dkey=AbC-123', 'https://lb.example.net/ogrpc?network=ethereum&dkey=AbC-123', 'https://lb.example.net'],
    ['https://node.example.com/rpc/', 'https://node.example.com/rpc/', 'https://node.example.com'],
    ['https://node.example.com?key=1', 'https://node.example.com/?key=1', 'https://node.example.com'],
    ['eth.example.com:8545/rpc', 'https://eth.example.com:8545/rpc', 'https://eth.example.com:8545'],
    ['https://203.0.113.7:8545', 'https://203.0.113.7:8545/', 'https://203.0.113.7:8545'],
    ['https://localhost:8545', 'https://localhost:8545/', 'https://localhost:8545'],
  ]) {
    const n = ok(input);
    assert.equal(n.url, url, input);
    assert.equal(n.origin, origin, input);
  }
  assert.equal(ok('https://eth.example.com:8545').port, 8545);
  assert.equal(ok('https://eth.example.com').port, null);
  assert.equal(ok('https://eth.example.com').local, false);
});

test('http only for a node on this device: localhost and 127.0.0.1 (any port), [::1] taken as localhost and said', () => {
  for (const [input, url] of [
    ['http://localhost:8545', 'http://localhost:8545/'],
    ['http://127.0.0.1:8545', 'http://127.0.0.1:8545/'],
    ['HTTP://LOCALHOST:8545/rpc', 'http://localhost:8545/rpc'],
    ['localhost:8545', 'http://localhost:8545/'],
    ['127.0.0.1:8545', 'http://127.0.0.1:8545/'],
    ['http://127.0.0.1', 'http://127.0.0.1/'],
  ]) {
    const n = ok(input);
    assert.equal(n.url, url, input);
    assert.equal(n.local, true, input);
    assert.equal(n.note, null);
  }
  const v6 = ok('http://[::1]:8545');
  assert.equal(v6.url, 'http://localhost:8545/');
  assert.equal(v6.origin, 'http://localhost:8545');
  assert.match(v6.note, /localhost.*same node/);
  assert.equal(ok('[::1]:8545').url, 'http://localhost:8545/', 'no scheme: http for this device');
  // Every other address over http is refused: plain http would show the requests to anyone on the way.
  for (const input of ['http://eth.example.com', 'http://eth.example.com:8545/rpc', 'http://192.168.1.10:8545', 'http://10.0.0.2:8545', 'http://127.0.0.2:8545', 'http://localhost.example.com:8545', 'http://203.0.113.7']) refused(input, 'insecure');
});

test('refused, each with what to change: credentials, other schemes, fragments, spaces, backslashes, bad ports', () => {
  for (const input of ['https://user:pass@eth.example.com', 'https://user@eth.example.com', 'https://eth.example.com@evil.example.com', 'https://eth.example.com/x@y', 'user:pw@eth.example.com']) refused(input, 'credentials');
  for (const input of ['wss://eth.example.com', 'ws://eth.example.com', 'ftp://eth.example.com', 'file:///etc/passwd', 'data://text', 'javascript://eth.example.com/%0aalert(1)', 'chrome-extension://abc']) refused(input, 'scheme');
  for (const input of ['https://eth.example.com/#x', 'https://eth.example.com#frag']) refused(input, 'fragment');
  for (const input of ['https://eth example.com', 'https://eth.example.com/a b', 'https://eth.example.com\\x', 'https://eth.example.com/\tx', 'https://eth.example.com/\nx']) refused(input, 'chars');
  for (const input of ['https://eth.example.com:0', 'https://eth.example.com:65536', 'https://eth.example.com:-1', 'https://eth.example.com:80a', 'https://eth.example.com:', 'https://eth.example.com:123456']) refused(input, 'port');
  refused('', 'empty');
  refused('   ', 'empty');
  refused(null, 'empty');
  refused(`https://eth.example.com/${'a'.repeat(MAX_EVM_SERVER_URL)}`, 'long');
});

test('IP addresses: written plainly or not at all; IPv6 other than [::1] cannot be named in a CSP', () => {
  // The browser would read these as 127.0.0.1 or another address than the one shown.
  for (const input of ['http://2130706433:8545', 'http://0x7f.0.0.1:8545', 'http://0x7f000001', 'http://127.1:8545', 'http://0177.0.0.1:8545', 'https://1.2.3', 'https://1.2.3.4.5', 'https://256.1.1.1', 'https://01.2.3.4', 'https://0.0.0.0:8545', 'https://%31%32%37.0.0.1', 'https://example.123']) refused(input);
  for (const input of ['https://[2001:db8::1]:8545', 'https://[::ffff:127.0.0.1]', 'http://[::]:8545', 'https://[fe80::1]', '2001:db8::1']) refused(input, 'ipv6');
  assert.equal(ok('https://8.8.8.8').origin, 'https://8.8.8.8');
});

test('host names: labels as DNS allows them; international names in their ASCII form (what the browser and the CSP use, and what is shown back)', () => {
  for (const input of ['https://-eth.example.com', 'https://eth-.example.com', 'https://eth..example.com', 'https://eth.example.com.', 'https://.example.com', 'https://eth_1.example.com', 'https://*.example.com', 'https://eth.*', 'https://:8545', 'https://', 'https://e%74h.example.com', `https://${'a'.repeat(64)}.example.com`]) refused(input);
  const idn = ok('https://bücher.example/rpc');
  assert.equal(idn.host, 'xn--bcher-kva.example');
  assert.equal(idn.url, 'https://xn--bcher-kva.example/rpc');
  // A look-alike of a listed server (Cyrillic "а") is shown as what it is.
  const lookAlike = ok('https://eth2.stackwаllet.com');
  assert.match(lookAlike.host, /^eth2\.xn--/);
  assert.notEqual(lookAlike.origin, 'https://eth2.stackwallet.com');
  // The path and query stay plain ASCII.
  refused('https://eth.example.com/ключ', 'path');
});

test('paths: exactly as typed; nothing a browser would rewrite ("..", "./", %2e, quotes) is taken', () => {
  for (const input of ['https://eth.example.com/a/../b', 'https://eth.example.com/./rpc', 'https://eth.example.com/..', 'https://eth.example.com/%2e%2e/rpc', 'https://eth.example.com/%2E/x', 'https://eth.example.com/a"b', 'https://eth.example.com/a<b>', 'https://eth.example.com/`x`', 'https://eth.example.com/{x}']) refused(input, 'path');
  // Double slashes and dots inside a name are not segments: kept as typed.
  assert.equal(ok('https://eth.example.com//rpc').url, 'https://eth.example.com//rpc');
  assert.equal(ok('https://eth.example.com/v1.2/rpc..x').url, 'https://eth.example.com/v1.2/rpc..x');
  assert.equal(ok('https://eth.example.com/%20key').url, 'https://eth.example.com/%20key');
});

test('evmServerOrigin and cspWithEvmServers: only an origin, once each, appended to connect-src; anything else throws', () => {
  const csp = "default-src 'self'; connect-src 'self' https://eth2.stackwallet.com; img-src 'self'";
  assert.equal(evmServerOrigin('https://eth.example.com:8545/v3/KEY'), 'https://eth.example.com:8545');
  assert.throws(() => evmServerOrigin('http://eth.example.com'));
  assert.equal(cspWithEvmServers(csp, []), csp);
  assert.equal(cspWithEvmServers(csp, null), csp);
  assert.equal(cspWithEvmServers(csp, { ethereum: null, bsc: null }), csp);
  assert.equal(cspWithEvmServers(csp, ['https://eth.example.com:8545']), "default-src 'self'; connect-src 'self' https://eth2.stackwallet.com https://eth.example.com:8545; img-src 'self'");
  assert.equal(cspWithEvmServers(csp, { ethereum: 'https://eth.example.com', bsc: 'http://127.0.0.1:8545' }), "default-src 'self'; connect-src 'self' https://eth2.stackwallet.com https://eth.example.com http://127.0.0.1:8545; img-src 'self'");
  assert.equal(cspWithEvmServers(csp, ['https://eth.example.com', 'https://eth.example.com']), "default-src 'self'; connect-src 'self' https://eth2.stackwallet.com https://eth.example.com; img-src 'self'", 'the same origin for both chains: once');
  assert.equal(cspWithEvmServers(csp, ['https://eth2.stackwallet.com']), csp, 'already allowed: nothing added');
  for (const bad of ['https://eth.example.com/', 'https://eth.example.com/rpc', 'https://eth.example.com?x', "https://eth.example.com; script-src 'unsafe-inline'", 'https://eth.example.com https://evil.example.com', 'https://*.example.com', 'https:', 'https://ETH.example.com', 'https://eth.example.com:443', 'http://[::1]:8545', 'http://eth.example.com', 'wss://eth.example.com', 42, {}])
    assert.throws(() => cspWithEvmServers(csp, [bad]), String(bad));
});

test('cleanEvmOrigins: what the service worker keeps is read back only as origins it would write; anything else is dropped', () => {
  assert.deepEqual(Object.keys(EVM_SERVER_CHAINS), ['ethereum', 'bsc']);
  assert.deepEqual(EVM_SERVER_CHAINS, { ethereum: 1, bsc: 56 });
  assert.deepEqual(cleanEvmOrigins(null), { ethereum: null, bsc: null });
  assert.deepEqual(cleanEvmOrigins({ ethereum: 'https://eth.example.com:8545', bsc: 'http://localhost:8545' }), { ethereum: 'https://eth.example.com:8545', bsc: 'http://localhost:8545' });
  assert.deepEqual(cleanEvmOrigins({ ethereum: 'https://eth.example.com/x', bsc: "https://b.example.com; script-src *", polygon: 'https://p.example.com' }), { ethereum: null, bsc: null });
  assert.deepEqual(cleanEvmOrigins({ ethereum: 7, bsc: ['https://b.example.com'] }), { ethereum: null, bsc: null });
  assert.deepEqual(cleanEvmOrigins('https://eth.example.com'), { ethereum: null, bsc: null });
});

test('ownEvmServerOf: the address prefs choose, only while the own server is the pick', () => {
  assert.deepEqual(EVM_SERVER_PREFS, { ethereum: { pick: 'ethRpc', url: 'ethRpcUrl' }, bsc: { pick: 'bscRpc', url: 'bscRpcUrl' } });
  assert.equal(EVM_OWN, 'custom');
  assert.equal(ownEvmServerOf({ bscRpc: 'custom', bscRpcUrl: 'https://b.example.com/rpc' }, 'bsc').url, 'https://b.example.com/rpc');
  assert.equal(ownEvmServerOf({ bscRpc: 'bsc-nodereal', bscRpcUrl: 'https://b.example.com/rpc' }, 'bsc'), null, 'kept for later, not in use');
  assert.equal(ownEvmServerOf({ bscRpc: 'custom', bscRpcUrl: 'http://b.example.com/rpc' }, 'bsc'), null, 'not an address it takes');
  assert.equal(ownEvmServerOf({ ethRpc: 'custom', ethRpcUrl: 'https://e.example.com' }, 'bsc'), null, 'per chain');
  assert.equal(ownEvmServerOf({ ethRpc: 'custom', ethRpcUrl: 'https://e.example.com' }, 'polygon'), null);
  assert.equal(ownEvmServerOf(null, 'ethereum'), null);
});
