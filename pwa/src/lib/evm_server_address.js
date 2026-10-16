// The person's own Ethereum or BNB Chain server: one address per chain, "Server address (https://…)".
// Shared by the page (lib/servers.js, lib/eth/hosts.js, the server screen) and the service worker:
// the build inlines this file into sw.js, so it imports nothing. The worker runs every address
// through normalizeEvmServer before its origin goes into a Content-Security-Policy, and puts only
// that origin there (scheme, host, port: never a path, a query or a wildcard), so nothing but
// [a-z0-9.-], one colon and a port can reach that header (cspWithEvmServers).
//
// What is accepted, and why:
//   - https:// only. http:// only for a node on this device: localhost or 127.0.0.1 (browsers treat
//     both as secure, and nothing leaves the device). [::1] is this device too, but a CSP host
//     source cannot name an IPv6 address: it is taken as localhost (the same node; said).
//     With no scheme typed: https://, or http:// for localhost and 127.0.0.1.
//   - A host name (an international one in its ASCII form, which is what the browser and the CSP
//     use, and what the screen shows back) or an IPv4 address written plainly (no 0x7f.1, 2130706433,
//     127.1: the browser would read those as another address than the one shown).
//   - Any port. A path and a query, as providers give them (an API key is often one): they stay in
//     the request URL only. Nothing the browser would rewrite ("..", "./", %2e, characters outside
//     plain ASCII): the address used is exactly the one typed.
//   - Refused: a user name or password (anything with @), a fragment (#), spaces and backslashes,
//     other schemes (ws, wss, javascript, data, ...), IPv6 other than [::1], 0.0.0.0.

export const EVM_SERVER_EXAMPLE = 'https://eth.example.com';
/** The chains a server can be added for, with their chain ids (lib/eth/chains.js has the same). */
export const EVM_SERVER_CHAINS = Object.freeze({ ethereum: 1, bsc: 56 });
export const MAX_EVM_SERVER_URL = 2048;
/** Where the page keeps each chain's choice (prefs): a listed server's id, or EVM_OWN with the address under `url`. */
export const EVM_SERVER_PREFS = Object.freeze({ ethereum: Object.freeze({ pick: 'ethRpc', url: 'ethRpcUrl' }), bsc: Object.freeze({ pick: 'bscRpc', url: 'bscRpcUrl' }) });
/** The pick that means "the person's own server". */
export const EVM_OWN = 'custom';

const EVM_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const evmFail = (code, error) => ({ ok: false, code, error });
const EVM_SCHEMES = 'Use an address that starts with https:// (or http:// for a node on this device: localhost or 127.0.0.1).';

function evmIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255) && parts[0] !== '0';
}

function evmHostname(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  // An all-digit last label would be read as a (shortened) IPv4 address.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * "https://Eth.Example.com:8545/v3/KEY" -> {ok: true, url: "https://eth.example.com:8545/v3/KEY",
 * origin: "https://eth.example.com:8545", host, port, local, note}. local: a node on this device.
 * note: a sentence when the address was taken in another form ([::1] -> localhost), else null.
 * Refused: {ok: false, code, error} with a plain sentence.
 */
