// A minimal stand-in DOM for screen code under node:test (what lib/dom.js, lib/ui.js and lib/icons.js
// use): elements with attributes, children, text, listeners, dataset and disabled; document.body;
// querySelectorAll for a class. Importing this module installs it as globalThis.document / Node.
export class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  appendChild(c) {
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  prepend(...cs) {
    for (const c of cs.reverse()) {
      c.parentNode?.removeChild(c);
      c.parentNode = this;
      this.childNodes.unshift(c);
    }
  }
  append(...cs) {
    for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c);
  }
  replaceChildren(...cs) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    for (const c of cs) this.appendChild(c);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === globalThis.document?.body;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren(new FakeText(v));
  }
}
export class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.text = String(text);
  }
  get textContent() {
    return this.text;
  }
}
export class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.disabled = false;
    this.style = { setProperty() {} };
    this.classList = { add() {}, remove() {}, toggle() {}, replace() {}, contains: () => false };
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  addEventListener(type, fn, opts) {
    // Capture listeners are kept apart: click() calls an element's own listeners, tap() goes the whole way.
    const capture = opts === true || Boolean(opts && opts.capture);
    const map = capture ? (this.captureListeners ||= new Map()) : this.listeners;
    if (!map.has(type)) map.set(type, []);
    map.get(type).push(fn);
  }
  dispatchEvent() {
    return true;
  }
  /**
   * A click as a browser dispatches it: capture listeners from the top down to this element, then
   * its own, then the bubbling ones back up; stopPropagation() ends it there. -> the handlers'
   * results, awaited.
   */
  tap() {
    if (this.disabled) return Promise.resolve([]);
    const path = [];
    for (let n = this.parentNode; n; n = n.parentNode) path.unshift(n);
    let stopped = false;
    const ev = { type: 'click', target: this, stopPropagation: () => (stopped = true), preventDefault() {} };
    const out = [];
    const run = (n, map) => {
      for (const fn of (map && map.get('click')) || []) out.push(fn({ ...ev, currentTarget: n }));
    };
    for (const n of path) {
      run(n, n.captureListeners);
      if (stopped) return Promise.all(out);
    }
    run(this, this.captureListeners);
    run(this, this.listeners);
    for (const n of [...path].reverse()) {
      if (stopped) break;
      run(n, n.listeners);
    }
    return Promise.all(out);
  }
  /** -> what the handlers returned, awaited (a tap's work). */
  click() {
    if (this.disabled) return Promise.resolve([]);
    return Promise.all((this.listeners.get('click') ?? []).map((fn) => fn({ type: 'click', target: this })));
  }
  /** The first element under this one matching a simple selector: '.class', 'tag', or both, space-separated for descendants ('.topbar h1'). */
  querySelector(sel) {
    const parts = String(sel).trim().split(/\s+/);
    const match = (el, part) => (part.startsWith('.') ? el.className.split(/\s+/).includes(part.slice(1)) : el.tagName === part.toUpperCase());
    let scope = [this];
    for (const part of parts) {
      const next = [];
      for (const root of scope) for (const el of root.findAll((x) => match(x, part))) if (!next.includes(el)) next.push(el);
      scope = next;
      if (!scope.length) return null;
    }
    return scope[0] || null;
  }
  findAll(pred, out = []) {
    for (const c of this.childNodes) {
      if (c instanceof FakeElement) {
        if (pred(c)) out.push(c);
        c.findAll(pred, out);
      }
    }
    return out;
  }
}
const body = new FakeElement('body');
globalThis.Node = FakeNode;
globalThis.document = {
  body,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeText(text),
  querySelectorAll(sel) {
    if (!/^\.[\w-]+$/.test(sel)) throw new Error(`this stand-in DOM only finds a class: ${sel}`);
    return body.findAll((el) => el.className.split(/\s+/).includes(sel.slice(1)));
  },
};

/** Elements under `root` (document.body by default) whose test id (attribute or dataset) is `id`. */
export function byTestId(id, root = body) {
  return root.findAll((el) => el.getAttribute('data-testid') === id || el.dataset.testid === id);
}
export const one = (id, root) => byTestId(id, root)[0] || null;
export { body };
