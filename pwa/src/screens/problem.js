/* Problem: this browser can't run the wallet / this copy failed its signature check /
 *          the web address now serves code Campfire did not sign (tripwire) /
 *          this load skipped the installed copy (bypassed) / this browser cannot keep a checked
 *          copy at all (no-loader: no service workers)
 * Spec: ONE job: say why the wallet can't open here and what to do instead.
 *       Primary CTA: "Try again" (reload) - except after the tripwire, where a reload would run
 *       the unsigned code: there the next step is written out instead (the recovery words or the
 *       encrypted backup file, in another Firo wallet).
 *       Taps from app open: 0.
 * Exit-intent reasons and answers:
 *   - "Is it broken?" -> names the exact missing browser feature or the failed check.
 *   - "What now?" -> the browser/OS that works, or to reload later / use the official address.
 *   - "Is my money gone?" (tripwire) -> no: the coins are on the Firo blockchain; the recovery
 *     words (or the backup file and its password) open them in the Campfire app or another Firo wallet.
 */
import { h } from '../lib/dom.js';
import { screen, primary, notice } from '../lib/ui.js';

export const TRIPWIRE_TEXT =
  "This app's web address is serving code Firo PWA did not sign. Don't enter your password here.";

export default function problem(app, p = {}) {
  if (p.kind === 'tripwire') return tripwire(app);
  if (p.kind === 'bypassed') return bypassed();
  if (p.kind === 'engine') return engineStopped();
  if (p.kind === 'no-loader') return noLoader();
  if (p.kind === 'shared-host') return sharedHostProblem();
  const integrity = p.kind === 'integrity';
  const missing = Array.isArray(p.detail) ? p.detail : p.detail ? [String(p.detail)] : [];
  const el = screen(
    { title: integrity ? 'Security check failed' : "This browser can't run Firo PWA", actions: [primary('Try again', () => location.reload())] },
    integrity
      ? notice('error', p.detail || 'This copy of Firo PWA did not pass its signature check.', " Don't enter your recovery words here. Reload later, or open Firo PWA from its official address.")
      : notice('warn', missing.length ? `Missing: ${missing.join(', ')}.` : 'This browser lacks something the wallet needs.'),
    integrity
      ? null
      : h('p', { class: 'lead', text: 'Firo PWA needs Safari on iOS 16.4 or newer (or a current Chrome, Edge or Firefox), opened over HTTPS from its own address. Private browsing can also block what the wallet needs.' }),
  );
  return { el };
}

function tripwire(app) {
  const el = screen(
    { title: 'Stop: unsigned code', cls: 'tripwire' },
    h('div', { 'data-testid': 'tripwire' }, notice('error', h('strong', { text: TRIPWIRE_TEXT }), ' The wallet was locked the moment it was noticed.')),
    h(
      'div',
      { class: 'card' },
      h('h3', { text: 'Your funds are safe' }),
      h('p', { text: 'Your coins are on the Firo blockchain, not in this app. Open them in the Campfire app or another Firo wallet:' }),
      h('ul', { class: 'steps-list' }, h('li', { text: 'with your recovery words (Restore), or' }), h('li', { text: 'with your encrypted backup file and its password, in a copy of Firo PWA from its official address.' })),
    ),
    h('p', { class: 'small', text: 'Close this app now. Do not reopen it from the same address or enter any password or words in it. This check is a best effort: code that has already taken over can show anything.' }),
  );
  return { el };
}

/* The wallet stopped working in this page (an error nothing could recover from). A reload starts
 * it again; the wallet on this device is untouched. */
function engineStopped() {
  const el = screen(
    { title: 'The wallet stopped', actions: [primary('Start it again', () => location.reload(), { 'data-testid': 'engine-reload' })] },
    h('div', { 'data-testid': 'engine-stopped' }, notice('warn', 'The wallet in this page stopped working. Your wallet and your coins are safe.')),
    h('p', { class: 'lead', text: 'Start it again, then unlock with your password.' }),
  );
  return { el };
}

/* Installed, but this load skipped the installed copy (a hard reload, or a browser set to bypass
 * installed web apps): not "this browser can't run it". One tap opens it normally. */
function bypassed() {
  const el = screen(
    { title: 'Firo PWA is installed', actions: [primary('Open Firo PWA', () => location.reload(), { 'data-testid': 'bypassed-open' })] },
    notice('info', 'This load skipped the installed copy (a hard reload does that). Open it again to continue.'),
    h('p', { class: 'small', text: 'If this screen keeps coming back, your browser is set to skip installed web apps: in its developer tools, turn off "Bypass for network" (Application, Service workers).' }),
  );
  return { el };
}

/* No service workers in this browser (some private windows, an app's built-in browser): Campfire
 * cannot keep a copy checked against its signature here, so it does not run unchecked (P14). */
function noLoader() {
  const el = screen(
    { title: "Firo PWA can't run safely here", actions: [primary('Try again', () => location.reload(), { 'data-testid': 'no-loader-retry' })] },
    h('div', { 'data-testid': 'no-loader' }, notice('warn', h('strong', { text: 'This browser cannot keep a checked copy of Firo PWA. ' }), 'Without one, the wallet would run whatever the web address sends, unchecked, so it does not open.')),
    h('p', { class: 'lead', text: 'Open Firo PWA in Safari, Chrome, Edge or Firefox in a normal (not private) window. If you followed a link inside another app, open it in your browser instead.' }),
    // A wallet made here with an earlier Campfire stays in this browser's storage, which another
    // browser cannot read (audit K3: it was not said how to get it back).
    h('p', { class: 'small', 'data-testid': 'no-loader-wallets', text: 'Made a wallet in this browser before? Your coins are on the Firo blockchain, not in the browser: in the browser that works, choose Restore and enter its recovery words, or open its backup file with its password.' }),
  );
  return { el };
}

/* Opened from a copy on a host many people's pages share (GitHub Pages, a CDN): the wallet's storage
 * would be shared with all of them, so it does not open here (H9). The copies serve updates only. */
function sharedHostProblem() {
  const el = screen(
    { title: 'Open Firo PWA from its own address' },
    h('div', { 'data-testid': 'shared-host' }, notice('warn', h('strong', { text: 'This is a copy Firo PWA updates from, not a place to run it. ' }), 'Pages from many people share this address, and any of them could read a wallet kept here, so it does not open.')),
    h('p', { class: 'lead', text: 'Open Firo PWA from its own address instead, and add it to your Home Screen from there.' }),
  );
  return { el };
}