export function normalizeEvmServer(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return evmFail('empty', `Type your server's address, for example ${EVM_SERVER_EXAMPLE}.`);
  if (s.length > MAX_EVM_SERVER_URL) return evmFail('long', 'That address is too long for a server address.');
  if (/[\s\\]|[\x00-\x1f\x7f]/.test(s)) return evmFail('chars', 'An address has no spaces or backslashes. Paste it as your provider gives it.');
  let scheme = null;
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme !== 'https' && scheme !== 'http') return evmFail('scheme', EVM_SCHEMES);
    s = s.slice(m[0].length);
  }
  if (s.includes('@')) return evmFail('credentials', 'Leave out any user name and password (the part before @): Campfire sends none.');
  if (s.includes('#')) return evmFail('fragment', 'Leave out the # and everything after it.');
  const cut = s.search(/[/?]/);
  const authority = cut < 0 ? s : s.slice(0, cut);
  let rest = cut < 0 ? '' : s.slice(cut);
  if (rest.startsWith('?')) rest = `/${rest}`;
  if (!authority) return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  let rawHost;
  let portText;
  if (authority.startsWith('[')) {
    const v6 = /^\[([^\]]*)\](?::(.*))?$/.exec(authority);
    if (!v6) return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
    rawHost = `[${v6[1].toLowerCase()}]`;
    portText = v6[2];
    if (rawHost !== '[::1]') return evmFail('ipv6', "IPv6 addresses can't be used here (the browser's rules cannot name them). Use the server's host name.");
  } else {
    if ((authority.match(/:/g) || []).length > 1) return evmFail('ipv6', "IPv6 addresses can't be used here (the browser's rules cannot name them). Use the server's host name.");
    const colon = authority.indexOf(':');
    rawHost = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
    portText = colon < 0 ? undefined : authority.slice(colon + 1);
  }
  let port = null;
  if (portText !== undefined) {
    if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return evmFail('port', 'The port (after the colon) must be a number from 1 to 65535.');
    port = Number(portText);
  }
  const local = EVM_LOCAL_HOSTS.has(rawHost);
  if (!scheme) scheme = local ? 'http' : 'https';
  if (scheme === 'http' && !local) return evmFail('insecure', 'Use https://. Only a node on this device (localhost or 127.0.0.1) may use http://.');
  let host = rawHost;
  let note = null;
  if (rawHost === '[::1]') {
    host = 'localhost';
    note = 'Saved as localhost: the same node on this device ([::1] cannot be named in the browser\'s rules).';
  } else if (/[^\x21-\x7e]/.test(rawHost)) {
    // An international name: its ASCII (punycode) form is what DNS, the browser and the CSP use.
    try {
      host = new URL(`https://${rawHost}/`).hostname;
    } catch {
      host = '';
    }
  }
  const dotted = /^[0-9.]+$/.test(host);
  if (!host || (dotted ? !evmIPv4(host) : !evmHostname(host))) return evmFail('host', `That is not a host name or an IPv4 address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  // The path and query exactly as typed: plain ASCII, no dot segments, nothing a browser rewrites.
  if (/[^\x21-\x7e]/.test(rest)) return evmFail('path', 'The part after the host may hold plain letters, digits and punctuation only.');
  const path = rest.split('?')[0];
  if (/(^|\/)\.{1,2}(\/|$)/.test(path) || /%2e/i.test(path)) return evmFail('path', 'Leave out "./" and "../" in the address: type it as your provider gives it.');
  const defaultPort = scheme === 'https' ? 443 : 80;
  const shownPort = port !== null && port !== defaultPort ? `:${port}` : '';
  const candidate = `${scheme}://${host}${shownPort}${rest || '/'}`;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  }
  if (u.protocol !== `${scheme}:` || u.hostname !== host || u.username || u.password || u.hash || `${u.pathname}${u.search}` !== (rest || '/'))
    return evmFail('path', 'That address has parts a browser would change. Type it as your provider gives it.');
  const origin = u.origin;
  if (!/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(origin)) return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  return { ok: true, url: u.href, origin, host, port: u.port ? Number(u.port) : null, local, note };
}

/** The origin (scheme, host, port) of a checked address, as connect-src names it. Throws for anything else. */
export function evmServerOrigin(address) {
  const n = normalizeEvmServer(address);
  if (!n.ok) throw new Error('not a server address');
  return n.origin;
}

/**
 * `csp` with the person's own Ethereum / BNB Chain servers' origins added to connect-src (each once,
 * after what is there), and nothing else changed. `origins`: a list or {chain: origin}; null entries
 * are skipped. Throws when one is not an origin normalizeEvmServer gives back unchanged.
 */
export function cspWithEvmServers(csp, origins) {
  const list = (Array.isArray(origins) ? origins : Object.values(origins || {})).filter((o) => o != null);
  if (!list.length) return csp;
  const add = list.map((o) => {
    const origin = evmServerOrigin(o);
    if (origin !== o) throw new Error('not an origin');
    return origin;
  });
  return csp
    .split('; ')
    .map((d) => {
      if (!d.startsWith('connect-src ')) return d;
      const have = d.split(' ');
      let out = d;
      for (const o of add) if (!have.includes(o) && !out.split(' ').includes(o)) out = `${out} ${o}`;
      return out;
    })
    .join('; ');
}

/** The own server's address `prefs` choose for `chain` (normalized), or null when a listed one is chosen. */
export function ownEvmServerOf(prefs, chain) {
  const k = EVM_SERVER_PREFS[chain];
  if (!k || !prefs || prefs[k.pick] !== EVM_OWN) return null;
  const n = normalizeEvmServer(prefs[k.url]);
  return n.ok ? n : null;
}

/** {ethereum, bsc} with each value an origin normalizeEvmServer gives back unchanged, or null. Anything else is dropped. */
export function cleanEvmOrigins(saved) {
  const out = {};
  for (const k of Object.keys(EVM_SERVER_CHAINS)) {
    const v = saved && typeof saved === 'object' ? saved[k] : null;
    let ok = null;
    if (typeof v === 'string') {
      const n = normalizeEvmServer(v);
      if (n.ok && n.origin === v) ok = v;
    }
    out[k] = ok;
  }
  return out;
}
