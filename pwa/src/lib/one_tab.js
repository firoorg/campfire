// SPDX-License-Identifier: MIT
// One tab at a time: only one page of this app may open a wallet, its engine and its storage.
//
// Why: only one tab of the app open, for safety. Each wallet has its own
// IndexedDB store (lib/wallet_store.js, sealed by lib/sealed_store.js), but two tabs on the same
// wallet run two engines over that one store: each keeps its own sync cursors, coins, spent marks
// and outgoing payments in memory and writes them back, so one tab's writes undo the other's (a coin
// spent by a payment in one tab is offered again in the other; a payment's record is written over),
// and both write the one Spark cache every wallet shares (lib/chain.js). The app store
// (lib/store.js: wallet records, envelopes, prefs) is shared by every tab too.
//
// How: the Web Locks API. At boot, before anything opens IndexedDB, the engine or the app's store,
// the page asks for LOCK_NAME with { ifAvailable: true } and, when it gets it, holds it for the
// life of the page. A page that does not get it shows "open in another tab" and runs no wallet
// code. "Use it here instead" is a hand-over over a BroadcastChannel: the holder locks the wallet
// (forgets its secret, stops the engine, which waits for its sync and its store to finish), lets go
// of the lock and says "moved to another tab"; the asking page waits for the lock (a normal
// request, not a steal), then starts. A holder that does not answer within NO_ANSWER_MS (a frozen
// background tab) can be taken over anyway ({ steal: true }); that page must then never write
// again: every write path asks confirmWrite() first (the wallet store, the Spark cache, the app
// store), which looks the lock up (navigator.locks.query) rather than trusting a flag the frozen
// page has not updated. A page that let go or lost the lock is spent: it reloads before it can
// hold the wallet again (its memory is the state it had then).
//
// A hand-over waits for a step whose parts must not be split (whileBusy: a new wallet's record and
// its selection, a deleted wallet's engine database and its record and keys; re-audit RE1-5, RE1-6),
// within the same LET_GO_CAP_MS. A hand-over that reaches the cap goes anyway and says so (how:
// 'capped', RE1-7): what the page was still saving then is refused, so its last few seconds may be
// missing.
//
// The lookup fails closed (re-audit RE1-1): a lock manager that rejects query(), or lists the lock
// without a clientId, cannot tell this page whether the lock is still its own, so the page does not
// hold the wallet (how: 'unchecked'): it runs no wallet, lets the lock go and asks the person to
// close the other tabs and reload. Trusting the page's own flag there let a frozen holder whose lock
// was stolen write its old engine state over the new tab's.
//
// Without the Web Locks API (Safari before 15.4, old browsers) a BroadcastChannel presence check
// stands in: "anyone here?", wait PRESENCE_MS for an answer. Its limits: a tab that is frozen or
// slow to answer within that time is not seen (both tabs then run, as before this guard); two tabs
// starting within the same moment are told apart by an id, which covers the usual case but not a
// channel that drops messages; and "Take over anyway" only tells the other tab to stop (nothing can
// make a frozen tab stop before it thaws). Without BroadcastChannel either there is no guard.
// Two holes closed there (re-audit RE1-2): a page going into the back/forward cache (pagehide with
// persisted) no longer says "let-go" - it may come back still holding - and leaves when it is
// restored (how: 'away'; the app reloads it), refusing any write once it has been away longer than
// AWAY_GRACE_MS (writes already under way when it went still land); and a tab that is asking for the wallet
// answers "here?", so a tab starting during a hand-over does not go on as well.
//
// No dependencies: the stores import this, and the unit tests drive it with a fake
// navigator.locks and BroadcastChannel (test/unit/one_tab.test.mjs).

export const LOCK_NAME = 'campfire-firo-one-tab';
/** No answer from the holder: offer "Take over anyway". */
export const NO_ANSWER_MS = 10000;
/** The holder answered but has not let go yet (stopping waits for the sync step under way): offer it then. */
export const SLOW_LET_GO_MS = 45000;
/** The holder lets go after this even if locking and saving hang; nothing of it writes after that. */
export const LET_GO_CAP_MS = 30000;
/** The fallback's wait for "I'm here". */
export const PRESENCE_MS = 300;
/** How long a confirmed lock lookup is trusted (a frozen page's clock jumps past it). */
export const CHECK_TTL_MS = 500;
/** Without Web Locks: writes a page still makes this long after going into the back/forward cache (ones already under way). */
export const AWAY_GRACE_MS = 2000;

