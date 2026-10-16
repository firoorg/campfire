/* Bridge: FIRO ⇄ rsFIRO through Rosen (on Ethereum or BNB Chain)
 * Spec: ONE job: move FIRO to rsFIRO on another chain, or back, knowing exactly what it costs.
 *       Primary CTA: "Bridge <amount> FIRO to BNB Chain" / "Bridge <amount> rsFIRO to FIRO" (then a
 *       confirmation that names the destination and says it cannot be undone, then Face ID / password).
 *       Taps from app open: 1 (⇄ beside FIRO | Ethereum on Home), then the amount, then 2 to confirm.
 * Exit-intent reasons and answers:
 *   - "What does it cost?" -> Rosen's fee as it is ($10 or 0.5%, whichever is more, in FIRO today),
 *     the network fee, what arrives, the total as a percent, and from how much it is just 0.5%.
 *   - "Too expensive for a small amount?" -> above 3% it warns, and points to buyfiro.app's bridge.
 *   - "Where does it go?" -> your own address on the chosen chain (or your own public FIRO address);
 *     a FIRO destination is transparent, so it says to Privatize after it arrives.
 *   - "How long?" -> BNB Chain about 40 minutes; Ethereum can take hours; back to FIRO 25-60 minutes.
 *   - "Can I undo it?" -> no, said before anything is signed: a bridge has no refunds.
 *   - "My crossing has said 'checking' for over an hour" -> when the Firo node in use says it never
 *     left and no other node could check it, the person may let it go here (let_go.js, RE3-3).
 */
