// The Firo engine behind the screens: WALLET_API.md's contract.
//
//   createBackend({network, servers, store, spark}) → Backend
//
// Transparent: keys.js + transparent.js over electrum.js. Spark: the public
// data from spark_sync.js, the cryptography from the injected `spark` client
// (spark_iface.js lists what it must offer); without one, Spark is simply
// off and every Spark action throws code 'NotYet'.
//
// Errors carry .code: 'offline' | 'insufficient' | 'invalid-address' | 'dust'
// | 'not-synced' | 'server' | 'NotYet' (and 'invalid-mnemonic',
// 'invalid-amount' for bad input); .message is plain English.
//
// A payment (send, privatize, a name, broadcastTx) is written down, signed, with the coins it
// spends, BEFORE it is broadcast (audit FM-1). Then:
//   resolves {txid}       the node answered with its txid;
//   'server'              the node answered with an error and no other node has it: it was not
//                         accepted, and it is forgotten (its coins are free again);
//   'offline'             it never reached a node (no connection): forgotten, nothing left;
//   'storage' | 'not-open' it could not be written down (the device's storage failed, or the
//                         wallet was locked meanwhile): not kept, not sent (release re-audit R-2);
//   'in-flight'           another payment was still being sent: refused before anything was
//                         built, nothing left (one at a time, release verification 0.1.8);
//   'unsure' + .txid      no answer after it reached a node (the connection dropped, no answer in
//                         time): it may have left. It stays recorded, its coins stay spent, and the
//                         engine follows it: sent again after 2 blocks, and after 6 given up on
//                         only when the nodes say they do not have it (Tx.dropped), or let go by
//                         the person on the node in use's word alone (Tx.oneNode, letGo()). Until
//                         then the same payment must not be offered again.
// Tx entries may carry: unsure (a payment of ours not seen on the network yet, from the moment it
// is written down until the node answers, and after a broadcast with no answer), dropped (one the
// network does not have: it did not go through, nothing left; letGo with it: the person let it go
// on the node in use's word, letGo()), oneNode (one the node in use says it never received, with
// no second node to ask for an hour: offered to let go, never decided here), unproven (a payment
// to us in a block, says the node, not proven yet: not spendable).
//
// Beyond WALLET_API, for callers that pick coins themselves and check what
// they sign before it goes out (the Rosen stream, coin control):
//
//   buildTransparentTx({inputs: ['txid:vout', …],
//                       outputs: [{address, amount} | {opReturn: '<hex data>'}],
//                       feePerKb?, changeAddress?, subtractFee = false})
//     → {hex, txid, fee, size, inputs: [{txid, vout, value, address}],
//        outputs: [{address, value, script, change?, opReturn?}]}      (strings; nothing is sent)
//     Spends exactly the chosen public coins, every one of them; an OP_RETURN
//     output is `6a <push> <data>` with value 0 (38 bytes → 6a 26 …).
//   broadcastTx(hex) → {txid}
//   paymentsTo({to, from?, minHeight?}) → [{txid, height, value, fromMatches}]
//
// Privacy choices (research §3.6):
//   - Spark sync downloads the same data for everyone and never asks about
//     our own coins. So Spark history knows a coin's block only roughly (the
//     tip when it was found: `heightApprox`), and coins found while restoring
//     have no date (time null) — unless the wallet is created with
//     sparkTxDetails: 'decoy', which fetches each own transaction together
//     with 7 random others from the same anonymity set.
//   - Spark names are resolved from the full list, never by asking for one.
//   - The anonymity sets a private payment uses are checked first (audit D-09): each set's hash
//     recomputed from its coins (spark_sethash.js) and confirmed by a second server. The newest
//     set is checked in the background by every wallet alike; older ones only at payment time,
//     when the payment itself names them.

import { network as getNetwork, sparkSpendTxVersion, SPARK_CHANGE_DIVERSIFIER, SPARK_KEY_INDEX, isValidSparkName } from './params.js';
import { FiroKeys, generateMnemonic, validateMnemonic, wipe } from './keys.js';
import { classifyAddress as classify, addressToScript, isSparkAddressShape, scriptToAddress } from './address.js';
import { ElectrumClient, ElectrumError } from './electrum.js';
import { TransparentWallet, TransparentError, planExplicit, paymentsTo, CONFLICT_KEEP_MS, MN_COLLATERAL } from './transparent.js';
import { SparkSync, coinBody, decodeSetEntry, TAG_OVERLAP } from './spark_sync.js';
import { extendSetHash, SetHashError } from './spark_sethash.js';
import { prefixStore } from './store.js';
import { transparentEntries, sparkEntries, mergeEntries, PROVEN } from './history.js';
import { serializeTx, decodeTx, SEQUENCE_FINAL, TxError, proRegCollateral, lTagHash } from './tx.js';
import { opReturnScript, OP, sparkNameFeeScript } from './script.js';
import { hexToBytes, bytesToHex, sha256d, base64ToBytes, bytesToBase64, concatBytes, hashToHex, hashFromHex } from './bytes.js';
import { requireSpark, sparkHas } from './spark_iface.js';

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** A payment asked for while another is still being sent: refused, nothing built (lib/send_outcome.js NOT_SENT_CODES). */
/** No payment's network fee above this, whatever a fee rate or the coins spent make of it: 0.05 FIRO (public audit, PN). */
export const MAX_PAYMENT_FEE = 5000000n;
/** Satoshi as FIRO, for a refusal's words. */
const formatSats = (sats) => (Number(BigInt(sats)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });

const inFlightRefusal = () => err('in-flight', 'Another payment from this wallet is still being sent, so this one was not sent. Nothing left your wallet: try again once that one has left.');

/** A payment that may have left (audit FM-1), in the screens' words. */
export const UNSURE_WORDS = "Your payment may have left. Don't send it again yet: Campfire is checking.";

/** A node's answer that it has no such transaction, in its mempool or chain (a positive "not there"). */
const NO_SUCH_TX = /no such (mempool|blockchain)/i;
/** A private coin of a spend let go of while it may be on the network: free again, and spent first (X3, P7). */
function freeAsConflict(c) {
  delete c.pendingSpentTxid;
  c.conflictAt = Date.now();
}
/** What a private spend is planned with over its amount, for its fee, when a conflict coin is in (X3, P7). */
const SPARK_FEE_MARGIN = 100000n; // 0.001 FIRO: Spark fees are a few hundredths of that
/** Blocks the node in use may be ahead of a second node before it is taken to disagree (P7). */
const TIP_LEAD_DISAGREE = 10;
/** Confirmations after which one of our payments with nothing of ours to prove it by is settled (X6). */
const SETTLE_DEPTH = 6;
// An error answer to a broadcast that says the network already has it: it left (FM-1). A node's words for "I have it already" (Firo Core: txn-already-in-mempool, txn-already-known,
// transaction already in block chain; ElectrumX passes them on): it left (audit of 0.1.8, X3).
const ALREADY_TX = /(txn[- ])?already[- ](in[- ]mempool|known|in[- ]block ?chain|have transaction)|txn-already-(in-mempool|known)/i;

/**
 * After a node's error answer to a broadcast, how long before another node is asked whether it has
 * the payment anyway (release re-audit R-5): the bytes take a moment to travel between nodes.
 */
const RELAY_LOOK_MS = 3000;
/**
 * A payment of ours the node in use says it does not have, with no second node to ask: once no
 * second node could be reached for this long, the person is offered to let it go on the node in
 * use's word (Tx.oneNode; letGo). Release re-audit R-6 gave it up automatically here; re-audit 3
 * RE3-3: a lying node in use with the others blocked for an hour then freed the coins of a payment
 * that had gone through (the attack R1-3 is fixed against), so only the person's tap decides, told
 * that it is one node's word. With the person's own node, its word decides alone, as always.
 */
const ONE_NODE_AFTER_S = 3600;
/**
 * A second opinion (_secondOpinion): how long the other nodes may take to open. They are opened
 * together, each with all of it (release re-audit 3 RE3-2: one at a time, a node that never opened
 * used up the 8 s before a healthy one was tried; re-audit 4 RE4-1: the 2.5 s each was then given
 * failed every second opinion on a slow link, where an honest node needs 3 s to open).
 */
const SECOND_WAIT_MS = 8000;
/**
 * A second opinion goes to the first node, in the question's rotating order, of those open (RE3-2):
 * once one node has opened, the nodes ahead of it in that order are waited for this long (re-audit 5
 * RE5-2: asking the first to open let one node faster than the rest answer every second opinion).
 * Cost: a node that never opens and is ahead in the order delays an answer by at most this.
 */
const SECOND_GRACE_MS = 1500;
// …growing with a slow first open (twice its time), up to this (re-audit 6 RE6-1).
const SECOND_GRACE_MAX_MS = 3000;
/** A second opinion that could not be had: the tip is asked about again this soon (not every 300 s). */
const NO_SECOND_RETRY_S = 30;
/** A second node that could not be asked at all (as opposed to one that answered). */
const unreachable = (e) => Boolean(e && (e.code === 'offline' || e.code === 'closed' || e.code === 'timeout'));
/** The tip check (D-11) found no second node to ask: 'unknown' with no other height. */
const noSecond = (sc) => Boolean(sc && sc.state === 'unknown' && sc.otherHeight == null);

function notYet(what) {
  return err('NotYet', `${what} is not available yet.`);
}

/** Satoshi string → BigInt > 0; throws 'invalid-amount'. */
function parseAmount(v) {
  if (typeof v === 'bigint') {
    if (v <= 0n) throw err('invalid-amount', 'The amount must be more than zero.');
    return v;
  }
  if (typeof v !== 'string' || !/^\d{1,16}$/.test(v)) throw err('invalid-amount', 'The amount is not a number of satoshi.');
  const n = BigInt(v);
  if (n <= 0n) throw err('invalid-amount', 'The amount must be more than zero.');
  return n;
}

/** Converts this module's internal errors to WALLET_API codes. */
function apiError(e) {
  if (e instanceof ElectrumError) {
    if (e.code === 'offline' || e.code === 'closed' || e.code === 'timeout') return err('offline', 'No connection to the Firo nodes. Check the internet connection and try again.');
    return err('server', `The server refused: ${e.message}`);
  }
  if (e instanceof TransparentError || e instanceof TxError) {
    if (e.code === 'insufficient') return Object.assign(err('insufficient', e.message), { needed: e.needed, available: e.available });
    if (e.code === 'dust') return err('dust', e.message);
  }
  return e;
}

/** A FiroPoW header's time (offset 68), or null. */
function headerTime(hex) {
  if (typeof hex !== 'string' || hex.length < 160) return null;
  const b = hexToBytes(hex.slice(136, 144));
  return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] * 0x1000000);
}

const now = () => Math.floor(Date.now() / 1000);

