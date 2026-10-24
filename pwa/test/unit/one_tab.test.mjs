// One tab at a time (lib/one_tab.js), driven by a fake navigator.locks (one lock manager shared by
// the "tabs", with ifAvailable, steal, signal and query as the Web Locks spec has them) and a fake
// BroadcastChannel whose messages a frozen tab only receives once it thaws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OneTab, OtherTabError, LOCK_NAME } from '../../src/lib/one_tab.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MS = { noAnswerMs: 60, slowMs: 200, capMs: 80, presenceMs: 25, ttlMs: 0 };

/** One browser's lock manager. client() is one tab's navigator.locks. */
function lockManager() {
  let held = null;
  // query(): 'ok' (as the spec has it), 'no-client-id' (LockInfo without clientId) or 'throws'.
  let queryMode = 'ok';
  const queue = [];
  const frozen = new Map(); // clientId -> settlements held back until thaw()
  let clients = 0;
  const abortError = () => Object.assign(new Error('The request was aborted.'), { name: 'AbortError' });
  const deliver = (entry, fn) => {
    if (frozen.has(entry.clientId)) frozen.get(entry.clientId).push(fn);
    else fn();
  };
  function grant(entry) {
    held = entry;
    Promise.resolve().then(() => {
      let ret;
      try {
        ret = entry.cb({ name: entry.name, mode: 'exclusive' });
      } catch (e) {
        return finish(entry, () => entry.reject(e));
      }
      Promise.resolve(ret).then(
        (v) => finish(entry, () => entry.resolve(v)),
        (e) => finish(entry, () => entry.reject(e)),
      );
    });
  }
  function finish(entry, settle) {
    if (held !== entry) return; // taken by a steal: already settled
    held = null;
    settle();
    if (!held && queue.length) grant(queue.shift());
  }
  return {
    get holder() {
      return held ? held.clientId : null;
    },
    get queued() {
      return queue.length;
    },
    set queryMode(m) {
      queryMode = m;
    },
    /** The tab's page is frozen: it learns nothing (no rejection) until thaw(). */
    freeze(clientId) {
      frozen.set(clientId, []);
    },
    thaw(clientId) {
      const q = frozen.get(clientId) || [];
      frozen.delete(clientId);
      q.forEach((fn) => fn());
    },
    client() {
      const clientId = `client-${++clients}`;
      return {
        clientId,
        request(name, opts, cb) {
          return new Promise((resolve, reject) => {
            const entry = { name, clientId, cb, resolve, reject };
            if (opts.steal) {
              if (held) {
                const old = held;
                held = null;
                deliver(old, () => old.reject(abortError()));
              }
              return grant(entry);
            }
            if (opts.ifAvailable) {
              if (held || queue.length) return Promise.resolve().then(() => cb(null)).then(resolve, reject);
              return grant(entry);
            }
            if (opts.signal) {
              if (opts.signal.aborted) return reject(abortError());
              opts.signal.addEventListener('abort', () => {
                const i = queue.indexOf(entry);
                if (i >= 0) {
                  queue.splice(i, 1);
                  reject(abortError());
                }
              });
            }
            if (!held && !queue.length) grant(entry);
            else queue.push(entry);
          });
        },
        async query() {
          if (queryMode === 'throws') throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' });
          const info = (e) => ({ name: e.name, mode: 'exclusive', ...(queryMode === 'no-client-id' ? {} : { clientId: e.clientId }) });
          return { held: held ? [info(held)] : [], pending: queue.map(info) };
        },
      };
    },
  };
}

/** One browser's BroadcastChannel: messages go to the other instances of the same name. */
function channelBus() {
  const members = new Set();
  return class FakeChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      this.paused = false;
      this.inbox = [];
      members.add(this);
    }
    postMessage(data) {
      const copy = structuredClone(data);
      for (const m of members) if (m !== this && m.name === this.name) setImmediate(() => m.deliver(copy));
    }
    deliver(data) {
      if (this.paused) return this.inbox.push(data);
      if (this.onmessage) this.onmessage({ data });
    }
    resume() {
      this.paused = false;
      this.inbox.splice(0).forEach((d) => this.deliver(d));
    }
    close() {
      members.delete(this);
    }
  };
}

