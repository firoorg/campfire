// What a server check (lib/evm_server_check.js) means, in words, for the Ethereum / BNB Chain server
// screen: one short line per server, compared with the best of the others ("behind"), and the
// sentence that says why a person's own server was not saved. Also the checks of the listed
// servers from the page (their origins are in every page's policy).

import { rpcCaller, checkEvmServer, EVM_CHECK_TIMEOUT_MS } from '../evm_server_check.js';
import { rpcHostsFor, rpcUrl } from './hosts.js';
import { chainOf } from './chains.js';
import { t, tn } from '../i18n.js';

/** A server more blocks than this below the best one seen counts as behind (about a minute on Ethereum, half a minute on BNB Chain). */
export const BEHIND_BLOCKS = Object.freeze({ ethereum: 5, bsc: 40 });

/** "120 ms", "1.4 s": a number and its unit on one line. */
export function speedText(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? t('{ms} ms', { ms: Math.round(ms) }) : `${(ms / 1000).toFixed(1)} s`;
}

/** "3 min", "2 h": how old a block is. */
export function ageText(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 5400) return t('{n} min', { n: Math.round(s / 60) });
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return t('{n} days', { n: Math.round(s / 86400) });
}

/** The highest block any of `results` (check reports on the right chain) gave, or null. */
export function bestHead(results) {
  let best = null;
  for (const r of results) if (r && r.chainId != null && r.head != null && (r.problem !== 'wrong_chain') && (best === null || r.head > best)) best = r.head;
  return best;
}

/** How many blocks `r` is below `best`, or null when either is unknown. */
export function lagOf(r, best) {
  return r && r.head != null && best != null ? Math.max(0, best - r.head) : null;
}

const SHORT = {
  unreachable: () => t('Not answering'),
  timeout: () => t('Too slow to answer'),
  busy: () => t('Busy: too many requests right now'),
  bad_answer: () => t("Answers in a way Firo PWA can't read"),
  wrong_chain: (c) => t('Not a {name} server', { name: c.name }),
  receipts_refused: () => t("Doesn't say whether payments went through"),
  receipts_missing: () => t("Couldn't show a recent payment"),
  receipts_error: () => t("Couldn't show a recent payment"),
  no_transactions: () => t('Showed no recent payment to check with'),
  call_failed: () => t("Can't read token balances or prices"),
};

/**
 * One server's line: {cls: 'ok' | 'bad' | 'wait', text, usable}. r: its check report (or
 * {state: 'checking'} / null); best: bestHead() of every report on screen. usable: worth offering
 * "Use this one" (answers, on its chain, keeping up, confirms payments).
 */
export function checkLine(r, { chain, best = null } = {}) {
  const c = chainOf(chain);
  if (!r) return { cls: 'wait', text: t('Not checked yet'), usable: true };
  if (r.state === 'checking') return { cls: 'wait', text: t('Checking…'), usable: true };
  const behind = BEHIND_BLOCKS[c.key];
  const lag = lagOf(r, best);
  if (r.problem === 'stale') return { cls: 'bad', text: t('Behind: its newest block is {amount} old', { amount: ageText(r.headAge) }), usable: false };
  if (r.problem && SHORT[r.problem]) return { cls: 'bad', text: SHORT[r.problem](c), usable: false };
  if (!r.ok) return { cls: 'bad', text: SHORT.bad_answer(c), usable: false };
  const block = r.head.toLocaleString('en-US');
  if (lag !== null && lag > behind) return { cls: 'bad', text: tn({ one: 'Behind by {n} block · {speed}', other: 'Behind by {n} blocks · {speed}' }, lag, { n: lag.toLocaleString('en-US'), speed: speedText(r.ms) }), usable: false };
  return { cls: 'ok', text: t('Block {block} · {amount} · confirms payments', { block, amount: speedText(r.ms) }), usable: true };
}

/**
 * Why a person's own server was not saved, in one or two sentences (never blaming them), or null
 * when the report is fine. chain: its key.
 */
export function ownServerProblem(r, chain) {
  const c = chainOf(chain);
  if (!r) return t(`Firo PWA could not check it. Try again in a moment.`);
  if (r.ok) return null;
  switch (r.problem) {
    case 'unreachable':
      return t(`Firo PWA could not reach it. Check that the address is right and the server is running, and that it accepts requests from web pages (its CORS setting must allow them).`);
    case 'timeout':
      return t('It did not answer in time. Check that it is running and reachable from this device, then try again.');
    case 'busy':
      return t('It said it is too busy (too many requests). Try again in a minute.');
    case 'wrong_chain':
      return t('It is not a {name} server: it answered for chain {chainId}, and {name} is chain {chainId2}.', { name: c.name, chainId: r.chainId, chainId2: c.chainId });
    case 'stale':
      return t('Its newest block is {amount} old, so it is not keeping up with {name}: balances and payments would show late. Use it once it has caught up.', { amount: ageText(r.headAge), name: c.name });
    case 'receipts_refused':
      return t(`It doesn't say whether a payment went through (it keeps that for paying users), so Firo PWA could never show your payments confirmed.`);
    case 'receipts_missing':
    case 'receipts_error':
      return t(`It could not show a recent payment's outcome, so Firo PWA could not show yours confirmed. A full node with its transaction index on answers this.`);
    case 'no_transactions':
      return t('It showed no payment in its newest blocks to check with. A {name} server that keeps up has some in every few blocks.', { name: c.name });
    case 'call_failed':
      return t(`It could not run a contract call, which Firo PWA needs to read token balances and swap prices.`);
    default:
      return t('It answers in a way Firo PWA can\'t read. Check that it is a {name} JSON-RPC server.', { name: c.name });
  }
}

/**
 * Every listed server of `chain` checked at once, from this page (their origins are in its policy):
 * onResult(entry, report) as each answers. Resolves when all have. Each sees the IP address and
 * these questions, never the wallet's address.
 */
export async function checkListedServers(chain, { onResult, fetch: fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = EVM_CHECK_TIMEOUT_MS, hosts = rpcHostsFor(chain) } = {}) {
  const c = chainOf(chain);
  await Promise.all(
    hosts.map(async (h) => {
      const report = await checkEvmServer(rpcCaller(fetchImpl, rpcUrl(h), { timeoutMs }), { chainId: c.chainId });
      if (onResult) onResult(h, report);
      return report;
    }),
  );
}

/** One server (listed, or the person's own once this page's policy names it), checked from this page. Rejects (never throws) for one that has no address. */
export async function checkServerHere(entry, { fetch: fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = EVM_CHECK_TIMEOUT_MS } = {}) {
  return checkEvmServer(rpcCaller(fetchImpl, rpcUrl(entry), { timeoutMs }), { chainId: chainOf(entry.chain).chainId });
}
