// Told once: BNB Chain's server changed (2026-10-14). Until then the default was PublicNode, which
// now answers every receipt with "Archive requests require a personal token": a payment there could
// never be seen confirmed. The default is BNB Chain's official server, and PublicNode is no longer
// listed (lib/eth/hosts.js). Whoever used it - by default, or picked - is told once, on the
// Ethereum & BNB Home (release audit 0.1.5, K1); whoever had picked it is also moved off it in their
// preferences (evmPrefs() already reads an id that is no longer listed as the default).
// A wallet set up from now on was shown the BNB Chain server on the privacy screen: nothing to tell
// (eth_privacy.js sets BSC_NOTE_PREF).

import { DEFAULT_BSC_RPC, RPC_PREF } from './hosts.js';

/** Set once the person was told (or had nothing to be told). */
export const BSC_NOTE_PREF = 'bscServerNote';
/** BNB Chain's server before 2026-10-14 (by default, or picked). */
export const OLD_BSC_DEFAULT = 'bsc-publicnode';

/**
 * What there is to tell, from the preferences alone: null (nothing: told already, or another server
 * was picked and nothing changed for them), or {picked} (they had picked PublicNode themselves;
 * else it was the default).
 */
export function bscServerNote(prefs) {
  const p = prefs || {};
  if (p[BSC_NOTE_PREF]) return null;
  const pick = p[RPC_PREF.bsc];
  if (pick === OLD_BSC_DEFAULT) return { picked: true };
  if (pick === undefined || pick === null || pick === '') return { picked: false };
  return null;
}

/**
 * Takes the note, once: records that it was told and moves a PublicNode pick to the default.
 * Returns the note (see bscServerNote) or null. Saving fails quietly: the note then comes again.
 */
export async function takeBscServerNote(app) {
  const note = bscServerNote(app.prefs);
  const patch = { [BSC_NOTE_PREF]: 1 };
  if (note && note.picked) patch[RPC_PREF.bsc] = DEFAULT_BSC_RPC;
  if (!app.prefs || !app.prefs[BSC_NOTE_PREF]) await app.setPrefs(patch).catch(() => {});
  return note;
}

/** The note in words: what changed, why, and who sees what now. */
export function bscServerNoteWords(note, serverName) {
  return note && note.picked
    ? `BNB Chain now goes through ${serverName}. PublicNode, the server you had picked, stopped saying whether payments went through, so it is no longer offered. ${serverName} sees your IP address with your address, as PublicNode did.`
    : `BNB Chain now goes through ${serverName}, not PublicNode: PublicNode stopped saying whether payments went through. ${serverName} sees your IP address with your address, as PublicNode did.`;
}