function browser({ locks = true } = {}) {
  const lm = lockManager();
  const Channel = channelBus();
  const tab = (extra = {}) => {
    const l = locks ? lm.client() : null;
    const t = new OneTab({ locks: l, Channel, win: null, ...MS, ...extra });
    t.left = [];
    t.onLeft((how) => t.left.push(how));
    t.lockClient = l;
    return t;
  };
  return { lm, tab };
}

test('the lock is free: the tab holds it for the page; a second tab is told another has it', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  assert.equal(a.state, 'idle');
  assert.equal(a.mayWrite(), true, 'outside a page (unit tests, tools) nothing is claimed and nothing is stopped');
  assert.equal(a.canOpen(), true);
  assert.equal(await a.claim(), 'held');
  assert.equal(a.mode, 'locks');
  assert.equal(lm.holder, a.lockClient.clientId);
  assert.equal(a.clientId, a.lockClient.clientId, 'it knows its own client id (to look the lock up later)');
  assert.equal(await a.claim(), 'held', 'asking again changes nothing');
  assert.equal(await b.claim(), 'busy');
  assert.equal(lm.holder, a.lockClient.clientId, 'ifAvailable: the second tab neither waits nor takes it');
  assert.equal(lm.queued, 0);
  assert.equal(b.canOpen(), false);
  assert.equal(b.mayWrite(), false);
  assert.equal(await b.confirmWrite(), false);
  assert.equal(a.canOpen(), true);
  assert.equal(await a.confirmWrite(), true);
  assert.equal(LOCK_NAME, 'campfire-firo-one-tab');
});

test('"Use it here instead": the holder locks and saves while it still holds the lock, lets go, and the asking tab gets it', async () => {
  const { lm, tab } = browser();
  const a = tab();
  // The asking tab's waits are longer here than the file's: this test proves an answered hand-over
  // never offers "Take over anyway" afterwards, and 60 ms of wall time was missed on a loaded machine
  // (the whole unit suite at once), offering it before the answer could come.
  const slow = { noAnswerMs: 1000, slowMs: 1500 };
  const b = tab(slow);
  await a.claim();
  await b.claim();
  const events = [];
  a.onLetGo(async () => {
    events.push(['a locks and saves', a.holds(), await a.confirmWrite(), a.canOpen()]);
    await sleep(15);
    events.push('a saved');
  });
  let noAnswer = 0;
  const r = await b.takeOver({ onNoAnswer: () => noAnswer++ });
  events.push('b holds');
  assert.equal(r, 'held');
  assert.deepEqual(events, [['a locks and saves', true, true, false], 'a saved', 'b holds'], 'the lock moved only after A saved; A opened nothing new meanwhile');
  assert.deepEqual(a.left, ['handed']);
  assert.equal(a.state, 'gone');
  assert.equal(a.how, 'handed');
  assert.equal(a.mayWrite(), false);
  assert.equal(await a.confirmWrite(), false);
  assert.equal(a.canOpen(), false);
  assert.equal(await a.claim(), 'gone', 'a tab that let go must reload before it holds the wallet again');
  assert.equal(b.canOpen(), true);
  assert.equal(await b.confirmWrite(), true);
  assert.equal(lm.holder, b.lockClient.clientId);
  await sleep(slow.slowMs + 30);
  assert.equal(noAnswer, 0, 'an answered hand-over never offers "Take over anyway"');
});

