// Sells as this device remembers them, and where they are kept, sealed like
// the buys (lib/buy/store.js) and the Ethereum wallet's data.
//
// The order id is a sell's only handle at buyfiro.app, and the deposit
// address is where this wallet sends the FIRO: a lost record is a sell the
// person can no longer look up, and maybe FIRO sent twice. So:
//
// * the list is sealed with AES-256-GCM under a key from the wallet's random
//   secret (app.dbPass): HKDF-SHA256 with its own info string
//   ("campfire-firo-sell-data-v1"); PBKDF2 >= 600,000 rounds is still read for
//   a wallet whose secret is a chosen password (record.imported). Every
//   envelope field is bound as additional data. Nothing in the clear links
//   this Firo wallet to a payout address on another chain;
// * it lives under the wallet's own key, 'w:<id>:sell' (lib/wallet_scope.js
//   walletKey): deleting the wallet deletes it, and no other wallet reads it;
// * a wrong key (another password, another wallet) is refused outright:
//   nothing is read and nothing is written over;
// * a record this version cannot read is kept as it was and written back
//   unchanged; nothing is ever deleted by the app itself;
// * the whole list goes in one write of one key (IndexedDB puts are atomic),
//   and the store only says it has a record once that write succeeded;
// * that this wallet sent the FIRO is written down twice: when the payment
//   starts (sendStartedAt) and once it is broadcast (sentTxid), so a sell is
//   never offered for payment again after a payment may have left.
//
// Storage is an injected {get, set} (lib/store.js's rawStore in the app, a Map
// in tests). Only WebCrypto.

import { payoutChainName } from './sellfiro.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, b64, unb64 } from '../envelope.js';
import { walletKey } from '../wallet_scope.js';
import { t } from '../i18n.js';

export const SELL_DATA_INFO = 'campfire-firo-sell-data-v1';
/** The per-wallet name of the record ('w:<id>:sell'). */
export const SELL_RECORD_NAME = 'sell';
const VERSION = 1;
const KIND = 'sell-orders';
const KDF_HKDF = 'hkdf-sha256';
const KDF_PBKDF2 = 'pbkdf2-sha256';
const MAX_ITERATIONS = 20000000;

export class SellStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'locked' | 'missing' | 'wrong_secret' | 'malformed' | 'weak' | 'mismatch'
  }
}

/** Where the open wallet's sells are kept. */
export function sellRecordKey(app) {
  return walletKey(app, SELL_RECORD_NAME);
}

// ---------------------------------------------------------------- the record

const TEXT = ['orderId', 'walletId', 'depositAddress'];
const KINDS = ['spark', 'firo'];
const FROM = ['private', 'public'];

function bad(k) {
  throw new TypeError(t('sell: bad {k}', { k }));
}

/** A checked, frozen sell from its stored form. Throws on anything malformed. */
export function orderFromJson(j) {
  if (!j || typeof j !== 'object') throw new TypeError(t('sell: not a record'));
  for (const k of TEXT) if (typeof j[k] !== 'string' || !j[k]) bad(k);
  if (!KINDS.includes(j.depositKind)) bad('depositKind');
  if (!FROM.includes(j.payFrom)) bad('payFrom');
  if (typeof j.amount !== 'string' || !/^\d{1,30}$/.test(j.amount)) bad('amount');
  if (!Number.isFinite(j.createdAt)) bad('createdAt');
  const p = j.payout;
  if (!p || typeof p !== 'object' || !Number.isSafeInteger(p.chainId) || typeof p.token !== 'string' || typeof p.address !== 'string' || typeof p.symbol !== 'string') bad('payout');
  const optNum = (k) => (j[k] == null ? null : Number.isFinite(j[k]) ? j[k] : bad(k));
  const optText = (k) => (j[k] == null ? null : typeof j[k] === 'string' ? j[k] : bad(k));
  return makeOrder({
    orderId: j.orderId,
    walletId: j.walletId,
    amount: BigInt(j.amount),
    depositKind: j.depositKind,
    depositAddress: j.depositAddress,
    sparkDepositAddress: optText('sparkDepositAddress'),
    payFrom: j.payFrom,
    fellBack: j.fellBack === true,
    payout: { chainId: p.chainId, chainName: typeof p.chainName === 'string' ? p.chainName : null, token: p.token, symbol: p.symbol, address: p.address, own: p.own === true },
    createdAt: j.createdAt,
    receiveUsd: optNum('receiveUsd'),
    expiresAt: optNum('expiresAt'),
    lastState: optText('state'),
    terminal: j.terminal === true,
    payable: j.payable !== false,
    sandbox: j.sandbox === true,
    updatedAt: optNum('updatedAt'),
    receivedFiro: optNum('receivedFiro'),
    proceedsUsd: optNum('proceedsUsd'),
    payoutTxid: optText('payoutTxid'),
    payoutExplorer: optText('payoutExplorer'),
    sendStartedAt: optNum('sendStartedAt'),
    sentTxid: optText('sentTxid'),
    sentFrom: j.sentFrom == null ? null : FROM.includes(j.sentFrom) ? j.sentFrom : bad('sentFrom'),
    sentAt: optNum('sentAt'),
    unsureTxid: optText('unsureTxid'),
    unsureHeight: optNum('unsureHeight'),
    paidElsewhereAt: optNum('paidElsewhereAt'),
  });
}

