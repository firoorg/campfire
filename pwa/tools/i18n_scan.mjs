// The translation scanner: reads the app's JavaScript (a small tokenizer, no parser dependency) and
// finds (1) every text routed through t() / tn() / tk() of lib/i18n.js, which become the catalog's
// keys, and (2) every string literal that looks like words a person reads but is not routed: the
// coverage test (test/unit/i18n_coverage.test.mjs) fails on those. tools/i18n_extract.mjs writes
// the key list and the catalogs from (1).
//
// What counts as routed:
//   t('English text', { name })     the first argument: one string literal (or a template literal
//                                   without ${}); placeholders are {name}
//   tn({ one: '{n} code', other: '{n} codes' }, n)   the forms object, literals only
//   tk('English text')              marks a text kept in a constant (module level, or a table) that
//                                   a screen translates later with t(CONSTANT)
// t() and tn() may not run at module level: a module is read once, and its text would stay in the
// language of that moment. tk() is for that.
//
// What is not text (never flagged): object keys, `case` labels, values compared with === / !==,
// imports, arguments of calls that take names rather than words (console.*, querySelector,
// addEventListener, setAttribute's name, storage keys, ...), the values of properties that hold
// names (class, data-testid, type, ...), and literals that are not word-like (identifiers, slugs,
// paths, URLs, CSS, constants). A literal that is text but must stay English (a brand, a protocol
// word) is listed in ALLOW in the coverage test with the reason.

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const NOT_CALL_BEFORE_PAREN = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'typeof', 'void', 'delete', 'await', 'yield', 'in', 'of', 'instanceof', 'case', 'throw', 'new', 'else', 'do']);
const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#'];

function cook(raw) {
  // raw: the characters between the quotes (or a template quasi). Escapes as JS reads them.
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n === 'v') out += '\v';
    else if (n === '0' && !/[0-9]/.test(raw[i + 1] || '')) out += '\0';
    else if (n === 'x') {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === 'u') {
      if (raw[i + 1] === '{') {
        const end = raw.indexOf('}', i);
        out += String.fromCodePoint(parseInt(raw.slice(i + 2, end), 16));
        i = end;
      } else {
        out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (n === '\r') {
      if (raw[i + 1] === '\n') i++;
    } else if (n === '\n' || n === ' ' || n === ' ') {
      /* line continuation */
    } else out += n;
  }
  return out;
}

/**
 * Tokens of a JavaScript source: { type, value, start, end, line } with type one of
 * name, num, str, tpl (a template's text part: head / tail say whether it starts / ends the
 * template), regex, punc. Comments and white space are dropped.
 */
export function tokenize(src, comments = null) {
  const toks = [];
  const braces = []; // '{' or '${' (a template expression)
  let i = 0;
  let line = 1;
  const lastSig = () => toks[toks.length - 1];
  const regexAllowed = () => {
    const p = lastSig();
    if (!p) return true;
    if (p.type === 'num' || p.type === 'str' || p.type === 'regex') return false;
    if (p.type === 'tpl') return !p.tail;
    if (p.type === 'name') return KEYWORDS_BEFORE_REGEX.has(p.value);
    if (p.type === 'punc') return ![')', ']', '}'].includes(p.value);
    return true;
  };
  const count = (s) => {
    for (const ch of s) if (ch === '\n') line++;
  };
  const quasi = (head) => {
    // i is just after ` (head) or after the } that closed ${...}
    const start = i;
    const startLine = line;
    let raw = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        raw += c + src[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        toks.push({ type: 'tpl', value: cook(raw), raw, head, tail: true, start: start - 1, end: i, line: startLine });
        count(raw);
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        toks.push({ type: 'tpl', value: cook(raw), raw, head, tail: false, start: start - 1, end: i, line: startLine });
        count(raw);
        braces.push('${');
        return;
      }
      raw += c;
      i++;
    }
    throw new Error(`unterminated template at line ${startLine}`);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿' || c === ' ' || c === ' ') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i++;
      if (comments) comments.push({ line, text: src.slice(start + 2, i) });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`unterminated comment at line ${line}`);
      if (comments) comments.push({ line, text: src.slice(i + 2, end) });
      count(src.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      i++;
      let raw = '';
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          raw += src[i] + src[i + 1];
          i += 2;
        } else if (src[i] === '\n') throw new Error(`unterminated string at line ${line}`);
        else raw += src[i++];
      }
      i++;
      toks.push({ type: 'str', value: cook(raw), raw, quote: c, start, end: i, line });
      count(raw);
      continue;
    }
    if (c === '`') {
      i++;
      quasi(true);
      continue;
    }
    if (c === '}' && braces.length && braces[braces.length - 1] === '${') {
      braces.pop();
      toks.push({ type: 'punc', value: '}', start: i, end: i + 1, line, tplClose: true });
      i++;
      quasi(false);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:0[xX][0-9a-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)/.exec(src.slice(i));
      toks.push({ type: 'num', value: m[0], start: i, end: i + m[0].length, line });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c) || c === '\\') {
      const m = /^(?:[A-Za-z_$\u0080-￿]|\\u[0-9a-fA-F]{4})(?:[\w$\u0080-￿]|\\u[0-9a-fA-F]{4})*/.exec(src.slice(i));
      toks.push({ type: 'name', value: m[0], start: i, end: i + m[0].length, line });
      i += m[0].length;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '\n') throw new Error(`unterminated regex at line ${line}`);
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || '')) i++;
      toks.push({ type: 'regex', value: src.slice(start, i), start, end: i, line });
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i));
    if (!p) throw new Error(`unexpected character ${JSON.stringify(c)} at line ${line}`);
    if (p === '{') braces.push('{');
    else if (p === '}') braces.pop();
    toks.push({ type: 'punc', value: p, start: i, end: i + p.length, line });
    i += p.length;
  }
  return toks;
}

