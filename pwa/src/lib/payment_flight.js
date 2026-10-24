// One Firo payment at a time from this page's screens (release verification 0.1.8): from the moment
// the person's password or Face ID is given until the engine says what became of it. Review,
// Privatize, Get a Spark name, a sell's payment and a FIRO -> rsFIRO crossing offer nothing new meanwhile and say why, so a
// screen opened again while one is under way (Back during "Sending…", then Review again) shows that
// instead of offering the same payment a second time. Each screen also stops a run whose screen was
// left before the password. The engine refuses a second payment while one is in flight too
// (lib/firo/backend.js, code 'in-flight'): this is what the person sees before it gets that far.
//
// One import, lib/i18n.js (its words): it loads with the first screen (test/unit/first_paint_imports.test.mjs).

/** What a screen says while another payment is under way, on its button. */
import { tk } from './i18n.js';

export const IN_FLIGHT_TEXT = tk('Your last payment is still being sent…');
/** The same, as a sentence next to the button. */
export const IN_FLIGHT_NOTE = tk('Your last payment is still being sent. You can send again as soon as Firo PWA knows it left.');

let flight = null; // {kind} while a payment is under way
const watchers = new Set();

/** The payment under way, {kind: 'send' | 'privatize' | 'name' | 'sell' | 'bridge'}, or null. */
export function paymentInFlight() {
  return flight;
}

/**
 * Takes the one place for a payment: a function that gives it back (once its outcome is known), or
 * null while another payment is under way (nothing may be sent then).
 */
export function startPayment(kind) {
  if (flight) return null;
  const mine = { kind };
  flight = mine;
  tell();
  return () => {
    if (flight !== mine) return;
    flight = null;
    tell();
  };
}

/**
 * Gives the place back whatever holds it: on lock, once the engine has stopped (a payment under way has
 * settled or failed with it; the engine itself refuses a second payment while one runs). A flag left
 * by a payment that never settled must not keep every wallet from paying until a reload (audit 0.1.8).
 */
export function releasePayments() {
  if (!flight) return;
  flight = null;
  tell();
}

/** fn() whenever a payment starts or ends (an open screen's redraw). Returns the unsubscribe. */
export function onPaymentFlight(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function tell() {
  // One screen's redraw never keeps the others from theirs.
  for (const fn of [...watchers]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}
