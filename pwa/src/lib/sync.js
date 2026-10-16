// The one place "synced" is decided, from the engine's state (WALLET_API.md getState()).
//
// "Synced" - and with it, permission to send - needs all of:
//   1. a server connection now (connected), after the engine said so in this session;
//   2. the engine's sync phase is 'done' (transparent history, Spark coin sets, spent tags and
//      this wallet's own Spark coins all read);
//   3. the tip the server gave is under MAX_TIP_AGE old by this device's clock. Firo makes a
//      block about every 5 minutes; a tip older than this means the server is stuck or behind;
//   4. no other Firo server shows a different chain (the engine's serverCheck, audit D-11), or
//      other coins spent (serverCheck.about 'spent', audit D-12).
// No second server to ask at all for RULES.noSecondSyncs syncs (serverCheck.noSecondSyncs) is said
// on the sync line, sending still allowed: payments to this wallet wait to be proven meanwhile.
// Anything else says what is happening, how far along, and that sending waits. No height
// constant ever grants "synced". Pure: same inputs, same answer.

export const RULES = Object.freeze({
  // Long gaps between Firo blocks happen; over 90 minutes they are rare enough to say so.
  maxTipAgeSec: 90 * 60,
  // A connection lost for longer than this is "offline", not "reconnecting".
  reconnectGraceSec: 20,
  // Firo's block time since its stage 3 (2022): 2.5 minutes (P18).
  blockSec: 150,
  // Syncs in a row with no second Firo node to ask before the sync line says so (release re-audit 3
  // RE3-2: incoming public payments are proven with a second node, and wait for one meanwhile).
  noSecondSyncs: 3,
});

/** The sync line's words while no second Firo node can be reached (sending stays allowed). */
export const NO_SECOND_WORDS = 'No second Firo node could be reached: incoming public payments wait until one can.';

// How far along each phase is, as a share of the whole sync (the Spark coin sets are most of it).
const PHASES = Object.freeze({
  connecting: { from: 0, to: 0, words: 'Connecting to a Firo node' },
  transparent: { from: 0, to: 20, words: 'Reading your public payments' },
  'spark-sets': { from: 20, to: 70, words: 'Downloading private coin sets' },
  'spark-tags': { from: 70, to: 85, words: 'Checking which private coins are spent' },
  'spark-identify': { from: 85, to: 100, words: 'Finding your private payments' },
});

/** "Finding your private payments": what a phase is doing, in words. */
export function phaseWords(phase) {
  return (PHASES[phase] && PHASES[phase].words) || 'Catching up with the network';
}

/** 0-100 over the whole sync, or null when nothing can be said yet. */
export function syncPercent(sync) {
  const p = sync && PHASES[sync.phase];
  if (!p || p.to === 0) return null;
  const frac = sync.total > 0 ? Math.max(0, Math.min(1, sync.done / sync.total)) : 0;
  return Math.floor(p.from + (p.to - p.from) * frac);
}

/** "electrumx01.firo.org" from "wss://electrumx01.firo.org:50004". */
export function serverHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || '');
  }
}

/**
 * @param {object} p
 * @param {object|null} p.raw            the engine's getState(), or null before it started
 * @param {boolean} p.everConnected      the engine reported a server connection in this session
 * @param {number|null} p.lostAt         unix seconds the connection went away (null: not lost)
 * @param {number} p.now                 unix seconds
 */
export function assessSync({ raw, everConnected = false, lostAt = null, now }) {
  const tip = raw && raw.tip ? raw.tip : null;
  const height = tip ? Number(tip.height) || 0 : 0;
  const tipAge = tip && tip.time ? now - Number(tip.time) : null;
  const base = { height, canSend: false, verified: false, percent: null, tipAgeSec: tipAge, phase: raw && raw.sync ? raw.sync.phase : null, server: raw ? raw.server : null };
  const offline = (detail) => ({ ...base, state: 'offline', title: "Can't reach the Firo network", detail: `${detail || 'Check your internet connection.'} Sending is paused until it is back.` });

  if (!raw) return { ...base, state: 'connecting', title: 'Connecting…', detail: 'Reaching a Firo node.' };
  const sync = raw.sync || { phase: 'connecting', done: 0, total: 0 };
  if (sync.phase === 'error') return offline(sync.error);
  if (!raw.connected) {
    if (everConnected && lostAt != null && now - lostAt > RULES.reconnectGraceSec) return offline('The Firo node stopped answering. The app keeps trying.');
    if (everConnected) return { ...base, state: 'connecting', reconnecting: true, title: 'Reconnecting…', detail: 'The Firo node went quiet; trying another. Sending is paused for a moment.' };
    return { ...base, state: 'connecting', title: 'Connecting…', detail: 'Reaching a Firo node.' };
  }
  if (sync.phase !== 'done') {
    const percent = syncPercent(sync);
    return { ...base, state: 'syncing', percent, title: 'Catching up with the network', detail: `${phaseWords(sync.phase)}. Sending is paused until your wallet is up to date.` };
  }
  // Another Firo server tells a different chain (or is well ahead): this one is not believed.
  // Or the same chain, but not the same coins spent (audit D-12).
  if (raw.serverCheck && raw.serverCheck.state === 'disagree' && raw.serverCheck.about === 'spent') {
    return { ...base, state: 'disagree', title: 'Another Firo node disagrees with yours', detail: `Your node (${serverHost(raw.server)}) and another Firo node do not agree on which private coins are already spent. Sending is paused; choose another Firo node.` };
  }
  if (raw.serverCheck && raw.serverCheck.state === 'disagree') {
    return { ...base, state: 'disagree', title: 'Another Firo node disagrees with yours', detail: `Your node (${serverHost(raw.server)}) does not show the same newest blocks as another Firo node. Sending is paused; choose another Firo node.` };
  }
  if (tipAge != null && tipAge > RULES.maxTipAgeSec) {
    const behind = Math.round(tipAge / RULES.blockSec);
    return { ...base, state: 'behind', behindBlocks: behind, title: `About ${behind.toLocaleString('en-US')} blocks behind`, detail: `The node's newest block is ${ageText(tipAge)}. Sending is paused; if this lasts, choose another Firo node.` };
  }
  // No second node to ask for a while: payments to this wallet wait unproven (audit FE-1, R1-3).
  const noSecond = Boolean(raw.serverCheck && raw.serverCheck.state === 'unknown' && raw.serverCheck.noSecondSyncs >= RULES.noSecondSyncs);
  return {
    ...base,
    state: 'synced',
    canSend: !raw.viewOnly,
    title: 'Synced',
    ...(noSecond ? { noSecond: true } : {}),
    detail: noSecond ? NO_SECOND_WORDS : `Block ${height.toLocaleString('en-US')}, made ${ageText(tipAge)} (from ${serverHost(raw.server)}).`,
  };
}

/** "40 s ago", "3 min ago", "2 h ago": how old the latest block is, by this device's clock. */
export function ageText(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 15) return 'just now';
  if (sec < 90) return `${Math.round(sec)} s ago`;
  if (sec < 90 * 60) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
}
