// The app as screens see it (app.go / app.back / currentName), for a screen test: go() leaves the
// screen it is on (destroy), dismisses every open password sheet as the real app.go does, and opens
// the next one from `screens` (any other name opens an empty screen). Every move is in app.moves.
import { dismissAll } from './auth_ui.mjs';

export function makeApp(screens = {}, extra = {}) {
  const app = {
    currentName: null,
    params: null,
    current: null,
    moves: [],
    sendDraft: null,
    record: { id: 'w1' },
    go(name, params = {}, opts = {}) {
      if (this.current && this.current.destroy) this.current.destroy();
      dismissAll();
      this.moves.push(name);
      this.currentName = name;
      this.params = params;
      this.current = screens[name] ? screens[name](this, params, opts) : { el: null };
      return this.current;
    },
    back(fallback = 'home') {
      return this.go(fallback);
    },
    has: () => true,
    ...extra,
  };
  return app;
}