/** The Merkle root a branch proves for `txid` (display hex) at `pos`, in header byte order. */
export function merkleRootOf(txid, branch, pos) {
  let h = hexToBytes(txid).reverse();
  let p = pos;
  for (const b of branch) {
    const s = hexToBytes(b).reverse();
    h = p & 1 ? sha256d(concatBytes(s, h)) : sha256d(concatBytes(h, s));
    p >>>= 1;
  }
  return h;
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Review's words when a private payment cannot be made to conflict with one let go of (P7, X3). */
const CONFLICT_WARNING = "A private payment from earlier that showed as not sent may still go through, and this one can't be made from the same coins. If this is that payment again, check Activity first: both could go through.";

/** A private coin of this wallet's, as its set lists it (spark_sync coinBody), or null. */
function ownBody(c) {
  if (!(c.coin instanceof Uint8Array) || typeof c.txid !== 'string') return null;
  try {
    return coinBody({ coin: c.coin, txHash: hashFromHex(c.txid), context: c.context instanceof Uint8Array ? c.context : new Uint8Array(0) });
  } catch {
    return null;
  }
}

/**
 * The private coins the Spark library spends for `required` from `coins`, as it picks them
 * (sparkmobile GetCoinsToSpend): sorted largest first, older first on a tie; while the rest is at
 * least the largest coin, that coin; else the smallest coin that covers the rest.
 */
export function sparkPick(coins, required) {
  const list = coins.slice().sort((a, b) => (a.value !== b.value ? (a.value > b.value ? -1 : 1) : (a.height ?? 0) - (b.height ?? 0)));
  const out = [];
  let sum = 0n;
  while (sum < required && list.length) {
    const need = required - sum;
    let i = 0;
    if (need < list[0].value) {
      for (let j = list.length - 1; j >= 0; j--) {
        if (list[j].value >= need && (j === 0 || list[j - 1].value !== list[j].value)) {
          i = j;
          break;
        }
      }
    }
    sum += list[i].value;
    out.push(list.splice(i, 1)[0]);
  }
  return out;
}

/** Whether `needle` is somewhere in `hay`. */
function hasBytes(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  const first = needle[0];
  for (let i = hay.indexOf(first); i !== -1 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
}
/**
 * Blocks read per sync while recomputing, in the background, the newest set's hash (audit D-09).
 * A group's first check reads every block it spans (17,350 for the newest group on 2026-10-12:
 * 4.6 MB), later ones only the blocks since.
 */
const VERIFY_HEIGHTS_PER_SYNC = 6000;
/** Blocks of a set checked in one part, before what is done is kept (N5). */
const VERIFY_HEIGHTS_PER_PART = 2000;
/** How long one sync spends at most on checking sets for coins received (N9): about 48,000 blocks. */
const PROVE_MS_PER_SYNC = 60000;

/**
 * Used tags compared with a second server every 300 s (audit D-12), from where the two last
 * agreed. Measured 2026-10-12: a wallet's last range (30 tags) is 3 KB in 0.15-0.3 s; a new
 * wallet's whole range (from the checkpoint, 102 tags) 10 KB; a restore's whole list (240,102
 * tags) 24 MB in 9 s, once: the list can only be asked for from a position to its end, and a
 * restore is where tags left out do harm.
 */
const TAG_CHECK_EVERY = 300;

/** Why a private payment was stopped over its coin lists (audit D-09), in the person's words. */
const SET_WORDS = Object.freeze({
  'set-mismatch': "This Firo node's list of private coins does not add up, so the payment was stopped to keep it private.",
  'set-disagree': 'Two Firo nodes gave different lists of private coins, so the payment was stopped to keep it private.',
  'set-unchecked': 'The list of private coins could not be checked with the network yet. Try again in a minute.',
});

/**
 * A payment to us is proven at its first confirmation (audit FE-1: with 2, it counted and was spent
 * at 1 on the node's word alone). A header that differs from the second node's at the tip itself
 * may be a fork race: tried again at the next sync, not failed.
 */
const PROVE_AT = 1;
/** A proof that failed is tried again this many blocks later (a reorg, a server catching up). */
const PROVE_RETRY = 6;

/**
 * What this engine keeps in the wallet's store (WALLET_API `store`). Its own
 * layout, inside a store the app has already scoped to one wallet:
 *   w/t/…      the public side (transparent.js)
 *   cache/…    the Spark sets and tags (spark_sync.js), unless a sharedStore is given
 *   and these:
 */
const KEY = Object.freeze({
  progress: 's/progress', // Spark: groups identified up to, tags checked up to, first group, new/restore
  coins: 's/coins', // Spark: our coins (values as strings)
  sends: 's/sends', // Spark: payments this wallet made (amount, fee, to, memo, time)
  sparkAddr: 's/addr', // Spark: the diversifier handed out last
  labels: 'labels', // coin labels
  spendInfo: 's/spend-info', // Spark: our spends' block, date, fee, name (asked among decoys, opt-in)
  anchors: 's/anchors', // Spark: blocks of the coins at fixed positions of each set (restores)
  anewAt: 's/anew-at', // Spark: where a look at a set downloaded anew stopped: g -> {gen, upTo} (r9)
  namePins: 's/name-pins', // Spark names this wallet paid: NAME -> the address it paid (audit D-02)
  decoySalt: 's/decoy-salt', // a secret of this wallet that picks the "Exact dates" decoys (audit D-07)
  decoys: 's/decoys', // txid -> the seven decoys it was first asked among, kept (audit FE-6)
});

/** Coins at fixed positions of a set whose blocks place restored coins: every 1/16 of it. */
export const ANCHOR_STEPS = 16;

/** The positions asked about in a set of `size` coins: the same for every wallet. */
export function anchorPositions(size) {
  if (!(size > 0)) return [];
  const out = new Set();
  for (let k = 0; k <= ANCHOR_STEPS; k++) out.add(Math.round((k * (size - 1)) / ANCHOR_STEPS));
  return [...out].sort((a, b) => a - b);
}

/** A coin's block from its position, between the anchors around it: points [[index, height]], sorted. */
export function placeByAnchors(points, index) {
  if (!points || !points.length) return null;
  if (index <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (index >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [i1, h1] = points[i];
    if (index <= i1) {
      const [i0, h0] = points[i - 1];
      return i1 === i0 ? h1 : Math.round(h0 + ((h1 - h0) * (index - i0)) / (i1 - i0));
    }
  }
  return last[1];
}

export function createBackend(opts = {}) {
  return new FiroBackend(opts);
}

/**
 * The wallet's store, written to only while the engine is open (audit FE-4: a lock landing inside
 * a save wrote what _reset() had already emptied: 0 private FIRO until a Rescan). put and del
 * resolve whether they wrote (release re-audit R1-2: a refused write was silent, and a payment whose
 * record never reached the store was answered 'unsure').
 */
function guardStore(store, closed) {
  return {
    get: (k) => store.get(k),
    keys: (p) => store.keys(p),
    put: async (k, v) => {
      if (closed()) return false;
      await store.put(k, v);
      return true;
    },
    del: async (k) => {
      if (closed()) return false;
      await store.del(k);
      return true;
    },
  };
}

export class FiroBackend {
  constructor({ network = 'main', servers, ownNode = false, store, spark = null, sharedStore = null, WebSocket, sparkTxDetails = 'none', electrum = {}, relayLookMs = RELAY_LOOK_MS, proveMsPerSync = PROVE_MS_PER_SYNC, verifyHeightsPerPart = VERIFY_HEIGHTS_PER_PART } = {}) {
    if (!store) throw new Error('createBackend needs a store.');
    this.net = getNetwork(network);
    this.servers = servers?.length ? servers.map((s) => (typeof s === 'string' ? s : s.url)) : [...this.net.servers];
    // The person reads the chain from a node of their own (the app says so): see _secondOpinion.
    this.ownNode = Boolean(ownNode);
    this.store = guardStore(store, () => this._closed);
    this.cacheStore = sharedStore ?? prefixStore(this.store, 'cache/');
    // Payments between send() and the end of their broadcast (audit FE-4: the app does not lock then).
    this._inFlight = 0;
    this.spark = spark;
    this.WebSocket = WebSocket;
    this.electrumOpts = electrum;
    this._relayLookMs = relayLookMs;
    this._proveMsPerSync = proveMsPerSync;
    this._verifyHeightsPerPart = verifyHeightsPerPart;
    this.sparkTxDetails = sparkTxDetails;
    this.listeners = new Set();
    this._reset();
    this.sparkNames = {
      list: () => this._listOwnNames(),
      listDetailed: () => this._listOwnNamesDetailed(),
      details: (name) => this._ownNameDetails(name),
      isFree: (name) => this._nameIsFree(name),
      feeFiro: (name, years = 1) => this.sparkNameFeeFiro(name, years),
      // A new registration, never taken for a renewal (its checks are a new name's: X8).
      register: (o) => this._registerName({ ...o, renew: false }),
      renew: (o) => this._renewName(o),
      // What a registration or renewal would cost, network fee included ({fee, total}), to show and
      // pin (expect) as a payment's review does (audit L7: the name's fee was never shown or pinned).
      quote: (o) => this._registerName({ ...o, renew: false, quoteOnly: true }),
      quoteRenew: (o) => this._renewName({ ...o, quoteOnly: true }),
      transfer: async () => {
        throw notYet('Transferring a Spark name');
      },
    };
    this.coins = {
      list: () => this._listCoins(),
      freeze: (id, frozen = true) => this._freeze(id, frozen),
      label: (id, text) => this._label(id, text),
    };
    this.masternodes = {
      list: () => this._listMasternodes(),
      register: async () => {
        throw notYet('Registering a masternode');
      },
    };
    this.rosen = {
      quote: async () => {
        throw notYet('The Rosen Bridge');
      },
      lock: async () => {
        throw notYet('The Rosen Bridge');
      },
    };
  }

  _reset() {
    this.client = null;
    this.keys = null;
    this.transparent = null;
    this.sparkSync = null;
    this._sparkKey = null; // 32 bytes at m/44'/136'/0'/6/1
    this._fvk = null; // serialized full view key (view-only)
    this.viewOnly = false;
    this.opened = false;
    this._closed = false;
    this.tip = null;
    this.syncState = { phase: 'connecting', done: 0, total: 0 };
    this.ownCoins = new Map(); // lTagHash → record
    this.progress = null;
    this.sends = new Map();
    this.spendInfo = new Map(); // txid -> {height, time, fee, name}
    this.anchors = {}; // groupId -> {size, points}
    this.namePins = new Map(); // NAME -> Spark address paid
    this.sparkAddr = { diversifier: 1 };
    this._sparkAddresses = new Map();
    this._running = null;
    this._again = false;
    this._proofAgain = false;
    this._epoch = 0; // raised by Rescan: a look under way when it is pressed stops, writing nothing
    this._sparkReady = false;
    this._names = null;
    this._refusedGroups = new Set(); // groups a private payment was stopped over (D-09)
    this.privateCheck = null; // {code, otherServer}: private coins received could not be confirmed (P4)
    this.tagCheck = null; // {state, at, ours, theirs}: the used tags compared with a second server (D-12)
    this._secondTurn = 0; // where the next second opinion starts in the list of other nodes (RE3-2)
    this._lastServer = null; // the node the main connection was last on (RE5-3: in use while it is down or moving)
    this._opinions = new Set(); // how to end each second opinion in flight, at a lock (RE5-5)
    this._noSecondSyncs = 0; // syncs in a row the tip check found no second node to ask (RE3-2)
    this._offs = [];
    this.labels = {};
  }

  // ------------------------------------------------------------ pure

  /** Also on the class, usable before any backend exists: FiroBackend.generateMnemonic(24). */
  static generateMnemonic(words = 24) {
    return generateMnemonic(words);
  }

  static validateMnemonic(text) {
    const v = validateMnemonic(text);
    return v.ok ? { ok: true } : { ok: false, error: v.error };
  }

  generateMnemonic(words = 24) {
    return generateMnemonic(words);
  }

  validateMnemonic(text) {
    const v = validateMnemonic(text);
    return v.ok ? { ok: true } : { ok: false, error: v.error };
  }

  classifyAddress(text) {
    const c = classify(text, this.net);
    const out = { kind: c.kind };
    if (c.address) out.address = c.address;
    if (c.name) out.name = c.name;
    return out;
  }

  // ------------------------------------------------------------ lifecycle

  /** Derives the keys, loads the cache, connects and starts syncing. Resolves before the sync ends. */
  async open({ mnemonic, passphrase = '', birthdayHeight } = {}) {
    if (this.opened) throw new Error('This wallet is already open.');
    const v = validateMnemonic(mnemonic);
    if (!v.ok) throw err('invalid-mnemonic', v.error);
    this.keys = await FiroKeys.fromMnemonic(mnemonic, passphrase, this.net);
    this._sparkKey = this.keys.sparkKeyMaterial();
    this.viewOnly = false;
    await this._start({ birthdayHeight });
  }

  /** View-only: transparent from an account xpub, Spark from a full view key (hex). Either may be missing. */
  async openViewOnly({ sparkFullViewKey, xpub, birthdayHeight } = {}) {
    if (this.opened) throw new Error('This wallet is already open.');
    if (!sparkFullViewKey && !xpub) throw new Error('A view-only wallet needs a Spark view key or an xpub.');
    if (xpub) this.keys = FiroKeys.fromXpub(xpub, this.net);
    if (sparkFullViewKey) {
      if (!/^[0-9a-f]+$/i.test(sparkFullViewKey) || sparkFullViewKey.length % 2) throw err('invalid-key', 'The Spark view key is not hex.');
      this._fvk = hexToBytes(sparkFullViewKey.toLowerCase());
    }
    this.viewOnly = true;
    await this._start({ birthdayHeight: Number.isSafeInteger(birthdayHeight) ? birthdayHeight : undefined });
  }

  async _start({ birthdayHeight }) {
    this.opened = true;
    this._closed = false;
    this.client = new ElectrumClient({ servers: this.servers, WebSocket: this.WebSocket, ...this.electrumOpts });
    if (this.keys) {
      this.transparent = new TransparentWallet({ net: this.net, keys: this.keys, client: this.client, store: prefixStore(this.store, 'w/') });
      await this.transparent.load();
    }
    if (this._sparkEnabled()) {
      this.sparkSync = new SparkSync({ client: this.client, store: this.cacheStore });
      await this._loadSpark(birthdayHeight);
    }
    this.labels = (await this.store.get(KEY.labels)) ?? {};
    this._wireClient();
    // The Spark receive address needs no network.
    await this._ensureSparkAddress().catch(() => {});
    this._emit();
    this._requestSync();
  }

  /** Listens to the connection: reconnects and new blocks start a sync; address changes refresh the public side. */
  _wireClient() {
    for (const off of this._offs) off();
    this._offs = [
      this.client.on('status', (s) => {
        if (s.connected && s.server) this._lastServer = s.server;
        if (s.connected) this._requestSync();
        this._emit();
      }),
      this.client.on('header', (h) => {
        const changed = !this.tip || this.tip.height !== h.height;
        this.tip = { height: h.height, time: headerTime(h.hex) };
        if (changed && this.syncState.phase !== 'connecting') this._requestSync();
        this._emit();
      }),
      this.client.on('scripthash', (sh, status) => {
        this.transparent
          ?.onStatus(sh, status)
          .then((changed) => changed && this._emit())
          .catch(() => {});
      }),
    ];
  }

  _sparkEnabled() {
    if (!this.spark) return false;
    if (this._sparkKey) return sparkHas(this.spark, 'keys') && sparkHas(this.spark, 'scan');
    if (this._fvk) return sparkHas(this.spark, 'viewOnly') && sparkHas(this.spark, 'scan');
    return false;
  }

  async _loadSpark(birthdayHeight) {
    const st = this.store;
    this.progress = (await st.get(KEY.progress)) ?? null;
    if (!this.progress) {
      // A birthday means a new wallet: only the groups from now on, tags from the checkpoint.
      this.progress = { groups: {}, tagsUpTo: 0, firstGroup: null, isNew: birthdayHeight !== undefined && birthdayHeight !== null, birthdayHeight: birthdayHeight ?? null };
      await st.put('s/progress', this.progress);
    }
    for (const r of (await st.get(KEY.coins)) ?? []) this.ownCoins.set(r.lTagHash, { ...r, value: BigInt(r.value) });
    this._anewAt = (await st.get(KEY.anewAt)) ?? {};
    for (const [txid, s] of Object.entries((await st.get(KEY.sends)) ?? {})) this.sends.set(txid, s);
    for (const [txid, i] of Object.entries((await st.get(KEY.spendInfo)) ?? {})) this.spendInfo.set(txid, i);
    this.anchors = (await st.get(KEY.anchors)) ?? {};
    for (const [n, a] of Object.entries((await st.get(KEY.namePins)) ?? {})) this.namePins.set(n, a);
    this.sparkAddr = (await st.get(KEY.sparkAddr)) ?? { diversifier: 1 };
    this._sparkReady = !!this.progress.lastDone;
  }

  /**
   * Taken as one picture before the first write (a lock between two writes cannot empty what is
   * written), and progress last: it never says more coins were identified than the list holds.
   * `written` (a Set) gets each key once it is in the store, also when a later write throws: a
   * payment's record (s/sends) is kept or not by that (release re-audit R-2).
   */
  async _saveSpark(written = new Set()) {
    if (this._closed || !this.progress) return written;
    const epoch = this._epoch;
    const coins = [...this.ownCoins.values()].map((r) => ({ ...r, value: String(r.value) }));
    const sends = Object.fromEntries([...this.sends].map(([k, v]) => [k, { ...v }]));
    const spendInfo = Object.fromEntries(this.spendInfo);
    const anchors = { ...this.anchors };
    // A copy all the way down (tenth audit N3: one level deep, a look under way moved the live groups
    // on, past a coin this save had not taken, and that progress was written).
    const progress = structuredClone(this.progress);
    for (const [k, v] of [
      [KEY.coins, coins],
      [KEY.sends, sends],
      [KEY.spendInfo, spendInfo],
      [KEY.anchors, anchors],
      [KEY.progress, progress],
    ]) {
      // A Rescan began during this save: its progress is the Rescan's to write, never this older one
      // after its emptied coins (ninth audit L3: a page that died then showed 0).
      if (k === KEY.progress && this._epoch !== epoch) break;
      if (await this.store.put(k, v)) written.add(k);
    }
    return written;
  }

  /** A payment is between send() and the end of its broadcast: the app must not lock now (FE-4). */
  get paymentInFlight() {
    return this._inFlight > 0;
  }

  /** Disconnects and forgets every key held in memory. */
  async close() {
    this._closed = true;
    for (const off of this._offs) off();
    this.client?.close();
    // Second opinions in flight end now (release re-audit 5 RE5-5): nothing more is asked, and the
    // sync this waits for below is not held by one for up to its 8 s (or a used-tag list's 120 s).
    for (const stop of this._opinions) stop();
    try {
      await this._running;
    } catch {
      // ignore
    }
    this.keys?.wipe();
    wipe(this._sparkKey, this._fvk);
    // The Spark client is one per page and outlives this engine: the view keys it derived go with
    // the Lock (a full view key shows every private payment: public audit, PN).
    this.spark?.forgetKeys?.();
    const listeners = this.listeners;
    this._reset();
    this.listeners = listeners;
    this._closed = true;
    this._emit();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit() {
    if (!this.listeners.size) return;
    const s = this.getState();
    for (const l of this.listeners) {
      try {
        l(s);
      } catch {
        // a listener's problem
      }
    }
  }

  // ------------------------------------------------------------ state

  getState() {
    const tipH = this.tip?.height ?? null;
    const pub = this.transparent && tipH !== null ? this.transparent.balance(tipH) : { available: 0n, pending: 0n };
    const priv = this._privateBalance();
    return {
      network: this.net.id,
      connected: !!this.client?.connected,
      server: this.client?.server ?? null,
      tip: this.tip ? { ...this.tip } : null,
      sync: { ...this.syncState },
      serverCheck: this._serverCheckState(),
      // Private coins received that could not be confirmed: this node's lists do not add up (P4).
      privateCheck: this.privateCheck ? { ...this.privateCheck } : null,
      // A payment's stage the person should see while it waits ('checking-coins'), or null.
      sending: this.sendStage ?? null,
      balance: {
        private: { available: String(priv.available), pending: String(priv.pending), ...(priv.checking > 0n ? { checking: String(priv.checking) } : {}) },
        public: { available: String(pub.available), pending: String(pub.pending), ...(pub.mnLocked > 0n ? { mnLocked: String(pub.mnLocked) } : {}) },
      },
      txs: this._txList(),
      receive: {
        spark: this._sparkAddresses.get(this.sparkAddr.diversifier) ?? null,
        transparent: this.transparent ? this.transparent.receiveAddress().address : null,
      },
      viewOnly: this.viewOnly,
    };
  }

  /**
   * The tip check (D-11), and the used tags (D-12) when another server disagrees about them:
   * {state, at, otherHeight, about?: 'spent'}. A different chain is said first.
   */
  _serverCheckState() {
    const t = this.serverCheck ? { ...this.serverCheck } : null;
    if (t && t.state === 'disagree') return t;
    if (this.tagCheck && this.tagCheck.state === 'disagree') return { ...(t ?? { otherHeight: null }), state: 'disagree', about: 'spent', at: this.tagCheck.at };
    // No second node could be asked, for this many syncs in a row (lib/sync.js says so after 3).
    if (noSecond(t)) t.noSecondSyncs = this._noSecondSyncs;
    return t;
  }

  _privateBalance() {
    let available = 0n;
    let pending = 0n;
    let checking = 0n; // of pending: in a block, waiting for its set to be checked (N9: said as such)
    for (const c of this.ownCoins.values()) {
      if (c.spentTxid) continue;
      // Not proven yet (P4): pending, like one in the mempool, never available.
      if (c.mempool) pending += c.value;
      else if (this._needsSparkProof(c)) {
        pending += c.value;
        checking += c.value;
      } else if (!c.pendingSpentTxid) available += c.value;
    }
    return { available, pending, checking };
  }

  /**
   * Whether a private coin waits for proof before it counts (public audit, P4): one this wallet did
   * not make itself (not change, not from one of its own payments) whose set no second Firo node
   * has confirmed yet, nor the person's own node. Until then it is pending: never available, never
   * spent, and shown waiting, as a public payment without proof is (_proveReceipts).
   */
  _needsSparkProof(c) {
    if (c.spentTxid || c.mempool || !c.groupId || PROVEN.has(c.proof)) return false;
    return !this._sparkMadeHere(c);
  }

  /**
   * A private coin this wallet made: its change, or a coin whose bytes are in a transaction this
   * wallet built itself (one of its private payments, or a public one of its own: Make private).
   * The transaction a server files a coin under proves nothing by itself (audit E1: a coin made to
   * this wallet off the chain, filed under one of its own payments, counted at once): the coin
   * must be in that transaction's bytes, and those the bytes this wallet built, or a public
   * payment of its own proven in a block.
   */
  _sparkMadeHere(c) {
    if (c.isChange) return true;
    const body = ownBody(c);
    if (!body) return false;
    const built = (hex) => typeof hex === 'string' && hasBytes(hexToBytes(hex), body);
    if (built(this.sends.get(c.txid)?.hex)) return true;
    const t = this.transparent;
    if (!t) return false;
    if (built(t.pending.get(c.txid)?.hex)) return true;
    const r = t.txs.get(c.txid);
    if (!r || r.dropped || !PROVEN.has(r.proof)) return false;
    const minted = r.decoded.vout.some((o) => o.script instanceof Uint8Array && o.script[0] === OP.OP_SPARKMINT && hasBytes(o.script, body));
    return (
      minted &&
      r.decoded.vin.some((i) => {
        const prev = i.txid ? t.txs.get(i.txid) : null;
        const out = prev?.decoded.vout[i.vout];
        return Boolean(out && t.isOwnScript(out.script));
      })
    );
  }

  /**
   * Whether the set held here has this coin, with its bytes (audit E2): where the coin says, or, when
   * the set was downloaded anew and it moved (a reorganisation: audit N3), anywhere in its group, and
   * then its place is put right.
   */
  async _inHeldSet(c) {
    if (!c.groupId || c.index == null || !(c.coin instanceof Uint8Array)) return false;
    const body = ownBody(c);
    if (!body) return false;
    const match = (e) => Boolean(e && e.txid === c.txid && sameBytes(coinBody(e), body));
    const [e] = await this.sparkSync.coins(c.groupId, { from: c.index, to: c.index + 1 });
    if (match(e)) return true;
    const moved = (await this.sparkSync.coins(c.groupId)).find(match);
    if (!moved) return false;
    c.index = moved.index;
    c.coin = moved.coin;
    return true;
  }

  _txList() {
    const tipH = this.tip?.height ?? 0;
    const t = this.transparent ? transparentEntries({ net: this.net, records: this.transparent.txs, isOwnScript: (s) => this.transparent.isOwnScript(s), tipHeight: tipH, pending: this.transparent.pending }) : new Map();
    const coins = [...this.ownCoins.values()].map((c) => ({
      txid: c.txid,
      value: c.value,
      memo: c.memo,
      isChange: c.isChange,
      spentTxid: c.spentTxid ?? c.pendingSpentTxid ?? null,
      spentHeight: c.spentTxid ? c.spentHeight : null,
      spentTime: c.spentTime ?? this.sends.get(c.spentTxid ?? c.pendingSpentTxid)?.time ?? null,
      height: c.mempool ? null : c.height,
      heightApprox: c.heightApprox,
      time: c.time,
      // In a block on the node's word, its set not confirmed by a second node yet (P4).
      unproven: this._needsSparkProof(c),
    }));
    const s = sparkEntries({ coins, sends: this.sends, tipHeight: tipH, spendInfo: this.spendInfo });
    return mergeEntries(t, s);
  }

  // ------------------------------------------------------------ sync

  _requestSync() {
    if (!this.opened || this._closed) return;
    if (this._running) {
      this._again = true;
      return;
    }
    this._running = (async () => {
      do {
        this._again = false;
        await this._syncOnce();
        // Set checks left for coins received (N9, F3): only that, part after part, until done or a
        // new block asks for a sync (fourth audit N6: a whole sync each time put Send and Review
        // through "syncing" every minute for as long as it lasted).
        while (this._proofAgain && !this._again && !this._closed) {
          this._proofAgain = false;
          if (this.sparkSync && this._sparkReady) await this._proveSparkReceipts().catch(() => {});
        }
      } while (this._again && !this._closed);
    })().finally(() => {
      this._running = null;
    });
  }

  /** Waits for the current sync run (tests and the UI's pull-to-refresh). */
  async waitForSync() {
    while (this._running) await this._running;
  }

  _phase(phase, done = 0, total = 0, error) {
    this.syncState = error ? { phase, done, total, error } : { phase, done, total };
    this._emit();
  }

  async _syncOnce() {
    try {
      if (!this.client.connected) {
        this._phase('connecting');
        await this.client.connect();
      }
      if (!this.tip) {
        const h = await this.client.subscribeHeaders();
        this.tip = { height: h.height, time: headerTime(h.hex) };
      }
      if (this.transparent) {
        this._phase('transparent');
        await this.transparent.sync({ onProgress: (p) => this._phase('transparent', p.done, p.total ?? 0) });
        await this._proveReceipts().catch(() => {});
        await this._checkCollateral().catch(() => {});
        await this._followPending().catch(() => {});
      }
      if (this.sparkSync) await this._syncSpark();
      this._phase('done', 1, 1);
      const sc = this.serverCheck;
      if (!sc || now() - sc.at >= (noSecond(sc) ? NO_SECOND_RETRY_S : 300)) await this._checkTip().catch(() => {});
      // How long no second node could be asked, in syncs: the sync line says so after a few (RE3-2:
      // every public receipt then waits unproven, and nothing said why).
      const count = noSecond(this.serverCheck) ? this._noSecondSyncs + 1 : 0;
      if (count !== this._noSecondSyncs) {
        this._noSecondSyncs = count;
        this._emit();
      }
      // A little each sync, after "done": the newest set's hash, recomputed from its coins (D-09).
      // A view-only wallet too: no key is needed, and its received coins wait for this (audit E4).
      if (this.sparkSync && this._sparkReady) await this._verifyLatestSet({ maxHeights: VERIFY_HEIGHTS_PER_SYNC }).catch(() => {});
      // Then the private coins this wallet did not make, until a second node confirms their sets (P4).
      if (this.sparkSync && this._sparkReady) await this._proveSparkReceipts().catch(() => {});
    } catch (e) {
      if (this._closed) return;
      // Let go of for a Rescan: the next sync (already asked for) does its look.
      if (e && e.code === 'superseded') return;
      const a = apiError(e);
      this._phase(a.code === 'offline' ? 'connecting' : 'error', 0, 0, a.message);
    }
  }

  async _syncSpark() {
    const epoch = this._epoch;
    const still = () => {
      if (this._epoch !== epoch) throw err('superseded', 'A Rescan began: this look was let go of.');
    };
    const latest = await this.sparkSync.latestGroupId();
    if (this.progress.firstGroup === null) {
      // "New" only if the birthday is today (576 blocks): an older birthday could hide coins in
      // earlier groups, which cannot be told apart by height without asking about them.
      if (this.progress.isNew && this.tip && this.tip.height - (this.progress.birthdayHeight ?? 0) > 576) this.progress.isNew = false;
      this.progress.firstGroup = this.progress.isNew ? Math.max(1, latest) : 1;
      await this.store.put(KEY.progress, this.progress);
    }
    const groups = [];
    for (let g = this.progress.firstGroup; g <= latest; g++) groups.push(g);

    // Sets: one progress bar over every group still to fetch.
    let total = 0;
    let done = 0;
    this._phase('spark-sets', 0, 0);
    for (const g of groups) {
      let counted = false;
      let last = 0;
      await this.sparkSync.syncGroup(g, {
        onProgress: (p) => {
          if (!counted) {
            counted = true;
            total += p.total;
          }
          last = p.done;
          this._phase('spark-sets', done + p.done, total);
        },
      });
      done += last;
    }

    // Used tags.
    this._phase('spark-tags');
    const startAt = this.progress.isNew ? (this.net.sparkTagsCheckpoint ?? 0) : 0;
    await this.sparkSync.syncTags({ startAt });
    // Compared with a second server now and then, before they mark anything (D-12).
    const t = this.tagCheck;
    if (!t || now() >= t.at + (t.state === 'unknown' && t.retrySoon ? 30 : TAG_CHECK_EVERY)) await this._checkTags().catch(() => {});

    // Which coins are ours.
    await this._identify(groups, epoch);
    still();
    // A mempool transaction that cannot be looked at stops nothing else (sixth audit N4: it threw
    // before the used tags were looked at, every sync, so a coin spent elsewhere looked spendable).
    await this._sparkMempool().catch(() => {});
    still();
    await this._checkSpent(epoch);
    still();
    // After _checkSpent: our spends are known by then. Not fatal: without an answer a restored
    // coin keeps a rough block, and is placed at a later sync (sixth audit N5: the mark went even
    // when placing failed, and old payments stayed dated by the Rescan for good).
    const placed = !this.progress.isNew || this.progress.relook ? await this._placeRestored().then(() => true, () => false) : true;
    still(); // a Rescan while the blocks were asked for keeps its own mark (seventh audit M2)
    if (placed) delete this.progress.relook;
    if (this.sparkTxDetails === 'decoy') await this._decoyDetails();
    this.progress.lastDone = now();
    this.progress.tipAtDone = this.tip?.height ?? null;
    this._sparkReady = true;
    await this._saveSpark();
    await this._ensureSparkAddress();
  }

  _keyArgs() {
    return this._sparkKey ? { keyData: this._sparkKey } : { fullViewKey: this._fvk };
  }

  async _identify(groups, epoch = this._epoch) {
    let total = 0;
    const todo = [];
    for (const g of groups) {
      const st = await this.sparkSync.groupState(g);
      // A set downloaded anew (another download id than the one this wallet last looked at whole:
      // audit N3, fifth audit M2) is looked at from its first coin until one pass over it is done
      // (fourth audit N1: a pass cut short went on from where it stopped, then let go of the waiting
      // coins before that place as if the whole set had been looked at).
      const anew = Boolean(st) && (st.gen ?? null) !== (this.progress.gens?.[g] ?? null);
      // Carried on where the last look at this same download stopped, each part kept (fifth audit r9:
      // sessions shorter than a whole look began it again each time and never reached its end).
      const resume = anew ? this._anewAt?.[g] : null;
      const from = anew ? (resume && resume.gen === (st.gen ?? null) && resume.upTo < st.size ? resume.upTo : 0) : this.progress.groups[g] ?? 0;
      if (st && st.size > from) {
        todo.push([g, from, st.size, anew, st.gen ?? null]);
        total += st.size - from;
      }
    }
    let done = 0;
    let unsaved = false; // coins found since the last whole save
    let savedAt = Date.now();
    let savedOnce = false; // in this look: the first coin found is saved at once (seventh audit M1)
    this._phase('spark-identify', 0, total);
    for (const [g, from, size, again, gen] of todo) {
      const coins = await this.sparkSync.coins(g, { from });
      const seen = new Set();
      // Restoring until the first sync is done (fourth audit N5: decided by "from the first coin", a
      // first look cut short and carried on dated old coins today and placed them at the tip), and
      // after a Rescan or a move off a node's refused sets (fifth audit M1: found again with no record,
      // every coin was dated today).
      const restoring = Boolean(this.progress.relook) || (!this.progress.isNew && this.progress.lastDone == null);
      // Back after a while (a web app does not run while closed): a coin new since the last sync
      // was mined between that sync's block and now, and coins are kept in chain order, so it is
      // placed there by its position, roughly, with no request. A coin first seen in the mempool
      // keeps the time it was seen.
      const lastTip = this.progress.tipAtDone ?? null;
      const gap = !restoring && lastTip != null && this.tip ? this.tip.height - lastTip : 0;
      const placeNew = (index) => lastTip + Math.min(gap, Math.max(1, Math.ceil(((index - from + 1) / Math.max(1, size - from)) * gap)));
      for (let i = 0; i < coins.length; i += 1000) {
        const part = coins.slice(i, i + 1000);
        const res = await this.spark.identifyCoins({ ...this._keyArgs(), index: SPARK_KEY_INDEX, isTestNet: this.net.id !== 'main', coins: part.map((c) => ({ coin: c.coin, context: c.context })) });
        if (!Array.isArray(res) || res.length !== part.length) throw err('server', 'The Spark library answered for a different number of coins.');
        // A Rescan meanwhile: nothing more is written from this look (sixth audit P1); Lock: nothing
        // more is looked at with the key (eighth audit N3: it went on for minutes after Lock).
        if (this._epoch !== epoch) throw err('superseded', 'A Rescan began: this look was let go of.');
        if (this._closed) throw err('not-open', 'The wallet was locked.');
        let found = false;
        res.forEach((r, j) => {
          if (!r) return;
          const c = part[j];
          const prev = this.ownCoins.get(r.lTagHash);
          seen.add(r.lTagHash);
          // Found again with other data: what proved the old one proves nothing of this (audit E3).
          // The same coin in another place (a set downloaded anew, or carried into the next group)
          // is the same coin (audit N6).
          const same = prev && prev.txid === c.txid && prev.value === BigInt(r.value) && prev.coin instanceof Uint8Array && sameBytes(ownBody(prev), coinBody(c));
          const placed = prev && prev.height != null && !prev.mempool;
          this.ownCoins.set(r.lTagHash, {
            ...(prev ?? {}),
            lTagHash: r.lTagHash,
            groupId: g,
            index: c.index,
            txid: c.txid,
            value: BigInt(r.value),
            memo: r.memo ?? '',
            diversifier: r.diversifier,
            isChange: r.diversifier === SPARK_CHANGE_DIVERSIFIER,
            coin: c.coin,
            context: c.context,
            // Found before: where it was placed then stays (a set downloaded anew is no new coin).
            height: placed ? prev.height : gap > 2 && !prev?.time ? placeNew(c.index) : this.tip?.height ?? null,
            heightApprox: placed ? prev.heightApprox : true,
            // Found before: its time stays, none included (third audit F6: a restored payment found
            // again in a set downloaded anew was dated today).
            time: prev ? prev.time ?? null : restoring || gap > 2 ? null : now(),
            mempool: false,
            fresh: true,
          });
          if (prev && !same) delete this.ownCoins.get(r.lTagHash).proof;
          // Seen in this download of its set (sixth audit N2: a look carried on across sessions knows
          // which coins it saw before it stopped).
          if (again) this.ownCoins.get(r.lTagHash).seenGen = gen;
          found = true;
        });
        done += part.length;
        this.progress.groups[g] = c_index(part) + 1;
        if (again) {
          // Where to carry on from is kept only once every coin found before it is kept too (N7),
          // and the coins at most every 10 s (sixth audit N3: a whole save after every part rewrote
          // every coin hundreds of times on a large set). Where to carry on from is a few bytes.
          // The place moves, here as on disk, only once every coin before it is kept: a later look in
          // this session carries on from it too (seventh audit H1: moved in memory alone, a look after a
          // failed one carried on past a coin never saved, and it was lost). A save counts only when the
          // store took both the coins and the progress.
          if (found) unsaved = true;
          if (unsaved && (!savedOnce || Date.now() - savedAt > 10000)) {
            const written = await this._saveSpark();
            // A Rescan while this was saved: nothing more from this look, not even its place (eighth
            // audit N1: a place worked out before the save was written back over the Rescan's).
            if (this._epoch !== epoch) throw err('superseded', 'A Rescan began: this look was let go of.');
            if (written.has(KEY.coins) && written.has(KEY.progress)) {
              unsaved = false;
              savedOnce = true;
              savedAt = Date.now();
            }
          }
          if (!unsaved) {
            this._anewAt = { ...(this._anewAt ?? {}), [g]: { gen, upTo: c_index(part) + 1 } };
            await this.store.put(KEY.anewAt, this._anewAt);
          }
        }
        this._phase('spark-identify', done, total);
      }
      // The places just looked at (from `from` to the set's size): a coin waiting for proof that says
      // it is in one of them and was not found there was never on the chain (or is back in the
      // mempool, where it is found again): let go of. Nothing outside them (third audit F4: a node a
      // block behind does not have the newest block yet; fourth audit N4: one that mined another block
      // there now has been looked at, and the coin no node has goes).
      // A look at a download, carried on across sessions, has looked at all of it once it ends: a
      // waiting coin of the group it did not see (sixth audit N2: one whose place lay before where the
      // look was carried on from stayed pending for ever).
      if (this._epoch !== epoch) throw err('superseded', 'A Rescan began: this look was let go of.');
      const unseen = (k, c) => (again ? c.seenGen !== gen : !seen.has(k) && c.index >= from);
      for (const [k, c] of this.ownCoins) {
        if (c.groupId === g && unseen(k, c) && !c.mempool && c.index != null && c.index < size && this._needsSparkProof(c) && !c.pendingSpentTxid) {
          this.ownCoins.delete(k);
          // Back in the mempool, perhaps: looked at there again (tenth audit N1: it stayed marked as
          // looked at, and the payment was not shown while it waited).
          this._mempoolLookAgain(c.txid);
        }
      }
      if (again) {
        this.progress.gens = { ...(this.progress.gens ?? {}), [g]: gen };
        const { [g]: _done, ...rest } = this._anewAt ?? {};
        void _done;
        this._anewAt = rest;
        await this.store.put(KEY.anewAt, this._anewAt);
      }
    }
  }

  /**
   * Coins found while restoring have no block of their own. Each is placed by its position in its
   * set, between the blocks of the coins at fixed positions (every 1/16 of every set downloaded).
   * Those positions are the same for every wallet and asked for every set, whether it holds our
   * coins or not, so the server learns nothing about which coins are ours. Asked once per set.
   */
  async _placeRestored() {
    const latest = await this.sparkSync.latestGroupId();
    const loose = [...this.ownCoins.values()].filter((c) => c.heightApprox && !c.time && c.groupId && c.index != null);
    let asked = false;
    for (let g = this.progress.firstGroup ?? 1; g <= latest; g++) {
      const st = await this.sparkSync.groupState(g);
      if (!st || !st.size) continue;
      const have = this.anchors[g];
      const beyond = loose.some((c) => c.groupId === g && (!have || c.index > have.points[have.points.length - 1][0]));
      if (have && !beyond) continue;
      const positions = anchorPositions(st.size);
      const byIndex = new Map((await this.sparkSync.coins(g)).map((c) => [c.index, c.txid]));
      const list = positions.map((i) => [i, byIndex.get(i)]).filter(([, t]) => t);
      const res = await this.client.batch(list.map(([, t]) => ['blockchain.transaction.get', [t, true]]));
      const points = [];
      list.forEach(([i], k) => {
        const v = res[k];
        if (v && !(v instanceof Error) && v.height > 0) points.push([i, v.height]);
      });
      if (points.length >= 2) {
        this.anchors[g] = { size: st.size, points };
        asked = true;
      }
    }
    let unplaced = 0;
    for (const c of loose) {
      const a = this.anchors[c.groupId];
      const h = a ? placeByAnchors(a.points, c.index) : null;
      if (h) c.height = h;
      else unplaced++;
    }
    if (asked || loose.length) await this._saveSpark();
    this._emit();
    // Every coin placed (sixth audit N5: the Rescan's mark went when a request for the blocks failed).
    if (unplaced) throw err('server', 'Some private payments could not be placed in their blocks yet.');
  }

  /** Mempool: Spark coins coming to us, and our coins being spent. */
  async _sparkMempool() {
    const { txs } = await this.sparkSync.syncMempool();
    for (const [txid, m] of txs) {
      if (m._identified) continue;
      // Marked looked at only once it has been (fifth audit: marked first, a failed look hid an
      // incoming payment until it was mined); one that keeps failing is given up after three tries
      // (sixth audit N4), and coins of an impossible size are never looked at.
      m._tries = (m._tries ?? 0) + 1;
      if (!m.coins.length || m._tries > 3 || m.coins.some((c) => !(c instanceof Uint8Array) || c.length > 4096) || (m.serialContext && m.serialContext.length > 1 << 24)) {
        m._identified = true;
        continue;
      }
      // One that fails waits for the next sync; the others are looked at now (seventh audit L2).
      let res;
      try {
        res = await this.spark.identifyCoins({ ...this._keyArgs(), index: SPARK_KEY_INDEX, isTestNet: this.net.id !== 'main', coins: m.coins.map((coin) => ({ coin, context: m.serialContext })) });
      } catch {
        continue;
      }
      m._identified = true;
      let again = false;
      for (let j = 0; j < res.length; j++) {
        const r = res[j];
        if (!r) continue;
        // Known already: kept, unless it is this very transaction's coin, back in the mempool from a
        // block a reorganisation took away and still waiting for proof there (eighth audit N2: that
        // stale entry hid it, and the next look let it go: invisible until mined again). Only when its
        // place in the set held no longer has it (ninth audit H1: one stale mempool answer about a
        // payment just mined took it out of its block, and it was never found there again).
        const prev = this.ownCoins.get(r.lTagHash);
        if (prev && !(prev.txid === txid && !prev.mempool && !prev.spentTxid && !prev.pendingSpentTxid && this._needsSparkProof(prev))) continue;
        if (prev && prev.groupId != null && prev.index != null) {
          let held;
          try {
            [held] = await this.sparkSync.coins(prev.groupId, { from: prev.index, to: prev.index + 1 });
          } catch {
            again = true; // cannot tell now: this transaction is looked at again next sync
            continue;
          }
          const body = ownBody(prev);
          if (held && held.txid === prev.txid && body && sameBytes(coinBody(held), body)) continue; // still mined there
        }
        this.ownCoins.set(r.lTagHash, {
          lTagHash: r.lTagHash,
          groupId: null,
          index: null,
          txid,
          value: BigInt(r.value),
          memo: r.memo ?? '',
          diversifier: r.diversifier,
          isChange: r.diversifier === SPARK_CHANGE_DIVERSIFIER,
          coin: m.coins[j],
          context: m.serialContext,
          height: null,
          heightApprox: false,
          time: now(),
          mempool: true,
        });
      }
      if (again) m._identified = false;
    }
    // A mempool coin whose transaction left the mempool without reaching the set was dropped.
    for (const [h, c] of this.ownCoins) if (c.mempool && !txs.has(c.txid)) this.ownCoins.delete(h);
  }

  /** A mempool transaction (or every one) looked at again at the next sync. */
  _mempoolLookAgain(txid = null) {
    const pool = this.sparkSync?.mempool;
    if (!pool) return;
    for (const [id, m] of pool) {
      if (txid !== null && id !== txid) continue;
      delete m._identified;
      delete m._tries;
    }
  }

  async _checkSpent(epoch = this._epoch) {
    const unspent = [...this.ownCoins.values()].filter((c) => !c.spentTxid && !c.mempool);
    const fresh = unspent.filter((c) => c.fresh).map((c) => c.lTagHash);
    const known = unspent.filter((c) => !c.fresh).map((c) => c.lTagHash);
    const tagState = await this.sparkSync.tagState();
    // While another server disagrees about the used tags (D-12), only those both agreed on count:
    // no coin of ours is marked spent, or taken as checked, on one server's word.
    const doubt = this.tagCheck?.state === 'disagree';
    const to = doubt ? this._agreedTagIndex(tagState) : Infinity;
    const found = new Map([...(await this.sparkSync.findUsed(fresh, { to })), ...(await this.sparkSync.findUsed(known, { from: Math.max(0, (this.progress.tagsUpTo ?? 0) - 100), to }))]);
    for (const c of unspent) {
      if (!doubt) delete c.fresh;
      const sp = found.get(c.lTagHash);
      if (sp) {
        c.spentTxid = sp;
        c.spentHeight = this.tip?.height ?? null;
        c.spentTime = this.sends.get(sp)?.time ?? c.spentTime ?? null;
        delete c.pendingSpentTxid;
      }
    }
    if (this._epoch !== epoch) return; // a Rescan meanwhile: its own look counts (P1)
    this.progress.tagsUpTo = Math.min(tagState?.stored ?? 0, to);
    // Spends waiting in the mempool, and this wallet's own payments not settled yet (their coins
    // stay spent, also after a Rescan forgot which coins they were: audit FM-1).
    const pending = new Map();
    for (const [txid, s] of this.sends) if (!s.confirmed && !s.dropped && Array.isArray(s.coins)) for (const h of s.coins) pending.set(h, txid);
    for (const [txid, m] of this.sparkSync.mempool) for (const h of m.lTagHashes) pending.set(h, txid);
    for (const c of this.ownCoins.values()) {
      if (c.spentTxid) continue;
      const t = pending.get(c.lTagHash);
      if (t) c.pendingSpentTxid = t;
      else if (c.pendingSpentTxid && !this.sends.has(c.pendingSpentTxid)) delete c.pendingSpentTxid;
    }
    await this._dropLostSends();
  }

  /**
   * A private payment of ours that is neither in the mempool nor used on chain (dropped by the
   * network, or never relayed): after 2 blocks it is sent again, once. After 6 it is given up on,
   * its coins free again, only on a positive signal (audit FE-2: an absence alone freed the coins of
   * a payment that had gone through, and erased its record): the node in use and a second one both
   * answer that they have no such transaction, and no other node disagrees about the used tags
   * (D-12). Given up is not final: it stays in the history with its record, and if it shows up in
   * the mempool or its coins are seen spent by it, it is back (confirmed, with its own amount, fee,
   * receiver and memo).
   */
  async _dropLostSends() {
    const tip = this.tip?.height ?? null;
    if (tip === null) return;
    const inMempool = this.sparkSync.mempool;
    // Another node disagrees about which coins are spent: an absent tag proves nothing.
    const doubt = this.tagCheck?.state === 'disagree';
    let changed = false;
    for (const [txid, s] of this.sends) {
      if (s.confirmed) continue;
      if ([...this.ownCoins.values()].some((c) => c.spentTxid === txid)) {
        s.confirmed = true;
        if (!s.toSelf) delete s.hex;
        delete s.unsure;
        delete s.dropped;
        delete s.oneNode;
        delete s.letGo;
        changed = true;
        continue;
      }
      if (inMempool.has(txid)) {
        if (s.unsure || s.dropped || s.noSecondSince != null || s.oneNode || s.letGo) {
          delete s.unsure; // seen on the network: it left
          delete s.dropped;
          delete s.noSecondSince;
          delete s.oneNode;
          delete s.letGo;
          changed = true;
        }
        continue;
      }
      if (s.dropped || typeof s.height !== 'number') continue;
      const age = tip - s.height;
      if (age >= 6) {
        if (doubt || this._closed) {
          // Another node says other coins are spent: no offer to let it go on one node's word meanwhile.
          if (doubt && s.oneNode) {
            delete s.oneNode;
            changed = true;
          }
          continue;
        }
        const v = await this._notOnNetwork(txid, s.noSecondSince ?? null);
        if ((v.since ?? null) !== (s.noSecondSince ?? null)) {
          if (v.since == null) delete s.noSecondSince;
          else s.noSecondSince = v.since;
          changed = true;
        }
        // An hour on the node in use's word alone: offered to the person, never decided here (RE3-3).
        if (Boolean(s.oneNode) !== Boolean(v.oneNode)) {
          if (v.oneNode) s.oneNode = true;
          else delete s.oneNode;
          changed = true;
        }
        if (!v.gone) continue;
        delete s.oneNode;
        s.dropped = true;
        s.droppedAt = tip;
        delete s.unsure;
        delete s.noSecondSince;
        for (const c of this.ownCoins.values()) if (c.pendingSpentTxid === txid) freeAsConflict(c);
        changed = true;
      } else if (age >= 2 && s.hex && !s.resent) {
        s.resent = true;
        changed = true;
        await this.client.broadcast(s.hex).catch(() => {});
      }
    }
    if (changed) await this._saveSpark();
  }

  /**
   * This wallet's public payments not in a block yet (audit FM-1; D-08 for private ones): one the
   * node does not list is sent again once after 2 blocks; after 6, only when the node in use and a
   * second one both answer that they have no such transaction, it did not go out: its coins are
   * free again and it stays in the history as not gone through. Seen on the network: followed
   * until it is in a block. A node merely not listing it decides nothing.
   */
  /** Whether a payment of ours the node puts at height h may be settled (its record let go): X6. */
  _settledEnough(txid, h, tip) {
    if (this.ownNode) return true;
    const r = this.transparent?.txs?.get(txid);
    // Proven in its block, by the node in use and a second one, change back or not (audit X6).
    return Boolean(r && PROVEN.has(r.proof));
  }

  async _followPending() {
    const t = this.transparent;
    const tip = this.tip?.height ?? null;
    if (!t || tip === null || !t.pending.size) return;
    const heights = t.historyHeights();
    let changed = false;
    for (const [txid, p] of [...t.pending]) {
      if (this._closed) return;
      const h = heights.get(txid);
      if (h !== undefined) {
        // In a block, by the node in use: settled only once that is more than one node's word (audit
        // of 0.1.8, X6: a later history without it, from a lagging or lying node or a reorganisation,
        // deleted the record and its coins looked free). Proven like a receipt (two nodes' header and
        // the Merkle branch), or, for a payment with nothing of ours in it to prove, deep enough.
        if (h > 0 && this._settledEnough(txid, h, tip)) await t.settlePending(txid);
        else if (p.unsure || p.dropped || p.noSecondSince != null || p.oneNode || p.letGo) await t.updatePending(txid, { unsure: undefined, dropped: undefined, noSecondSince: undefined, oneNode: undefined, letGo: undefined });
        changed = true;
        continue;
      }
      if (p.dropped) continue;
      if (typeof p.height !== 'number') {
        await t.updatePending(txid, { height: tip });
        continue;
      }
      const age = tip - p.height;
      if (age >= 6) {
        const v = await this._notOnNetwork(txid, p.noSecondSince ?? null);
        if (v.gone) {
          await t.updatePending(txid, { dropped: true, unsure: undefined, noSecondSince: undefined, oneNode: undefined });
          changed = true;
        } else if ((v.since ?? null) !== (p.noSecondSince ?? null) || Boolean(v.oneNode) !== Boolean(p.oneNode)) {
          // An hour on the node in use's word alone: offered to the person, never decided here (RE3-3).
          await t.updatePending(txid, { noSecondSince: v.since ?? undefined, oneNode: v.oneNode ? true : undefined });
          changed = true;
        }
      } else if (age >= 2 && !p.resent) {
        await t.updatePending(txid, { resent: true });
        await this.client.broadcast(p.hex).catch(() => {});
      }
    }
    if (changed) this._emit();
  }

  /**
   * Whether the network does not have our transaction `txid`: the node in use, and (unless it is
   * the person's own node) a second one, each answer that they have no such transaction. A node
   * that does not answer, or has it, means no (audit FE-2: never decided from an absence).
   * When no second node can be reached at all (every one refuses or times out), the node in use's
   * own answer never decides (release re-audit 3 RE3-3): once that has lasted ONE_NODE_AFTER_S,
   * counted from `since` (unix seconds, kept with the payment by the caller; null: not counting),
   * the person is offered to let it go (oneNode), and only letGo() frees its coins.
   * -> {gone, since, oneNode}: since is the count to keep (null: none).
   */
  async _notOnNetwork(txid, since = null) {
    const hour = (s) => s != null && now() - s >= ONE_NODE_AFTER_S;
    let here;
    try {
      here = await this._noSuchTx(this.client, txid);
    } catch {
      return { gone: false, since, oneNode: hour(since) }; // no answer from the node in use: nothing learned
    }
    if (!here) return { gone: false, since: null, oneNode: false };
    if (this.ownNode) return { gone: true, since: null, oneNode: false };
    let second;
    try {
      second = await this._secondOpinion((c) => this._noSuchTx(c, txid));
    } catch (e) {
      // Locked meanwhile (re-audit 6 RE6-2): nothing learned, the hour is neither started nor ended.
      if (e?.code === 'closed' || this._closed) return { gone: false, since, oneNode: hour(since) };
      if (!unreachable(e)) return { gone: false, since: null, oneNode: false }; // a second node answered otherwise
      const t = now();
      if (since == null || since > t) return { gone: false, since: t, oneNode: false };
      return { gone: false, since, oneNode: hour(since) };
    }
    return { gone: second === true, since: null, oneNode: false };
  }

  /** Whether node `c` answers that it has no transaction `txid` (true), has it (false); throws on no answer. */
  async _noSuchTx(c, txid) {
    try {
      await c.getTransaction(txid);
      return false;
    } catch (e) {
      if (e instanceof ElectrumError && e.code === 'server' && NO_SUCH_TX.test(e.message)) return true;
      throw e;
    }
  }

  /**
   * The person lets go of a payment of theirs the node in use says it never received, offered once
   * no second node could be reached for ONE_NODE_AFTER_S (Tx.oneNode, release re-audit 3 RE3-3):
   * its coins are free again and it says it did not go through, by the person's choice (Tx.letGo).
   * The node in use is asked once more first: one it has now is not let go ('seen'), one it does not
   * answer for is not either ('offline'). As any payment given up, it is back if the network shows
   * it after all. -> {txid, letGo: true}
   */
  async letGo(txid) {
    if (this._closed || !this.opened || !this.client) throw err('not-open', 'The wallet is locked.');
    const t = this.transparent;
    const p = t?.pending.get(txid) ?? null;
    const s = p ? null : this.sends.get(txid) ?? null;
    const offered = p ? Boolean(p.oneNode && !p.dropped) : Boolean(s && s.oneNode && !s.dropped && !s.confirmed);
    if (!offered) throw err('not-offered', 'Campfire is still checking this payment with the Firo nodes.');
    const seen = () => err('seen', 'The Firo node in use has this payment now: it is on its way, so it was not let go.');
    if (s && this.tagCheck?.state === 'disagree') throw err('not-offered', 'Campfire is still checking this payment with the Firo nodes.');
    if (s && (this.sparkSync?.mempool.has(txid) || [...this.ownCoins.values()].some((c) => c.spentTxid === txid))) throw seen();
    let none;
    try {
      none = await this._noSuchTx(this.client, txid);
    } catch {
      // Locked (or handed to another tab) while it was asked: that closed the connection (RE4-2).
      if (this._closed) throw err('not-open', 'The wallet was locked, so the payment was not let go.');
      throw err('offline', "The Firo node in use didn't answer, so the payment was not let go. Try again in a moment.");
    }
    if (!none) {
      // It left after all: followed as any payment on its way.
      if (p) await t.updatePending(txid, { oneNode: undefined, noSecondSince: undefined });
      else {
        delete s.oneNode;
        delete s.noSecondSince;
        await this._saveSpark().catch(() => {});
      }
      this._emit();
      throw seen();
    }
    if (this._closed) throw err('not-open', 'The wallet is locked.');
    // Let go only as the store keeps it: a write refused (locked meanwhile) or failed (storage)
    // changes nothing, also in memory, so its coins are never free here while the disk keeps it.
    const restore = (obj, before) => {
      for (const k of Object.keys(obj)) delete obj[k];
      Object.assign(obj, before);
    };
    let kept = false;
    let failure = null;
    if (p) {
      const before = { ...p };
      const rec = t.txs.get(txid);
      const recDropped = Boolean(rec && rec.dropped);
      try {
        kept = (await t.updatePending(txid, { dropped: true, letGo: true, unsure: undefined, noSecondSince: undefined, oneNode: undefined })) === true;
      } catch (e) {
        failure = e;
      }
      if (!kept) {
        restore(p, before);
        if (rec && !recDropped) delete rec.dropped;
      }
    } else {
      const before = { ...s };
      const marked = [...this.ownCoins.values()].filter((c) => c.pendingSpentTxid === txid);
      s.dropped = true;
      s.droppedAt = this.tip?.height ?? null;
      s.letGo = true;
      delete s.unsure;
      delete s.noSecondSince;
      delete s.oneNode;
      for (const c of marked) freeAsConflict(c);
      try {
        kept = (await this._saveSpark()).has(KEY.sends);
      } catch (e) {
        failure = e;
      }
      if (!kept) {
        restore(s, before);
        for (const c of marked) c.pendingSpentTxid = txid;
        await this._saveSpark().catch(() => {}); // a coin list written before the failure, put right if the store lets it
      }
    }
    this._emit();
    if (!kept) throw failure && !this._closed ? err('storage', 'This device could not save that, so the payment was not let go. Try again in a moment.') : err('not-open', 'The wallet was locked, so the payment was not let go.');
    return { txid, letGo: true };
  }

  /** Optional: heights and times of our Spark transactions, each asked for among 7 random others. */
  async _decoyDetails() {
    // Our coins found while restoring, and our spends not sent from here (their fee, a name).
    const spends = [...new Set([...this.ownCoins.values()].map((c) => c.spentTxid).filter((t) => t && !this.spendInfo.has(t)))];
    const want = [...new Set([...[...this.ownCoins.values()].filter((c) => c.heightApprox && c.groupId).map((c) => c.txid), ...spends])];
    if (!want.length) return;
    // Decoys (audit D-07: random ones changed on every ask, so two asks, e.g. around a Rescan,
    // intersected to exactly our coins). Now: chosen with a secret of this wallet, the same seven
    // for a txid every time (asking again adds nothing to compare); from every set downloaded, not
    // only the ones holding our coins; the batch padded to a multiple of 32. The seven are kept once
    // chosen (audit FE-6: picked by position in a pool that grows every block, they changed after
    // a Rescan on a later day, and two asks intersected to our own transactions again).
    const pool = [];
    const latest = await this.sparkSync.latestGroupId();
    for (let g = this.progress.firstGroup ?? 1; g <= latest; g++) {
      for (const c of (await this.sparkSync.coins(g)).sort((a, b) => a.index - b.index)) pool.push(c.txid);
    }
    const ask = new Set(want);
    if (pool.length) {
      const key = await globalThis.crypto.subtle.importKey('raw', await this._decoySalt(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const pick = async (label) => {
        const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(label)));
        return pool[(((mac[0] << 24) | (mac[1] << 16) | (mac[2] << 8) | mac[3]) >>> 0) % pool.length];
      };
      const kept = (await this.store.get(KEY.decoys)) ?? {};
      let added = false;
      for (const t of want) {
        let d = Array.isArray(kept[t]) && kept[t].length ? kept[t] : null;
        if (!d) {
          d = [];
          for (let i = 0; i < 7; i++) d.push(await pick(`${t}|${i}`));
          kept[t] = d;
          added = true;
        }
        for (const x of d) ask.add(x);
      }
      if (added) await this.store.put(KEY.decoys, kept);
      for (let n = 0; ask.size % 32 !== 0 && n < 4096; n++) ask.add(await pick(`pad|${ask.size}|${n}`));
    }
    const list = [...ask].sort();
    const res = await this.client.batch(list.map((t) => ['blockchain.transaction.get', [t, true]]));
    const info = new Map();
    list.forEach((t, i) => {
      const v = res[i];
      if (!v || v instanceof Error || !v.height) return;
      const fee = (v.vin || []).reduce((sum, x) => sum + (typeof x.nFees === 'number' ? Math.round(x.nFees * 1e8) : 0), 0);
      const name = (v.vout || []).some((o) => o && o.scriptPubKey && o.scriptPubKey.type === 'sparknamefee');
      info.set(t, { height: v.height, time: v.blocktime ?? v.time ?? null, fee, name });
    });
    for (const c of this.ownCoins.values()) {
      const x = info.get(c.txid);
      if (x) Object.assign(c, { height: x.height, time: x.time, heightApprox: false });
      const sp = c.spentTxid ? info.get(c.spentTxid) : null;
      if (sp) Object.assign(c, { spentHeight: sp.height, spentTime: sp.time });
    }
    for (const t of spends) {
      const x = info.get(t);
      if (x) this.spendInfo.set(t, x);
    }
    await this._saveSpark();
  }

  /** The store position up to which a second server agreed with our used tags (D-12); 0 when it never has. */
  _agreedTagIndex(tagState) {
    const a = this.progress.tagsAgreed;
    if (!tagState || !a || a.firstCursor !== tagState.firstCursor) return 0;
    return Math.max(0, Math.min(tagState.stored, a.count - tagState.firstCursor));
  }

  /**
   * Are the used tags (which coins are spent) the same on another Firo server? (audit D-12: one
   * server's list was believed as given; tags left out show spent coins of a restored wallet as
   * unspent, and payments of them fail.) Compared only when both servers are at the same block:
   * that server's count of all used tags must be the count ours gave, and each tag it lists from
   * where the two last agreed (the first time, every tag this wallet holds) must be among ours,
   * spent by the same transaction. The same question for every wallet: nothing about our coins.
   * -> this.tagCheck = {state: 'agree' | 'disagree' | 'unknown', at, ours, theirs}
   */
  async _checkTags() {
    const st = await this.sparkSync.tagState();
    const at = now();
    if (!st || !this.tip) return;
    const mine = this.tip.height;
    const agreed = this.progress.tagsAgreed && this.progress.tagsAgreed.firstCursor === st.firstCursor ? this.progress.tagsAgreed.count : st.firstCursor;
    const from = Math.max(st.firstCursor, Math.min(agreed, st.cursor) - TAG_OVERLAP);
    const theirs = await this._secondOpinion(async (c) => {
      const h = await c.subscribeHeaders();
      return h.height === mine ? { height: h.height, list: await c.sparkUsedTags(from) } : { height: h.height };
    }).catch(() => null);
    let state = this.ownNode ? 'own-node' : 'unknown';
    let count = null;
    if (theirs && theirs.list && this.tip?.height === mine) {
      count = from + theirs.list.length;
      let same = count === st.cursor;
      if (same) {
        const pairs = theirs.list.map(([t, x]) => {
          const tag = base64ToBytes(t);
          const tx = base64ToBytes(x);
          if (tag.length !== 34 || tx.length !== 32) same = false;
          return [tag.length === 34 ? lTagHash(tag) : '', tx.length === 32 ? hashToHex(tx) : ''];
        });
        const ours = await this.sparkSync.findUsed(pairs.map(([h]) => h), { from: Math.max(0, from - st.firstCursor - TAG_OVERLAP) });
        same = same && pairs.every(([h, x]) => ours.get(h) === x);
      }
      state = same ? 'agree' : 'disagree';
    }
    this.tagCheck = { state, at, ours: st.cursor, theirs: count, retrySoon: state === 'unknown' && !!theirs };
    if (state === 'agree') {
      this.progress.tagsAgreed = { count: st.cursor, firstCursor: st.firstCursor };
      await this.store.put(KEY.progress, this.progress);
    }
    this._emit();
  }

  /**
   * Is the server telling the same chain as another Firo server? (audit D-11: a frozen or lying
   * server stayed "Synced" while hiding what arrived.) The second's tip more than 3 blocks ahead:
   * ours is behind. Otherwise both must give the very same header at the lower of the two tips.
   * Ours ahead of the second: inconclusive (the second may be catching up). No second: unknown.
   */
  async _checkTip() {
    const mine = this.tip?.height;
    if (!mine) return;
    const at = now();
    const ask = (avoid) =>
      this._secondOpinion(
        async (c) => {
          const h = await c.subscribeHeaders();
          const m = Math.min(mine, h.height);
          return { url: c.server, height: h.height, at: m, header: await c.blockHeader(m) };
        },
        { avoid },
      ).catch(() => null);
    let theirs = await ask([]);
    let lowest = theirs ? theirs.height : null;
    // Far behind the node in use: a node lagging, or the node in use on a chain of its own. Another
    // node is asked before it counts (audit L3: one lagging node paused every payment). Payments are
    // still signed at the lower of the two (N10: a node agreeing with the one in use on an invented tip
    // would otherwise hold them back until the chain got there).
    if (theirs && mine > theirs.height + TIP_LEAD_DISAGREE && theirs.url) {
      const another = await ask([theirs.url]);
      if (another) theirs = another;
    }
    let state = this.ownNode ? 'own-node' : 'unknown';
    if (theirs) {
      if (theirs.height > mine + 3) state = 'disagree';
      // Far ahead of every other node is no catching up: it disagrees (P7: more than 3 was always
      // "unknown", which skipped the header check and kept its tip for signing).
      else if (mine > theirs.height + TIP_LEAD_DISAGREE) state = 'disagree';
      else if (mine > theirs.height + 3) state = 'unknown';
      else state = (await this.client.blockHeader(theirs.at)) === theirs.header ? 'agree' : 'disagree';
    }
    this.serverCheck = { state, at, otherHeight: theirs ? Math.min(theirs.height, lowest ?? theirs.height) : null };
    this._emit();
  }

  /**
   * Public payments to this wallet are believed only with proof (audit D-01, FE-1: one server could
   * show a confirmed payment that does not exist, and the wallet would count and spend it). The
   * proof is the gate: transparent.js counts an output as confirmed and spendable only when its
   * transaction is proven. For each in a block (PROVE_AT): the node's Merkle branch must lead to
   * the root in the header it gives for that height, and a second Firo node must give the very same
   * header. Proven: 'two-servers'. No second node answering is no proof (release re-audit R1-3: one
   * node in use that invents a payment, with the others blocked, had it counted, "Confirmed" and
   * spent as 'one-server'): 'unproven', asked again at the next sync, as is a 'one-server' record
   * 0.1.3 kept. Per transaction: no branch or header from the node ('unproven') is asked again at
   * the next sync; a branch that does not match ('failed') PROVE_RETRY blocks later; a second node
   * giving another header is named (r.disagreed) and another node is asked at the next sync: only
   * two different nodes disagreeing fail it (audit FE-8). The person's own node is
   * believed by its own word ('own-node'). The verdict is kept with the record, and only a new
   * block for the transaction sets it aside.
   */
  async _proveReceipts() {
    const tip = this.tip?.height ?? 0;
    const t = this.transparent;
    const todo = [];
    for (const [txid, r] of t.txs) {
      if (r.dropped) continue;
      const at = r.height;
      if (!(at > 0) || tip - at + 1 < PROVE_AT) continue;
      // A payment of this wallet's own is proven too, change back or not: one still followed (audit
      // X6: one with none was let go of on one node's word once six blocks deep, and its coins freed),
      // and one that spends this wallet's coins (second audit N5: a Make private with no change was
      // 'not-ours' for good, so the private coin it made waited for the slow proof of every set).
      const ownPending = t.pending.has(txid);
      const ownIn = r.decoded.vin.some((i) => {
        const out = i.txid ? t.txs.get(i.txid)?.decoded.vout[i.vout] : null;
        return Boolean(out && t.isOwnScript(out.script));
      });
      if (PROVEN.has(r.proof) || (r.proof === 'not-ours' && !ownPending && !ownIn)) continue;
      if (r.proof === 'failed' && tip < (r.failedAt ?? 0) + PROVE_RETRY) continue;
      if (!ownPending && !ownIn && !r.decoded.vout.some((o) => o.type === 'p2pkh' && t.ownEntryForScript(o.script))) {
        r.proof = 'not-ours';
        await t.putTx(txid, r);
        continue;
      }
      todo.push([txid, r, at]);
    }
    if (!todo.length) return;
    const verdicts = new Map();
    if (this.ownNode) {
      for (const [txid] of todo) verdicts.set(txid, 'own-node');
    } else {
      const heights = [...new Set(todo.map(([, , at]) => at))];
      const hdr = await this.client.blockHeaders(heights);
      const headers = new Map(heights.map((h, i) => [h, typeof hdr[i] === 'string' ? hdr[i] : null]));
      const branches = await this.client.getMerkles(todo.map(([txid, , at]) => [txid, at]));
      const merkleOk = new Map();
      todo.forEach(([txid, , at], i) => {
        const m = branches[i];
        const h = headers.get(at);
        merkleOk.set(txid, m instanceof Error || !h ? null : sameBytes(merkleRootOf(txid, m.merkle, m.pos), hexToBytes(h).subarray(36, 68)));
      });
      // The second node: one that has not disagreed about this payment before (audit FE-8: one node
      // giving another header kept every receipt unspendable, retried with that same node).
      const groups = new Map(); // avoid-list key -> {avoid, heights}
      for (const [txid, r, at] of todo) {
        if (merkleOk.get(txid) !== true) continue;
        const avoid = [...new Set(r.disagreed ?? [])].sort();
        const key = avoid.join(' ');
        if (!groups.has(key)) groups.set(key, { avoid, heights: new Set() });
        groups.get(key).heights.add(at);
      }
      const seconds = new Map(); // key -> {url, headers: Map height -> hex | null} | null (none answered)
      for (const [key, { avoid, heights }] of groups) {
        const hs = [...heights];
        seconds.set(
          key,
          await this._secondOpinion(
            async (c) => {
              const res = await c.blockHeaders(hs);
              return { url: c.server, headers: new Map(hs.map((h, i) => [h, typeof res[i] === 'string' ? res[i] : null])) };
            },
            { avoid },
          ).catch(() => null),
        );
      }
      for (const [txid, r, at] of todo) {
        const ok = merkleOk.get(txid);
        const before = [...new Set(r.disagreed ?? [])];
        const second = ok === true ? seconds.get([...before].sort().join(' ')) : null;
        let v;
        if (ok === null) v = 'unproven';
        else if (!ok) v = 'failed';
        // No second node answered: one node's word, not a proof (R1-3); asked again next sync.
        else if (!second) v = 'unproven';
        else if (second.headers.get(at) == null) v = 'unproven';
        else if (second.headers.get(at) === headers.get(at)) v = 'two-servers';
        else if (at >= tip) v = 'unproven'; // a fork race at the tip: asked again
        else {
          // Named, and asked of another node next time; failed once two different nodes disagree.
          r.disagreed = [...new Set([...before, second.url].filter(Boolean))];
          v = r.disagreed.length >= 2 ? 'failed' : 'unproven';
        }
        verdicts.set(txid, v);
      }
    }
    for (const [txid, r] of todo) {
      const v = verdicts.get(txid);
      r.proof = v;
      if (v === 'failed') r.failedAt = tip;
      else delete r.failedAt;
      if (PROVEN.has(v)) delete r.disagreed;
      await t.putTx(txid, r);
    }
    this._emit();
  }

  // ------------------------------------------------------------ Spark addresses

  async _sparkAddress(diversifier) {
    if (this._sparkAddresses.has(diversifier)) return this._sparkAddresses.get(diversifier);
    const isTestNet = this.net.id !== 'main';
    const a = this._sparkKey
      ? await this.spark.getAddress({ keyData: this._sparkKey, index: SPARK_KEY_INDEX, diversifier, isTestNet })
      : await this.spark.getAddressFromFullViewKey({ fullViewKey: this._fvk, index: SPARK_KEY_INDEX, diversifier, isTestNet });
    if (!isSparkAddressShape(a, this.net)) throw err('server', 'The Spark library made an address that does not look like one.');
    this._sparkAddresses.set(diversifier, a);
    return a;
  }

  async _ensureSparkAddress() {
    if (!this._sparkEnabled()) return;
    await this._sparkAddress(this.sparkAddr.diversifier);
    this._emit();
  }

  async newSparkAddress() {
    if (!this._sparkEnabled()) throw notYet('Spark');
    let d = this.sparkAddr.diversifier + 1;
    if (d === SPARK_CHANGE_DIVERSIFIER) d++;
    const a = await this._sparkAddress(d);
    this.sparkAddr = { diversifier: d };
    await this.store.put(KEY.sparkAddr, this.sparkAddr);
    this._emit();
    return a;
  }

  async newTransparentAddress() {
    if (!this.transparent) throw notYet('A public address in this view-only wallet');
    const e = await this.transparent.newReceiveAddress();
    this._emit();
    return e.address;
  }

  // ------------------------------------------------------------ anonymity sets (audit D-09)

  /**
   * The groups a private payment from `coins` checks, newest first: each coin's group, and for a
   * coin among the ones its group carried over from the group before, that group too (its chain,
   * not the later group's, is the one that covers the coin).
   */
  async _setGroupsFor(coins) {
    const out = new Set();
    const carry = new Map();
    for (const c of coins) {
      if (!c.groupId) continue;
      out.add(c.groupId);
      if (!carry.has(c.groupId)) carry.set(c.groupId, (await this.sparkSync.verifiedState(c.groupId))?.carry ?? 0);
      if (c.index != null && c.index < carry.get(c.groupId) && (await this.sparkSync.groupState(c.groupId - 1))) out.add(c.groupId - 1);
    }
    return [...out].sort((a, b) => b - a);
  }

  /**
   * In the background, a little each sync: the newest group's hash, the set most payments are made
   * over. Every wallet with Spark does this, coins in it or not: checking only the groups that hold
   * this wallet's coins would tell the server which they are before any payment does (a payment
   * names its groups on chain, so the older ones are checked then, in _checkedSets).
   */
  async _verifyLatestSet({ maxHeights }) {
    const tipHeight = this.tip?.height;
    if (!tipHeight) return;
    const g = await this.sparkSync.latestGroupId();
    if (await this.sparkSync.groupState(g)) await this.sparkSync.verifyGroup(g, { tipHeight, maxHeights });
  }

  _setRefused(code, groups) {
    for (const g of groups) this._refusedGroups.add(g);
    // Another public node is offered only to someone on Firo's public nodes, never in place of their own.
    return Object.assign(err(code, SET_WORDS[code]), { otherServer: code !== 'set-unchecked' && !this.ownNode });
  }

  /**
   * The anonymity sets of `groups` for a private payment from `coins`, each checked before anything
   * is built (audit D-09: the server's coins went to the proof under the server's hash, so it
   * could serve fewer or other coins and learn from whether the payment was made):
   *   1. its hash, recomputed from the coins held (spark_sethash.js), is the very hash the payment
   *      commits to; a coin among those its group carried over is covered by the group before's
   *      chain, which is checked too;
   *   2. a second Firo server reports that hash (and the hash the chain began from), since a
   *      server can hash whatever coins it serves. No second server answering: one server's word,
   *      as for names.
   * Otherwise nothing is built: 'set-mismatch', 'set-disagree' (both with otherServer: true) or
   * 'set-unchecked'.
   */
  async _checkedSets(groups, coins) {
    // Said on Review while it runs: the first private payment from a set can wait on it (~25 s).
    this.sendStage = 'checking-coins';
    this._emit();
    try {
      return await this._checkSets(groups, coins);
    } finally {
      this.sendStage = null;
      this._emit();
    }
  }

  async _checkSets(groups, coins, { verdict = false } = {}) {
    const sets = new Map();
    const states = new Map();
    const check = async (g) => {
      for (let i = 0; i < 3; i++) {
        const set = await this.sparkSync.anonymitySet(g);
        // In parts, each one kept as it is done (second audit N5: an old group was checked in one go,
        // and one network error started it again from the beginning).
        let r;
        do r = await this.sparkSync.verifyGroup(g, { tipHeight: this.tip?.height ?? 0, maxHeights: this._verifyHeightsPerPart });
        while (r.state === 'partial' && r.read > 0);
        if (r.state === 'mismatch') throw this._setRefused('set-mismatch', [g]);
        if (r.state === 'match' && r.size === set.size && r.setHash === set.setHash) {
          states.set(g, { g, set, v: await this.sparkSync.verifiedState(g) });
          return set;
        }
        // A coin in a block past the tip known here, or the set moved on meanwhile: the tip, then again.
        await this.client.subscribeHeaders().catch(() => {});
      }
      throw this._setRefused('set-unchecked', [g]);
    };
    for (const g of groups) sets.set(g, await check(g));
    for (const g of await this._setGroupsFor(coins)) if (!states.has(g)) await check(g);
    const confirmed = await this._confirmSets([...states.values()]);
    return verdict ? confirmed : groups.map((g) => sets.get(g));
  }

  /**
   * Private payments to this wallet are believed only with proof, as public ones (public audit, P4:
   * a coin one server served, made to this wallet's key off the chain, showed as received). The
   * proof is the check a payment makes of its sets (_checkSets): each set's hash recomputed from
   * the coins held, and the same hash given by a second Firo node. One node alone is no proof; the
   * person's own node is. A little each sync while a coin waits for it.
   */
  async _proveSparkReceipts() {
    const todo = [...this.ownCoins.values()].filter((c) => this._needsSparkProof(c));
    if (!todo.length) return;
    let verdict = 'own-node';
    let vouched = null; // group -> how much of it the second node vouched for (N1)
    if (!this.ownNode) {
      // Every set this wallet holds, newest first, never only the ones with its coins: which sets
      // those are stays this wallet's business, as for the background check (_verifyLatestSet).
      const latest = await this.sparkSync.latestGroupId();
      const groups = [];
      for (let g = latest; g >= (this.progress.firstGroup ?? 1); g--) if (await this.sparkSync.groupState(g)) groups.push(g);
      // An old or restored wallet's first look reads every block since Spark began (about a quarter
      // of an hour on mainnet): a part of it each sync, each part kept, so no sync is held up long and
      // new blocks keep being followed meanwhile (second audit N9, measured on mainnet 2026-10-16).
      const until = Date.now() + this._proveMsPerSync;
      // Work left when the time is up: more at once, the checks only (third audit F3: waiting for the
      // next block made it take about 65 minutes instead of 26, or days for a wallet opened briefly).
      // Only after a part that read something (fourth audit N3: never a loop that reads nothing).
      let read = 0;
      const more = () => {
        if (read > 0) this._proofAgain = true;
      };
      for (const g of groups) {
        for (;;) {
          if (this._closed) return;
          const r = await this.sparkSync.verifyGroup(g, { tipHeight: this.tip?.height ?? 0, maxHeights: this._verifyHeightsPerPart });
          read += r.read ?? 0;
          if (r.state !== 'partial' || r.read === 0) break;
          if (Date.now() > until) return more(); // on from here, next
        }
        if (Date.now() > until) return more();
      }
      try {
        ({ verdict, vouched } = await this._checkSets(groups, todo, { verdict: true }));
      } catch (e) {
        // A node whose lists do not add up, or a second node that disagrees: said on Home, with the
        // way to another node, as on Review (a refusal of no answer is asked again next sync).
        if (e && (e.code === 'set-mismatch' || e.code === 'set-disagree')) {
          this.privateCheck = { code: e.code, otherServer: e.otherServer === true };
          this._emit();
        }
        throw e;
      }
    }
    if (this.privateCheck) {
      this.privateCheck = null;
      this._emit();
    }
    if (!PROVEN.has(verdict)) return;
    // Proven is a coin the checked sets hold, with its bytes: a coin kept from a set since dropped
    // (audit E2: "Try another node" made a caught fake coin a proven one) is not; it waits, never
    // counted. Nothing is deleted here (audit N3: a real coin whose place a reorganisation moved was):
    // a set downloaded anew lets go of what it does not hold (_identify).
    for (const c of todo) {
      if (!(await this._inHeldSet(c))) continue;
      // Only what the second node vouched for (N1): a coin past it waits for the next look.
      if (vouched && !(c.index < (vouched.get(c.groupId) ?? 0))) continue;
      c.proof = verdict;
    }
    await this._saveSpark();
    this._emit();
  }

  /**
   * A second Firo server's word on each checked set: the same hash for the same block; or, when
   * it has newer coins of the group, our hash carried on over them (placed in their blocks by that
   * server) reaches its hash; or, when it is a little behind, its hash is one ours passed through.
   * And the hash a later group's chain began from is that server's last hash of the group before,
   * and the coins no hash covers (group 1's first block, 5 coins on mainnet) are the same there.
   * -> 'two-servers' | 'one-server' (none answered) | 'own-node' (the person's own node: none asked); throws 'set-disagree'.
   */
  async _confirmSets(list) {
    // Asked about every group this wallet holds, not only the ones checked: which those are is
    // this wallet's business until the payment shows it.
    const held = [];
    const latest = Math.max(0, ...Object.keys(this.progress.groups ?? {}).map(Number), ...list.map((x) => x.g));
    for (let g = this.progress.firstGroup ?? 1; g <= latest; g++) if (await this.sparkSync.groupState(g)) held.push(g);
    const answer = await this._secondOpinion(async (c) => {
      const tip = (await c.subscribeHeaders()).height;
      const metas = new Map();
      for (const g of new Set([...held, ...list.map((x) => x.g)])) metas.set(g, await c.sparkSetMeta(g));
      const out = new Map();
      for (const { g, set, v } of list) {
        const m = metas.get(g);
        const before = v.carry > 0 ? (metas.get(g - 1) ?? (await c.sparkSetMeta(g - 1))) : null;
        let ext = null;
        if (m.blockHash !== set.blockHash && m.size > set.size) {
          // That server has newer coins of the group: our hash, carried on over them (placed in their
          // blocks by that server), must reach its hash.
          try {
            const raw = await c.sparkSetSector(g, m.blockHash, 0, m.size - set.size);
            const newer = raw.map(decodeSetEntry).reverse().map((e) => ({ txid: hashToHex(e.txHash), body: coinBody(e) }));
            const r = await extendSetHash({ hash: base64ToBytes(v.hash), height: v.height, coins: newer, tipHeight: tip, blockTxids: (hs) => c.blockTxids(hs) });
            if (r.placed === newer.length) ext = bytesToBase64(r.hash);
          } catch (e) {
            if (!(e instanceof SetHashError)) throw e;
          }
        }
        // Group 1's first block is in no hash (firod): its few coins are compared one by one.
        let first = null;
        if (v.unhashed > 0) {
          try {
            first = (await c.sparkSetSector(g, set.blockHash, set.size - v.unhashed, set.size)).map((e) => bytesToHex(coinBody(decodeSetEntry(e)))).reverse();
          } catch (e) {
            // An answer, but an error: that server does not know our block (another chain). Not "no answer".
            if (!(e instanceof ElectrumError) || e.code !== 'server') throw e;
            first = [];
          }
        }
        out.set(g, { m, before, ext, first });
      }
      return out;
    }).catch(() => null);
    if (!answer) return { verdict: this.ownNode ? 'own-node' : 'one-server', vouched: null };
    // How much of each set the second node vouched for: all of it, or, when it is behind, as far as
    // its own (audit N1: a node in use a block ahead of every other put a coin made off the chain in
    // that block, and it was taken as confirmed with the rest).
    const vouched = new Map();
    for (const { g, set, v } of list) {
      const { m, before, ext, first } = answer.get(g);
      let same;
      if (m.blockHash === set.blockHash) same = m.setHash === set.setHash && m.size === set.size;
      else if (m.size > set.size) same = ext === m.setHash;
      else same = (v.checkpoints ?? []).some((cp) => cp.size === m.size && cp.hash === m.setHash);
      if (first && first.join() !== set.coins.slice(0, v.unhashed).map((c) => bytesToHex(coinBody(c))).join()) same = false;
      if (!same || (before && before.setHash !== v.startHash)) throw this._setRefused('set-disagree', list.map((x) => x.g));
      vouched.set(g, Math.min(set.size, m.size));
    }
    return { verdict: 'two-servers', vouched };
  }

  /**
   * After a private payment was stopped over its coin lists (audit D-09): the wallet moves to the
   * next server of its list, and the lists in question are dropped and fetched again from there
   * (this wallet's coins in them looked for again). -> {server}
   */
  async useAnotherServer() {
    if (!this.opened) throw err('not-open', 'The wallet is not open.');
    const current = this.client?.server ?? null;
    const others = this.servers.filter((u) => u !== current);
    if (!others.length) throw err('no-other-server', 'Only one server is chosen. Add another in Settings, Servers, then try again.');
    // setServers drops the lists in question (as any change of node does: audit FE-7).
    await this.setServers([...others, ...(current ? [current] : [])], { ownNode: this.ownNode });
    return { server: others[0] };
  }

  /**
   * On any change of node (audit FE-7: only "Try another node" did this, so a node chosen on the
   * Firo nodes screen was refused over the last node's list): the sets a payment was stopped over,
   * and any set marked as not adding up, are dropped and fetched again from the new node, then
   * checked from the start.
   */
  async _forgetRefusedSets() {
    const drop = new Set(this._refusedGroups);
    this._refusedGroups.clear();
    this.privateCheck = null;
    if (!this.sparkSync || !this.progress) return;
    for (const g of Object.keys(this.progress.groups ?? {}).map(Number)) if ((await this.sparkSync.verifiedState(g))?.bad) drop.add(g);
    if (!drop.size) return;
    for (const g of drop) {
      await this.sparkSync.dropGroup(g);
      delete this.progress.groups[g];
    }
    // Their coins waiting for proof go with them (audit E2): a real one is found again in the set
    // downloaded anew, a fake one is not.
    for (const [k, c] of this.ownCoins) {
      if (drop.has(c.groupId) && this._needsSparkProof(c) && !c.pendingSpentTxid) {
        this.ownCoins.delete(k);
        this._mempoolLookAgain(c.txid); // back in the mempool, perhaps: looked at there again (eleventh audit)
      }
    }
    this.progress.relook = true; // the real ones found again: placed, not dated today (M1)
    await this.store.put(KEY.progress, this.progress);
    await this._saveSpark();
  }

  // ------------------------------------------------------------ names

  async _allNames(maxAgeMs = 60000) {
    if (this._names && Date.now() - this._names.at < maxAgeMs) return this._names.list;
    try {
      const list = await this.client.sparkNames();
      this._names = { at: Date.now(), list };
      return list;
    } catch (e) {
      throw apiError(e);
    }
  }

  /** The Spark address a name points to, or null. Looked up in the full list (no per-name query). */
  async resolveSparkName(name) {
    const n = String(name ?? '').replace(/^@/, '');
    if (!isValidSparkName(n)) return null;
    const hit = (await this._allNames()).find((e) => e.name.toUpperCase() === n.toUpperCase());
    return hit ? hit.address : null;
  }

  /**
   * A Spark name about to be paid (audit D-02). The server the wallet is on answers who the name
   * is; that alone could hand the payment to anyone, so:
   * - a second Firo server is asked about the same name, and two different answers stop the
   *   payment (no answer from it: it goes ahead, said as checked with one server only);
   * - the address this wallet paid the name before is kept, and a different answer stops the
   *   payment until the person has seen both addresses and accepts the new one.
   * -> {address, checked: 'two-servers' | 'one-server' | 'own-node'} | null (no such name).
   */
  async resolveSparkNameForPayment(name, { acceptChange = false } = {}) {
    const n = String(name ?? '').replace(/^@/, '');
    if (!isValidSparkName(n)) return null;
    const address = await this.resolveSparkName(n);
    if (!address) return null;
    const second = await this._secondOpinion((c) => c.sparkNameData(n)).catch(() => undefined);
    // null: the second node answered that no one has the name. That is a disagreement too, never
    // "unchecked": one node alone would then decide who is paid (public audit, P8).
    if (second === null) {
      throw Object.assign(err('name-conflict', `One Firo node says @${n} is a Spark name and another says no one has it, so nothing can be sent to this name now. A name registered moments ago can take a few minutes to reach every node; otherwise one of them is wrong. Try again in a few minutes, or ask the person for their address.`), { name: n, answers: [address, null] });
    }
    if (second && second.address !== address) {
      throw Object.assign(err('name-conflict', `Two Firo nodes disagree about who @${n} is, so nothing can be sent to this name now. Ask the person for their address instead.`), { name: n, answers: [address, second.address] });
    }
    const pinned = this.namePins.get(n.toUpperCase());
    if (pinned && pinned !== address && !acceptChange) {
      throw Object.assign(err('name-changed', `@${n} now points to a different address than the one you paid before.`), { name: n, before: pinned, now: address });
    }
    return { address, checked: second && second.address === address ? 'two-servers' : this.ownNode ? 'own-node' : 'one-server' };
  }

  /** This wallet's secret for picking decoys (made once, kept in its sealed store). */
  async _decoySalt() {
    let hex = await this.store.get(KEY.decoySalt);
    if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
      hex = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
      await this.store.put(KEY.decoySalt, hex);
    }
    return hexToBytes(hex);
  }

  /** After a payment to @name went out: the address it went to is the one expected next time. */
  async pinSparkName(name, address) {
    const n = String(name ?? '').replace(/^@/, '').toUpperCase();
    if (!n || typeof address !== 'string' || !address) return;
    this.namePins.set(n, address);
    await this.store.put(KEY.namePins, Object.fromEntries(this.namePins));
  }

  /**
   * fn(client) on another of the nodes (not the one in use), on short-lived connections, so that no
   * single public node can lie unseen. Never when the person reads the chain from a node of their own
   * (this.ownNode): that node is their truth, and they chose it so that no one else sees their IP
   * address or which payments are theirs. Rejects 'offline' when none opens within SECOND_WAIT_MS,
   * 'closed' when the wallet is locked meanwhile (a lock ends it at once: re-audit 5 RE5-5).
   *
   * Release re-audit 4 RE4-1: the other nodes are opened together, each with the whole
   * SECOND_WAIT_MS, so a node that never opens delays nobody for long and a slow, honest one is
   * waited for. The question goes to one node at a time (its answer may be ~24 MB, the first used-tag
   * list, and the nodes need not all learn what this wallet asks): the first in this question's
   * rotating order (RE3-2) of the nodes open. Re-audit 5 RE5-2: not simply the first to open, or one
   * node faster than the rest would be every second opinion (a lying one then froze for good what
   * the rotation healed within a few syncs): once the first node opens, the ones ahead of it in the
   * order are waited for up to SECOND_GRACE_MS, or twice as long as that first open took when that is
   * longer, at most SECOND_GRACE_MAX_MS (re-audit 6 RE6-1; never past SECOND_WAIT_MS), then the first open in
   * the order is asked. A node that opens later still counts when none of those can be asked. One
   * that loses the connection before it answers hands the question to the next open one; an answer,
   * even an error, is that node's. Every connection is closed once there is an answer or none can
   * be had, also one still opening.
   */
  async _secondOpinion(fn, { avoid = [] } = {}) {
    if (this.ownNode) throw err('own-node', 'Your own node is the only one this wallet asks.');
    if (this._closed) throw new ElectrumError('closed', 'The wallet was locked.');
    // The node in use. While the main connection is down or moving to the next node, client.server
    // is null (release re-audit 5 RE5-3: the node in use was then one of the "others", contacted by
    // every second opinion and asked when first in order): the node it was last on, and the one it
    // is moving to, which will answer its next question.
    const current = [this.client?.server, this._lastServer, this.client?.target];
    const others = [...this.servers, ...this.net.servers].filter((u, i, a) => !current.includes(u) && a.indexOf(u) === i && !avoid.includes(u));
    if (!others.length) throw err('offline', 'No second Firo node to ask.');
    const start = this._secondTurn++ % others.length;
    const order = [...others.slice(start), ...others.slice(0, start)];
    const connectTimeoutMs = Math.min(SECOND_WAIT_MS, this.electrumOpts?.connectTimeoutMs ?? SECOND_WAIT_MS);
    const clients = order.map((url) => new ElectrumClient({ servers: [url], WebSocket: this.WebSocket, ...this.electrumOpts, reconnect: false, timeoutMs: SECOND_WAIT_MS, connectTimeoutMs }));
    // Each node: opening, open (`connected`), or out (could not open, or opened and closed again).
    const opened = new Set();
    const out = new Set();
    const tried = new Set();
    let wake = null;
    const changed = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const offs = clients.map((c, k) => {
      c.connect().then(
        () => {
          opened.add(k);
          changed();
        },
        () => {
          out.add(k);
          changed();
        },
      );
      return c.on('status', changed); // an open one that closes
    });
    // A lock ends it (release re-audit 5 RE5-5): every connection closed, the wait woken, nothing more asked.
    let stopped = false;
    const opinions = this._opinions;
    const stop = () => {
      stopped = true;
      for (const c of clients) c.close();
      changed();
    };
    opinions.add(stop);
    // Until a node opens or closes, or `ms` pass.
    const waitFor = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    const startedAt = Date.now();
    const capAt = startedAt + SECOND_WAIT_MS;
    let graceAt = null; // the first node opened: those ahead of it in the order are waited for until then
    let lost = null;
    try {
      for (;;) {
        if (stopped || this._closed) throw new ElectrumError('closed', 'The wallet was locked.');
        // In the order: the nodes not asked yet that are open or still opening.
        const live = clients.map((c, k) => k).filter((k) => !tried.has(k) && !out.has(k) && (clients[k].connected || !opened.has(k)));
        const i = live.find((k) => clients[k].connected);
        const t = Date.now();
        if (i === undefined) {
          if (!live.length) throw lost ?? err('offline', 'No second Firo node could be reached.');
          if (t >= capAt) throw err('offline', 'No second Firo node opened in time.');
          await waitFor(capAt - t);
          continue;
        }
        // Twice as long as the first open took, between SECOND_GRACE_MS and SECOND_GRACE_MAX_MS (re-audit 6
        // RE6-1): on a slow link, where every node takes seconds to open, a fixed grace let a node a little
        // faster than the rest be every second opinion again. Capped: a dark node ahead never opens, and
        // waiting for it costs every question that much.
        const grace = Math.min(SECOND_GRACE_MAX_MS, Math.max(SECOND_GRACE_MS, 2 * (t - startedAt)));
        if (graceAt === null) graceAt = Math.min(t + grace, capAt);
        // Nodes ahead of it in the order still opening: the order decides among nodes that open close together.
        if (live[0] !== i && t < graceAt) {
          await waitFor(graceAt - t);
          continue;
        }
        tried.add(i);
        try {
          return await fn(clients[i]);
        } catch (e) {
          // No answer, the connection gone (not a timeout: that spent the time already): the next one.
          if (!(e instanceof ElectrumError) || (e.code !== 'offline' && e.code !== 'closed')) throw e;
          lost = e;
          clients[i].close();
        }
      }
    } finally {
      opinions.delete(stop);
      for (const off of offs) off();
      for (const c of clients) c.close();
    }
  }

  /** This wallet's names as the full list gives them: [{name, address, validUntil, additionalInfo}]. */
  async _ownNames() {
    if (!this._sparkEnabled()) throw notYet('Spark names');
    const mine = new Set();
    for (let d = 1; d <= this.sparkAddr.diversifier; d++) if (d !== SPARK_CHANGE_DIVERSIFIER) mine.add(await this._sparkAddress(d));
    return (await this._allNames()).filter((e) => mine.has(e.address));
  }

  async _listOwnNames() {
    return (await this._ownNames()).map((e) => ({ name: e.name, address: e.address }));
  }

  /**
   * This wallet's names with their expiry and extra information, from the full list every wallet
   * fetches (audit D-10: asking the server about each own name told it which names, and so which
   * Spark address, are this wallet's). On a server whose list lacks them: null, unknown, until the
   * person asks about one name (details).
   */
  async _listOwnNamesDetailed() {
    return (await this._ownNames()).map((e) => ({ name: e.name, address: e.address, validUntil: e.validUntil ?? null, additionalInfo: e.additionalInfo ?? null }));
  }

  /**
   * One of this wallet's names asked about by name (spark.getsparknamedata): only when the person
   * asks, for a name the full list gave no expiry for. -> {validUntil, additionalInfo}
   */
  async _ownNameDetails(name) {
    const n = String(name ?? '').replace(/^@/, '').toLowerCase();
    const entry = (await this._ownNames()).find((e) => e.name.toLowerCase() === n);
    if (!entry) throw err('invalid-name', `"${name}" is not one of this wallet's names.`);
    let d;
    try {
      d = await this.client.sparkNameData(entry.name);
    } catch (e) {
      throw apiError(e);
    }
    if (!d) throw err('server', 'The server has no record of this name.');
    return { validUntil: d.validUntil ?? null, additionalInfo: d.additionalInfo ?? '' };
  }

  /** Whether a name is free to register (from the full list: no per-name query). */
  async _nameIsFree(name) {
    const n = String(name ?? '').replace(/^@/, '');
    if (!isValidSparkName(n)) return false;
    return !(await this._allNames(0)).some((e) => e.name.toUpperCase() === n.toUpperCase());
  }

  // ------------------------------------------------------------ masternodes

  /**
   * This wallet's masternodes, as Campfire finds them: its coins of exactly 1,000 FIRO, whether the
   * network counts each as masternode collateral (blockchain.checkifmncollateral), the
   * registration among this wallet's own transactions that names it, and that masternode's state
   * (protx.info). -> [{collateral, amount, isCollateral, proTxHash, info}]
   */
  /**
   * Coins of exactly 1,000 FIRO: asked of the node whether each is a masternode's collateral
   * (blockchain.checkifmncollateral). Only a clear "no" lets one be spent; no answer keeps it locked
   * (audit P3: a send or privatize could spend a masternode's collateral and stop its rewards).
   */
  async _checkCollateral() {
    const t = this.transparent;
    if (!t || !this.client) return;
    const tipH = this.tip?.height ?? 0;
    for (const u of t.utxos(tipH)) {
      if (BigInt(u.value) !== MN_COLLATERAL) continue;
      const k = `${u.txid}:${u.vout}`;
      if (t.collateral.has(k)) continue;
      const r = await this.client.request('blockchain.checkifmncollateral', [u.txid, String(u.vout)]).then((x) => (x === true ? 'yes' : x === false ? 'no' : null), () => null);
      if (r) t.collateral.set(k, r);
    }
  }

  async _listMasternodes() {
    if (!this.transparent) throw notYet('Masternodes in a view-only wallet');
    const tipH = this.tip?.height ?? 0;
    const COLLATERAL = 1000n * 100000000n;
    const regs = new Map();
    for (const [txid, r] of this.transparent.txs) {
      const d = r.decoded;
      if (!d || d.type !== 1 || !d.extraPayload) continue;
      const c = proRegCollateral(d.extraPayload);
      if (c) regs.set(`${c.txid ?? txid}:${c.vout}`, txid);
    }
    const out = [];
    for (const u of this.transparent.utxos(tipH)) {
      if (BigInt(u.value) !== COLLATERAL) continue;
      const id = `${u.txid}:${u.vout}`;
      const isCollateral = await this.client.request('blockchain.checkifmncollateral', [u.txid, String(u.vout)]).then((x) => x === true, () => null);
      const proTxHash = regs.get(id) ?? null;
      let info = null;
      if (proTxHash) {
        const i = await this.client.request('protx.info', [proTxHash]).catch(() => null);
        if (i && i.state) {
          info = {
            service: String(i.state.service ?? ''),
            payoutAddress: String(i.state.payoutAddress ?? ''),
            registeredHeight: Number(i.state.registeredHeight) || null,
            lastPaidHeight: Number(i.state.lastPaidHeight) || null,
            posePenalty: Number(i.state.PoSePenalty) || 0,
            banned: Number(i.state.PoSeBanHeight) > 0,
            operatorReward: Number(i.operatorReward) || 0,
          };
        }
      }
      out.push({ collateral: id, amount: String(u.value), confirmations: u.confirmations, isCollateral, proTxHash, info });
    }
    return out;
  }

  // ------------------------------------------------------------ coins

  async _listCoins() {
    const tipH = this.tip?.height ?? 0;
    const out = [];
    const first = this.transparent?.conflictCoins() ?? new Set();
    for (const u of this.transparent?.utxos(tipH) ?? []) {
      const id = `${u.txid}:${u.vout}`;
      out.push({ id, kind: 'transparent', amount: String(u.value), address: u.address, height: u.height, confirmations: u.confirmations, frozen: u.frozen, ...(first.has(id) ? { spendFirst: true } : {}), ...(u.collateral ? { collateral: true } : {}), spendable: u.spendable, ...(u.unproven ? { unproven: true } : {}), label: this.labels[id] });
    }
    for (const c of this.ownCoins.values()) {
      if (c.spentTxid) continue;
      out.push({ id: c.lTagHash, kind: 'spark', amount: String(c.value), txid: c.txid, height: c.mempool ? null : c.height, frozen: false, spendable: !c.mempool && !c.pendingSpentTxid && !this._needsSparkProof(c), ...(this._needsSparkProof(c) ? { unproven: true } : {}), memo: c.memo || undefined, label: this.labels[c.lTagHash] });
    }
    return out;
  }

  async _freeze(id, frozen) {
    const m = /^([0-9a-f]{64}):(\d+)$/.exec(String(id));
    if (!m) throw notYet('Freezing Spark coins');
    await this.transparent.setFrozen(m[1], Number(m[2]), !!frozen);
    this._emit();
  }

  async _label(id, text) {
    if (text) this.labels[id] = String(text).slice(0, 200);
    else delete this.labels[id];
    await this.store.put(KEY.labels, this.labels);
  }

  // ------------------------------------------------------------ sending

  async _recipients(to) {
    if (!Array.isArray(to) || to.length === 0) throw err('invalid-address', 'Add someone to send to.');
    const out = [];
    for (const r of to) {
      const c = classify(r.address, this.net);
      let kind = c.kind;
      let address = c.address;
      if (kind === 'spark-name') {
        const a = await this.resolveSparkName(c.name);
        if (!a) throw err('invalid-address', `No Spark name "${c.name}" is registered.`);
        kind = 'spark';
        address = a;
      }
      if (kind === 'invalid') throw err('invalid-address', c.error ?? 'This is not a Firo address.');
      if (kind === 'spark' && sparkHas(this.spark, 'validate') && !(await this.spark.isValidSparkAddress({ address, isTestNet: this.net.id !== 'main' }))) {
        throw err('invalid-address', 'This Spark address is not valid.');
      }
      const amount = parseAmount(r.amount);
      if (amount < this.net.dust) throw err('dust', 'The amount is too small to send (under 0.00001 FIRO).');
      out.push({ kind, address, amount, memo: r.memo ?? '', name: c.kind === 'spark-name' ? c.name : undefined });
    }
    return out;
  }

  _needTip() {
    if (!this.tip) throw err('not-synced', 'Still connecting to the Firo network.');
    return this.tip.height;
  }

  /**
   * The height a payment is signed with as its locktime: the node in use's tip, or a second node's
   * when that one says less (audit P7: a node claiming a tip far ahead had payments signed that no
   * block could take yet; they read as dropped, and a resend paid twice once the first was mined).
   */
  _lockTip(tip) {
    const other = this.serverCheck?.otherHeight;
    return Number.isSafeInteger(other) && other > 0 && other < tip ? other : tip;
  }

  /** Works out a payment without sending it: {fee, total, change, warnings, build()}. */
  async _plan({ from, to, subtractFee = false, sendAll = false, opReturn = null, nameInfo = null }) {
    // Coded, as the stand-in engine does: nothing was built, so "not sent" (X-misc: uncoded, it read as "couldn't tell").
    if (from !== 'public' && from !== 'private') throw err('invalid', 'Pay from the private or the public balance.');
    if (this.viewOnly) throw err('NotYet', 'A view-only wallet cannot send.');
    const recips = await this._recipients(to);
    const tip = this._needTip();
    const warnings = [];
    if (from === 'public') {
      if (!this.transparent || this.syncState.phase === 'connecting' || !this.transparent.loaded) throw err('not-synced', 'The public balance is still syncing.');
      const fees = await this.transparent.feeRates().catch((e) => {
        throw apiError(e);
      });
      const transparentOuts = recips.filter((r) => r.kind !== 'spark').map((r) => ({ script: addressToScript(r.address, this.net), value: r.amount }));
      if (opReturn !== null) {
        const data = typeof opReturn === 'string' ? hexToBytes(opReturn) : opReturn;
        transparentOuts.push({ script: opReturnScript(data, this.net.maxOpReturnRelay), value: 0n });
      }
      const sparkOuts = recips.filter((r) => r.kind === 'spark');
      if (sparkOuts.length) {
        requireSpark(this.spark, 'mint', 'Paying a Spark address from the public balance');
        const own = new Set(this._sparkAddresses.values());
        if (sparkOuts.some((r) => !own.has(r.address))) warnings.push('Paying a Spark address from the public balance shows the amount on the blockchain.');
        return this._planMint({ sparkOuts, transparentOuts, feePerKb: fees.normal, tip, subtractFee, sendAll, warnings, recips });
      }
      return this._planTransparent({ outputs: transparentOuts, feePerKb: fees.normal, tip, subtractFee, sendAll, warnings, recips });
    }
    // private
    requireSpark(this.spark, 'spend', 'Sending from the private balance');
    if (!this._sparkKey) throw err('NotYet', 'A view-only wallet cannot send.');
    if (recips.some((r) => r.kind === 'exchange')) throw err('invalid-address', 'Sending to an exchange (EX) address from the private balance is not allowed. Send from your public balance.');
    if (!this._sparkReady) throw err('not-synced', 'The private balance is still syncing.');
    if (opReturn !== null) throw err('NotYet', 'Data (OP_RETURN) can only be sent from the public balance.');
    const transparentTotal = recips.filter((r) => r.kind !== 'spark').reduce((s, r) => s + r.amount, 0n);
    if (transparentTotal > this.net.sparkValueSpendLimitPerTx) throw err('insufficient', 'A private payment to public addresses can be at most 10,000 FIRO.');
    if (transparentTotal > 0n) warnings.push('The amount and the receiving address will be public on the blockchain.');
    return this._planSparkSpend({ recips, tip, subtractFee: subtractFee || sendAll, warnings, nameInfo });
  }

  _planTransparent({ outputs, feePerKb, tip, subtractFee, sendAll, warnings, recips }) {
    let plan;
    try {
      plan = this.transparent.planSend({ outputs, feePerKb, tipHeight: tip, subtractFee, sendAll });
    } catch (e) {
      throw apiError(e);
    }
    const sent = plan.outputs.filter((o) => !o.change).reduce((s, o) => s + o.value, 0n);
    return {
      kind: 'transparent',
      fee: plan.fee,
      total: sent + plan.fee,
      change: plan.change,
      warnings,
      build: async () => {
        const signed = this.transparent.signPlan(plan, this._lockTip(tip));
        return { hex: signed.hex, txid: signed.txid, fee: signed.fee, recips };
      },
    };
  }

  async _planMint({ sparkOuts, transparentOuts, feePerKb, tip, subtractFee, sendAll, warnings, recips }) {
    const outs = sparkOuts.map((r) => ({ address: r.address, value: r.amount, memo: r.memo ?? '' }));
    const dummies = await this.spark.createSparkMintRecipients({ outputs: outs, serialContext: new Uint8Array(0), generate: false });
    if (!Array.isArray(dummies) || dummies.length !== outs.length) throw err('server', 'The Spark library made the wrong number of mint outputs.');
    // Room for the real scripts, which can be a little longer than the dummies.
    const pad = (s) => new Uint8Array(s.length + 16).fill(OP.OP_SPARKMINT, 0, 1);
    let outputs = [...dummies.map((d, i) => ({ script: pad(d.script), value: outs[i].value, mint: i })), ...transparentOuts];
    let plan;
    try {
      plan = this.transparent.planSend({ outputs, feePerKb, tipHeight: tip, subtractFee, sendAll });
    } catch (e) {
      throw apiError(e);
    }
    const sent = plan.outputs.filter((o) => !o.change).reduce((s, o) => s + o.value, 0n);
    return {
      kind: 'mint',
      fee: plan.fee,
      total: sent + plan.fee,
      change: plan.change,
      warnings,
      build: async () => {
        const serialContext = await this.spark.serializeMintContext({ inputs: plan.inputs.map((u) => ({ txid: u.txid, vout: u.vout })) });
        const finalOuts = plan.outputs.filter((o) => o.mint !== undefined).map((o) => ({ ...outs[o.mint], value: o.value }));
        const real = await this.spark.createSparkMintRecipients({ outputs: finalOuts, serialContext, generate: true });
        let k = 0;
        const outputsReal = plan.outputs.map((o) => (o.mint !== undefined ? { script: real[k++].script, value: o.value } : o));
        const signed = this.transparent.signPlan({ ...plan, outputs: outputsReal }, this._lockTip(tip));
        // The fee must still pay for the real size.
        const minFee = (BigInt(signed.size) * (feePerKb > this.net.minRelayFeePerKb ? feePerKb : this.net.minRelayFeePerKb) + 999n) / 1000n;
        if (signed.fee < minFee) throw err('server', 'The mint came out larger than planned; try again.');
        return { hex: signed.hex, txid: signed.txid, fee: signed.fee, recips };
      },
    };
  }

  _spendableSparkCoins() {
    return [...this.ownCoins.values()].filter((c) => !c.spentTxid && !c.pendingSpentTxid && !c.mempool && c.groupId && !this._needsSparkProof(c));
  }

  /**
   * The private coins a spend of `need` is planned from. A coin of a spend let go of while it may be on
   * the network (conflictAt) should be one of those spent, so the two conflict and at most one is ever
   * mined (audit of 0.1.8, X3 / P7). The library picks among the coins it is given, by its own rule
   * (sparkPick): it is given the fewest coins taken away for its pick to hold a conflict coin, both for
   * the bare amount (`alone`) and for the amount with the planning margin (`need`), the real fee lying
   * between (audit L2: others between the amount plus the real fee and the margin paid without it).
   * -> {coins, forced}: forced false when no set of coins makes it so (Review says so).
   */
  _sparkCoinsForPlan(need, alone = need) {
    const coins = this._spendableSparkCoins();
    const now = Date.now();
    const kept = new Set(coins.filter((c) => c.conflictAt && now - c.conflictAt < CONFLICT_KEEP_MS));
    if (!kept.size) return { coins, forced: true };
    const total = (list) => list.reduce((s, c) => s + c.value, 0n);
    let given = coins.slice();
    while (total(given) >= need) {
      const picks = [sparkPick(given, alone), sparkPick(given, need)];
      const missing = picks.find((p) => !p.some((c) => kept.has(c)));
      if (!missing) return { coins: given, forced: true };
      // The largest coin the library took instead goes, and it is asked again.
      const blocker = missing.filter((c) => !kept.has(c)).sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0))[0];
      given = given.filter((c) => c !== blocker);
    }
    return { coins, forced: false };
  }

  async _planSparkSpend({ recips, tip, subtractFee, warnings, nameInfo = null }) {
    const wanted = recips.reduce((s, r) => s + r.amount, 0n);
    // A margin over the amount for the fee (Spark fees are far below it), so the set given can pay it.
    const plan = this._sparkCoinsForPlan(subtractFee ? wanted : wanted + SPARK_FEE_MARGIN, wanted);
    let coins = plan.coins;
    let warnedConflict = !plan.forced;
    if (warnedConflict) warnings.push(CONFLICT_WARNING);
    const balance = coins.reduce((s, c) => s + c.value, 0n);
    const amount = recips.reduce((s, r) => s + r.amount, 0n);
    if (balance === 0n || (!subtractFee && amount > balance) || (subtractFee && amount > balance)) {
      throw Object.assign(err('insufficient', 'Not enough private FIRO for this amount and fee.'), { needed: amount, available: balance });
    }
    const v = sparkSpendTxVersion(this.net, tip + 1);
    const own = coins.map((c) => ({ coin: c.coin, context: c.context, groupId: c.groupId, height: c.height ?? tip }));
    const transparentRecips = recips.filter((r) => r.kind !== 'spark');
    const privateRecips = recips.filter((r) => r.kind === 'spark');
    let fee;
    try {
      fee = BigInt(
        await this.spark.estimateSparkFee({
          keyData: this._sparkKey,
          index: SPARK_KEY_INDEX,
          sendAmount: amount,
          subtractFee,
          coins: own,
          privateRecipients: privateRecips.length,
          utxoNum: transparentRecips.length,
          additionalTxSize: nameInfo ? await this._nameExtraSize(nameInfo, v) : 0,
          spendVersion: v.spendVersion,
        }),
      );
    } catch (e) {
      if (/insufficient|not enough|enough/i.test(e.message)) throw Object.assign(err('insufficient', 'Not enough private FIRO for this amount and fee.'), { needed: amount, available: balance });
      throw e;
    }
    if (!subtractFee && amount + fee > balance) throw Object.assign(err('insufficient', 'Not enough private FIRO for this amount and fee.'), { needed: amount + fee, available: balance });
    // At the real fee, the library's own pick from these coins (audit N4: checked only at the bare
    // amount and at the margin, it could differ in between): a let-go coin in it, or Review says so.
    const now0 = Date.now();
    const kept = coins.filter((c) => c.conflictAt && now0 - c.conflictAt < CONFLICT_KEEP_MS);
    if (kept.length && !warnedConflict && !sparkPick(coins, subtractFee ? amount : amount + fee).some((c) => kept.includes(c))) {
      warnedConflict = true;
      warnings.push(CONFLICT_WARNING);
    }
    const mustUse = kept.length && !warnedConflict ? new Set(kept.map((c) => c.lTagHash)) : null;
    // With the fee taken from the amounts, it is shared out over the recipients (the first gets the remainder).
    const share = subtractFee ? fee / BigInt(recips.length) : 0n;
    const rem = subtractFee ? fee - share * BigInt(recips.length) : 0n;
    const adjusted = recips.map((r, i) => ({ ...r, amount: r.amount - share - (i === 0 ? rem : 0n) }));
    if (adjusted.some((r) => r.amount < this.net.dust)) throw err('dust', 'After the fee an amount is too small to send.');
    const total = subtractFee ? amount : amount + fee;
    const totalChange = balance - total; // the library chooses the coins; change is at most this
    return {
      kind: 'spark-spend',
      fee,
      total,
      change: totalChange,
      warnings,
      build: () => this._buildSparkSpend({ recips: adjusted, tip, v, own, coins, fee, nameInfo, mustUse }),
    };
  }

  /**
   * recips carry what each one receives: with the fee taken from the amounts, _planSparkSpend has
   * already taken it off. So the library is never asked to subtract it again (it would, from the
   * same recipients: the receiver got one fee less than Review said, and a public recipient's
   * output no longer matched the proof). `fee` is what Review showed: anything else is refused.
   */
  async _buildSparkSpend({ recips, tip, v, own, coins = [], fee, nameInfo = null, mustUse = null }) {
    const transparentOuts = recips.filter((r) => r.kind !== 'spark').map((r) => ({ value: r.amount, script: addressToScript(r.address, this.net) }));
    // A name registration: the fee output also names the name and the Spark address it points to.
    let nameScriptDelta = 0;
    if (nameInfo) {
      const base0 = transparentOuts[0].script;
      transparentOuts[0] = { ...transparentOuts[0], script: sparkNameFeeScript(base0, nameInfo.name, nameInfo.address) };
      nameScriptDelta = transparentOuts[0].script.length - base0.length;
    }
    const base = {
      versionRaw: v.version,
      vin: [{ prevHash: new Uint8Array(32), vout: 0xffffffff, scriptSig: Uint8Array.of(OP.OP_SPARKSPEND), sequence: SEQUENCE_FINAL }],
      vout: transparentOuts,
      locktime: this._lockTip(tip),
      extraPayload: new Uint8Array(0),
    };
    const txHashSig = sha256d(serializeTx(base));
    // The name record without its proof sizes the transaction and (spend v2) is committed to by it.
    let noProof = null;
    if (nameInfo) noProof = await this._nameScript(nameInfo, v, decodeTx(serializeTx(base), this.net).txid, { ignoreProof: true });
    const extensionCommitment = noProof && v.spendVersion === 2 ? await this.spark.getSparkNameCommitment(noProof.script) : undefined;
    const groups = [...new Set(own.map((c) => c.groupId))].sort((a, b) => a - b);
    const coverSets = [];
    const idAndBlockHashes = [];
    // Each set's hash recomputed from its coins and confirmed by a second server first (D-09).
    for (const set of await this._checkedSets(groups, coins)) {
      const g = set.groupId;
      // The library takes a group in the server's order, newest first (Campfire stores it oldest
      // first and reverses it again when reading it for a spend); the store keeps oldest first.
      const list = set.coins.map((c) => ({ coin: c.coin, txHash: c.txHash })).reverse();
      coverSets.push({ groupId: g, setHash: set.setHash, blockHash: set.blockHash, coins: list });
      idAndBlockHashes.push({ groupId: g, blockHash: hexToBytes(set.blockHashHex).reverse() });
    }
    const r = await this.spark.createSparkSpendTransaction({
      keyData: this._sparkKey,
      index: SPARK_KEY_INDEX,
      recipients: recips.filter((x) => x.kind !== 'spark').map((x) => ({ address: x.address, value: x.amount, subtractFee: false })),
      privateRecipients: recips.filter((x) => x.kind === 'spark').map((x) => ({ address: x.address, value: x.amount, subtractFee: false, memo: x.memo ?? '' })),
      coins: own,
      coverSets,
      idAndBlockHashes,
      txHashSig,
      additionalTxSize: noProof ? noProof.size + nameScriptDelta : 0,
      spendVersion: v.spendVersion,
      extensionCommitment,
    });
    if (!r || !(r.payload instanceof Uint8Array) || !Array.isArray(r.outputScripts)) throw err('server', 'The Spark library did not return a transaction.');
    if (!v.multiInput && (r.usedCoins?.length ?? 1) !== 1) throw err('server', 'This block height allows one Spark input per payment.');
    // What you see is what you sign: the fee on Review, or nothing.
    if (fee !== undefined && BigInt(r.fee) !== BigInt(fee)) throw err('server', `The network fee came out at ${r.fee} instead of the ${fee} shown, so nothing was sent. Review the payment again.`);
    // Review said nothing of a let-go payment: the library spent one of its coins, or nothing goes (N4).
    // Told by linking tag, as the payment's record does (third audit F1: compared as bytes, the set's
    // entry never matched the library's coin, which comes back without the set's suffix).
    if (mustUse && !(await this._coinsSpentBy({ usedCoins: r.usedCoins ?? [] })).some((c) => mustUse.has(c.lTagHash))) {
      throw err('conflict-coin', "A private payment from earlier that showed as not sent may still go through, and this one would not have used the same coins, so nothing was sent. Check Activity, then review the payment again.");
    }
    // The node's proof check, here on the device, before anything is broadcast.
    if (typeof this.spark.verifySparkSpend === 'function') {
      const check = await this.spark.verifySparkSpend({
        spendVersion: v.spendVersion,
        serializedSpendPayload: r.payload,
        outputScripts: r.outputScripts,
        transparentOut: transparentOuts.reduce((s, o) => s + BigInt(o.value), 0n),
        anonymitySets: coverSets.map((s) => ({ setId: s.groupId, setHash: base64ToBytes(s.setHash), coins: s.coins.map((c) => c.coin) })),
        txHash: txHashSig,
      });
      if (!check || !check.valid) throw err('server', `The private payment did not pass the network's check, so it was not sent${check?.reason ? ` (${check.reason})` : ''}.`);
    }
    const tx = { ...base, vout: [...transparentOuts, ...r.outputScripts.map((script) => ({ value: 0n, script }))], extraPayload: r.payload };
    if (nameInfo) {
      // As Firo checks it: the proof is over the id of the transaction carrying the proof-less record.
      const hash = decodeTx(serializeTx({ ...tx, extraPayload: concatBytes(r.payload, noProof.script) }), this.net).txid;
      let named = null;
      for (let failSafe = 0; !named; failSafe++) {
        try {
          named = await this._nameScript(nameInfo, v, hash, { ignoreProof: false, hashFailSafe: failSafe });
        } catch (e) {
          if (v.spendVersion === 2 || !/hash fail/i.test(e.message) || failSafe > 100) throw e;
        }
      }
      tx.extraPayload = concatBytes(r.payload, named.script);
    }
    const bytes = serializeTx(tx);
    const decoded = decodeTx(bytes, this.net);
    return { hex: bytesToHex(bytes), txid: decoded.txid, fee: BigInt(r.fee), recips, spark: true, usedCoins: r.usedCoins ?? [] };
  }

  /** The Spark name record (createSparkNameScript) for `nameInfo`, proof over `inputHex` (a txid). */
  async _nameScript(nameInfo, v, inputHex, { ignoreProof, hashFailSafe = 0 }) {
    requireSpark(this.spark, 'names', 'Registering a Spark name');
    const out = await this.spark.createSparkNameScript({
      sparkNameValidityBlocks: nameInfo.validBlocks,
      name: nameInfo.name,
      additionalInfo: nameInfo.additionalInfo,
      proofInput: { spendVersion: v.spendVersion, inputHex },
      privateKey: this._sparkKey,
      spendKeyIndex: SPARK_KEY_INDEX,
      diversifier: nameInfo.diversifier,
      isTestNet: this.net.id !== 'main',
      hashFailSafe,
      ignoreProof,
    });
    return { script: out.script instanceof Uint8Array ? out.script : hexToBytes(out.script), size: Number(out.size) };
  }

  /** Bytes a name registration adds to a spend: the record plus the fee script's name part. */
  async _nameExtraSize(nameInfo, v) {
    const rec = await this._nameScript(nameInfo, v, '00'.repeat(32), { ignoreProof: true });
    const base = addressToScript(this.net.sparkNameFeeAddress, this.net);
    return rec.size + (sparkNameFeeScript(base, nameInfo.name, nameInfo.address).length - base.length);
  }

  /**
   * Registers (or renews) a Spark name for this wallet's Spark address: a private payment of the
   * yearly fee × years to Firo's community fund, carrying the name record. Resolves {txid}.
   */
  async _registerName({ name, years = 1, additionalInfo = '', diversifier, renew = false, expect = null, quoteOnly = false } = {}) {
    if (this.viewOnly || !this._sparkKey) throw err('NotYet', 'A view-only wallet cannot register a name.');
    const n = String(name ?? '');
    if (!isValidSparkName(n)) throw err('invalid-name', 'A Spark name is 1–20 letters, digits, dots or dashes.');
    const y = Number(years);
    if (!Number.isInteger(y) || y < 1 || y > 10) throw err('invalid-amount', 'A Spark name is registered for 1 to 10 years.');
    if (new TextEncoder().encode(additionalInfo).length > 1024) throw err('invalid-amount', 'The extra information is longer than 1,024 bytes.');
    // Never the same name paid for twice (second audit, X8): a new registration only of a name the
    // node's list, read fresh, does not have, and that this wallet is not registering already; a
    // renewal only while no other renewal of it is on its way. (A quote pays nothing: not asked.)
    if (quoteOnly) {
      // nothing to check
    } else if (!renew) {
      const held = (await this._allNames(0)).find((e) => e.name.toUpperCase() === n.toUpperCase());
      if (held) throw err('name-taken', (await this._isOwnSparkAddressAsync(held.address)) ? `This wallet already has @${n}, so nothing was paid. Renew it to keep it longer.` : `@${n} is taken, so nothing was paid.`);
      if (this._ownNameSend(n, { confirmed: true })) throw err('name-taken', `This wallet is already registering @${n}, so nothing was paid.`);
    } else if (this._ownNameSend(n, { confirmed: false })) {
      throw err('name-taken', `A renewal of @${n} is still on its way, so nothing was paid. Try again once it is confirmed.`);
    }
    let d = diversifier;
    // A quote: the address in use (any Spark address makes a record of the same size), none made.
    if (d === undefined && quoteOnly) d = this.sparkAddr.diversifier;
    if (d === undefined) {
      // One name per Spark address (as Campfire does): the first receive address with no name yet.
      const named = new Set((await this._listOwnNames().catch(() => [])).map((e) => e.address));
      d = this.sparkAddr.diversifier;
      while (named.has(await this._sparkAddress(d))) {
        await this.newSparkAddress();
        d = this.sparkAddr.diversifier;
      }
    }
    const address = await this._sparkAddress(d);
    const feeFiro = BigInt(this.net.sparkNameFeeFiro[n.length]) * BigInt(y);
    const nameInfo = { name: n, additionalInfo, validBlocks: y * 365 * 24 * 24, diversifier: d, address };
    const req = { from: 'private', to: [{ address: this.net.sparkNameFeeAddress, amount: String(feeFiro * 100000000n) }], nameInfo };
    if (quoteOnly) return this.quote(req);
    return this.send({ ...req, ...(expect ? { expect } : {}) });
  }

  /** Renews one of this wallet's names for `years` more: the same registration, to the name's own address. */
  async _renewName({ name, years = 1, additionalInfo, expect = null, quoteOnly = false } = {}) {
    const mine = await this._ownNames();
    const entry = mine.find((e) => e.name.toLowerCase() === String(name ?? '').toLowerCase());
    if (!entry) throw err('invalid-name', `"${name}" is not one of this wallet's names.`);
    let d = null;
    for (let i = 1; i <= this.sparkAddr.diversifier && d === null; i++) if (i !== SPARK_CHANGE_DIVERSIFIER && (await this._sparkAddress(i)) === entry.address) d = i;
    if (d === null) throw err('invalid-name', `The address of "${name}" is not one of this wallet's.`);
    // The name's note, kept: from the full list (audit D-10). Only a server whose list lacks it is
    // asked about the name, and only now: the renewal names it and its address to that server anyway.
    const info = additionalInfo ?? entry.additionalInfo ?? (await this.client.sparkNameData(entry.name).catch(() => null))?.additionalInfo ?? '';
    return this._registerName({ name: entry.name, years, additionalInfo: info, diversifier: d, renew: true, expect, quoteOnly });
  }

  /** The txid of this wallet's payment registering or renewing `name` that is not dropped (with `confirmed`: confirmed ones too), or null. */
  _ownNameSend(name, { confirmed }) {
    const want = `@${String(name).toUpperCase()}`;
    for (const [txid, s] of this.sends) {
      if (s.kind !== 'spark-name' || s.dropped || String(s.to ?? '').toUpperCase() !== want) continue;
      if (!s.confirmed || confirmed) return txid;
    }
    return null;
  }

  /** Whether `address` is one of this wallet's Spark receive addresses. */
  async _isOwnSparkAddressAsync(address) {
    for (let d = 1; d <= this.sparkAddr.diversifier; d++) if (d !== SPARK_CHANGE_DIVERSIFIER && (await this._sparkAddress(d)) === address) return true;
    return false;
  }

  /** The yearly fee for a name of this length, in whole FIRO (Firo Core standardSparkNamesFee). */
  sparkNameFeeFiro(name, years = 1) {
    return this.net.sparkNameFeeFiro[String(name).length] * years;
  }

  /** WALLET_API quote: {fee, total, change, warnings} as satoshi strings. */
  async quote(req) {
    try {
      const p = await this._plan(req);
      return { fee: String(p.fee), total: String(p.total), change: String(p.change), warnings: p.warnings };
    } catch (e) {
      throw apiError(e);
    }
  }

  /**
   * Builds, signs, writes the payment down, then broadcasts; resolves {txid}. See the top of this
   * file for what each outcome means (audit FM-1). req.expect = {fee, total} (satoshi strings): the
   * figures Review showed; a plan that differs is refused before anything is built, code
   * 'fee-changed' with the new {fee, total, change} (audit FE-3: a coin arriving during Face ID
   * changed the fee paid, and with the fee from the amount what the receiver got).
   */
  async send(req) {
    // One payment at a time (release verification 0.1.8): a second one while another is between
    // send() and the end of its broadcast is refused before anything is planned, with a "not sent"
    // code. Two at once could be the same intent twice (a screen left during "Sending…" and opened
    // again), and their coins are not kept from each other until the first is written down.
    if (this._inFlight > 0) throw inFlightRefusal();
    this._inFlight++;
    try {
      let built;
      try {
        const p = await this._plan(req);
        // A hard ceiling on any payment's network fee, whatever a server's fee rate or the coins it
        // spends made of it (public audit, PN): far above what Firo needs, so nothing is sent.
        if (BigInt(p.fee) > MAX_PAYMENT_FEE) throw err('invalid-amount', `The network fee came out at ${formatSats(p.fee)} FIRO, far above what Firo needs, so nothing was sent.`);
        if (req.expect && (String(p.fee) !== String(req.expect.fee) || String(p.total) !== String(req.expect.total))) {
          throw Object.assign(err('fee-changed', 'The network fee changed since it was shown, so nothing was sent. Check the new figures, then send.'), { fee: String(p.fee), total: String(p.total), change: String(p.change) });
        }
        built = await p.build();
      } catch (e) {
        throw apiError(e);
      }
      if (this._closed || !this.opened) throw err('not-open', 'The wallet was locked, so the payment was not sent.');
      await this._recordPayment(built, req);
      return await this._sendRecorded(built);
    } finally {
      this._inFlight--;
    }
  }

  /**
   * Writes a signed payment down before it is broadcast (audit FM-1): a private one in the payment
   * log with its bytes and the coins it spends (pending-spent), a public one among the pending
   * payments (its coins spent). Whatever the broadcast then does, the next payment cannot pick
   * the same intent's coins as free, and the follow-up (D-08) covers an answer that never came.
   *
   * It is written down in doubt (unsure) until the node answers (release re-audit 3 RE3-1: the flag
   * was set only after an unanswered broadcast, which a lock, a hand-over or a dying page during the
   * broadcast never reached: the next unlock showed it pending, not in doubt, and the Bridge offered
   * a second crossing while the engine re-sent the first).
   *
   * A record the store did not take is not kept in memory either, and nothing is sent: 'storage'
   * (release re-audit R-2: kept in memory behind an uncoded error the screens read as "not sent",
   * it was sent by the follow-up two blocks later), or 'not-open' when the store refused it because
   * the wallet was locked meanwhile (R1-2: answered 'unsure' with nothing written down behind it).
   * A record that reached the store before a later write failed, or one that cannot be told, is
   * kept and sent: never "not sent" over a record the next unlock would send.
   */
  async _recordPayment(built, req = {}) {
    const tip = this.tip?.height ?? null;
    if (built.spark) {
      const coins = await this._coinsSpentBy(built);
      const to = built.recips.find((r) => r.kind !== 'spark' || !this._isOwnSparkAddress(r.address));
      const before = { send: this.sends.get(built.txid), marks: coins.map((c) => [c, c.pendingSpentTxid]) };
      this.sends.set(built.txid, {
        amount: String(built.recips.filter((r) => !this._isOwnSparkAddress(r.address)).reduce((s, r) => s + r.amount, 0n)),
        fee: String(built.fee),
        to: to ? to.name ?? to.address : undefined,
        // Every one paid, when more than one (N12).
        ...(() => {
          const all = built.recips.filter((r) => r.kind !== 'spark' || !this._isOwnSparkAddress(r.address)).map((r) => r.name ?? r.address);
          return all.length > 1 ? { toAll: all.slice(0, 20) } : {};
        })(),
        memo: built.recips.find((r) => r.memo)?.memo,
        time: now(),
        // Until the payment is seen used on chain: where it was sent, its bytes to send again, the coins it spends.
        height: tip,
        hex: built.hex,
        // To one of this wallet's own (non-change) addresses: its bytes are kept once confirmed too,
        // so the coin it made stays "made here" (second audit N7).
        ...(built.recips.some((r) => r.kind === 'spark' && this._isOwnSparkAddress(r.address)) ? { toSelf: true } : {}),
        coins: coins.map((c) => c.lTagHash),
        // In doubt until the node answers (release re-audit 3 RE3-1): a lock or a closed page during
        // the broadcast leaves it so on disk, and the next unlock says it may have left.
        unsure: true,
        ...(req.nameInfo ? { kind: 'spark-name', to: `@${req.nameInfo.name}` } : {}),
      });
      // The coins it spends are pending until the tags show them used.
      for (const c of coins) c.pendingSpentTxid = built.txid;
      const written = new Set();
      let failure = null;
      try {
        await this._saveSpark(written);
      } catch (e) {
        failure = e;
      }
      // Refused (locked meanwhile: nothing more is written), or failed and not in the store.
      if (!written.has(KEY.sends) && (!failure || (await this._sendOnDisk(built)) === false)) {
        if (before.send) this.sends.set(built.txid, before.send);
        else this.sends.delete(built.txid);
        for (const [c, m] of before.marks) {
          if (m === undefined) delete c.pendingSpentTxid;
          else c.pendingSpentTxid = m;
        }
        // A coin list written with the mark before the failure is put right if the store lets it
        // (otherwise the next unlock clears a mark no payment of the log has: _checkSpent).
        await this._saveSpark().catch(() => {});
        this._emit();
        throw this._notRecorded(failure);
      }
    } else {
      let kept;
      try {
        // Who a payment to a Spark address is for the transaction cannot tell (audit X2: Review's
        // "Paid before?" never saw one): kept with it while it is followed.
        const sparkTo = (built.recips ?? []).filter((r) => r.kind === 'spark' && !this._isOwnSparkAddress(r.address)).map((r) => r.name ?? r.address);
        kept = await this.transparent.addPending({ txid: built.txid, hex: built.hex, height: tip, unsure: true, to: sparkTo[0], toAll: sparkTo.length > 1 ? sparkTo : undefined });
      } catch (e) {
        if (e instanceof TransparentError) throw e;
        throw this._notRecorded(e);
      }
      if (!kept) throw this._notRecorded(null);
    }
    this._emit();
  }

  /** Whether the stored payment log holds this payment with its bytes: true, false, or null (cannot be read). */
  async _sendOnDisk(built) {
    try {
      const m = await this.store.get(KEY.sends);
      return Boolean(m && m[built.txid] && m[built.txid].hex === built.hex);
    } catch {
      return null;
    }
  }

  /** A payment that could not be written down, so it was not sent (and is not kept): why, coded. */
  _notRecorded(e) {
    if (this._closed || (e && e.code === 'other_tab')) return err('not-open', 'The wallet was locked, so the payment was not sent.');
    return err('storage', 'This device could not save the payment, so it was not sent.');
  }

  /**
   * This wallet's coins a private payment spends, found by their linking tags (release re-audit R1-1:
   * matched by bytes, none was ever found with the real library, which hands its used coins back
   * serialized anew, without the tx hash and context firod appends on mainnet). The used coins are
   * identified with this wallet's view key, as any coin is. Fewer own coins than the payment spends:
   * it is not written down, nor sent (its coins could not be kept from the next payment).
   */
  async _coinsSpentBy(built) {
    const used = built.usedCoins ?? [];
    const refuse = () => err('server', 'Campfire could not tell which of your private coins this payment spends, so it was not sent.');
    if (!used.length) throw refuse();
    let res;
    try {
      res = await this.spark.identifyCoins({ ...this._keyArgs(), index: SPARK_KEY_INDEX, isTestNet: this.net.id !== 'main', coins: used.map((u) => ({ coin: u.coin, context: u.context })) });
    } catch {
      throw refuse();
    }
    if (this._closed) throw err('not-open', 'The wallet was locked, so the payment was not sent.');
    const coins = [...new Set((Array.isArray(res) ? res : []).map((r) => (r ? this.ownCoins.get(r.lTagHash) : null)).filter(Boolean))];
    if (coins.length < used.length) throw refuse();
    return coins;
  }

  /**
   * A recorded payment the node did not take (an error answer, or it never reached one): forgotten.
   * Resolves whether the store forgot it too (R1-2: locked meanwhile, the store keeps it, and the
   * next unlock follows it: it may still leave).
   */
  async _forgetPayment(built) {
    let forgotten;
    if (built.spark) {
      this.sends.delete(built.txid);
      for (const c of this.ownCoins.values()) if (c.pendingSpentTxid === built.txid) freeAsConflict(c);
      forgotten = (await this._saveSpark()).has(KEY.sends);
    } else {
      forgotten = await this.transparent.removePending(built.txid);
    }
    this._emit();
    return forgotten;
  }

  /**
   * Broadcasts a payment already written down, and says what became of it (audit FM-1): only an
   * error answer from the node, or a broadcast that never reached one, means it did not leave.
   */
  async _sendRecorded(built) {
    let state;
    let error = null;
    // The node the broadcast goes to (only on the connection there is now: broadcast() never waits
    // for another). Its error answer is what a second node is asked about, so it is never that second
    // node (release re-audit 5 RE5-1: it dropped the connection after refusing, the wallet moved to
    // the next node, and the refusing node, now one of the "others", answered as its own second opinion).
    const node = this.client?.server ?? null;
    if (this._closed || !this.client) {
      // Locked after it was written down (it is in the store: _recordPayment), before it was sent:
      // the follow-up sends it at the next unlock.
      state = 'unsure';
    } else {
      try {
        state = (await this.client.broadcast(built.hex)) === built.txid ? 'sent' : 'unsure'; // another txid: cannot tell
      } catch (e) {
        error = e;
        if (e instanceof ElectrumError && e.code === 'server') state = ALREADY_TX.test(e.message) ? 'sent' : 'refused';
        // Never handed to a socket (no connection, or it closed before): it did not leave. Any other
        // error, an answer without a result included, came after the node had the bytes: it may have
        // left (audit of 0.1.8, X3: an answer without a result was taken for "not sent").
        else if (e instanceof ElectrumError && !e.written && ['offline', 'closed', 'timeout'].includes(e.code)) state = 'unsent';
        else state = 'unsure';
      }
    }
    // An error answer from a node that relayed it anyway: another node has it (R-5). Only another
    // node's clear "no such transaction" lets it be forgotten; a node that could not be asked leaves
    // it in doubt (X3: an unreachable second node had a relayed payment forgotten, and paid again).
    if (state === 'refused') {
      const left = await this._leftAnyway(built.txid, node);
      if (left === 'yes') state = 'sent';
      else if (left === 'unknown') state = 'unsure';
    }
    if (state === 'refused' || state === 'unsent') {
      // Not forgotten in the store (a failed or refused write): the follow-up would send it, so it may still leave.
      const forgotten = await this._forgetPayment(built).catch(() => false);
      if (forgotten) throw apiError(error);
      state = 'unsure';
    }
    this._requestSync();
    if (state === 'unsure') {
      if (built.spark) {
        const s = this.sends.get(built.txid);
        if (s) {
          s.unsure = true;
          await this._saveSpark().catch(() => {});
        }
      } else {
        await this.transparent?.updatePending(built.txid, { unsure: true }).catch(() => {});
      }
      this._emit();
      throw Object.assign(err('unsure', UNSURE_WORDS), { txid: built.txid });
    }
    // The node answered with its txid: no longer in doubt (it was written down so: RE3-1). A write
    // the store refuses (locked meanwhile) leaves it in doubt, the safe side: the follow-up clears it.
    if (built.spark) {
      const s = this.sends.get(built.txid);
      if (s && s.unsure) {
        delete s.unsure;
        await this._saveSpark().catch(() => {});
      }
    } else {
      await this.transparent?.updatePending(built.txid, { unsure: undefined }).catch(() => {});
    }
    this._emit();
    return { txid: built.txid };
  }

  /**
   * A node answered our broadcast with an error: does another node have the payment anyway (release
   * re-audit R-5: a node that relays, then refuses, had it forgotten, its coins free, a Sell offered
   * again, and a private one shown with no receiver)? Asked after a moment; never when the person
   * reads the chain from their own node. true: it left. `node`: the node that answered the broadcast,
   * never asked (re-audit 5 RE5-1: its "no such transaction" would confirm its own refusal).
   */
  async _leftAnyway(txid, node = null) {
    // The person's own node is the only one asked: its refusal stands (it is the network they trust).
    if (this.ownNode) return 'no';
    // Two looks, the second later: a payment a node relayed may take some seconds to reach others.
    let said = 'unknown';
    for (const wait of [this._relayLookMs, this._relayLookMs * 3]) {
      if (this._closed) return 'unknown';
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (this._closed) return 'unknown';
      try {
        const hex = await this._secondOpinion((c) => c.getTransaction(txid), { avoid: node ? [node] : [] });
        // Its bytes must hash to this very txid: any answer counted as "it has it" before (public
        // audit, PN), so a node could have a payment that never left shown as sent.
        let same = false;
        try {
          same = decodeTx(hex, this.net).txid === txid;
        } catch {
          same = false;
        }
        if (same) return 'yes';
        return 'unknown';
      } catch (e) {
        // Only a node's clear "no such transaction" is a no; anything else (none reachable, a
        // timeout, a strange answer) tells nothing.
        said = e instanceof ElectrumError && e.code === 'server' && NO_SUCH_TX.test(e.message || '') ? 'no' : 'unknown';
        if (said === 'unknown') return 'unknown';
      }
    }
    return said;
  }

  _isOwnSparkAddress(a) {
    for (const v of this._sparkAddresses.values()) if (v === a) return true;
    return false;
  }

  /** Public → private: mints `amount` (satoshi string) or 'all' to this wallet's Spark address. */
  async privatize({ amount, subtractFee = false, expect = null } = {}) {
    if (!this._sparkEnabled() || !this._sparkKey) throw notYet('Privatizing');
    requireSpark(this.spark, 'mint', 'Privatizing');
    const address = await this._sparkAddress(this.sparkAddr.diversifier);
    const all = amount === 'all';
    // An amount the person saw, with its fee taken from it and pinned (expect): exactly what was shown
    // is moved, never coins that arrived meanwhile, never another fee (audit of 0.1.8, XM).
    const req = all ? { from: 'public', to: [{ address, amount: String(this.net.dust) }], sendAll: true } : { from: 'public', to: [{ address, amount }], ...(subtractFee ? { subtractFee: true } : {}), ...(expect ? { expect } : {}) };
    return this.send(req);
  }

  // ------------------------------------------------------------ explicit transactions

  /** Builds and signs a public transaction from exactly the chosen coins. Does not broadcast. */
  async buildTransparentTx({ inputs, outputs, feePerKb, changeAddress, subtractFee = false } = {}) {
    if (this.viewOnly || !this.transparent) throw err('NotYet', 'A view-only wallet cannot sign.');
    const tip = this._needTip();
    if (!Array.isArray(inputs) || inputs.length === 0) throw err('insufficient', 'Choose at least one coin to spend.');
    const all = new Map(this.transparent.utxos(tip).map((u) => [`${u.txid}:${u.vout}`, u]));
    const chosen = inputs.map((id) => {
      const u = all.get(String(id));
      if (!u) throw err('insufficient', `The coin ${id} is not an unspent coin of this wallet.`);
      if (!u.spendable) throw err('insufficient', u.frozen ? `The coin ${id} is frozen.` : `The coin ${id} is not confirmed yet.`);
      return u;
    });
    // The coins of a payment let go of while it may still be out there are spent here too, as by
    // every payment (P7; audit E6: the Bridge left them out, so a dropped lock and a second one with
    // other coins could both be mined). What they add comes back as change.
    for (const k of this.transparent.conflictCoins()) {
      const u = all.get(k);
      if (u && u.spendable && !chosen.includes(u)) chosen.push(u);
    }
    if (!Array.isArray(outputs) || outputs.length === 0) throw err('invalid-address', 'Add an output.');
    const outs = outputs.map((o) => {
      if (o && o.opReturn !== undefined) {
        if (typeof o.opReturn !== 'string' || !/^([0-9a-f]{2})*$/i.test(o.opReturn)) throw err('invalid-amount', 'OP_RETURN data must be hex.');
        return { script: opReturnScript(hexToBytes(o.opReturn.toLowerCase()), this.net.maxOpReturnRelay), value: 0n, opReturn: o.opReturn.toLowerCase() };
      }
      const c = classify(o?.address, this.net);
      if (c.kind !== 'transparent' && c.kind !== 'exchange') throw err('invalid-address', 'Only public (transparent or EX) addresses can be paid here.');
      return { script: addressToScript(c.address, this.net), value: parseAmount(o.amount), address: c.address };
    });
    let changeScript = this.transparent.changeAddress().script;
    if (changeAddress) {
      const s = addressToScript(changeAddress, this.net);
      if (!this.transparent.isOwnScript(s)) throw err('invalid-address', 'Change can only go to an address of this wallet.');
      changeScript = s;
    }
    let rate;
    if (feePerKb !== undefined) rate = BigInt(feePerKb);
    else rate = (await this.transparent.feeRates().catch((e) => Promise.reject(apiError(e)))).normal;
    if (rate > this.net.maxFeePerKb) throw err('invalid-amount', `A fee rate of ${rate} sat/kB is far above what Firo needs, so nothing was built.`);
    let plan;
    try {
      plan = planExplicit({ utxos: chosen, outputs: outs, feePerKb: rate, changeScript, dust: this.net.dust, minRelayFeePerKb: this.net.minRelayFeePerKb, subtractFee });
    } catch (e) {
      throw apiError(e);
    }
    let signed;
    try {
      // The lower of the two nodes' tips, as every payment (P7): one node ahead cannot make it unminable.
      signed = this.transparent.signPlan(plan, this._lockTip(tip));
    } catch (e) {
      throw apiError(e);
    }
    return {
      hex: signed.hex,
      txid: signed.txid,
      fee: String(signed.fee),
      size: signed.size,
      inputs: chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: String(u.value), address: u.address })),
      outputs: plan.outputs.map((o) => {
        const x = { address: o.opReturn !== undefined ? null : scriptToAddressSafe(o.script, this.net), value: String(o.value), script: bytesToHex(o.script) };
        if (o.change) x.change = true;
        if (o.opReturn !== undefined) x.opReturn = o.opReturn;
        return x;
      }),
    };
  }

  /**
   * Sends a signed transaction (from buildTransparentTx, after the caller checked it): written down
   * among this wallet's pending payments first, as send() does (audit FM-1), with the same answers.
   */
  async broadcastTx(hex) {
    let d;
    try {
      d = decodeTx(hex, this.net);
    } catch {
      throw err('invalid-amount', 'That is not a Firo transaction.');
    }
    if (this.viewOnly || !this.transparent) throw err('NotYet', 'A view-only wallet cannot send.');
    if (this._closed || !this.opened) throw err('not-open', 'The wallet was locked, so the payment was not sent.');
    const built = { spark: false, txid: d.txid, hex: typeof hex === 'string' ? hex.toLowerCase() : bytesToHex(hex) };
    // One payment at a time, as send() (release verification 0.1.8).
    if (this._inFlight > 0) throw inFlightRefusal();
    this._inFlight++;
    try {
      // Built outside this guard (buildTransparentTx): its coins are looked at again now, when no
      // other payment can be under way. One spent meanwhile by another payment of this wallet would
      // make two payments of the same coin (second audit, XX): nothing is sent.
      this._coinsStillFree(d);
      await this._recordPayment(built);
      return await this._sendRecorded(built);
    } finally {
      this._inFlight--;
    }
  }

  /** Throws 'insufficient' unless every coin `decoded` spends is an unspent, spendable coin of this wallet now. */
  _coinsStillFree(decoded) {
    const free = new Map(this.transparent.utxos(this._needTip()).map((u) => [`${u.txid}:${u.vout}`, u]));
    for (const i of decoded.vin) {
      const u = free.get(`${i.txid}:${i.vout}`);
      if (!u || !u.spendable) throw err('insufficient', 'A coin this payment spends was used by another payment meanwhile, so it was not sent. Nothing left your wallet: try again.');
    }
  }

  /** Payments to `to` (newest first) and whether an input came from `from`. Asks the server about `to`. */
  async paymentsTo({ to, from = null, minHeight = 0 }) {
    try {
      const list = await paymentsTo({ client: this.client, net: this.net, to, from, minHeight });
      return list.map((p) => ({ txid: p.txid, height: p.height, value: String(p.value), fromMatches: p.fromMatches }));
    } catch (e) {
      throw apiError(e);
    }
  }

  // ------------------------------------------------------------ the rest

  async estimateFeeRate() {
    if (!this.transparent) throw notYet('Fee rates in this view-only wallet');
    try {
      const f = await this.transparent.feeRates();
      return { fast: String(f.fast), normal: String(f.normal), slow: String(f.slow), min: String(f.min), unit: 'sat/kB' };
    } catch (e) {
      throw apiError(e);
    }
  }

  async exportSparkViewKey() {
    if (this._fvk) return bytesToHex(this._fvk);
    if (!this._sparkKey || !this.spark?.getFullViewKey) throw notYet('Exporting the Spark view key');
    return bytesToHex(await this.spark.getFullViewKey({ keyData: this._sparkKey, index: SPARK_KEY_INDEX }));
  }

  async exportXpub() {
    if (!this.keys) throw notYet('Exporting the xpub of a Spark-only view-only wallet');
    return this.keys.xpub();
  }

  /**
   * Forgets what was learned from the servers (keeping the downloaded Spark
   * data) and syncs again. Electrum history is complete, and a set index
   * cannot be mapped to a height without asking about own coins, so
   * `fromHeight` is accepted but everything is looked at again.
   */
  async rescan({ fromHeight } = {}) {
    void fromHeight;
    if (this.transparent) {
      for (const k of await this.store.keys('w/t/')) await this.store.del(k);
      this.transparent = new TransparentWallet({ net: this.net, keys: this.keys, client: this.client, store: prefixStore(this.store, 'w/') });
      await this.transparent.load();
    }
    if (this.progress) {
      // A look under way stops before it writes anything more (sixth audit P1: it went on writing
      // progress past the coins this had just forgotten, and they were never looked at again).
      this._epoch++;
      // Forgotten here at once, before anything is awaited (ninth audit L2: cleared after the writes, a
      // sync started meanwhile had its coins wiped while its look was counted done).
      this.ownCoins.clear();
      // The mempool looked at again too (tenth audit N2: a payment waiting there vanished until mined).
      this._mempoolLookAgain();
      this.progress.groups = {};
      this.progress.tagsUpTo = 0;
      // Every set looked at whole again, from its first coin (sixth audit N1: a look at a set
      // downloaded anew, carried on from where it stopped, skipped the coins before that place).
      this.progress.gens = {};
      this._anewAt = {};
      // Found again with no record of them: placed as when restoring, never dated today (M1).
      this.progress.relook = true;
      await this.store.put(KEY.anewAt, this._anewAt);
      // The cleared progress first, then the emptied coins (seventh audit L1: coins first, a page that
      // died in between was left with no coins and the old progress, and showed 0).
      await this.store.put(KEY.progress, this.progress);
      await this._saveSpark();
    }
    this._requestSync();
  }

  /** Deletes the downloaded Spark sets and tags; the next sync fetches them again. */
  async clearSparkCache() {
    if (!this.sparkSync) return;
    await this.sparkSync.clear();
    this.progress.groups = {};
    this.progress.tagsUpTo = 0;
    delete this.progress.tagsAgreed;
    this.tagCheck = null;
    await this._saveSpark();
    this._requestSync();
  }

  /**
   * Asks one node for its newest block, on a connection of its own that is closed at once (the
   * Firo nodes screen): {ok: true, height, ms} | {ok: false, error}. It learns this IP address only.
   */
  async checkNode(url, { timeoutMs = 8000 } = {}) {
    const c = new ElectrumClient({ servers: [String(url)], WebSocket: this.WebSocket, ...this.electrumOpts, reconnect: false, timeoutMs, connectTimeoutMs: timeoutMs, pingIntervalMs: 0 });
    const t0 = Date.now();
    let timer = null;
    try {
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('did not answer in time')), timeoutMs);
      });
      const h = await Promise.race([c.connect().then(() => c.subscribeHeaders()), late]);
      return { ok: true, height: h.height, ms: Math.max(1, Date.now() - t0) };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      clearTimeout(timer);
      c.close();
    }
  }

  async setServers(list, { ownNode = false } = {}) {
    const urls = (list ?? []).map((s) => (typeof s === 'string' ? s : s?.url));
    if (!urls.length || urls.some((u) => typeof u !== 'string' || !/^wss:\/\/[^/\s]+$/.test(u.replace(/\/$/, '')))) throw err('invalid-address', 'A server is a wss:// address, for example wss://electrumx.firo.org:50004.');
    this.servers = urls;
    this.ownNode = Boolean(ownNode);
    if (!this.opened) return;
    this.client.close();
    await this.waitForSync().catch(() => {});
    await this._forgetRefusedSets();
    this.client = new ElectrumClient({ servers: this.servers, WebSocket: this.WebSocket, ...this.electrumOpts });
    if (this.transparent) this.transparent.client = this.client;
    if (this.sparkSync) this.sparkSync.client = this.client;
    this.tip = null;
    this._names = null;
    this.tagCheck = null; // the new server's used tags are compared on its first sync (D-12)
    // And its tip (D-11) at its first sync (release re-audit R1-6: the old node's 'agree' spoke for
    // the new one for up to 300 s, a stale 'disagree' paused sending as long).
    this.serverCheck = null;
    this._noSecondSyncs = 0;
    this._wireClient();
    this._requestSync();
  }
}

function scriptToAddressSafe(script, net) {
  try {
    return scriptToAddress(script, net);
  } catch {
    return null;
  }
}

function c_index(part) {
  return part[part.length - 1].index;
}

