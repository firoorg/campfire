// Which server each chain uses, from the person's preferences (lib/eth/wallet.js evmPrefs), and the
// one-time move off BNB Chain's PublicNode (lib/eth/server_notes.js): it answers every receipt with
// "Archive requests require a personal token" since 2026-10, so it is no longer listed; whoever used
// it (by default before 2026-10-14, or picked) is moved to BNB Chain's official server and told
// once. Also: the person's own server is read from prefs only while it is the pick, and while it
// is in use no listed server is asked about the address (R-1's second opinion is skipped).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evmPrefs, ethPrefs, ethWallet, forgetEthWallet } from '../../src/lib/eth/wallet.js';
import { bscServerNote, takeBscServerNote, bscServerNoteWords, BSC_NOTE_PREF, OLD_BSC_DEFAULT } from '../../src/lib/eth/server_notes.js';
import { DEFAULT_BSC_RPC, BSC_RPC_HOSTS, RPC_HOSTS, CUSTOM_RPC } from '../../src/lib/eth/hosts.js';
import { saveEthKey } from '../../src/lib/eth/vault.js';
import { ethKeyFromMnemonic } from '../../src/lib/eth/crypto.js';
import { newDbPassword } from '../../src/lib/envelope.js';
import { SECOND_TRIES } from '../../src/lib/eth/second_opinion.js';

const JUNK = 'test test test test test test test test test test test junk';

function memoryKv() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    set: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
    update: async (k, fn) => {
      const next = await fn(m.has(k) ? structuredClone(m.get(k)) : undefined);
      m.set(k, structuredClone(next));
      return next;
    },
  };
}

/** An app whose setPrefs merges into prefs, as app.js does. */
function appWith(prefs = {}) {
  const app = { record: { id: 'w-1', imported: false }, dbPass: newDbPassword(), prefs: { ...prefs }, saved: [] };
  app.setPrefs = async (patch) => {
    app.saved.push(patch);
    app.prefs = { ...app.prefs, ...patch };
    return app.prefs;
  };
  return app;
}

test('BNB Chain: PublicNode is no longer listed; a saved pick of it reads as the default (BNB Chain official)', () => {
  assert.equal(DEFAULT_BSC_RPC, 'bsc-bnbchain');
  assert.ok(!BSC_RPC_HOSTS.some((h) => h.id === OLD_BSC_DEFAULT));
  // (An own server whose address is not one is refused instead: N2, below.)
  for (const prefs of [{}, { bscRpc: OLD_BSC_DEFAULT }, { bscRpc: 'nonsense' }]) {
    const p = evmPrefs({ prefs }, 'bsc');
    assert.equal(p.rpcId, 'bsc-bnbchain', JSON.stringify(prefs));
    assert.equal(p.host.name, 'BNB Chain (official)');
    assert.equal(p.custom, false);
  }
  assert.equal(evmPrefs({ prefs: { bscRpc: 'bsc-bloxroute' } }, 'bsc').host.name, 'bloXroute');
  assert.equal(ethPrefs({ prefs: { ethRpc: 'tenderly' } }).host.name, 'Tenderly');
  assert.equal(ethPrefs({ prefs: { ethRpc: 'bsc-nodereal' } }).rpcId, 'stackwallet', "another chain's server is not this chain's");
});

test("the person's own server: in use only while it is the pick, with an address the rules take; named by its host", () => {
  const p = evmPrefs({ prefs: { bscRpc: CUSTOM_RPC, bscRpcUrl: 'https://bsc.example.com:8545/v1/KEY', ethRpc: 'drpc' } }, 'bsc');
  assert.equal(p.custom, true);
  assert.equal(p.rpcId, CUSTOM_RPC);
  assert.equal(p.host.name, 'bsc.example.com:8545');
  assert.equal(p.host.url, 'https://bsc.example.com:8545/v1/KEY');
  assert.equal(p.host.chain, 'bsc');
  assert.equal(evmPrefs({ prefs: { bscRpc: CUSTOM_RPC, bscRpcUrl: 'https://bsc.example.com:8545/v1/KEY', ethRpc: 'drpc' } }, 'ethereum').host.id, 'drpc', 'per chain');
  // Its address kept, another server picked: not in use.
  assert.equal(evmPrefs({ prefs: { bscRpc: 'bsc-nodereal', bscRpcUrl: 'https://bsc.example.com' } }, 'bsc').custom, false);
});

