// Everything around a payment that is not the payment itself: where to look it up, and its Spark
// memo as it may be shown. Pure: no DOM, no engine.
//
// Block explorers are links the person taps, never fetched by the app (they are not in the
// page's connect-src). Hosts are written without their scheme and joined in originOf(), as
// lib/eth/hosts.js does, so the "no source file reaches out to another origin" check in
// test/unit/config.test.mjs keeps flagging literal URLs elsewhere.
//
// Checked 2026-10-12 with a real mainnet txid (2b30e1ab…7493687, block 1393022):
//   - explorer.firo.org is Firo's own Insight explorer (AngularJS). Its server answers 404 for
//     /tx/<id> (no fallback to the app for deep links), but the hashbang route /#!/tx/<id> loads the
//     app, which shows the transaction (headless Chrome: the page rendered the txid, size, fee and
//     block). That is the default.
//   - chainz.cryptoid.info/firo/tx.dws?<id>.htm answers 200 with the transaction (curl). A third
//     party; offered as the other choice.
// Settings → Block explorer stores the choice in prefs.explorer (an id below).

const SCHEME = 'https:';

export const EXPLORERS = Object.freeze(
  [
    { id: 'firo', name: 'Firo Explorer', host: 'explorer.firo.org', tx: (id) => `/#!/tx/${id}`, address: (a) => `/#!/address/${a}` },
    { id: 'chainz', name: 'Chainz (cryptoID)', host: 'chainz.cryptoid.info', tx: (id) => `/firo/tx.dws?${id}.htm`, address: (a) => `/firo/address.dws?${a}.htm` },
  ].map((e) => Object.freeze(e)),
);

export const DEFAULT_EXPLORER = 'firo';

/** The explorer with this id, or the default one for anything unknown. */
export function explorerById(id) {
  return EXPLORERS.find((e) => e.id === id) || EXPLORERS.find((e) => e.id === DEFAULT_EXPLORER);
}

export function originOf(entry) {
  return `${SCHEME}//${entry.host}`;
}

/** Where a Firo transaction is shown (a link only). Throws for anything that is not a txid. */
export function txExplorerUrl(txid, explorerId = DEFAULT_EXPLORER) {
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) throw new Error('not a transaction ID');
  const e = explorerById(explorerId);
  return `${originOf(e)}${e.tx(txid.toLowerCase())}`;
}

/** Where a public Firo address is shown (transparent or exchange; a Spark address is private and has no page). */
export function addressExplorerUrl(address, explorerId = DEFAULT_EXPLORER) {
  if (typeof address !== 'string' || !/^(EX|[aZ])[1-9A-HJ-NP-Za-km-z]{30,40}$/.test(address)) throw new Error('not a public Firo address');
  const e = explorerById(explorerId);
  return `${originOf(e)}${e.address(address)}`;
}

/** The explorer's name for a link's words ("Open in Firo Explorer"). */
export const explorerName = (explorerId = DEFAULT_EXPLORER) => explorerById(explorerId).name;

/** A Spark memo's size: bytes of UTF-8, as the Spark library counts them (lib/wallet.js SPARK_MEMO_MAX). */
export const MEMO_MAX = 31;

/** A memo's size in UTF-8 bytes (a letter outside English takes 2 to 4). */
export const memoBytes = (s) => new TextEncoder().encode(String(s ?? '')).length;

/**
 * A memo as it may be shown or sent: printable characters only (no line breaks, no control or
 * direction characters, which could make a memo pose as other text), single spaces, at most
 * `maxBytes` UTF-8 bytes, cut between characters (public audit, PN: counted in characters, a memo
 * of 31 letters outside English was two to four times what the library takes). A received memo was
 * written by someone else: shown as text, never as a link or markup (the screens use textContent).
 */
export function cleanMemo(raw, maxBytes = MEMO_MAX) {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = memoBytes(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out.trimEnd();
}
