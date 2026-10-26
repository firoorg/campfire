// Where Back goes: the screens the person came through, newest last, kept in
// memory only (a reload or a lock starts again). app.go() records the screen
// it leaves; app.back() returns to the newest one, with the params it had.
//
// - A root starts a fresh history: Wallet, Ethereum, Activity, Settings,
//   Welcome, Unlock, install and problem. Ethereum's start screen is one when
//   it is the Ethereum side itself, not a step of Settings, Move coins or Buy.
// - Going to a screen already in the history goes back to it: the history is
//   cut there, so Back never loops. The same screen with other params (another
//   move, another batch) is another entry.
// - { replace: true } moves on without leaving the current screen behind (a
//   review after the payment was sent, a form after its codes exist, a
//   redirect); { reset: true } forgets everything before (setup is over).
// - The lock screen and a payment's status are never a Back target.

const ROOTS = new Set(['home', 'ethHome', 'activity', 'settings', 'welcome', 'unlock', 'install', 'problem']);
const NO_RETURN = new Set(['unlock', 'txStatus', 'install', 'problem']);

export function isRoot(name, params = {}) {
  return ROOTS.has(name) || (name === 'ethStart' && (!params.from || params.from === 'home'));
}

/** The two params agree on every key both have (another id is another screen). */
function sameEntry(entry, name, params) {
  if (entry.name !== name) return false;
  return Object.keys(entry.params).every((k) => !(k in params) || Object.is(entry.params[k], params[k]));
}

export function navHistory({ max = 30 } = {}) {
  let stack = [];
  return {
    /** Before `to` opens. `from` is the screen being left ({name, params}) or null. */
    move(from, to, { replace = false, reset = false } = {}) {
      const toParams = to.params || {};
      if (reset || isRoot(to.name, toParams)) {
        stack = [];
        return;
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        if (sameEntry(stack[i], to.name, toParams)) {
          stack = stack.slice(0, i);
          return;
        }
      }
      if (!from || !from.name || replace || from.name === to.name || NO_RETURN.has(from.name)) return;
      stack.push({ name: from.name, params: { ...(from.params || {}) } });
      if (stack.length > max) stack.shift();
    },
    /** What app.back() opens: the newest entry, else the fallback without recording the screen left. */
    backTarget(fallback = 'home', fallbackParams = {}) {
      const e = stack[stack.length - 1];
      return e ? { name: e.name, params: { ...e.params }, opts: {} } : { name: fallback, params: { ...fallbackParams }, opts: { replace: true } };
    },
    clear() {
      stack = [];
    },
    /** Screen names only, oldest first. */
    names() {
      return stack.map((e) => e.name);
    },
  };
}
