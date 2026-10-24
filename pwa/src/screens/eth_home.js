/* Ethereum & BNB Home (Home's switcher -> Ethereum & BNB)
 * Spec: ONE job: see what the EVM wallet holds on Ethereum and on BNB Chain, and get rsFIRO with it.
 *       Primary CTA: "Buy rsFIRO" when there is ETH or BNB to pay with (on the chain that has it),
 *       otherwise "Receive"; Send and Receive beside it.
 *       Taps from app open: 1 (Home -> Ethereum & BNB); Buy rsFIRO, Send or Receive is 2.
 * Exit-intent reasons and answers:
 *   - "Is this balance real / current?" -> each chain names its server and the block it answered at,
 *     or, when it didn't answer, who failed and the ways out (try again, another server, all servers).
 *   - "Why does BNB Chain say another server?" -> once, after the default moved from PublicNode
 *     (it stopped confirming payments): a sheet over the first Ethereum & BNB screen opened
 *     (screens/eth_server_note.js).
 *   - "Which chain is my money on?" -> two cards, Ethereum and BNB Chain, each with its coin and
 *     its tokens; one address for both, said once at the top.
 *   - "Where did my payment go?" -> what this device sent shows at once, with its chain and status
 *     in words, before any history index knows of it.
 *   - "Empty, now what?" -> the primary button becomes Receive; the empty list says so.
 *   - "How do I get FIRO here?" -> Buy rsFIRO (Uniswap on Ethereum, PancakeSwap on BNB Chain) is the
 *     primary as soon as there is ETH or BNB; rsFIRO is FIRO on those chains, public, and says so.
 *   - "I have BTC, not ETH" -> "Pay with any coin" (NEAR Intents) under the buttons, which also
 *     shows a swap still on its way.
 *   - "Where's my FIRO?" -> the switcher at the top is one tap back.
 *   - "Why no history on BNB Chain?" -> said under the list: there is no index for it here; only
 *     what this device sent is listed (and what arrives shows in the balance).
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, toast, copyText } from '../lib/ui.js';
import { ethWallet, evmPrefs } from '../lib/eth/wallet.js';
import { tokensFor, nativeFor } from '../lib/eth/tokens.js';
import { CHAINS, CHAIN_KEYS } from '../lib/eth/chains.js';
import { formatUnits } from '../lib/eth/units.js';
import { chainSwitch } from './eth_screens.js';
import { payWithCoinEntry } from './near_intents_entry.js';
import { intentsFor, openSwaps } from '../lib/intents/wiring.js';
import { ethBadge, compactAmountText, exactText, serverProblem, activityRow, tokenNote, entryScreen } from './eth_ui.js';
import { inDoubt, entryChain } from '../lib/eth/outbox.js';
import { rememberNearSwaps } from '../lib/notify.js';
import { t, tn } from '../lib/i18n.js';

const REFRESH_MS = 30000;
const FOLLOW_MS = 4000;
/** Each chain's test ids, kept from when this was Ethereum's screen alone. */
const IDS = Object.freeze({ ethereum: { balance: 'eth-balance', status: 'eth-status' }, bsc: { balance: 'bsc-balance', status: 'bsc-status' } });