export class OtherTabError extends Error {
  constructor(message = 'Campfire is open in another tab.') {
    super(message);
    this.name = 'OtherTabError';
    this.code = 'other_tab';
  }
}

const randomId = () => {
  try {
    const b = new Uint8Array(8);
    globalThis.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(16).slice(2) + Date.now().toString(16);
  }
};

/**
 * States: idle (not asked yet: install screen, unit tests) -> held | busy. held -> letting-go
 * (another tab asked; still holds while it locks and saves) -> gone (how: 'handed'). held -> gone
 * (how: 'stolen'). busy | gone -> asking -> held.
 */
export class OneTab {
  constructor({
    name = LOCK_NAME,
    locks = globalThis.navigator && globalThis.navigator.locks,
    Channel = globalThis.BroadcastChannel,
    win = typeof window !== 'undefined' ? window : null,
    setTimer = (f, ms) => setTimeout(f, ms),
    clearTimer = (t) => clearTimeout(t),
    now = () => Date.now(),
    id = randomId(),
    noAnswerMs = NO_ANSWER_MS,
    slowMs = SLOW_LET_GO_MS,
    capMs = LET_GO_CAP_MS,
    presenceMs = PRESENCE_MS,
    ttlMs = CHECK_TTL_MS,
    awayGraceMs = AWAY_GRACE_MS,
    // In a page, nothing writes before claim() has answered (a second tab must not, even once);
    // elsewhere (unit tests, tools) there is no claim and writes go ahead.
    strictIdle = typeof window !== 'undefined',
  } = {}) {
    this.name = name;
    this.locks = locks && typeof locks.request === 'function' ? locks : null;
    this.Channel = typeof Channel === 'function' ? Channel : null;
    this.mode = this.locks ? 'locks' : this.Channel ? 'presence' : 'none';
    Object.assign(this, { win, setTimer, clearTimer, now, id, noAnswerMs, slowMs, capMs, presenceMs, ttlMs, awayGraceMs, strictIdle });
    this.state = 'idle';
    this.how = null; // why it is gone: 'handed' | 'capped' (handed at the cap) | 'stolen' | 'unchecked' (the lock could not be looked up) | 'away' (back/forward cache)
    this.busy = new Set(); // steps a hand-over waits for (whileBusy)
    this.unchecked = false; // a lookup could not be made: the next loss is said as 'unchecked'
    this.awayAt = null; // without Web Locks: when this holding page went into the back/forward cache
    this.spent = false; // let go once: never writes or opens a wallet again in this page
    this.ch = null;
    this.seq = 0; // lock requests made
    this.wanted = 0; // the request that may still hold the lock
    this.grant = 0; // the request that holds it
    this.release = null;
    this.clientId = null;
    this.checkedAt = 0;
    this.letGoHandler = null;
    this.leftHandlers = new Set();
    this.claiming = null;
    this.ask = null;
    this.heard = false;
    this.rivals = new Set();
    this.heldWaiters = [];
  }

  // ------------------------------------------------------------ what the app asks

  /** This page holds the lock (also while it locks and saves for a hand-over). */
  holds() {
    return this.state === 'held' || this.state === 'letting-go';
  }

  /** A wallet may be opened or its engine started here now (outside a page: no claim, no guard). */
  canOpen() {
    if (this.spent) return false;
    return this.state === 'held' || (this.state === 'idle' && !this.strictIdle);
  }

  /** A write may start now (synchronous; confirmWrite() also looks the lock up). */
  mayWrite() {
    if (this.spent) return false;
    return (this.state === 'idle' && !this.strictIdle) || this.holds();
  }

  /**
   * Whether this page may write to the wallet's storage now. idle: nothing was asked yet (allowed
   * only outside a page: the unit tests, tools). Otherwise the lock must be this page's, looked up in the browser's
   * lock manager, not taken from this page's own flag: a page frozen while another tab took over
   * learns it only after it thaws, maybe after its next write has started.
   */
  async confirmWrite() {
    if (!this.mayWrite()) return false;
    if (this.state === 'idle') return true;
    if (this.awayAt !== null && !(this.now() - this.awayAt <= this.awayGraceMs)) {
      // Restored from the back/forward cache, and this runs before its pageshow: another tab may
      // hold the wallet by now (the fallback cannot look it up).
      this.leave('away');
      return false;
    }
    if (this.mode !== 'locks') return true;
    if (this.clientId && this.now() - this.checkedAt < this.ttlMs && this.now() >= this.checkedAt) return true;
    if (!(await this.lookUp())) {
      this.lost();
      return false;
    }
    return this.mayWrite();
  }

