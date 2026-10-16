// SPDX-License-Identifier: MIT
// The engine's per-wallet store, sealed (audit A-1). Without it, anyone who copied the browser
// profile (an infostealer, a backup, a forensic image) read every Spark coin, memo, private
// payment, address and transparent transaction of the wallet, with no password.
//
// Every value is AES-256-GCM under a key derived from the wallet's unlocked secret (app.dbPass:
// HKDF for the random secret every wallet has; PBKDF2 >= 600,000 rounds for a chosen one, as
// lib/eth/vault.js), with its own info string, so this key is never another key's key. The stored
// name and the wallet are bound as additional data (a value moved to another name, or another
// wallet's store, does not open). Values keep their types: BigInt and Uint8Array go through a
// tagged JSON.
//
// Key names that would name a transaction (the transparent wallet's w/t/tx/<txid>) are stored as
// w/t/tx/<HMAC(name)>; the real name travels inside the ciphertext, so keys() still answers real
// names. The Spark set cache is another database (public chain data) and is not sealed.
//
// A store written before this (plaintext values) is sealed in place the first time it is opened
// here (the header then says migrated). After that, a value in the clear is not the wallet's (audit
// FE-5: anyone who could write to the profile planted values that were believed with no key): it
// is treated as missing and removed. A header is made only for a store with no sealed value in it,
// never put over another one: a header of another version, or a missing header over sealed data,
// stops the store from opening instead of silently replacing the salt (and losing every value).

import { KDF_PBKDF2, kdfFor, deriveWrappingKey, checkIterations } from './kdf.js';
import { PBKDF2_MIN_ITERATIONS, randomBytes, b64, unb64 } from './envelope.js';

export const ENGINE_DATA_INFO = 'campfire-firo-engine-v1';
export const ENGINE_NAMES_INFO = 'campfire-firo-engine-names-v1';
const HEADER = '__seal';
const VERSION = 1;
/** Prefixes whose suffix names something private (a txid): stored under an HMAC of it. */
const HIDDEN_SUFFIX = ['w/t/tx/'];

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** JSON that keeps BigInt and Uint8Array. */
function toJson(v) {
  return JSON.stringify(v, (k, x) => {
    if (typeof x === 'bigint') return { $b: x.toString() };
    if (x instanceof Uint8Array) return { $u: b64(x) };
    return x;
  });
}
function fromJson(text) {
  return JSON.parse(text, (k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const keys = Object.keys(x);
      if (keys.length === 1 && keys[0] === '$b' && typeof x.$b === 'string') return BigInt(x.$b);
      if (keys.length === 1 && keys[0] === '$u' && typeof x.$u === 'string') return unb64(x.$u);
    }
    return x;
  });
}

const isSealed = (v) => Boolean(v) && typeof v === 'object' && v.$sealed === VERSION && typeof v.iv === 'string' && typeof v.ct === 'string';

/** A header this version can use: never replaced when it is not one (FE-5). */
const usableHeader = (h) => Boolean(h) && typeof h === 'object' && h.v === VERSION && typeof h.salt === 'string' && h.salt.length > 0 && typeof h.kdf === 'string';

function headerError() {
  return Object.assign(new Error("This wallet's data on this device was changed by something other than Campfire, so it was not opened. Your coins are on the blockchain: restoring the wallet from its recovery words brings them back."), { code: 'store-header' });
}

/** The HMAC key for names: HKDF of the same secret with its own info, or of the PBKDF2 output. */
async function namesKey(header, dbPass) {
  let ikm;
  if (header.kdf === KDF_PBKDF2) {
    const pw = await subtle().importKey('raw', enc.encode(dbPass), 'PBKDF2', false, ['deriveBits']);
    ikm = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(header.salt), iterations: header.iterations }, pw, 256));
  } else {
    if (!/^[0-9a-f]{64}$/.test(dbPass)) throw new Error("This wallet's secret is not a random one; it cannot use HKDF.");
    ikm = Uint8Array.from(dbPass.match(/../g).map((x) => parseInt(x, 16)));
  }
  try {
    const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(header.salt), info: enc.encode(ENGINE_NAMES_INFO) }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  } finally {
    ikm.fill(0);
  }
}

/**
 * raw: { get, put, del, keys(prefix) } (lib/wallet_store.js openWalletStore). -> the same
 * interface, sealed. dbPass: the unlocked wallet's secret; imported: whether a person chose it.
 */
