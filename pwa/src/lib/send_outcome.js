// What a Firo payment that failed means for the person, and what became of one that may have
// left: the screens' half of the contract with the engine (release audit FM-1).
//
// * The engine refuses some payments before anything is broadcast (NOT_SENT_CODES): nothing left
//   the wallet, for certain, and the same payment may be offered again. 'offline' is one of them:
//   the bytes never reached any node.
// * A node's error ANSWER to the broadcast ('server', with the node's words) means it was not
//   accepted: the engine forgets the payment and its coins are spendable again.
// * 'fee-changed': the figures the person reviewed (wallet.send's expect: {fee, total}) are not
//   the ones the engine would sign: nothing was signed.
// * A broadcast that reached a node and got no answer is 'unsure' and carries the txid: the engine
//   recorded the signed transaction before sending it, marks its coins pending and follows it
//   (the payment's Tx says unsure). It may have left: it is never offered again until the
//   engine says the network does not have it (the Tx says dropped: followVerdict 'gone').
// * Anything else (an error with no code) cannot be told apart from a payment that left:
//   'unknown', and the person looks in Activity first.
//
// Pure: no DOM, no engine; the screens (sell_order.js, bridge.js, privatize.js) bring both.

/**
 * The engine's refusals that come before anything is built or broadcast, and a node's refusal:
 * nothing left. Among them the private coin list checks (audit D-09: 'set-mismatch' and
 * 'set-disagree' carry otherServer, "Try another node"), an amount the engine cannot use, a
 * feature not there yet, asking public nodes while the person's own node is set (FM-7), and a
 * payment this device could not write down, which is then not kept nor sent ('storage', release
 * re-audit R-2), and one asked for while another was still being sent ('in-flight': one at a time,
 * release verification 0.1.8).
 */
export const NOT_SENT_CODES = Object.freeze(new Set(['offline', 'server', 'fee-changed', 'insufficient', 'invalid-address', 'invalid-amount', 'dust', 'not-synced', 'not-open', 'view-only', 'invalid', 'invalid-memo', 'set-mismatch', 'set-disagree', 'set-unchecked', 'NotYet', 'own-node', 'storage', 'in-flight', 'invalid-name', 'name-taken', 'conflict-coin']));

/** The words every screen says for an unsure payment (the contract's). */
export const UNSURE_TITLE = "Your payment may have left. Don't send it again yet: Campfire is checking.";

const TXID = /^[0-9a-f]{64}$/i;

/**
 * What a failed send means: {kind: 'not-sent' | 'unsure' | 'unknown', txid, otherServer}.
 * 'unsure' always has a txid; an 'unsure' without one cannot be followed, so it is 'unknown'.
 */
export function sendOutcome(e) {
  const code = e && e.code;
  const otherServer = Boolean(e && e.otherServer);
  if (code === 'unsure') return TXID.test(String(e.txid || '')) ? { kind: 'unsure', txid: String(e.txid).toLowerCase(), otherServer } : { kind: 'unknown', txid: null, otherServer };
  if (NOT_SENT_CODES.has(code)) return { kind: 'not-sent', txid: null, otherServer };
  return { kind: 'unknown', txid: null, otherServer };
}

/**
 * What became of a payment of ours that may have left, {txid}, from the wallet's own view w.state
 * (the engine's Tx flags):
 *   'left'      in a block: it went through;
 *   'gone'      the engine says the network does not have it (Tx.dropped): it may be paid again;
 *   'checking'  anything else: on its way, unsure, or not in the payments (yet): not offered again.
 */
export function followVerdict({ txid }, w) {
  const s = w && w.state;
  if (!s || !txid) return 'checking';
  const tx = (s.txs || []).find((t) => t.txid === txid);
  if (!tx) return 'checking';
  if (tx.dropped) return 'gone';
  return tx.confirmations > 0 && !tx.unproven ? 'left' : 'checking';
}
