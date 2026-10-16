/* BNB Chain's server changed (a sheet, once, over whichever Ethereum & BNB screen opens the wallet first)
 * Spec: ONE job: say that BNB Chain now goes through BNB Chain's official server, why, and who sees
 *       what now, before anything of the person's goes to it.
 *       Primary CTA: "OK" (secondary: "See BNB Chain servers"). Taps: 0 to see it, 1 to close it.
 * Exit-intent reasons and answers:
 *   - "Why did my server change?" -> PublicNode stopped saying whether payments went through.
 *   - "Who sees my address now?" -> the server named, as PublicNode did.
 *   - "I want another one" -> "See BNB Chain servers" opens the list (and your own).
 */
import { h } from '../lib/dom.js';
import { openSheet, primary, secondary, notice } from '../lib/ui.js';
import { takeBscServerNote, bscServerNoteWords, bscServerNote } from '../lib/eth/server_notes.js';
import { evmPrefs } from '../lib/eth/wallet.js';

/**
 * Takes the note (told now; a PublicNode pick moves to the default) and shows it, once per session:
 * app.bscNoteShown is set before anything else, so a save that fails cannot bring it back every
 * moment, nor hold BNB Chain's requests (lib/eth/wallet.js bscHeld); it comes again next start.
 */
export async function showBscServerNote(app, { open = openSheet } = {}) {
  if (app.bscNoteShown) return;
  const pending = bscServerNote(app.prefs);
  app.bscNoteShown = true;
  const note = (await takeBscServerNote(app)) || pending;
  if (!note) return;
  const name = evmPrefs(app, 'bsc').host.name;
  open(
    (close) => [
      h('h2', { text: 'BNB Chain server changed' }),
      h('div', { 'data-testid': 'bsc-server-note', 'data-picked': note.picked ? 'true' : 'false' }, notice('info', h('strong', { text: 'BNB Chain server changed. ' }), bscServerNoteWords(note, name))),
      h(
        'div',
        { class: 'sheet-actions' },
        primary('OK', () => close(), { 'data-testid': 'bsc-server-note-ok' }),
        secondary('See BNB Chain servers', () => {
          close();
          app.go('ethServers', { chain: 'bsc' });
        }, { 'data-testid': 'bsc-server-note-see' }),
      ),
    ],
    { label: 'BNB Chain server changed' },
  );
}
