// Tiny DOM helpers. Text always goes in through textContent: nothing on any
// screen is built from HTML strings, so nothing from the chain or a pasted
// address can turn into markup. (The CSP also forbids inline script/style.)

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (k === 'disabled') el.disabled = Boolean(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

/** "3f25d94e…77" style shortening for addresses and ids. */
export function shorten(s, head = 8, tail = 6) {
  s = String(s || '');
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function fmtDate(unixSec) {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })}, ${time}`;
}

/** Replaces an element's children, skipping null/false (replaceChildren would print "null"). */
export function put(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

/**
 * `fn` run one call at a time: a call while one is under way (a second tap on a button that asks for
 * the password and sends, say) starts nothing and resolves to undefined. `.running` says whether one
 * is under way (for a button's disabled state).
 */
export function oneAtATime(fn) {
  let running = false;
  const wrapped = async (...args) => {
    if (running) return undefined;
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
  Object.defineProperty(wrapped, 'running', { get: () => running });
  return wrapped;
}