test('a frozen holder: nothing is taken by waiting; "Take over anyway" steals, and the frozen tab never writes again', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  let aSaved = 0;
  a.onLetGo(async () => {
    aSaved++;
  });
  await a.claim();
  await b.claim();
  // A is frozen: its page hears nothing (no message, no lock news) until it thaws.
  a.ch.paused = true;
  lm.freeze(a.lockClient.clientId);
  let offered = null;
  const done = b.takeOver({ onNoAnswer: (x) => (offered = x) });
  await sleep(MS.noAnswerMs + 40);
  assert.deepEqual(offered, { acked: false }, 'no answer within the wait: "Take over anyway" is offered');
  assert.equal(b.state, 'asking');
  assert.equal(lm.holder, a.lockClient.clientId, 'waiting alone takes nothing');
  assert.equal(lm.queued, 1, 'B waits for the lock with a normal request');
  assert.equal(await b.stealNow(), 'held');
  assert.equal(await done, 'held');
  assert.equal(lm.holder, b.lockClient.clientId);
  assert.equal(lm.queued, 0, "B's waiting request was withdrawn: it can never be granted later");
  // A is still frozen and believes it holds the lock. Its next write looks the lock up first.
  assert.equal(a.state, 'held');
  assert.equal(await a.confirmWrite(), false, 'the frozen tab finds out at its next write, from the lock manager');
  assert.deepEqual(a.left, ['stolen']);
  assert.equal(a.mayWrite(), false);
  // It thaws: the queued "take-over" and the lock's AbortError arrive late and change nothing.
  lm.thaw(a.lockClient.clientId);
  a.ch.resume();
  await sleep(20);
  assert.equal(aSaved, 0, 'a tab that lost the lock never saves (it would overwrite the new tab)');
  assert.deepEqual(a.left, ['stolen'], 'told once');
  assert.equal(await a.confirmWrite(), false);
  assert.equal(b.canOpen(), true);
});

test('a frozen holder that hears the request before the news of the steal neither saves nor says it handed over', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  let aSaved = 0;
  a.onLetGo(async () => {
    aSaved++;
  });
  await a.claim();
  await b.claim();
  a.ch.paused = true;
  lm.freeze(a.lockClient.clientId);
  await b.takeOver({ onNoAnswer: () => b.stealNow() });
  // It thaws, and its BroadcastChannel runs before the lock's AbortError reaches it.
  a.ch.resume();
  await sleep(20);
  assert.equal(aSaved, 0, 'the late request was not acted on: the lock manager says the lock is B\'s');
  assert.equal(a.how, 'stolen');
  assert.deepEqual(a.left, ['stolen']);
  lm.thaw(a.lockClient.clientId);
  await sleep(10);
  assert.deepEqual(a.left, ['stolen'], 'told once');
  assert.equal(lm.holder, b.lockClient.clientId);
});

test('stolen while awake: the AbortError alone tells the old holder, at once', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  a.onLetGo(() => new Promise(() => {})); // would never finish: B must steal
  await a.claim();
  await b.claim();
  a.ch.paused = true; // it does not hear the request
  const p = b.takeOver({ onNoAnswer: () => b.stealNow() });
  assert.equal(await p, 'held');
  await sleep(10);
  assert.equal(a.state, 'gone');
  assert.equal(a.how, 'stolen');
  assert.deepEqual(a.left, ['stolen']);
  assert.equal(lm.holder, b.lockClient.clientId);
});

test('after a steal, handing over again goes to the tab that asks, and the stealing tab is not granted twice', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  const c = tab();
  await a.claim();
  await b.claim();
  await c.claim();
  a.ch.paused = true;
  lm.freeze(a.lockClient.clientId);
  await b.takeOver({ onNoAnswer: () => b.stealNow() });
  b.onLetGo(async () => {});
  assert.equal(await c.takeOver(), 'held');
  assert.equal(lm.holder, c.lockClient.clientId);
  await sleep(20);
  assert.equal(lm.holder, c.lockClient.clientId, "B's withdrawn request did not come back");
  assert.deepEqual(b.left, ['handed']);
  assert.equal(c.canOpen(), true);
});

