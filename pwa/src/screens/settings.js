/* Settings
 * Spec: ONE job: adjust how this wallet connects, stays locked and is backed up.
 *       Primary CTA: none (a list); the most used item, "Lock now", is first in its group.
 *       Taps from app open: 1 (☰ on Home), 2 for any item.
 * Exit-intent reasons and answers:
 *   - "Which server should I pick?" -> none: Firo's servers by default, and the engine moves to
 *     another by itself; "Servers" says which is in use and offers your own.
 *   - "Who can see my IP?" -> IP privacy row.
 *   - "How do I remove it?" -> Delete is here, with what it means before anything happens.
 *   - "What is my backup?" -> Backup row: the recovery words (shown after Face ID / password), and
 *     an encrypted backup file.
 *   - "My balance is wrong / a payment is missing" -> Rescan, and Clear the Spark cache.
 *   - "What if this app's address dies?" -> Check for updates also asks public copies of the
 *     release, and "Update from another address" takes any copy; both say the app keeps working.
 *   - "Why are there no dollar values?" -> the CoinGecko switch (it sees the IP address).
 *   - "It is not in my language" / "I want it in English" -> App: Language, like this device by
 *     default, or any of the app's languages.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, toast, openSheet, primary, textButton, notice } from '../lib/ui.js';
import { hasPasskey, removePasskey } from '../lib/session.js';
import { passkeyAvailable } from '../lib/passkey.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { lastCheckText } from '../lib/update.js';
import { runUpdateCheck, openOtherAddress } from '../lib/update_ui.js';
import { listWallets, nameOf } from '../lib/wallets.js';
import { notificationsRow } from './notifications.js';
import { THEMES, THEME_WORDS, readTheme, setTheme } from '../lib/theme.js';
import { languageSelect, languageRowNote } from '../lib/lang_ui.js';
import { serverWords } from '../lib/servers.js';
import { isNotYet } from '../lib/chain.js';
import { priceSettings } from './fiat_ui.js';
import * as payments from '../lib/payments.js';
import { t, tn } from '../lib/i18n.js';

/** A settings row: icon, title, a line under it, a chevron. */
export function settingsRow(ico, title, sub, onclick, extra = {}) {
  return h('button', { class: 'row', onclick, ...extra }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), h('span', { class: 'chev' }, icon('chevron')));
}

/** Clear the Spark cache: what it does, then the engine reads the coin sets again. */
export function clearCacheSheet(app) {
  let busy = false;
  let message = null;
  openSheet((close, rerender) => [
    h('h2', { text: t('Clear the Spark cache?') }),
    h('p', { class: 'lead', text: t('Firo PWA forgets the private coin sets it downloaded and reads them again from the Firo node. Your coins and history are safe; until it is done, sending waits.') }),
    message,
    primary(busy ? t('Clearing…') : t('Clear and read again'), async () => {
      if (busy) return;
      busy = true;
      rerender();
      try {
        await app.wallet.clearSparkCache();
        close();
        toast(t('Spark cache cleared. Reading the coin sets again…'), 4000);
      } catch (e) {
        busy = false;
        message = notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? t('Clearing the Spark cache is not in this version yet.') : t('It was not cleared: {message}', { message: e.message }));
        rerender();
      }
    }, { 'data-testid': 'clear-cache-confirm' }),
    textButton(t('Cancel'), () => close(), { 'data-testid': 'clear-cache-cancel' }),
  ], { label: t('Clear the Spark cache') });
}

