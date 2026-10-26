// A stand-in for the Firo engine (lib/firo/backend.js, the core stream), so every screen and the
// browser suites run with no server and no network. It implements the whole contract of
// WALLET_API.md - keys, lifecycle, state, receive, send, privatize, and the later milestones'
// stubs - deterministically:
//
// - Words are real BIP39 (the vendored @scure/bip39): what it generates validates anywhere.
// - A wallet is known by SHA-256 of its words and passphrase. Words generated in this page start
//   empty (a new wallet has no history); any other words come back with the same small history
//   every time (a restored wallet): received publicly, privatized, received privately with a memo,
//   paid privately, received publicly again - so both balances and Privatize show.
// - Sync walks the contract's phases (connecting, transparent, spark-sets, spark-tags,
//   spark-identify, done) in about two seconds; payments confirm in the next fake block, three
//   seconds later. What a wallet did is kept in its store, so a reload shows it again.
// - Addresses look like Firo's (Spark "sm1…", transparent "a…") but are made from the hash: never
//   pay them on the real network. Spark names: satoshi and campfire resolve; others do not.
//
// Test controls (this module only, so only where the fake runs): globalThis.__firoFake =
// { credit({to, amount, memo, unproven}), offline(bool), mine(), speed(ms), state(), renameTo(name, address),
// refuseSets(code), slowCoinCheck(ms), nodeDown(host, down), unsureNext({arrives}), refuseNext(message),
// hold(on), feeChangeNext(sats), noSecond(syncs), slowSwitch(ms), proving(sats, done, total) } on the open wallet. slowSwitch(ms): the next change of
// node takes that long, as the real engine's does while a sync it waits for ends. hold(true): no fake block comes by itself (mine()
// still makes one). feeChangeNext(sats): from the next send() on, the fee is that much higher (as
// when a coin arrives during Face ID); a send() given the figures Review showed (expect) is then
// refused with 'fee-changed' and the new figures, as the real engine does (audit FE-3).
//
// As the real engine (audit FM-1), a payment is in the wallet's records before it is "broadcast":
// unsureNext() makes the next one get no answer (code 'unsure' with its txid, the payment shown
// unsure and its amount spent); with arrives: true (the default) it was relayed: the next fake
// block finds it on the network (no longer unsure), the one after confirms it; with arrives: false
// it never left, and two fake blocks later it is dropped (the amount is back, the payment says it
// did not go through); with arrives: false, oneNode: true it is offered to let go instead
// (Tx.oneNode), and letGo(txid) drops it (Tx.letGo; letGoNext(answer) makes the next tap answered
// 'seen' or 'offline' instead, as the real engine can). refuseNext() makes the node refuse the
// next one (code 'server'): nothing is kept. credit({unproven: true}): a payment to this wallet that
// is in a block on the node's word for one fake block before it is proven (audit FE-1: shown with
// confirmations 0 and unproven, not spendable).
//
// Nothing here touches the network, and nothing here is secret: the words are hashed and dropped.
// i18n-ignore-file: the stand-in engine of the browser suites (sample data, no Firo network); a release never runs it

import { generateMnemonic as bip39Generate, validateMnemonic as bip39Validate } from '../vendor/noble/scure-bip39/index.js';
import { wordlist } from '../vendor/noble/scure-bip39/wordlists/english.js';
import { sha256 } from '../vendor/noble/noble-hashes/sha2.js';

export const DEFAULT_SERVERS = Object.freeze(['electrumx.firo.org', 'electrumx01.firo.org', 'electrumx02.firo.org', 'electrumx03.firo.org'].map((h) => Object.freeze({ url: `wss://${h}:50004` })));

/** The stand-in's network fee for a Spark name registration (satoshi). */
const NAME_NET_FEE = 21000n;
const COIN = 100000000n;
const DUST = 1000n;
const FEE_PUBLIC = 10000n; // 0.0001 FIRO (fake)
const FEE_PRIVATE = 20000n; // 0.0002 FIRO (fake)
const FEE_PER_EXTRA_OUTPUT = 5000n;
// Firo mainnet was at block 1,393,023 on 2026-10-12; the fake tip follows the clock from there.
const BASE_HEIGHT = 1393000;
const BASE_TIME = Date.UTC(2026, 9, 12) / 1000;
const BLOCK_SEC = 300;
const SPARK_MEMO_MAX = 31;
// The real engine's words for a payment that may have left (lib/firo/backend.js UNSURE_WORDS).
const UNSURE_WORDS = "Your payment may have left. Don't send it again yet: Firo PWA is checking.";
/** As the real engine (lib/firo/backend.js): a payment while another is still being sent is refused. */
const IN_FLIGHT_WORDS = 'Another payment from this wallet is still being sent, so this one was not sent. Nothing left your wallet: try again once that one has left.';
// The real engine's words when a private payment is stopped over its coin lists (audit D-09).
const SET_WORDS = Object.freeze({
  'set-mismatch': "This Firo server's list of private coins does not add up, so the payment was stopped to keep it private.",
  'set-disagree': 'Two Firo servers gave different lists of private coins, so the payment was stopped to keep it private.',
  'set-unchecked': 'The list of private coins could not be checked with the network yet. Try again in a minute.',
});