// ------------------------------------------------------------------ context

const isPunc = (t, v) => t && t.type === 'punc' && t.value === v;

/** The dotted name just before index i (a callee): console.warn, app.go, h; '' when there is none. */
function calleeBefore(toks, i) {
  const parts = [];
  let j = i - 1;
  while (j >= 0) {
    const t = toks[j];
    if (t.type === 'name') {
      parts.unshift(t.value);
      j--;
      if (isPunc(toks[j], '.') || isPunc(toks[j], '?.')) {
        j--;
        continue;
      }
      break;
    }
    if (isPunc(t, ')') || isPunc(t, ']')) {
      parts.unshift('()');
      break;
    }
    break;
  }
  return { name: parts.join('.'), before: toks[j] };
}

function blockOrObject(toks, i) {
  // toks[i] is '{': an object literal or a block (a function body when after ')' or '=>').
  const p = toks[i - 1];
  if (!p) return { kind: 'block', fn: false };
  if (p.type === 'punc') {
    if (p.value === ')') return { kind: 'block', fn: true };
    if (p.value === '=>') return { kind: 'block', fn: true };
    if ([';', '}', '{'].includes(p.value)) return { kind: 'block', fn: false };
    return { kind: 'object', fn: false };
  }
  if (p.type === 'name') {
    if (['else', 'try', 'finally', 'do'].includes(p.value)) return { kind: 'block', fn: false };
    if (['return', 'yield', 'await', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw'].includes(p.value)) return { kind: 'object', fn: false };
    return { kind: 'block', fn: false }; // class X {, extends Y {, a label, or `get x() {`'s name (rare)
  }
  if (p.type === 'tpl') return { kind: 'object', fn: false };
  return { kind: 'object', fn: false };
}

/**
 * Walks the tokens once and gives every string / template token its context:
 *   frames: the open brackets around it, innermost last ({ open, kind, callee, isNew, arg, key, fn })
 *   inFunction: inside a function body or an arrow function's expression
 *   key: it is an object key
 * Returns the tokens with `ctx` set on str/tpl tokens and on t/tn/tk call names.
 */
export function analyze(toks) {
  const stack = [];
  const top = () => stack[stack.length - 1];
  const inFn = () => stack.some((f) => f.fn);
  const objectFrame = () => {
    const f = top();
    return f && f.kind === 'object' ? f : null;
  };
  const popArrows = () => {
    while (top() && top().kind === 'arrow') stack.pop();
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'punc') {
      const v = t.value;
      if (v === ',' || v === ';') {
        popArrows();
        const f = top();
        if (f && v === ',') {
          f.arg++;
          if (f.kind === 'object') {
            f.key = null;
            f.expectKey = true;
          }
        }
        if (f && v === ';' && f.kind === 'object') f.expectKey = true;
        continue;
      }
      if (v === '(' || v === '[' || v === '{') {
        let frame;
        if (v === '(') {
          const { name, before } = calleeBefore(toks, i);
          const prev = toks[i - 1];
          const isCall = prev && ((prev.type === 'name' && !NOT_CALL_BEFORE_PAREN.has(prev.value)) || isPunc(prev, ')') || isPunc(prev, ']') || isPunc(prev, '?.') || (prev.type === 'tpl' && prev.tail));
          const isDecl = Boolean((before && before.type === 'name' && before.value === 'function') || (prev && prev.type === 'name' && prev.value === 'function') || (isPunc(prev, '*') && toks[i - 2] && toks[i - 2].value === 'function'));
          frame = { open: '(', kind: isCall && !isDecl ? 'call' : 'paren', callee: isCall && !isDecl ? name : null, isNew: Boolean(before && before.type === 'name' && before.value === 'new'), arg: 0, fn: isDecl, ternary: 0, start: i };
        } else if (v === '[') frame = { open: '[', kind: 'array', arg: 0, fn: false, ternary: 0, start: i };
        else {
          const bo = blockOrObject(toks, i);
          frame = { open: '{', kind: bo.kind, fn: bo.fn, arg: 0, key: null, expectKey: bo.kind === 'object', ternary: 0, start: i };
        }
        stack.push(frame);
        continue;
      }
      if (t.tplClose) {
        // The } that closed a template's ${...}: no frame of ours (the template's next part follows).
        popArrows();
        continue;
      }
      if (v === ')' || v === ']' || v === '}') {
        popArrows();
        const closed = stack.pop();
        if (closed) closed.end = i;
        // `}` that closed a template's ${...}: the template continues (its next part follows).
        continue;
      }
      if (v === '${') continue;
      if (v === '=>') {
        const n = toks[i + 1];
        if (!isPunc(n, '{')) stack.push({ open: '=>', kind: 'arrow', fn: true, arg: 0, ternary: 0, start: i });
        continue;
      }
      if (v === '?') {
        const f = top();
        if (f) f.ternary++;
        continue;
      }
      if (v === ':') {
        const f = top();
        if (f && f.ternary > 0) f.ternary--;
        else if (f && f.kind === 'object') {
          f.expectKey = false;
          const k = toks[i - 1];
          f.key = k && (k.type === 'name' || k.type === 'str' || k.type === 'num') ? k.value : null;
        }
        continue;
      }
      continue;
    }
    if (t.type === 'tpl' && !t.head) {
      // A template's later part: the ${...} frame was the brace stack's, not this one.
    }
    if (t.type === 'str' || t.type === 'tpl' || t.type === 'name') {
      const f = top();
      const objKey = f && f.kind === 'object' && f.expectKey && isPunc(toks[i + 1], ':') && (t.type !== 'tpl');
      // A snapshot: the frames change as the walk goes on (argument counts, the current key); .ref is the live
      // frame (its .end, the closing bracket, is known once the walk has passed it).
      t.ctx = { frames: stack.map((x) => ({ ...x, ref: x })), inFunction: inFn(), key: Boolean(objKey), propKey: f && f.kind === 'object' && !f.expectKey ? f.key : null };
      // A template that has ${...}: its expressions are tokens in between; every part shares the
      // frames of the head.
    }
  }
  return toks;
}

// ------------------------------------------------------------------ routed text

export const T_FUNCS = new Set(['t', 'tk', 'tNodes']);
export const PLURAL_FUNC = 'tn';
export const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** The placeholders of a text: {name} → ['name'] (sorted, unique). */
export function placeholders(s) {
  return [...new Set([...String(s).matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]))].sort();
}

