/* Receive on Ethereum or BNB Chain
 * Spec: ONE job: give someone this wallet's address (the same 0x… address on Ethereum and BNB Chain).
 *       Primary CTA: "Share address" (or "Copy address" where sharing isn't available).
 *       Taps from app open: 2 (Home -> Ethereum -> Receive).
 * Exit-intent reasons and answers:
 *   - "Which network?" -> said up front: Ethereum and BNB Chain, the same address; nothing else.
 *   - "Will it arrive if I'm offline?" -> yes: Ethereum payments need nothing from this app.
 *   - "Is it private?" -> no, and said so: everyone can see what this address receives.
 *   - "The address is long" -> QR code first, then the address in groups of four, copy and share.
 */
import { h } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, copyText } from '../lib/ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { groupedAddress, qrElement } from './eth_ui.js';
import { t } from '../lib/i18n.js';

export default function ethReceive(app) {
  const qrBox = h('div', { class: 'qr' }, h('div', { class: 'spinner' }));
  const addrText = h('p', { class: 'mono addr-groups', 'data-testid': 'eth-receive-address' });
  const canShare = typeof navigator.share === 'function';
  const shareBtn = primary(h('span', {}, canShare ? t('Share address') : t('Copy address')), () => (canShare ? share() : copy()), { disabled: true, 'data-testid': 'eth-share' });
  shareBtn.prepend(icon(canShare ? 'share' : 'copy'));
  const copyBtn = canShare ? secondary(h('span', {}, t('Copy')), copy, { disabled: true, 'data-testid': 'eth-copy' }) : null;
  if (copyBtn) copyBtn.prepend(icon('copy'));
  let address = null;

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

  (async () => {
    const w = await ethWallet(app).catch(() => null);
    if (!w) return app.go('ethHome');
    address = w.state.address;
    qrBox.replaceChildren(qrElement(address, t('QR code of the address')));
    addrText.textContent = groupedAddress(address);
    addrText.dataset.address = address;
    shareBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
  })();

  const el = screen(
    { title: t('Receive ETH, BNB or tokens'), back: () => app.back('ethHome'), actions: [shareBtn, copyBtn] },
    qrBox,
    h('div', { class: 'address-box' }, addrText),
    notice('info', h('strong', { text: t('Ethereum and BNB Chain, the same address: ') }), t('ETH, BNB, rsFIRO, USDT, USDC and other tokens on those two chains. Coins sent on any other chain do not show here. Payments arrive even while this app is closed.')),
    h('p', { class: 'small', text: t('Everything this address receives is public on both chains. For private payments, use your Firo Spark address.') }),
  );
  return { el };
}