const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SPARK_RE = /^(sm1|st1)[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{60,}$/;
const TRANSPARENT_RE = /^[aZ][1-9A-HJ-NP-Za-km-z]{33}$/;
const EXCHANGE_RE = /^EX[1-9A-HJ-NP-Za-km-z]{30,40}$/;
// Spark names: letters, digits, '.' and '-', 20 at most (libspark); typed with or without '@'.
const NAME_RE = /^@?([a-zA-Z0-9][a-zA-Z0-9.-]{0,19})$/;

const enc = new TextEncoder();
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const hash = (s) => sha256(enc.encode(s));

// Words generated in this page: their wallet starts empty.
const generated = new Set();
let current = null;
let tickMs = 40;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function normalizeWords(text) {
  return String(text ?? '').normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

/** Characters of `alphabet` drawn from a hash chain seeded by `seed`. */
function drawn(seed, alphabet, n) {
  let out = '';
  let block = hash(seed);
  let i = 0;
  while (out.length < n) {
    if (i >= block.length) {
      block = sha256(block);
      i = 0;
    }
    out += alphabet[block[i++] % alphabet.length];
  }
  return out;
}

const sparkAddress = (id, d) => `sm1${drawn(`${id}:spark:${d}`, BECH, 141)}`;
const transparentAddress = (id, i) => `a${drawn(`${id}:t:${i}`, B58, 33)}`;
const txidOf = (id, n) => hex(hash(`${id}:tx:${n}`));
const tipNow = () => BASE_HEIGHT + Math.floor((Date.now() / 1000 - BASE_TIME) / BLOCK_SEC);

const NAMES = { satoshi: sparkAddress('names', 'satoshi'), campfire: sparkAddress('names', 'campfire') }; // not frozen: __firoFake.renameTo changes an answer

/** The deterministic history of a restored wallet (amounts in satoshi, ages in days). */
function sampleHistory(id) {
  const day = 86400;
  const now = Math.floor(Date.now() / 1000);
  const counter = (n) => transparentAddress(`${id}:other`, n);
  return [
    { n: 1, ageSec: 40 * day, direction: 'in', kind: 'transparent', amount: 125000000n, fee: 0n, counterparty: counter(1), effect: { public: 125000000n } },
    { n: 2, ageSec: 39 * day, direction: 'self', kind: 'privatize', amount: 100000000n, fee: FEE_PUBLIC, effect: { public: -(100000000n + FEE_PUBLIC), private: 100000000n } },
    { n: 3, ageSec: 10 * day, direction: 'in', kind: 'spark', amount: 250000000n, fee: 0n, memo: 'Thanks for the coffee', effect: { private: 250000000n } },
    { n: 4, ageSec: 3 * day, direction: 'out', kind: 'spark', amount: 40000000n, fee: FEE_PRIVATE, memo: 'Rent share', counterparty: sparkAddress(`${id}:other`, 4), effect: { private: -(40000000n + FEE_PRIVATE) } },
    { n: 5, ageSec: 1 * day, direction: 'in', kind: 'transparent', amount: 30000000n, fee: 0n, counterparty: counter(5), effect: { public: 30000000n } },
  ].map((t) => ({ ...t, txid: txidOf(id, t.n), time: now - t.ageSec, height: tipNow() - Math.floor(t.ageSec / BLOCK_SEC) }));
}

const big = (v) => BigInt(v);
const str = (v) => String(v);

function toStored(t) {
  return { ...t, amount: str(t.amount), fee: str(t.fee), effect: Object.fromEntries(Object.entries(t.effect || {}).map(([k, v]) => [k, str(v)])) };
}
function fromStored(t) {
  return { ...t, amount: big(t.amount), fee: big(t.fee), effect: Object.fromEntries(Object.entries(t.effect || {}).map(([k, v]) => [k, big(v)])) };
}

function sats(v, what = 'amount') {
  let b;
  try {
    b = typeof v === 'bigint' ? v : BigInt(String(v));
  } catch {
    throw fail('invalid-amount', `The ${what} is not a number of satoshi.`);
  }
  if (b <= 0n) throw fail('invalid-amount', `The ${what} must be more than zero.`);
  return b;
}

const coins = (s) => {
  const v = BigInt(s);
  const w = v / COIN;
  const f = (v % COIN).toString().padStart(8, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
};

class FakeBackend {
  constructor({ network = 'main', servers, store } = {}) {
    this.network = network === 'test' ? 'test' : 'main';
    this.servers = (Array.isArray(servers) && servers.length ? servers : DEFAULT_SERVERS).map((s) => ({ url: String(s.url) }));
    this.store = store;
    this.listeners = new Set();
    this.timers = new Set();
    this.id = null;
    this._inFlight = 0; // as the real engine: payments between send() and their broadcast (FE-4)
    this.reset();
    // Later milestones (WALLET_API.md): not built in this version.
    const notYet = (what) => async () => {
      throw fail('NotYet', `${what} is not in this version yet.`);
    };
    // Spark names, in memory: 'taken' is a name someone else has; registrations land on this wallet.
    const names = [];
    const fee = (n) => [0, 1000, 100, 10, 10, 10][String(n).length] ?? 1;
    this.sparkNames = {
      list: async () => names.map((e) => ({ name: e.name, address: e.address })),
      listDetailed: async () => names.map((e) => ({ ...e })),
      // As the real engine: one own name asked about by name, only when the person asks.
      details: async (n) => {
        const e = names.find((x) => x.name.toLowerCase() === String(n).replace(/^@/, '').toLowerCase());
        if (!e) throw Object.assign(new Error(`"${n}" is not one of this wallet's names.`), { code: 'invalid-name' });
        return { validUntil: e.validUntil, additionalInfo: e.additionalInfo };
      },
      isFree: async (n) => /^[a-zA-Z0-9.-]{1,20}$/.test(n) && n.toLowerCase() !== 'taken' && !names.some((e) => e.name.toLowerCase() === String(n).toLowerCase()),
      feeFiro: (n, years = 1) => fee(n) * years,
      // As the real engine: what it would cost, network fee included, and pinned at payment (L7).
      quote: async ({ name, years = 1 }) => ({ fee: String(NAME_NET_FEE + (this._extraFee || 0n)), total: String(BigInt(fee(name) * years) * 100000000n + NAME_NET_FEE + (this._extraFee || 0n)) }),
      quoteRenew: async ({ name, years = 1 }) => this.sparkNames.quote({ name, years }),
      // As the real engine, a registration is a payment: one at a time (release verification 0.1.8).
      register: async ({ name, years = 1, additionalInfo = '', expect = null }) => {
        if (this._inFlight > 0) throw fail('in-flight', IN_FLIGHT_WORDS);
        await this._nameExpect(name, years, expect);
        names.push({ name, address: this.s.receive?.spark ?? 'sm1fake', validUntil: (this.s.tip?.height ?? 1000000) + years * 210240, additionalInfo });
        return { txid: 'f'.repeat(56) + String(names.length).padStart(8, '0') };
      },
      renew: async ({ name, years = 1, expect = null }) => {
        if (this._inFlight > 0) throw fail('in-flight', IN_FLIGHT_WORDS);
        await this._nameExpect(name, years, expect);
        const e = names.find((x) => x.name === name);
        if (!e) throw Object.assign(new Error(`"${name}" is not one of this wallet's names.`), { code: 'invalid-name' });
        e.validUntil += years * 210240;
        return { txid: 'e'.repeat(56) + String(names.length).padStart(8, '0') };
      },
      transfer: notYet('Moving a Spark name'),
    };
    // Coins, in memory: one public and one private coin per credited payment (the stand-in keeps
    // balances, not coins, so it shows them as two coins at most).
    const frozen = new Set();
    const labels = {};
    this.coins = {
      list: async () => {
        const out = [];
        const b = this.balances();
        if (BigInt(b.public.available) > 0n) out.push({ id: `${'a'.repeat(64)}:0`, kind: 'transparent', amount: String(b.public.available), address: this.s.receive?.transparent, confirmations: 6, frozen: frozen.has(`${'a'.repeat(64)}:0`), spendable: !frozen.has(`${'a'.repeat(64)}:0`), label: labels[`${'a'.repeat(64)}:0`] });
        if (BigInt(b.private.available) > 0n) out.push({ id: 'b'.repeat(64), kind: 'spark', amount: String(b.private.available), frozen: false, spendable: true, label: labels['b'.repeat(64)] });
        return out;
      },
      freeze: async (id, on = true) => {
        if (!/:\d+$/.test(id)) throw Object.assign(new Error('Freezing Spark coins is not in this version yet.'), { code: 'NotYet' });
        if (on) frozen.add(id);
        else frozen.delete(id);
      },
      label: async (id, text) => {
        if (text) labels[id] = String(text);
        else delete labels[id];
      },
    };
    // Masternodes in the stand-in: none, so the screen shows what a masternode needs.
    this.masternodes = { list: async () => [], register: notYet('Registering a masternode') };
    this.rosen = { quote: notYet('The Rosen bridge'), lock: notYet('The Rosen bridge') };
  }

  /** As the real engine's send with expect: other figures than the ones shown, nothing is paid. */
  async _nameExpect(name, years, expect) {
    if (this._feeChangeNext) {
      this._extraFee = (this._extraFee || 0n) + this._feeChangeNext;
      this._feeChangeNext = 0n;
    }
    if (!expect) return;
    const q = await this.sparkNames.quote({ name, years });
    if (q.fee !== String(expect.fee) || q.total !== String(expect.total)) throw Object.assign(fail('fee-changed', 'The network fee changed since it was shown, so nothing was sent. Check the new figures, then send.'), { fee: q.fee, total: q.total });
  }

  reset() {
    this.s = {
      connected: false,
      server: null,
      tip: null,
      sync: { phase: 'connecting', done: 0, total: 0 },
      txs: [],
      receive: { spark: null, transparent: null },
      viewOnly: false,
      offline: false,
      spark: 0,
      transparent: 0,
      nextTx: 100,
    };
    this.revealed = { public: false, private: false };
  }

  // ---------------------------------------------------------------- keys (pure)
  generateMnemonic(words = 24) {
    if (words !== 12 && words !== 24) throw fail('invalid', 'Recovery phrases have 12 or 24 words.');
    const m = bip39Generate(wordlist, words === 24 ? 256 : 128);
    generated.add(hex(hash(normalizeWords(m))));
    return m;
  }

  validateMnemonic(text) {
    const words = normalizeWords(text).split(' ').filter(Boolean);
    if (![12, 15, 18, 21, 24].includes(words.length)) return { ok: false, error: `A recovery phrase has 12, 15, 18, 21 or 24 words; this has ${words.length}.` };
    const unknown = words.findIndex((w) => !wordlist.includes(w));
    if (unknown >= 0) return { ok: false, error: `Word ${unknown + 1} ("${words[unknown]}") is not a recovery word. Check its spelling.` };
    if (!bip39Validate(words.join(' '), wordlist)) return { ok: false, error: 'These words are not a valid recovery phrase. Check their order and spelling.' };
    return { ok: true };
  }

  // ---------------------------------------------------------------- lifecycle
  async open({ mnemonic, passphrase = '', birthdayHeight } = {}) {
    const v = this.validateMnemonic(mnemonic);
    if (!v.ok) throw fail('invalid', v.error);
    const words = normalizeWords(mnemonic);
    const seedHash = hex(hash(`${words}\u0000${String(passphrase).normalize('NFKD')}`));
    this.id = seedHash.slice(0, 32);
    this.birthday = Number.isSafeInteger(birthdayHeight) ? birthdayHeight : null;
    await this.load(generated.has(hex(hash(words))));
    current = this;
    this.connect();
  }

  async openViewOnly({ sparkFullViewKey, xpub } = {}) {
    if (!sparkFullViewKey && !xpub) throw fail('invalid', 'A view key or an xpub is needed.');
    this.id = hex(hash(`view:${sparkFullViewKey || ''}:${xpub || ''}`)).slice(0, 32);
    await this.load(false);
    this.s.viewOnly = true;
    current = this;
    this.connect();
  }

  async close() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (current === this) current = null;
    this.id = null;
    this.reset();
    this.emit();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  later(ms, fn) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.id) fn();
    }, ms);
    this.timers.add(t);
  }

  async load(fresh) {
    const saved = this.store ? await this.store.get('fake:wallet') : undefined;
    if (saved && saved.v === 1) {
      this.all = saved.txs.map(fromStored);
      this.s.spark = saved.spark || 0;
      this.s.transparent = saved.transparent || 0;
      this.s.nextTx = saved.nextTx || 100;
    } else {
      this.all = fresh ? [] : sampleHistory(this.id);
      await this.save();
    }
    this.s.receive = { spark: sparkAddress(this.id, this.s.spark), transparent: transparentAddress(this.id, this.s.transparent) };
  }

  async save() {
    if (!this.store || !this.id) return;
    await this.store.put('fake:wallet', { v: 1, txs: this.all.map(toStored), spark: this.s.spark, transparent: this.s.transparent, nextTx: this.s.nextTx });
  }

  /** Connects to the first server and walks the sync phases. */
  connect(phases = ['transparent', 'spark-sets', 'spark-tags', 'spark-identify']) {
    const s = this.s;
    s.connected = false;
    s.server = null;
    s.sync = { phase: 'connecting', done: 0, total: 0 };
    if (phases[0] === 'transparent') this.revealed = { public: false, private: false };
    else this.revealed.private = false;
    this.emit();
    this.later(tickMs * 6, () => {
      if (s.offline) return this.goOffline();
      s.connected = true;
      s.server = this.servers[0].url;
      // Never behind a block this wallet's payments are already in (fake blocks run ahead of the clock).
      const highest = this.all.reduce((m, t) => (t.height != null && t.height > m ? t.height : m), 0);
      s.tip = { height: Math.max(tipNow(), s.tip ? s.tip.height : 0, highest), time: Math.floor(Date.now() / 1000) - 40 };
      // Payments still waiting from before (a reopen) go into the next fake block too.
      if (this.all.some((t) => t.height == null && !t.dropped)) this.later(3000, () => this.autoMine());
      this.walk(phases, 0);
    });
  }

  walk(phases, i) {
    const s = this.s;
    if (s.offline) return this.goOffline();
    if (i >= phases.length) {
      s.sync = { phase: 'done', done: 1, total: 1 };
      this.revealed = { public: true, private: true };
      return this.emit();
    }
    const phase = phases[i];
    const total = { transparent: 12, 'spark-sets': 24, 'spark-tags': 8, 'spark-identify': Math.max(4, this.all.length) }[phase];
    let done = 0;
    const step = () => {
      if (s.offline) return this.goOffline();
      s.sync = { phase, done, total };
      if (phase === 'spark-sets' && done === 0) this.revealed.public = true;
      this.emit();
      if (done >= total) return this.walk(phases, i + 1);
      done++;
      this.later(tickMs, step);
    };
    step();
  }

  goOffline() {
    const s = this.s;
    s.connected = false;
    s.server = null;
    s.sync = { phase: 'error', done: 0, total: 0, error: 'No Firo node answered. Check your internet connection.' };
    this.emit();
  }

  emit() {
    const state = this.getState();
    for (const l of this.listeners) {
      try {
        l(state);
      } catch (e) {
        console.error(e);
      }
    }
  }

  // ---------------------------------------------------------------- state
  balances() {
    const tip = this.s.tip ? this.s.tip.height : tipNow();
    const b = { private: { available: 0n, pending: 0n }, public: { available: 0n, pending: 0n } };
    for (const t of this.all) {
      if (t.dropped) continue; // never left: nothing of it counts
      const confirmed = t.height != null && t.height <= tip && !t.proving;
      for (const side of ['public', 'private']) {
        const d = (t.effect && t.effect[side]) || 0n;
        if (d === 0n || !this.revealed[side]) continue;
        if (d < 0n || confirmed) b[side].available += d;
        else b[side].pending += d;
      }
    }
    return b;
  }

  visible(t) {
    if (t.kind === 'transparent' || t.kind === 'coinbase' || t.kind === 'masternode') return this.revealed.public;
    return this.revealed.private;
  }

  getState() {
    const s = this.s;
    const tip = s.tip ? s.tip.height : null;
    const b = this.balances();
    const out = (x) => ({ available: str(x.available), pending: str(x.pending) });
    return {
      network: this.network,
      connected: s.connected,
      server: s.server,
      tip: s.tip ? { ...s.tip } : null,
      sync: { ...s.sync },
      // As the real engine's tip check (D-11) when no second node can be asked (__firoFake.noSecond).
      serverCheck: this._noSecond ? { state: 'unknown', at: Math.floor(Date.now() / 1000), otherHeight: null, noSecondSyncs: this._noSecond } : null,
      privateCheck: this._privateCheck ?? null,
      sending: this.sending ?? null,
      balance: {
        // __firoFake.proving(sats, done, total): received private FIRO waiting for its sets' check, as the real engine.
        private: this._proving ? { available: str(b.private.available), pending: str(b.private.pending + this._proving.sats), checking: str(this._proving.sats) } : out(b.private),
        public: out(b.public),
      },
      ...(this._proving && this._proving.total ? { privateProof: { done: this._proving.done, total: this._proving.total } } : {}),
      txs: this.id
        ? this.all
            .filter((t) => this.visible(t))
            .sort((a, z) => z.time - a.time)
            .map((t) => {
              const tx = { txid: t.txid, height: t.height, time: t.time, confirmations: t.height != null && tip != null && !t.dropped ? Math.max(0, tip - t.height + 1) : 0, direction: t.direction, kind: t.kind, amount: str(t.amount), fee: str(t.fee) };
              if (t.memo) tx.memo = t.memo;
              if (t.counterparty) tx.counterparty = t.counterparty;
              if (t.dropped) {
                tx.dropped = true;
                if (t.letGo) tx.letGo = true;
              } else if (t.height == null) {
                if (t.unsure) tx.unsure = true;
                if (t.oneNode) tx.oneNode = true;
              }
              if (t.proving && t.height != null) {
                tx.unproven = true;
                tx.confirmations = 0;
              }
              return tx;
            })
        : [],
      receive: { ...s.receive },
      viewOnly: s.viewOnly,
    };
  }

  // ---------------------------------------------------------------- receive
  async newTransparentAddress() {
    this.need();
    this.s.transparent++;
    this.s.receive = { ...this.s.receive, transparent: transparentAddress(this.id, this.s.transparent) };
    await this.save();
    this.emit();
    return this.s.receive.transparent;
  }

  async newSparkAddress() {
    this.need();
    this.s.spark++;
    this.s.receive = { ...this.s.receive, spark: sparkAddress(this.id, this.s.spark) };
    await this.save();
    this.emit();
    return this.s.receive.spark;
  }

  need() {
    if (!this.id) throw fail('not-open', 'The wallet is not open.');
  }

  isMine(address) {
    if (!this.id) return false;
    for (let d = 0; d <= this.s.spark; d++) if (sparkAddress(this.id, d) === address) return true;
    for (let i = 0; i <= this.s.transparent; i++) if (transparentAddress(this.id, i) === address) return true;
    return false;
  }

  // ---------------------------------------------------------------- send
  classifyAddress(text) {
    const t = String(text ?? '').trim();
    const name = NAME_RE.exec(t);
    if (name) return { kind: 'spark-name', name: name[1].toLowerCase() };
    if (SPARK_RE.test(t)) return t.startsWith(this.network === 'test' ? 'st1' : 'sm1') ? { kind: 'spark', address: t } : { kind: 'invalid' };
    if (EXCHANGE_RE.test(t)) return { kind: 'exchange', address: t };
    if (TRANSPARENT_RE.test(t)) return { kind: 'transparent', address: t };
    return { kind: 'invalid' };
  }

  async resolveSparkName(name) {
    await new Promise((r) => setTimeout(r, 120));
    const n = String(name || '').replace(/^@/, '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMES, n) ? NAMES[n] : null;
  }

  /** As the real engine: pinned names (a change is refused until accepted); "checked" by two servers. */
  async resolveSparkNameForPayment(name, { acceptChange = false } = {}) {
    const n = String(name || '').replace(/^@/, '');
    const address = await this.resolveSparkName(n);
    if (!address) return null;
    this._pins = this._pins || new Map();
    const pinned = this._pins.get(n.toUpperCase());
    if (pinned && pinned !== address && !acceptChange) throw Object.assign(fail('name-changed', `@${n} now points to a different address than the one you paid before.`), { name: n, before: pinned, now: address });
    return { address, checked: 'two-servers' };
  }

  async pinSparkName(name, address) {
    this._pins = this._pins || new Map();
    this._pins.set(String(name || '').replace(/^@/, '').toUpperCase(), address);
  }

  /** Tests: point a name somewhere else (a server that changed its answer). */
  setNameForTest(name, address) {
    NAMES[String(name).toLowerCase()] = address;
  }

  ready() {
    if (!this.id) throw fail('not-open', 'The wallet is not open.');
    if (this.s.viewOnly) throw fail('view-only', 'This wallet can only watch: it cannot send.');
    if (!this.s.connected) throw fail('offline', "Can't reach a Firo server right now. Nothing was sent.");
    if (this.s.sync.phase !== 'done') throw fail('not-synced', 'The wallet is still catching up with the network. Try again once it is up to date.');
  }

  /** Recipients checked, names resolved: [{address, kind, amount, memo}]. */
  async recipients(to) {
    if (!Array.isArray(to) || !to.length) throw fail('invalid-address', 'Say who gets the payment.');
    const out = [];
    for (const r of to) {
      let c = this.classifyAddress(r.address);
      if (c.kind === 'spark-name') {
        const a = await this.resolveSparkName(c.name);
        if (!a) throw fail('invalid-address', `No one has the Spark name @${c.name}. Check the spelling, or ask for their address.`);
        c = { kind: 'spark', address: a };
      }
      if (c.kind === 'invalid') throw fail('invalid-address', "That isn't a Firo address. Copy it again from the person you're paying.");
      const amount = sats(r.amount);
      if (amount < DUST) throw fail('dust', `That amount is too small to send: at least ${coins(DUST)} FIRO.`);
      const memo = r.memo ? String(r.memo) : '';
      if (memo && c.kind !== 'spark') throw fail('invalid-memo', 'Only a payment to a Spark address can carry a memo.');
      if ([...memo].length > SPARK_MEMO_MAX) throw fail('invalid-memo', `A memo holds ${SPARK_MEMO_MAX} characters at most.`);
      out.push({ address: c.address, kind: c.kind, amount, memo });
    }
    return out;
  }

  async plan({ from = 'private', to, subtractFee = false } = {}) {
    this.ready();
    if (from !== 'private' && from !== 'public') throw fail('invalid', 'Pay from the private or the public balance.');
    const list = await this.recipients(to);
    if (from === 'private' && list.some((r) => r.kind === 'exchange')) throw fail('invalid-address', 'An exchange address takes payments from your public balance only. Choose Public, or privatize later.');
    const fee = (from === 'private' ? FEE_PRIVATE : FEE_PUBLIC) + FEE_PER_EXTRA_OUTPUT * BigInt(list.length - 1) + (this._extraFee || 0n);
    const sum = list.reduce((a, r) => a + r.amount, 0n);
    const total = subtractFee ? sum : sum + fee;
    if (subtractFee && list.some((r) => r.amount <= fee)) throw fail('dust', 'After the network fee nothing would arrive. Send more.');
    const have = this.balances()[from].available;
    if (total > have) throw fail('insufficient', `That's more than your ${from} balance: ${coins(have)} FIRO can be spent now${subtractFee ? '' : `, and the network fee is ${coins(fee)} FIRO`}.`);
    const warnings = [];
    if (from === 'public') warnings.push('Paid from your public balance: the amount and both addresses are visible on the blockchain.');
    if (from === 'private' && list.some((r) => r.kind === 'transparent')) warnings.push("The receiver's address is public: anyone can see what arrives there. Your balance and history stay private.");
    if (list.some((r) => r.kind === 'exchange')) warnings.push('An exchange address: the exchange sees this payment came from a public balance.');
    return { list, fee, total, change: have - total, warnings };
  }

  async quote(opts = {}) {
    const p = await this.plan(opts);
    return { fee: str(p.fee), total: str(p.total), change: str(p.change), warnings: p.warnings };
  }

  /** As the real engine: a payment between send() and the end of its broadcast (FE-4). */
  get paymentInFlight() {
    return this._inFlight > 0;
  }

  async send(opts = {}) {
    // As the real engine: one payment at a time (release verification 0.1.8).
    if (this._inFlight > 0) throw fail('in-flight', IN_FLIGHT_WORDS);
    this._inFlight++;
    try {
      return await this._send(opts);
    } finally {
      this._inFlight--;
    }
  }

  async _send(opts = {}) {
    if (this._feeChangeNext) {
      this._extraFee = (this._extraFee || 0n) + this._feeChangeNext;
      this._feeChangeNext = 0n;
    }
    const p = await this.plan(opts);
    // As the real engine: the figures Review showed, or nothing (audit FE-3).
    if (opts.expect && (str(p.fee) !== String(opts.expect.fee) || str(p.total) !== String(opts.expect.total))) {
      throw Object.assign(fail('fee-changed', 'The network fee changed since it was shown, so nothing was sent. Check the new figures, then send.'), { fee: str(p.fee), total: str(p.total), change: str(p.change) });
    }
    // As the real engine when a server's list of private coins does not check out (audit D-09).
    // As the real engine's check of the private coin list, when it takes a while (audit D-09).
    if (this._slowCoinCheck && opts.from === 'private') {
      const ms = this._slowCoinCheck;
      this._slowCoinCheck = 0;
      this.sending = 'checking-coins';
      this.emit();
      await new Promise((r) => setTimeout(r, ms));
      this.sending = null;
      this.emit();
    }
    if (this._refuseSets && opts.from === 'private') {
      const code = this._refuseSets;
      this._refuseSets = null;
      throw Object.assign(fail(code, SET_WORDS[code]), { otherServer: code !== 'set-unchecked' });
    }
    this.refusedHere();
    const mine = p.list.every((r) => this.isMine(r.address));
    const sum = p.list.reduce((a, r) => a + r.amount, 0n);
    const kind = opts.from === 'public' ? 'transparent' : 'spark';
    const delta = -p.total;
    const effect = { [opts.from === 'public' ? 'public' : 'private']: delta };
    if (mine) for (const r of p.list) effect[r.kind === 'spark' ? 'private' : 'public'] = (effect[r.kind === 'spark' ? 'private' : 'public'] || 0n) + (opts.subtractFee ? r.amount - p.fee / BigInt(p.list.length) : r.amount);
    const t = this.addTx({ direction: mine ? 'self' : 'out', kind, amount: opts.subtractFee ? sum - p.fee : sum, fee: p.fee, memo: p.list[0].memo || undefined, counterparty: p.list[0].address, effect });
    return this.answered(t);
  }

  /** As the real engine when the node answers a broadcast with an error: nothing is kept (refuseNext). */
  refusedHere() {
    if (!this._refuseNext) return;
    const message = this._refuseNext;
    this._refuseNext = null;
    throw fail('server', `The server refused: ${message}`);
  }

  /**
   * After the payment `t` is in the records: its broadcast's answer. With unsureNext(), none came
   * (code 'unsure' with the txid, as the real engine); the payment is followed as the engine does.
   */
  answered(t) {
    const u = this._unsureNext;
    if (!u) return { txid: t.txid };
    this._unsureNext = null;
    t.unsure = true;
    if (!u.arrives) t.lost = true;
    if (!u.arrives && u.oneNode) t.oneNodeLost = true;
    this.save();
    this.emit();
    throw Object.assign(fail('unsure', UNSURE_WORDS), { txid: t.txid });
  }

  async privatize(opts = {}) {
    if (this._inFlight > 0) throw fail('in-flight', IN_FLIGHT_WORDS);
    this._inFlight++;
    try {
      return await this._privatize(opts);
    } finally {
      this._inFlight--;
    }
  }

  async _privatize({ amount, subtractFee = false } = {}) {
    this.ready();
    const have = this.balances().public.available;
    const fee = FEE_PUBLIC;
    let a;
    if (amount === 'all') {
      if (have <= fee) throw fail('insufficient', `There is not enough public balance to privatize after the ${coins(fee)} FIRO network fee.`);
      a = have - fee;
    } else a = sats(amount) - (subtractFee ? fee : 0n); // the fee taken from the amount, as the real engine does (Privatize screen)
    if (a < DUST) throw fail('dust', `That amount is too small to privatize: at least ${coins(DUST)} FIRO.`);
    if (a + fee > have) throw fail('insufficient', `That's more than your public balance: ${coins(have)} FIRO, and the network fee is ${coins(fee)} FIRO.`);
    this.refusedHere();
    const t = this.addTx({ direction: 'self', kind: 'privatize', amount: a, fee, effect: { public: -(a + fee), private: a } });
    return this.answered(t);
  }

  addTx(t) {
    const n = this.s.nextTx++;
    const tx = { n, txid: txidOf(this.id, n), time: Math.floor(Date.now() / 1000), height: null, fee: 0n, ...t };
    this.all.push(tx);
    this.save();
    this.emit();
    // The next fake block confirms it.
    this.later(3000, () => this.autoMine());
    return tx;
  }

  /** A fake block that comes by itself, unless the test holds them (__firoFake.hold). */
  autoMine() {
    if (!heldBlocks) this.mine();
  }

  /**
   * A fake block: the tip moves on and every unconfirmed payment is in it, except one that never
   * left (unsureNext({arrives: false})): two blocks later it is given up on (dropped).
   */
  mine() {
    if (!this.s.tip) return;
    this.s.tip = { height: Math.max(this.s.tip.height + 1, tipNow()), time: Math.floor(Date.now() / 1000) };
    let following = false;
    // Payments in an earlier fake block are proven by now (audit FE-1).
    for (const t of this.all) if (t.proving && t.height != null) delete t.proving;
    for (const t of this.all) {
      if (t.height != null || t.dropped) continue;
      if (t.unsure && !t.lost) {
        delete t.unsure; // seen on the network: in the next block
        following = true;
        continue;
      }
      if (!t.lost) {
        t.height = this.s.tip.height;
        continue;
      }
      t.waited = (t.waited || 0) + 1;
      if (t.waited >= 2 && t.oneNodeLost) {
        // As the real engine with no second node for an hour (RE3-3): offered to let go, not decided.
        t.oneNode = true;
      } else if (t.waited >= 2) {
        t.dropped = true;
        delete t.unsure;
      } else following = true;
    }
    this.save();
    this.emit();
    if (following) this.later(3000, () => this.autoMine());
  }

  /** As the real engine (RE3-3): the person lets go of a payment offered to let go (Tx.oneNode). */
  async letGo(txid) {
    this.need();
    const t = this.all.find((x) => x.txid === txid);
    if (!t || !t.oneNode || t.dropped || t.height != null) throw fail('not-offered', 'Firo PWA is still checking this payment with the Firo nodes.');
    const answer = this._letGoNext;
    this._letGoNext = null;
    if (answer === 'offline') throw fail('offline', "The Firo node in use didn't answer, so the payment was not let go. Try again in a moment.");
    if (answer === 'seen') {
      // The node in use has it now: followed as any payment on its way, the offer withdrawn first.
      delete t.oneNode;
      delete t.oneNodeLost;
      delete t.lost;
      await this.save();
      this.emit();
      throw fail('seen', 'The Firo node in use has this payment now: it is on its way, so it was not let go.');
    }
    t.dropped = true;
    t.letGo = true;
    delete t.unsure;
    delete t.oneNode;
    await this.save();
    this.emit();
    return { txid, letGo: true };
  }

  // ---------------------------------------------------------------- later milestones the shell uses
  async rescan({ fromHeight } = {}) {
    this.need();
    if (fromHeight != null && !(Number.isSafeInteger(fromHeight) && fromHeight >= 0)) throw fail('invalid', 'Rescan from a block height of 0 or more.');
    this.connect();
  }

  async clearSparkCache() {
    this.need();
    this.connect(['spark-sets', 'spark-tags', 'spark-identify']);
  }

  /** As the real engine: the next server of the list, its coin lists fetched again. -> {server} */
  async useAnotherServer() {
    this.need();
    if (this.servers.length < 2) throw fail('no-other-server', 'Only one server is chosen. Add another in Settings, Servers, then try again.');
    this.servers = [...this.servers.slice(1), this.servers[0]];
    this._privateCheck = null; // the new node's lists add up (as the real engine, which checks them again)
    this.connect(['spark-sets', 'spark-tags', 'spark-identify']);
    return { server: this.servers[0].url };
  }

  /** As the real engine's node check, offline: every node answers with this tip, unless made to fail. */
  async checkNode(url) {
    await new Promise((r) => setTimeout(r, 150));
    const host = String(url).replace(/^wss:\/\//, '').replace(/:\d+$/, '');
    if (downNodes.has(host)) return { ok: false, error: `${host} did not answer in time` };
    return { ok: true, height: this.s.tip ? this.s.tip.height : 0, ms: 940 + (host.length % 7) * 11 };
  }

  async setServers(list) {
    if (!Array.isArray(list) || !list.length) throw fail('invalid', 'Give at least one server.');
    for (const s of list) if (!/^wss:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i.test(String(s && s.url))) throw fail('invalid', `${s && s.url} is not a wss:// server address.`);
    this.servers = list.map((s) => ({ url: String(s.url) }));
    const ms = slowSwitchMs;
    slowSwitchMs = 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    if (this.id) this.connect();
  }

  async exportSparkViewKey() {
    throw fail('NotYet', 'Exporting the Spark view key is not in this version yet.');
  }

  async exportXpub() {
    throw fail('NotYet', 'Exporting the xpub is not in this version yet.');
  }

  /** As the real engine (WALLET_API): sat/kB at each speed. */
  async estimateFeeRate() {
    return { fast: '1000', normal: '1000', slow: '1000', min: '1000', unit: 'sat/kB' };
  }

  // ---------------------------------------------------------------- test controls
  credit({ to = 'private', amount = '50000000', memo, unproven = false } = {}) {
    const side = to === 'public' ? 'public' : 'private';
    return this.addTx({ direction: 'in', kind: side === 'public' ? 'transparent' : 'spark', amount: BigInt(amount), fee: 0n, memo: side === 'private' && memo ? String(memo) : undefined, counterparty: side === 'public' ? transparentAddress('sender', this.s.nextTx) : undefined, effect: { [side]: BigInt(amount) }, ...(unproven && side === 'public' ? { proving: true } : {}) }).txid;
  }

  setOffline(on) {
    this.s.offline = Boolean(on);
    if (on) this.goOffline();
    else this.connect();
  }
}

/** Hosts the stand-in's node check reports as not answering (__firoFake.nodeDown). */
const downNodes = new Set();
/** __firoFake.hold(true): fake blocks come only when a test calls mine(). */
let heldBlocks = false;
/** __firoFake.slowSwitch(ms): how long the next setServers() takes. */
let slowSwitchMs = 0;

export function createBackend(opts = {}) {
  return new FakeBackend(opts);
}

globalThis.__firoFake = Object.freeze({
  credit: (o) => (current ? current.credit(o) : null),
  offline: (on = true) => current && current.setOffline(on),
  mine: () => current && current.mine(),
  speed: (ms) => {
    if (Number.isFinite(ms) && ms > 0) tickMs = ms;
    return tickMs;
  },
  state: () => (current ? current.getState() : null),
  // A server that now answers a different address for a Spark name.
  renameTo: (name, address) => current && current.setNameForTest(name, address),
  // The next private payment is stopped as when a server's coin list does not check out (D-09).
  refuseSets: (code = 'set-mismatch') => {
    if (current) current._refuseSets = code;
  },
  // A node that the Firo nodes screen's check finds not answering.
  slowSwitch: (ms) => {
    slowSwitchMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  },
  nodeDown: (host, down = true) => (down ? downNodes.add(host) : downNodes.delete(host)),
  // The next private payment first waits `ms` on the coin-list check, as a first payment can.
  slowCoinCheck: (ms = 3000) => {
    if (current) current._slowCoinCheck = ms;
  },
  // The next payment's broadcast gets no answer (audit FM-1): 'unsure' with its txid. arrives:
  // whether it had reached the network (it confirms) or not (two fake blocks later: dropped).
  // oneNode (with arrives: false): two fake blocks later the node in use says it never got it and
  // no second node answers for an hour: offered to let go (Tx.oneNode), not dropped (RE3-3).
  unsureNext: ({ arrives = true, oneNode = false } = {}) => {
    if (current) current._unsureNext = { arrives: Boolean(arrives), oneNode: Boolean(oneNode) };
  },
  // The next letGo() is answered as the real engine does when the node in use, asked once more, has
  // the payment now ('seen': the offer is withdrawn, the payment followed as on its way) or does not
  // answer ('offline': the offer stays). RE4-3.
  letGoNext: (answer) => {
    if (current) current._letGoNext = answer === 'seen' || answer === 'offline' ? answer : null;
  },
  // The node refuses the next payment with this message (an error answer: nothing kept).
  refuseNext: (message = 'bad-txns-inputs-missingorspent') => {
    if (current) current._refuseNext = String(message);
  },
  // No fake block by itself while on (a test looks at a state that a block would end).
  hold: (on = true) => {
    heldBlocks = Boolean(on);
  },
  // From the next payment on, the network fee is `sats` higher (a coin arrived during Face ID).
  feeChangeNext: (sats = 7000) => {
    if (current) current._feeChangeNext = BigInt(sats);
  },
  // Private coins received cannot be confirmed: this node's lists do not add up ('set-mismatch') or a
  // second node disagrees ('set-disagree'); null clears it (public audit, P4).
  privateCheck: (code = 'set-mismatch') => {
    if (!current) return;
    current._privateCheck = code ? { code, otherServer: true } : null;
    current.emit();
  },
  // Received private FIRO waiting for its sets' check (N9): `sats` of it, `done` of `total` coins checked; 0 sats clears it.
  proving: (sats, done = 0, total = 0) => {
    if (!current) return;
    current._proving = sats ? { sats: BigInt(sats), done, total } : null;
    current.emit();
  },
  // No second Firo node could be asked for `syncs` syncs in a row (0: one answers again; RE3-2).
  noSecond: (syncs = 3) => {
    if (!current) return;
    current._noSecond = Math.max(0, Number(syncs) || 0);
    current.emit();
  },
});
