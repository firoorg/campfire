/* Home (the Campfire app's wallet screen: balance card, Privatize pill, transactions, Receive/Send dock)
 * Spec: ONE job: see what I have and start a payment.
 *       Primary CTA: "Send" in the dock at the bottom (when there is nothing to send yet: "Receive");
 *       "Buy" sits beside them. Settings is ☰, Activity is "See all".
 *       Taps from app open: 0 after unlock; Send / Receive / Privatize are 1.
 * Exit-intent reasons and answers:
 *   - "Is this number real / up to date?" -> the sync line says Synced with the newest block and its
 *     server, or exactly what the wallet is still reading, and that sending waits until it is done.
 *   - "Why are there two balances?" -> Private (Spark: hidden on the blockchain) is the big number;
 *     Public (transparent: visible to anyone) is the line under it; the card's title swaps them.
 *   - "Some of my FIRO is public - what now?" -> the wide "Privatize" pill under the card, with
 *     what public means.
 *   - "Why can't I send?" -> the reason is written under the buttons, never a silent grey button.
 *   - "Where did my payment go?" -> recent payments with plain status right below.
 *   - "Empty wallet, now what?" -> the primary button becomes Receive; Buy is beside it.
 *   - "What is all this worth?" -> FIRO in dollars once allowed (asked once: CoinGecko sees the IP).
 *   - "What if this phone, or the browser's storage, is lost?" -> a wallet restored from a backup
 *     file never showed its words: a card under the balance asks to write them down (one tap to
 *     Backup; "Later" for a week) until the person says they did.
 */
import { h, fmtDate, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, progressBar } from '../lib/ui.js';
import { isOwnServer } from '../lib/servers.js';
import { keepingAwake, startKeepingAwake, stopKeepingAwake, onKeepAwakeChange, screenKeptOn } from '../lib/keep_awake.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet, txTitle, txSign, txSide, isPendingTx, SIDE_WORDS, txWhen } from '../lib/wallet.js';
import { copyAt } from '../lib/update.js';
import { applyUpdate } from '../lib/update_ui.js';
import { chainSwitch } from './eth_screens.js';
import { openBuy } from './buy_screens.js';
import { openSell } from './sell_screens.js';
import { loaderBehind } from '../lib/loader.js';
import { rowExtra } from './payment_extras.js';
import { loadContacts } from '../lib/contacts.js';
import { walletChip } from './wallets.js';
import { awayNow, dismissAway } from '../lib/notify.js';
import { moneyOf, priceQuestion, shouldAsk } from './fiat_ui.js';
import { firoPrice } from '../lib/fiat.js';
import { store, rawStore } from '../lib/store.js';
import { walletKey } from '../lib/wallet_scope.js';
import { wordsReminderDue, WORDS_REMINDER_SNOOZE_MS } from '../lib/session.js';
import { t, tn, lang, sentences } from '../lib/i18n.js';
import { loaderText } from '../lib/loader_words.js';

export function syncLine(sync) {
  const cls = sync.state === 'synced' ? 'ok' : sync.state === 'offline' || sync.state === 'behind' || sync.state === 'disagree' ? 'bad' : 'wait';
  const pct = sync.state === 'syncing' && sync.percent != null ? ` (${sync.percent}%)` : '';
  return h('div', { class: 'syncline', 'data-testid': 'sync', 'data-state': sync.state }, h('span', { class: `dot ${cls}` }), h('span', { text: `${sync.title}${pct}` }));
}

/** The four signal bars of Campfire's top bar: green when synced, amber while catching up, red offline. */
export function syncBars(sync, onclick) {
  const cls = sync.state === 'synced' ? 'ok' : sync.state === 'offline' || sync.state === 'behind' || sync.state === 'disagree' ? 'bad' : 'wait';
  const lit = sync.state === 'synced' ? 4 : sync.state === 'syncing' ? 1 + Math.min(3, Math.floor((sync.percent || 0) / 34)) : sync.state === 'offline' ? 0 : 1;
  return h('button', { class: `icon-btn sync-bars ${cls}`, type: 'button', 'aria-label': t('{title}. Firo nodes', { title: sync.title }), title: sync.title, 'data-testid': 'sync-bars', 'data-state': sync.state, onclick }, ...[1, 2, 3, 4].map((i) => h('span', { class: `bar b${i}${i <= lit ? ' lit' : ''}` })));
}

