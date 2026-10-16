// buyfiro.app, the one service Buy FIRO talks to: its buy API (v1) under one
// path, and its own site, which the person may open with a tap to reach its
// support.
//
// Written without the scheme and joined in buyApiBase(), as lib/eth/hosts.js
// does, so the "no source file reaches out to another origin" check in
// test/unit/config.test.mjs keeps flagging literal URLs elsewhere, and the
// CSP (tools/headers.mjs) lists exactly buyConnectSources(): the API path,
// never the whole host. A host added here is added to the CSP by the build.

const SCHEME = 'https:';

/** The buy API's hosts; the first is the one used. */
export const BUY_HOSTS = Object.freeze([Object.freeze({ id: 'buyfiro', name: 'buyfiro.app', host: 'buyfiro.app', path: '/api/v1/buy/' })]);

export const BUYFIRO = BUY_HOSTS[0];

/** The API's base, without the trailing slash: requests add "/assets", "/quote", … */
export function buyApiBase(entry = BUYFIRO) {
  if (!BUY_HOSTS.includes(entry)) throw new Error('Not one of the listed buy hosts.');
  return `${SCHEME}//${entry.host}${entry.path.slice(0, -1)}`;
}

/** buyfiro.app's site, where its support is. A link the person taps, never fetched. */
export function buySiteUrl(entry = BUYFIRO) {
  return `${SCHEME}//${entry.host}`;
}

/** What `connect-src` must list for Buy FIRO: the API paths only. */
export function buyConnectSources() {
  return BUY_HOSTS.map((e) => `${SCHEME}//${e.host}${e.path}`);
}
