// Payment history as a CSV file (Activity → "Save as CSV"): one row per payment the wallet knows
// (lib/wallet.js state.txs), newest first, for a spreadsheet or the person's accountant.
//
// Columns: when, what it was, which balance (private, public, or public → private), the amount,
// the network fee, the net change to the wallet, its value in the person's currency at today's
// price (only when prices are on and a price is known; the column says which day), the Spark memo,
// the other side's address (when the wallet knows it), its state, the block, the transaction ID.
//   - every field is quoted as RFC 4180 says when it needs to be (a memo may hold a comma);
//   - a memo or address that a spreadsheet would run as a formula starts with an apostrophe (P15);
//   - the file starts with a UTF-8 byte order mark, so Excel reads a memo's non-Latin letters;
//   - amounts in FIRO with a dot and no thousands separators; dates "11 Oct 2026 | 12:08" in this
//     device's time zone.
// Pure except saveCsv, which hands the file to the share sheet or the downloads.

import { formatAmount } from './amount.js';
import { t, tk } from './i18n.js';

// English month names in every language: the file is data for a spreadsheet, which reads them.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; // i18n-ignore: a spreadsheet's date format
const PRIVATE_KINDS = new Set(['spark', 'spark-name', 'lelantus']);

export const CSV_HEADER = Object.freeze(['Date | Time', 'Type', 'Balance', 'Amount, FIRO', 'Fee, FIRO', 'Net change, FIRO', 'Memo', 'Address', 'Status', 'Block', 'Transaction ID']); // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)

/** One field: quoted when it holds a comma, a quote, a line break or leading / trailing space. */
export function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Text that came from someone else (a memo a sender wrote, an address or name): a spreadsheet runs a
 * field starting with = + - @ or a tab as a formula, so a memo like =HYPERLINK(...) would run on the
 * person's computer when they open the file (public audit, P15). Such text starts with an
 * apostrophe here, which spreadsheets show as plain text.
 */
export function csvText(v) {
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** "11 Oct 2026 | 12:08", in this device's time zone. */
export function csvDate(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} | ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};
const plain = (sats) => formatAmount(sats, { group: false });
const confirmed = (item) => Number(item.confirmations) >= 1;

/** What a payment was, in words (the same words as Activity, without "…ing"). */
export function typeWords(item) {
  if (item.kind === 'privatize') return 'Privatized'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
  if (item.kind === 'spark-name') return 'Spark name registration'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
  if (item.direction === 'self') return 'Sent to yourself'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
  if (item.direction === 'in') {
    if (item.kind === 'coinbase') return 'Mining reward'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
    if (item.kind === 'masternode') return 'Masternode payment'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
    if (item.kind === 'lelantus') return 'Moved from Lelantus'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
    return 'Received'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
  }
  return 'Sent'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
}

/** Which balance it touched: Private, Public, or Public → Private. */
export function balanceWords(item) {
  if (item.kind === 'privatize') return 'Public → Private'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
  return PRIVATE_KINDS.has(item.kind) ? 'Private' : 'Public'; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
}

/** The change to the wallet in sats: + what came in; − what went out and its fee; − the fee of a move inside it. */
export function netChange(tx) {
  const amount = big(tx.amount);
  const fee = big(tx.fee);
  if (tx.direction === 'in') return amount;
  if (tx.direction === 'out') return -(amount + fee);
  return -fee;
}

/** sats × price, as the currency's plain number with 2 decimals, rounded half up; '' without a price. */
export function fiatAmount(sats, price) {
  if (!(Number.isFinite(price) && price > 0)) return '';
  // Exact enough for a statement: price in hundredths of a cent.
  const p = BigInt(Math.round(price * 1e4));
  const v = big(sats);
  const neg = v < 0n;
  const num = (neg ? -v : v) * p; // sats × (currency × 1e4)
  const den = 100000000n * 100n; // → hundredths of the currency
  const cents = (num + den / 2n) / den;
  const s = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  return neg && cents > 0n ? `-${s}` : s;
}

/**
 * The file as text, with a byte order mark and CRLF line ends. price: {price, currency, at} or null
 * (lib/fiat.js); with one, a column of each row's net change in that currency at that price.
 */
export function buildCsv(txs, { price = null } = {}) {
  const fiat = price && Number.isFinite(price.price) && price.price > 0 && /^[A-Z]{3}$/.test(String(price.currency || ''));
  const day = fiat ? new Date(price.at || Date.now()).toISOString().slice(0, 10) : null;
  const head = [...CSV_HEADER];
  const header = fiat ? [...head.slice(0, 6), `Net change, ${price.currency} (price of ${day})`, ...head.slice(6)] : head; // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
  const rows = [header];
  // A payment that did not go through (the network does not have it) moved nothing: not listed.
  const list = (txs || []).filter((tx) => tx && tx.txid && !tx.dropped).sort((a, b) => Number(b.time) - Number(a.time));
  for (const tx of list) {
    const net = netChange(tx);
    const row = [
      csvDate(tx.time),
      typeWords(tx),
      balanceWords(tx),
      plain(big(tx.amount)),
      plain(big(tx.fee)),
      plain(net),
      csvText(tx.memo || ''),
      csvText(tx.counterparty || ''),
      confirmed(tx) ? `Confirmed (${Number(tx.confirmations)})` : 'Waiting for confirmation', // i18n-ignore: the file is data, English in every language (spreadsheets and tax tools read it)
      tx.height == null ? '' : String(tx.height),
      tx.txid,
    ];
    if (fiat) row.splice(6, 0, fiatAmount(net, price.price));
    rows.push(row);
  }
  return `﻿${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** "campfire-firo-payments-2026-10-11.csv" (with the wallet's name when there are several). */
export function csvFileName(now = new Date(), walletName = null) {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const w = walletName ? `-${String(walletName).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)}` : '';
  return `campfire-firo-payments${w}-${d}.csv`;
}

/**
 * Activity's "Save as CSV": the open wallet's payments, its name in the file name when this
 * device has several wallets, and a value column only when prices are on and one is known (no
 * request is made here). Resolves what happened: 'shared' | 'downloaded' | 'cancelled' | 'empty'.
 */
export async function saveCsv(app, { now = new Date() } = {}) {
  const txs = (app && app.wallet && app.wallet.state && app.wallet.state.txs) || [];
  if (!txs.length) return 'empty';
  const [{ listWallets, nameOf }, { firoPrice }, { deliverExport }] = await Promise.all([import('./wallets.js'), import('./fiat.js'), import('./export.js')]);
  let walletName = null;
  try {
    if ((await listWallets()).length > 1) walletName = nameOf(app.record);
  } catch {
    walletName = null;
  }
  const price = firoPrice(app).current();
  const text = buildCsv(txs, { price });
  const file = new File([text], csvFileName(now, walletName), { type: 'text/csv' });
  return deliverExport(file, { title: t('Firo PWA payments') });
}
