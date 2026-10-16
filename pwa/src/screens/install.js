/* First run: setting up the verified copy
 * Spec: ONE job: get Campfire onto this device, checked against its signature, once.
 *       Primary CTA: none while it works (live progress); "Try again" if it stopped.
 *       Taps from app open: 0 (the first open on a device, or after the browser cleared it).
 * Exit-intent reasons and answers:
 *   - "Is it stuck? Blank screen?" -> never blank: files and MB checked so far, live, from the first second.
 *   - "How long?" -> the total is shown (about 3.5 MB) and it says this happens once.
 *   - "My connection dropped / I closed it" -> said up front: what was already checked is kept and it
 *     continues on the next open. If the download stops moving for 30 s it says so and offers Try again.
 *   - "Nothing happens for a minute" -> measured: Safari can take about a minute to start a site's
 *     first service worker. Until setup has begun the screen says the browser is preparing it (no
 *     false "stopped"); only after 150 s without a start does it offer Try again.
 *   - "I want it on my Home Screen" (iPhone Safari tab) -> says to add it now: the Home Screen app sets
 *     itself up separately.
 *   - "Is this download safe?" -> every file is checked against the release signature before use.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, progressBar } from '../lib/ui.js';
import { registerLoader, readInstallProgress, reloadOnceIntoVerifiedCopy, INTEGRITY_CODES } from '../lib/loader.js';
import { isIosSafariTab } from './welcome.js';

export const STALL_MS = 30000; // no bytes for this long, once downloading: stalled
export const SLOW_START_MS = 45000; // the browser has not started setup yet: say it is normal
export const NO_START_MS = 150000; // ...and only then offer Try again
const POLL_MS = 500;
// How long "Opening Campfire" may show before a way on is offered.
const OPEN_TIMEOUT_MS = 8000;
const MB = (n) => (n / 1e6).toFixed(1);

/** The line under the progress bar. Pure (unit-tested). */
export function progressLine(p) {
  if (!p) return 'Starting setup…';
  if (!p.total) return 'Checking the release signature…';
  return `${p.done} of ${p.total} files checked · ${MB(p.doneBytes)} of ${MB(p.totalBytes)} MB`;
}

