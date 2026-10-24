// Talking to the service worker about releases. The worker owns the rules
// (sw.js): it serves only files from a release whose signature and hashes it
// verified, and it switches releases only when apply() is called - which only
// the "Update" button does.
//
// Nothing here runs by itself: there is no update check at start, no timer and
// no re-registration. Update sources are contacted only when the person taps
// "Check for updates": this app's own address, the public copies of the
// release and an address the person added, all of them, and the newest signed
// release wins (lib/update_sources.js). The installed copy keeps working when
// all of them are gone.

import { askLoader, loaderServed, moveToLoader } from './loader.js';
import { normalizeSource } from './update_sources.js';
import { t, tn } from './i18n.js';

const LAST_CHECK_KEY = 'campfire-last-update-check';
const ADDED_KEY = 'campfire-update-source';
const JUST_UPDATED_KEY = 'campfire-just-updated';

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, v) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: only the "last checked" line and the added address are lost */
  }
}

function readLastCheck() {
  const v = readJson(LAST_CHECK_KEY);
  return v && typeof v.at === 'number' ? v : null;
}

// The newest release any source has is older than this: say so (never refuse it). A frozen
// address, or every copy left behind, looks exactly like "up to date" otherwise.
export const STALE_AFTER_DAYS = 180;
const DAY_MS = 86400000;

/** "12 Oct 2026" for a release's signed date (ISO), or null. */
export function releaseDate(iso) {
  const item = Date.parse(iso);
  return Number.isFinite(item) ? new Date(item).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
}

/** How old the newest known release is, when that is old enough to say: {date, months}; else null. */
export function staleRelease(created, now = Date.now()) {
  const item = Date.parse(created);
  if (!Number.isFinite(item)) return null;
  const days = (now - item) / DAY_MS;
  return days >= STALE_AFTER_DAYS ? { date: releaseDate(created), months: Math.round(days / 30.44) } : null;
}

/** "a copy at cdn.jsdelivr.net", or null for this app's own address. */
export const copyAt = (from) => (from && !from.own && from.host ? t('a copy at {host}', { host: from.host }) : null);

/** The refusal in plain words, naming the copy it came from when that was not this app's address. */
export function refusalText(r) {
  const why = r.reason || t('The update did not pass the signature check.');
  return r.from && !r.from.own ? t('From the copy at {host}: {why}', { host: r.from.host, why }) : why;
}

