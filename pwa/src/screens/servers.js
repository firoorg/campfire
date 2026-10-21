/* Firo nodes (Settings -> Firo nodes; also the signal bars on Home)
 * Spec: ONE job: see which Firo node the wallet reads the blockchain from, and pick another when
 *       one is dead: one of Firo's public nodes, or your own.
 *       Primary CTA: "Use my node" (when an address is typed) / "Use Firo's public nodes" (when your
 *       own is in use). "Use this one" on a public node's row. Nothing else moves money.
 *       Taps from app open: 1 (the signal bars), 2 to switch to another public node.
 * Exit-intent reasons and answers:
 *   - "Is it connected?" -> the node in use and the newest block it gave, live.
 *   - "The one in use is dead" -> every public node with its newest block and how fast it answered,
 *     checked when the screen opens; "Use this one" on any of them. The wallet also moves on by
 *     itself when a node stops answering.
 *   - "Is this a central server?" -> no: nodes only serve public chain data; keys, signing and
 *     private proofs stay on the device. Said on the screen.
 *   - "My address is refused" -> says exactly what to change (wss only, host and port).
 *   - "Will I lose anything?" -> no: switching only changes where the wallet reads from; using your
 *     own node reopens the app once (you unlock again).
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice, toast } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { serverHost } from '../lib/sync.js';
import { FIRO_SERVERS, isOwnServer, useOwnServer, useFiroServers, usePublicNode, canUseOwnServer } from '../lib/servers.js';
import { normalizeServerAddress, SERVER_EXAMPLE } from '../lib/server_address.js';
import { syncLine } from './home.js';

export default function servers(app) {
  const own = isOwnServer(app.prefs.server) ? normalizeServerAddress(app.prefs.server).address : null;
  const status = h('div');
  const nodesBox = h('div');
  const msg = h('div', { 'aria-live': 'polite' });
  // A public node's switch is said right under the list it was tapped in, not at the screen's foot.
  const nodeMsg = h('div', { 'aria-live': 'polite', 'data-testid': 'node-msg' });
  const input = h('input', { class: 'input', type: 'text', inputmode: 'url', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: SERVER_EXAMPLE, 'aria-label': 'Your own node', 'data-testid': 'own-server' });
  if (own) input.value = own;
  const hint = h('p', { class: 'hint', text: 'The host and its secure WebSocket (wss) port. Without a port, 50004.' });
  let busy = false;
  let gone = false;
  /** The public node being moved to, while it is (its row says so at once). */
  let switching = null;
  /** What the node rows last showed: the same rows are not built again (a tap must not land on a row replaced under it). */
  let shownRows = '';
  /** url -> {state: 'checking' | 'ok' | 'down', height?, ms?} */
  const checks = new Map();

  function renderStatus(s) {
    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    put(
      status,
      h(
        'div',
        { class: 'card' },
        kv('In use', own ? `Your own node, ${own}` : "Firo's public nodes", 'servers-mode'),
        kv('Connected to', s.server ? serverHost(s.server) : 'not connected', 'servers-connected'),
        kv('Newest block', s.tip ? s.tip.height.toLocaleString('en-US') : '—', 'servers-height'),
        syncLine(s.sync),
      ),
    );
    renderNodes(s);
  }

  /** What a public node's row says: in use, its newest block and speed, still checking, or down. */
  function nodeState(url, s) {
    const c = checks.get(url);
    const tip = s.tip ? s.tip.height : null;
    if (switching === serverHost(url)) return { cls: 'wait', text: 'Connecting…' };
    if (!own && s.server === url && s.connected) return { cls: 'ok', text: tip ? `In use · block ${tip.toLocaleString('en-US')}` : 'In use' };
    if (!c) return { cls: 'wait', text: own ? 'Not checked: you use your own node' : 'Not checked yet' };
    if (c.state === 'checking') return { cls: 'wait', text: 'Checking…' };
    if (c.state === 'down') return { cls: 'bad', text: 'Not answering' };
    const behind = tip && c.height < tip - 3;
    // A number and its unit stay on one line (no-break spaces); a second or more reads in seconds.
    const took = c.ms < 1000 ? `${c.ms}\u00a0ms` : `${(c.ms / 1000).toFixed(1)}\u00a0s`;
    return { cls: behind ? 'bad' : 'ok', text: `${behind ? 'Behind: block' : 'Block'}\u00a0${c.height.toLocaleString('en-US')} · ${took}` };
  }

  function renderNodes(s) {
    // Every change of the wallet's state renders this screen, several times a second while it syncs:
    // the rows are built again only when what they say changes, so the button a finger is on stays
    // the button it lifts from (owner, 2026-10-21: "Use this one" did nothing when tapped mid-sync).
    const seen = FIRO_SERVERS.map((url) => {
      const st = nodeState(url, s);
      return { url, st, inUse: !own && s.server === url && s.connected && switching !== serverHost(url) };
    });
    const key = JSON.stringify([own, switching, busy, seen.map((x) => [x.st.cls, x.st.text, x.inUse])]);
    if (key === shownRows) return;
    shownRows = key;
    const rows = seen.map(({ url, st, inUse }) => {
      const host = serverHost(url);
      const button =
        switching === host
          ? h('button', { class: 'btn btn-text btn-small', type: 'button', disabled: true, 'data-testid': `node-${host}-use` }, 'Connecting…')
          : inUse || st.cls === 'bad'
            ? null
            : h('button', { class: 'btn btn-text btn-small', type: 'button', disabled: busy, 'data-testid': `node-${host}-use`, onclick: () => useNode(host) }, 'Use this one');
      return h(
        'div',
        { class: 'row node-row', 'data-testid': `node-${host}`, 'data-state': st.cls },
        h('span', { class: 'ico' }, h('span', { class: `dot ${st.cls}` })),
        h('span', { class: 'main' }, h('div', { class: 't', text: host }), h('div', { class: 's', 'data-testid': `node-${host}-state`, text: st.text })),
        button,
      );
    });
    put(
      nodesBox,
      h(
        'div',
        { class: 'card', 'data-testid': 'public-nodes' },
        h('h3', {}, icon('server', 'inline-icon'), " Firo's public nodes"),
        h('p', { class: 'small', text: 'The wallet reads the Firo blockchain from one of these and moves to the next by itself when one stops answering. They only serve public chain data: your keys, signing and private proofs stay on this device. They see your IP address and your public addresses, never your private balance.' }),
        ...rows,
        own ? secondary("Check Firo's public nodes", () => checkAll(), { 'data-testid': 'check-public-nodes' }) : null,
        own ? h('p', { class: 'small', text: 'Checking asks each of them for its newest block, so they see your IP address.' }) : null,
      ),
    );
  }

  /** Every public node not in use, at once: its newest block and how fast it answered. */
  async function checkAll() {
    const s = wallet.state;
    const todo = FIRO_SERVERS.filter((url) => own || !(s.server === url && s.connected));
    for (const url of todo) checks.set(url, { state: 'checking' });
    renderNodes(wallet.state);
    await Promise.all(
      todo.map(async (url) => {
        const r = await wallet.checkNode(url).catch((e) => ({ ok: false, error: e.message }));
        checks.set(url, r.ok ? { state: 'ok', height: r.height, ms: r.ms } : { state: 'down' });
        if (!gone) renderNodes(wallet.state);
      }),
    );
  }

  /** While a node is being moved to, the screen's other ways to switch are off too (none does nothing silently). */
  function lockActions(on) {
    if (backBtn) backBtn.disabled = on;
    if (on) useBtn.disabled = true;
    else input.dispatchEvent(new Event('input'));
  }

  async function useNode(host) {
    if (busy) return;
    busy = true;
    switching = host;
    renderNodes(wallet.state);
    lockActions(true);
    put(nodeMsg, notice('info', `${own ? 'Moving' : 'Connecting'} to ${host}… Your coins and history stay as they are.`));
    nodeMsg.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    try {
      await usePublicNode(app, host);
      if (gone) return;
      toast(`Using ${host}`);
      app.go('servers', {}, { replace: true });
    } catch (e) {
      busy = false;
      switching = null;
      if (gone) return;
      renderNodes(wallet.state);
      lockActions(false);
      put(nodeMsg, notice('error', `It did not switch to ${host}: ${e.message} Try again, or another node.`));
    }
  }

  input.addEventListener('input', () => {
    const v = input.value.trim();
    const n = v ? normalizeServerAddress(v) : null;
    hint.textContent = !v ? 'The host and its secure WebSocket (wss) port. Without a port, 50004.' : n.ok ? `Firo PWA will connect to wss://${n.address}` : n.error;
    hint.className = `hint${v && !n.ok ? ' bad' : v ? ' good' : ''}`;
    useBtn.disabled = !(n && n.ok) || (own && n.address === own);
  });

  async function useMine() {
    if (busy) return;
    const n = normalizeServerAddress(input.value);
    if (!n.ok) return put(msg, notice('warn', n.error));
    if (!canUseOwnServer()) return put(msg, notice('info', 'Your own node works in the installed app (after the first install finished). Reload and try again.'));
    busy = true;
    useBtn.disabled = true;
    renderNodes(wallet.state);
    put(msg, notice('info', 'Saving… Firo PWA reopens once so it may connect there; then unlock again.'));
    try {
      await useOwnServer(app, n.address);
    } catch (e) {
      busy = false;
      useBtn.disabled = false;
      if (gone) return;
      renderNodes(wallet.state);
      put(msg, notice('error', `It was not saved: ${e.message}`));
    }
  }

  async function useFiro() {
    if (busy) return;
    busy = true;
    renderNodes(wallet.state);
    try {
      await useFiroServers(app);
      toast("Using Firo's public nodes");
      app.go('servers', {}, { replace: true });
    } catch (e) {
      busy = false;
      if (gone) return;
      renderNodes(wallet.state);
      put(msg, notice('error', `It did not switch: ${e.message}`));
    }
  }

  const useBtn = primary('Use my node', useMine, { disabled: true, 'data-testid': 'use-own-server' });
  const backBtn = own ? secondary("Use Firo's public nodes", useFiro, { 'data-testid': 'use-firo-servers' }) : null;
  if (own) {
    useBtn.classList.replace('btn-primary', 'btn-secondary');
    backBtn.classList.replace('btn-secondary', 'btn-primary');
  }

  const off = wallet.onChange(renderStatus);
  renderStatus(wallet.state);
  // On Firo's public nodes the wallet talks to them anyway: check them all as the screen opens.
  // Someone on their own node chose to talk to no one else: only on their tap.
  if (!own) checkAll();
  const el = screen(
    { title: 'Firo nodes', back: () => app.back('settings'), actions: own ? [backBtn, useBtn] : [useBtn] },
    status,
    nodesBox,
    nodeMsg,
    h(
      'div',
      { class: 'card' },
      h('h3', { text: 'Your own node' }),
      h('p', { class: 'small', text: 'A Firo node with ElectrumX and a secure WebSocket port. Only that node is used: no fallback and no cross-check with Firo\'s public nodes, so no one else sees your IP address or which payments are yours.' }),
      // Said plainly (public audit, P16): with no second node, this node's word is the wallet's truth.
      h('p', { class: 'small', 'data-testid': 'own-node-trust', text: 'Firo PWA then believes that node completely: what it says has arrived, been confirmed or left is checked with no other node. Use only a node you run yourself, or one you trust as much as your wallet.' }),
      h('label', { class: 'field' }, 'Address', input),
      hint,
    ),
    msg,
  );
  return {
    el,
    destroy() {
      gone = true;
      off();
    },
  };
}