/** The round icon of a payment row, as Campfire draws them: received, sent, privatized, waiting. */
function txIcon(tx) {
  const pending = isPendingTx(tx);
  if (tx.kind === 'privatize') return h('span', { class: `ico tx-ico privatized${pending ? ' pending' : ''}` }, icon('refresh'));
  if (tx.direction === 'in') return h('span', { class: `ico tx-ico in${pending ? ' pending' : ''}` }, icon('receive'));
  if (tx.direction === 'out') return h('span', { class: `ico tx-ico out${pending ? ' pending' : ''}` }, icon('send'));
  return h('span', { class: `ico tx-ico self${pending ? ' pending' : ''}` }, icon('swap'));
}

/** One payment as a row (Home's list and Activity): title and date left, amount and its value right. */
export function txRow(app, tx, onclick) {
  const sign = txSign(tx);
  const side = txSide(tx);
  const money = moneyOf(app, tx.amount);
  return h(
    'button',
    { class: 'row tx-row', onclick, 'data-txid': tx.txid, 'data-kind': tx.kind },
    txIcon(tx),
    h('span', { class: 'main' }, h('div', { class: 't', text: txTitle(tx) }), h('div', { class: 's', text: [txWhen(tx, fmtDate), SIDE_WORDS[side], rowExtra(tx)].filter(Boolean).join(' · ') })),
    h('span', { class: 'end' }, h('div', { class: sign === '+' ? 'in' : '', text: `${sign}${formatAmount(tx.amount)} ${UNIT}` }), money ? h('div', { class: 'small', text: `${sign}${money.replace(/^≈ /, '')}` }) : null),
  );
}

