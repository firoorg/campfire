// A wallet whose recovery words were never shown on this device (restored from a backup file)
// gets a reminder on Home until the person says they wrote them down (audit A-10). The file and
// its password are one copy, easily lost with the device, and the browser may clear its storage.
// The preference for "Later" (backupPromptSnoozedUntil) was declared and never used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wordsReminderDue, WORDS_REMINDER_SNOOZE_MS } from '../../src/lib/session.js';
import { WALLET_PREF_KEYS } from '../../src/lib/wallet_scope.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const now = 1_800_000_000_000;

test('due for a wallet from a backup file, until the words are written down or "Later" runs', () => {
  const fromFile = { id: '0123456789abcdef', restored: true, words: 24, wordsConfirmed: false };
  assert.equal(wordsReminderDue(fromFile, {}, now), true);
  assert.equal(wordsReminderDue({ ...fromFile, wordsConfirmed: true }, {}, now), false, 'written down');
  assert.equal(wordsReminderDue(fromFile, { backupPromptSnoozedUntil: now + 1000 }, now), false, 'Later');
  assert.equal(wordsReminderDue(fromFile, { backupPromptSnoozedUntil: now - 1 }, now), true, 'a week later');
  assert.equal(WORDS_REMINDER_SNOOZE_MS, 7 * 24 * 3600 * 1000);
  assert.ok(WALLET_PREF_KEYS.includes('backupPromptSnoozedUntil'), 'per wallet');
});

test('never for a wallet made here (its three words were checked), restored from words, or watch-only', () => {
  assert.equal(wordsReminderDue({ restored: false, wordsConfirmed: true }, {}, now), false);
  assert.equal(wordsReminderDue({ restored: true, wordsConfirmed: true }, {}, now), false);
  assert.equal(wordsReminderDue({ restored: true }, {}, now), false, 'an older record: unknown, not nagged');
  assert.equal(wordsReminderDue({ watchOnly: true, wordsConfirmed: false }, {}, now), false);
  assert.equal(wordsReminderDue(null, {}, now), false);
});

test('a file restore records the words as not yet confirmed; Home and Backup use it; persistence is asked again', () => {
  const session = readFileSync(join(src, 'lib', 'session.js'), 'utf8');
  assert.match(session, /const wordsConfirmed = setup\.mode !== 'file';/);
  assert.match(readFileSync(join(src, 'screens', 'home.js'), 'utf8'), /wordsReminderDue\(app\.record, app\.prefs\)/);
  assert.match(readFileSync(join(src, 'screens', 'backup.js'), 'utf8'), /markWordsConfirmed\(app\)/);
  assert.match(readFileSync(join(src, 'lib', 'storage.js'), 'utf8'), /appinstalled/);
  assert.match(readFileSync(join(src, 'screens', 'notifications.js'), 'utf8'), /refreshPersistence\(app, \{ request: true \}\)/);
});