test('told once: whoever used PublicNode on BNB Chain (by default, or picked) hears it once; a pick of it is moved to the default', async () => {
  // Picked it: moved and told.
  let app = appWith({ bscRpc: OLD_BSC_DEFAULT });
  assert.deepEqual(bscServerNote(app.prefs), { picked: true });
  assert.deepEqual(await takeBscServerNote(app), { picked: true });
  assert.equal(app.prefs.bscRpc, DEFAULT_BSC_RPC, 'moved to BNB Chain official');
  assert.equal(app.prefs[BSC_NOTE_PREF], 1);
  assert.equal(await takeBscServerNote(app), null, 'once');
  assert.equal(app.saved.length, 1, 'and nothing more is written');
  // The default (unset) under 0.1.4 was PublicNode: told, nothing to move.
  app = appWith({});
  assert.deepEqual(await takeBscServerNote(app), { picked: false });
  assert.equal(app.prefs.bscRpc, undefined);
  assert.equal(await takeBscServerNote(app), null);
  // Another server picked: nothing changed for them; nothing to tell.
  app = appWith({ bscRpc: 'bsc-nodereal' });
  assert.equal(await takeBscServerNote(app), null);
  assert.equal(app.prefs.bscRpc, 'bsc-nodereal');
  app = appWith({ bscRpc: CUSTOM_RPC, bscRpcUrl: 'https://bsc.example.com' });
  assert.equal(await takeBscServerNote(app), null);
  // Set up from now on (the privacy screen named the BNB Chain server): nothing to tell.
  assert.equal(bscServerNote({ [BSC_NOTE_PREF]: 1 }), null);
  assert.equal(bscServerNote({ [BSC_NOTE_PREF]: 1, bscRpc: OLD_BSC_DEFAULT }), null);
  // A failed save does not lose the note: it comes again.
  app = appWith({});
  app.setPrefs = async () => {
    throw new Error('quota');
  };
  assert.deepEqual(await takeBscServerNote(app), { picked: false });
  assert.deepEqual(bscServerNote(app.prefs), { picked: false });
});

test('the note says what changed, why, and who sees what now', () => {
  const picked = bscServerNoteWords({ picked: true }, 'BNB Chain (official)');
  assert.match(picked, /^BNB Chain now goes through BNB Chain \(official\)\. PublicNode, the server you had picked, stopped saying whether payments went through/);
  assert.match(picked, /sees your IP address with your address/);
  const dflt = bscServerNoteWords({ picked: false }, 'BNB Chain (official)');
  assert.match(dflt, /^BNB Chain now goes through BNB Chain \(official\), not PublicNode: PublicNode stopped saying whether payments went through\./);
  assert.ok(!/rpc|receipt/i.test(picked + dflt), 'no jargon');
});