export default function home(app) {
  const balanceBox = h('div', { class: 'balance-wrap' });
  const proofBox = h('div');
  /** What the check's note last showed: built again only when that changes (a tap must not land on a button replaced under it). */
  let proofShown = '';
  let dockShown = '';
  const privatizeBox = h('div');
  const shortcutsBox = h('div');
  const askBox = h('div');
  const txBox = h('div');
  const bannerBox = h('div');
  const whyBox = h('div');
  const dock = h('nav', { class: 'dock', 'aria-label': t('Payments') });
  const barsBox = h('span');
  // Which balance the card shows big (Campfire's "Full Spark balance ▾"); the other is the line under it.
  let shown = app.homeBalance === 'public' ? 'public' : 'private';

  function proofNote(pp, checking) {
    const pct = pp ? Math.min(99, Math.floor((pp.done / pp.total) * 100)) : null;
    // The auto-lock (and a phone's screen going dark) stopped the check long before it was done: the
    // way to let it finish, on a tap, said plainly with its limits (lib/keep_awake.js).
    const awake = keepingAwake();
    return h(
      'div',
      { 'data-testid': 'private-proof' },
      notice(
        'info',
        h('strong', { text: pct != null ? t('Second Firo node check: {pct}%. ', { pct }) : t('Second Firo node check: starting. ') }),
        awake
          ? (screenKeptOn() ? t('Firo PWA stays unlocked until it is done, for about an hour at most, with the screen kept on. Hiding or closing Firo PWA, or Lock, ends this.') : t('Firo PWA stays unlocked until it is done, for about an hour at most. Hiding or closing Firo PWA, or Lock, ends this.'))
          : t('{amount} {UNIT} can be sent once it is done. The first check can take about half an hour, and runs only while Firo PWA is open and unlocked.', { amount: formatAmount(checking), UNIT }),
      ),
      pct != null ? progressBar(pct / 100) : null,
      awake
        ? h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'private-proof-awake-stop', onclick: () => stopKeepingAwake() }, t('Stop: lock as usual'))
        : h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'private-proof-awake', onclick: () => startKeepingAwake() }, t('Stay unlocked until it is done')),
    );
  }

  function renderProof(s) {
    const checking = s.balance.private.checking ?? 0n;
    const show = checking > 0n && !s.privateCheck && !s.viewOnly && !isOwnServer(app.prefs.server);
    const pp = s.privateProof;
    const key = show ? JSON.stringify([String(checking), pp ? Math.min(99, Math.floor((pp.done / pp.total) * 100)) : null, keepingAwake(), screenKeptOn()]) : '';
    if (key === proofShown) return;
    proofShown = key;
    put(proofBox, show ? proofNote(pp, checking) : null);
  }

  function render(s) {
    renderProof(s);
    const b = s.balance;
    const known = s.sync.state === 'synced' || s.txsLoaded;
    const reading = !known && s.sync.state !== 'offline';
    const other = shown === 'private' ? 'public' : 'private';
    // Private FIRO one node showed counts in the figure (owner, 2026-10-21: "show the private balance
    // that confirmed by the first node"), said as such right under it, with the second node's check;
    // it is sent only once that check is done. Not when a node's lists do not add up or another
    // disagrees: then it waits outside the figure, as before (public audit, P4).
    const checking = b.private.checking ?? 0n;
    const counted = checking > 0n && !s.privateCheck ? checking : 0n;
    const figure = (side) => (side === 'private' ? b.private.available + counted : b[side].available);
    const amountText = (side) => (known || figure(side) > 0n ? formatAmount(figure(side)) : '—');
    const pp = s.privateProof;
    const pct = pp ? Math.min(99, Math.floor((pp.done / pp.total) * 100)) : null;
    const pending = [];
    // In a block by the node's word, its set still being checked with a second node (P4; N9: an old
    // or restored wallet's first check takes a while, and "arriving" was not what was happening).
    if (b.private.pending - checking > 0n) pending.push(t('+{amount} arriving privately', { amount: formatAmount(b.private.pending - checking) }));
    // Said as the node's word, not as received (third audit F7: a node that lies could show a coin
    // that never came, and "received" would vouch for it).
    if (checking > 0n && !counted) pending.push(t('+{amount} private, shown by the Firo node, being checked with a second one', { amount: formatAmount(checking) }));
    if (b.public.pending > 0n) pending.push(t('+{amount} arriving publicly', { amount: formatAmount(b.public.pending) }));
    // A masternode's collateral is kept out of what can be sent: said, so no FIRO seems to vanish (P3).
    if (b.public.mnLocked > 0n) pending.push(t('{amount} locked as masternode collateral (see Coins)', { amount: formatAmount(b.public.mnLocked) }));
    const money = known ? moneyOf(app, figure(shown)) : null;
    const toggle = h(
      'button',
      { class: 'balance-toggle', type: 'button', 'data-testid': 'balance-toggle', 'aria-label': shown === 'private' ? t('Showing your private balance. Show the public one') : t('Showing your public balance. Show the private one'), onclick: () => ((shown = other), (app.homeBalance = shown), render(wallet.state)) },
      icon(shown === 'private' ? 'spark' : 'eye', 'inline-icon'),
      h('span', { text: shown === 'private' ? t('Private balance') : t('Public balance') }),
      icon('down', 'chev'),
    );
    put(
      balanceBox,
      h(
        'div',
        { class: `balance-card ${shown}`, 'data-testid': 'balance-card' },
        h('div', { class: 'balance-head' }, toggle, h('img', { class: 'coin', src: 'img/firo.svg', alt: 'FIRO' })), // i18n-ignore: a ticker
        h('div', { class: 'balance-amount', 'data-testid': `balance-${shown}` }, amountText(shown), h('span', { class: 'unit', text: ` ${UNIT}` })),
        money ? h('div', { class: 'balance-fiat', 'data-testid': 'balance-fiat', text: money.replace(/^≈ /, '') }) : null,
        h('div', { class: 'balance-other', 'data-testid': 'public-line' }, h('span', { text: shown === 'private' ? t('Public') : t('Private') }), h('strong', { 'data-testid': `balance-${other}`, text: `${amountText(other)} ${UNIT}` })),
        counted > 0n ? h('div', { class: 'balance-pending', 'data-testid': 'balance-checking', text: pct != null ? t('Private includes {amount} FIRO shown by one Firo node, not sendable until a second one confirms it ({pct}% checked)', { amount: formatAmount(counted), pct }) : t('Private includes {amount} FIRO shown by one Firo node, not sendable until a second one confirms it', { amount: formatAmount(counted) }) }) : null,
        pending.length ? h('div', { class: 'balance-pending', 'data-testid': 'balance-pending', text: pending.join(' · ') }) : null,
      ),
      h('div', { class: 'sync-row' }, syncLine(s.sync), reading && s.sync.percent != null ? progressBar(s.sync.percent / 100) : null),
      h('p', { class: 'small sync-detail', 'data-testid': 'sync-detail', text: s.sync.detail }),
      // A node that is down, behind or disagreeing: the way to another one, right here.
      ['offline', 'behind', 'disagree'].includes(s.sync.state) || s.sync.reconnecting
        ? h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': 'sync-choose-node', onclick: () => app.go('servers') }, t('Choose another Firo node'))
        : null,
      // Private FIRO received, waiting for its sets' check: how far it is and what it needs (owner,
      // 2026-10-21: "Private balance 0, +3500 private, shown by the Firo node. Why 0?"). The first
      // check of an old or restored wallet reads every block since Spark began: about half an hour
      // on mainnet, only while the app is open and unlocked.
      // Private FIRO received that this node's lists cannot confirm (public audit, P4): kept waiting,
      // never counted, and the way out said right here.
      s.privateCheck
        ? h(
            'div',
            { 'data-testid': 'private-check' },
            notice(
              'warn',
              h('strong', { text: t('Private FIRO received is waiting. ') }),
              s.privateCheck.code === 'set-disagree'
                ? t('Another Firo node disagrees with this one about the list of private coins, so Firo PWA cannot confirm it yet.')
                : t("This Firo node's list of private coins does not add up, so Firo PWA cannot confirm it yet."),
            ),
            s.privateCheck.otherServer
              ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'private-check-other', onclick: () => wallet.useAnotherServer().catch(() => app.go('servers')) }, t('Try another node'))
              : null,
          )
        : null,
    );

    // Campfire's wide pill under the card: public FIRO can be followed by anyone.
    put(
      privatizeBox,
      s.viewOnly
        ? h('div', { 'data-testid': 'watch-only-note' }, notice('info', h('strong', { text: t('Watch-only. ') }), t('This wallet sees payments from its view key; it cannot send.')))
        : b.public.available > 0n
        ? h(
            'div',
            { class: 'privatize-wrap' },
            h('button', { class: 'btn btn-secondary pill', 'data-testid': 'privatize', onclick: () => app.go('privatize') }, icon('privatize'), t('Privatize {amount} {UNIT}', { amount: formatAmount(b.public.available), UNIT })),
            h('p', { class: 'small center', 'data-testid': 'public-note', text: t('Your public FIRO can be seen on the blockchain. Privatize it to hide it.') }),
          )
        : null,
    );

    // Firo's extras, one tap each from here: Buy FIRO (it asks: private FIRO
    // through buyfiro.app, or rsFIRO in two steps through NEAR Intents), Sell FIRO (it asks too:
    // FIRO through buyfiro.app, or rsFIRO swapped in the Ethereum & BNB wallet), the Rosen bridge,
    // Spark names. Secondary tiles, one row on a 375 px phone: Send / Receive stays the one strong
    // action. A watch-only wallet cannot sign, so it keeps Buy only.
    const cut = (testid, ico, label, onclick) => h('button', { class: 'shortcut', type: 'button', 'data-testid': testid, onclick }, h('span', { class: 'shortcut-ico' }, icon(ico)), h('span', { class: 'shortcut-label', text: label }));
    put(
      shortcutsBox,
      h(
        'nav',
        { class: 'shortcuts', 'aria-label': t('More with FIRO'), 'data-testid': 'home-shortcuts' },
        cut('sc-buy', 'buy', t('Buy FIRO'), () => openBuy(app)),
        !s.viewOnly && app.has('sellFiro') ? cut('sc-sell', 'sell', t('Sell FIRO'), () => openSell(app)) : null,
        !s.viewOnly && app.has('bridge') ? cut('sc-bridge', 'bridge', t('Bridge'), () => app.go('bridge', { back: 'home' })) : null,
        !s.viewOnly && app.has('names') ? cut('sc-names', 'at', t('Spark name'), () => app.go('names')) : null,
      ),
    );

    // Private FIRO one node showed counts here too: Send opens and says it waits for the second node's check.
    const hasFunds = b.private.available > 0n || b.public.available > 0n || ((b.private.checking ?? 0n) > 0n && !s.privateCheck);
    put(askBox, known && shouldAsk(app, hasFunds) ? priceQuestion(app, () => render(wallet.state)) : null);

    const recent = s.txs.slice(0, 6);
    put(
      txBox,
      h('div', { class: 'section-head' }, h('p', { class: 'section-title', text: t('Transactions') }), s.txs.length ? h('button', { class: 'btn btn-text btn-inline', 'data-testid': 'see-all', onclick: () => app.go('activity') }, t('See all')) : null),
      recent.length
        ? h('div', { class: 'card list tx-list', 'data-testid': 'recent' }, ...recent.map((tx) => txRow(app, tx, () => app.go('activity', { txid: tx.txid }))))
        : h('div', { class: 'card empty', 'data-testid': 'home-empty' }, icon('activity'), h('p', { text: known ? t('No payments yet. Receive some FIRO to get started.') : t('Payments show up here once the wallet is up to date.') })),
    );

    // The dock (Campfire's floating Receive / Send): the main action is the strong one.
    const canSend = s.sync.canSend;
    const item = (testid, ico, label, onclick, { main = false, disabled = false } = {}) =>
      h('button', { class: `dock-item${main ? ' main' : ''}`, type: 'button', 'data-testid': testid, disabled, onclick }, h('span', { class: 'dock-ico' }, icon(ico)), h('span', { text: label }));
    // Built again only when it changes: every change of the wallet's state renders Home, and a tap on
    // Send or Receive must not land on a button replaced under it (owner, 2026-10-21, as on Firo nodes).
    const dockKey = JSON.stringify([hasFunds, Boolean(canSend), Boolean(s.viewOnly)]);
    if (dockKey !== dockShown) {
      dockShown = dockKey;
      put(
        dock,
        item('receive', 'receive', t('Receive'), () => app.go('receive'), { main: !hasFunds }),
        item('send', 'send', t('Send'), () => app.go('send'), { main: hasFunds && !s.viewOnly, disabled: !canSend || !hasFunds || s.viewOnly }),
        item('buy', 'buy', t('Buy'), () => openBuy(app)),
      );
    }
    put(whyBox, !canSend && hasFunds ? h('p', { class: 'small center', 'data-testid': 'send-why', text: t('Sending is paused: {reason}.', { reason: (lang() === 'en' ? s.sync.title.toLowerCase() : s.sync.title).replace(/[.…。]+$/, '') }) }) : null);
    put(barsBox, syncBars(s.sync, () => app.go('servers')));
  }

  function renderBanner() {
    const parts = [];
    if (app.updates.available) {
      parts.push(
        h('div', { class: 'notice info', 'data-testid': 'update-banner' }, icon('download'), h('div', { class: 'grow', text: copyAt(app.updates.available.from) ? t('Firo PWA {version} is ready. It came from {from} and was checked against the release signature.', { version: app.updates.available.version, from: copyAt(app.updates.available.from) }) : t('Firo PWA {version} is ready. It was checked against the release signature.', { version: app.updates.available.version }) }), h('button', { class: 'btn btn-primary btn-small', onclick: () => applyUpdate(app), 'data-testid': 'update-apply' }, t('Update'))),
      );
    }
    if (app.updates.refused) parts.push(notice('error', t('An update was refused: {reason} You are still on the version you had.', { reason: loaderText(app.updates.refused.reason) })));
    // Normally the move to a new loader takes seconds after an Update; only a move still pending after that is worth a word.
    if (loaderBehind() && performance.now() > 10000) {
      parts.push(
        h(
          'div',
          { class: 'notice warn', 'data-testid': 'update-finishing' },
          icon('alert'),
          h(
            'div',
            { class: 'grow' },
            h('strong', { text: t('One step left to finish the update. ') }),
            t('Until then, a connection this version added may be refused. Finishing reloads the app; you unlock again after it.'),
            h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-primary btn-small', 'data-testid': 'update-finish', onclick: () => location.reload() }, t('Finish now'))),
          ),
        ),
      );
    }
    put(bannerBox, ...parts);
  }
  const bannerLater = setTimeout(() => renderBanner(), 11000);
  const onController = () => renderBanner();
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('controllerchange', onController);

  const off = wallet.onChange(render);
  const offAwake = onKeepAwakeChange(() => render(wallet.state));
  const offU = app.updates.onChange(renderBanner);
  const offPrice = firoPrice(app).onChange(() => render(wallet.state));
  // Buys still on their way are followed while the wallet is open: one store read ('buy', the Buy
  // record's key), and the Buy code is loaded only when there are some.
  store
    .get('buy')
    .then((v) => (v ? import('../lib/buy/wiring.js').then((m) => m.followBuys && m.followBuys(app)) : null))
    .catch(() => {});
  // Sells too: their record is the wallet's own ('w:<id>:sell'), and the Sell code loads only when there is one.
  Promise.resolve()
    .then(() => rawStore.get(walletKey(app, 'sell')))
    .then((v) => (v ? import('../lib/sell/wiring.js').then((m) => m.followSells && m.followSells(app)) : null))
    .catch(() => {});
  render(wallet.state);
  renderBanner();
  // Contact names on the payment rows (sealed per wallet; read once per unlock).
  loadContacts(app).then(() => render(wallet.state), () => {});

  // The words of a wallet restored from a file were never shown: until they are written down, a
  // card under the balance says so (audit A-10). Dismissible for a week.
  const wordsBox = h('div');
  function renderWords() {
    if (!wordsReminderDue(app.record, app.prefs)) return put(wordsBox);
    const evictable = app.persisted === false ? t('This browser may also clear its storage.') : null;
    put(
      wordsBox,
      h(
        'div',
        { class: 'notice warn', 'data-testid': 'backup-prompt' },
        icon('alert'),
        h(
          'div',
          { class: 'grow' },
          h('strong', { text: t('Write down your recovery words. ') }),
          sentences(tn({ one: 'This wallet came from a backup file. Its {n} word brings it back without the file or its password.', other: 'This wallet came from a backup file. Its {n} words bring it back without the file or its password.' }, app.record.words || 24), evictable),
          h(
            'div',
            { class: 'btn-row prompt-actions' },
            // Secondary: Send / Receive stays the screen's one strong action.
            h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'backup-prompt-show', onclick: () => app.go('backup') }, t('Show my words')),
            h('button', {
              class: 'btn btn-text btn-small',
              'data-testid': 'backup-prompt-later',
              onclick: async () => {
                await app.setPrefs({ backupPromptSnoozedUntil: Date.now() + WORDS_REMINDER_SNOOZE_MS }).catch(() => {});
                renderWords();
              },
            }, t('Later')),
          ),
        ),
      ),
    );
  }
  renderWords();

  // What happened while the person was away (lib/notify.js): one line until it is closed or seen.
  const awayBox = h('div', { class: 'hidden' });
  let awayShown = null;
  function renderAway() {
    const line = awayNow();
    if (line === awayShown) return;
    awayShown = line;
    awayBox.classList.toggle('hidden', !line);
    if (!line) return put(awayBox);
    const close = () => {
      dismissAway();
      renderAway();
    };
    put(
      awayBox,
      h(
        'div',
        { class: 'notice info away-line', 'data-testid': 'home-away' },
        icon('clock'),
        h('div', { class: 'grow' }, h('span', { 'data-testid': 'home-away-text', text: line }), ' ', h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'home-away-open', onclick: () => (dismissAway(), app.go('activity')) }, t('See Activity'))),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('Close'), onclick: close, 'data-testid': 'home-away-close' }, icon('close')),
      ),
    );
  }
  const offAway = wallet.onChange(renderAway);
  renderAway();

  const el = screen(
    // The title is the open wallet's name: a tap opens the switcher (screens/wallets.js).
    {
      brand: walletChip(app),
      tabs: 'home',
      app,
      cls: 'home has-dock',
      right: h(
        'div',
        { class: 'top-actions' },
        barsBox,
        // Scan: any QR code, recognized, then the screen for it (screens/scan_go.js, loaded on the tap).
        h('button', { class: 'icon-btn', 'aria-label': t('Scan a QR code'), 'data-testid': 'home-scan', onclick: () => import('./scan_go.js').then((m) => m.scanAndGo(app)) }, icon('scan')),
        h('button', { class: 'icon-btn', 'aria-label': t('Lock'), onclick: () => app.lock('manual'), 'data-testid': 'lock' }, icon('lock')),
        h('button', { class: 'icon-btn menu-btn', 'aria-label': t('Settings'), onclick: () => app.go('settings'), 'data-testid': 'menu' }, icon('menu')),
      ),
    },
    chainSwitch(app, 'firo'),
    bannerBox,
    h('div', { class: 'home-cols' }, h('div', { class: 'home-main' }, balanceBox, proofBox, wordsBox, privatizeBox, shortcutsBox, whyBox, awayBox, askBox), h('div', { class: 'home-side' }, txBox)),
    dock,
  );
  return {
    el,
    destroy() {
      off();
      offAwake();
      offU();
      offPrice();
      offAway();
      clearTimeout(bannerLater);
      if (navigator.serviceWorker) navigator.serviceWorker.removeEventListener('controllerchange', onController);
    },
  };
}
