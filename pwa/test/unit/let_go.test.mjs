// The "Let it go" offer (screens/let_go.js), on a minimal stand-in DOM: what a tap tells the person.
// Release re-audit 4 RE4-3: on the screens that re-render when the wallet changes (the payment's
// screen, Sell, Bridge), the engine's 'seen' answer withdraws the offer (it clears oneNode and
// emits before it refuses), so the box and the reason it kept vanished before they could be shown:
// the person tapped "Let it go" and the offer silently disappeared. Now 'seen' and 'offline' are
// also said in a toast, which outlives the box, as the success path's is.
import test from 'node:test';
import assert from 'node:assert/strict';

// ------------------------------------------------------------ a minimal DOM (what dom.js and ui.js use)
class FakeNode {
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
class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.text = String(text);
  }
  get textContent() {
    return this.text;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.disabled = false;
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.get(k) ?? null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  /** -> what the handlers returned, awaited (a tap's work). */
  click() {
    return Promise.all((this.listeners.get('click') ?? []).map((fn) => fn({ type: 'click', target: this })));
  }
  /** Every element below this one (depth first) for which pred holds. */
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

const { letGoOffer } = await import('../../src/screens/let_go.js');
const { wallet } = await import('../../src/lib/wallet.js');

// The engine's words (lib/firo/backend.js letGo).
const SEEN = 'The Firo node in use has this payment now: it is on its way, so it was not let go.';
const OFFLINE = "The Firo node in use didn't answer, so the payment was not let go. Try again in a moment.";
const refusal = (code, message) => Object.assign(new Error(message), { code });
const testid = (root, id) => root.findAll((el) => el.getAttribute('data-testid') === id);
const toasts = () => document.querySelectorAll('.toast');

/** A screen showing the offer for a payment, as the payment's screen, Sell and Bridge do. */
function screen(txid) {
  body.replaceChildren();
  const box = letGoOffer({ txid, oneNode: true });
  assert.ok(box, 'offered');
  const page = document.createElement('div');
  page.appendChild(box);
  body.appendChild(page);
  return { page, box, button: testid(box, 'let-go-button')[0] };
}

test('release re-audit 4 RE4-3: "seen" withdraws the offer as the screen re-renders; the person is still told why, in a toast', async () => {
  const { page, box, button } = screen('aa'.repeat(32));
  wallet.letGo = async () => {
    // As the real engine: oneNode cleared and the change emitted before the refusal; the screen
    // re-renders, and the payment no longer has an offer (letGoOffer gives null).
    page.replaceChildren();
    throw refusal('seen', SEEN);
  };
  await button.click();
  assert.equal(box.isConnected, false, 'the offer is gone from the screen');
  const t = toasts();
  assert.equal(t.length, 1, 'a toast says what happened');
  assert.equal(t[0].textContent, SEEN);
});

test('"didn\'t answer" is said in the offer, which stays; no toast covers its button (RE4-3, then the offline toast was dropped)', async () => {
  const { box, button } = screen('bb'.repeat(32));
  wallet.letGo = async () => {
    throw refusal('offline', OFFLINE);
  };
  await button.click();
  assert.equal(box.isConnected, true, 'still offered');
  assert.equal(toasts().length, 0, 'the offer says it: no toast over its button');
  assert.equal(testid(box, 'let-go-error')[0]?.textContent, OFFLINE, 'and kept with the offer for the minute');
  assert.equal(testid(box, 'let-go-button')[0].disabled, false, 'it can be tapped again');
});

test('a screen that re-renders with a new offer for the payment: the new offer says why, no toast', async () => {
  const { page, button } = screen('ee'.repeat(32));
  wallet.letGo = async () => {
    page.replaceChildren(letGoOffer({ txid: 'ee'.repeat(32), oneNode: true }));
    throw refusal('offline', OFFLINE);
  };
  await button.click();
  assert.equal(toasts().length, 0);
  const fresh = page.children?.[0] ?? page.firstChild;
  assert.ok(fresh && fresh.isConnected, 'the new offer is on screen');
  // ...and it is redrawn when the answer comes: the reason shown, the button usable again (it was drawn
  // while the tap was in flight, as "Letting it go…"; release audit 0.1.5, N2).
  const b = testid(fresh, 'let-go-button')[0];
  assert.equal(b.textContent, 'Let it go');
  assert.equal(b.disabled, false);
  assert.equal(testid(fresh, 'let-go-error').length, 1, 'the new offer says why');
});

test('the success path still says so in a toast; a refusal that keeps the offer on screen (storage) is said in the offer', async () => {
  body.replaceChildren();
  let done = 0;
  const box = letGoOffer({ txid: 'cc'.repeat(32), oneNode: true }, { onDone: () => done++ });
  body.appendChild(box);
  wallet.letGo = async (txid) => ({ txid, letGo: true });
  await testid(box, 'let-go-button')[0].click();
  assert.equal(done, 1);
  assert.equal(toasts().length, 1);
  assert.equal(toasts()[0].textContent, 'Let go: its FIRO is spendable again.');
  const { box: kept, button } = screen('dd'.repeat(32)); // a new screen: the toast went with the old one
  wallet.letGo = async () => {
    throw refusal('storage', 'This device could not save that, so the payment was not let go. Try again in a moment.');
  };
  await button.click();
  assert.equal(toasts().length, 0);
  assert.match(testid(kept, 'let-go-error')[0]?.textContent ?? '', /could not save that, so the payment was not let go/);
});

test('release audit 0.1.5 N3: offers that left the screen are forgotten when a new one is made; a fresh one not on screen yet is kept for 2 s', async () => {
  const { offersRemembered } = await import('../../src/screens/let_go.js');
  const realNow = Date.now;
  let t = realNow() + 60000; // later than every offer the tests above made
  Date.now = () => t;
  try {
    body.replaceChildren();
    const page = document.createElement('div');
    body.appendChild(page);
    const offer = () => letGoOffer({ txid: 'f1'.repeat(32), oneNode: true });
    const a = offer();
    page.appendChild(a);
    assert.equal(offersRemembered(), 1, "the earlier tests' offers, long off screen, are forgotten");
    // A re-render half a second later: the new box replaces the old one on screen.
    t += 500;
    const b = offer();
    page.replaceChildren(b);
    assert.equal(a.isConnected, false);
    assert.equal(offersRemembered(), 2);
    // A box made but not on screen yet (a render under way), a moment after: nothing is forgotten,
    // not even the one that just left (it may be on its way back), within 2 s.
    t += 500;
    const c = offer();
    assert.equal(c.isConnected, false);
    assert.equal(offersRemembered(), 3, 'a, b and the fresh c');
    // Two seconds on: the box that left the screen is forgotten; c, never shown, is just 2 s old: kept.
    t += 2000;
    const d = offer();
    assert.equal(offersRemembered(), 3, 'b (on screen), c (2 s old) and d; a forgotten');
    // Later still: c is forgotten too; the one on screen and the newest stay.
    t += 2000;
    offer();
    assert.equal(offersRemembered(), 3, 'b, d (2 s old) and the newest; c forgotten');
    assert.ok(b.isConnected && !d.isConnected);
    t += 10000;
    offer();
    assert.equal(offersRemembered(), 2, 'only the one on screen and the newest');
  } finally {
    Date.now = realNow;
    body.replaceChildren();
  }
});
