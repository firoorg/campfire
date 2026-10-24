// Buys as this device remembers them, and where they are kept, sealed like
// the Ethereum wallet's data (lib/eth/sealed.js).
//
// The deposit address is a buy's only handle at buyfiro.app: with it alone,
// where the buy is can always be asked again, after a reload or on another
// day. A lost record is a deposit address the person can no longer look up,
// so:
//
// * the list is sealed with AES-256-GCM under a key from the wallet's random
//   secret (app.dbPass): HKDF-SHA256 with its own info string
//   ("campfire-firo-buy-data-v1"); PBKDF2 >= 600,000 rounds is still read for
//   a wallet whose secret is a chosen password (record.imported). Every
//   envelope field is bound as additional data. Nothing in the clear links
//   this Firo wallet to a refund address on another chain;
// * a wrong key (another password, another wallet) is refused outright:
//   nothing is read and nothing is written over;
// * a record this version cannot read is kept as it was and written back
//   unchanged; nothing is ever deleted by the app itself;
// * the whole list goes in one write of one key (IndexedDB puts are atomic),
//   and the store only says it has a record once that write succeeded.
//
// Storage is an injected {get, set} (lib/store.js's IndexedDB in the app, a
// Map in tests). Only WebCrypto: no Ethereum code is loaded for this.

import { chainName } from './buyfiro.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, b64, unb64 } from '../envelope.js';
import { t } from '../i18n.js';

export const BUY_DATA_INFO = 'campfire-firo-buy-data-v1';
export const BUY_RECORD_KEY = 'buy';
const VERSION = 1;
const KIND = 'buy-orders';
const KDF_HKDF = 'hkdf-sha256';
const KDF_PBKDF2 = 'pbkdf2-sha256';
const MAX_ITERATIONS = 20000000;

export class BuyStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'locked' | 'missing' | 'wrong_secret' | 'malformed' | 'weak' | 'mismatch'
  }
}

// ---------------------------------------------------------------- the record

const TEXT = ['depositAddress', 'assetId', 'symbol', 'chain', 'sendAmount', 'walletAddress', 'walletId', 'refundAddress'];

/** A checked, frozen buy from its stored form. Throws on anything malformed. */
export function orderFromJson(j) {
  if (!j || typeof j !== 'object') throw new TypeError(t('buy: not a record'));
  for (const k of TEXT) if (typeof j[k] !== 'string' || !j[k]) throw new TypeError(t('buy: bad {k}', { k }));
  if (!Number.isInteger(j.decimals) || j.decimals < 0 || j.decimals > 36) throw new TypeError(t('buy: bad decimals'));
  if (typeof j.sendAmountRaw !== 'string' || !/^\d{1,80}$/.test(j.sendAmountRaw)) throw new TypeError(t('buy: bad sendAmountRaw'));
  if (!Number.isFinite(j.createdAt)) throw new TypeError(t('buy: bad createdAt'));
  const optNum = (k) => (j[k] == null ? null : Number.isFinite(j[k]) ? j[k] : bad(k));
  const optText = (k) => (j[k] == null ? null : typeof j[k] === 'string' ? j[k] : bad(k));
  return makeOrder({
    depositAddress: j.depositAddress,
    assetId: j.assetId,
    symbol: j.symbol,
    chain: j.chain,
    contract: optText('contract'),
    decimals: j.decimals,
    sendAmount: j.sendAmount,
    sendAmountRaw: BigInt(j.sendAmountRaw),
    walletAddress: j.walletAddress,
    walletId: j.walletId,
    refundAddress: j.refundAddress,
    createdAt: j.createdAt,
    estimate: optNum('estimate'),
    deadline: optNum('deadline'),
    etaSeconds: optNum('etaSeconds'),
    lastState: optText('state'),
    txid: optText('txid'),
    terminal: j.terminal === true,
    sandbox: j.sandbox === true,
    updatedAt: optNum('updatedAt'),
  });
}

function bad(k) {
  throw new TypeError(t('buy: bad {k}', { k }));
}

/**
 * One buy. Amounts: sendAmount exactly as typed ("0.0122") and sendAmountRaw
 * in the coin's smallest unit; estimate the FIRO buyfiro.app said it buys;
 * times in ms since 1970.
 */
