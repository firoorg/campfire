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

// What the release signature does not cover, said plainly (audit C-1, E-2).
export const ABOUT_TRIPWIRE =
  "Updates are checked against Campfire's signature before they are installed. The part of Campfire that does that check (the loader) comes straight from this app's web address. While Campfire is open it watches the loader and stops if the address starts serving a different one; it cannot see a change made while it is closed, and the next time it opens, that code runs.";

export default function about(app) {
  const kv = (k, v, testid, mono = false) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: `v${mono ? ' mono' : ''}`, 'data-testid': testid || null, text: v }));
  const sw = h('div');
  const engineKv = kv('Wallet engine', '…', 'about-engine');
  const engineNote = h('div');
  backendKind().then((k) => {
    engineKv.querySelector('.v').textContent = k === 'fake' ? 'Stand-in (no network, sample data)' : 'Firo (Spark + ElectrumX)';
    if (k === 'fake') put(engineNote, h('div', { 'data-testid': 'about-fake' }, notice('warn', 'This build runs a stand-in for the Firo engine: balances and payments are samples, nothing reaches the Firo network. Never send real FIRO to its addresses.')));
  });

  const storageKv = kv('Storage', persistenceText(app.persisted), 'about-storage');
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
        kv('Installed release', st.current ? `${st.current}${releaseDate(st.currentCreated) ? `, released ${releaseDate(st.currentCreated)}` : ''}${copyAt(st.currentFrom) ? ` (from ${copyAt(st.currentFrom)})` : ''}` : '—', 'about-release'),
        kv('Staged update', st.pending || 'none'),
        kv('Loader', st.loader || '—', 'about-loader', true),
        kv('Updates', lastCheckText(app.updates.lastCheck), 'about-last-check'),
        // Where a tapped check looks: all of them, the newest signed release wins (on a tie, this app's address).
        h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'Update sources (each check asks them all)' }), h('span', { class: 'v list', 'data-testid': 'about-sources' }, ...["This app's address", ...copies].map((t) => h('span', { text: t })))),
        st.lastRefusal ? kv('Last refused update', st.lastRefusal.reason) : null,
      );
    } catch {
      put(sw, kv('Verified copy', BUILT ? 'not active yet' : 'development build (no service worker)'));
    }
  })();

  const s = wallet.state;
  const el = screen(
    { title: 'About', back: () => app.back('settings') },
    engineNote,
    h(
      'div',
      { class: 'card' },
      kv('App', `Campfire ${APP_VERSION}`, 'about-version'),
      engineKv,
      kv('Network', s.raw && s.raw.network === 'test' ? 'Firo testnet' : 'Firo mainnet'),
      kv('Servers', serverWords(app.prefs), 'about-servers'),
      kv('Connected to', s.server ? serverHost(s.server) : 'not connected', 'about-connection'),
      kv('Latest block', s.tip ? s.tip.height.toLocaleString('en-US') : '—'),
      kv('Cross-origin isolated', String(self.crossOriginIsolated)),
      storageKv,
    ),
    h('p', { class: 'section-title', text: 'Release' }),
    h('div', { class: 'card' }, sw),
    h('p', { class: 'small', 'data-testid': 'about-tripwire', text: ABOUT_TRIPWIRE }),
    h('p', { class: 'small', text: 'Campfire for the web: MIT licence, by vsnation, from the Campfire wallet (Cypher Stack). Bundled: noble cryptography and scure (MIT), jsQR (Apache-2.0), Inter font (SIL Open Font License 1.1), and Spark (Firo\'s sparkmobile, libsecp256k1, Bitcoin Core, ctaes, musl and Emscripten, MIT; LLVM libc++, Apache-2.0 with LLVM Exceptions), each licence in vendor/spark/licenses. Logos: Campfire\'s (GPL-3.0, from the Campfire app), Ethereum\'s (CC BY 3.0, the Ethereum Foundation), Firo\'s (Firo\'s mark): img/LICENSE.txt.' }),
  );
  return { el };
}
