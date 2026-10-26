// The page's side of the person's own Ethereum / BNB Chain server (lib/servers.js), with a stand-in
// service worker: it is checked by the worker before anything is saved, its origin handed to the
// worker, the choice saved, and the app reopened once unless this page's policy already names it;
// at boot the worker and the choice are brought into agreement (one reload at most, never a loop);
// going back to a listed server takes its origin out of the next page's policy. An older loader
// (contract level 1) is answered with a plain sentence, never a silent "saved".
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- a stand-in browser
const sent = [];
let loader = null; // (msg) -> answer, the stand-in worker
const meta = new Map(); // the meta cache: url -> JSON
let reloads = 0;
const session = new Map();
globalThis.MessageChannel = class {
  constructor() {
    this.port1 = { onmessage: null };
    this.port2 = { postMessage: (d) => this.port1.onmessage && this.port1.onmessage({ data: d }) };
  }
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    serviceWorker: {
      controller: {
        postMessage: (msg, [port]) => {
          sent.push(msg);
          Promise.resolve(loader(msg)).then((a) => port.postMessage(a));
        },
      },
    },
  },
});
globalThis.document = { baseURI: 'https://wallet.example/' };
globalThis.caches = { open: async () => ({ match: async (url) => (meta.has(url) ? new Response(JSON.stringify(meta.get(url))) : undefined) }) };
globalThis.sessionStorage = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) };
globalThis.location = { reload: () => reloads++ };

/** A worker of this release: keeps origins as sw.js does (the real rules, lib/evm_server_address.js). */
const { normalizeEvmServer } = await import('../../src/lib/evm_server_address.js');
function newLoader() {
  return (msg) => {
    if (msg.type === 'set-evm-server') {
      const n = msg.url == null ? null : normalizeEvmServer(msg.url);
      if (n && !n.ok) return { result: 'refused', reason: n.error };
      const all = { ethereum: null, bsc: null, ...(meta.get(EVM_KEY) || {}), [msg.chain]: n ? n.origin : null };
      meta.set(EVM_KEY, all);
      return { result: 'saved', chain: msg.chain, origin: all[msg.chain] };
    }
    if (msg.type === 'set-server') return { result: 'saved', server: msg.server };
    if (msg.type === 'check-evm-server') return { result: 'checked', chain: msg.chain, url: msg.url, origin: normalizeEvmServer(msg.url).origin, report: { ok: true, head: 1, ms: 5 } };
    return { result: 'error', reason: 'unknown request' };
  };
}
/** A loader of 0.1.4 (contract level 1): it knows none of the Ethereum / BNB Chain messages. */
const oldLoader = (msg) => (msg.type === 'set-server' ? { result: 'saved', server: msg.server } : { result: 'error', reason: 'unknown request' });
const EVM_KEY = 'https://wallet.example/__campfire_evm';

function appWith(prefs) {
  const app = { prefs: { server: 'firo', ...prefs }, locked: [], wallet: {} };
  app.setPrefs = async (patch) => (app.prefs = { ...app.prefs, ...patch });
  app.lock = async (why) => app.locked.push(why);
  return app;
}

const S = await import('../../src/lib/servers.js');

function reset() {
  sent.length = 0;
  meta.clear();
  session.clear();
  reloads = 0;
  loader = newLoader();
}

test('at boot: an own server the worker does not know is handed to it, with one reload, and never a loop', async () => {
  reset();
  const app = appWith({ bscRpc: 'custom', bscRpcUrl: 'https://bsc.example.com/v1/KEY' });
  assert.equal(await S.reconcileOwnServer(app), true);
  assert.equal(reloads, 1);
  assert.deepEqual(sent.filter((m) => m.type === 'set-evm-server'), [{ type: 'set-evm-server', chain: 'bsc', url: 'https://bsc.example.com/v1/KEY' }]);
  assert.deepEqual(meta.get(EVM_KEY), { ethereum: null, bsc: 'https://bsc.example.com' }, 'the worker keeps the origin');
  // The reloaded page: the worker names it now, nothing to do.
  assert.equal(await S.reconcileOwnServer(app), false);
  assert.equal(S.servedEvmOrigin('bsc'), 'https://bsc.example.com');
  assert.equal(reloads, 1);
  // A worker that does not keep it (an old loader): one try, then never again in this session.
  reset();
  loader = oldLoader;
  assert.equal(await S.reconcileOwnServer(app), false, 'it refused: no reload');
  assert.equal(await S.reconcileOwnServer(app), false, 'and no second try: no loop');
  assert.equal(reloads, 0);
});