/**
 * One sell. amount in satoshi (BigInt); receiveUsd what buyfiro.app said it
 * brings; times in ms since 1970. payout: {chainId, chainName, token, symbol,
 * address, own} (own: this wallet's Ethereum & BNB address).
 */
export function makeOrder(o) {
  const p = o.payout;
  return Object.freeze({
    orderId: o.orderId,
    walletId: o.walletId,
    amount: BigInt(o.amount),
    /** 'spark': buyfiro.app gave a private deposit address too; 'firo': a transparent one only. */
    depositKind: o.depositKind,
    depositAddress: o.depositAddress,
    sparkDepositAddress: o.sparkDepositAddress || null,
    /** The balance the person chose to pay from. */
    payFrom: o.payFrom,
    /** Spark deposits were off when it was made: the FIRO goes to a public address. */
    fellBack: Boolean(o.fellBack),
    payout: Object.freeze({ chainId: p.chainId, chainName: p.chainName || payoutChainName(p.chainId), token: p.token, symbol: p.symbol, address: p.address, own: Boolean(p.own) }),
    createdAt: o.createdAt,
    receiveUsd: o.receiveUsd ?? null,
    expiresAt: o.expiresAt ?? null,
    lastState: o.lastState ?? null,
    /** buyfiro.app will not change it again. */
    terminal: Boolean(o.terminal),
    /** False only for a test-mode order, which has nothing to pay. */
    payable: o.payable !== false,
    /** buyfiro.app's test mode. */
    sandbox: Boolean(o.sandbox),
    updatedAt: o.updatedAt ?? null,
    receivedFiro: o.receivedFiro ?? null,
    proceedsUsd: o.proceedsUsd ?? null,
    /** The payout transaction on its chain, and buyfiro.app's link to it. */
    payoutTxid: o.payoutTxid ?? null,
    payoutExplorer: o.payoutExplorer ?? null,
    /** This wallet started paying it (ms): a payment may have left. */
    sendStartedAt: o.sendStartedAt ?? null,
    /** This wallet's payment, once broadcast. */
    sentTxid: o.sentTxid ?? null,
    sentFrom: o.sentFrom ?? null,
    sentAt: o.sentAt ?? null,
    /**
     * This wallet's payment that may have left (the engine got no answer to its broadcast), and
     * the block height then: followed by the engine, never paid again until it lets it go.
     */
    unsureTxid: o.unsureTxid ?? null,
    unsureHeight: o.unsureHeight ?? null,
    /** The person said they paid it from another wallet (ms): never paid from this one. */
    paidElsewhereAt: o.paidElsewhereAt ?? null,
    isOpen: !o.terminal,
  });
}

export function orderToJson(o) {
  const j = {
    orderId: o.orderId,
    walletId: o.walletId,
    amount: o.amount.toString(),
    depositKind: o.depositKind,
    depositAddress: o.depositAddress,
    payFrom: o.payFrom,
    fellBack: o.fellBack,
    payout: { chainId: o.payout.chainId, chainName: o.payout.chainName, token: o.payout.token, symbol: o.payout.symbol, address: o.payout.address, own: o.payout.own },
    createdAt: o.createdAt,
    terminal: o.terminal,
    payable: o.payable,
    sandbox: o.sandbox,
  };
  for (const k of ['sparkDepositAddress', 'receiveUsd', 'expiresAt', 'updatedAt', 'receivedFiro', 'proceedsUsd', 'payoutTxid', 'payoutExplorer', 'sendStartedAt', 'sentTxid', 'sentFrom', 'sentAt', 'unsureTxid', 'unsureHeight', 'paidElsewhereAt']) if (o[k] != null) j[k] = o[k];
  if (o.lastState != null) j.state = o.lastState;
  return j;
}

