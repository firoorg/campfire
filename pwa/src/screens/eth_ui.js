// Pieces the Ethereum / BNB Chain screens share: token badges, amounts in words, the
// "server didn't answer" notice with its ways out, the "doesn't say whether it went through"
// notice, the chain picker, and activity rows.
import { h, svg, shorten, fmtDate } from '../lib/dom.js';
import { encodeQr, qrSvgPath } from '../lib/qr.js';
import { icon } from '../lib/icons.js';
import { assetBadge, notice } from '../lib/ui.js';
import { formatUnits, isRoundedDown, DISPLAY_DECIMALS } from '../lib/eth/units.js';
import { ETH } from '../lib/eth/tokens.js';
import { compactUnits } from '../lib/compact.js';
import { RPC_HOSTS, DEFAULT_RPC } from '../lib/eth/hosts.js';
import { evmPrefs } from '../lib/eth/wallet.js';
import { useListedEvmServer } from '../lib/servers.js';
import { CHAINS, CHAIN_KEYS } from '../lib/eth/chains.js';
import { entryChain, entryWords } from '../lib/eth/outbox.js';
import { t, tk, tNodes } from '../lib/i18n.js';

// Fixed colours, never taken from a token contract.
const TOKEN_COLORS = { USDT: '#26a17b', USDC: '#2775ca', WBTC: '#f09242', DAI: '#f5ac37', BNB: '#f0b90b' };

/** A chain's small mark for a badge's corner: Ethereum's diamond, or BNB Chain's initial on its yellow. */
function chainMark(chainKey) {
  if (chainKey === 'bsc') {
    const m = h('span', { class: 'badge-mark bnb-mark', 'aria-hidden': 'true', text: 'B' });
    m.style.setProperty('background', '#f0b90b');
    m.style.setProperty('color', '#1c1d22');
    m.style.setProperty('font-size', '10px');
    m.style.setProperty('font-weight', '700');
    return m;
  }
  return h('span', { class: 'badge-mark', 'aria-hidden': 'true' }, h('img', { src: 'img/eth.svg', alt: '' }));
}

/** ETH's diamond, BNB on its yellow; rsFIRO as FIRO with its chain's mark (a public token, not private FIRO); the others as letters. */
export function ethBadge(asset, size = '') {
  if (asset === ETH) return h('span', { class: `asset-badge eth ${size}`.trim(), 'aria-hidden': 'true' }, h('img', { src: 'img/eth.svg', alt: '' }));
  if (asset && asset.firo) return rsfiroBadge(size, asset.chain);
  return assetBadge({ id: -1, unit: asset.symbol, color: TOKEN_COLORS[asset.symbol] }, { size });
}

/** rsFIRO's badge: FIRO's, with its chain's mark in the corner, so it never passes for private FIRO. */
export function rsfiroBadge(size = '', chainKey = 'ethereum') {
  return h('span', { class: 'badge-pair', 'data-badge': `rsfiro-${chainKey}` }, assetBadge({ id: 'firo' }, { size }), chainMark(chainKey));
}

/** What a token is, in a few words, under its name in a list. */
export function tokenNote(asset) {
  if (!asset) return '';
  if (asset.firo) return t('FIRO on {name} (public)', { name: CHAINS[asset.chain || 'ethereum'].name });
  return asset.symbol;
}

/** "0.01 ETH" / "0.01 BNB": a fee or a coin amount on `chainKey`, rounded down. */
export function coinText(wei, chainKey = 'ethereum') {
  return `${formatUnits(wei, 18)} ${CHAINS[chainKey].native.symbol}`;
}

/** An "at most" figure on `chainKey`: rounded UP at the shown precision. */
export function coinMaxText(wei, chainKey = 'ethereum') {
  const v = BigInt(wei);
  const cut = 10n ** BigInt(18 - DISPLAY_DECIMALS);
  const up = v % cut === 0n ? v : v + (cut - (v % cut));
  return `${formatUnits(up, 18)} ${CHAINS[chainKey].native.symbol}`;
}

