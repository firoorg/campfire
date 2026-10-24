/* About
 * Spec: ONE job: show exactly what is running, so it can be checked.
 *       Primary CTA: none (information); "Check for updates" lives in Settings.
 *       Taps from app open: 2 (Settings -> About).
 * Exit-intent reasons and answers:
 *   - "Can I verify this build?" -> version, loader, release status and where updates come from.
 *   - "Which engine is this?" -> said plainly; the stand-in (no network, no real funds) is named.
 *   - "Who made this?" -> project and licences named.
 *   - "Will my wallet survive?" -> whether the browser keeps this app's storage, and when updates were
 *     last checked. Opening this screen contacts nothing.
 *   - "What does the signature not cover?" -> said under Release: the loader comes from the web
 *     address as it is; the app watches it only while open (lib/loader.js, loader-watch.js).
 */
import { h, put } from '../lib/dom.js';
import { screen, notice } from '../lib/ui.js';
import { APP_VERSION, BUILT } from '../lib/version.js';
import { wallet } from '../lib/wallet.js';
import { backendKind } from '../lib/chain.js';
import { serverHost } from '../lib/sync.js';
import { serverWords } from '../lib/servers.js';
import { lastCheckText, copyAt, releaseDate } from '../lib/update.js';
import { refreshPersistence, persistenceText } from '../lib/storage.js';
import { t, tk } from '../lib/i18n.js';
import { loaderText } from '../lib/loader_words.js';

/** The installed release, its date and the copy it came from, as one sentence. */
function releaseLine(version, date, from) {
  if (date && from) return t('{version}, released {date} (from {from})', { version, date, from });
  if (date) return t('{version}, released {date}', { version, date });
  if (from) return t('{version} (from {from})', { version, from });
  return version;
}

// What the release signature does not cover, said plainly (audit C-1, E-2).
export const ABOUT_TRIPWIRE =
  tk("Updates are checked against Firo PWA's signature before they are installed. The part of Firo PWA that does that check (the loader) comes straight from this app's web address. While Firo PWA is open it watches the loader and stops if the address starts serving a different one; it cannot see a change made while it is closed, and the next time it opens, that code runs.");

export default function about(app) {
  const kv = (k, v, testid, mono = false) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: `v${mono ? ' mono' : ''}`, 'data-testid': testid || null, text: v }));
  const sw = h('div');
  const engineKv = kv(t('Wallet engine'), '…', 'about-engine');
  const engineNote = h('div');
  backendKind().then((k) => {
    engineKv.querySelector('.v').textContent = k === 'fake' ? t('Stand-in (no network, sample data)') : 'Firo (Spark + ElectrumX)';
    if (k === 'fake') put(engineNote, h('div', { 'data-testid': 'about-fake' }, notice('warn', t('This build runs a stand-in for the Firo engine: balances and payments are samples, nothing reaches the Firo network. Never send real FIRO to its addresses.'))));
  });

  const storageKv = kv(t('Storage'), persistenceText(app.persisted), 'about-storage');
  refreshPersistence(app, { request: Boolean(app.record) }).then((v) => {
    storageKv.querySelector('.v').textContent = persistenceText(v);
  });

  (async () => {
    try {
      const st = await app.updates.status();
      const added = app.updates.addedSource();
      const copies = [...(st.sources || []).filter((x) => x.kind !== 'own').map((x) => x.host), ...(added ? [new URL(added).host] : [])];
      put(
        sw,
        kv(t('Installed release'), st.current ? releaseLine(st.current, releaseDate(st.currentCreated), copyAt(st.currentFrom)) : '—', 'about-release'),
        kv(t('Staged update'), st.pending || t('none')),
        kv(t('Loader'), st.loader || '—', 'about-loader', true),
        kv(t('Updates'), lastCheckText(app.updates.lastCheck), 'about-last-check'),
        // Where a tapped check looks: all of them, the newest signed release wins (on a tie, this app's address).
        h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('Update sources (each check asks them all)') }), h('span', { class: 'v list', 'data-testid': 'about-sources' }, ...[t("This app's address"), ...copies].map((item) => h('span', { text: item })))),
        st.lastRefusal ? kv(t('Last refused update'), loaderText(st.lastRefusal.reason)) : null,
      );
    } catch {
      put(sw, kv(t('Verified copy'), BUILT ? t('not active yet') : t('development build (no service worker)')));
    }
  })();

  const s = wallet.state;
  const el = screen(
    { title: t('About'), back: () => app.back('settings') },
    engineNote,
    h(
      'div',
      { class: 'card' },
      kv(t('App'), `Firo PWA ${APP_VERSION}`, 'about-version'),
      engineKv,
      kv(t('Network'), s.raw && s.raw.network === 'test' ? t('Firo testnet') : t('Firo mainnet')),
      kv(t('Servers'), serverWords(app.prefs), 'about-servers'),
      kv(t('Connected to'), s.server ? serverHost(s.server) : t('not connected'), 'about-connection'),
      kv(t('Latest block'), s.tip ? s.tip.height.toLocaleString('en-US') : '—'),
      kv(t('Cross-origin isolated'), String(self.crossOriginIsolated)),
      storageKv,
    ),
    h('p', { class: 'section-title', text: t('Release') }),
    h('div', { class: 'card' }, sw),
    h('p', { class: 'small', 'data-testid': 'about-tripwire', text: t(ABOUT_TRIPWIRE) }),
    h('p', { class: 'small', text: t('Firo PWA: MIT licence, by vsnation, from the Campfire wallet (Cypher Stack). Bundled: noble cryptography and scure (MIT), jsQR (Apache-2.0), Inter font (SIL Open Font License 1.1), and Spark (Firo\'s sparkmobile, libsecp256k1, Bitcoin Core, ctaes, musl and Emscripten, MIT; LLVM libc++, Apache-2.0 with LLVM Exceptions), each licence in vendor/spark/licenses. Logos: Firo PWA\'s (GPL-3.0, from the Firo PWA app), Ethereum\'s (CC BY 3.0, the Ethereum Foundation), Firo\'s (Firo\'s mark): img/LICENSE.txt.') }),
  );
  return { el };
}
