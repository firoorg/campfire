/* Receive
 * Spec: ONE job: give someone my address.
 *       Primary CTA: "Share address" (or "Copy address" where sharing isn't available).
 *       Taps from app open: 1 (Home -> Receive).
 * Exit-intent reasons and answers:
 *   - "Which address do I give?" -> Spark (private) is chosen; Transparent (public) is one tap away
 *     for an exchange or a wallet that can't pay Spark, with what that means for privacy.
 *   - "Is this address safe to share?" -> yes, and a new one is one tap away.
 *   - "The address is huge" -> QR code first; copy and share buttons, no manual selection.
 *   - "Does the app need to stay open?" -> no: a Firo payment arrives with the app closed.
 */
import { h, svg, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, textButton, notice, copyText, toast } from '../lib/ui.js';
import { encodeQr, qrSvgPath } from '../lib/qr.js';
import { wallet } from '../lib/wallet.js';
import { t, tk, lazyWords } from '../lib/i18n.js';

export function qrElement(text, label = t('QR code of the address')) {
  const qr = encodeQr(text, { ecl: 'M' });
  const n = qr.size + 8;
  return svg('svg', { viewBox: `0 0 ${n} ${n}`, 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': label }, svg('rect', { width: n, height: n, fill: '#ffffff' }), svg('path', { d: qrSvgPath(qr, 4), fill: '#000000' }));
}

/** A QR code with the text under it, as Receive shows an address. */
export function qrCard(text, { label = t('QR code of the address'), testid = 'qr-text' } = {}) {
  return h('div', {}, h('div', { class: 'qr' }, qrElement(text, label)), h('div', { class: 'address-box' }, h('p', { class: 'mono', 'data-testid': testid, text })));
}

export const RECEIVE_KINDS = Object.freeze({
  spark: lazyWords({ label: 'Spark', sub: tk('Private'), note: tk('Private: what you receive, and from whom, stays hidden. Use it whenever the sender can pay Spark.') }), // i18n-ignore: a name, the same in every language
  transparent: lazyWords({ label: tk('Transparent'), sub: tk('Public'), note: tk('Public: anyone can see what arrives at this address. For exchanges and wallets that cannot pay Spark yet. Privatize it afterwards from Home.') }),
});

export default function receive(app, params = {}) {
  let kind = params.kind === 'transparent' ? 'transparent' : 'spark';
  const qrBox = h('div', { class: 'qr' }, h('div', { class: 'spinner' }));
  const addrText = h('p', { class: 'mono', 'data-testid': 'receive-address' });
  const kindBox = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('Address type') });
  const noteBox = h('div', { 'data-testid': 'receive-note' });
  const msg = h('div');
  const canShare = typeof navigator.share === 'function';
  const shareBtn = primary(h('span', {}, canShare ? t('Share address') : t('Copy address')), () => (canShare ? share() : copy()), { disabled: true, 'data-testid': 'share' });
  shareBtn.prepend(icon(canShare ? 'share' : 'copy'));
  const copyBtn = canShare ? secondary(h('span', {}, t('Copy')), copy, { disabled: true, 'data-testid': 'copy' }) : null;
  if (copyBtn) copyBtn.prepend(icon('copy'));
  let address = null;
  let shown = null;

  function renderKinds() {
    put(
      kindBox,
      ...Object.entries(RECEIVE_KINDS).map(([id, k]) =>
        h('button', { type: 'button', class: `seg${kind === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(kind === id), 'data-testid': `receive-${id}`, onclick: () => setKind(id) }, h('span', { class: 'seg-t' }, icon(id === 'spark' ? 'spark' : 'eye'), k.label), h('span', { class: 'seg-s', text: k.sub })),
      ),
    );
    put(noteBox, notice(kind === 'spark' ? 'success' : 'info', RECEIVE_KINDS[kind].note));
  }

  function setKind(id) {
    if (kind === id) return;
    kind = id;
    renderKinds();
    show();
  }

  /** The current address of the chosen kind, from the wallet's state. */
  function show() {
    address = wallet.state.receive[kind] || null;
    if (address === shown) return;
    shown = address;
    if (!address) {
      put(qrBox, h('div', { class: 'spinner' }));
      addrText.textContent = '';
      shareBtn.disabled = true;
      if (copyBtn) copyBtn.disabled = true;
      put(msg, notice('info', t('Your address appears once the wallet is connected.')));
      return;
    }
    put(qrBox, qrElement(`firo:${address}`));
    addrText.textContent = address;
    shareBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
    put(msg);
  }

  async function fresh() {
    try {
      address = kind === 'spark' ? await wallet.newSparkAddress() : await wallet.newTransparentAddress();
      shown = null;
      show();
      toast(t('New address ready'));
    } catch (e) {
      put(msg, notice('error', t('A new address could not be made: {message} Try again in a moment.', { message: e.message })));
    }
  }

  function copy() {
    if (address) copyText(address, t('Address copied'));
  }

  async function share() {
    try {
      await navigator.share({ text: address });
    } catch (e) {
      if (e && e.name !== 'AbortError') copy();
    }
  }

  renderKinds();
  show();
  const off = wallet.onChange(() => show());
  const el = screen(
    { title: t('Receive FIRO'), back: () => app.back('home'), actions: [shareBtn, copyBtn, textButton(t('Make a new address'), fresh, { 'data-testid': 'new-address' })] },
    kindBox,
    qrBox,
    h('div', { class: 'address-box' }, addrText),
    noteBox,
    msg,
  );
  return { el, destroy: off };
}
