/* Ethereum server / BNB Chain server (Settings -> Ethereum & BNB -> Ethereum server or BNB Chain
 * server; also every "server didn't answer" and "doesn't say whether it went through" notice of
 * that chain, which opens it on its chain)
 * Spec: ONE job: pick the one server Campfire asks about your address on this chain, seeing which
 *       ones answer, keep up and confirm payments - a listed one, or your own.
 *       Primary CTA: "Use my server" (enabled once an address is typed) / "Use <default>" while your
 *       own is in use. "Use this one" (text) on a listed server's row. Nothing here moves money.
 *       Taps from app open: 4 (Settings, Ethereum & BNB, the chain's server, Use this one); 2 from a
 *       notice (the notice's link, Use this one).
 * Exit-intent reasons and answers:
 *   - "Which one works?" -> every listed server is checked as the screen opens: its newest block
 *     (behind the best one seen?), how fast it answered, and whether it confirms payments (a
 *     recent payment's outcome). Dead ones get no "Use this one".
 *   - "Does checking tell them who I am?" -> said under the list: each check shows that server your
 *     IP address, never your wallet's address (like the Firo nodes screen).
 *   - "Can I use my own node?" -> yes: "Your own server", https (or http for a node on this device),
 *     checked before it is used; refused with the reason and what to change.
 *   - "Is my own server safe?" -> said before it is used: it sees your IP with your address and
 *     could show wrong balances or confirmations; it can never move coins (payments are signed on
 *     this device); swap prices are still checked with a listed server.
 *   - "Will I lose anything?" -> no: switching only changes where the wallet reads from. Your own
 *     server may reopen the app once (you unlock again): said before the tap.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, toast } from '../lib/ui.js';
import { CHAINS } from '../lib/eth/chains.js';
import { rpcHostsFor, DEFAULT_RPC, RPC_URL_PREF } from '../lib/eth/hosts.js';
import { evmPrefs } from '../lib/eth/wallet.js';
import { checkLine, bestHead, ownServerProblem, checkListedServers, checkServerHere, speedText } from '../lib/eth/server_words.js';
import { normalizeEvmServer } from '../lib/evm_server_address.js';
import { canUseOwnServer, checkEvmWithLoader, useOwnEvmServer, useListedEvmServer, servedEvmOrigin } from '../lib/servers.js';
import { chainTabs } from './eth_ui.js';
import { t, sentences } from '../lib/i18n.js';
import { loaderText } from '../lib/loader_words.js';

/** A host name that may break after its dots on a narrow screen, never inside a label. */
const hostWords = (host) => host.split('.').flatMap((part, i, all) => (i < all.length - 1 ? [`${part}.`, h('wbr')] : [part]));

