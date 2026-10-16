// A swap's price, asked again of a second listed server for its chain before the review.
//
// A swap's least-acceptable amount is the chosen server's quote less the price protection, and
// that quote is an eth_call the chosen server answers (Uniswap's quoters, PancakeSwap's QuoterV2,
// the pools' prices behind the "price change"). A server that answers low makes the minimum low,
// and the router then lets the swap through at a price that bad: the difference can be taken by
// whoever trades around it. So the same swap is priced once more on another server of the list,
// and when the two differ by more than PRICE_GAP the review says so and asks for a tick.
//
// What the second server sees: the browser's IP address and an eth_call of a quoter for this
// pair and amount, with no `from`; never this wallet's address, and nothing is sent through it.
// (Which is why only the price is asked there: everything about the account stays with the
// person's own server, lib/eth/rpc.js.) When no other server answers, the review says the price
// was not compared and waits for a tick: the person's server alone is never trusted silently.
//
// The second server is always a listed one (lib/eth/hosts.js), in list order, the first SECOND_TRIES
// other than the one in use. With the person's own server in use (id CUSTOM_RPC, which no listed
// server has) that is the first SECOND_TRIES of the list: a server they added is never its own
// second opinion, and a listed one still sees no address.

import { rpcHostsFor } from './hosts.js';
import { EthRpc } from './rpc.js';

/** Two servers' amounts out for the same swap may differ by this much before the person is asked to look: 2 %. */
export const PRICE_GAP = 0.02;
/** How many other servers are tried before the price is left uncompared. */
export const SECOND_TRIES = 2;
/** How long one try may take in all (a Uniswap route is a few requests), so a slow server cannot hold up the review. */
export const SECOND_TIMEOUT_MS = 10000;

/** The listed servers of `chainKey` other than `chosenId` (every one of them when it is the person's own server), in list order. */
export function otherServers(chainKey, chosenId) {
  return rpcHostsFor(chainKey).filter((h) => h.id !== chosenId);
}

/**
 * `mine` (what the chosen server quoted) against `theirs` (another server, the same swap):
 * gap = mine / theirs - 1 (below 0 when the chosen server gives less); agree when |gap| <= tolerance.
 */
export function compareOut(mine, theirs, tolerance = PRICE_GAP) {
  const a = BigInt(mine);
  const b = BigInt(theirs);
  if (a <= 0n || b <= 0n) return { gap: null, agree: false };
  // In parts per million, exactly, then as a fraction.
  const gap = Number(((a - b) * 1000000n) / b) / 1e6;
  return { gap, agree: Math.abs(gap) <= tolerance };
}

/**
 * The same swap priced on another listed server: quoteOn(rpc) -> its amount out (bigint), for
 * the first other server that answers (at most `tries`). Resolves (never rejects) to
 * {status: 'agree' | 'differ' | 'unchecked', host (the server asked, or null), mine, theirs, gap}.
 */
export async function secondOpinion({ chainKey, chosenId, mine, quoteOn, tries = SECOND_TRIES, timeoutMs = SECOND_TIMEOUT_MS, makeRpc = (h) => new EthRpc(h, { timeoutMs }) }) {
  for (const host of otherServers(chainKey, chosenId).slice(0, tries)) {
    let theirs;
    let timer = null;
    try {
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });
      theirs = await Promise.race([quoteOn(makeRpc(host)), late]);
    } catch {
      continue; // that server did not answer in time, or could not price it: the next one
    } finally {
      clearTimeout(timer);
    }
    if (typeof theirs !== 'bigint' || theirs <= 0n) continue;
    const { gap, agree } = compareOut(mine, theirs);
    return Object.freeze({ status: agree ? 'agree' : 'differ', host, mine: BigInt(mine), theirs, gap });
  }
  return Object.freeze({ status: 'unchecked', host: null, mine: BigInt(mine), theirs: null, gap: null });
}

/** Whether a review must wait for the person's tick before swapping: unless a second server agreed (P13). */
export function priceAckNeeded(check) {
  return !check || check.status !== 'agree';
}

/**
 * What the review says about it → {kind: 'ok' | 'warn' | 'info', text, ack (the tick's words, when
 * one is needed)}. `server`: the name of the person's server; `amount(v)`: an amount out in words.
 */
export function secondOpinionWords(check, { server, amount }) {
  // Unchecked: the minimum rests on one server's price, so the swap waits for a tick, as when the
  // two disagree (public audit, P13).
  if (!check || check.status === 'unchecked')
    return {
      kind: 'warn',
      text: `Only your server (${server}) priced this swap: no second server answered to compare it with. Your minimum comes from its price alone: if that price is too low, so is your minimum, and the swap could go through at it.`,
      ack: `Swap at ${server}'s price alone`,
    };
  const other = check.host.name;
  if (check.status === 'agree') return { kind: 'ok', text: `Price checked with a second server (${other}).`, ack: null };
  const p = Math.abs(check.gap) * 100;
  const pct = `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
  const lower = check.gap < 0;
  return {
    kind: 'warn',
    text: lower
      ? `Your server (${server}) prices this swap ${pct} lower than ${other} does: ${amount(check.mine)} against ${amount(check.theirs)}. A price that is too low lowers your minimum, and the swap could then go through at that worse price. Try again in a minute, or pick another server in Settings.`
      : `Your server (${server}) prices this swap ${pct} higher than ${other} does: ${amount(check.mine)} against ${amount(check.theirs)}. One of them is wrong; if it is yours, the swap will most likely be refused and only the network fee spent. Try again in a minute, or pick another server in Settings.`,
    ack: `Swap anyway at ${server}'s price`,
  };
}
