// What a scanned QR code (or a pasted text) is, and so where it goes (Home's Scan, screens/scan_go.js).
//
//   firo         a Firo address (Spark "sm1…", transparent "a…", exchange "EX…"), or a "firo:" link,
//                with its amount (as the amount field holds it, "1.5") and its memo when the link
//                carries valid ones                                         -> Send (FIRO)
//   name         a Spark name, "@alice" (or "firo:@alice")                  -> Send (FIRO), name looked up
//   eth          an Ethereum address, or an EIP-681 "ethereum:" link on Ethereum mainnet (chain 1),
//                with its value in wei when it is a whole number, and the token of a "/transfer" link
//                                                                            -> Send (Ethereum)
//   unsupported  a link of BNB Chain (bsc: no BNB Chain wallet here yet), another chain (chain),
//                another coin (coin), or a web link (link): said, never opened
//   unknown      anything else: shown as text, nothing done with it
//   empty
// Pure. Nothing is looked up or opened here: an address is checked again by the screen it goes to
// (the Firo engine's own validation, the Ethereum checksum), and a web link is never followed.

import { formatAmount } from './amount.js';
import { addressShape, normalizeAddress, parseFiroUri, sparkNameOf } from './firo_uri.js';

const ETH_ADDR = /^0x[0-9a-fA-F]{40}$/;
const BSC_CHAIN = '56';

/** A wei amount from EIP-681's number ("1000", "2.014e18"), as a decimal string; null unless whole and positive. */
export function weiOf(text) {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE](\d{1,3}))?$/.exec(String(text || ''));
  if (!m) return null;
  const frac = m[2] || '';
  const exp = Number(m[3] || 0);
  if (frac.length > exp && /[1-9]/.test(frac.slice(exp))) return null;
  const digits = `${m[1]}${frac.slice(0, exp).padEnd(exp, '0')}`;
  const v = BigInt(digits);
  return v > 0n ? v.toString() : null;
}

function ethLink(rest) {
  // ethereum:<target>[@chain][/function]?params (EIP-681)
  const m = /^(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([A-Za-z]+))?(?:\?(.*))?$/.exec(rest);
  if (!m) return { kind: 'unknown' };
  if (m[2] === BSC_CHAIN) return { kind: 'unsupported', reason: 'bsc' };
  if (m[2] && m[2] !== '1') return { kind: 'unsupported', reason: 'chain' };
  const q = new URLSearchParams(m[4] || '');
  if (m[3]) {
    if (m[3] !== 'transfer') return { kind: 'unknown' };
    const to = q.get('address');
    return to && ETH_ADDR.test(to) ? { kind: 'eth', to, token: m[1] } : { kind: 'unknown' };
  }
  const wei = q.has('value') ? weiOf(q.get('value')) : null;
  return wei ? { kind: 'eth', to: m[1], valueWei: wei } : { kind: 'eth', to: m[1] };
}

function firoLink(s) {
  const u = parseFiroUri(s);
  if (u && u.required) return { kind: 'unsupported', reason: 'requires', what: u.required };
  if (!u || !u.shape) return { kind: 'unknown' };
  if (u.shape === 'spark-name') return { kind: 'name', name: sparkNameOf(u.address) };
  const out = { kind: 'firo', address: u.address, shape: u.shape };
  if (u.amount != null) out.amount = formatAmount(u.amount, { group: false });
  if (u.memo) out.memo = u.memo;
  return out;
}

/** The scanned text's meaning (see the table above). */
export function recognize(raw) {
  let s = String(raw ?? '').trim();
  const nl = s.search(/[\r\n]/);
  if (nl >= 0) s = s.slice(0, nl).trim();
  if (!s) return { kind: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(s);
  if (scheme && !ETH_ADDR.test(s)) {
    const sch = scheme[1].toLowerCase();
    if (sch === 'firo') return firoLink(s);
    if (sch === 'ethereum') return ethLink(scheme[2]);
    if (sch === 'http' || sch === 'https') return { kind: 'unsupported', reason: 'link' };
    return { kind: 'unsupported', reason: 'coin' };
  }
  if (ETH_ADDR.test(s)) return { kind: 'eth', to: s };
  const shape = addressShape(s);
  if (shape === 'spark-name') return { kind: 'name', name: sparkNameOf(s) };
  if (shape) return { kind: 'firo', address: normalizeAddress(s), shape };
  return { kind: 'unknown' };
}