test('a hand-over waits for a step that must not be split, then locks and saves; the asking tab gets the wallet after both', async () => {
  const { lm, tab } = browser();
  const a = tab({ capMs: 2000 });
  const b = tab();
  const events = [];
  a.onLetGo(async () => {
    events.push(['locks and saves', await a.confirmWrite()]);
  });
  await a.claim();
  await b.claim();
  let finish;
  const step = a.whileBusy(async () => {
    events.push('file');
    await new Promise((r) => (finish = r));
    events.push(['record', await a.confirmWrite()]);
    return 'made';
  });
  const done = b.takeOver();
  await sleep(30);
  assert.equal(a.state, 'letting-go');
  assert.equal(lm.holder, a.lockClient.clientId, 'not handed over in the middle of the step');
  assert.deepEqual(events, ['file']);
  finish();
  assert.equal(await step, 'made', 'whileBusy gives back what the step returns');
  assert.equal(await done, 'held');
  assert.deepEqual(events, ['file', ['record', true], ['locks and saves', true]], 'the record was written while this tab still held the wallet');
  assert.equal(a.how, 'handed');
  assert.equal(a.busy.size, 0);
});

test('a step that fails still lets the hand-over go on; whileBusy passes the failure on', async () => {
  const { tab } = browser();
  const a = tab();
  const b = tab();
  a.onLetGo(async () => {});
  await a.claim();
  await b.claim();
  const step = a.whileBusy(async () => {
    await sleep(10);
    throw new Error('storage refused');
  });
  const done = b.takeOver();
  await assert.rejects(step, /storage refused/);
  assert.equal(await done, 'held');
  assert.equal(a.how, 'handed');
});

test('the holder answers but locking takes long: "Take over anyway" waits for the longer time', async () => {
  const { tab } = browser();
  const a = tab({ capMs: 2000 });
  const b = tab();
  let release;
  a.onLetGo(() => new Promise((r) => (release = r)));
  await a.claim();
  await b.claim();
  let offered = null;
  const done = b.takeOver({ onNoAnswer: (x) => (offered = x) });
  await sleep(MS.noAnswerMs + 30);
  assert.equal(offered, null, 'it answered: no offer at the short wait');
  assert.equal(a.state, 'letting-go');
  release();
  assert.equal(await done, 'held');
  assert.equal(offered, null);
});

test('a hand-over whose locking hangs lets go after the cap, and from then on that tab writes nothing', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  a.onLetGo(() => new Promise(() => {}));
  await a.claim();
  await b.claim();
  const t0 = Date.now();
  assert.equal(await b.takeOver(), 'held');
  assert.ok(Date.now() - t0 >= MS.capMs - 5, 'it waited for the cap');
  // Said as such (re-audit RE1-7): what it was still saving then is refused, so "locked and saved
  // here" would not be true.
  assert.equal(a.how, 'capped');
  assert.deepEqual(a.left, ['capped']);
  assert.equal(a.mayWrite(), false);
  assert.equal(await a.confirmWrite(), false);
  assert.equal(lm.holder, b.lockClient.clientId);
});

test('a tab that let go can ask for the wallet back, but must reload to use it (its memory is the old copy)', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  a.onLetGo(async () => {});
  b.onLetGo(async () => {});
  await a.claim();
  await b.claim();
  await b.takeOver();
  assert.equal(a.state, 'gone');
  assert.equal(await a.takeOver(), 'held');
  assert.equal(lm.holder, a.lockClient.clientId);
  assert.deepEqual(b.left, ['handed']);
  assert.equal(a.holds(), true);
  assert.equal(a.canOpen(), false, 'spent: no wallet opens in this page');
  assert.equal(a.mayWrite(), false, 'spent: nothing is written from this page');
  assert.equal(await a.confirmWrite(), false);
});