/** The sell as status `s` (SellClient.status) says it is now, at `at` ms. */
export function withStatus(o, s, at) {
  return makeOrder({
    ...o,
    lastState: s.state,
    terminal: s.terminal,
    receivedFiro: s.receivedFiro ?? o.receivedFiro,
    proceedsUsd: s.proceedsUsd ?? o.proceedsUsd,
    payoutTxid: s.payoutTxid ?? o.payoutTxid,
    payoutExplorer: s.payoutExplorer ?? o.payoutExplorer,
    updatedAt: at,
  });
}

/** This wallet is about to pay it. */
export function withSending(o, at) {
  return makeOrder({ ...o, sendStartedAt: o.sendStartedAt ?? at });
}

/** This wallet paid it: the transaction, from which balance, when. */
export function withSent(o, { txid, from, at }) {
  return makeOrder({ ...o, sendStartedAt: o.sendStartedAt ?? at, sentTxid: txid, sentFrom: from, sentAt: at, unsureTxid: null, unsureHeight: null });
}

/** This wallet's payment `txid` may have left (no answer to its broadcast), from `from`, at block `height`. */
export function withUnsure(o, { txid, from, height, at }) {
  return makeOrder({ ...o, sendStartedAt: o.sendStartedAt ?? at, sentFrom: from, unsureTxid: txid, unsureHeight: Number.isSafeInteger(height) ? height : null });
}

/** The same sell as far as the person can see (nothing to write). */
export function sameAs(a, b) {
  return (
    a.orderId === b.orderId &&
    a.lastState === b.lastState &&
    a.terminal === b.terminal &&
    a.payoutTxid === b.payoutTxid &&
    a.payoutExplorer === b.payoutExplorer &&
    a.receivedFiro === b.receivedFiro &&
    a.proceedsUsd === b.proceedsUsd &&
    a.sendStartedAt === b.sendStartedAt &&
    a.sentTxid === b.sentTxid &&
    a.unsureTxid === b.unsureTxid &&
    a.paidElsewhereAt === b.paidElsewhereAt
  );
}