export const updates = {
  available: null, // {version, from} once a verified update is staged
  refused: null, // {reason}
  lastCheck: readLastCheck(), // {at, result, version?, host?} of the last check the person asked for
  listeners: new Set(),
  emit() {
    for (const fn of this.listeners) fn(this);
  },
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  async status() {
    return askLoader({ type: 'status' }, { timeoutMs: 10000 });
  },
  /** The address the person added ("Update from another address"), or null. */
  addedSource() {
    const v = readJson(ADDED_KEY);
    return v && typeof v.url === 'string' && normalizeSource(v.url).ok ? v.url : null;
  },
  /** Saves an address (validated here and again by the loader); null forgets it. Returns {ok, url?, reason?}. */
  setAddedSource(input) {
    if (input === null) {
      writeJson(ADDED_KEY, null);
      this.emit();
      return { ok: true, url: null };
    }
    const n = normalizeSource(input);
    if (n.ok) {
      writeJson(ADDED_KEY, { url: n.url, at: Date.now() });
      this.emit();
    }
    return n;
  },
  /**
   * Looks for a newer signed release, source by source, and downloads and
   * verifies it. Never applies it. Only on request. onProgress gets
   * {step: 'checking'|'downloading', host, own, version?, done?, total?}.
   */
  async check({ onProgress = null } = {}) {
    const added = this.addedSource();
    let r;
    try {
      r = await askLoader({ type: 'check-update', added: added ? [added] : [], progress: true }, { onProgress });
    } catch (e) {
      r = { result: 'unreachable', reason: e.message };
    }
    if (!r || r.result === 'error') r = { result: 'unreachable', reason: (r && r.reason) || 'no answer' };
    if (r.result === 'ready') {
      this.available = { version: r.version, from: r.from || null };
      this.refused = null;
    } else if (r.result === 'refused') {
      this.refused = { reason: refusalText(r), version: r.version };
    } else if (r.result === 'none') {
      this.refused = null;
    }
    const created = r.result === 'ready' ? r.created || null : (r.newest && r.newest.created) || null;
    this.lastCheck = { at: Date.now(), result: r.result, version: r.version || null, host: copyAt(r.from) ? r.from.host : null, created };
    writeJson(LAST_CHECK_KEY, this.lastCheck);
    // This app's address answered with exactly the installed release: if the
    // page still runs under an older loader (the update came from another copy
    // while the address was down), it moves to its own now.
    if (ownServesInstalled(r)) r.loaderMove = await moveToLoader().catch(() => 'not-served');
    this.emit();
    return r;
  },
  /**
   * Switches to the staged release and reloads. A release that brings a loader
   * the running one cannot stand in for needs this app's address right now (the
   * page moves to that loader after the reload): {result: 'needs_own_address'}
   * when it does not serve that loader's signed bytes to the page. That is a
   * pre-check, not a guarantee (lib/loader.js loaderServed): the browser fetches
   * the loader again to install it, and the page checks it once more after the move.
   */
  async apply() {
    let r = await askLoader({ type: 'apply-update' });
    if (r.result === 'needs_loader') {
      if (!(await loaderServed(r.loader, r.loaderSha256))) {
        r = { result: 'needs_own_address', version: r.version };
        this.lastCheck = { at: Date.now(), result: r.result, version: r.version };
        writeJson(LAST_CHECK_KEY, this.lastCheck);
        this.emit();
        return r;
      }
      r = await askLoader({ type: 'apply-update', loaderReady: true });
    }
    if (r.result === 'applied') {
      const host = copyAt(r.from) ? r.from.host : null;
      this.lastCheck = { at: Date.now(), result: 'applied', version: r.version, host };
      writeJson(LAST_CHECK_KEY, this.lastCheck);
      writeJson(JUST_UPDATED_KEY, { version: r.version, host });
      location.reload();
    }
    return r;
  },
};

/**
 * Once, on the first start after an Update: what was installed and from where.
 * Returns the line to show, or null.
 */
export function takeJustUpdated(appVersion) {
  const v = readJson(JUST_UPDATED_KEY);
  if (!v) return null;
  writeJson(JUST_UPDATED_KEY, null);
  if (v.version !== appVersion) return null;
  return v.host ? t('Updated to {version} from a copy at {host} — checked against Firo PWA\'s signature.', { version: v.version, host: v.host }) : t('Updated to {version} — checked against Firo PWA\'s signature.', { version: v.version });
}

/** Whether this app's own address answered a check with exactly the installed release. */
export const ownServesInstalled = (r) => Boolean(r && Array.isArray(r.tried) && r.tried.some((item) => item && item.own && item.outcome === 'same'));

/** "Last checked 5 min ago: up to date." for Settings and About. */
export function lastCheckText(lc, now = Date.now()) {
  if (!lc) return t('Never checked. Updates are signed and install only when you tap Update.');
  const mins = Math.max(0, Math.round((now - lc.at) / 60000));
  const when = mins < 1 ? t('just now') : mins < 60 ? t('{n} min ago', { n: mins }) : mins < 48 * 60 ? t('{n} h ago', { n: Math.round(mins / 60) }) : tn({ one: '{n} day ago', other: '{n} days ago' }, Math.round(mins / 1440));
  const released = releaseDate(lc.created);
  const what = {
    none: released ? t('you have the latest version, released {released}.', { released }) : t('you have the latest version.'),
    ready: (lc.host ? t('version {version} is ready to install (from a copy at {host}).', { version: lc.version, host: lc.host }) : t('version {version} is ready to install.', { version: lc.version })),
    applied: (lc.host ? t('updated to {version} from a copy at {host}, checked against Firo PWA\'s signature.', { version: lc.version, host: lc.host }) : t('updated to {version}, checked against Firo PWA\'s signature.', { version: lc.version })),
    unreachable: t('no update source was reachable; your app keeps working.'),
    refused: t('an update was refused.'),
    needs_own_address: t('version {version} needs this app\'s address to install; your app keeps working.', { version: lc.version }),
  }[lc.result] || t('no answer.');
  return t('Last checked {when}: {what}', { when, what });
}