export default function ethServers(app, params = {}) {
  const chain = params.chain === 'bsc' ? 'bsc' : 'ethereum';
  const c = CHAINS[chain];
  const pref = evmPrefs(app, chain);
  const cur = pref.host;
  const own = pref.custom ? cur : null;
  const list = rpcHostsFor(chain);
  const fallback = list.find((x) => x.id === DEFAULT_RPC[chain]);
  /** id -> a check report, or {state: 'checking'} */
  const results = new Map();
  let ownResult = null; // the own server in use, checked from this page
  let gone = false;
  let busy = false;

  const listBox = h('div');
  const ownBox = h('div');
  const msg = h('div', { 'aria-live': 'polite' });
  const saved = typeof app.prefs[RPC_URL_PREF[chain]] === 'string' ? app.prefs[RPC_URL_PREF[chain]] : '';
  const input = h('input', { class: 'input', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'https://…', 'aria-label': t('Server address'), 'data-testid': 'evm-own-server' }); // i18n-ignore: a name, the same in every language
  if (saved) input.value = saved;
  const hint = h('p', { class: 'hint', 'data-testid': 'evm-own-hint' });

  const other = CHAINS[chain === 'bsc' ? 'ethereum' : 'bsc'];
  /** What the own server changes, exactly, chain by chain (release audit 0.1.5, B1). */
  // Stack Wallet's history index (Ethereum) is asked about the address too, while History is on and a
  // listed Ethereum server is in use: said wherever who is asked is said (release audit 0.1.5, B1).
  const indexAsked = () => evmPrefs(app, 'ethereum').history;
  // Whole sentences, joined with a space (lib/i18n.js typesets the join for Chinese and Japanese): the
  // chains' names, "your own" and the index change their form in other languages.
  function ownWords() {
    const o = evmPrefs(app, other.key);
    const first = chain === 'ethereum'
      ? t("An Ethereum server you run or pay for. While it is in use it is the only server asked about your address on Ethereum: no listed server is, and Stack Wallet's history index is not asked either.")
      : t('A BNB Chain server you run or pay for. While it is in use it is the only server asked about your address on BNB Chain: no listed server is.');
    const there = o.custom
      ? t('Your address is the same on {chainName}: your own server there is asked.', { chainName: other.name })
      : other.key === 'ethereum' && o.history
        ? t("Your address is the same on {chainName}: {server} is still asked there (and Stack Wallet's history index, while History is on), unless you add your own for {chainName} too.", { chainName: other.name, server: o.host.name })
        : t('Your address is the same on {chainName}: {server} is still asked there, unless you add your own for {chainName} too.', { chainName: other.name, server: o.host.name });
    return [first, there, t('Swap prices are still checked with a listed server, which never sees your address.')].join(' ');
  }

  /** Who is asked about the address, on this screen's chain and the other. */
  function listWords() {
    const eth = evmPrefs(app, 'ethereum');
    const mine = chain === 'ethereum' && indexAsked()
      ? t("Firo PWA asks one {chainName} server about your address: the one in use (and Stack Wallet's history index, while History is on).", { chainName: c.name })
      : t('Firo PWA asks one {chainName} server about your address: the one in use.', { chainName: c.name });
    const theirs = other.key === 'ethereum' && indexAsked()
      ? t("{chainName} has its own server, asked about the same address (and Stack Wallet's history index, while History is on).", { chainName: other.name })
      : t('{chainName} has its own server, asked about the same address.', { chainName: other.name });
    // With the own Ethereum server in use, History (when on) is held: a listed server picked here
    // brings Stack Wallet's index back too, and that is said before the tap.
    const back = chain === 'ethereum' && own && eth.historyHeld ? t("Using one of these instead lets it, and Stack Wallet's history index (History is on), see your address.") : chain === 'ethereum' && own ? t('Using one of these instead lets it see your address.') : null;
    return sentences(mine, t('It sees your IP address with your address.'), theirs, t('Your keys and signing stay on this device.'), back);
  }

  const best = () => bestHead([...results.values(), ownResult].filter((r) => r && !r.state));

  function renderList() {
    const b = best();
    // The one in use first: what the screen is about, without scrolling.
    const ordered = own ? list : [...list.filter((x) => x.id === cur.id), ...list.filter((x) => x.id !== cur.id)];
    const rows = ordered.map((x) => {
      const r = results.get(x.id);
      const inUse = !own && x.id === cur.id;
      const line = checkLine(r, { chain, best: b });
      return h(
        'div',
        { class: 'row node-row', 'data-testid': `evm-server-${x.id}`, 'data-state': line.cls, 'data-in-use': inUse ? 'true' : null },
        h('span', { class: 'ico' }, h('span', { class: `dot ${line.cls}` })),
        h('span', { class: 'main' }, h('div', { class: 't', text: x.name }), h('div', { class: 's host-note' }, ...hostWords(x.host), x.path || ''), h('div', { class: 's', 'data-testid': `evm-server-${x.id}-state`, text: line.text })),
        inUse
          ? h('span', { class: 'tag private', 'data-testid': `evm-server-${x.id}-in-use`, text: t('In use') })
          : line.usable
            ? h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': `evm-server-${x.id}-use`, onclick: () => useListed(x) }, t('Use this one'))
            : null,
      );
    });
    const checkedAny = results.size > 0;
    put(
      listBox,
      h(
        'div',
        { class: 'card', 'data-testid': 'evm-servers' },
        h('h3', {}, icon('server', 'inline-icon'), ' ', t('{chainName} servers', { chainName: c.name })),
        h('p', { class: 'small', 'data-testid': 'evm-servers-who', text: listWords() }),
        ...rows,
        own && !checkedAny ? secondary(t('Check the listed servers'), () => checkAll(), { 'data-testid': 'evm-check-listed' }) : null,
        h('p', { class: 'small', 'data-testid': 'evm-check-privacy', text: t('Checking asks each server for its newest block and a recent payment, so each one sees your IP address (never your wallet\'s address).') }),
      ),
    );
  }

  function renderOwn() {
    const r = own ? ownResult : null;
    // An own server whose saved address the rules no longer take (N2): said, never checked.
    const line = own && own.unusable ? { cls: 'bad', text: t("Its saved address can't be used any more: type it again below, or use a listed server.") } : own ? checkLine(r, { chain, best: best() }) : null;
    put(
      ownBox,
      h(
        'div',
        { class: 'card', 'data-testid': 'evm-own-card' },
        h('h3', { text: t('Your own server') }),
        own
          ? h(
              'div',
              { class: 'row node-row', 'data-testid': 'evm-own-row', 'data-state': line.cls },
              h('span', { class: 'ico' }, h('span', { class: `dot ${line.cls}` })),
              h('span', { class: 'main' }, h('div', { class: 't', text: own.name }), h('div', { class: 's', 'data-testid': 'evm-own-state', text: line.text })),
              h('span', { class: 'tag private', text: t('In use') }),
            )
          : null,
        h('p', { class: 'small', 'data-testid': 'evm-own-what', text: ownWords() }),
        notice('info', h('strong', { text: t('What it can and cannot do. ') }), t('It sees your IP address with your address, and it could show wrong balances or say a payment went through when it did not. It can never move your coins: payments are signed on this device.')),
        h('label', { class: 'field' }, t('Server address (https://…)'), input),
        hint,
      ),
    );
  }

  function renderHint() {
    const v = input.value.trim();
    const n = v ? normalizeEvmServer(v) : null;
    const inUse = Boolean(own && n && n.ok && n.url === own.url);
    hint.textContent = !v ? t('https://, or http://localhost for a node on this device.') : inUse ? t('In use now.') : n.ok ? sentences(t('Firo PWA checks {server} before using it.', { server: n.port ? `${n.host}:${n.port}` : n.host }), n.note ? loaderText(n.note) : null) : loaderText(n.error);
    hint.className = `hint${v && !n.ok ? ' bad' : v ? ' good' : ''}`;
    useBtn.disabled = busy || !(n && n.ok) || (own && n.url === own.url);
  }

  /** Every listed server at once: newest block, speed, a recent payment's outcome, one contract call. */
  async function checkAll() {
    for (const x of list) results.set(x.id, { state: 'checking' });
    renderList();
    await checkListedServers(chain, {
      onResult: (x, report) => {
        results.set(x.id, report);
        if (!gone) {
          renderList();
          renderOwn();
        }
      },
    }).catch(() => {});
  }

  async function checkOwnHere() {
    // Its origin is in this page's policy once the app reopened for it.
    if (!own || own.unusable || servedEvmOrigin(chain) !== own.origin) return;
    ownResult = { state: 'checking' };
    renderOwn();
    ownResult = await checkServerHere(own).catch(() => null);
    if (!gone) {
      renderOwn();
      renderList();
    }
  }

  async function useListed(x) {
    if (busy) return;
    busy = true;
    try {
      await useListedEvmServer(app, chain, x.id);
      toast(t('{name} through {name2}', { name: c.name, name2: x.name }));
      app.go('ethServers', { chain }, { replace: true });
    } catch (e) {
      busy = false;
      put(msg, notice('error', t('It did not switch: {message}', { message: e.message })));
    }
  }

  async function useMine() {
    if (busy) return;
    const n = normalizeEvmServer(input.value);
    if (!n.ok) return put(msg, notice('warn', n.error));
    if (!canUseOwnServer()) return put(msg, notice('info', t('Your own server works in the installed app (after the first install finished). Reload and try again.')));
    busy = true;
    renderHint();
    const name = n.port ? `${n.host}:${n.port}` : n.host;
    put(msg, h('div', { 'data-testid': 'evm-own-checking' }, notice('info', h('strong', { text: t('Checking {name}… ', { name }) }), t('It is asked for its network, its newest block, a recent payment and one contract call; it sees your IP address, not your wallet\'s address.'))));
    let checked;
    try {
      checked = await checkEvmWithLoader(chain, n.url);
    } catch (e) {
      busy = false;
      renderHint();
      return put(msg, h('div', { 'data-testid': 'evm-own-refused' }, notice('error', t('It was not saved: {message}', { message: e.message }))));
    }
    const r = checked.report;
    if (!r.ok) {
      busy = false;
      renderHint();
      const why = ownServerProblem(r, chain);
      const box = h('div', { 'data-testid': 'evm-own-refused', 'data-problem': r.problem || '', title: r.detail || '' }, notice('error', h('strong', { text: t('Not used. ') }), why, t(' Nothing changed: Firo PWA keeps using '), (own ? own.name : cur.name), '.'));
      return put(msg, box);
    }
    const reload = servedEvmOrigin(chain) !== checked.origin;
    put(
      msg,
      h(
        'div',
        { 'data-testid': 'evm-own-ok' },
        notice('success', h('strong', { text: t('{name} checked. ', { name }) }), sentences(t('Block {head} · {speed} · confirms payments.', { head: r.head.toLocaleString('en-US'), speed: speedText(r.ms) }), reload ? t('Saving… Firo PWA reopens once so it may reach it; then unlock again.') : null)),
      ),
    );
    try {
      const how = await useOwnEvmServer(app, chain, checked.url);
      if (how === 'now') {
        toast(t('{name} through your server, {name2}', { name: c.name, name2: name }));
        app.go('ethServers', { chain }, { replace: true });
      }
    } catch (e) {
      busy = false;
      renderHint();
      put(msg, h('div', { 'data-testid': 'evm-own-refused' }, notice('error', t('It was not saved: {message}', { message: e.message }))));
    }
  }

  const useBtn = primary(t('Use my server'), useMine, { disabled: true, 'data-testid': 'evm-use-own' });
  const backBtn = own ? secondary(t('Use {name}', { name: fallback.name }), () => useListed(fallback), { 'data-testid': 'evm-use-default' }) : null;
  if (own) {
    useBtn.classList.replace('btn-primary', 'btn-secondary');
    backBtn.classList.replace('btn-secondary', 'btn-primary');
  }
  input.addEventListener('input', () => {
    put(msg);
    renderHint();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && !useBtn.disabled && useMine());

  renderList();
  renderOwn();
  renderHint();
  // On a listed server the wallet talks to them anyway: check them all as the screen opens. With
  // their own server the person chose to tell no listed server anything: those only on a tap.
  if (!own) checkAll();
  else checkOwnHere();

  const el = screen(
    { title: t('{name} server', { name: c.name }), back: () => app.back('ethSettings'), actions: own ? [backBtn, useBtn] : [useBtn] },
    chainTabs(chain, (k) => app.go('ethServers', { chain: k }, { replace: true }), { testid: 'servers-chain', label: t('Network') }),
    // The server in use first: the person's own when it is, else the list (with the one in use in it).
    ...(own ? [ownBox, msg, listBox] : [listBox, ownBox, msg]),
  );
  return {
    el,
    destroy() {
      gone = true;
    },
  };
}
