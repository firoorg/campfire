// The address book (contacts: a name and a Firo address) and the address Receive
// shows, kept for ONE wallet in the app's IndexedDB (lib/store.js) under the key
// `w:<wallet id>:payments`, sealed, and deleted with the wallet (every key under
// its prefix goes with it).
//
// Why sealed: a contact is who you pay, which in a privacy wallet is nobody
// else's business, and an address that changes on its own sends the next payment
// to someone else. So the record is AES-256-GCM under a key from the wallet's
// random secret (app.dbPass) - HKDF-SHA256 (dbPass is 32 random bytes); the
// PBKDF2 path (at least 600,000 rounds) stays for a wallet whose secret is a
// chosen password, as lib/eth/vault.js has it - with every header field bound as
// additional data. Anything that edits the stored record makes it fail to open:
// the screens then say so and never write over it. Only the person changes a
// contact, from the Contacts screen, which shows the old and the new address
// before saving.
//
// A contact's address is any Firo address the engine can pay (lib/firo_uri.js
// shapes): a Spark address ("sm1…"), a transparent one ("a…"), an exchange
// address ("EX…"), or a Spark name ("@alice"), one address per contact, as the
// Campfire app's address book keeps them.

import { PBKDF2_MIN_ITERATIONS, randomBytes, toHex, b64, unb64 } from './envelope.js';
import { store as appStore } from './store.js';
import { prefixOf } from './wallet_scope.js';
import { addressShape, normalizeAddress } from './firo_uri.js';

export const PAYMENTS_DATA_INFO = 'campfire-firo-payments-v1';
export const KDF_HKDF = 'hkdf-sha256';
export const KDF_PBKDF2 = 'pbkdf2-sha256';
const VERSION = 1;
const KIND = 'campfire-firo-payments';
const MAX_ITERATIONS = 20000000;

export const NAME_MAX = 40;
export const ADDRESS_MAX = 256;
export const CONTACTS_MAX = 500;

/** The store key of a wallet's record. */
// 'w:<id>:payments' (lib/wallet_scope.js walletKey): deleting the wallet removes it with every key under its prefix.
export const paymentsKey = (walletId) => `${prefixOf(walletId)}payments`;

export class ContactsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'locked' | 'missing' | 'wrong_secret' | 'malformed' | 'weak' | 'invalid' | 'duplicate' | 'full' | 'gone'
  }
}

// ---------------------------------------------------------------- rules (pure)

/** A name as it is kept: printable, single spaces, at most NAME_MAX characters. */
export function cleanName(raw) {
  const s = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, NAME_MAX).join('');
}

/** An address as it is kept: no spaces or line breaks (a paste split across lines), a Spark address in lower case. */
export function cleanAddress(raw) {
  return normalizeAddress(String(raw ?? '').replace(/\s+/g, ''));
}

/** The shape of a Firo address or a Spark name (lib/firo_uri.js); the engine checks the rest. */
export function looksLikeAddress(a) {
  return typeof a === 'string' && a.length <= ADDRESS_MAX && addressShape(a) !== null;
}

const sameAddress = (a, b) => cleanAddress(a) === cleanAddress(b);

/** The saved contact with exactly this address, or null. */
export function findByAddress(list, address) {
  const a = cleanAddress(address);
  if (!a) return null;
  return (list || []).find((c) => sameAddress(c.address, a)) || null;
}

/**
 * A saved contact whose address starts and ends like this one but is not it: the
 * trick of planting a look-alike address in someone's history. Null when the
 * address is a contact's own, or nothing looks like it.
 */
export function lookalikeOf(list, address, edge = 6) {
  const a = cleanAddress(address);
  if (a.length < edge * 2 + 4 || findByAddress(list, a)) return null;
  const head = a.slice(0, edge);
  const tail = a.slice(-edge);
  return (list || []).find((c) => c.address !== a && c.address.slice(0, edge) === head && c.address.slice(-edge) === tail) || null;
}

/** Contacts in the order the list shows them: by name, then by address. */
export function sortContacts(list) {
  return [...(list || [])].sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }) || x.address.localeCompare(y.address));
}

/** Contacts whose name or address contains q (case-insensitive). */
export function searchContacts(list, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return sortContacts(list);
  return sortContacts((list || []).filter((c) => c.name.toLowerCase().includes(s) || c.address.toLowerCase().includes(s)));
}

/**
 * Whether {name, address} may be saved next to `list` (editing `editingId`, if
 * any). The engine's own check (classifyAddress: a real address) comes on top,
 * in the screen.
 */