export async function sealedStore(raw, { walletId, dbPass, imported = false }) {
  if (typeof walletId !== 'string' || !walletId) throw new Error('sealedStore needs the wallet id.');
  let header = await raw.get(HEADER);
  if (header === undefined || header === null) {
    // A new store, or one from before sealing: never one already holding sealed values.
    for (const k of await raw.keys('')) if (isSealed(await raw.get(k))) throw headerError();
    const kdf = kdfFor(imported);
    header = { v: VERSION, kdf, salt: b64(randomBytes(16)), ...(kdf === KDF_PBKDF2 ? { iterations: PBKDF2_MIN_ITERATIONS } : {}) };
    await raw.put(HEADER, header);
  } else if (!usableHeader(header)) {
    throw headerError();
  }
  if (header.kdf === KDF_PBKDF2) checkIterations(header.iterations);
  const dataKey = await deriveWrappingKey({ kdf: header.kdf, salt: header.salt, iterations: header.iterations }, dbPass, ENGINE_DATA_INFO);
  const macKey = await namesKey(header, dbPass);

  // The header itself is authenticated (public audit, PN-keys): one rewritten to say "not migrated"
  // had plaintext values planted beside it believed again (FE-5). Its tag is an HMAC under the
  // names key, which only the wallet's secret gives. A header from before tags: taken once, and
  // only when it says migrated (believing nothing in the clear) or the store holds no sealed value
  // (nothing to protect yet); tagged from then on.
  const headerTag = async (hd) => b64(new Uint8Array(await subtle().sign('HMAC', macKey, enc.encode(JSON.stringify([VERSION, walletId, hd.kdf, hd.salt, hd.iterations ?? 0, hd.migrated === true])))));
  const aad = (storedName) => enc.encode(JSON.stringify([VERSION, walletId, storedName]));
  if (typeof header.tag === 'string') {
    if (header.tag !== (await headerTag(header))) throw headerError();
  } else {
    let sealedOne = null;
    for (const k of await raw.keys('')) {
      if (k === HEADER) continue;
      const v = await raw.get(k);
      if (isSealed(v)) {
        sealedOne = [k, v];
        break;
      }
    }
    if (sealedOne) {
      // The secret opens what is sealed before the header is tagged under it (audit K4: a header
      // tagged under a wrong secret would lock the wallet out from then on).
      try {
        await subtle().decrypt({ name: 'AES-GCM', iv: unb64(sealedOne[1].iv), additionalData: aad(sealedOne[0]) }, dataKey, unb64(sealedOne[1].ct));
      } catch {
        throw headerError();
      }
      // Sealed values beside a header that does not say migrated: a first migration cut short
      // (0.1.7), or a header rewritten to say so (FE-5). Nothing in the clear is believed from here,
      // and what the chain holds comes back with the next sync (audit K4: it was refused, and the
      // person told to restore).
      if (header.migrated !== true) header = { ...header, migrated: true };
    }
    header = { ...header, tag: await headerTag(header) };
    await raw.put(HEADER, header);
  }

  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const hidden = (name) => HIDDEN_SUFFIX.find((p) => name.startsWith(p) && name.length > p.length) || null;
  /** The name a value is stored under. */
  async function stored(name) {
    const p = hidden(name);
    if (!p) return name;
    const mac = new Uint8Array(await subtle().sign('HMAC', macKey, enc.encode(`${walletId}|${name}`)));
    return `${p}${hex(mac)}`;
  }
  async function seal(name, value) {
    const at = await stored(name);
    const iv = randomBytes(12);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(at) }, dataKey, enc.encode(toJson({ n: name, v: value })));
    return { at, env: { $sealed: VERSION, iv: b64(iv), ct: b64(new Uint8Array(ct)) } };
  }
  async function open(at, env) {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: aad(at) }, dataKey, unb64(env.ct));
    return fromJson(dec.decode(pt));
  }

  const store = {
    name: raw.name,
    // Lets the database go (Lock, and Delete, which the browser blocks while it is open).
    async close() {
      if (typeof raw.close === 'function') await raw.close();
    },
    async get(name) {
      const at = await stored(name);
      const v = await raw.get(at);
      if (v === undefined || v === null) {
        // Written before the store was sealed, under its real name (only until it is migrated).
        if (at !== name && !header.migrated) {
          const old = await raw.get(name);
          if (old !== undefined && old !== null && !isSealed(old)) return old;
        }
        return v;
      }
      if (!isSealed(v)) {
        if (!header.migrated) return v; // plaintext from before; sealed on its next write
        await raw.del(at); // in the clear after sealing: not the wallet's (FE-5)
        return undefined;
      }
      return (await open(at, v)).v;
    },
    async put(name, value) {
      const { at, env } = await seal(name, value);
      await raw.put(at, env);
      if (at !== name) await raw.del(name); // a plaintext copy under the real name, if any
    },
    async del(name) {
      const at = await stored(name);
      await raw.del(at);
      if (at !== name) await raw.del(name);
    },
    async keys(prefix = '') {
      const out = new Set();
      for (const k of await raw.keys(prefix)) {
        if (k === HEADER) continue;
        const v = header.migrated || hidden(k) ? await raw.get(k) : null;
        if (header.migrated && !isSealed(v)) {
          await raw.del(k); // in the clear after sealing: not the wallet's (FE-5)
          continue;
        }
        if (!hidden(k)) {
          out.add(k);
          continue;
        }
        if (isSealed(v)) out.add((await open(k, v)).n);
        else out.add(k); // plaintext under its real name, from before
      }
      return [...out];
    },
  };

  // Seal what an older version left in the clear, once.
  if (!header.migrated) {
    for (const k of await raw.keys('')) {
      if (k === HEADER) continue;
      const v = await raw.get(k);
      if (v === undefined || v === null || isSealed(v)) continue;
      await store.put(k, v);
    }
    header = { ...header, migrated: true };
    header = { ...header, tag: await headerTag(header) };
    await raw.put(HEADER, header);
  }
  return store;
}
