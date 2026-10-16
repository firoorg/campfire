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
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
}

/** How old the newest known release is, when that is old enough to say: {date, months}; else null. */
export function staleRelease(created, now = Date.now()) {
  const t = Date.parse(created);
  if (!Number.isFinite(t)) return null;
  const days = (now - t) / DAY_MS;
  return days >= STALE_AFTER_DAYS ? { date: releaseDate(created), months: Math.round(days / 30.44) } : null;
}

/** "a copy at cdn.jsdelivr.net", or null for this app's own address. */
export const copyAt = (from) => (from && !from.own && from.host ? `a copy at ${from.host}` : null);

/** The refusal in plain words, naming the copy it came from when that was not this app's address. */
export function refusalText(r) {
  const why = r.reason || 'The update did not pass the signature check.';
  return r.from && !r.from.own ? `From the copy at ${r.from.host}: ${why}` : why;
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
  return v.host ? `Updated to ${v.version} from a copy at ${v.host} — checked against Firo PWA's signature.` : `Updated to ${v.version} — checked against Firo PWA's signature.`;
}

/** Whether this app's own address answered a check with exactly the installed release. */
export const ownServesInstalled = (r) => Boolean(r && Array.isArray(r.tried) && r.tried.some((t) => t && t.own && t.outcome === 'same'));

/** "Last checked 5 min ago: up to date." for Settings and About. */
export function lastCheckText(lc, now = Date.now()) {
  if (!lc) return 'Never checked. Updates are signed and install only when you tap Update.';
  const mins = Math.max(0, Math.round((now - lc.at) / 60000));
  const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  const copy = lc.host ? ` from a copy at ${lc.host}` : '';
  const released = releaseDate(lc.created);
  const what = {
    none: released ? `you have the latest version, released ${released}.` : 'you have the latest version.',
    ready: `version ${lc.version} is ready to install${lc.host ? ` (from a copy at ${lc.host})` : ''}.`,
    applied: `updated to ${lc.version}${copy}, checked against Firo PWA's signature.`,
    unreachable: 'no update source was reachable; your app keeps working.',
    refused: 'an update was refused.',
    needs_own_address: `version ${lc.version} needs this app's address to install; your app keeps working.`,
  }[lc.result] || 'no answer.';
  return `Last checked ${when}: ${what}`;
}
