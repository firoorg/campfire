// A payment that must reach an address by a time: a Buy's deposit address, paid from the Ethereum
// wallet. Send and Review look again just before signing (audit of 0.1.8, XB: Buy checked the
// deadline only at its own "Pay" tap, so a Send or Review left open paid an address past it).
// One import, lib/i18n.js (its words): screens and their tests load it as it is.

/** Too close to the deadline to pay from here: a payment must reach the address in time. */
import { t } from './i18n.js';

export const PAY_BY_MARGIN_MS = 10 * 60 * 1000;

/**
 * 'past' (the address no longer takes payments), 'soon' (too close for a payment to be sure to reach
 * it), or null: also when `recipient` is no longer the address the deadline is for (the person
 * changed it).
 */
export function payByState(payBy, recipient, now = Date.now()) {
  if (!payBy || typeof payBy.address !== 'string' || !Number.isFinite(payBy.deadline)) return null;
  if (String(recipient || '').trim().toLowerCase() !== payBy.address.trim().toLowerCase()) return null;
  if (payBy.deadline <= now) return 'past';
  if (payBy.deadline - now <= PAY_BY_MARGIN_MS) return 'soon';
  return null;
}

/** What is said for a state of payByState, with nothing sent. */
export function payByText(state) {
  if (state === 'past') return t("This buy's address no longer takes payments, so nothing was sent. Start the buy again for a new address.");
  if (state === 'soon') return t("This buy's address takes payments for only a few more minutes: too soon for a payment from here to be sure to reach it in time, so nothing was sent. Start the buy again for a new address.");
  return '';
}
