// The person's own ElectrumX server: "host:port" and nothing else, reached over wss://.
// Shared by the page (lib/servers.js, screens/servers.js) and the service worker: the build
// inlines this file into sw.js, so it imports nothing. The worker runs every address through
// normalizeServerAddress before it goes into a Content-Security-Policy, so nothing but
// [a-z0-9.-], one colon and a port can ever reach that header.

export const SERVER_EXAMPLE = 'electrum.example.com:50004';
/** ElectrumX's usual secure WebSocket port, used when none is typed. */
export const DEFAULT_WSS_PORT = 50004;

const fail = (code, error) => ({ ok: false, code, error });

function validIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

function validHostname(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  // An all-digit last label would be read as a (shortened) IPv4 address.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * "wss://Electrum.Example.com:50004/" -> {ok: true, address: "electrum.example.com:50004", host, port}.
 * A missing port is ElectrumX's wss port, 50004. Refused, each with a plain sentence: a scheme
 * other than wss://, a user name or password, a path, query or fragment, IPv6 (CSP host sources
 * cannot name one), an out-of-range port, anything that is not a host name or an IPv4 address.
 */
export function normalizeServerAddress(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return fail('empty', `Type your server's address, for example ${SERVER_EXAMPLE}.`);
  if (/^wss:\/\//i.test(s)) s = s.slice(6);
  else if (/^(ws|tcp|ssl):\/\//i.test(s)) return fail('insecure', `A browser reaches ElectrumX over a secure WebSocket (wss) only. Type the host and its wss port, like ${SERVER_EXAMPLE}.`);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return fail('scheme', `Leave out ${s.slice(0, s.indexOf('://') + 3)} and type only the host and port, like ${SERVER_EXAMPLE}.`);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.includes('@')) return fail('credentials', `Leave out the user name and password: type only the host and port, like ${SERVER_EXAMPLE}.`);
  if (/[/?#\\]/.test(s)) return fail('path', `Leave out everything after the port: type only the host and port, like ${SERVER_EXAMPLE}.`);
  if (/\s/.test(s)) return fail('host', `An address has no spaces. It looks like ${SERVER_EXAMPLE}.`);
  if (s.startsWith('[') || (s.match(/:/g) || []).length > 1) return fail('ipv6', "IPv6 addresses can't be used here. Use the server's host name or its IPv4 address.");
  const colon = s.lastIndexOf(':');
  let port = DEFAULT_WSS_PORT;
  let host = s;
  if (colon >= 0) {
    const portText = s.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return fail('port', 'The port must be a number from 1 to 65535.');
    port = Number(portText);
    host = s.slice(0, colon);
  }
  host = host.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (/[^\x21-\x7e]/.test(host)) {
    // An international name: its ASCII (punycode) form is what DNS and the CSP use.
    try {
      host = new URL(`wss://${host}/`).hostname;
    } catch {
      host = '';
    }
  }
  const dotted = /^[0-9.]+$/.test(host);
  if (!host || (dotted ? !validIPv4(host) : !validHostname(host))) return fail('host', `That is not a host name or an IPv4 address. It looks like ${SERVER_EXAMPLE}.`);
  return { ok: true, address: `${host}:${port}`, host, port };
}

/** The WebSocket origin of a checked address: "wss://host:port". */
export function serverOrigin(address) {
  const n = normalizeServerAddress(address);
  if (!n.ok) throw new Error('not a server address');
  return `wss://${n.address}`;
}

/** `csp` with the person's own server added to connect-src, and nothing else changed. null: `csp` itself. */
export function cspWithServer(csp, address) {
  if (address == null) return csp;
  const origin = serverOrigin(address);
  return csp
    .split('; ')
    .map((d) => (d.startsWith('connect-src ') && !d.split(' ').includes(origin) ? `${d} ${origin}` : d))
    .join('; ');
}