/**
 * Whether token i (a str, or a tpl head) is exactly the first argument of a call to one of `names`:
 * '(' before it, ',' or ')' after it, and the call's callee is the bare name.
 */
function soleFirstArg(toks, i, names) {
  const t = toks[i];
  if (t.type === 'tpl' && !(t.head && t.tail)) return null;
  const prev = toks[i - 1];
  const next = toks[i + 1];
  if (!isPunc(prev, '(') || !(isPunc(next, ',') || isPunc(next, ')'))) return null;
  const f = t.ctx && t.ctx.frames[t.ctx.frames.length - 1];
  if (!f || f.kind !== 'call' || !names.has(f.callee) || f.arg !== 0) return null;
  return f.callee;
}

/** Whether token i is a plural form's value in tn()'s first argument: tn({ one: '…', other: '…' }, n). */
function pluralForm(toks, i) {
  const t = toks[i];
  if (t.type === 'tpl' && !(t.head && t.tail)) return null;
  const frames = t.ctx && t.ctx.frames;
  if (!frames || frames.length < 2) return null;
  const obj = frames[frames.length - 1];
  const call = frames[frames.length - 2];
  if (obj.kind !== 'object' || call.kind !== 'call' || call.callee !== PLURAL_FUNC || call.arg !== 0) return null;
  if (!isPunc(toks[i - 1], ':') || !(isPunc(toks[i + 1], ',') || isPunc(toks[i + 1], '}'))) return null;
  if (!isPunc(toks[obj.start - 1], '(')) return null;
  return PLURAL_FORMS.includes(obj.key) ? obj.key : null;
}