test('in a page nothing writes before claim() answers; start-up work waits until the tab holds the wallet', async () => {
  const { tab } = browser();
  const a = tab({ strictIdle: true });
  const b = tab({ strictIdle: true });
  assert.equal(a.mayWrite(), false);
  assert.equal(await a.confirmWrite(), false);
  assert.equal(a.canOpen(), false, 'no wallet opens before the tab holds the lock');
  const ran = [];
  a.whenHeld(() => ran.push('a'));
  b.whenHeld(() => ran.push('b'));
  assert.deepEqual(ran, []);
  await a.claim();
  await b.claim();
  assert.deepEqual(ran, ['a'], 'only the holder runs it');
  a.whenHeld(() => ran.push('a again'));
  assert.deepEqual(ran, ['a', 'a again'], 'at once once held');
  a.onLetGo(async () => {});
  await b.takeOver();
  assert.deepEqual(ran, ['a', 'a again', 'b'], 'the other tab runs it when it takes over');
});

test('a write refused while it is not this tab: OtherTabError says so', () => {
  const e = new OtherTabError();
  assert.equal(e.code, 'other_tab');
  assert.match(e.message, /open in another tab/);
});

test('the lock looked up, not trusted: a confirmed check is reused only briefly', async () => {
  let clock = 1000;
  const { lm, tab } = browser();
  const a = tab({ ttlMs: 500, now: () => clock });
  const b = tab({ now: () => clock });
  await a.claim();
  await b.claim();
  lm.freeze(a.lockClient.clientId);
  a.ch.paused = true;
  await b.takeOver({ onNoAnswer: () => b.stealNow() });
  // Inside the short window after A's last check a write still passes: A was not frozen long
  // (a steal is offered only after NO_ANSWER_MS without an answer, far longer than this window).
  assert.equal(await a.confirmWrite(), true);
  clock += 600;
  assert.equal(await a.confirmWrite(), false);
  assert.deepEqual(a.left, ['stolen']);
});

// Re-audit RE1-1: a lock manager that cannot be asked (query() rejects, or gives no clientId) used to
// leave the page trusting its own flag, so a frozen holder whose lock was stolen kept flushing its
// old copy over the new tab's. Now it fails closed: such a page does not hold the wallet.
for (const [mode, label] of [
  ['no-client-id', 'gives no clientId'],
  ['throws', 'rejects'],
]) {
  test(`a lock manager whose query() ${label}: no tab runs a wallet, each says so and lets the lock go`, async () => {
    const { lm, tab } = browser();
    lm.queryMode = mode;
    const a = tab();
    const b = tab();
    const ran = [];
    a.whenHeld(() => ran.push('a'));
    assert.equal(await a.claim(), 'gone');
    assert.equal(a.how, 'unchecked');
    assert.deepEqual(a.left, ['unchecked']);
    assert.equal(a.canOpen(), false);
    assert.equal(a.mayWrite(), false);
    assert.equal(await a.confirmWrite(), false);
    assert.deepEqual(ran, [], 'start-up work that touches storage never runs');
    assert.equal(lm.holder, null, 'the lock is let go: it guards nothing here');
    assert.equal(await b.claim(), 'gone', 'the next tab finds the same and refuses too');
    assert.equal(b.how, 'unchecked');
    assert.equal(await a.claim(), 'gone', 'a reload is needed to ask again');
  });
}

test("the audit's PoC: the lock manager stops answering while a frozen holder's lock is stolen - the old holder never writes again", async () => {
  for (const mode of ['no-client-id', 'throws']) {
    const { lm, tab } = browser();
    const a = tab();
    const b = tab();
    let aSaved = 0;
    a.onLetGo(async () => {
      aSaved++;
    });
    assert.equal(await a.claim(), 'held');
    await b.claim();
    a.ch.paused = true;
    lm.freeze(a.lockClient.clientId);
    await b.takeOver({ onNoAnswer: () => b.stealNow() });
    assert.equal(lm.holder, b.lockClient.clientId, 'B stole the lock');
    lm.queryMode = mode;
    assert.equal(await a.confirmWrite(), false, `${mode}: A's next flush is refused (it used to pass)`);
    assert.equal(a.mayWrite(), false);
    assert.equal(aSaved, 0);
    assert.ok(['unchecked', 'stolen'].includes(a.how), a.how);
  }
});