export default function settings(app) {
  const row = settingsRow;
  const lockSel = h('select', { class: 'inline', 'aria-label': t('Auto-lock'), 'data-testid': 'autolock-select' }, ...[1, 5, 15].map((m) => h('option', { value: String(m), text: t('{n} min', { n: m }) })));
  lockSel.value = String(app.prefs.autoLockMin);
  lockSel.addEventListener('change', async () => {
    await app.setPrefs({ autoLockMin: Number(lockSel.value) });
    toast(t('Locks after {n} min without use', { n: lockSel.value }));
  });

  // Light or dark: like this device, or always one (lib/theme.js). It changes at once.
  const themeSel = h('select', { class: 'inline', 'aria-label': t('Theme'), 'data-testid': 'theme-select' }, ...THEMES.map((item) => h('option', { value: item, text: THEME_WORDS[item] })));
  themeSel.value = readTheme();
  themeSel.addEventListener('change', () => setTheme(themeSel.value));
  const langSel = languageSelect();

  // Which block explorer a payment's link opens (a link only; the app fetches nothing from it).
  const explorers = Array.isArray(payments.EXPLORERS) ? payments.EXPLORERS : [];
  const explorerSel = explorers.length > 1 ? h('select', { class: 'inline', 'aria-label': t('Block explorer'), 'data-testid': 'explorer-select' }, ...explorers.map((x) => h('option', { value: x.id, text: x.name }))) : null;
  if (explorerSel) {
    explorerSel.value = explorers.some((x) => x.id === app.prefs.explorer) ? app.prefs.explorer : explorers[0].id;
    explorerSel.addEventListener('change', async () => {
      await app.setPrefs({ explorer: explorerSel.value });
      toast(t('Payments open on {name}', { name: explorers.find((x) => x.id === explorerSel.value).name }));
    });
  }

  const faceRowBox = h('div');
  (async () => {
    const on = hasPasskey(app);
    const avail = on || (await passkeyAvailable());
    put(
      faceRowBox,
      on
        ? row('face', 'Face ID / Touch ID', t('On. Tap to turn off.'), async () => {
            if (!(await confirmIdentity(app, { title: t('Turn off Face ID?'), cta: t('Turn off') }))) return;
            await removePasskey(app);
            // The passkey itself stays in the password manager, opening nothing now (PN-keys): said.
            toast(t('Face ID is off. Use your password to unlock. The Campfire passkey in your password manager opens nothing now; you can delete it there.'), 8000);
            app.go('settings', {}, { replace: true });
          }, { 'data-testid': 'passkey-row' })
        : avail
          ? row('face', 'Face ID / Touch ID', t('Off. Tap to turn on.'), () => app.go('passkeySetup'), { 'data-testid': 'passkey-row' })
          : row('face', 'Face ID / Touch ID', t('Not available in this browser.'), () => toast(t('This browser cannot keep a key behind Face ID. Use your password.'))),
    );
  })();

  // The only way this app contacts an update source (its web address, then copies of the
  // release, then an address added below): when this row is tapped.
  const updRow = row('download', t('Check for updates'), lastCheckText(app.updates.lastCheck), () => runUpdateCheck(app, { onDone: setUpdSub }), { 'data-testid': 'check-updates' });
  const otherSub = () => {
    const added = app.updates.addedSource();
    return added ? t('Also asks {host}', { host: new URL(added).host }) : t("If this app's address is gone");
  };
  const otherRow = row('globe', t('Update from another address'), otherSub(), () => openOtherAddress(app, { onDone: setUpdSub }), { 'data-testid': 'update-other-row' });
  function setUpdSub() {
    const sub = updRow.querySelector('.s');
    if (sub) sub.textContent = lastCheckText(app.updates.lastCheck);
    const sub2 = otherRow.querySelector('.s');
    if (sub2) sub2.textContent = otherSub();
  }
  const offU = app.updates.onChange(setUpdSub);

  // Several wallets (screens/wallets.js): which one is open, and the way to the others.
  const walletsRow = row('wallet', t('Wallets'), t('{name} is open', { name: nameOf(app.record) }), () => app.go('wallets'), { 'data-testid': 'wallets-row' });
  listWallets().then((l) => {
    const sub = walletsRow.querySelector('.s');
    if (sub && l.length > 1) sub.textContent = tn({ one: '{name} is open · {n} on this device', other: '{name} is open · {n} on this device' }, l.length, { name: nameOf(app.record) });
    else if (sub) sub.textContent = t('{name} is open · add another', { name: nameOf(app.record) });
  }, () => {});

  // Restored private payments are found without asking the server about them, so their date is
  // only roughly known; this asks for each one hidden among 7 others (Firo engine: sparkTxDetails).
  const exactSw = h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': t('Exact dates for restored private payments'), 'data-testid': 'exact-dates-switch', checked: app.prefs.exactSparkDates === true });
  exactSw.addEventListener('change', async () => {
    await app.setPrefs({ exactSparkDates: exactSw.checked });
    toast(exactSw.checked ? t('Exact dates from the next unlock: each payment is asked for among 7 others.') : t('Restored private payments keep an approximate date.'), 4500);
  });
  const inline = (ico, title, sub, control, testid) => h('div', { class: 'row', 'data-testid': testid }, h('span', { class: 'ico' }, icon(ico)), h('span', { class: 'main' }, h('div', { class: 't', text: title }), sub ? h('div', { class: 's', text: sub }) : null), control);

  const el = screen(
    { title: t('Settings'), tabs: 'settings', app, back: () => app.go('home'), cls: 'settings' },
    h('div', { class: 'card list' }, walletsRow),
    h('p', { class: 'section-title', text: t('Security') }),
    h(
      'div',
      { class: 'card list' },
      row('lock', t('Lock now'), null, () => app.lock('manual'), { 'data-testid': 'lock-now' }),
      inline('clock', t('Auto-lock'), t('Also in the background'), lockSel),
      faceRowBox,
      row('key', t('Change password'), null, () => app.go('changePassword'), { 'data-testid': 'change-password' }),
      row('file', t('Backup'), tn({ one: 'Your {n} recovery word, or an encrypted file', other: 'Your {n} recovery words, or an encrypted file' }, app.record.words || 24), () => app.go('backup'), { 'data-testid': 'backup-row' }),
    ),
    h('p', { class: 'section-title', text: t('Payments') }),
    h(
      'div',
      { class: 'card list' },
      row('person', t('Address book'), t('People you pay, with their address'), () => app.go('contacts'), { 'data-testid': 'contacts-row' }),
      notificationsRow(app),
      priceSettings(app),
      explorerSel ? inline('external', t('Block explorer'), t('Where a payment’s link opens'), explorerSel, 'explorer-row') : null,
      h('label', { class: 'row', 'data-testid': 'exact-dates-row' }, h('span', { class: 'ico' }, icon('clock')), h('span', { class: 'main' }, h('div', { class: 't', text: t('Exact dates for restored private payments') }), h('div', { class: 's wrap', text: t('Off: their dates are approximate. On: the server is asked for each one hidden among 7 others, so it cannot tell which is yours.') })), exactSw),
    ),
    h('p', { class: 'section-title', text: t('Network') }),
    h(
      'div',
      { class: 'card list' },
      row('at', t('Spark names'), t('Get @yourname, so people can pay you by name'), () => app.go('names'), { 'data-testid': 'names-row' }),
      row('coins', t('Coins'), t('Freeze or note single coins'), () => app.go('coins'), { 'data-testid': 'coins-row' }),
      row('server', t('Masternodes'), t('Yours, running or not'), () => app.go('masternodes'), { 'data-testid': 'masternodes-row' }),
      row('server', t('Firo nodes'), serverWords(app.prefs), () => app.go('servers'), { 'data-testid': 'servers-row' }),
      row('refresh', t('Rescan'), t('If your balance or a payment looks wrong'), () => app.go('rescan'), { 'data-testid': 'rescan-row' }),
      row('spark', t('Clear the Spark cache'), t('Read the private coin sets again'), () => clearCacheSheet(app), { 'data-testid': 'clear-cache-row' }),
      row('eye', t('Spark view key'), t('Let another wallet watch your private payments'), () => app.go('viewKey'), { 'data-testid': 'view-key-row' }),
      row('shield', t('IP privacy'), t('Who can see your IP address'), () => app.go('ipNotice'), { 'data-testid': 'ip-privacy' }),
      row('eth', 'Ethereum & BNB', t('Servers, privacy, backup'), () => app.go('ethSettings'), { 'data-testid': 'eth-settings-row' }),
    ),
    h('p', { class: 'section-title', text: t('App') }),
    h(
      'div',
      { class: 'card list' },
      h('div', { class: 'row', 'data-testid': 'lang-row' }, h('span', { class: 'ico' }, icon('language')), h('span', { class: 'main' }, h('div', { class: 't', text: t('Language') }), languageRowNote()), langSel),
      inline('moon', t('Theme'), t('Light or dark'), themeSel, 'theme-row'),
      updRow,
      otherRow,
      row('info', t('About'), null, () => app.go('about'), { 'data-testid': 'about' }),
      row('trash', t('Delete wallet from this device'), null, () => app.go('deleteWallet'), { 'data-testid': 'delete-wallet' }),
    ),
  );
  return { el, destroy: offU };
}