// ------------------------------------------------------------------ what looks like words

// Properties whose values are names, not words.
export const NAME_KEYS = new Set([
  'class', 'className', 'data-testid', 'testid', 'id', 'type', 'name', 'role', 'autocomplete', 'inputmode', 'autocapitalize', 'autocorrect', 'spellcheck', 'enterkeyhint', 'rel', 'href', 'src', 'method', 'kind', 'code', 'state', 'mode', 'for', 'accept', 'pattern', 'mime', 'contentType', 'Content-Type', 'event', 'action', 'icon', 'ico', 'tag', 'key', 'cls', 'screen', 'target', 'sandbox', 'allow', 'referrerpolicy', 'loading', 'decoding', 'media', 'content', 'lang', 'dir', 'slot', 'part', 'as', 'cache', 'credentials', 'referrerPolicy', 'reason', 'status', 'result', 'unit', 'symbol', 'ticker', 'network', 'chain', 'route', 'step', 'stage', 'phase', 'level', 'severity', 'variant', 'size', 'align', 'position', 'format', 'encoding', 'algorithm', 'hash', 'curve', 'namedCurve', 'kty', 'crv', 'cid', 'aid', 'address', 'host', 'url', 'path', 'file', 'filename', 'ext', 'extension', 'dbName', 'store', 'storeName', 'keyPath', 'prop', 'field', 'param', 'arg', 'args', 'label_id', 'jsonrpc', 'error_code', 'testid', 'sel', 'selector',
]);
// Calls whose literal arguments are names, keys, selectors or log lines, not words a person reads.
export const NAME_CALLS = [
  /^console\./, /(^|\.)querySelector(All)?$/, /(^|\.)closest$/, /(^|\.)matches$/, /(^|\.)(add|remove)EventListener$/, /(^|\.)(get|has|remove|toggle)Attribute(NS)?$/,
  /(^|\.)classList\.(add|remove|toggle|contains|replace)$/, /(^|\.)(getItem|setItem|removeItem)$/, /(^|\.)createElement(NS)?$/, /^(new )?URL$/, /(^|\.)fetch$/, /^import$/, /^(new )?RegExp$/,
  /(^|\.)dispatchEvent$/, /^(new )?(Custom)?Event$/, /^(new )?(Message|Broadcast)Channel$/, /(^|\.)call$/, /^icon$/, /(^|\.)go$/, /(^|\.)has$/, /(^|\.)get$/, /(^|\.)set$/, /(^|\.)delete$/, /^Symbol(\.for)?$/, /(^|\.)setProperty$/,
  /(^|\.)getPropertyValue$/, /(^|\.)setRequestHeader$/, /(^|\.)postMessage$/, /(^|\.)(startsWith|endsWith|includes|indexOf|lastIndexOf|split|join|replace|replaceAll|padStart|padEnd|localeCompare)$/,
  /(^|\.)toLocale(Date|Time)?String$/, /^(new )?Intl\./, /(^|\.)(open|deleteDatabase|transaction|objectStore|createObjectStore|index|createIndex)$/, /(^|\.)(importKey|exportKey|deriveKey|deriveBits|digest|encrypt|decrypt|sign|verify|generateKey)$/,
  /(^|\.)(subscribe|unsubscribe|emit|on|off|once)$/, /(^|\.)request$/, /^(new )?Worker$/, /(^|\.)register$/, /(^|\.)(match|keys|addAll)$/, /\.put$/, /^(new )?Response$/, /^(new )?Request$/, /^(new )?Headers$/, /\.append$/,
  /^(new )?(DOMException)$/, /(^|\.)assert$/, /(^|\.)(warn|log|debug|info|trace)$/, /(^|\.)(query|requestPermission)$/, /(^|\.)(mark|measure)$/, /^(new )?TextDecoder$/, /^svg$/, /(^|\.)(getContext|toDataURL|toBlob)$/,
  /(^|\.)(normalize)$/, /(^|\.)(sendMessage)$/,
];