export function makeOrder(o) {
  return Object.freeze({
    depositAddress: o.depositAddress,
    assetId: o.assetId,
    symbol: o.symbol,
    /** The coin's chain id ("btc", "eth"…). */
    chain: o.chain,
    /** The token's contract on its chain; null for a chain's own coin (and for buys kept before it was). */
    contract: typeof o.contract === 'string' && o.contract ? o.contract : null,
    decimals: o.decimals,
    sendAmount: o.sendAmount,
    sendAmountRaw: BigInt(o.sendAmountRaw),
    /** The address of this wallet the FIRO goes to (Spark "sm1…", or transparent "a…"). */
    walletAddress: o.walletAddress,
    walletId: o.walletId,
    refundAddress: o.refundAddress,
    createdAt: o.createdAt,
    estimate: o.estimate ?? null,
    deadline: o.deadline ?? null,
    etaSeconds: o.etaSeconds ?? null,
    lastState: o.lastState ?? null,
    /** The FIRO transaction that delivered it. */
    txid: o.txid ?? null,
    /** buyfiro.app will not change it again. */
    terminal: Boolean(o.terminal),
    /** buyfiro.app's test mode: nothing to pay. */
    sandbox: Boolean(o.sandbox),
    updatedAt: o.updatedAt ?? null,
    chainName: chainName(o.chain),
    isOpen: !o.terminal,
  });
}

export function orderToJson(o) {
  const j = {
    depositAddress: o.depositAddress,
    assetId: o.assetId,
    symbol: o.symbol,
    chain: o.chain,
    decimals: o.decimals,
    sendAmount: o.sendAmount,
    sendAmountRaw: o.sendAmountRaw.toString(),
    walletAddress: o.walletAddress,
    walletId: o.walletId,
    refundAddress: o.refundAddress,
    createdAt: o.createdAt,
    terminal: o.terminal,
    sandbox: o.sandbox,
  };
  if (o.contract != null) j.contract = o.contract;
  if (o.estimate != null) j.estimate = o.estimate;
  if (o.deadline != null) j.deadline = o.deadline;
  if (o.etaSeconds != null) j.etaSeconds = o.etaSeconds;
  if (o.lastState != null) j.state = o.lastState;
  if (o.txid != null) j.txid = o.txid;
  if (o.updatedAt != null) j.updatedAt = o.updatedAt;
  return j;
}

/** The buy as status `s` (BuyClient.status) says it is now, at `at` ms. */
export function withStatus(o, s, at) {
  return makeOrder({
    ...o,
    estimate: s.estimate ?? o.estimate,
    deadline: s.deadline ?? o.deadline,
    lastState: s.state,
    txid: s.txid ?? o.txid,
    terminal: s.terminal,
    updatedAt: at,
  });
}

/** The same buy as far as the person can see (nothing to write). */
export function sameAs(a, b) {
  return a.depositAddress === b.depositAddress && a.lastState === b.lastState && a.txid === b.txid && a.terminal === b.terminal && a.deadline === b.deadline && a.estimate === b.estimate;
}

