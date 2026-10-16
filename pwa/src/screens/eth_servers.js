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
import { chainTabs, aChain } from './eth_ui.js';

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
  const input = h('input', { class: 'input', type: 'url', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'https://…', 'aria-label': 'Server address', 'data-testid': 'evm-own-server' });
  if (saved) input.value = saved;
  const hint = h('p', { class: 'hint', 'data-testid': 'evm-own-hint' });

  const other = CHAINS[chain === 'bsc' ? 'ethereum' : 'bsc'];
  /** What the own server changes, exactly, chain by chain (release audit 0.1.5, B1). */
  // Stack Wallet's history index (Ethereum) is asked about the address too, while History is on and a
  // listed Ethereum server is in use: said wherever who is asked is said (release audit 0.1.5, B1).
  const INDEX = " (and Stack Wallet's history index, while History is on)";
  const indexAsked = () => evmPrefs(app, 'ethereum').history;
  function ownWords() {
    const o = evmPrefs(app, other.key);
    const there = o.custom ? 'your own server there is asked' : `${o.host.name} is still asked there${other.key === 'ethereum' && o.history ? INDEX : ''}, unless you add your own for ${other.name} too`;
    return `${aChain(c.name).replace(/^a/, 'A')} server you run or pay for. While it is in use it is the only server asked about your address on ${c.name}: no listed server is${chain === 'ethereum' ? ", and Stack Wallet's history index is not asked either" : ''}. Your address is the same on ${other.name}: ${there}. Swap prices are still checked with a listed server, which never sees your address.`;
  }

  /** Who is asked about the address, on this screen's chain and the other. */
  function listWords() {
    const eth = evmPrefs(app, 'ethereum');
    const mine = chain === 'ethereum' && indexAsked() ? INDEX : '';
    const theirs = other.key === 'ethereum' && indexAsked() ? INDEX : '';
    // With the own Ethereum server in use, History (when on) is held: a listed server picked here
    // brings Stack Wallet's index back too, and that is said before the tap.
    const back = chain === 'ethereum' && own && eth.historyHeld ? " Using one of these instead lets it, and Stack Wallet's history index (History is on), see your address." : chain === 'ethereum' && own ? ' Using one of these instead lets it see your address.' : '';
    return `Campfire asks one ${c.name} server about your address: the one in use${mine}. It sees your IP address with your address. ${other.name} has its own server, asked about the same address${theirs}. Your keys and signing stay on this device.${back}`;
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
          ? h('span', { class: 'tag private', 'data-testid': `evm-server-${x.id}-in-use`, text: 'In use' })
          : line.usable
            ? h('button', { class: 'btn btn-text btn-small', type: 'button', 'data-testid': `evm-server-${x.id}-use`, onclick: () => useListed(x) }, 'Use this one')
            : null,
      );
    });
    const checkedAny = results.size > 0;
    put(
      listBox,
      h(
        'div',
        { class: 'card', 'data-testid': 'evm-servers' },
        h('h3', {}, icon('server', 'inline-icon'), ` ${c.name} servers`),
        h('p', { class: 'small', 'data-testid': 'evm-servers-who', text: listWords() }),
        ...rows,
        own && !checkedAny ? secondary('Check the listed servers', () => checkAll(), { 'data-testid': 'evm-check-listed' }) : null,
        h('p', { class: 'small', 'data-testid': 'evm-check-privacy', text: 'Checking asks each server for its newest block and a recent payment, so each one sees your IP address (never your wallet\'s address).' }),
      ),
    );
  }

  function renderOwn() {
    const r = own ? ownResult : null;
    // An own server whose saved address the rules no longer take (N2): said, never checked.
    const line = own && own.unusable ? { cls: 'bad', text: "Its saved address can't be used any more: type it again below, or use a listed server." } : own ? checkLine(r, { chain, best: best() }) : null;
    put(
      ownBox,
      h(
        'div',
        { class: 'card', 'data-testid': 'evm-own-card' },
        h('h3', { text: 'Your own server' }),
        own
          ? h(
              'div',
              { class: 'row node-row', 'data-testid': 'evm-own-row', 'data-state': line.cls },
              h('span', { class: 'ico' }, h('span', { class: `dot ${line.cls}` })),
              h('span', { class: 'main' }, h('div', { class: 't', text: own.name }), h('div', { class: 's', 'data-testid': 'evm-own-state', text: line.text })),
              h('span', { class: 'tag private', text: 'In use' }),
            )
          : null,
        h('p', { class: 'small', 'data-testid': 'evm-own-what', text: ownWords() }),
        notice('info', h('strong', { text: 'What it can and cannot do. ' }), 'It sees your IP address with your address, and it could show wrong balances or say a payment went through when it did not. It can never move your coins: payments are signed on this device.'),
        h('label', { class: 'field' }, 'Server address (https://…)', input),
        hint,
      ),
    );
  }

  function renderHint() {
    const v = input.value.trim();
    const n = v ? normalizeEvmServer(v) : null;
    const inUse = Boolean(own && n && n.ok && n.url === own.url);
    hint.textContent = !v ? 'https://, or http://localhost for a node on this device.' : inUse ? 'In use now.' : n.ok ? `Campfire checks ${n.port ? `${n.host}:${n.port}` : n.host} before using it.${n.note ? ` ${n.note}` : ''}` : n.error;
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
      toast(`${c.name} through ${x.name}`);
      app.go('ethServers', { chain }, { replace: true });
    } catch (e) {
      busy = false;
      put(msg, notice('error', `It did not switch: ${e.message}`));
    }
  }

  async function useMine() {
    if (busy) return;
    const n = normalizeEvmServer(input.value);
    if (!n.ok) return put(msg, notice('warn', n.error));
    if (!canUseOwnServer()) return put(msg, notice('info', 'Your own server works in the installed app (after the first install finished). Reload and try again.'));
    busy = true;
    renderHint();
    const name = n.port ? `${n.host}:${n.port}` : n.host;
    put(msg, h('div', { 'data-testid': 'evm-own-checking' }, notice('info', h('strong', { text: `Checking ${name}… ` }), 'It is asked for its network, its newest block, a recent payment and one contract call; it sees your IP address, not your wallet\'s address.')));
    let checked;
    try {
      checked = await checkEvmWithLoader(chain, n.url);
    } catch (e) {
      busy = false;
      renderHint();
      return put(msg, h('div', { 'data-testid': 'evm-own-refused' }, notice('error', `It was not saved: ${e.message}`)));
    }
    const r = checked.report;
    if (!r.ok) {
      busy = false;
      renderHint();
      const why = ownServerProblem(r, chain);
      const box = h('div', { 'data-testid': 'evm-own-refused', 'data-problem': r.problem || '', title: r.detail || '' }, notice('error', h('strong', { text: 'Not used. ' }), why, ' Nothing changed: Campfire keeps using ', (own ? own.name : cur.name), '.'));
      return put(msg, box);
    }
    const reload = servedEvmOrigin(chain) !== checked.origin;
    put(
      msg,
      h(
        'div',
        { 'data-testid': 'evm-own-ok' },
        notice('success', h('strong', { text: `${name} checked. ` }), `Block ${r.head.toLocaleString('en-US')} · ${speedText(r.ms)} · confirms payments.${reload ? ' Saving… Campfire reopens once so it may reach it; then unlock again.' : ''}`),
      ),
    );
    try {
      const how = await useOwnEvmServer(app, chain, checked.url);
      if (how === 'now') {
        toast(`${c.name} through your server, ${name}`);
        app.go('ethServers', { chain }, { replace: true });
      }
    } catch (e) {
      busy = false;
      renderHint();
      put(msg, h('div', { 'data-testid': 'evm-own-refused' }, notice('error', `It was not saved: ${e.message}`)));
    }
  }

  const useBtn = primary('Use my server', useMine, { disabled: true, 'data-testid': 'evm-use-own' });
  const backBtn = own ? secondary(`Use ${fallback.name}`, () => useListed(fallback), { 'data-testid': 'evm-use-default' }) : null;
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
    { title: `${c.name} server`, back: () => app.back('ethSettings'), actions: own ? [backBtn, useBtn] : [useBtn] },
    chainTabs(chain, (k) => app.go('ethServers', { chain: k }, { replace: true }), { testid: 'servers-chain', label: 'Network' }),
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