export default function ethHome(app, params = {}) {
  const addressBox = h('div');
  const chainsBox = h('div', { class: 'stack' });
  const actionsBox = h('div', { class: 'actions eth-actions' });
  const activityBox = h('div');
  // NEAR Intents: nothing is asked of it here; the row reads this device's swaps under way.
  const intentsBox = h('div', {}, payWithCoinEntry(app, { testid: 'eth-pay-other-coin', swaps: intentsFor(app).then((c) => (c ? openSwaps(c.store) : [])).then((l) => (rememberNearSwaps(l), l)) }));
  let w = null;
  let off = null;
  let dead = false;

  /** One chain's card: its coin, its tokens with a balance, the server's line, its problem if any. */
  function chainCard(k) {
    const c = w.chain(k);
    const pref = evmPrefs(app, k);
    const coin = nativeFor(k);
    const known = c.native !== null;
    const status = c.loading && !known ? { cls: 'wait', text: t('Asking {name}…', { name: pref.host.name }) } : c.error ? { cls: 'bad', text: t('{name} didn\'t answer', { name: pref.host.name }) } : known ? { cls: 'ok', text: t('{name} · block {block}', { name: pref.host.name, block: c.block.toLocaleString('en-US') }) } : { cls: 'wait', text: t('Not checked yet') };
    const tokens = tokensFor(k)
      .map((token) => [token, c.tokens.get(token.symbol)])
      .filter(([, v]) => v != null && v > 0n);
    return h(
      'div',
      { class: 'card list', 'data-testid': `evm-card-${k}` },
      h('div', { class: 'row asset-row' }, ethBadge(coin), h('span', { class: 'main' }, h('div', { class: 't', text: CHAINS[k].name }), h('div', { class: 's', text: coin.symbol })), h('span', { class: 'end strong', 'data-testid': IDS[k].balance, 'data-wei': known ? String(c.native) : '', title: known ? exactText(c.native, coin) : null, text: known ? `${formatUnits(c.native, 18)} ${coin.symbol}` : '—' })),
      ...tokens.map(([token2, v]) =>
        h(
          'div',
          { class: 'row asset-row', 'data-testid': 'eth-token-row', 'data-symbol': token2.symbol, 'data-chain': k },
          ethBadge(token2),
          h('span', { class: 'main' }, h('div', { class: 't', text: token2.name }), h('div', { class: 's', text: tokenNote(token2) })),
          h('span', { class: 'end', 'data-testid': 'eth-token-balance', 'data-units': String(v), title: exactText(v, token2), text: compactAmountText(v, token2) }),
        ),
      ),
      h('div', { class: 'row small' }, h('div', { class: 'syncline', 'data-testid': IDS[k].status, 'data-state': status.cls }, h('span', { class: `dot ${status.cls}` }), h('span', { text: status.text }))),
      c.error ? serverProblem(app, c.error, { chain: k, retry: refresh, switched: (alt) => { toast(t('Using {name}', { name: alt.name })); refresh(); } }) : null,
    );
  }

  function render(s) {
    if (dead || !w) return;
    put(
      addressBox,
      h(
        'div',
        { class: 'card balance' },
        h('div', { class: 'label', text: t('Your address on Ethereum and BNB Chain') }),
        h(
          'button',
          { class: 'addr-chip', onclick: () => copyText(s.address, t('Address copied')), 'data-testid': 'eth-address', 'data-address': s.address, 'aria-label': t('Copy address') },
          h('span', { class: 'mono', text: shorten(s.address, 6, 4) }),
          icon('copy'),
        ),
      ),
    );
    put(chainsBox, ...CHAIN_KEYS.map(chainCard));

    const holds = (k) => {
      const c = w.chain(k);
      return (c.native ?? 0n) > 0n || [...c.tokens.values()].some((v) => (v ?? 0n) > 0n);
    };
    const hasFunds = CHAIN_KEYS.some(holds);
    // Buy rsFIRO pays with the chain's own coin: on the first chain that has some.
    const payChain = CHAIN_KEYS.find((k) => (w.chain(k).native ?? 0n) > 0n) || null;
    const buyBtn = (payChain ? primary : secondary)(h('span', {}, t('Buy rsFIRO')), () => (payChain === 'bsc' ? app.go('ethSwapBsc') : app.go('ethSwap', { pay: 'ETH', receive: 'rsFIRO' })), { 'data-testid': 'eth-buy-rsfiro', 'data-chain': payChain || 'ethereum' });
    buyBtn.prepend(icon('buy'));
    const sendBtn = secondary(h('span', {}, t('Send')), () => app.go('ethSend'), { disabled: !hasFunds, 'data-testid': 'eth-send' });
    sendBtn.prepend(icon('send'));
    const recvBtn = (payChain ? secondary : primary)(h('span', {}, payChain ? t('Receive') : t('Receive ETH or BNB')), () => app.go('ethReceive'), { 'data-testid': 'eth-receive' });
    recvBtn.prepend(icon('receive'));
    const known = CHAIN_KEYS.some((k) => w.chain(k).native !== null);
    // A transaction in doubt holds up every new one on its chain (audit BM-1): said before Send.
    const doubt = inDoubt(s.outbox);
    const doubtNames = [...new Set(doubt.map((e) => CHAINS[entryChain(e)].name))];
    const doubtChains = doubtNames.length > 1 ? t('{list} and {last}', { list: doubtNames.slice(0, -1).join(', '), last: doubtNames[doubtNames.length - 1] }) : doubtNames[0];
    put(
      actionsBox,
      doubt.length
        ? h('div', { 'data-testid': 'eth-doubt-line' }, notice('warn', tn({ one: 'A transaction on {chains} is not settled yet: nothing new is signed there until it is. ', other: '{n} transactions on {chains} are not settled yet: nothing new is signed there until they are. ' }, doubt.length, { chains: doubtChains }), h('button', { class: 'btn-link', 'data-testid': 'eth-doubt-see', onclick: () => app.go(...entryScreen(doubt[0])) }, t('See it'))))
        : null,
      h('div', { class: 'btn-row three' }, ...(payChain ? [buyBtn, sendBtn, recvBtn] : [recvBtn, sendBtn, buyBtn])),
      known && !payChain && hasFunds ? h('p', { class: 'small center', 'data-testid': 'eth-no-gas', text: t('Swaps and token payments need a little ETH or BNB for the network fee.') }) : null,
    );

    const ethPref = evmPrefs(app, 'ethereum');
    const items = w.activity().slice(0, 10);
    const hist = s.history;
    put(
      activityBox,
      h('p', { class: 'section-title', text: t('Recent activity') }),
      items.length
        ? h('div', { class: 'card list', 'data-testid': 'eth-activity' }, ...items.map((i) => activityRow(i, () => app.go(i.kind === 'swap' || i.kind === 'approve' || i.kind === 'approveReset' ? (i.chain === 'bsc' ? 'ethTx' : 'ethSwapTx') : 'ethTx', { hash: i.hash, item: i, chain: i.chain }))))
        : h('div', { class: 'card empty', 'data-testid': 'eth-activity-empty' }, icon('activity'), h('p', { text: known ? t('Nothing yet. Payments to and from this address show up here.') : t('Payments show up here once the servers have answered.') })),
      !ethPref.history
        ? h('p', { class: 'small', 'data-testid': 'eth-history-off' }, ethPref.historyHeld ? t("Ethereum: only what this device sent is shown: Stack Wallet's history index is not asked while your own Ethereum server is in use. ") : t('Ethereum: only what this device sent is shown, because History from Stack Wallet is off. '), h('button', { class: 'btn-link', onclick: () => app.go('ethSettings') }, t('Settings')))
        : hist.error
          ? h('p', { class: 'small', 'data-testid': 'eth-history-error', text: t('Older Ethereum payments could not be loaded: {error} What this device sent is shown.', { error: hist.error }) })
          : null,
      h('p', { class: 'small', 'data-testid': 'bsc-history-note', text: t('BNB Chain: only what this device sent is listed (there is no history index for it here). What arrives shows in the balance above.') }),
    );
  }

  let busy = false;
  async function refresh() {
    if (!w || busy || dead || !app.dbPass) return;
    busy = true;
    try {
      await w.refresh();
      if (!dead && app.dbPass) await w.followOpen().catch(() => {});
    } finally {
      busy = false;
    }
  }

  // Only while this screen is visible and the wallet unlocked.
  const visible = () => document.visibilityState === 'visible' && app.dbPass && !dead;
  const timer = setInterval(() => visible() && refresh(), REFRESH_MS);
  const follower = setInterval(() => {
    if (visible() && w && w.state.outbox.some((e) => e.state === 'signed' || e.state === 'pending')) w.followOpen().catch(() => {});
  }, FOLLOW_MS);
  const onVis = () => visible() && refresh();
  document.addEventListener('visibilitychange', onVis);

  (async () => {
    try {
      w = await ethWallet(app);
    } catch (e) {
      put(chainsBox, notice('error', t('The Ethereum & BNB wallet could not be opened: {message}', { message: e.message })));
      return;
    }
    if (dead) return;
    if (!w) return app.go('ethStart');
    off = w.onChange(render);
    render(w.state);
    if (params.created) toast(params.created === 'import' ? t('Ethereum & BNB wallet imported') : t('Ethereum & BNB wallet ready'));
    refresh();
  })();

  const el = screen(
    { brand: true, tabs: 'home', app, cls: 'eth-home', right: h('button', { class: 'icon-btn', 'aria-label': t('Lock'), onclick: () => app.lock('manual'), 'data-testid': 'lock' }, icon('lock')) },
    chainSwitch(app, 'eth'),
    addressBox,
    actionsBox,
    chainsBox,
    intentsBox,
    activityBox,
  );
  return {
    el,
    destroy() {
      dead = true;
      clearInterval(timer);
      clearInterval(follower);
      document.removeEventListener('visibilitychange', onVis);
      if (off) off();
    },
  };
}
