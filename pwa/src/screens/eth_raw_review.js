/* Review a payment another feature asked for (lib/eth/send_raw.js: the Rosen bridge's exit, rsFIRO
 * back to FIRO), on Ethereum or BNB Chain
 * Spec: ONE job: show in plain words what this payment does before anything is signed.
 *       Primary CTA: "<caller's title>" (e.g. "Send 100 rsFIRO to the bridge"), then Face ID /
 *       password; secondary: "Cancel".
 *       Taps from app open: whatever opened it (the bridge: 3), then this button.
 * Exit-intent reasons and answers:
 *   - "What exactly am I signing?" -> the caller's own words (title, amount, its rows, its warning),
 *     the chain, where the token goes (the address, grouped) and the network fee as "about" and
 *     "at most". Never "raw data", never hex.
 *   - "Is this safe?" -> only a transfer of this wallet's rsFIRO, of no more than it holds, carrying
 *     no ETH or BNB, gets this far; anything else was refused before this screen opened.
 *   - "Can I undo it?" -> no, said before the button.
 *   - "The server refused it - did it leave?" -> its status screen, "Not sent yet": most likely not,
 *     but the server may have passed it on, so it is followed there and not offered here again.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, textButton, notice, holdTaps } from '../lib/ui.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { prepareCall, signAndBroadcastCall, SendError } from '../lib/eth/send.js';
import { EthRpcError } from '../lib/eth/rpc.js';
import { rawRequest, claimRawRequest, settleRawRequest, rawOutcome, RawSendError } from '../lib/eth/send_raw.js';
import { coinText, coinMaxText, amountText, groupedAddress, serverProblem, doubtNotice } from './eth_ui.js';
import { inDoubt } from '../lib/eth/outbox.js';
import { shortNow } from '../lib/eth/short_now.js';
import { t } from '../lib/i18n.js';

export default function ethRawReview(app, params = {}) {
  const req = rawRequest(params.id);
  // Gone, or already under way on a review that was left while it signs: never offered a second
  // time (it would be signed twice). Ethereum's activity shows it once it has left.
  if (!req || !claimRawRequest(params.id)) {
    queueMicrotask(() => app.go('ethHome', {}, { replace: true }));
    return { el: h('div') };
  }
  const { call, words } = req;
  const chainKey = call.chain.key;
  const msg = h('div', { 'aria-live': 'polite' });
  const feeBox = h('div');
  let w = null;
  let prepared = null;
  let settled = false;
  let busy = false;
  let sending = false; // from the password to the outcome: Cancel waits
  let gone = false; // the screen was left (another screen, a lock)

  const cta = primary(words.title, confirm, { disabled: true, 'data-testid': 'raw-confirm' });

  function finish({ hash = null, error = null, refused = false, sent = true }) {
    if (settled) return;
    settled = true;
    settleRawRequest(req.id, { hash, error, refused, sent });
  }

  function cancel() {
    // Past the password the payment is on its way to being signed: Cancel can no longer promise
    // "nothing was sent", so it waits for the outcome (release audit 0.1.7, S1).
    if (sending) return;
    finish({ error: new RawSendError('cancelled', t('Cancelled: nothing was sent.')) });
    app.back(req.back, req.backParams);
  }

  async function prepare() {
    put(feeBox, h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', text: t('Checking…') })));
    try {
      w = await ethWallet(app);
      if (!w) throw new RawSendError('locked', t('There is no Ethereum / BNB Chain wallet on this device.'));
      // An earlier transaction in doubt on this chain: nothing new is signed until it settles (audit BM-1).
      const doubt = inDoubt(await w.reloadOutbox(), chainKey)[0];
      if (doubt) {
        prepared = null;
        put(msg, doubtNotice(app, doubt, { testid: 'raw-in-doubt' }));
        put(feeBox, h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', text: '—' })));
        cta.disabled = true;
        return;
      }
      prepared = await prepareCall(w.rpcFor(chainKey), { from: w.state.address, to: call.to, data: call.data, value: 0n });
      // What may pay: the balances less what transactions still on their way hold (release audit 0.1.6).
      const free = w.spendable(chainKey);
      const heldCoin = free.held.eth ?? 0n;
      const heldTok = free.held[call.token.symbol] ?? 0n;
      const have = free.eth ?? 0n;
      const tokFree = free[call.token.symbol];
      if (tokFree != null && call.amount > tokFree) {
        put(msg, notice('error', heldTok > 0n ? t('That\'s more {symbol} than this wallet can send now on {chainName}: {amount} is free, and {held} more is held for a transaction still on its way. Nothing was sent.', { symbol: call.token.symbol, chainName: call.chain.name, amount: amountText(tokFree, call.token), held: amountText(heldTok, call.token) }) : t('That\'s more {symbol} than this wallet can send now on {chainName}: {amount} is free. Nothing was sent.', { symbol: call.token.symbol, chainName: call.chain.name, amount: amountText(tokFree, call.token) })));
        prepared = null;
      } else if (prepared.fees.upTo > have) {
        put(msg, notice('error', heldCoin > 0n ? t('The network fee is paid in {symbol}: up to {fee}, and this wallet has {amount} free ({held} more is held for a transaction still on its way) on {chainName}. Add some first; nothing was sent.', { symbol: call.chain.native.symbol, fee: coinMaxText(prepared.fees.upTo, chainKey), amount: coinText(have, chainKey), held: coinText(heldCoin, chainKey), chainName: call.chain.name }) : t('The network fee is paid in {symbol}: up to {fee}, and this wallet has {amount} on {chainName}. Add some first; nothing was sent.', { symbol: call.chain.native.symbol, fee: coinMaxText(prepared.fees.upTo, chainKey), amount: coinText(have, chainKey), chainName: call.chain.name })));
        prepared = null;
      }
    } catch (e) {
      prepared = null;
      put(msg, e instanceof EthRpcError ? serverProblem(app, e, { chain: chainKey, retry: prepare, switched: () => prepare() }) : notice('error', e instanceof SendError || e instanceof RawSendError ? e.message : t('It could not be prepared: {message}', { message: e.message })));
    }
    put(
      feeBox,
      h(
        'div',
        { class: 'kv' },
        h('span', { class: 'k', text: t('Network fee') }),
        prepared ? h('span', { class: 'v' }, h('span', { 'data-testid': 'raw-fee', text: t('about {amount}', { amount: coinText(prepared.fees.likely, chainKey) }) }), h('div', { class: 'small', text: t('at most {amount}', { amount: coinMaxText(prepared.fees.upTo, chainKey) }) })) : h('span', { class: 'v', text: '—' }),
      ),
    );
    cta.disabled = !prepared;
  }

  async function confirm() {
    if (busy || !prepared) return;
    busy = true;
    cta.disabled = true;
    put(msg);
    const ok = await confirmIdentity(app, { title: words.title, detail: t('{amountText} on {name}', { amountText: words.amountText, name: call.chain.name }), cta: t('Confirm') });
    if (!ok) {
      busy = false;
      cta.disabled = false;
      return;
    }
    // Left meanwhile (another screen, a lock): the caller already heard "cancelled"; nothing is signed.
    if (settled) return;
    sending = true;
    cta.textContent = t('Checking your balance…');
    try {
      // What can be spent, read again now (after the password): a transfer signed on old figures
      // (spent from another device meanwhile) fails on chain and still pays its fee.
      const why = await shortNow(w, chainKey, { asset: call.token, amount: call.amount, fees: prepared.fees.upTo, forWhat: t('this payment'), feeName: t('the network fee') });
      if (why) throw new SendError('not_enough', why);
      if (settled) return;
      // Too late for what it was worked out on (the Bridge's price: N2): nothing is signed.
      if (Number.isFinite(words.notAfter) && Date.now() > words.notAfter) throw new RawSendError('stale', words.lateText);
      cta.textContent = t('Sending…');
      const r = await signAndBroadcastCall(app, w.rpcFor(chainKey), prepared.tx, { kind: 'raw', asset: call.token, amount: call.amount, recipient: call.recipient, extra: { label: words.title.slice(0, 80) } }, { ethId: w.ethId, kv: w.kv });
      await w.reloadOutbox().catch(() => {});
      // Sent, refused by a server that may have passed it on first, or no answer at all: its status
      // screen follows it either way and says which ("Not sent yet" / "Sending" until it knows),
      // never "nothing was sent" too soon, and the caller hears it was not taken (FM-4).
      finish(rawOutcome(r));
      if (!gone) app.go('ethTx', { hash: r.entry.hash, chain: chainKey, justSent: true }, { replace: true });
    } catch (e) {
      sending = false;
      // Left while sending: the caller hears the real outcome now (nothing was sent), never "cancelled" before it.
      if (gone) return finish({ error: e instanceof RawSendError ? e : new RawSendError(e.code === 'not_enough' || e.code === 'locked' ? e.code : 'server', t('Nothing was sent. {message}', { message: e.message })), sent: false });
      busy = false;
      cta.disabled = false;
      cta.textContent = words.title;
      put(msg, notice('error', t('Nothing was sent. {message}', { message: e.message })));
    }
  }

  prepare();

  const el = screen(
    { title: t('Check before sending'), back: cancel, actions: [cta, textButton(t('Cancel'), cancel, { 'data-testid': 'raw-cancel' })] },
    h('div', { class: 'big-amount', 'data-testid': 'raw-amount', text: words.amountText }),
    h(
      'div',
      { class: 'card' },
      ...words.rows.map(([k, v]) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }))),
      h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network') }), h('span', { class: 'v', 'data-testid': 'raw-network', text: call.chain.name })),
      h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('{symbol} goes to', { symbol: call.token.symbol }) }), h('span', { class: 'v mono addr-groups', 'data-testid': 'raw-to', 'data-address': call.recipient, text: groupedAddress(call.recipient) })),
      feeBox,
    ),
    words.warning ? notice('warn', words.warning) : null,
    notice('info', t('{name} payments cannot be cancelled or undone once sent, and anyone can see them.', { name: call.chain.name })),
    msg,
  );
  // The button that opened this sits where its confirm is: the second tap of a double tap is held.
  const hold = holdTaps(el);
  return {
    el,
    destroy() {
      gone = true;
      hold.stop();
      // Left without confirming (another screen, a lock): the caller hears "cancelled". Left while the
      // payment is on its way to being signed: the caller hears its real outcome from confirm() instead.
      if (!settled && !sending) finish({ error: new RawSendError('cancelled', t('Cancelled: nothing was sent.')) });
    },
  };
}