export default function install(app) {
  let reg = null;
  let startedAt = Date.now();
  let lastBytes = -1;
  let lastChange = Date.now();
  let phase = 'starting'; // starting | working | stalled | failed | done
  let poller = null;
  let destroyed = false;
  let lastProgress = null;
  let begun = false; // the service worker wrote a record for THIS run
  let slowShown = false;

  const bar = progressBar(null);
  const line = h('p', { class: 'small', 'aria-live': 'polite', 'data-testid': 'install-line', text: 'Starting…' });
  const status = h('div', { 'data-testid': 'install-status' });
  const actions = h('div', { class: 'actions' });
  const tip = isIosSafariTab()
    ? notice('info', h('strong', { text: 'Adding it to your Home Screen? ' }), 'Do it now and open it from there: the Home Screen app sets itself up separately.')
    : null;

  const el = screen(
    { topbar: false, cls: 'install' },
    h('div', { class: 'hero compact' }, h('img', { src: 'img/logo.svg', alt: '' }), h('h1', { text: 'Campfire' })),
    h('h2', { class: 'title center', 'data-testid': 'install-title', text: 'Setting up Campfire on this device…' }),
    bar,
    line,
    status,
    notice('info', h('strong', { text: 'This happens once. Keep this screen open. ' }), 'Every file is checked against the Campfire release signature before it is used.'),
    h('p', { class: 'small', text: 'If the connection drops, nothing is lost: the files already checked are kept, and setup continues the next time you open Campfire.' }),
    tip,
  );
  el.appendChild(actions);

  function show(p) {
    lastProgress = p;
    const fraction = p && p.totalBytes ? p.doneBytes / p.totalBytes : null;
    if (fraction == null) {
      bar.classList.add('indeterminate');
    } else {
      bar.classList.remove('indeterminate');
      bar.firstChild.style.width = `${Math.max(2, fraction * 100)}%`;
    }
    line.textContent = progressLine(p);
    el.dataset.done = p ? String(p.done || 0) : '0';
  }

  function stopped(kind, message) {
    phase = kind;
    put(status, notice(kind === 'stalled' ? 'warn' : 'error', message));
    put(actions, primary('Try again', retry, { 'data-testid': 'install-retry' }));
  }

  async function tick() {
    if (destroyed || phase === 'done') return;
    const p = await readInstallProgress();
    // A record from an earlier run still shows what is already checked; its failure is old news.
    const fresh = Boolean(p && p.at >= startedAt - 1000);
    if (p && (p.total || !lastProgress)) show(p);
    if (fresh && !begun) {
      begun = true;
      lastChange = Date.now();
      if (slowShown && phase === 'working') put(status);
    }
    const bytes = p ? p.doneBytes || 0 : 0;
    if (bytes !== lastBytes) {
      lastBytes = bytes;
      lastChange = Date.now();
      if (phase === 'stalled') {
        phase = 'working';
        put(status);
        put(actions);
      }
    }
    if (fresh && p.state === 'failed' && phase !== 'failed') return onFailed(p.error);
    if (phase !== 'working') return;
    if (!begun) {
      // Safari can take about a minute to start a site's first service worker (measured on the
      // iOS Simulator). That is not a stalled download: say so, and offer Try again only much later.
      const waited = Date.now() - startedAt;
      if (waited > NO_START_MS) {
        stopped('stalled', 'Setup has not started after two and a half minutes. Your browser may have paused it.');
      } else if (waited > SLOW_START_MS && !slowShown) {
        slowShown = true;
        put(status, notice('info', 'Your browser is still preparing the setup. The first time, this can take about a minute.'));
      }
      return;
    }
    if (Date.now() - lastChange > STALL_MS) {
      const kept = p && p.done ? ` The ${p.done} files already checked are kept.` : '';
      stopped('stalled', `The download has not moved for ${Math.round(STALL_MS / 1000)} seconds. The connection to the Campfire site may have dropped.${kept}`);
    }
  }

  function onFailed(err) {
    const code = err && err.code;
    if (INTEGRITY_CODES.has(code)) {
      phase = 'failed';
      return app.go('problem', { kind: 'integrity', detail: err.message });
    }
    const kept = lastProgress && lastProgress.done ? ` The ${lastProgress.done} files already checked are kept; Try again continues from there.` : '';
    stopped('failed', code === 'stopped' ? `Setup was stopped.${kept}` : `Couldn't reach the Campfire site to finish setting up. Check your connection.${kept}`);
  }

  function follow(r) {
    const w = r.installing || r.waiting || r.active;
    if (!w) return;
    if (w.state === 'activated') return finish();
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') finish();
      else if (w.state === 'redundant' && phase !== 'done') setTimeout(tick, 300); // the record says why
    });
  }

  async function begin() {
    startedAt = Date.now();
    lastChange = Date.now();
    begun = false;
    slowShown = false;
    phase = 'working';
    put(status);
    put(actions);
    try {
      reg = await registerLoader();
    } catch {
      if (!destroyed) onFailed({ code: 'unreachable' });
      return;
    }
    if (destroyed) return;
    reg.addEventListener('updatefound', () => follow(reg));
    follow(reg);
  }

  async function retry() {
    put(actions);
    put(status, h('p', { class: 'small', text: 'Trying again…' }));
    const w = reg && reg.installing;
    if (w) {
      // End the stuck run; the next one resumes from the files already checked.
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 10000);
        w.addEventListener('statechange', () => w.state === 'redundant' && (clearTimeout(t), resolve()));
        w.postMessage({ type: 'abort-install' });
      });
    }
    begin();
  }

  function finish() {
    if (phase === 'done' || destroyed) return;
    phase = 'done';
    line.textContent = 'Checked. Opening Campfire…';
    bar.classList.remove('indeterminate');
    bar.firstChild.style.width = '100%';
    // Opening takes a second; if this screen is still here, never leave the person waiting.
    setTimeout(() => {
      if (destroyed) return;
      put(
        actions,
        primary('Open Campfire', () => location.reload(), { 'data-testid': 'install-open' }),
        h('p', { class: 'small', text: 'Still here? If your browser\'s developer tools are open, turn off "Update on reload" and "Bypass for network" (Application, Service workers), then open it again.' }),
      );
    }, OPEN_TIMEOUT_MS);
    if (!reloadOnceIntoVerifiedCopy()) app.continueBoot();
  }

  show(null);
  readInstallProgress().then((p) => p && p.total && show(p));
  poller = setInterval(tick, POLL_MS);
  begin();

  return {
    el,
    destroy() {
      destroyed = true;
      clearInterval(poller);
    },
  };
}