import { h, put, shorten } from '../lib/dom.js';
import { screen, primary, notice, openSheet, textButton, toast } from '../lib/ui.js';
import { parseAmount, formatAmount, toInputString, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { firoPrice, firoUsdOnce, firoUsdOnceAt } from '../lib/fiat.js';
import { rosen, assess, CHAINS, TO_FIRO_ETA, isRosenFiroAddress, crossFailure, rememberUnsureLock, unsureLock, crossHandedOver } from '../lib/bridge_rosen.js';
import { UNSURE_TITLE } from '../lib/send_outcome.js';
import { paymentInFlight, startPayment, onPaymentFlight, IN_FLIGHT_NOTE } from '../lib/payment_flight.js';
import { letGoOffer } from './let_go.js';

/** The Ethereum / BNB Chain side, loaded only here: its address and its rsFIRO, when there is a wallet. */
async function evmSide(app, chain) {
  try {
    const m = await import('../lib/eth/send_raw.js');
    const address = typeof m.evmAddress === 'function' ? await m.evmAddress(app) : null;
    const balance = address && typeof m.tokenBalance === 'function' ? await m.tokenBalance(app, chain, 'rsFIRO') : null;
    return { address, balance };
  } catch {
    return { address: null, balance: null };
  }
}

/**
 * A crossing under way from any Bridge screen (built, signed, sent, until its outcome is known). A
 * Bridge opened again meanwhile offers nothing until it ends: the first one's lock is written down only
 * when it is about to be broadcast, so before that a second crossing could start (release audit 0.1.7,
 * verification 4).
 */
/**
 * An address in groups of four, so it wraps between groups and never leaves one character on a line
 * of its own (visual check of 0.1.8, V3); the address itself stays in data-address.
 */
const grouped = (a) => {
  const s = String(a || '');
  if (!s) return '';
  return s.startsWith('0x') ? `0x ${s.slice(2).match(/.{1,4}/g).join(' ')}` : s.match(/.{1,4}/g).join(' ');
};
let crossingInFlight = false;
/** The open Bridge screens' redraws, told when a crossing in flight ends. */
const inFlightWatchers = new Set();

export default function bridge(app, params = {}) {
  const st = { toEvm: params.from !== 'evm', chain: params.chain === 'ethereum' ? 'ethereum' : 'bsc', evm: { address: null, balance: null }, quote: null, busy: false };
  const back = params.back || 'home';
  const dirBox = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Direction' });
  const chainBox = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Chain' });
  const fromBox = h('div');
  const toBox = h('div');
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': 'Amount', 'data-testid': 'bridge-amount' });
  const maxBtn = h('button', { class: 'btn btn-secondary btn-small inside', type: 'button', 'data-testid': 'bridge-max' }, 'Max');
  const unitLabel = h('span', { class: 'small' });
  const hint = h('p', { class: 'hint' });
  const costBox = h('div');
  const msg = h('div', { 'aria-live': 'polite' });
  const doubtBox = h('div');
  // A crossing from a Bridge screen left meanwhile, still being sent: said first, before any amount.
  const flightBox = h('div', { 'aria-live': 'polite' });
  const cta = primary('Bridge', confirm, { disabled: true, 'data-testid': 'bridge-go' });
  let seq = 0;
  let alive = true; // false once the screen is left (destroy)
  let evmSeq = 0; // the newest Ethereum / BNB Chain side read (reload)
  let confirming = false; // a Bridge run is under way (confirm)

  const unitFrom = () => (st.toEvm ? UNIT : 'rsFIRO');
  const unitTo = () => (st.toEvm ? 'rsFIRO' : UNIT);
  const chainName = () => CHAINS[st.chain].name;
  const available = () => (st.toEvm ? wallet.state.balance.public.available : st.evm.balance);
  const destination = () => (st.toEvm ? st.evm.address : wallet.state.receive.transparent);

  function seg(box, items, current, onPick, testid) {
    put(box, ...items.map(([id, label]) => h('button', { type: 'button', class: `seg${current === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(current === id), 'data-testid': `${testid}-${id}`, onclick: () => onPick(id) }, label)));
  }

  function renderPickers() {
    seg(dirBox, [['firo', 'FIRO → rsFIRO'], ['evm', 'rsFIRO → FIRO']], st.toEvm ? 'firo' : 'evm', (id) => {
      st.toEvm = id === 'firo';
      reload();
    }, 'bridge-dir');
    seg(chainBox, [['bsc', 'BNB Chain'], ['ethereum', 'Ethereum']], st.chain, (id) => {
      st.chain = id;
      reload();
    }, 'bridge-chain');
  }

  function renderEnds() {
    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    const b = wallet.state.balance;
    if (st.toEvm) {
      put(
        fromBox,
        h('div', { class: 'card' }, kv('From', 'Your public FIRO balance', 'bridge-from'), kv('Available', `${formatAmount(b.public.available)} ${UNIT}`, 'bridge-available')),
        b.private.available > 0n && b.public.available < (parsed() || 1n)
          ? h('div', { 'data-testid': 'bridge-private-note' }, notice('info', `Rosen takes public FIRO only. You have ${formatAmount(b.private.available)} ${UNIT} private: `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'bridge-make-public', onclick: makePublic }, 'send some to your own public address first'), '.'))
          : null,
      );
      put(
        toBox,
        st.evm.address
          ? h('div', { class: 'card' }, kv('To', `Your ${chainName()} address`, 'bridge-to'), h('p', { class: 'mono small addr-groups', 'data-testid': 'bridge-to-address', 'data-address': st.evm.address || '', text: grouped(st.evm.address) }))
          : h('div', { 'data-testid': 'bridge-no-evm' }, notice('info', `rsFIRO arrives in your ${chainName()} wallet, which isn't set up yet. `, h('button', { class: 'btn btn-text btn-small inline', type: 'button', onclick: () => app.go('ethStart', { from: 'bridge' }) }, 'Set it up'), ' (its own recovery words), then come back.')),
      );
    } else {
      put(fromBox, h('div', { class: 'card' }, kv('From', `Your ${chainName()} wallet`, 'bridge-from'), kv('Available', st.evm.balance == null ? (st.evm.address ? '…' : 'no wallet yet') : `${formatAmount(st.evm.balance)} rsFIRO`, 'bridge-available')));
      put(
        toBox,
        h('div', { class: 'card' }, kv('To', 'Your public FIRO address', 'bridge-to'), h('p', { class: 'mono small addr-groups', 'data-testid': 'bridge-to-address', 'data-address': wallet.state.receive.transparent || '', text: grouped(wallet.state.receive.transparent || '…') })),
        h('div', { 'data-testid': 'bridge-privatize-note' }, notice('info', 'Rosen pays only public (transparent) addresses. Once it arrives, Home offers to Privatize it.')),
      );
    }
  }

  function parsed() {
    try {
      const a = parseAmount(amount.value);
      return a > 0n ? a : null;
    } catch {
      return null;
    }
  }

  // Rosen's minimum is $10 in FIRO: the quote needs FIRO's dollar price. Values shown in dollars
  // give it; otherwise the person is asked once (a request to CoinGecko) and it is kept a while.
  let usd = null;
  let usdAt = 0; // when that price was read
  // Only a recent price (audit D-05): the shown one may be up to 30 minutes old when requests fail.
  const FRESH_MS = 10 * 60000;
  /** {price, at} of FIRO in dollars no older than FRESH_MS, or null. */
  function dollarQuote() {
    const p = firoPrice(app).current();
    if (p && p.currency === 'USD' && Date.now() - p.at <= FRESH_MS) return { price: p.price, at: p.at };
    if (usd != null && Date.now() - usdAt <= FRESH_MS) return { price: usd, at: usdAt };
    return null;
  }
  function dollarPrice() {
    const d = dollarQuote();
    return d ? d.price : null;
  }
  async function askPrice() {
    put(msg);
    st.askingPrice = true;
    render();
    usd = await firoUsdOnce();
    usdAt = firoUsdOnceAt() ?? Date.now();
    st.askingPrice = false;
    if (usd == null) put(msg, notice('error', "CoinGecko didn't answer, so Rosen's fee can't be worked out yet. Nothing was sent. Try again in a moment."));
    requote();
  }

  async function requote() {
    const my = ++seq;
    st.quote = null;
    render();
    const a = parsed();
    if (!a) return;
    if (dollarPrice() == null) {
      st.needPrice = true;
      return render();
    }
    st.needPrice = false;
    try {
      const priced = dollarQuote();
      const q = await (await rosen()).quote({ from: st.toEvm ? 'firo' : st.chain, to: st.toEvm ? st.chain : 'firo', amount: a, firoUsd: priced ? priced.price : null });
      if (my !== seq) return;
      st.quote = { amount: a, ...q, priceAt: priced ? priced.at : 0 };
    } catch (e) {
      if (my !== seq) return;
      put(msg, notice('error', `The fee could not be worked out: ${e.message}`));
    }
    render();
  }

  /**
   * A FIRO lock of this wallet that may have left (the node didn't answer): followed here, and
   * nothing new is bridged from FIRO until the wallet has it in a block or has let it go (FM-1),
   * also after a reload or in another tab: the wallet's own payments say so (R-3).
   */
  function lockInDoubt() {
    const u = unsureLock(wallet);
    if (!u) {
      // A crossing that did not go through, or was let go, is said once (the page's memory then
      // forgets it): it stays in sight while this screen is open, not just until the next render.
      if (doubtBox.dataset.txid && !doubtBox.dataset.txid.includes('|gone|')) {
        put(doubtBox);
        delete doubtBox.dataset.txid;
      }
      return null;
    }
    // The lock as the wallet follows it: offered to let go after an hour on the node in use's word
    // alone (RE3-3), or let go by the person.
    const tx = wallet.state.txs.find((t) => t.txid === u.lock.txid) || null;
    const oneNode = Boolean(tx && tx.oneNode);
    const letGo = Boolean(tx && tx.letGo);
    const key = `${u.lock.txid}|${u.verdict}|${oneNode}|${letGo}`;
    if (doubtBox.dataset.txid !== key) {
      doubtBox.dataset.txid = key;
      const chain = CHAINS[u.lock.to] ? CHAINS[u.lock.to] : null;
      put(
        doubtBox,
        u.verdict === 'checking'
          ? h(
              'div',
              { class: 'stack', 'data-testid': 'bridge-unsure', 'data-txid': u.lock.txid },
              notice(
                'warn',
                h('strong', { text: `${UNSURE_TITLE} ` }),
                `The Firo node didn't answer when your crossing of ${formatAmount(u.lock.amount)} ${UNIT}${chain ? ` to ${chain.name}` : ''} went out. Follow it in Activity: once it is in a block, rsFIRO arrives${chain ? ` on ${chain.name} in ${chain.etaShort}` : ''}. If the Firo network turns out not to have it, Firo PWA says so here once two Firo nodes confirm they do not have it, and you can bridge again.`,
                h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'bridge-follow', onclick: () => app.go('activity', { txid: u.lock.txid }) }, 'Follow it in Activity')),
              ),
              oneNode ? letGoOffer(tx) : null,
            )
          : letGo
            ? h('div', { 'data-testid': 'bridge-unsure-gone', 'data-let-go': 'true' }, notice('info', 'You let your earlier crossing go on the word of the Firo node in use: its FIRO is back in your public balance. If it did leave, its rsFIRO still arrives, and bridging again would cross a second time.'))
            : h('div', { 'data-testid': 'bridge-unsure-gone' }, notice('info', "Your earlier crossing didn't go through: the Firo network doesn't have it, and its FIRO is back in your public balance. You can bridge again.")),
      );
    }
    return u.verdict === 'checking' ? u.lock : null;
  }

  function render() {
    put(flightBox, crossingInFlight && !st.busy ? h('div', { 'data-testid': 'bridge-in-flight' }, notice('info', 'Your last crossing is still being sent. You can bridge again as soon as Firo PWA knows it left.')) : null);
    if (!crossingInFlight && st.toEvm && !st.busy && paymentInFlight()) put(flightBox, h('div', { 'data-testid': 'bridge-in-flight' }, notice('info', IN_FLIGHT_NOTE)));
    const held = st.toEvm ? lockInDoubt() : null;
    if (!st.toEvm && doubtBox.dataset.txid) {
      put(doubtBox);
      delete doubtBox.dataset.txid;
    }
    unitLabel.textContent = unitFrom();
    const a = parsed();
    const avail = available();
    let err = null;
    if (amount.value.trim() && !a) {
      try {
        parseAmount(amount.value);
        err = 'The amount must be more than zero.';
      } catch (e) {
        err = e.message;
      }
    } else if (a && avail != null && a > avail) err = `That's more than you have here: ${formatAmount(avail)} ${unitFrom()}.`;
    hint.textContent = err || (avail != null ? `Available: ${formatAmount(avail)} ${unitFrom()}` : '');
    hint.className = `hint${err ? ' bad' : ''}`;

    const q = st.quote && st.quote.amount === a ? st.quote : null;
    if (!q && st.needPrice && a && !err) {
      put(
        costBox,
        h(
          'div',
          { class: 'card', 'data-testid': 'bridge-need-price' },
          h('p', { class: 'small', text: "Rosen's fee is $10 or 0.5%, whichever is more. To work out $10 in FIRO, Firo PWA asks CoinGecko for FIRO's dollar price. CoinGecko sees your IP address, not your wallet." }),
          h('button', { class: 'btn btn-secondary', 'data-testid': 'bridge-get-price', disabled: Boolean(st.askingPrice), onclick: askPrice }, st.askingPrice ? 'Asking…' : "Get today's price"),
        ),
      );
      cta.disabled = true;
      cta.textContent = 'Bridge';
      return;
    }
    if (!q) {
      put(costBox, a && !err ? h('p', { class: 'small', text: 'Working out the fees…' }) : null);
      cta.disabled = true;
      cta.textContent = 'Bridge';
      return;
    }
    const v = assess(a, q);
    const kv = (k, val, testid, cls = '') => h('div', { class: `kv ${cls}`.trim() }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: val }));
    put(
      costBox,
      h(
        'div',
        { class: 'card', 'data-testid': 'bridge-costs' },
        kv("Rosen's fee", `${formatAmount(q.bridgeFee)} ${UNIT}`, 'bridge-fee'),
        h('p', { class: 'small', 'data-testid': 'bridge-fee-rule', text: `$10 or 0.5%, whichever is more (${formatAmount(q.minBridgeFee, { maxDecimals: 2 })} ${UNIT} today). From ${formatAmount(v.breakEven, { maxDecimals: 0 })} ${UNIT} you pay just 0.5%.` }),
        kv(`Network fee (${st.toEvm ? chainName() : 'FIRO'})`, `${formatAmount(q.networkFee)} ${UNIT}`, 'bridge-network-fee'),
        kv('You receive', `${formatAmount(q.receive)} ${unitTo()}`, 'bridge-receive'),
        kv('Total cost', v.costPercent == null ? '—' : `${v.costPercent.toFixed(2)}%`, 'bridge-cost'),
        kv('Time', st.toEvm ? CHAINS[st.chain].eta : TO_FIRO_ETA, 'bridge-eta'),
        h('p', { class: 'small', text: `Plus the ${st.toEvm ? 'FIRO network fee for the sending transaction' : `${chainName()} network fee (gas), paid in ${st.chain === 'bsc' ? 'BNB' : 'ETH'}`}, shown before you approve.` }),
      ),
      v.refuse ? h('div', { 'data-testid': 'bridge-refused' }, notice('error', `The fees (${formatAmount(v.fees)} ${UNIT}) are as much as the amount or more: nothing would arrive. Bridge more, or use buyfiro.app's bridge for small amounts.`)) : null,
      !v.refuse && v.warn ? h('div', { 'data-testid': 'bridge-warn' }, notice('warn', `This costs ${v.costPercent.toFixed(1)}% of what you send.`)) : null,
      !v.refuse && v.small ? h('p', { class: 'small', 'data-testid': 'bridge-small' }, 'For amounts under the 0.5% line, ', buyLink(), ' is usually cheaper.') : null,
    );
    // rsFIRO -> FIRO: the other chain's balance known first (never a sheet and a password for an amount it lacks).
    // FIRO -> rsFIRO is a Firo payment: one at a time with Send, Privatize, names and Sell (second audit, XX).
    const otherPayment = st.toEvm && !st.busy && paymentInFlight() !== null;
    const ready = !err && !v.refuse && Boolean(destination()) && (st.toEvm || avail != null) && !st.busy && !confirming && !crossingInFlight && !otherPayment && !held && wallet.state.sync.canSend;
    cta.disabled = !ready;
    // A crossing from a Bridge screen left meanwhile is still being sent: nothing new until it is.
    cta.textContent = st.busy ? 'Sending your crossing…' : crossingInFlight ? 'Your last crossing is still being sent…' : st.toEvm ? `Bridge ${formatAmount(a)} ${UNIT} to ${chainName()}` : `Bridge ${formatAmount(a)} rsFIRO to FIRO`;
  }

  // buyfiro.app's site, from Buy's host list (loaded with this screen, not with Home).
  let buyUrl = null;
  import('../lib/buy/hosts.js')
    .then((m) => {
      buyUrl = typeof m.buySiteUrl === 'function' ? m.buySiteUrl() : null;
    })
    .catch(() => {});
  function buyLink() {
    const url = buyUrl;
    return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', 'data-testid': 'bridge-buyfiro' }, "buyfiro.app's bridge") : "buyfiro.app's bridge";
  }

  function makePublic() {
    app.sendDraft = { address: wallet.state.receive.transparent || '', amount: amount.value, memo: '', from: 'private', subtractFee: false };
    app.go('send');
  }

  /**
   * The Bridge button: one run at a time, from the first tap. A second tap while the first reads the
   * fee or shows its sheet starts nothing: two runs stacked two "Bridges cannot be undone" sheets, and
   * saying yes to both sent two crossings (release audit 0.1.7, verification 4).
   */
  async function confirm() {
    if (confirming || st.busy) return;
    confirming = true;
    cta.disabled = true;
    try {
      await confirmRun();
    } finally {
      confirming = false;
      if (alive) render();
    }
  }

  async function confirmRun() {
    put(msg); // what the last run said is not left under this one
    const a = parsed();
    const q = st.quote;
    const dest = destination();
    if (!a || !q || !dest) return;
    // The route as confirmed: the quote must be for it and this amount, and it must still be the one
    // on screen after the sheet and the password (release audit 0.1.7, verification 5).
    const route = { toEvm: st.toEvm, chain: st.chain };
    const routeFrom = route.toEvm ? 'firo' : route.chain;
    const routeTo = route.toEvm ? route.chain : 'firo';
    const sameRoute = () => st.toEvm === route.toEvm && st.chain === route.chain;
    // Words for this route only (the screen may change under the sheet): never two routes at once.
    const rFrom = route.toEvm ? UNIT : 'rsFIRO';
    const rTo = route.toEvm ? 'rsFIRO' : UNIT;
    const rChain = CHAINS[route.chain].name;
    // Changed under the run: worked out again, and said, so the person is never left guessing.
    const changed = () => {
      requote();
      put(msg, h('div', { 'data-testid': 'bridge-result' }, notice('info', parsed() ? 'The fees were worked out again for what is on screen now. Nothing was sent: check them, then bridge.' : 'The amount changed, so nothing was sent. Enter it, then bridge.')));
    };
    // The same figures (a re-quote of an unchanged amount gives a new object with equal fees).
    const sameQuote = (x) => Boolean(x) && x.from === q.from && x.to === q.to && x.amount === q.amount && x.bridgeFee === q.bridgeFee && x.networkFee === q.networkFee;
    // Never a second lock while one may have left (FM-1): lib/rosen names its lock address.
    const engine = await rosen();
    if (engine.stub) return put(msg, h('div', { 'data-testid': 'bridge-result' }, notice('error', 'Bridging is not in this version yet: it comes with the Rosen update. Nothing was sent.')));
    if (!alive) return;
    if (q.from !== routeFrom || q.to !== routeTo || q.amount !== a || !sameRoute() || !sameQuote(st.quote)) return changed();
    if (st.toEvm && lockInDoubt()) return render();
    if (!st.toEvm && !isRosenFiroAddress(dest)) return put(msg, notice('error', 'Rosen can pay only a public FIRO address (starting with a). Nothing was sent.'));
    // FIRO -> rsFIRO: the FIRO network fee of the lock transaction, said before approval (audit
    // B-2): the rate the wallet would pay (capped), for a typical lock transaction.
    let lockFee = null;
    if (st.toEvm) {
      try {
        const rate = await wallet.need().estimateFeeRate();
        lockFee = (await rosen()).expectedLockFee(rate.normal);
      } catch {
        lockFee = null;
      }
    }
    // Left, or the route or amount changed while the fee was read: no sheet for figures not on screen.
    if (!alive) return;
    if (!sameRoute() || !sameQuote(st.quote) || parsed() !== a) return changed();
    // The sheet's buttons answer only once it has been on screen a moment: the second tap of a double
    // tap on Bridge lands where "Yes, bridge it" or Cancel now is, and must not answer for the person.
    const openedAt = Date.now();
    const settled = () => Date.now() - openedAt > 600;
    const sure = await new Promise((resolve) => {
      openSheet((close) => [
        h('h2', { text: 'Bridges cannot be undone' }),
        h('p', { class: 'lead', 'data-testid': 'bridge-confirm-text', text: `${formatAmount(a)} ${rFrom} leave now; about ${formatAmount(q.receive)} ${rTo} arrive ${route.toEvm ? `on ${rChain}` : 'in your public FIRO balance'}.` }),
        h('div', { class: 'address-box' }, h('p', { class: 'small', text: route.toEvm ? `To your ${rChain} address` : 'To your public FIRO address' }), h('p', { class: 'mono addr-groups', 'data-testid': 'bridge-confirm-dest', 'data-address': dest, text: grouped(dest) })),
        route.toEvm ? h('p', { class: 'small', 'data-testid': 'bridge-confirm-network-fee', text: lockFee != null ? `FIRO network fee: about ${formatAmount(lockFee)} ${UNIT}, from your public balance (never more than 0.01 ${UNIT}).` : `FIRO network fee: shown once the transaction is built, never more than 0.01 ${UNIT}.` }) : null,
        notice('warn', h('strong', { text: 'There are no refunds. ' }), 'If anything about a crossing is wrong, the coins are gone. Firo PWA checks every byte before you sign.'),
        primary('Yes, bridge it', () => settled() && close(true), { 'data-testid': 'bridge-confirm' }),
        textButton('Cancel', () => settled() && close(false), { 'data-testid': 'bridge-cancel' }),
      // Not closed by a tap beside it: the second tap of a double tap would close it unseen (Cancel is the way out).
      ], { label: 'Bridges cannot be undone', dismissable: false }).then((v) => resolve(v === true));
    });
    if (!sure) return;
    if (!(await confirmIdentity(app, { title: 'Confirm the bridge', detail: `${formatAmount(a)} ${rFrom} to ${shorten(dest, 8, 6)}`, cta: 'Confirm' }))) return;
    // Left meanwhile, the route changed, or a lock that may have left found since the sheet opened: nothing is sent.
    if (!alive || st.busy) return;
    // The $10 is at the price of the quote: older than ten minutes when signed, nothing is sent, and
    // today's price is asked for again (Rosen ignores a crossing under its own minimum).
    if (!q.priceAt || Date.now() - q.priceAt > FRESH_MS) {
      requote();
      return put(msg, h('div', { 'data-testid': 'bridge-result' }, notice('info', "FIRO's price is more than ten minutes old, so nothing was sent. Get today's price, then bridge.")));
    }
    if (!sameRoute() || !sameQuote(st.quote) || parsed() !== a) return changed();
    if (st.toEvm && lockInDoubt()) return render();
    if (crossingInFlight) return render();
    const toEvm = route.toEvm;
    const chain = route.chain; // the chain picked when it was confirmed (the picker stays usable meanwhile)
    // FIRO -> rsFIRO takes the one place for a Firo payment (lib/payment_flight.js): a payment from
    // Send, Privatize, a name or Sell under way meanwhile, and nothing is sent (second audit, XX).
    const done = toEvm ? startPayment('bridge') : () => {};
    if (!done) return render();
    try {
      st.busy = true;
      crossingInFlight = true;
      render();
      try {
        const sent = await (await rosen()).cross({ app, from: toEvm ? 'firo' : chain, to: toEvm ? chain : 'firo', amount: a, destination: dest, quote: q });
        // Refused by the chain's server (it may have passed it on), or no answer at all: the person is
        // on the payment's status screen, which follows it. Not "Sent to Rosen", and no other screen.
        if (!crossHandedOver(sent)) return;
        toast(toEvm ? `Sent to Rosen. rsFIRO arrives on ${CHAINS[chain].name} in ${CHAINS[chain].etaShort}.` : 'Sent to Rosen. FIRO arrives in 25 to 60 minutes; Privatize it then.', 6000);
        // Back from this screen (FIRO -> rsFIRO stays here) or from this exit's own status screen;
        // someone who moved on meanwhile stays where they are (release audit 0.1.7, verification 3).
        if ((alive && app.currentName === 'bridge') || (app.currentName === 'ethTx' && app.params && sent && sent.hash && app.params.hash === sent.hash)) app.go(back);
        else if (alive) {
          st.busy = false;
          render();
        }
      } catch (e) {
        st.busy = false;
        // "Nothing was sent" only when it is certain (FM-1): a lock the node didn't answer for may
        // have left, and is followed here instead.
        const f = crossFailure(e, { toFiro: !toEvm });
        if (f.kind === 'unsure') {
          rememberUnsureLock({ txid: f.txid, at: Date.now(), amount: a, to: chain });
          put(msg);
          return render();
        }
        render();
        if (f.kind === 'not-yet') put(msg, h('div', { 'data-testid': 'bridge-result' }, notice('info', e.message)));
        else if (f.kind === 'not-sent') put(msg, h('div', { 'data-testid': 'bridge-result' }, notice('error', `Nothing was sent: ${e.message}`)));
        else put(msg, h('div', { 'data-testid': 'bridge-result' }, notice('error', `Firo PWA couldn't tell whether the crossing left: ${e.message} Look in Activity before you bridge again.`), h('div', { class: 'btn-row prompt-actions' }, h('button', { class: 'btn btn-secondary btn-small', 'data-testid': 'bridge-open-activity', onclick: () => app.go('activity') }, 'Open Activity'))));
      }
    } finally {
      done();
      crossingInFlight = false; // its outcome is known (or followed elsewhere): Bridge may be offered again
      for (const redraw of [...inFlightWatchers]) {
        try {
          redraw();
        } catch {
          /* one screen's redraw never keeps the others from theirs */
        }
      }
    }
  }

  async function reload() {
    // The quote shown was for the route before this change: gone at once, never sent for the new one.
    seq++;
    st.quote = null;
    render();
    renderPickers();
    put(msg);
    // The newest pick's balance only: an older chain's read landing late is dropped.
    const mine = ++evmSeq;
    // The balance only: the address is this wallet's on both chains (never "isn't set up yet" meanwhile).
    st.evm = { address: st.evm.address, balance: null };
    renderEnds();
    const side = await evmSide(app, st.chain);
    if (mine !== evmSeq || !alive) return;
    st.evm = side;
    renderEnds();
    requote();
  }

  let t = null;
  amount.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      renderEnds();
      requote();
    }, 300);
    render();
  });
  maxBtn.addEventListener('click', async () => {
    let avail = available();
    if (avail == null) return;
    // FIRO -> rsFIRO: the lock's network fee comes from the same public balance, and its coins are
    // chosen for the amount plus Rosen's module's fee budget: Max leaves that budget (what the fee
    // does not use comes back as change). All of it always failed (second audit, XX).
    if (st.toEvm) {
      const budget = (await rosen()).MAX_LOCK_FEE ?? 0n;
      avail = avail > budget ? avail - budget : 0n;
    }
    amount.value = toInputString(avail);
    renderEnds();
    requote();
  });

  // The balances shown move with the wallet (a lock let go is back in the public balance).
  const off = wallet.onChange(() => (renderEnds(), render()));
  const offFlight = onPaymentFlight(() => render());
  reload();
  // Rosen's module names its FIRO lock address: a lock in doubt is said as soon as it is loaded.
  rosen().then(() => render(), () => {});
  const el = screen(
    { title: 'Bridge', back: () => app.back(back), actions: [cta], cls: 'sticky-actions' },
    h('p', { class: 'lead', text: 'Move FIRO to rsFIRO on another chain, or back, through the Rosen bridge. 1 rsFIRO is 1 FIRO.' }),
    // A lock in doubt is said first (3-second rule).
    doubtBox,
    flightBox,
    dirBox,
    chainBox,
    fromBox,
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: 'Amount' }), unitLabel), h('div', { class: 'input-wrap' }, amount, maxBtn)),
    hint,
    toBox,
    costBox,
    msg,
  );
  const redrawWhenFree = () => alive && render();
  inFlightWatchers.add(redrawWhenFree);
  return { el, destroy: () => ((alive = false), inFlightWatchers.delete(redrawWhenFree), off(), offFlight(), clearTimeout(t)) };
}

