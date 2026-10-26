// NEAR Intents' 1Click API, the one service "Pay with BTC, ZEC or LTC" talks
// to, as the desktop app does (lib/wallets/ethereum/near_intents/
// one_click_client.dart, kOneClickBaseUrl): its swap API under one path
// (/v0/: tokens, quote, status), and its explorer, which the person may open
// with a tap to look a swap up.
//
// Written without the scheme and joined here, as lib/eth/hosts.js and
// lib/buy/hosts.js do, so the "no source file reaches out to another origin"
// check in test/unit/config.test.mjs keeps flagging literal URLs elsewhere,
// and the CSP (tools/headers.mjs) lists exactly intentsConnectSources(): the
// API path, never the whole host.

const SCHEME = 'https:';

export const ONECLICK = Object.freeze({ id: 'oneclick', name: 'NEAR Intents', host: '1click.chaindefuser.com', path: '/v0/' });

/** NEAR Intents' public explorer: a link the person taps, never fetched. */
export const INTENTS_EXPLORER = Object.freeze({ name: 'NEAR Intents explorer', host: 'explorer.near-intents.org' });

/** The API's base, without the trailing slash: requests add "/tokens", "/quote", "/status". */
export function intentsApiBase() {
  return `${SCHEME}//${ONECLICK.host}${ONECLICK.path.slice(0, -1)}`;
}

/** What `connect-src` must list for NEAR Intents: the API path only. */
export function intentsConnectSources() {
  return [`${SCHEME}//${ONECLICK.host}${ONECLICK.path}`];
}

/** The explorer's address (the person searches it for the deposit address). */
export function intentsExplorerUrl() {
  return `${SCHEME}//${INTENTS_EXPLORER.host}`;
}