test("R-1's second opinion: listed servers other than the one in use, at most SECOND_TRIES; none at all while the person's own server is in use", async () => {
  const kv = memoryKv();
  const app = appWith({});
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  await saveEthKey(app, { sk, address, words: 12 }, { kv });
  const w = await ethWallet(app, { kv });
  const others = w.otherRpcs('bsc');
  assert.equal(others.length, SECOND_TRIES);
  assert.ok(others.every((o) => RPC_HOSTS.bsc.includes(o.host) && o.host.id !== 'bsc-bnbchain'));
  app.prefs = { ...app.prefs, bscRpc: CUSTOM_RPC, bscRpcUrl: 'https://bsc.example.com' };
  assert.deepEqual(w.otherRpcs('bsc'), [], 'no listed server learns the address');
  assert.equal(w.otherRpcs('ethereum').length, SECOND_TRIES, 'the other chain as it was');
  // The client follows the choice: the own server at its address; a new address, a new client.
  const own = w.rpcFor('bsc');
  assert.equal(own.url, 'https://bsc.example.com/');
  assert.equal(w.rpcFor('bsc'), own, 'the same client while nothing changes');
  app.prefs = { ...app.prefs, bscRpcUrl: 'https://bsc.example.com/v2' };
  assert.equal(w.rpcFor('bsc').url, 'https://bsc.example.com/v2');
  app.prefs = { ...app.prefs, bscRpc: 'bsc-defibit' };
  assert.equal(w.rpcFor('bsc').url, 'https://bsc-dataseed1.defibit.io');
  forgetEthWallet();
});

// ---------------------------------------------------------------- release audit 0.1.5 (second round)

test("B1: with the person's own Ethereum server, Stack Wallet's history index is not asked (it is a listed server); the switch is kept for later", async () => {
  const p = evmPrefs({ prefs: { ethRpc: CUSTOM_RPC, ethRpcUrl: 'https://eth.example.com' } }, 'ethereum');
  assert.equal(p.custom, true);
  assert.equal(p.history, false, 'not asked');
  assert.equal(p.historyHeld, true, 'History is on, held while the own server is in use');
  assert.equal(evmPrefs({ prefs: { ethRpc: CUSTOM_RPC, ethRpcUrl: 'https://eth.example.com', ethHistory: false } }, 'ethereum').historyHeld, false);
  assert.equal(evmPrefs({ prefs: {} }, 'ethereum').history, true, 'listed server: as before');
  assert.equal(evmPrefs({ prefs: { bscRpc: CUSTOM_RPC, bscRpcUrl: 'https://bsc.example.com' } }, 'ethereum').history, true, "BNB Chain's own server changes nothing for Ethereum's history");
  // refresh() does not ask the index then.
  const kv = memoryKv();
  const app = appWith({ ethRpc: CUSTOM_RPC, ethRpcUrl: 'https://eth.example.com' });
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  await saveEthKey(app, { sk, address, words: 12 }, { kv });
  const w = await ethWallet(app, { kv });
  const asked = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    throw new TypeError('no network in a unit test');
  };
  try {
    await w.refresh();
  } finally {
    globalThis.fetch = prevFetch;
  }
  assert.ok(asked.length > 0, 'the servers were asked');
  assert.ok(!asked.some((u) => /stackwallet|\/export/.test(u)), `no listed server and no index: ${asked.join(' ')}`);
  forgetEthWallet();
});

test('N2: an own server whose saved address the rules no longer take is refused and said so, never swapped for a listed server', async () => {
  const p = evmPrefs({ prefs: { bscRpc: CUSTOM_RPC, bscRpcUrl: 'http://bsc.example.com' } }, 'bsc');
  assert.equal(p.custom, true);
  assert.equal(p.host.unusable, true);
  assert.ok(!BSC_RPC_HOSTS.includes(p.host));
  const { EthRpc } = await import('../../src/lib/eth/rpc.js');
  let fetched = 0;
  const rpc = new EthRpc(p.host, { fetch: async () => (fetched++, new Response('{}')) });
  await assert.rejects(rpc.blockNumber(), (e) => e.code === 'unusable' && /own BNB Chain server is not one Campfire can use any more\. Pick a server again\./.test(e.message));
  assert.equal(fetched, 0, 'nothing was asked of anyone');
  assert.equal(evmPrefs({ prefs: { bscRpc: CUSTOM_RPC } }, 'bsc').host.unusable, true, 'no address saved at all: the same');
});

