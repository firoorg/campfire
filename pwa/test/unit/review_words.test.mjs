// What the payment screens say when a payment fails or may have left: "not sent" only when the
// engine says so with its code; anything else may have left (release re-audit R-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendFailure } from '../../src/screens/review.js';

const coded = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const TXID = 'ab'.repeat(32);

test('release re-audit R-2: an error without a code is "could not tell", never "not sent"', () => {
  // The PoC's error: a store write that failed while the payment was written down.
  const f = sendFailure(new Error('QuotaExceededError: the quota has been exceeded'));
  assert.equal(f.kind, 'unknown');
  assert.equal(f.text, "Campfire couldn't tell whether the payment left: QuotaExceededError: the quota has been exceeded. Look in Activity before you send it again.");
  assert.doesNotMatch(f.text, /not sent|Nothing left/i);
  assert.equal(sendFailure(new Error('')).text, "Campfire couldn't tell whether the payment left. Look in Activity before you send it again.");
  // A code the engine never gives for "not sent", and an 'unsure' without a txid to follow.
  assert.equal(sendFailure(coded('other_tab', 'Campfire is open in another tab.')).kind, 'unknown');
  assert.equal(sendFailure(coded('unsure', "Your payment may have left. Don't send it again yet: Campfire is checking.")).kind, 'unknown');
});

test('release re-audit R-2: the engine\'s "not sent" codes, said once; an unsure payment goes to its status screen', () => {
  assert.deepEqual(sendFailure(coded('storage', 'This device could not save the payment, so it was not sent.')), { kind: 'not-sent', text: 'This device could not save the payment, so it was not sent.' });
  assert.deepEqual(sendFailure(coded('not-open', 'The wallet was locked, so the payment was not sent.')), { kind: 'not-sent', text: 'The wallet was locked, so the payment was not sent.' });
  assert.deepEqual(sendFailure(coded('server', 'The server refused: bad-txns-inputs-missingorspent')), { kind: 'not-sent', text: 'The payment was not sent: The server refused: bad-txns-inputs-missingorspent. Nothing left your wallet.' });
  assert.deepEqual(sendFailure(coded('set-mismatch', "This Firo node's list of private coins does not add up, so the payment was stopped to keep it private.", { otherServer: true })), {
    kind: 'not-sent',
    text: "The payment was not sent: This Firo node's list of private coins does not add up, so the payment was stopped to keep it private. Nothing left your wallet.",
  });
  assert.deepEqual(sendFailure(coded('unsure', 'may have left', { txid: TXID })), { kind: 'unsure', txid: TXID });
});

test('release re-audit R1-7: the payment status screen promises no time it cannot keep', async () => {
  const { UNSURE_NOTE } = await import('../../src/screens/tx_status.js');
  assert.equal(UNSURE_NOTE, 'The Firo node did not answer. If the payment did not leave, Activity says so once two Firo nodes confirm they do not have it.');
  assert.doesNotMatch(UNSURE_NOTE, /within|minutes/);
});