test('the lock manager stops answering while this tab holds the wallet: it stops, refuses the write and lets the lock go', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  assert.equal(await a.claim(), 'held');
  assert.equal(await a.confirmWrite(), true);
  lm.queryMode = 'throws';
  assert.equal(await a.confirmWrite(), false);
  assert.equal(a.how, 'unchecked');
  assert.deepEqual(a.left, ['unchecked']);
  await sleep(5);
  assert.equal(lm.holder, null, 'let go: another tab may ask (and, while the browser cannot be asked, is refused too)');
  assert.equal(await b.claim(), 'gone');
  lm.queryMode = 'ok';
  const c = tab();
  assert.equal(await c.claim(), 'held', 'once the browser answers again a new page goes on');
});

test('"Use it here instead" in a browser that cannot be asked: the asking tab does not hold the wallet either', async () => {
  const { lm, tab } = browser();
  const a = tab();
  const b = tab();
  a.onLetGo(async () => {});
  await a.claim();
  await b.claim();
  lm.queryMode = 'no-client-id';
  const r = await b.takeOver();
  assert.equal(r, 'gone');
  assert.equal(b.how, 'unchecked');
  assert.equal(b.canOpen(), false);
  assert.equal(await b.confirmWrite(), false);
});

// ------------------------------------------------------------ without Web Locks

test('without Web Locks: a BroadcastChannel presence check; the second tab is told, and the hand-over works', async () => {
  const { tab } = browser({ locks: false });
  const a = tab();
  const b = tab();
  a.onLetGo(async () => {});
  assert.equal(await a.claim(), 'held');
  assert.equal(a.mode, 'presence');
  assert.equal(await b.claim(), 'busy');
  assert.equal(b.mayWrite(), false);
  assert.equal(await b.takeOver(), 'held');
  assert.equal(a.state, 'gone');
  assert.equal(a.how, 'handed');
  assert.equal(b.canOpen(), true);
  assert.equal(await a.confirmWrite(), false);
});

test('without Web Locks: two tabs starting together - exactly one goes on', async () => {
  const { tab } = browser({ locks: false });
  const a = tab();
  const b = tab();
  const [ra, rb] = await Promise.all([a.claim(), b.claim()]);
  assert.deepEqual([ra, rb].sort(), ['busy', 'held']);
});

test('without Web Locks: "Take over anyway" tells a frozen tab to stop; once thawed it neither saves nor writes', async () => {
  const { tab } = browser({ locks: false });
  const a = tab();
  const b = tab();
  let aSaved = 0;
  a.onLetGo(async () => {
    aSaved++;
  });
  await a.claim();
  await b.claim();
  a.ch.paused = true;
  let offered = null;
  const p = b.takeOver({ onNoAnswer: (x) => (offered = x) });
  await sleep(MS.noAnswerMs + 30);
  assert.deepEqual(offered, { acked: false });
  await b.stealNow();
  assert.equal(await p, 'held');
  a.ch.resume(); // the old "take-over" (stale by now) and "stolen" arrive
  await sleep(20);
  assert.equal(aSaved, 0, 'the stale request was not acted on: saving now would overwrite the new tab');
  assert.equal(a.state, 'gone');
  assert.equal(a.how, 'stolen');
  assert.equal(a.mayWrite(), false);
});

// Re-audit RE1-2: the fallback could end with two holders. (1) pagehide posted "let-go" also when the
// page went into the back/forward cache (persisted): the asking tab took the wallet, and the page
// resumed as a holder when restored. (2) A tab that was asking answered nobody's "here?", so a tab
// starting meanwhile heard silence and went on too.
function pageWindow() {
  const on = { pagehide: [], pageshow: [] };
  return {
    addEventListener: (type, fn) => on[type] && on[type].push(fn),
    fire: (type, e) => on[type].forEach((fn) => fn(e)),
  };
}