  /**
   * Whether the browser's lock manager says this page holds the lock. Without Web Locks: its own
   * flag. With them, a lookup that cannot be made (query() rejects, or no clientId to compare) is
   * "not this page's" (RE1-1: fail closed), and the loss that follows is said as 'unchecked'.
   */
  async lookUp() {
    if (this.mode !== 'locks') return this.holds();
    if (!this.clientId) {
      this.unchecked = true;
      return false;
    }
    let q;
    try {
      q = await this.locks.query();
    } catch {
      this.unchecked = true;
      return false;
    }
    const mine = ((q && q.held) || []).find((l) => l.name === this.name);
    if (mine && !mine.clientId) {
      this.unchecked = true;
      return false;
    }
    if (!mine || mine.clientId !== this.clientId) return false;
    this.checkedAt = this.now();
    return this.holds();
  }

  /** Runs fn once this page holds the lock (now, if it does): start-up work that touches storage. */
  whenHeld(fn) {
    if (this.holds() && !this.spent) return void fn();
    this.heldWaiters.push(fn);
  }

  /**
   * Runs fn() so that a hand-over to another tab first waits for it (bounded by LET_GO_CAP_MS): a
   * step whose parts must not be split, such as a wallet's database and its record. Returns fn's result.
   */
  whileBusy(fn) {
    let p;
    try {
      p = Promise.resolve(fn());
    } catch (e) {
      p = Promise.reject(e);
    }
    const done = p.then(
      () => undefined,
      () => undefined,
    );
    this.busy.add(done);
    done.then(() => this.busy.delete(done));
    return p;
  }

  /** Resolves once no whileBusy step is running. */
  async settled() {
    while (this.busy.size) await Promise.all([...this.busy]);
  }

  /** fn(): locks the wallet and saves; called when another tab asks for it. Resolves when done. */
  onLetGo(fn) {
    this.letGoHandler = typeof fn === 'function' ? fn : null;
  }

  /** fn(how): this page let go ('handed') or the lock was taken ('stolen'). */
  onLeft(fn) {
    this.leftHandlers.add(fn);
    return () => this.leftHandlers.delete(fn);
  }

  /** At boot: 'held' (go on), 'busy' (another tab has it) or 'gone' (this page let go: reload). */
  claim() {
    if (this.holds()) return Promise.resolve('held');
    if (this.state === 'gone' || this.spent) return Promise.resolve('gone');
    if (this.state === 'asking' || this.state === 'letting-go') return Promise.resolve('busy');
    if (this.claiming) return this.claiming;
    this.claiming = (async () => {
      try {
        if (this.mode === 'none') {
          await this.becomeHolder();
          return 'held';
        }
        if (this.mode === 'locks') {
          if (await this.request({ ifAvailable: true })) {
            await this.becomeHolder();
            // A lock this page cannot look up guards nothing: it was let go ('unchecked').
            return this.holds() ? 'held' : 'gone';
          }
          this.open();
          this.state = 'busy';
          return 'busy';
        }
        // presence (no Web Locks): ask, wait, and among tabs starting together the lowest id goes on
        this.open();
        this.heard = false;
        this.rivals.clear();
        this.state = 'claiming';
        this.post('here?');
        await new Promise((r) => this.setTimer(r, this.presenceMs));
        // "Use it here instead" was tapped meanwhile: that flow decides.
        if (this.state !== 'claiming') return this.holds() ? 'held' : 'busy';
        if (this.heard || [...this.rivals].some((r) => r < this.id)) {
          this.state = 'busy';
          return 'busy';
        }
        await this.becomeHolder();
        return 'held';
      } finally {
        this.claiming = null;
      }
    })();
    return this.claiming;
  }

  /**
   * "Use it here instead": asks the holder to let go and waits for the lock. onNoAnswer({acked}) is
   * called when the holder has not answered within NO_ANSWER_MS (or answered but has not let go
   * within SLOW_LET_GO_MS): then stealNow() is the way on. Resolves 'held'.
   */
  takeOver({ onNoAnswer = null } = {}) {
    if (this.holds()) return Promise.resolve('held');
    if (this.ask) return this.ask.done;
    const ask = { acked: false, timer: null, stealing: false, ctl: null };
    ask.done = new Promise((resolve, reject) => {
      ask.resolve = resolve;
      ask.reject = reject;
    });
    this.ask = ask;
    this.state = 'asking';
    this.open();
    const arm = (ms) => {
      this.clearTimer(ask.timer);
      ask.timer = this.setTimer(() => {
        if (this.ask === ask && !ask.stealing && onNoAnswer) onNoAnswer({ acked: ask.acked });
      }, ms);
    };
    ask.onAck = () => {
      if (ask.acked) return;
      ask.acked = true;
      arm(this.slowMs);
    };
    arm(this.noAnswerMs);
    if (this.mode === 'locks') {
      ask.ctl = typeof AbortController === 'function' ? new AbortController() : null;
      this.request(ask.ctl ? { signal: ask.ctl.signal } : {}).then(
        (ok) => ok && this.granted(ask),
        (e) => !ask.stealing && this.askFailed(ask, e),
      );
      this.post('take-over');
    } else if (this.mode === 'presence') {
      ask.onFreed = () => this.granted(ask);
      this.post('take-over');
    } else this.granted(ask);
    return ask.done;
  }