test("S4: someone who had picked PublicNode: every BNB Chain request waits until the note was shown (which takes it); nothing waits for anyone else", async () => {
  const { bscHeld } = await import('../../src/lib/eth/wallet.js');
  const kv = memoryKv();
  const app = appWith({ bscRpc: OLD_BSC_DEFAULT });
  let shown = 0;
  app.bscNote = () => {
    shown++;
  };
  assert.equal(bscHeld(app), true);
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  await saveEthKey(app, { sk, address, words: 12 }, { kv });
  const w = await ethWallet(app, { kv });
  assert.ok(shown >= 1, 'opening the wallet asks for the note');
  const asked = [];
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    const m = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: '0x10' }), { status: 200 });
  };
  try {
    const pending = w.rpcFor('bsc').blockNumber();
    let settled = false;
    pending.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(settled, false, 'held');
    assert.deepEqual(asked, [], 'nothing reached a BNB Chain server');
    assert.ok(shown >= 2, 'the note is asked for while held');
    // The note is shown: it takes it (told, and the pick moved to BNB Chain official).
    await takeBscServerNote(app);
    assert.equal(await pending, 16);
    assert.deepEqual(asked, ['https://bsc-dataseed.bnbchain.org'], 'then to BNB Chain official');
    assert.equal(bscHeld(app), false);
    // Ethereum never waited.
    assert.equal(bscHeld(appWith({})), false, 'default users: told, never held');
    assert.equal(bscHeld({ prefs: { bscRpc: OLD_BSC_DEFAULT } }), false, 'no screen to tell it on (no hook): never held for ever');
  } finally {
    globalThis.fetch = prevFetch;
    forgetEthWallet();
  }
});

test('S4 (verification): showing the note marks it shown for the session first, so a failed save neither brings it back nor holds BNB Chain; a locked wallet stops waiting', async () => {
  const { bscHeld } = await import('../../src/lib/eth/wallet.js');
  const { showBscServerNote } = await import('../../src/screens/eth_server_note.js');
  // Saving fails: prefs never change.
  const app = appWith({ bscRpc: OLD_BSC_DEFAULT });
  app.setPrefs = async () => {
    throw new Error('quota');
  };
  let asked = 0;
  app.bscNote = () => {
    asked++;
  };
  assert.equal(bscHeld(app), true, 'held before the note is shown');
  const opened = [];
  await showBscServerNote(app, { open: (build, opts) => opened.push(opts.label) });
  assert.deepEqual(opened, ['BNB Chain server changed'], 'shown once');
  assert.equal(app.bscNoteShown, true, 'marked shown for the session, whatever the save did');
  assert.equal(bscHeld(app), false, 'so nothing waits for it any more');
  assert.deepEqual(bscServerNote(app.prefs), { picked: true }, 'the save failed: it comes again at the next start');
  await showBscServerNote(app, { open: (build, opts) => opened.push(opts.label) });
  assert.equal(opened.length, 1, 'not again in this session');
  // Opening the wallet again asks for no note either (it was shown).
  const kv0 = memoryKv();
  const k0 = await ethKeyFromMnemonic(JUNK);
  await saveEthKey(app, { sk: k0.sk, address: k0.address, words: 12 }, { kv: kv0 });
  await ethWallet(app, { kv: kv0 });
  assert.equal(asked, 0, 'no note asked for once it was shown');
  forgetEthWallet();
  // A request made while it is held waits, asking for the note meanwhile; it goes once the note
  // was shown, and gives up when the wallet locks.
  const kv = memoryKv();
  const held = appWith({ bscRpc: OLD_BSC_DEFAULT });
  let notes = 0;
  held.bscNote = () => {
    notes++;
  };
  const { sk, address } = await ethKeyFromMnemonic(JUNK);
  await saveEthKey(held, { sk, address, words: 12 }, { kv });
  const w = await ethWallet(held, { kv });
  const pending = w.rpcFor('bsc').blockNumber();
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(notes >= 2, `the note was asked for while the request waited (${notes})`);
  held.dbPass = null; // locked
  await assert.rejects(pending, (e) => e.code === 'locked');
  forgetEthWallet();
});
