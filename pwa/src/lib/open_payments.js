// Payments this wallet made that are not confirmed yet, by address (Review's "Paid before?").
// No imports: screens and their tests load it as it is.

/**
 * This wallet's payments to `address` that are not confirmed yet: on their way, or that may have left
 * (no answer after a node had them). Review says so before the same address is paid again (audit of
 * 0.1.8, X2: a payment re-entered by Scan or Contacts while the first one was being sent went again
 * with no word). A payment that did not go through (dropped) is not one of them.
 */
export function openPaymentsTo(txs, address) {
  const a = String(address || '').trim();
  if (!a) return [];
  const paid = (t) => t.counterparty === a || (Array.isArray(t.counterparties) && t.counterparties.includes(a));
  return (txs || []).filter((t) => t && t.direction === 'out' && paid(t) && !t.dropped && (t.unsure || !(Number(t.confirmations) > 0)));
}