/**
 * Ethereum | BNB Chain, as two tabs: which chain a screen works on. onPick(chainKey) when the
 * other is tapped. testid: 'evm-chain' (each tab 'evm-chain-ethereum' / 'evm-chain-bsc').
 */
export function chainTabs(active, onPick, { testid = 'evm-chain', label = t('Network') } = {}) {
  return h(
    'div',
    { class: 'segmented', role: 'tablist', 'aria-label': label, 'data-testid': testid },
    ...CHAIN_KEYS.map((k) =>
      h('button', { type: 'button', class: `seg${k === active ? ' on' : ''}`, role: 'tab', 'aria-selected': String(k === active), 'data-testid': `${testid}-${k}`, onclick: k === active ? null : () => onPick(k) }, CHAINS[k].name),
    ),
  );
}

/** HSL (0-360, 0-1, 0-1) → "#rrggbb". */
function hslHex(hue, sat, light) {
  const k = (n) => (n + hue / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A coin from another chain (NEAR Intents' coin list): its letters on a colour made from its
 * id. No picture is downloaded, and a copy never borrows a real coin's look.
 */
export function coinBadge(assetId, symbol, size = '') {
  let hue = 7;
  for (const ch of String(assetId)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const clean = String(symbol).replace(/[^A-Za-z0-9]/g, '');
  const letters = clean.slice(0, 3).toUpperCase() || '?';
  const el = h('span', { class: `asset-badge tinted coin${letters.length > 2 ? ' three' : ''} ${size}`.trim(), 'aria-hidden': 'true', text: letters });
  el.style.setProperty('--badge', hslHex(hue, 0.5, 0.42));
  el.style.setProperty('--badge-ink', '#ffffff');
  return el;
}

/** A QR code of `text` (an address), black on white whatever the theme, so every camera reads it. */
export function qrElement(text, label = t('QR code of the address')) {
  const qr = encodeQr(text, { ecl: 'M' });
  const n = qr.size + 8;
  return svg('svg', { viewBox: `0 0 ${n} ${n}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': label }, svg('rect', { width: n, height: n, fill: '#ffffff' }), svg('path', { d: qrSvgPath(qr, 4), fill: '#000000' }));
}

/** "0.01 ETH"; "≈" when the display hides digits (full precision is on the review). */
export function amountText(value, asset, { approx = true } = {}) {
  const item = `${formatUnits(value, asset.decimals)} ${asset.symbol}`;
  return approx && isRoundedDown(value, asset.decimals) ? `≈${item}` : item;
}

/**
 * A short balance for a list row, rounded as the activity rows and the desktop
 * round (compactUnits); "≈" when digits are hidden. The exact figure goes in
 * the row's title.
 */
export function compactAmountText(value, asset) {
  const v = BigInt(value);
  const shown = compactUnits(v, asset.decimals);
  const exact = formatUnits(v, asset.decimals, { maxDecimals: asset.decimals });
  return `${shown === exact ? '' : '≈'}${shown} ${asset.symbol}`;
}

/** The exact figure, every decimal: for the review and on tap. */
export function exactText(value, asset) {
  return `${formatUnits(value, asset.decimals, { maxDecimals: asset.decimals })} ${asset.symbol}`;
}

/** A fee "about" this much: rounded down, no "≈" (the word says it). */
export function ethText(wei) {
  return `${formatUnits(wei, ETH.decimals)} ETH`;
}

/** An "at most" figure: rounded UP at the shown precision, so the limit is never understated. */
export function ethMaxText(wei) {
  const v = BigInt(wei);
  const cut = 10n ** BigInt(ETH.decimals - DISPLAY_DECIMALS);
  const up = v % cut === 0n ? v : v + (cut - (v % cut));
  return `${formatUnits(up, ETH.decimals)} ETH`;
}

/** The address in groups of four, so it can be read out and compared. */
export function groupedAddress(address) {
  return `${address.slice(0, 2)} ${address.slice(2).match(/.{1,4}/g).join(' ')}`;
}

export function shortAddress(address) {
  return shorten(address, 6, 4);
}

/**
 * The listed server to offer instead of the one in use on `chain`: the default, or, when the
 * default is in use, the next one of the list. The person's own server: the default.
 */
export function altServer(app, chain) {
  const { host: cur, chain: c, custom } = evmPrefs(app, chain);
  const list = RPC_HOSTS[c.key];
  const def = list.find((x) => x.id === DEFAULT_RPC[c.key]);
  return !custom && cur.id === def.id ? list.find((x) => x.id !== cur.id) || null : def;
}

/**
 * The words of a button that moves `chain` to the listed server `alt`. From the person's own server it
 * says what that costs (release audit 0.1.5, S3): the listed one then sees the address they kept from
 * listed servers, and their own server stays saved, a tap away on the chain's screen.
 */
export function useOtherWords(app, chain, alt) {
  const p = evmPrefs(app, chain);
  // With History on, a listed Ethereum server brings Stack Wallet's history index back too (B1).
  if (p.custom) return p.historyHeld ? t('Switch to {name} (it and Stack Wallet\'s index then see your address)', { name: alt.name }) : t('Switch to {name} (it then sees your address)', { name: alt.name });
  return t('Use {name} instead', { name: alt.name });
}

/** "Stack Wallet's Ethereum server", "your Ethereum server (my.node)": who is meant, in words. */
export function serverWho(app, chain) {
  const { host, chain: c, custom } = evmPrefs(app, chain);
  return custom ? t('Your {name} server ({name2})', { name: c.name, name2: host.name }) : t('{name}\'s {name2} server', { name: host.name, name2: c.name });
}

/**
 * The server could not be asked: say who, and offer the ways out: try again, the other server
 * (one tap), or every server of that chain (its screen). Never switches by itself: another
 * server is another party that sees the IP address with the address.
 */
export function serverProblem(app, error, { retry, switched, chain = (error && error.host && error.host.chain) || 'ethereum' }) {
  const { chain: c } = evmPrefs(app, chain);
  const alt = altServer(app, c.key);
  // The server's own words (HTTP codes and the like) stay out of sight, for whoever debugs it.
  return h(
    'div',
    { 'data-testid': 'eth-server-problem', 'data-chain': c.key, title: error && error.message ? error.message : '' },
    notice(
      'error',
      h('strong', { text: error && error.code === 'unusable' ? t('The address saved for your own {name} server can\'t be used any more. ', { name: c.name }) : t('{app} didn\'t answer. ', { app: serverWho(app, c.key) }) }),
      error && error.code === 'unusable' ? t('Nothing was asked of any other server. Pick a {name} server again (or your own, typed again). Your coins are safe on {name}.', { name: c.name }) : t('Your coins are safe on {name}; only this view is out of date.', { name: c.name }),
      h(
        'div',
        { class: 'btn-row prompt-actions' },
        h('button', { class: 'btn btn-secondary btn-small', onclick: retry, 'data-testid': 'eth-retry' }, t('Try again')),
        alt
          ? h('button', {
              class: 'btn btn-text btn-small',
              'data-testid': 'eth-use-other',
              onclick: async () => {
                await useListedEvmServer(app, c.key, alt.id);
                switched(alt);
              },
            }, useOtherWords(app, c.key, alt))
          : null,
        h('button', { class: 'btn btn-text btn-small', 'data-testid': 'eth-all-servers', onclick: () => app.go('ethServers', { chain: c.key }) }, t('All servers')),
      ),
    ),
  );
}

/**
 * The server in use keeps receipts for paying users (lib/eth/rpc.js 'receipts_refused'): this
 * screen cannot show when `chain`'s payment is confirmed. The payment itself is not affected. The
 * way out: another server of that chain (one tap), or all of them (release audit 0.1.5, S1/S2).
 * onSwitched(): after the other server was picked.
 */
// What is waiting, in whole sentences (its word changes its form in other languages).
const RECEIPTS_REFUSED = Object.freeze({
  payment: tk("so this screen can't show when the payment is confirmed. The payment itself is not affected. Pick another {chainName} server to see it settle."),
  permission: tk("so this screen can't show when the permission is confirmed. The permission itself is not affected. Pick another {chainName} server to see it settle."),
  swap: tk("so this screen can't show when the swap is confirmed. The swap itself is not affected. Pick another {chainName} server to see it settle."),
});

export function receiptsRefusedNotice(app, chain, { what = 'payment', testid = 'eth-tx-receipts-refused', onSwitched = null } = {}) {
  const { chain: c } = evmPrefs(app, chain);
  const alt = altServer(app, c.key);
  return h(
    'div',
    { 'data-testid': testid, 'data-chain': c.key },
    notice(
      'warn',
      h('strong', { text: t('{app} doesn\'t say whether a transaction went through, ', { app: serverWho(app, c.key) }) }),
      t(RECEIPTS_REFUSED[what] || RECEIPTS_REFUSED.payment, { chainName: c.name }),
      h(
        'div',
        { class: 'btn-row prompt-actions' },
        alt
          ? h('button', {
              class: 'btn btn-secondary btn-small',
              type: 'button',
              'data-testid': `${testid}-use-other`,
              onclick: async () => {
                await useListedEvmServer(app, c.key, alt.id);
                if (onSwitched) onSwitched(alt);
              },
            }, evmPrefs(app, c.key).custom ? useOtherWords(app, c.key, alt) : t('Use {name}', { name: alt.name }))
          : null,
        h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'eth-tx-pick-server', onclick: () => app.go('ethServers', { chain: c.key }) }, c.key === 'ethereum' ? t('Choose an Ethereum server') : t('Choose a BNB Chain server')),
      ),
    ),
  );
}

/** The status screen of an outbox entry (as Home's activity rows open it). */
export function entryScreen(entry) {
  const key = entryChain(entry);
  const swapLike = entry.kind === 'swap' || entry.kind === 'approve' || entry.kind === 'approveReset';
  return [swapLike && key === 'ethereum' ? 'ethSwapTx' : 'ethTx', { hash: entry.hash, chain: key }];
}

/**
 * A swap paying with `symbol` still on its way (outbox.js openSwapOf): another swap of it waits, so
 * the second never fails on chain with its fee lost (release audit 0.1.6). See it, or look again now.
 */
export function swapOnItsWayNotice(app, w, entry, symbol, { testid = 'swap-on-its-way', rerender = () => {} } = {}) {
  const c = CHAINS[entryChain(entry)];
  const [name, params] = entryScreen(entry);
  const again = h(
    'button',
    {
      class: 'btn btn-text btn-small',
      'data-testid': `${testid}-check`,
      onclick: async () => {
        if (again.disabled) return;
        again.disabled = true;
        again.textContent = t('Checking…');
        // Its entry followed, and the chain read again (its mined count says so even where a server
        // keeps receipts to itself and the entry cannot close).
        await Promise.all([w.followOpen().catch(() => {}), w.refreshChain(entryChain(entry), { fresh: true }).catch(() => {})]);
        rerender();
      },
    },
    t('Check again'),
  );
  return h(
    'div',
    { 'data-testid': testid, 'data-hash': entry.hash },
    notice(
      'info',
      h('strong', { text: t('Your last swap of {symbol} is still on its way. ', { symbol }) }),
      // A swap paying with the chain's own coin (a buy with BNB) fails on nothing: a second one now
      // would be the same swap made twice (release verification 0.1.8).
      entry.token == null
        ? t('Swap {symbol} again once {name} confirms it, usually within seconds: until then a second swap could be the same one made twice.', { symbol, name: c.name })
        : t('Swap {symbol} again once {name} confirms it: a second swap now would count on the same {symbol} and fail on {name}, its network fee lost.', { symbol, name: c.name }),
      h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': `${testid}-see`, onclick: () => app.go(name, params) }, t('See it')), again),
    ),
  );
}

/**
 * A transaction of this wallet whose fate is in doubt (lib/eth/outbox.js inDoubt) holds up every
 * new one on its chain (audit BM-1): which one, why, and the ways out: see it (it updates by
 * itself), or check it with another server. One whose nonce a server calls used can stay so where
 * no listed server shows what took it (release re-audit R-1): then also History from Stack Wallet
 * (Ethereum, when it is off). Never "remove the wallet and add it again": that forgets every guard
 * on this wallet's open transactions (second audit, XR).
 */
export function doubtNotice(app, entry, { testid = 'eth-in-doubt' } = {}) {
  const key = entryChain(entry);
  const c = CHAINS[key];
  const { history } = evmPrefs(app, key);
  const stuck = Boolean(entry.unsureSince);
  const alt = altServer(app, key);
  const [name, params] = entryScreen(entry);
  return h(
    'div',
    { 'data-testid': testid, 'data-hash': entry.hash },
    notice(
      'warn',
      h('strong', { text: t('Not settled yet: {entry} on {name}. ', { entry: entryWords(entry), name: c.name }) }),
      t('Until it is, Firo PWA signs nothing new on {name}: a new transaction could go through together with it. It updates by itself, or another server can check it.', { name: c.name }),
      stuck
        ? h(
            'p',
            { class: 'small', 'data-testid': `${testid}-exits` },
            t('It ends by itself once a second {name} server also shows its place used for good.', { name: c.name }),
            key === 'ethereum' && !history
              ? h('span', {}, ' ', ...tNodes('In {settings}, History from Stack Wallet can find what took its place.', { settings: h('button', { class: 'btn-link', 'data-testid': `${testid}-settings`, onclick: () => app.go('ethSettings') }, t('Settings')) }))
              : null,
          )
        : null,
      h(
        'div',
        { class: 'btn-row prompt-actions' },
        h('button', { class: 'btn btn-secondary btn-small', 'data-testid': `${testid}-see`, onclick: () => app.go(name, params) }, t('See it')),
        alt
          ? h('button', {
              class: 'btn btn-text btn-small',
              'data-testid': `${testid}-other`,
              onclick: async () => {
                await useListedEvmServer(app, key, alt.id);
                app.go(name, params);
              },
            }, evmPrefs(app, key).custom ? useOtherWords(app, key, alt) : t('Check it with {name}', { name: alt.name }))
          : null,
      ),
    ),
  );
}

const STATE_TEXT = {
  signed: tk('Sending'),
  pending: tk('Waiting for the network'),
  confirmed: null,
  failed: tk('Failed'),
  replaced: tk('Replaced'),
  rejected: tk('Not sent'),
};

/** A Uniswap swap's or approval's title in the activity list, or null for a payment. */
function swapTitle(item) {
  const open = item.state === 'signed' || item.state === 'pending';
  const failed = item.state === 'failed' || item.state === 'replaced' || item.state === 'rejected';
  if (item.kind === 'swap') {
    const to = item.swapOut || t('a token');
    return open ? t('Swapping to {to}', { to }) : failed ? t('Swap not done') : t('Swapped to {to}', { to });
  }
  if (item.kind === 'approve') return open ? t('Allowing {symbol}', { symbol: item.asset.symbol }) : failed ? t('{symbol} not allowed', { symbol: item.asset.symbol }) : t('Allowed {symbol}', { symbol: item.asset.symbol });
  if (item.kind === 'approveReset') return t('Reset the {symbol} permission', { symbol: item.asset.symbol });
  // A payment another feature asked for (lib/eth/send_raw.js): its own words.
  if (item.kind === 'raw' && item.label) return open ? t('{label} (sending)', { label: item.label }) : failed ? t('{label}: not done', { label: item.label }) : item.label;
  return null;
}

/** Which chain a row is on, and its swap venue. */
const chainWord = (item) => CHAINS[item.chain || 'ethereum'].name;
const venue = (item) => (item.chain === 'bsc' ? 'PancakeSwap' : 'Uniswap');

/** One row of the activity list (Ethereum and BNB Chain together; each row names its chain). */
export function activityRow(item, onclick) {
  const open = item.state === 'signed' || item.state === 'pending';
  const bad = item.state === 'failed' || item.state === 'replaced' || item.state === 'rejected';
  // Open but in doubt (lib/eth/history.js): its nonce said used with nothing shown, or its bytes refused.
  const doubt = item.doubt === 'unsure' ? t('Not sure yet') : item.doubt === 'refused' ? t('Not sent yet') : null;
  const title =
    (doubt && item.kind === 'raw' && item.label ? `${item.label}: ${doubt.toLowerCase()}` : doubt) ||
    swapTitle(item) ||
    (STATE_TEXT[item.state] && t(STATE_TEXT[item.state])) ||
    (item.direction === 'in' ? t('Received {symbol}', { symbol: item.asset.symbol }) : item.direction === 'self' ? t('Sent {symbol} to yourself', { symbol: item.asset.symbol }) : t('Sent {symbol}', { symbol: item.asset.symbol }));
  const when = item.at ? fmtDate(Math.floor(item.at / 1000)) : null;
  const who = item.counterparty ? h('span', { class: 'nowrap', text: `${item.direction === 'in' ? 'from' : 'to'} ${shortAddress(item.counterparty)}` }) : null;
  const sub = [when, when && who ? ' · ' : null, who, ` · ${chainWord(item)}`].filter(Boolean);
  const sign = item.direction === 'in' ? '+' : '−';
  if (item.kind === 'approve' || item.kind === 'approveReset') {
    return h(
      'button',
      { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state, 'data-kind': item.kind, 'data-chain': item.chain || 'ethereum' },
      h('span', { class: `ico ${bad ? 'fail' : 'swap'}` }, icon(open ? 'clock' : 'check')),
      h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's addr', text: when ? t('{when} · for {item}', { when, item: venue(item) }) : t('For {item}', { item: venue(item) }) })),
      h('span', { class: 'end small', title: amountText(item.amount, item.asset), text: item.kind === 'approve' ? `${compactUnits(item.amount, item.asset.decimals)} ${item.asset.symbol}` : '' }),
    );
  }
  if (item.kind === 'swap') {
    return h(
      'button',
      { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state, 'data-kind': 'swap', 'data-chain': item.chain || 'ethereum' },
      h('span', { class: `ico ${bad ? 'fail' : 'swap'}` }, icon(open ? 'clock' : 'swap')),
      h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's addr', text: when ? `${when} · ${venue(item)}` : venue(item) })),
      h('span', { class: 'end', title: amountText(item.amount, item.asset), text: `−${compactUnits(item.amount, item.asset.decimals)} ${item.asset.symbol}` }),
    );
  }
  return h(
    'button',
    { class: 'row', onclick, 'data-testid': 'eth-activity-row', 'data-hash': item.hash, 'data-state': item.state, 'data-chain': item.chain || 'ethereum' },
    h('span', { class: `ico ${bad ? 'fail' : item.direction === 'in' ? 'in' : 'out'}` }, icon(open ? 'clock' : item.direction === 'in' ? 'receive' : 'send')),
    h('span', { class: 'main' }, h('div', { class: 't', text: title }), h('div', { class: 's addr' }, ...sub)),
    h('span', { class: `end${item.direction === 'in' && !bad ? ' in' : ''}`, text: `${sign}${amountText(item.amount, item.asset)}` }),
  );
}

