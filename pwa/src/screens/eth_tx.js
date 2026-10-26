/* Transaction status, Ethereum or BNB Chain (right after sending; also any row of the activity)
 * Spec: ONE job: follow this payment until its chain has it.
 *       Primary CTA: "Done" (back to the Ethereum & BNB Home); secondary: "View on Etherscan" /
 *       "View on BscScan" (a link).
 *       Taps from app open: 5 after sending (Ethereum, Send, Send <amount>, Send <amount>, Face ID);
 *       2 from the activity list.
 * Exit-intent reasons and answers:
 *   - "Did it go through?" -> live status in words: waiting for the network -> confirmed, with the block.
 *   - "It failed - is my money gone?" -> says what was spent (only the network fee) and that the
 *     amount stayed; "replaced" and "not sent" say plainly that nothing more will happen.
 *     "Replaced" only once the server showed the transaction that took its place (signed by this
 *     wallet: lib/eth/send.js), which is named here.
 *   - "The server says it was replaced, but shows nothing" -> "Not sure yet": don't send it again
 *     yet (the first one may still go through and it would be paid twice); the same payment keeps
 *     being offered and checked; Etherscan is one tap to look for yourself.
 *   - "The server refused it - did it leave?" -> "Not sent yet": most likely not, but the server
 *     may have passed it on, so it is checked for half an hour before it says "Not sent".
 *   - "The app lost signal while sending" -> it was saved before sending; the same bytes go again by
 *     themselves, never a second payment.
 *   - "Can I check elsewhere?" -> the hash copies with a tap, and the chain's explorer is one tap.
 */
import { h, put, shorten, fmtDate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, copyText } from '../lib/ui.js';
import { ethWallet } from '../lib/eth/wallet.js';
import { entryFee } from '../lib/eth/send.js';
import { txExplorerUrl } from '../lib/eth/hosts.js';
import { tokenBySymbol, nativeFor } from '../lib/eth/tokens.js';
import { entryChain } from '../lib/eth/outbox.js';
import { CHAINS } from '../lib/eth/chains.js';
import { amountText, coinText, coinMaxText, groupedAddress, receiptsRefusedNotice } from './eth_ui.js';
import { t } from '../lib/i18n.js';

const FOLLOW_MS = 4000;

function texts(state, assetSym, chainName = 'Ethereum', { unsure = false, refused = false, unseen = false, failing = false } = {}) {
  // One server says it failed; no second one has confirmed that yet (lib/eth/send.js, X7).
  if (failing && (state === 'signed' || state === 'pending'))
    return { title: t('Checking'), icon: 'clock', cls: 'wait', kind: 'warn', note: t('Don\'t send it again yet. Your {chainName} server says this payment failed, so only its network fee was spent, but no second server has confirmed that yet. If it is wrong, the payment went through. Firo PWA keeps checking, and signs nothing new on {chainName} until it knows.', { chainName }) };
  // The server says this payment's place was taken but cannot show by what: it may still go through.
  if (unsure && (state === 'signed' || state === 'pending'))
    return { title: t('Not sure yet'), icon: 'clock', cls: 'wait', kind: 'warn', note: t('Don\'t send it again yet. Your {chainName} server says another transaction from this wallet took this payment\'s place, but it can\'t show that transaction, so this payment may still go through. The same payment (never a second one) keeps being offered, and this screen updates by itself.', { chainName }) };
  // The server refused the bytes, but may have passed them on first.
  if (refused && state === 'signed')
    return { title: t('Not sent yet'), icon: 'clock', cls: 'wait', kind: 'warn', note: t('Don\'t send it again yet. Your {chainName} server refused this payment, so it has most likely not left, but it may have passed it on before refusing. Firo PWA keeps checking it, and offering the same payment (never a second one), for half an hour; if it never reaches {chainName}, this then says "Not sent".', { chainName }) };
  switch (state) {
    case 'signed':
      return { title: t('Sending'), icon: 'clock', cls: 'wait', kind: 'info', note: t('Saved on this device and being handed to {chainName}. If the connection drops, the same payment is sent again by itself - never twice.', { chainName }) };
    case 'pending':
      return { title: t('Waiting for {chainName}', { chainName }), icon: 'clock', cls: 'wait', kind: 'info', note: t('On its way. {chainName} usually takes it into a block within a minute. You can leave this screen; it carries on without the app.', { chainName }) };
    case 'confirmed':
      return { title: t('Payment confirmed'), icon: 'check', cls: 'ok', kind: 'success', note: t('{chainName} has it in a block. It cannot be undone.', { chainName }) };
    case 'failed':
      return { title: t('Payment failed'), icon: 'close', cls: 'bad', kind: 'error', note: t('{chainName} refused it, so no {assetSym} was sent. Only the network fee was spent.', { chainName, assetSym }) };
    case 'replaced':
      // Two servers' word, neither able to show what took its place (lib/eth/send.js, R-1).
      if (unseen) return { title: t('Replaced'), icon: 'close', cls: 'bad', kind: 'info', note: t('Another transaction from this wallet took its place on {chainName}: your {chainName} server and a second one both show its place used for good, though neither can show by what (most likely a wallet with the same words or key sent it). This payment can no longer go through, and its amount did not leave.', { chainName }) };
      return { title: t('Replaced'), icon: 'close', cls: 'bad', kind: 'info', note: t('Another transaction from this wallet, sent from this device or another one with the same words, took its place on {chainName}. This payment will not happen, and its amount did not leave.', { chainName }) };
    case 'rejected':
      return { title: t('Not sent'), icon: 'close', cls: 'bad', kind: 'error', note: t('Your {chainName} server refused it for half an hour and never showed it, so it most likely never left and nothing was spent. That is the server\'s word: the explorer below shows what {chainName} itself has, and Firo PWA looks again now and then.', { chainName }) };
    default:
      return { title: t('Payment'), icon: 'clock', cls: 'wait', kind: 'info', note: '' };
  }
}

