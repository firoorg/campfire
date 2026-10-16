// buyfiro.app, the one service Sell FIRO talks to: its sell API (v1) under one
// path, its own site (a link the person may tap to reach its support), and the
// block explorers whose page of a payout may be linked.
//
// Written without the scheme and joined in sellApiBase(), as lib/buy/hosts.js
// does, so the "no source file reaches out to another origin" check in
// test/unit/config.test.mjs keeps flagging literal URLs elsewhere, and the CSP
// (tools/headers.mjs) lists exactly sellConnectSources(): the API path, never
// the whole host. A host added here is added to the CSP by the build.

const SCHEME = 'https:';

/** The sell API's hosts; the first is the one used. */
export const SELL_HOSTS = Object.freeze([Object.freeze({ id: 'buyfiro', name: 'buyfiro.app', host: 'buyfiro.app', path: '/api/v1/sell/' })]);

export const SELLFIRO = SELL_HOSTS[0];

/** The API's base, without the trailing slash: requests add "/quote", "/order", … */
export function sellApiBase(entry = SELLFIRO) {
  if (!SELL_HOSTS.includes(entry)) throw new Error('Not one of the listed sell hosts.');
  return `${SCHEME}//${entry.host}${entry.path.slice(0, -1)}`;
}

/** buyfiro.app's site, where its support is. A link the person taps, never fetched. */
export function sellSiteUrl(entry = SELLFIRO) {
  return `${SCHEME}//${entry.host}`;
}

/** What `connect-src` must list for Sell FIRO: the API paths only. */
export function sellConnectSources() {
  return SELL_HOSTS.map((e) => `${SCHEME}//${e.host}${e.path}`);
}

/**
 * The block explorers a payout's page may be on, by the payout's chain id: the
 * link buyfiro.app sends (payout_explorer) is shown only when it is on one of
 * its chain's hosts. Links the person taps; the app never fetches them. A
 * chain missing here shows the transaction id instead of a link.
 */
export const PAYOUT_EXPLORERS = Object.freeze({
  1: Object.freeze(['etherscan.io']),
  10: Object.freeze(['optimistic.etherscan.io']),
  25: Object.freeze(['cronoscan.com', 'explorer.cronos.org']),
  56: Object.freeze(['bscscan.com']),
  137: Object.freeze(['polygonscan.com']),
  8453: Object.freeze(['basescan.org']),
  42161: Object.freeze(['arbiscan.io']),
  43114: Object.freeze(['snowtrace.io', 'snowscan.xyz']),
  59144: Object.freeze(['lineascan.build']),
});

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * buyfiro.app's link to a payout (payout_explorer), when it may be shown: https,
 * on a known explorer of the payout's chain (no other port, no password in it),
 * and about that very transaction (txid, a 32-byte hash, in its path). Else null:
 * the screen shows the transaction id.
 */
export function payoutTxUrl(link, { chainId, txid }) {
  if (typeof link !== 'string' || typeof txid !== 'string' || !TX_HASH.test(txid)) return null;
  const hosts = Object.hasOwn(PAYOUT_EXPLORERS, chainId) ? PAYOUT_EXPLORERS[chainId] : null;
  if (!hosts) return null;
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== SCHEME || u.port || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!hosts.includes(host)) return null;
  if (!u.pathname.toLowerCase().split('/').includes(txid.toLowerCase())) return null;
  return u.href;
}