export function checkContact({ name, address }, list, { editingId = null } = {}) {
  const n = cleanName(name);
  const a = cleanAddress(address);
  if (!n) return { ok: false, code: 'invalid', field: 'name', problem: 'Give the contact a name.' };
  if (!a) return { ok: false, code: 'invalid', field: 'address', problem: 'Paste or scan their Firo address, or type their Spark name like @alice.' };
  if (!looksLikeAddress(a)) return { ok: false, code: 'invalid', field: 'address', problem: "This isn't a Firo address or a Spark name. Copy it again from the person." };
  const dup = (list || []).find((c) => c.id !== editingId && sameAddress(c.address, a));
  if (dup) return { ok: false, code: 'duplicate', field: 'address', problem: `This address is already saved as ${dup.name}.`, contact: dup };
  const others = (list || []).filter((c) => c.id !== editingId);
  if (!editingId && others.length >= CONTACTS_MAX) return { ok: false, code: 'full', field: 'name', problem: `The address book holds ${CONTACTS_MAX} contacts. Delete one to add another.` };
  return { ok: true, name: n, address: a };
}

function validStored(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && /^[0-9a-f]{16}$/.test(c.id) && typeof c.name === 'string' && cleanName(c.name) === c.name && c.name && looksLikeAddress(c.address);
}

// ---------------------------------------------------------------- sealing

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function header(h) {
  return { v: h.v, kind: h.kind, walletId: h.walletId, kdf: h.kdf, ...(h.iterations !== undefined ? { iterations: h.iterations } : {}), salt: h.salt };
}
const aad = (h) => enc.encode(JSON.stringify([h.v, h.kind, h.walletId, h.kdf, h.iterations || 0, h.salt]));

function checkIterations(n) {
  if (!Number.isSafeInteger(n)) throw new ContactsError('malformed', 'Bad round count.');
  if (n < PBKDF2_MIN_ITERATIONS) throw new ContactsError('weak', 'Too few rounds; refusing.');
  if (n > MAX_ITERATIONS) throw new ContactsError('malformed', 'Implausible round count.');
}

async function deriveKey(h, dbPass) {
  if (typeof dbPass !== 'string' || !dbPass) throw new ContactsError('locked', 'Unlock the wallet first.');
  const salt = unb64(h.salt);
  if (h.kdf === KDF_HKDF) {
    if (!/^[0-9a-f]{64}$/.test(dbPass)) throw new ContactsError('malformed', "This wallet's key is not a random one.");
    const ikm = new Uint8Array(dbPass.match(/../g).map((x) => parseInt(x, 16)));
    try {
      const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
      return await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(PAYMENTS_DATA_INFO) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally {
      ikm.fill(0);
    }
  }
  if (h.kdf !== KDF_PBKDF2) throw new ContactsError('malformed', 'Unknown key derivation.');
  checkIterations(h.iterations);
  const pw = enc.encode(dbPass.normalize('NFC'));
  try {
    const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveKey']);
    return await subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: h.iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally {
    pw.fill(0);
  }
}

/**
 * One wallet's payments record: {contacts: [{id, name, address, createdAt, updatedAt}],
 * receive: the address Receive shows, or null}. kv is {get, set} (lib/store.js in
 * the app, a Map in tests). One write at a time, in order.
 */
export class PaymentsVault {
  #key = null;
  #header = null;
  #data = null;
  #loading = null;
  #queue = Promise.resolve();

  constructor({ kv, walletId, imported, dbPass, iterations = PBKDF2_MIN_ITERATIONS }) {
    if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function') throw new TypeError('PaymentsVault needs a {get, set} storage');
    if (typeof walletId !== 'string' || !walletId) throw new ContactsError('missing', 'There is no wallet on this device.');
    if (typeof dbPass !== 'string' || !dbPass) throw new ContactsError('locked', 'Unlock the wallet first.');
    this.kv = kv;
    this.walletId = walletId;
    this.kdf = imported ? KDF_PBKDF2 : KDF_HKDF;
    this.dbPass = dbPass;
    this.iterations = iterations;
    this.key = paymentsKey(walletId);
  }

  #load() {
    if (!this.#loading) {
      this.#loading = this.#read().catch((e) => {
        this.#loading = null;
        throw e;
      });
    }
    return this.#loading;
  }

  async #read() {
    const env = await this.kv.get(this.key);
    if (env === undefined || env === null) {
      const h = { v: VERSION, kind: KIND, walletId: this.walletId, kdf: this.kdf, salt: b64(randomBytes(16)) };
      if (this.kdf === KDF_PBKDF2) h.iterations = this.iterations;
      this.#key = await deriveKey(h, this.dbPass);
      this.#header = h;
      this.#data = { contacts: [], receive: null };
      return;
    }
    if (!env || typeof env !== 'object' || env.v !== VERSION || env.kind !== KIND || typeof env.salt !== 'string' || typeof env.iv !== 'string' || typeof env.ct !== 'string') {
      throw new ContactsError('malformed', 'The address book on this device is not readable by this version.');
    }
    if (env.walletId !== this.walletId) throw new ContactsError('wrong_secret', 'This address book belongs to another wallet.');
    if (env.kdf !== this.kdf) throw new ContactsError(this.kdf === KDF_PBKDF2 ? 'weak' : 'malformed', 'The address book uses the wrong key for this wallet; it was not opened.');
    if (this.kdf !== KDF_PBKDF2 && env.iterations !== undefined) throw new ContactsError('malformed', 'Unexpected round count.');
    const h = header(env);
    const key = await deriveKey(h, this.dbPass);
    let parsed;
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(h) }, key, unb64(env.ct));
      parsed = JSON.parse(dec.decode(pt));
    } catch {
      throw new ContactsError('wrong_secret', 'The address book on this device did not open with this wallet. It was left as it is.');
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.contacts)) throw new ContactsError('malformed', 'The address book on this device is damaged. It was left as it is.');
    this.#key = key;
    this.#header = h;
    this.#data = {
      contacts: parsed.contacts.filter(validStored).map((c) => ({ id: c.id, name: c.name, address: c.address, createdAt: Number(c.createdAt) || 0, updatedAt: Number(c.updatedAt) || 0 })),
      receive: typeof parsed.receive === 'string' && looksLikeAddress(parsed.receive) ? parsed.receive : null,
    };
  }

  async #write(next) {
    const iv = randomBytes(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(this.#header) }, this.#key, enc.encode(JSON.stringify(next)));
    await this.kv.set(this.key, { ...this.#header, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
    this.#data = next;
  }

  #change(fn) {
    const done = this.#queue.then(async () => {
      await this.#load();
      const cur = { contacts: this.#data.contacts.map((c) => ({ ...c })), receive: this.#data.receive };
      const r = await fn(cur);
      await this.#write(cur);
      return r;
    });
    this.#queue = done.catch(() => {});
    return done;
  }

  /** Every contact, sorted by name. */
  async contacts() {
    await this.#load();
    return sortContacts(this.#data.contacts.map((c) => ({ ...c })));
  }

  async add({ name, address }, now = Date.now()) {
    return this.#change((d) => {
      const r = checkContact({ name, address }, d.contacts);
      if (!r.ok) throw new ContactsError(r.code, r.problem);
      const c = { id: toHex(randomBytes(8)), name: r.name, address: r.address, createdAt: now, updatedAt: now };
      d.contacts.push(c);
      return { ...c };
    });
  }

  async update(id, { name, address }, now = Date.now()) {
    return this.#change((d) => {
      const c = d.contacts.find((x) => x.id === id);
      if (!c) throw new ContactsError('gone', 'This contact is no longer in the address book.');
      const r = checkContact({ name, address }, d.contacts, { editingId: id });
      if (!r.ok) throw new ContactsError(r.code, r.problem);
      c.name = r.name;
      c.address = r.address;
      c.updatedAt = now;
      return { ...c };
    });
  }

  async remove(id) {
    return this.#change((d) => {
      const before = d.contacts.length;
      d.contacts = d.contacts.filter((x) => x.id !== id);
      return d.contacts.length < before;
    });
  }

  /** The address Receive shows (one of this wallet's own), or null for "the newest". */
  async receiveAddress() {
    await this.#load();
    return this.#data.receive;
  }

  async setReceiveAddress(address) {
    const a = address == null ? null : cleanAddress(address);
    if (a !== null && !looksLikeAddress(a)) throw new ContactsError('invalid', 'Not an address.');
    return this.#change((d) => {
      d.receive = a;
      return a;
    });
  }
}

