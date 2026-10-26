/* Scan a QR code (a sheet over Home, Send, Ethereum Send and the contact form)
 * Spec: ONE job: get an address off someone's screen or paper without typing it.
 *       Primary CTA: none while the camera looks (pointing it is the action); on a camera
 *       problem: "Paste instead".
 *       Taps from app open: 2 (Home -> Send -> Scan).
 * Exit-intent reasons and answers:
 *   - "Is it filming me / sending this somewhere?" -> says the picture stays on the phone; frames
 *     are read on the device and never kept.
 *   - "The camera does not open" -> says why (refused, no camera, in use, browser can't) and how
 *     to allow it, with Paste and "Use a photo" right there.
 *   - "It reads nothing" -> a QR code that is not a Firo address is named as such; scanning goes on.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet, notice, primary, secondary, textButton } from '../lib/ui.js';
import { parseScanned, startCameraScan, cameraProblem, cameraSupported, scanImageFile } from '../lib/qr_scan.js';
import { recognize } from '../lib/scan_recognize.js';
import { t } from '../lib/i18n.js';

/** Why a code is not what this scanner wants, in words that say where it belongs. */
export function elsewhere(text, wanted) {
  const r = recognize(text);
  if (r.kind === 'eth' && wanted !== 'eth') return t("That's an Ethereum address. Send to it from your Ethereum wallet, or scan a Firo address.");
  if ((r.kind === 'firo' || r.kind === 'name') && wanted === 'eth') return t("That's a Firo address. Send to it from your Firo wallet, or scan an Ethereum address.");
  if (r.kind === 'unsupported' && r.reason === 'bsc') return t("That's a payment on BNB Chain. Firo PWA doesn't have a BNB Chain wallet yet.");
  if (r.kind === 'unsupported' && r.reason === 'chain') return t("That's a payment on another network, which this wallet doesn't use.");
  if (r.kind === 'unsupported' && r.reason === 'coin') return t("That's an address of another coin, which this wallet doesn't hold.");
  if (r.kind === 'unsupported' && r.reason === 'link') return t("That's a web link. Firo PWA doesn't open links from codes.");
  if (r.kind === 'unsupported' && r.reason === 'requires') return t('That payment link asks for something this wallet can\'t do ({value}), so it was not opened. Ask for a plain address instead.', { value: (r.what || []).join(', ') });
  return null;
}

/**
 * The scanner sheet. consider(text) -> the value to resolve with, or null to keep looking (with
 * `wrong(text)` as what to say). Resolves that value, {paste: true} when the person chose to paste
 * instead, or null.
 */
function scanSheet({ title, idle, consider, wrong }) {
  return new Promise((resolve) => {
    let scanner = null;
    let done = false;
    const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true, 'aria-label': t('Camera picture'), 'data-testid': 'scan-video' });
    const stage = h('div', { class: 'scan-stage', 'data-testid': 'scan-stage' }, video, h('div', { class: 'scan-frame', 'aria-hidden': 'true' }));
    const status = h('p', { class: 'small center', 'aria-live': 'polite', 'data-testid': 'scan-status', text: t('Starting the camera…') });
    const problemBox = h('div');
    const photo = h('input', { type: 'file', accept: 'image/*', class: 'file-input', 'data-testid': 'scan-photo-input', 'aria-label': t('Choose a photo of the QR code') });
    const photoBtn = h('label', { class: 'btn btn-secondary' }, icon('file'), t('Use a photo'), photo);
    const pasteBtn = secondary(h('span', {}, t('Paste instead')), () => finish({ paste: true }), { 'data-testid': 'scan-paste' });
    const privacy = h('p', { class: 'small center', text: t('The picture stays on this phone: Firo PWA reads the code here and keeps nothing.') });

    const finish = (v) => {
      if (done) return;
      done = true;
      if (scanner) scanner.stop();
      sheet.close(v);
    };
    // A code this scanner does not want: say what it is, keep looking.
    const take = (text) => {
      const v = consider(text);
      if (v) {
        finish(v);
        return true;
      }
      status.textContent = wrong(text);
      status.className = 'small center bad-text';
      return false;
    };

    const sheet = openSheet(
      () => [
        h('h2', { text: title }),
        stage,
        status,
        problemBox,
        privacy,
        h('div', { class: 'btn-row' }, pasteBtn, photoBtn),
        textButton(t('Cancel'), () => finish(null), { 'data-testid': 'scan-cancel' }),
      ],
      { label: title },
    );
    sheet.then((v) => {
      if (scanner) scanner.stop();
      done = true;
      resolve(v || null);
    });

    function showProblem(e) {
      const p = cameraProblem(e);
      stage.classList.add('hidden');
      privacy.classList.add('hidden');
      pasteBtn.classList.add('hidden'); // the problem box has its own, as the primary way on
      status.textContent = '';
      put(problemBox, h('div', { 'data-testid': 'scan-problem', 'data-code': p.code }, notice('warn', p.text)), primary(t('Paste instead'), () => finish({ paste: true }), { 'data-testid': 'scan-problem-paste' }));
    }

    photo.addEventListener('change', async () => {
      const f = photo.files && photo.files[0];
      photo.value = '';
      if (!f) return;
      status.className = 'small center';
      status.textContent = t('Reading the photo…');
      try {
        const text = await scanImageFile(f);
        if (!text) {
          status.textContent = t('No QR code found in that photo. Try a sharper one, closer to the code.');
          return;
        }
        take(text);
      } catch {
        status.textContent = t("That photo couldn't be read. Try another, or paste instead.");
      }
    });

    if (!cameraSupported()) return showProblem({ name: 'unsupported' });
    startCameraScan(video, { onText: take })
      .then((s) => {
        if (done) return s.stop();
        scanner = s;
        status.textContent = idle;
      })
      .catch((e) => {
        if (!done) showProblem(e);
      });
  });
}

/**
 * A Firo address (or a Spark name) for Send and the contact form. Resolves {address, amount?, memo?}
 * (lib/qr_scan.js parseScanned), {paste: true}, or null. Another kind of code is named as such;
 * scanning goes on.
 */
export function scanAddress({ title = t('Scan a QR code') } = {}) {
  return scanSheet({
    title,
    idle: t('Point the camera at the QR code of a Firo address.'),
    consider: (text) => {
      const r = recognize(text);
      return r.kind === 'firo' || r.kind === 'name' ? parseScanned(text) : null;
    },
    wrong: (text) => elsewhere(text, 'firo') || t("That QR code isn't a Firo address. Point the camera at the receiver's address."),
  });
}

/** An Ethereum address for Ethereum Send: {kind: 'eth', to, valueWei?, token?}, {paste: true}, or null. */
export function scanEthAddress({ title = t('Scan an Ethereum address') } = {}) {
  return scanSheet({
    title,
    idle: t('Point the camera at the QR code of an Ethereum address.'),
    consider: (text) => {
      const r = recognize(text);
      return r.kind === 'eth' ? r : null;
    },
    wrong: (text) => elsewhere(text, 'eth') || t("That QR code isn't an Ethereum address."),
  });
}

/** Home's Scan: anything with a meaning (lib/scan_recognize.js), {paste: true}, or null. */
export function scanAnything({ title = t('Scan a QR code') } = {}) {
  return scanSheet({
    title,
    idle: t('Point the camera at a QR code: a Firo or Ethereum address, or a payment link.'),
    consider: (text) => {
      const r = recognize(text);
      return r.kind === 'empty' ? null : { ...r, text: String(text).trim().slice(0, 2000) };
    },
    wrong: () => '',
  });
}