export function newestFirst(list) {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------- stores

/** A store that forgets on reload (tests). `writes` is every save, in order; failNext makes the next save throw. */
export function memorySellStore() {
  const byId = new Map();
  const writes = [];
  const s = {
    writes,
    failNext: 0,
    async all() {
      return newestFirst(byId.values());
    },
    async save(order) {
      if (s.failNext > 0) {
        s.failNext--;
        throw new Error(t('storage is full'));
      }
      byId.set(order.orderId, order);
      writes.push(order);
    },
  };
  return s;
}

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

// "walletId|kdf|salt|iterations" -> {dbPass, key}: a key is used only with the dbPass it came from.
const keys = new Map();

/** Drops every derived key (on lock). */
export function forgetSellKeys() {
  keys.clear();
}

function checkIterations(n) {
  if (!Number.isSafeInteger(n)) throw new SellStoreError('malformed', t('Bad PBKDF2 round count.'));
  if (n < PBKDF2_MIN_ITERATIONS) throw new SellStoreError('weak', t('Too few PBKDF2 rounds; refusing.'));
  if (n > MAX_ITERATIONS) throw new SellStoreError('malformed', t('Implausible PBKDF2 round count.'));
}

async function deriveKey(env, dbPass) {
  const id = [env.walletId, env.kdf, env.salt, env.iterations || 0].join('|');
  const hit = keys.get(id);
  if (hit && hit.dbPass === dbPass) return hit.key;
  const salt = unb64(env.salt);
  let key;
  if (env.kdf === KDF_HKDF) {
    if (!/^[0-9a-f]{64}$/.test(dbPass)) throw new SellStoreError('malformed', t("This wallet's secret is not a random one; it cannot use HKDF."));
    const ikm = Uint8Array.from(dbPass.match(/../g), (x) => parseInt(x, 16));
    try {
      const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
      key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(SELL_DATA_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally {
      ikm.fill(0);
    }
  } else {
    const pw = enc.encode(dbPass.normalize('NFC'));
    try {
      const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
      key = await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: env.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally {
      pw.fill(0);
    }
  }
  keys.set(id, { dbPass, key });
  return key;
}

function aad(env) {
  return enc.encode(JSON.stringify([env.v, env.kind, env.walletId, env.kdf, env.iterations || 0, env.salt, SELL_DATA_INFO]));
}

function sameShape(env) {
  return Boolean(env) && env.v === VERSION && env.kind === KIND && typeof env.walletId === 'string' && typeof env.salt === 'string' && typeof env.iv === 'string' && typeof env.ct === 'string';
}

/**
 * The sells of the unlocked wallet, sealed in `kv` under `key` (the wallet's
 * 'w:<id>:sell', fixed when the store is made: a write that lands after a
 * switch still goes to its own wallet, or is refused). all() → newest first;
 * save(order) replaces the one with its order id.
 */
export function sealedSellStore(app, { kv, key = sellRecordKey(app) }) {
  if (!app || !app.record || typeof app.record.id !== 'string') throw new SellStoreError('missing', t('There is no wallet on this device.'));
  const walletId = app.record.id;
  let unreadable = [];
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  function walletOf() {
    if (!app.record || app.record.id !== walletId) throw new SellStoreError('mismatch', t('Another wallet is open now.'));
    if (!app.dbPass) throw new SellStoreError('locked', t('Unlock the wallet first.'));
    return { walletId, imported: Boolean(app.record.imported), dbPass: app.dbPass };
  }

  async function open() {
    const w = walletOf();
    const env = await kv.get(key);
    if (env == null) return { w, env: null, orders: new Map() };
    if (!sameShape(env)) throw new SellStoreError('malformed', t('The saved sells are not in a form this version reads; they are kept as they are.'));
    if (env.walletId !== w.walletId) throw new SellStoreError('mismatch', t('The saved sells belong to another wallet.'));
    const want = w.imported ? KDF_PBKDF2 : KDF_HKDF;
    if (env.kdf !== want) throw new SellStoreError(want === KDF_PBKDF2 ? 'weak' : 'malformed', t('The saved sells use the wrong key derivation for this wallet; refusing them.'));
    if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
    else if (env.iterations !== undefined) throw new SellStoreError('malformed', t('Unexpected round count.'));
    let pt;
    try {
      pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, await deriveKey(env, w.dbPass), unb64(env.ct));
    } catch {
      throw new SellStoreError('wrong_secret', t('The saved sells did not open.'));
    }
    let body;
    try {
      body = JSON.parse(dec.decode(pt));
    } catch {
      throw new SellStoreError('malformed', t('The saved sells are damaged; they are kept as they are.'));
    }
    const orders = new Map();
    const skipped = [];
    for (const j of Array.isArray(body && body.orders) ? body.orders : []) {
      try {
        const o = orderFromJson(j);
        orders.set(o.orderId, o);
      } catch {
        skipped.push(j);
      }
    }
    unreadable = [...skipped, ...(Array.isArray(body && body.unreadable) ? body.unreadable : [])];
    return { w, env, orders };
  }

  return {
    async all() {
      const { orders } = await serial(open);
      return newestFirst(orders.values());
    },
    save(order) {
      return serial(async () => {
        const { w, env: prev, orders } = await open();
        orders.set(order.orderId, order);
        const kdf = w.imported ? KDF_PBKDF2 : KDF_HKDF;
        // The salt is kept, so a PBKDF2 wallet pays its rounds once per unlock, not on every write.
        const reuse = prev && prev.kdf === kdf;
        const env = { v: VERSION, kind: KIND, walletId: w.walletId, kdf, salt: reuse ? prev.salt : b64(randomBytes(16)) };
        if (kdf === KDF_PBKDF2) env.iterations = reuse ? prev.iterations : PBKDF2_MIN_ITERATIONS;
        const iv = randomBytes(12);
        const pt = enc.encode(JSON.stringify({ orders: newestFirst(orders.values()).map(orderToJson), unreadable }));
        const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, await deriveKey(env, w.dbPass), pt);
        await kv.set(key, { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
      });
    },
  };
}

/** Whether this device keeps any sell under `key` (one store read, nothing opened). */
export async function hasSells(kv, key) {
  return Boolean(await kv.get(key));
}