// ---------------------------------------------------------------- the open wallet

let current = null; // {walletId, dbPass, vault}
let cache = null; // the last contacts read, for lists that render synchronously
const cacheListeners = new Set();

/**
 * The vault of the unlocked wallet in `app` ({record: {id}, dbPass}), one per
 * unlock, so the key is derived once. kv defaults to the app's store; a lock hook
 * forgets it.
 */
export async function vaultFor(app, kv = null) {
  if (!app || !app.record || typeof app.record.id !== 'string') throw new ContactsError('missing', 'There is no wallet on this device.');
  if (!app.dbPass) throw new ContactsError('locked', 'Unlock the wallet first.');
  if (current && current.walletId === app.record.id && current.dbPass === app.dbPass) return current.vault;
  const vault = new PaymentsVault({ kv: kv || appStore, walletId: app.record.id, imported: Boolean(app.record.imported), dbPass: app.dbPass });
  current = { walletId: app.record.id, dbPass: app.dbPass, vault };
  if (app.lockHooks && !app.lockHooks.has(forget)) app.lockHooks.add(forget);
  return vault;
}

/** Forgets the open vault and the cached contacts (on lock). */
export function forget() {
  current = null;
  cache = null;
}

/** The contacts, read once per unlock and kept for synchronous lists; null until read or when unreadable. */
export async function loadContacts(app) {
  try {
    const v = await vaultFor(app);
    cache = await v.contacts();
  } catch (e) {
    cache = null;
    throw e;
  }
  for (const fn of cacheListeners) fn(cache);
  return cache;
}

export function cachedContacts() {
  return cache;
}

export function onContactsChange(fn) {
  cacheListeners.add(fn);
  return () => cacheListeners.delete(fn);
}

/** The saved name for an address from the cache, or null. */
export function contactNameFor(address) {
  const c = cache ? findByAddress(cache, address) : null;
  return c ? c.name : null;
}