export default function ethTx(app, p = {}) {
  const body = h('div', { class: 'stack' });
  // Which chain: the caller's word, the activity row's, or Ethereum until the entry says.
  let chainKey = p.chain === 'bsc' || (p.item && p.item.chain === 'bsc') ? 'bsc' : 'ethereum';
  const ethText = (v) => coinText(v, chainKey);
  const ethMaxText = (v) => coinMaxText(v, chainKey);
  let w = null;
  let entry = null;
  let refused = null; // this payment's chain's server refuses receipts (lib/eth/rpc.js 'receipts_refused')
  let dead = false;

  function render() {
    if (dead) return;
    // A row from the history index (not sent from this device): show what the index said.
    const item = p.item || null;
    const state = entry ? entry.state : item ? item.state : 'pending';
    if (entry) chainKey = entryChain(entry);
    const coin = nativeFor(chainKey);
    const asset = entry ? (entry.token ? tokenBySymbol(entry.asset, chainKey) || coin : coin) : item ? item.asset : coin;
    const amount = entry ? BigInt(entry.amount) : item ? item.amount : 0n;
    const to = entry ? entry.to : item && item.direction !== 'in' ? item.counterparty : null;
    const from = !entry && item && item.direction === 'in' ? item.counterparty : null;
    const item2 = texts(state, asset.symbol, CHAINS[chainKey].name, { unsure: Boolean(entry && entry.unsureSince), refused: Boolean(entry && entry.refusedAt), unseen: Boolean(entry && entry.replacedUnseen), failing: Boolean(entry && entry.failedSeen) });
    const title = !entry && item && item.direction === 'in' ? (state === 'failed' ? t('Failed') : t('Received {symbol}', { symbol: asset.symbol })) : item2.title;
    const fee = entry ? entryFee(entry) : item && item.fee != null ? { wei: item.fee, final: true } : null;
    const block = entry && entry.receipt ? entry.receipt.blockNumber : item ? item.blockNumber : null;
    put(
      body,
      h('div', { class: `status-icon ${item2.cls}` }, icon(item2.icon)),
      h('h2', { class: 'title center', 'data-testid': 'eth-tx-title', 'data-state': state, 'data-unseen': entry && entry.replacedUnseen && state === 'replaced' ? 'true' : null, 'data-unsure': entry && entry.unsureSince ? 'true' : null, 'data-failing': entry && entry.failedSeen ? 'true' : null, 'data-refused': entry && entry.refusedAt && state === 'signed' ? 'true' : null, text: title }),
      h('div', { class: 'big-amount', 'data-testid': 'eth-tx-amount', text: amountText(amount, asset) }),
      h(
        'div',
        { class: 'card' },
        to ? h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('To') }), h('span', { class: 'v mono addr-groups', text: groupedAddress(to.startsWith('0x') ? to : `0x${to}`) })) : null,
        from ? h('div', { class: 'kv kv-stack' }, h('span', { class: 'k', text: t('From') }), h('span', { class: 'v mono addr-groups', text: groupedAddress(from) })) : null,
        fee ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Network fee') }), h('span', { class: 'v', 'data-testid': 'eth-tx-fee', 'data-wei': String(fee.wei), text: fee.final ? ethText(fee.wei) : t('at most {amount}', { amount: ethMaxText(fee.wei) }) })) : null,
        block ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Block') }), h('span', { class: 'v', 'data-testid': 'eth-tx-block', text: block.toLocaleString('en-US') })) : null,
        entry ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Sent') }), h('span', { class: 'v', text: fmtDate(Math.floor(entry.createdAt / 1000)) })) : null,
        h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Transaction') }), h('button', { class: 'v mono btn-text', 'data-testid': 'eth-tx-hash', 'data-hash': p.hash, onclick: () => copyText(p.hash, t('Transaction hash copied')), text: shorten(p.hash, 10, 8) })),
        entry && state === 'replaced' && entry.replacedBy ? h('div', { class: 'kv' }, h('span', { class: 'k', text: t('Replaced by') }), h('button', { class: 'v mono btn-text', 'data-testid': 'eth-tx-replaced-by', 'data-hash': entry.replacedBy, onclick: () => copyText(entry.replacedBy, t('Transaction hash copied')), text: shorten(entry.replacedBy, 10, 8) })) : null,
      ),
      item2.note && (entry || item) ? notice(item2.kind, item2.note) : null,
      refused && (state === 'signed' || state === 'pending') ? receiptsRefusedNotice(app, chainKey, { what: 'payment', onSwitched: () => follow() }) : null,
      entry && entry.error && (state === 'signed' || state === 'rejected') ? h('p', { class: 'small', 'data-testid': 'eth-tx-error', text: t('The server said: {error}', { error: entry.error }) }) : null,
    );
  }

  async function follow() {
    if (dead || !w || !entry || document.visibilityState !== 'visible' || !app.dbPass) return;
    // A "Not sent" too, slowly (lib/eth/send.js recheckClosed): it is one server's word.
    if (entry.state !== 'signed' && entry.state !== 'pending' && entry.state !== 'rejected') return;
    try {
      await w.followOpen();
    } catch {
      /* the next look tries again */
    }
    if (dead) return;
    entry = w.state.outbox.find((e) => e.hash === p.hash) || entry;
    // This payment's own look, on its own chain's server (release audit 0.1.5, S2): another
    // chain's refusing server never shows here. Said when it refuses receipts, and gone the look after.
    const err = w.followError(p.hash);
    refused = err && err.code === 'receipts_refused' && err.chain === entryChain(entry) ? err : null;
    render();
  }

  // Receipts only while this screen is visible and the wallet unlocked.
  const timer = setInterval(follow, FOLLOW_MS);
  const onVis = () => follow();
  document.addEventListener('visibilitychange', onVis);

  (async () => {
    w = await ethWallet(app).catch(() => null);
    if (!w || dead) return w ? null : app.go('ethHome');
    entry = w.state.outbox.find((e) => e.hash === p.hash) || null;
    render();
    setLink();
    follow();
  })();
  render();

  const linkBox = h('div');
  let titleEl = null;
  function setLink() {
    const c = CHAINS[chainKey];
    put(linkBox, /^0x[0-9a-fA-F]{64}$/.test(p.hash || '') ? h('a', { class: 'btn btn-text', href: txExplorerUrl(p.hash, chainKey), target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'eth-tx-explorer' }, icon('external'), t('View on {name}', { name: c.explorer.name })) : null);
    if (titleEl) titleEl.textContent = t('{name} payment', { name: c.name });
  }
  setLink();
  const el = screen({ title: t('{name} payment', { name: CHAINS[chainKey].name }), back: () => app.back('ethHome'), actions: [primary(t('Done'), () => app.go('ethHome'), { 'data-testid': 'eth-tx-done' }), linkBox] }, body);
  titleEl = el.querySelector('.topbar h1');
  return {
    el,
    destroy() {
      dead = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