export function newestFirst(list) {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

// ---------------------------------------------------------------- stores

/** A store that forgets on reload (tests). `writes` is every save, in order; failNext makes the next save throw. */
export function memoryBuyStore() {
  const byAddress = new Map();
  const writes = [];
  const s = {
    writes,
    failNext: 0,
    async all() {
      return newestFirst(byAddress.values());
    },
    async save(order) {
      if (s.failNext > 0) {
        s.failNext--;
        throw new Error(t('storage is full'));
      }
      byAddress.set(order.depositAddress, order);
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
export function forgetBuyKeys() {
  keys.clear();
}

function walletOf(app) {
  if (!app || !app.record || typeof app.record.id !== 'string') throw new BuyStoreError('missing', t('There is no wallet on this device.'));
  if (!app.dbPass) throw new BuyStoreError('locked', t('Unlock the wallet first.'));
  return { walletId: app.record.id, imported: Boolean(app.record.imported), dbPass: app.dbPass };
}

function checkIterations(n) {
  if (!Number.isSafeInteger(n)) throw new BuyStoreError('malformed', t('Bad PBKDF2 round count.'));
  if (n < PBKDF2_MIN_ITERATIONS) throw new BuyStoreError('weak', t('Too few PBKDF2 rounds; refusing.'));
  if (n > MAX_ITERATIONS) throw new BuyStoreError('malformed', t('Implausible PBKDF2 round count.'));
}

async function deriveKey(env, dbPass) {
  const id = [env.walletId, env.kdf, env.salt, env.iterations || 0].join('|');
  const hit = keys.get(id);
  if (hit && hit.dbPass === dbPass) return hit.key;
  const salt = unb64(env.salt);
  let key;
  if (env.kdf === KDF_HKDF) {
    if (!/^[0-9a-f]{64}$/.test(dbPass)) throw new BuyStoreError('malformed', t("This wallet's secret is not a random one; it cannot use HKDF."));
    const ikm = Uint8Array.from(dbPass.match(/../g), (x) => parseInt(x, 16));
    try {
      const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
      key = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(BUY_DATA_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
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
  return enc.encode(JSON.stringify([env.v, env.kind, env.walletId, env.kdf, env.iterations || 0, env.salt, BUY_DATA_INFO]));
}

function sameShape(env) {
  return Boolean(env) && env.v === VERSION && env.kind === KIND && typeof env.walletId === 'string' && typeof env.salt === 'string' && typeof env.iv === 'string' && typeof env.ct === 'string';
}

/**
 * The buys of the unlocked wallet in `kv`, sealed. all() → newest first;
 * save(order) replaces the one with its deposit address.
 */
export function sealedBuyStore(app, { kv }) {
  let unreadable = [];
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  async function open() {
    const w = walletOf(app);
    const env = await kv.get(BUY_RECORD_KEY);
    if (env == null) return { w, env: null, orders: new Map() };
    if (!sameShape(env)) throw new BuyStoreError('malformed', t('The saved buys are not in a form this version reads; they are kept as they are.'));
    if (env.walletId !== w.walletId) throw new BuyStoreError('mismatch', t('The saved buys belong to another wallet.'));
    const want = w.imported ? KDF_PBKDF2 : KDF_HKDF;
    if (env.kdf !== want) throw new BuyStoreError(want === KDF_PBKDF2 ? 'weak' : 'malformed', t('The saved buys use the wrong key derivation for this wallet; refusing them.'));
    if (env.kdf === KDF_PBKDF2) checkIterations(env.iterations);
    else if (env.iterations !== undefined) throw new BuyStoreError('malformed', t('Unexpected round count.'));
    let pt;
    try {
      pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(env) }, await deriveKey(env, w.dbPass), unb64(env.ct));
    } catch {
      throw new BuyStoreError('wrong_secret', t('The saved buys did not open.'));
    }
    let body;
    try {
      body = JSON.parse(dec.decode(pt));
    } catch {
      throw new BuyStoreError('malformed', t('The saved buys are damaged; they are kept as they are.'));
    }
    const orders = new Map();
    const skipped = [];
    for (const j of Array.isArray(body && body.orders) ? body.orders : []) {
      try {
        const o = orderFromJson(j);
        orders.set(o.depositAddress, o);
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
        orders.set(order.depositAddress, order);
        const kdf = w.imported ? KDF_PBKDF2 : KDF_HKDF;
        // The salt is kept, so a PBKDF2 wallet pays its rounds once per unlock, not on every write.
        const reuse = prev && prev.kdf === kdf;
        const env = { v: VERSION, kind: KIND, walletId: w.walletId, kdf, salt: reuse ? prev.salt : b64(randomBytes(16)) };
        if (kdf === KDF_PBKDF2) env.iterations = reuse ? prev.iterations : PBKDF2_MIN_ITERATIONS;
        const iv = randomBytes(12);
        const pt = enc.encode(JSON.stringify({ orders: newestFirst(orders.values()).map(orderToJson), unreadable }));
        const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(env) }, await deriveKey(env, w.dbPass), pt);
        await kv.set(BUY_RECORD_KEY, { ...env, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
      });
    },
  };
}

/** Whether this device keeps any buy (one store read, nothing opened). */
export async function hasBuys(kv) {
  return Boolean(await kv.get(BUY_RECORD_KEY));
}
