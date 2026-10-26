// UI flows shared by the e2e tests. They drive the real screens by their data-testid hooks.
import { waitScreen, shot, sleep } from './harness.mjs';

const tid = (id) => `[data-testid="${id}"]`;
/** A restored wallet's words: the stand-in engine gives these its sample history. */
export const SAMPLE_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ');

/**
 * Welcome -> words (24, or 12 with words: 12) -> confirm -> password -> (passkey) -> Home.
 * Returns the words (throwaway wallets only, never screenshotted) and when setup ended.
 */
export async function createWallet(page, { password, passkey = false, shots = null, words: count = 24, passphrase = '' }) {
  await waitScreen(page, 'welcome', 60000);
  if (shots) await shot(page, `${shots}-01-welcome`);
  await page.click(tid('create'));
  await waitScreen(page, 'backup');
  if (count === 12) {
    await page.click(tid('word-count'));
    await waitScreen(page, 'backup');
  }
  await page.waitForSelector('[data-testid="words"] .word');
  if (shots) await shot(page, `${shots}-02-backup-hidden`);
  if (passphrase) {
    await page.click('[data-testid="advanced"] summary');
    await page.fill(tid('passphrase'), passphrase);
    await page.fill(tid('passphrase2'), passphrase); // typed twice (P10)
  }
  await page.click(tid('reveal'));
  const words = await page.$$eval('[data-testid="words"] .word span:last-child', (els) => els.map((e) => e.textContent));
  if (words.length !== count) throw new Error(`expected ${count} words, got ${words.length}`);
  // No screenshot of the revealed words: never a picture of a seed, not even a throwaway's.
  await page.click(tid('wrote-down'));
  await waitScreen(page, 'confirmWords');
  if (shots) await shot(page, `${shots}-04-confirm`);
  const positions = await page.$$eval('[data-position]', (els) => els.map((e) => Number(e.dataset.position)));
  for (const pos of positions) await page.click(`[data-position="${pos}"] [data-word="${words[pos - 1]}"]`);
  await page.click(tid('confirm-words'));
  await finishProtect(page, { password, passkey, shots });
  await waitScreen(page, 'home');
  return { words, connectedAt: Date.now() };
}

/** Restore -> paste words (-> Advanced: passphrase, starting block) -> password -> Home. */
export async function restoreWallet(page, { words = SAMPLE_WORDS, password, passphrase = '', height = null, passkey = false, shots = null }) {
  await waitScreen(page, 'welcome', 60000);
  await page.click(tid('restore'));
  await waitScreen(page, 'restore');
  if (shots) await shot(page, `${shots}-01-restore-empty`);
  await page.fill(tid('word-1'), words.join(' '));
  if (passphrase || height != null) {
    await page.click('[data-testid="advanced"] summary');
    if (passphrase) await page.fill(tid('passphrase'), passphrase);
    if (height != null) await page.fill(tid('restore-height'), String(height));
  }
  await page.waitForFunction(() => !document.querySelector('[data-testid="restore-submit"]').disabled, null, { timeout: 30000 });
  await page.click(tid('restore-submit'));
  await finishProtect(page, { password, passkey, shots: null });
  await waitScreen(page, 'home');
}

export async function finishProtect(page, { password, passkey, shots }) {
  await waitScreen(page, 'setPassword');
  await page.fill(tid('pw1'), password);
  await page.fill(tid('pw2'), password);
  if (shots) await shot(page, `${shots}-05-password`);
  await page.click(tid('save-password'));
  await page.waitForFunction(() => ['passkeySetup', 'home', 'unlock'].includes(document.getElementById('app').dataset.screen), null, { timeout: 30000 });
  if ((await page.evaluate(() => document.getElementById('app').dataset.screen)) === 'passkeySetup') {
    if (shots) await shot(page, `${shots}-06-passkey`);
    if (passkey) await page.click(tid('passkey-on'));
    else await page.click(tid('passkey-skip'));
  }
}

export async function waitHome(page, { timeout = 60000 } = {}) {
  await waitScreen(page, 'home', timeout);
}

export async function waitSynced(page, timeout = 60000) {
  await page.waitForFunction(() => window.__campfire && window.__campfire.sync().state === 'synced', null, { timeout, polling: 200 });
  return page.evaluate(() => ({ sync: window.__campfire.sync(), height: window.__campfire.height() }));
}

export async function unlockWithPassword(page, password) {
  await waitScreen(page, 'unlock', 60000);
  const pwVisible = await page.isVisible(tid('unlock-pw'));
  if (!pwVisible) await page.click(tid('use-password'));
  await page.fill(tid('unlock-pw'), password);
  await page.click(tid('unlock-submit'));
}

export async function lock(page) {
  await page.click(tid('lock'));
  await waitScreen(page, 'unlock');
}

export { sleep };