test("at boot: an origin the worker still allows but nobody uses is taken out of the next page's policy, without a reload", async () => {
  reset();
  meta.set(EVM_KEY, { ethereum: 'https://eth.example.com', bsc: null });
  const app = appWith({ ethRpc: 'tenderly', ethRpcUrl: 'https://eth.example.com' });
  assert.equal(await S.reconcileOwnServer(app), false);
  assert.deepEqual(sent, [{ type: 'set-evm-server', chain: 'ethereum', url: null }]);
  assert.deepEqual(meta.get(EVM_KEY), { ethereum: null, bsc: null });
  assert.equal(reloads, 0);
});

test('using one: checked by the worker first; saved; the app reopens once unless this page already allows it; unlock says which', async () => {
  reset();
  const app = appWith({});
  await S.reconcileOwnServer(app); // this page was served with no own server
  const checked = await S.checkEvmWithLoader('ethereum', 'https://ETH.example.com:8545/rpc');
  assert.equal(checked.url, 'https://eth.example.com:8545/rpc');
  assert.equal(checked.report.ok, true);
  assert.deepEqual(sent.at(-1), { type: 'check-evm-server', chain: 'ethereum', url: 'https://eth.example.com:8545/rpc' }, 'the worker gets the address already normalized');
  assert.equal(await S.useOwnEvmServer(app, 'ethereum', checked.url), 'reload');
  assert.deepEqual(app.locked, ['server'], 'the wallet locks before the app reopens');
  assert.equal(reloads, 1);
  assert.equal(app.prefs.ethRpc, 'custom');
  assert.equal(app.prefs.ethRpcUrl, 'https://eth.example.com:8545/rpc');
  assert.deepEqual(meta.get(EVM_KEY), { ethereum: 'https://eth.example.com:8545', bsc: null });
  assert.deepEqual(S.takeEvmSwitchNote(), { chain: 'Ethereum', name: 'eth.example.com:8545' });
  assert.equal(S.takeEvmSwitchNote(), null, 'said once');
  // The reloaded page names it: another path or key on the same origin needs no reload.
  await S.reconcileOwnServer(app);
  assert.equal(await S.useOwnEvmServer(app, 'ethereum', 'https://eth.example.com:8545/rpc2'), 'now');
  assert.equal(reloads, 1);
  assert.deepEqual(app.locked, ['server']);
});

test('back to a listed server: the own origin leaves the next policy (no reload); the address stays in prefs to offer again', async () => {
  reset();
  meta.set(EVM_KEY, { ethereum: null, bsc: 'https://bsc.example.com' });
  const app = appWith({ bscRpc: 'custom', bscRpcUrl: 'https://bsc.example.com/x' });
  await S.reconcileOwnServer(app);
  sent.length = 0;
  await S.useListedEvmServer(app, 'bsc', 'bsc-nodereal');
  assert.deepEqual(sent, [{ type: 'set-evm-server', chain: 'bsc', url: null }]);
  assert.equal(app.prefs.bscRpc, 'bsc-nodereal');
  assert.equal(app.prefs.bscRpcUrl, 'https://bsc.example.com/x');
  assert.equal(reloads, 0);
  // From one listed server to another: the worker is not asked anything.
  meta.clear();
  await S.reconcileOwnServer(appWith({}));
  sent.length = 0;
  await S.useListedEvmServer(appWith({ bscRpc: 'bsc-nodereal' }), 'bsc', 'bsc-defibit');
  assert.deepEqual(sent, []);
});

test('refusals in plain words: an address the rules refuse (before the worker is asked), an older loader, no installed copy', async () => {
  reset();
  await assert.rejects(S.checkEvmWithLoader('ethereum', 'http://eth.example.com'), /Only a node on this device/);
  assert.deepEqual(sent, [], 'the worker was not asked');
  loader = oldLoader;
  await assert.rejects(S.checkEvmWithLoader('ethereum', 'https://eth.example.com'), /close Firo PWA and open it again/);
  await assert.rejects(S.setLoaderEvmServer('ethereum', 'https://eth.example.com'), /close Firo PWA and open it again/);
  await assert.rejects(S.useOwnEvmServer(appWith({}), 'polygon', 'https://p.example.com'), /Not a chain/);
  const controller = navigator.serviceWorker.controller;
  navigator.serviceWorker.controller = null;
  try {
    assert.equal(S.canUseOwnServer(), false);
    await assert.rejects(S.checkEvmWithLoader('ethereum', 'https://eth.example.com'), /installed app/);
  } finally {
    navigator.serviceWorker.controller = controller;
  }
});