/**
 * Whether a literal's text reads as words (rather than a name, a key, a path or a number). A
 * template's text comes with {…} where its expressions are.
 */
// Names that stay as they are in every language: a text made only of these is not words to translate.
export const BRANDS = ['Firo PWA', 'Firo', 'FIRO', 'rsFIRO', 'Spark', 'Campfire', 'buyfiro.app', 'Rosen', 'ETH', 'BNB', 'USDT', 'USDC', 'BTC', 'LTC', 'Ethereum', 'BNB Chain', 'Uniswap', 'PancakeSwap', 'NEAR Intents', 'NEAR', 'CoinGecko', 'ElectrumX', 'Face ID', 'Touch ID'];
// Longest first: 'BNB Chain' before 'BNB', 'Firo PWA' before 'Firo'.
const BRAND_RE = new RegExp(`\\b(${[...BRANDS].sort((x, y) => y.length - x.length).map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');

export function wordLike(s) {
  const t = String(s).trim();
  if (!/[A-Za-z]{2}/.test(t.replace(BRAND_RE, ' ').replace(/\{…\}/g, ' '))) return false;
  if (!/[A-Za-z]{2}/.test(t.replace(/\{…\}/g, ' '))) return false;
  if (/^(https?|wss?|data|blob|file|mailto|firo|ethereum):/i.test(t)) return false;
  if (!/\s/.test(t)) {
    // One token: only a capitalised word is text ('Reload', 'Back', 'Copied!'); identifiers, slugs,
    // keys, paths and CONSTANTS are not.
    return /^[A-Z][a-z]+(-[a-z]+)*[.!?…:]?$/.test(t); // 'Reload', 'Auto-lock'
  }
  if (/^[.#[]/.test(t) && !/[A-Z]/.test(t)) return false; // a CSS selector
  if (/^[a-z0-9_-]+( [a-z0-9_-]+)+$/.test(t) && /-/.test(t)) return false; // a class list
  if (/^[a-z-]+\s*:\s*[^;]+;/.test(t)) return false; // CSS declarations
  if (/^[A-Z0-9_ ]+$/.test(t)) return false; // CONSTANTS
  if (/^[0-9a-f ]+$/i.test(t) && /[0-9]/.test(t)) return false;
  return true;
}

// The name-holding properties that sometimes hold a sentence instead (sentenceLike decides).
const SOFT_NAME_KEYS = new Set(['reason', 'status', 'result', 'state', 'kind', 'mode', 'content', 'action', 'event', 'step', 'stage', 'phase']);

/** Words that read as a sentence: three or more, or two or more ending in . ! ? … */
export function sentenceLike(s) {
  const v = String(s).replace(/\{…\}/g, ' x ').trim();
  if (!wordLike(v)) return false;
  const words = v.split(/\s+/).filter((w) => /[A-Za-z]{2}/.test(w));
  if (/^[a-z0-9_-]+( [a-z0-9_-]+)*$/.test(v) && /[-_]/.test(v)) return false;
  return words.length >= 3 || (words.length >= 2 && /[.!?…]$/.test(v));
}

// Properties whose values are words.
export const TEXT_KEYS = new Set(['text', 'aria-label', 'placeholder', 'title', 'alt', 'label', 'detail', 'lead', 'hint', 'cta', 'sub', 'body', 'message', 'note', 'explanation', 'heading', 'subtitle', 'description', 'caption', 'tooltip', 'what', 'why', 'how', 'line', 'words', 'confirm', 'ok', 'cancel', 'yes', 'no', 'button']);
const TEXT_SETTERS = new Set(['textContent', 'innerText', 'placeholder', 'title', 'ariaLabel', 'alt', 'label']);

/**
 * Every string literal of `src` with its verdict:
 *   { line, value, kind: 'key' | 'plural' | 'mark' | 'text' | 'name', reason, call }
 * 'key' / 'mark' / 'plural': routed through t / tk / tn; 'text': words that are not routed; 'name':
 * anything else. Also returns the t()/tn() calls made at module level and t() calls whose first
 * argument is a template with ${...}.
 */
export function scanSource(src, file = '') {
  const comments = [];
  const toks = analyze(tokenize(src, comments));
  const items = [];
  const problems = [];
  // Pragmas: `i18n-ignore-file: <why>` (every literal of the file is not words to translate: a
  // module of diagnostics nobody is shown), `i18n-ignore: <why>` (that line and the next).
  let ignoreFile = null;
  const ignoreLines = new Map();
  for (const c of comments) {
    for (const m of c.text.matchAll(/i18n-ignore(-file)?(?::\s*([^\n*]*))?/g)) {
      const why = (m[2] || '').trim();
      if (!why) problems.push({ line: c.line, problem: `i18n-ignore${m[1] || ''} needs a reason after a colon` });
      if (m[1]) ignoreFile = why || '?';
      else {
        ignoreLines.set(c.line, why);
        ignoreLines.set(c.line + 1, why);
      }
    }
  }
  // The translation functions this file has: imported from lib/i18n.js (or defined there). A call of
  // a function of the same name that is not one of them is not a translation.
  const imported = new Set();
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'[^']*\/i18n\.js';/gm)) for (const part of m[1].split(',')) imported.add(part.trim().split(/\s+as\s+/)[0]);
  for (const m of src.matchAll(/^export (?:const|function) (t|tn|tk|tNodes)\b/gm)) imported.add(m[1]);
  const routing = new Set([...T_FUNCS].filter((f) => imported.has(f)));
  const own = new Set([...src.matchAll(/^export (?:const|function) (t|tn|tk|tNodes)\b/gm)].map((m) => m[1]));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'name' && imported.has(t.value) && (T_FUNCS.has(t.value) || t.value === PLURAL_FUNC) && isPunc(toks[i + 1], '(') && !isPunc(toks[i - 1], '.') && !(toks[i - 1] && toks[i - 1].type === 'name' && toks[i - 1].value === 'function')) {
      if (t.value !== 'tk' && !t.ctx.inFunction && !isImportLine(toks, i)) problems.push({ line: t.line, problem: `${t.value}() at module level: its text would stay in the language of the moment the module was read; use tk() there and t() where it is shown` });
      const a = toks[i + 2];
      if (t.value !== PLURAL_FUNC && a && a.type === 'tpl' && a.head && !a.tail) problems.push({ line: a.line, problem: `${t.value}() with \${...} in its text: use a placeholder, ${t.value}('… {name} …', { name })` });
      if ((t.value === 't' || t.value === 'tNodes') && a && (a.type === 'str' || (a.type === 'tpl' && a.head && a.tail))) {
        const want = placeholders(a.value);
        const after = toks[i + 3];
        if (isPunc(after, ')')) {
          if (want.length) problems.push({ line: a.line, problem: `t('${a.value.slice(0, 60)}') has {${want.join('}, {')}} but no values for them` });
        } else if (isPunc(after, ',') && isPunc(toks[i + 4], '{')) {
          const given = objectKeys(toks, i + 4);
          if (given && !(given.length === want.length && given.every((k, j) => k === want[j]))) problems.push({ line: a.line, problem: `t('${a.value.slice(0, 60)}'): placeholders {${want.join('}, {')}} but values for {${given.join('}, {')}}` });
        }
      }
      continue;
    }
    // A binding named like the translation functions would hide them: (t) => …, const t = …
    if (t.type === 'name' && (t.value === 't' || t.value === 'tn' || t.value === 'tk' || t.value === 'tNodes') && !isPunc(toks[i - 1], '.') && !isPunc(toks[i + 1], ':')) {
      const prev = toks[i - 1];
      const next = toks[i + 1];
      const f = t.ctx && t.ctx.frames[t.ctx.frames.length - 1];
      const declared = prev && prev.type === 'name' && ['const', 'let', 'var', 'function', 'class'].includes(prev.value);
      const arrowParam = isPunc(next, '=>');
      const param = f && f.open === '(' && (isPunc(prev, '(') || isPunc(prev, ',')) && (isPunc(next, ',') || isPunc(next, ')') || isPunc(next, '=')) && (f.fn || (f.ref.end && isPunc(toks[f.ref.end + 1], '=>')) || (prev && toks[f.start - 1] && toks[f.start - 1].value === 'catch'));
      const definition = own.has(t.value) && toks[i - 2] && toks[i - 2].value === 'export';
      if ((declared || arrowParam || param) && !definition) t.binding = true;
    }
    if (t.type !== 'str' && t.type !== 'tpl') continue;
    if (t.type === 'tpl' && !t.head) continue; // a template's later part: judged with its head
    const ctx = t.ctx || { frames: [], inFunction: false, key: false, propKey: null };
    const routed = soleFirstArg(toks, i, routing);
    if (routed) {
      items.push({ line: t.line, value: t.value, kind: routed === 'tk' ? 'mark' : 'key', call: routed });
      continue;
    }
    const form = imported.has(PLURAL_FUNC) ? pluralForm(toks, i) : null;
    if (form) {
      items.push({ line: t.line, value: t.value, kind: 'plural', form, call: PLURAL_FUNC, group: toks[t.ctx.frames[t.ctx.frames.length - 1].start].start });
      continue;
    }
    const verdict = classify(toks, i, ctx);
    let kind = verdict.text ? 'text' : 'name';
    let reason = verdict.reason;
    if (kind === 'text' && (ignoreFile || ignoreLines.has(t.line))) {
      kind = 'ignored';
      reason = ignoreFile || ignoreLines.get(t.line);
    }
    const item = { line: t.line, value: t.type === 'tpl' ? templateText(toks, i) : t.value, kind, reason, call: verdict.call || null };
    // Where it is in the source (tools that rewrite it need this): its token, whether it stands in a
    // function, and whether it is a part of a concatenation ('a ' + b).
    if (kind === 'text') item.at = { start: t.start, end: t.end, type: t.type, whole: t.type === 'str' || Boolean(t.tail), inFunction: Boolean(ctx.inFunction), joined: isPunc(toks[i - 1], '+') || isPunc(toks[i + 1], '+') };
    items.push(item);
  }
  for (const t of toks) if (t.binding && imported.has(t.value)) problems.push({ line: t.line, problem: `a variable named ${t.value} hides the translation function ${t.value}(): rename it` });
  return { items, problems, file, ignoredFile: ignoreFile };
}

/** The keys of the object literal opening at toks[open] ('{'): null when it has a spread or computed key. */
function objectKeys(toks, open) {
  const keys = [];
  let depth = 0;
  let expectKey = true;
  for (let k = open; k < toks.length; k++) {
    const t = toks[k];
    if (isPunc(t, '{') || isPunc(t, '(') || isPunc(t, '[')) {
      depth++;
      if (depth > 1) expectKey = false;
      continue;
    }
    if (t.type === 'tpl' && t.head && !t.tail) depth++;
    if (isPunc(t, '}') || isPunc(t, ')') || isPunc(t, ']')) {
      depth--;
      if (depth === 0) return [...new Set(keys)].sort();
      continue;
    }
    if (depth !== 1) continue;
    if (isPunc(t, ',')) {
      expectKey = true;
      continue;
    }
    if (!expectKey) continue;
    if (isPunc(t, '...') || isPunc(t, '[')) return null;
    if (t.type === 'name' || t.type === 'str' || t.type === 'num') {
      keys.push(t.value);
      expectKey = false;
    }
  }
  return null;
}

function isImportLine(toks, i) {
  for (let j = i; j >= 0; j--) {
    const t = toks[j];
    if (t.type === 'name' && (t.value === 'import' || t.value === 'export')) return true;
    if (isPunc(t, ';')) return false;
  }
  return false;
}

/** The nearest call this literal is an argument of, directly or through operators (not through another bracket). */
function directCall(ctx) {
  const f = ctx.frames[ctx.frames.length - 1];
  if (f && f.kind === 'call') return f;
  if (f && f.kind === 'arrow') return null;
  return null;
}

function classify(toks, i, ctx) {
  const t = toks[i];
  const prev = toks[i - 1];
  const next = toks[i + 1];
  if (ctx.key) return { text: false, reason: 'object key' };
  if (prev && prev.type === 'name' && (prev.value === 'from' || prev.value === 'import' || prev.value === 'case')) return { text: false, reason: prev.value };
  if (prev && prev.type === 'punc' && ['===', '!==', '==', '!='].includes(prev.value)) return { text: false, reason: 'compared' };
  if (next && next.type === 'punc' && ['===', '!==', '==', '!='].includes(next.value)) return { text: false, reason: 'compared' };
  if (prev && prev.type === 'name' && (prev.value === 'in' || prev.value === 'instanceof')) return { text: false, reason: 'in' };
  if (next && next.type === 'name' && next.value === 'in') return { text: false, reason: 'in' };
  if (prev && isPunc(prev, '[') && isPunc(next, ']') && toks[i - 2] && (toks[i - 2].type === 'name' || isPunc(toks[i - 2], ')') || isPunc(toks[i - 2], ']'))) return { text: false, reason: 'member' };
  // A template's text: whole if it has no ${...}, else every part.
  const value = t.type === 'tpl' ? templateText(toks, i) : t.value;
  const call = directCall(ctx);
  const callee = call ? `${call.isNew ? 'new ' : ''}${call.callee || ''}` : null;
  // An assignment: el.textContent = '…' (words), el.className = '…' (a name).
  if (isPunc(prev, '=') && toks[i - 2] && toks[i - 2].type === 'name') {
    const target = toks[i - 2].value;
    if (TEXT_SETTERS.has(target)) return { text: /[A-Za-z]/.test(value), reason: `${target} =`, call: callee };
    if (NAME_KEYS.has(target)) return { text: false, reason: `${target} =` };
  }
  const propKey = ctx.propKey;
  const f = ctx.frames[ctx.frames.length - 1];
  const directProp = f && f.kind === 'object' && propKey != null;
  // A property that usually holds a name (reason, status, kind…) can still hold a sentence: three
  // words or more, or words ending like a sentence, are words.
  if (directProp && NAME_KEYS.has(propKey)) return { text: SOFT_NAME_KEYS.has(propKey) && sentenceLike(value), reason: `${propKey}:`, call: callee };
  if (call && call.callee) {
    const c = `${call.isNew ? 'new ' : ''}${call.callee}`;
    if (call.callee === 'setAttribute' || /\.setAttribute$/.test(call.callee)) {
      if (call.arg === 0) return { text: false, reason: 'setAttribute name', call: c };
      const attr = attributeName(toks, call.start);
      if (attr && ['aria-label', 'title', 'placeholder', 'alt', 'aria-description'].includes(attr)) return { text: /[A-Za-z]/.test(value), reason: `setAttribute ${attr}`, call: c };
      if (attr) return { text: false, reason: `setAttribute ${attr}`, call: c };
    }
    if (NAME_CALLS.some((re) => re.test(c) || re.test(call.callee))) return { text: false, reason: `argument of ${c}`, call: c };
    if ((call.callee === 'h' || call.callee === 'el') && call.arg === 0) return { text: false, reason: 'tag', call: c };
    if (call.callee === 'h' && call.arg >= 2) return { text: /[A-Za-z]/.test(value), reason: 'a child of h()', call: c };
    // put(el, ...children) and append(el, children) of lib/dom.js: what they put on the page is shown.
    if ((call.callee === 'put' || call.callee === 'append') && call.arg >= 1) return { text: wordLike(value), reason: `a child of ${call.callee}()`, call: c };
  }
  if (directProp && TEXT_KEYS.has(propKey)) return { text: /[A-Za-z]{2}/.test(value) && !/^[a-z][a-zA-Z0-9]*$/.test(value.trim()), reason: `${propKey}:`, call: callee };
  return { text: wordLike(value), reason: 'looks like words', call: callee };
}

function attributeName(toks, openIdx) {
  const a = toks[openIdx + 1];
  return a && a.type === 'str' ? a.value : null;
}

/** A template with ${...} (index j: its head): its text parts joined with {…} where the expressions were, e.g. 'Locks after {…} min'. */
function templateText(toks, j) {
  const parts = [toks[j].value];
  if (toks[j].tail) return parts[0];
  let depth = 1;
  for (let k = j + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'tpl') continue;
    if (t.head) {
      if (!t.tail) depth++;
      continue;
    }
    if (depth === 1) {
      parts.push(t.value);
      if (t.tail) break;
    } else if (t.tail) depth--;
  }
  return parts.join('{…}');
}
