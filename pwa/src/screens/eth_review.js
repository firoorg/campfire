/* Review a payment (a sheet over Send, Ethereum or BNB Chain)
 * Spec: ONE job: show exactly what leaves this wallet before anything is signed.
 *       Primary CTA: "Send <amount> <symbol>" (then Face ID / password).
 *       Taps from app open: 4 (Home -> Ethereum -> Send -> Send <amount>), then this button.
 * Exit-intent reasons and answers:
 *   - "What exactly am I signing?" -> the amount to every decimal, the full address in groups of
 *     four, the network fee as "about" and "at most", and the total.
 *   - "Will the fee surprise me?" -> "at most" is the very limit signed into the transaction; it
 *     cannot be exceeded. If it rose since this sheet opened, the new numbers are shown instead of sending.
 *   - "Can I undo it?" -> no, said before the button.
 */
import { payByState, payByText } from '../lib/pay_by.js';
import { h, shorten } from '../lib/dom.js';
import { openSheet, notice } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { prepareSend, signAndSend, costRose, SendError } from '../lib/eth/send.js';
import { freeNow } from '../lib/eth/short_now.js';
import { isNative } from '../lib/eth/tokens.js';
import { CHAINS } from '../lib/eth/chains.js';
import { amountText, exactText, coinText, coinMaxText, groupedAddress } from './eth_ui.js';

/** Re-checked before signing when the review is older than this. */
const FRESH_MS = 60000;

export function openEthReview(app, w, first, { payBy = null } = {}) {
  let prepared = first;
  let message = null;
  let busy = false;
  const sheet = openSheet((close, rerender) => {
    const p = prepared;
    const chainKey = p.asset.chain || 'ethereum';
    const chain = CHAINS[chainKey];
    const rpc = w.rpcFor(chainKey);
    const ethText = (v) => coinText(v, chainKey);
    const ethMaxText = (v) => coinMaxText(v, chainKey);
    const isEth = isNative(p.asset);
    const label = `Send ${amountText(p.amount, p.asset, { approx: false })}`;
    const total = isEth
      ? [h('span', { 'data-testid': 'eth-review-total', text: `about ${ethText(p.amount + p.fees.likely)}` }), h('div', { class: 'small', text: `at most ${ethMaxText(p.amount + p.fees.upTo)}` })]
      : [h('span', { 'data-testid': 'eth-review-total', text: `${amountText(p.amount, p.asset, { approx: false })} + about ${ethText(p.fees.likely)}` }), h('div', { class: 'small', text: `fee at most ${ethMaxText(p.fees.upTo)}` })];

    const confirm = async () => {
      if (busy) return;
      busy = true;
      message = null;
      try {
        if (Date.now() - prepared.preparedAt > FRESH_MS) {
          const fresh = await prepareSend(rpc, { from: w.state.address, asset: p.asset, recipient: p.recipient, amount: p.amount, balances: w.spendable(chainKey) });
          if (costRose(prepared, fresh)) {
            prepared = fresh;
            busy = false;
            message = notice('warn', 'The network fee changed since you opened this. Check the new amounts, then send.');
            return rerender();
          }
          prepared = { ...prepared, preparedAt: fresh.preparedAt };
        }
        // Closed meanwhile (the app moved on): no password sheet over the next screen.
        if (sheet.closed) return;
        const ok = await confirmIdentity(app, { title: 'Confirm the payment', detail: `${amountText(p.amount, p.asset, { approx: false })} to ${shorten(p.recipient, 8, 6)}`, cta: 'Confirm' });
        if (!ok || sheet.closed) {
          busy = false;
          return;
        }
        // What can be spent, read again now (after the password), and the payment prepared on it: a
        // token payment signed on old figures (spent from another device meanwhile) fails on chain and
        // still pays its fee. The fresh preparation is the one signed; costlier, it is shown first.
        message = h('p', { class: 'small center', 'data-testid': 'eth-checking', text: 'Checking your balance…' });
        rerender();
        const again = await prepareSend(rpc, { from: w.state.address, asset: p.asset, recipient: p.recipient, amount: p.amount, balances: await freeNow(w, chainKey) });
        // Closed meanwhile: nothing is sent (release audit 0.1.7, S2).
        if (sheet.closed) return;
        if (costRose(prepared, again)) {
          prepared = again;
          busy = false;
          message = notice('warn', 'The network fee changed since you opened this. Check the new amounts, then send.');
          return rerender();
        }
        prepared = again;
        // A Buy's address: still taking payments, with time to spare, now (XB).
        const late = payByState(payBy, prepared.recipient);
        if (late) {
          busy = false;
          message = h('div', { 'data-testid': 'eth-pay-by' }, notice('error', payByText(late)));
          return rerender();
        }
        message = h('p', { class: 'small center', 'data-testid': 'eth-sending', text: 'Signing and sending…' });
        rerender();
        const r = await signAndSend(app, rpc, prepared, { ethId: w.ethId });
        await w.reloadOutbox().catch(() => {});
        app.ethSendDraft = null;
        // Its status screen, only from this sheet: closed by the app moving on, the person stays there.
        if (sheet.closed) return;
        close(true);
        app.go('ethTx', { hash: r.entry.hash, chain: chainKey, justSent: true }, { replace: true });
      } catch (e) {
        busy = false;
        const why = e instanceof SendError ? e.message : `${e.message}${/\.$/.test(e.message) ? '' : '.'}`;
        message = notice('error', `Nothing was sent. ${why}`);
        rerender();
      }
    };

    return [
      h('h2', { text: 'Check before sending' }),
      h('div', { class: 'big-amount', 'data-testid': 'eth-review-amount', text: exactText(p.amount, p.asset) }),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: 'To' }), h('span', { class: 'v mono addr-groups', 'data-testid': 'eth-review-to', 'data-address': p.recipient, text: groupedAddress(p.recipient) })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network' }), h('span', { class: 'v', 'data-testid': 'eth-review-network', text: chain.name })),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Network fee' }), h('span', { class: 'v' }, h('span', { 'data-testid': 'eth-review-fee', text: `about ${ethText(p.fees.likely)}` }), h('div', { class: 'small', 'data-testid': 'eth-review-fee-max', text: `at most ${ethMaxText(p.fees.upTo)}` }))),
        h('div', { class: 'kv' }, h('span', { class: 'k', text: 'Total' }), h('span', { class: 'v' }, ...total)),
      ),
      // The server asked more than the ceiling (lib/eth/chains.js maxTipWei, audit P6): capped, and said.
      p.fees.capped ? notice('warn', `Your ${chain.name} server asked for an unusually high network fee, so Firo PWA offers its usual most instead. If ${chain.name} is really that busy, the payment waits longer.`) : null,
      notice('info', `${chain.name} payments cannot be cancelled or undone once sent, and anyone can see them.`),
      message,
      h('button', { class: 'btn btn-primary', onclick: confirm, disabled: busy, 'data-testid': 'eth-review-send' }, busy ? 'Sending…' : label),
      h('button', { class: 'btn btn-text', onclick: () => close(false), disabled: busy, 'data-testid': 'eth-review-change' }, 'Change'),
    ];
  }, { label: 'Check before sending', dismissable: false });
  return sheet;
}
