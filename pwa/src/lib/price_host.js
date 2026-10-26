// CoinGecko's price endpoint, the one outside price source (asked only after the person agrees).
// Its own small module so Home's dollar values (lib/fiat.js) do not load the Ethereum code
// (lib/eth/hosts.js re-exports it); e2e:eth and e2e:buy check first paint carries none.
export const PRICE_HOST = Object.freeze({ id: 'coingecko', name: 'CoinGecko', host: 'api.coingecko.com', path: '/api/v3/simple/price' });

const SCHEME = 'https:';

/** The origin of a host entry (scheme and host). */
export function originOf(entry) {
  return `${SCHEME}//${entry.host}`;
}