test('without Web Locks: a page that goes into the back/forward cache never tells the asking tab it is free, and on its return it leaves', async () => {
  let clock = 1000;
  let cached = false; // A is in the back/forward cache: its timers do not run
  const { tab } = browser({ locks: false });
  const win = pageWindow();
  const a = tab({ win, now: () => clock, awayGraceMs: 2000, setTimer: (f, ms) => setTimeout(() => !cached && f(), ms) });
  const b = tab({ now: () => clock });
  a.onLetGo(() => new Promise(() => {})); // still locking (a slow engine stop) when the person leaves
  assert.equal(await a.claim(), 'held');
  assert.equal(await b.claim(), 'busy');
  let offered = null;
  const done = b.takeOver({ onNoAnswer: (x) => (offered = x) });
  await sleep(10);
  win.fire('pagehide', { persisted: true });
  // The save on the way out (the wallet's own pagehide listener runs after this one) still goes.
  assert.equal(await a.confirmWrite(), true, 'the leaving save is not refused');
  a.ch.paused = true; // in the cache: it hears nothing, runs nothing
  cached = true;
  await sleep(30);
  assert.equal(b.holds(), false, 'B was not told the wallet is free: A may come back holding it');
  // B's wait runs out ("Take over anyway"); A, in the cache, does not hear it.
  await sleep(MS.slowMs);
  assert.ok(offered, '"Take over anyway" is offered');
  assert.equal(await b.stealNow(), 'held');
  assert.equal(await done, 'held');
  // Restored later: a write that runs before its pageshow is refused (it has been away too long) ...
  clock += 60000;
  assert.equal(await a.confirmWrite(), false);
  assert.equal(a.how, 'away');
  // ... and pageshow says it left (the app reloads it: its memory is the old copy).
  win.fire('pageshow', { persisted: true });
  assert.deepEqual(a.left, ['away'], 'told once');
  assert.equal(a.mayWrite(), false);
  assert.equal(a.canOpen(), false);
  assert.equal(await b.confirmWrite(), true, 'one writer');
});

test('without Web Locks: restored from the back/forward cache with nobody else around, the page still leaves (and reloads)', async () => {
  const { tab } = browser({ locks: false });
  const win = pageWindow();
  const a = tab({ win });
  assert.equal(await a.claim(), 'held');
  win.fire('pagehide', { persisted: true });
  win.fire('pageshow', { persisted: true });
  assert.deepEqual(a.left, ['away']);
  assert.equal(a.mayWrite(), false);
});

test("without Web Locks: a page that really closes still tells the asking tab at once", async () => {
  const { tab } = browser({ locks: false });
  const win = pageWindow();
  const a = tab({ win });
  const b = tab();
  a.onLetGo(() => new Promise(() => {}));
  await a.claim();
  await b.claim();
  let offered = null;
  const done = b.takeOver({ onNoAnswer: (x) => (offered = x) });
  await sleep(10);
  win.fire('pagehide', { persisted: false });
  assert.equal(await done, 'held');
  assert.equal(offered, null, 'no wait for "Take over anyway"');
  assert.deepEqual(a.left, []);
});

test('without Web Locks: a tab starting while another asks for the wallet hears it, and does not go on', async () => {
  const { tab } = browser({ locks: false });
  const a = tab();
  const b = tab();
  const c = tab();
  await a.claim();
  await b.claim();
  a.ch.paused = true; // the holder is asleep: it answers nothing
  const done = b.takeOver({ onNoAnswer: () => b.stealNow() });
  await sleep(5);
  assert.equal(b.state, 'asking');
  assert.equal(await c.claim(), 'busy', 'the asking tab answered "here": the wallet is about to be its');
  assert.equal(await done, 'held');
  assert.equal(c.holds(), false);
  assert.equal(await c.confirmWrite(), false);
});

test('neither Web Locks nor BroadcastChannel: no guard (the page goes on)', async () => {
  const t = new OneTab({ locks: null, Channel: null, win: null, ...MS });
  assert.equal(t.mode, 'none');
  assert.equal(await t.claim(), 'held');
  assert.equal(t.canOpen(), true);
  assert.equal(await t.confirmWrite(), true);
});