  /** "Take over anyway": the holder did not answer. Its lock is taken; it must never write again. */
  stealNow() {
    if (this.holds()) return Promise.resolve('held');
    const ask = this.ask;
    if (!ask) return this.takeOver().then(() => 'held');
    if (ask.stealing) return ask.done;
    ask.stealing = true;
    if (this.mode === 'locks') {
      if (ask.ctl) ask.ctl.abort();
      this.request({ steal: true }).then(
        (ok) => ok && this.granted(ask),
        (e) => this.askFailed(ask, e),
      );
    } else {
      this.post('stolen');
      this.granted(ask);
    }
    return ask.done;
  }

  // ------------------------------------------------------------ inside

  /** One lock request; resolves true when granted, false when refused (ifAvailable). */
  request(opts) {
    const seq = ++this.seq;
    this.wanted = seq;
    return new Promise((resolve, reject) => {
      let granted = false;
      let p;
      try {
        p = this.locks.request(this.name, opts, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          // A request this page gave up on (a steal replaced it): let go at once.
          if (this.wanted !== seq) {
            resolve(false);
            return undefined;
          }
          granted = true;
          this.grant = seq;
          return new Promise((release) => {
            this.release = release;
            resolve(true);
          });
        });
      } catch (e) {
        reject(e);
        return;
      }
      Promise.resolve(p).then(
        () => {
          // Released by this page (a hand-over): nothing to do. Anything else is a loss.
          if (granted && this.grant === seq && this.holds()) this.lost();
        },
        (e) => {
          if (!granted) return reject(e);
          // Taken by another tab ({ steal: true }): the request rejects with an AbortError.
          if (this.grant === seq) this.lost();
        },
      );
    });
  }

  async becomeHolder() {
    this.state = 'held';
    this.how = null;
    this.open();
    if (this.mode === 'locks') {
      await this.learnClientId();
      // Fail closed (RE1-1): without its clientId this page could never check, at a write, that the
      // lock is still its own. It does not hold the wallet: no wallet runs, the lock is let go.
      if (!this.clientId && !this.spent) {
        this.unchecked = true;
        this.lost();
      }
    }
    if (this.spent) return;
    for (const fn of this.heldWaiters.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  async learnClientId() {
    try {
      const q = await this.locks.query();
      const mine = ((q && q.held) || []).filter((l) => l.name === this.name);
      if (mine.length === 1 && mine[0].clientId) {
        this.clientId = mine[0].clientId;
        this.checkedAt = this.now();
      }
    } catch {
      /* no lookup: clientId stays null and becomeHolder() refuses (fail closed) */
    }
  }

  async granted(ask) {
    if (this.ask !== ask) return;
    this.clearTimer(ask.timer);
    this.ask = null;
    await this.becomeHolder();
    ask.resolve(this.holds() ? 'held' : 'gone');
  }

  askFailed(ask, e) {
    if (this.ask !== ask) return;
    this.clearTimer(ask.timer);
    this.ask = null;
    this.state = this.spent ? 'gone' : 'busy';
    ask.reject(e);
  }

  /** Another tab asked: lock and save (the app's handler), then let go and say so. */
  async letGo() {
    if (this.state !== 'held') return;
    this.state = 'letting-go';
    // Heard late (this page was frozen while the asking tab took the lock): nothing to hand over,
    // and nothing may be saved - the other tab's data is newer.
    if (!(await this.lookUp())) return this.lost();
    this.post('letting-go');
    let capped = false;
    if (this.letGoHandler || this.busy.size) {
      let timer = null;
      // First what must not be split (a wallet's database and its record), then lock and save; the cap
      // bounds both. Past the cap nothing more of it runs as part of the hand-over.
      const work = (async () => {
        await this.settled();
        if (this.state === 'letting-go' && !capped && this.letGoHandler) await this.letGoHandler();
      })().catch((e) => console.warn('[campfire] one tab: locking for the other tab', e && e.message));
      try {
        await Promise.race([
          work,
          new Promise((r) => {
            timer = this.setTimer(() => {
              capped = true;
              r();
            }, this.capMs);
          }),
        ]);
      } finally {
        this.clearTimer(timer);
      }
    }
    if (this.state !== 'letting-go') return; // lost meanwhile
    // Taken while locking (the other tab gave up waiting): its saves from then on were refused.
    if (!(await this.lookUp())) return this.lost();
    this.leave(capped ? 'capped' : 'handed');
    const r = this.release;
    this.release = null;
    if (r) r();
    this.post('let-go');
  }

  /**
   * The lock is no longer this page's (taken, or found taken), or this page cannot tell whether it
   * is ('unchecked'): then the lock is also let go, since it guards nothing here.
   */
  lost() {
    if (this.state === 'gone') return;
    const r = this.unchecked ? this.release : null;
    this.release = null;
    this.leave(this.unchecked ? 'unchecked' : 'stolen');
    if (r) r();
  }

  leave(how) {
    this.state = 'gone';
    this.how = how;
    this.spent = true;
    for (const fn of this.leftHandlers) {
      try {
        fn(how);
      } catch (e) {
        console.error(e);
      }
    }
  }

  open() {
    if (this.ch || !this.Channel) return;
    try {
      this.ch = new this.Channel(this.name);
      this.ch.onmessage = (e) => this.onMessage(e && e.data);
    } catch {
      this.ch = null;
    }
    if (this.win && typeof this.win.addEventListener === 'function') {
      // Closing: the lock goes with the page; tabs waiting in the fallback learn it here. Into the
      // back/forward cache (persisted) the fallback's page keeps "holding" and may come back: it says
      // nothing (a tab asking meanwhile offers "Take over anyway" after its wait), and when it is
      // restored it leaves (RE1-2). Writes already under way when it went still land.
      this.win.addEventListener('pagehide', (e) => {
        if (!this.holds()) return;
        if (this.mode === 'presence' && e && e.persisted) {
          if (this.awayAt === null) this.awayAt = this.now();
          return;
        }
        this.post('let-go');
      });
      this.win.addEventListener('pageshow', (e) => {
        if (e && e.persisted && this.awayAt !== null && this.state !== 'gone') this.leave('away');
      });
    }
  }

  post(t) {
    if (!this.ch) return;
    try {
      this.ch.postMessage({ app: this.name, t, from: this.id, at: this.now() });
    } catch {
      /* closed */
    }
  }

  onMessage(m) {
    if (!m || typeof m !== 'object' || m.app !== this.name || m.from === this.id) return;
    switch (m.t) {
      case 'take-over':
        // The fallback cannot look the lock up: a request this page hears only after a freeze is
        // old news (the asking tab has offered "Take over anyway" since), and saving now could
        // overwrite what that tab did. With Web Locks, confirmWrite() refuses such a save anyway.
        if (this.mode === 'presence' && !(this.now() - Number(m.at) < this.noAnswerMs)) break;
        if (this.state === 'held') this.letGo();
        else if (this.state === 'letting-go') this.post('letting-go');
        break;
      case 'letting-go':
        if (this.ask) this.ask.onAck();
        break;
      case 'let-go':
        if (this.ask && this.ask.onFreed) this.ask.onFreed();
        break;
      case 'here?':
        // A tab asking for the wallet answers too: it is about to hold it (RE1-2).
        if (this.holds() || this.state === 'asking') this.post('here');
        else if (this.state === 'claiming') {
          // Two tabs starting together: the later one did not exist when the first asked, so the
          // first says it is starting too; both then let the lower id go on.
          this.rivals.add(String(m.from));
          this.post('starting');
        }
        break;
      case 'starting':
        if (this.state === 'claiming') this.rivals.add(String(m.from));
        break;
      case 'here':
        this.heard = true;
        break;
      case 'stolen':
        // The fallback's "Take over anyway": the asking tab goes on without this one.
        if (this.mode === 'presence' && this.holds()) this.lost();
        break;
      default:
    }
  }
}

/** This page's guard (made on first use; nothing is opened before claim()). */
let single = null;
export function oneTab() {
  if (!single) single = new OneTab();
  return single;
}

/** Throws OtherTabError unless this page may open a wallet now. */
export function needThisTab() {
  if (!oneTab().canOpen()) throw new OtherTabError();
}
