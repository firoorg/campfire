// A small fake Firo chain behind the fake ElectrumX of firo_fake_ws.mjs:
// Spark coin groups made of blocks (served newest block first, as firod's
// GetCoinsForRecovery does), a used-tag list, a Spark mempool, and a
// transparent side (transactions, script-hash histories, broadcast).
//
// The groups follow firod (src/spark/state.cpp), as the wallet checks them (audit D-09): a new
// group G starts with the newest blocks of G-1 holding at least `startGroupSize` coins (8,000 on
// Firo; all of G-1 in a small test), and each block's set hash is SHA256d(previous hash ‖ its
// coins), starting from G-1's last hash; the very first group's first block is in no hash.

import { bytesToBase64, concatBytes, compactSize, sha256d, hashToHex, hashFromHex, sha256, bytesToHex, hexToBytes, reverse } from '../../src/lib/firo/bytes.js';
import { decodeTx } from '../../src/lib/firo/tx.js';
import { scriptHash, pubkeyToAddress } from '../../src/lib/firo/address.js';
import { parseScript } from '../../src/lib/firo/script.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { coinBody } from '../../src/lib/firo/spark_sync.js';
import { electrumHandler } from './firo_fake_ws.mjs';

let counter = 0;
const u32 = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);

/** A fake set entry: coin body (with a recognisable id), tx hash, 41-byte context; element0 repeats hash+context like firod. */
export function fakeCoin(id = ++counter, { txHash, mine = false, value = 0n } = {}) {
  const body = new Uint8Array(60);
  body[0] = mine ? 0xee : 0x00;
  body.set(u32(id), 1);
  body.set(new TextEncoder().encode(String(value)).subarray(0, 20), 10);
  const tx = txHash ?? sha256(concatBytes(Uint8Array.of(7), u32(id)));
  const ctx = sha256(u32(id + 1000000)).slice(0, 32);
  const context = concatBytes(ctx, new Uint8Array(9));
  const coin = concatBytes(body, tx, compactSize(context.length), context);
  return { id, coin, txHash: tx, context, mine, value };
}

/** 34-byte linking tag with a recognisable id. */
export function fakeTag(id) {
  const t = new Uint8Array(34);
  t.set(sha256(u32(id)), 0);
  t[32] = id & 1;
  return t;
}

export class FakeChain {
  constructor({ height = 1393000, startGroupSize = 8000 } = {}) {
    this.height = height;
    this.startGroupSize = startGroupSize;
    this.groups = new Map(); // id → [{hash (32), coins: [], height, setHash}] oldest block first (its own blocks)
    this.carried = new Map(); // id → the blocks of the group before it starts with, oldest first
    this.tags = []; // [{tag, txid (display hex)}]
    this.mempool = new Map(); // txid → {coins, lTags, ctx, isLocked}
    this.txs = new Map(); // txid → {hex, height, time}
    this.sparkTxs = new Map(); // txid → {height, time, nFees, nameFee}: Spark transactions, as firod describes them
    this.txGets = []; // Spark txids asked about (verbose), in order
    this.history = new Map(); // scripthash → [{tx_hash, height}]
    this.broadcasts = [];
    this.calls = [];
    this.failSector = null; // (groupId, start) => boolean
    this.names = [];
    this.feeRate = 1.008e-5;
  }

  get latestGroup() {
    return Math.max(0, ...this.groups.keys());
  }

  /** Adds a block of `coins` to group `g` (`hash`: the block's, to describe the same block on two fake servers). */
  addBlock(g, coins, { hash: blockHash } = {}) {
    if (!this.groups.has(g)) {
      // As firod's CountLastNCoins: the newest blocks of the group before, until startGroupSize coins.
      const before = this.groups.get(g - 1) ?? [];
      const carried = [];
      for (let i = before.length - 1, n = 0; i >= 0 && n < this.startGroupSize; i--) {
        carried.unshift(before[i]);
        n += before[i].coins.length;
      }
      this.groups.set(g, []);
      this.carried.set(g, carried);
    }
    const blocks = this.groups.get(g);
    const hash = blockHash ?? sha256(concatBytes(u32(g), u32(++counter)));
    this.height++;
    // The set hash as firod makes it: after the group's last block; a new group after the last
    // block of the one before; the first group's first block in no hash (before Chaum V2).
    const prevBlocks = this.groups.get(g - 1);
    const prev = blocks.length ? blocks[blocks.length - 1].setHash : prevBlocks?.length ? prevBlocks[prevBlocks.length - 1].setHash : null;
    const setHash = prev === null ? new Uint8Array(0) : sha256d(concatBytes(prev, ...coins.map(coinBody)));
    blocks.push({ hash, coins, height: this.height, setHash });
    // Each coin's transaction, mined in this block (a block every 5 minutes before 1791790000).
    for (const c of coins) {
      const txid = hashToHex(c.txHash);
      if (!this.sparkTxs.has(txid)) this.sparkTxs.set(txid, { height: this.height, time: 1791790000 - (1393000 + 1000 - this.height) * 300 });
    }
    return hash;
  }

  /** Every txid in the block at `h`: a coinbase, the Spark transactions of its coins, the public ones. */
  blockTxidsAll(h) {
    const out = [bytesToHex(sha256(concatBytes(Uint8Array.of(9), u32(h))))];
    for (const blocks of this.groups.values()) {
      for (const b of blocks) if (b.height === h) for (const c of b.coins) out.push(hashToHex(c.txHash));
    }
    out.push(...this.blockTxids(h));
    return [...new Set(out)];
  }

  /** Replaces the newest block of group `g` (a reorg). */
  reorgLast(g, coins) {
    const blocks = this.groups.get(g);
    blocks.pop();
    return this.addBlock(g, coins);
  }

  serverList(g, blockHashB64 = null) {
    const blocks = this.groups.get(g) ?? [];
    let end = blocks.length - 1;
    if (blockHashB64) {
      end = blocks.findIndex((b) => bytesToBase64(b.hash) === blockHashB64);
      if (end < 0) throw Object.assign(new Error('Unable to get anonymity set by provided parameters: Incorrect blockHash provided: x'), { code: -1 });
    }
    const out = [];
    for (let i = end; i >= 0; i--) out.push(...blocks[i].coins);
    // Then the blocks carried over from the group before, newest first.
    for (const b of (this.carried.get(g) ?? []).slice().reverse()) out.push(...b.coins);
    return out;
  }

  /** The group oldest first in Campfire's order: the reverse of the server's list. */
  campfireOrder(g) {
    return this.serverList(g).slice().reverse();
  }

  addTx(hex, height, time = 1791790000) {
    const d = decodeTx(hex);
    this.txs.set(d.txid, { hex, height, time });
    // Electrum indexes a transaction under the scripts it spends from as well.
    for (const i of d.vin) {
      const prev = i.txid && this.txs.get(i.txid);
      if (!prev) continue;
      const o = decodeTx(prev.hex).vout[i.vout];
      if (o) this.addHistory(scriptHash(o.script), d.txid, height);
    }
    for (const o of d.vout) {
      const sh = scriptHash(o.script);
      const h = this.history.get(sh) ?? [];
      if (!h.some((x) => x.tx_hash === d.txid)) h.push({ tx_hash: d.txid, height });
      this.history.set(sh, h);
    }
    return d.txid;
  }

  addHistory(sh, txid, height) {
    const h = this.history.get(sh) ?? [];
    const e = h.find((x) => x.tx_hash === txid);
    if (e) e.height = height;
    else h.push({ tx_hash: txid, height });
    this.history.set(sh, h);
  }

  /** The txids at height `h`, in the order they were added. */
  blockTxids(h) {
    return [...this.txs].filter(([, t]) => t.height === h).map(([id]) => id);
  }

  /** The 120-byte header at `h`, its Merkle root over blockTxids(h). */
  header(h) {
    const b = hexToBytes(headerHex(h));
    b.set(merkleRoot(this.blockTxids(h)), 36);
    return bytesToHex(b);
  }

  /** Mines a mempool transaction at the next height. */
  confirm(txid) {
    const t = this.txs.get(txid);
    this.height++;
    t.height = this.height;
    for (const h of this.history.values()) for (const e of h) if (e.tx_hash === txid) e.height = this.height;
    return this.height;
  }

  status(sh) {
    const h = this.history.get(sh);
    if (!h || !h.length) return null;
    return bytesToHex(sha256(new TextEncoder().encode(h.map((x) => `${x.tx_hash}:${x.height}:`).join(''))));
  }

  handler() {
    const table = {
      'spark.getsparklatestcoinid': () => this.latestGroup,
      'spark.getsparkanonymitysetmeta': ([g]) => {
        const blocks = this.groups.get(Number(g)) ?? [];
        const last = blocks[blocks.length - 1];
        return { blockHash: bytesToBase64(last ? last.hash : new Uint8Array(32)), setHash: bytesToBase64(last ? last.setHash : new Uint8Array(0)), size: this.serverList(Number(g)).length };
      },
      'spark.getsparkanonymitysetsector': ([g, bh, s, e]) => {
        if (this.failSector?.(Number(g), Number(s))) throw new Error('sector failed (test)');
        const list = this.serverList(Number(g), bh);
        return { coins: list.slice(Number(s), Number(e)).map((c) => [bytesToBase64(c.coin), bytesToBase64(c.txHash), bytesToBase64(c.context)]) };
      },
      'spark.getusedcoinstagstxhashes': ([start]) => ({ tagsandtxids: this.tags.slice(Math.max(0, Number(start))).map((t) => [bytesToBase64(t.tag), bytesToBase64(hashFromHex(t.txid))]) }),
      'spark.getmempoolsparktxids': () => [...this.mempool.keys()].map((t) => bytesToBase64(hashFromHex(t))),
      'spark.getmempoolsparktxs': ([{ txids }]) => {
        const out = {};
        for (const t of txids) {
          const m = this.mempool.get(t);
          if (!m) continue;
          out[bytesToBase64(hashFromHex(t))] = { 'lTags ': m.lTags ? m.lTags.map(bytesToBase64) : ['MintTX'], serial_context: [bytesToBase64(m.ctx ?? new Uint8Array(4))], coins: m.coins.map((c) => bytesToBase64(c.coin)), isLocked: !!m.isLocked };
        }
        return out;
      },
      'spark.getsparknames': () => this.names,
      // As firod: one name's record, or an error answer for a name nobody has.
      'spark.getsparknamedata': ([name]) => {
        const e = this.names.find((n) => n.name.toUpperCase() === String(name).toUpperCase());
        if (!e) throw Object.assign(new Error('Spark name not found'), { code: -8 });
        return { address: e.address, validUntil: e.validUntil ?? 0, additionalInfo: '' };
      },
      'blockchain.scripthash.subscribe': ([sh]) => this.status(sh),
      'blockchain.scripthash.get_history': ([sh]) => this.history.get(sh) ?? [],
      'blockchain.transaction.get': ([txid, verbose]) => {
        const t = this.txs.get(txid);
        const sp = !t && verbose ? this.sparkTxs.get(txid) : null;
        if (sp) {
          // Like firod: a Spark spend's fee in its input (nFees), its outputs typed.
          const vin = sp.nFees !== undefined ? [{ scriptSig: { asm: 'OP_SPARKSPEND ', hex: 'd3' }, nFees: sp.nFees, lTags: [], sequence: 4294967295 }] : [];
          const vout = [...(sp.nameFee ? [{ value: sp.nameFee, n: 0, scriptPubKey: { type: 'sparknamefee' } }] : []), { value: 0, n: sp.nameFee ? 1 : 0, scriptPubKey: { type: 'sparksmint' } }];
          this.txGets.push(txid);
          return { txid, hash: txid, version: 3, type: 9, vin, vout, height: sp.height, time: sp.time, blocktime: sp.time, confirmations: this.height - sp.height + 1 };
        }
        if (!t) throw Object.assign(new Error('No such mempool or blockchain transaction.'), { code: 2 });
        if (!verbose) return t.hex;
        // Like firod with -addressindex: each input's address and value, where known.
        const vin = decodeTx(t.hex, NETWORKS.main).vin.map((i) => {
          if (!i.txid) return { coinbase: '00' };
          const ops = parseScript(i.scriptSig);
          const prev = this.txs.get(i.txid);
          const po = prev ? decodeTx(prev.hex).vout[i.vout] : null;
          return { txid: i.txid, vout: i.vout, address: ops[1]?.data ? pubkeyToAddress(ops[1].data, NETWORKS.main) : null, valueSat: po ? Number(po.value) : null };
        });
        return { hex: t.hex, txid, vin, height: t.height > 0 ? t.height : undefined, time: t.height > 0 ? t.time : undefined, blocktime: t.height > 0 ? t.time : undefined, confirmations: t.height > 0 ? this.height - t.height + 1 : 0 };
      },
      'blockchain.transaction.broadcast': ([hex]) => {
        const d = decodeTx(hex);
        this.broadcasts.push(hex);
        this.addTx(hex, 0);
        return d.txid;
      },
      // Blocks with real Merkle roots over the transactions at each height (in the order added).
      'blockchain.block.header': ([h]) => this.header(h),
      'blockchain.block.txids': ([h]) => this.blockTxidsAll(Number(h)),
      'blockchain.transaction.get_merkle': ([txid, h]) => {
        const ids = this.blockTxids(h);
        const pos = ids.indexOf(txid);
        if (pos < 0) throw Object.assign(new Error('tx not in block'), { code: 2 });
        return { block_height: h, merkle: merkleBranch(ids, pos), pos };
      },
      'blockchain.estimatefee': () => this.feeRate,
      'blockchain.relayfee': () => 1e-5,
    };
    const base = electrumHandler(table);
    return (method, params, socket) => {
      this.calls.push(method);
      if (method === 'blockchain.headers.subscribe') return { height: this.height, hex: headerHex(this.height) };
      // Tests add methods the fake chain has no model for (masternodes: protx.info, …).
      if (this.extra && this.extra[method]) return this.extra[method](params);
      return base(method, params, socket);
    };
  }
}

/** A 120-byte FiroPoW-shaped header with `height` and a time at offset 68. */
/** Bitcoin-style Merkle tree over display-hex txids: the root in header byte order. */
function levels(ids) {
  let level = ids.map((t) => reverse(hexToBytes(t)));
  const out = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(concatBytes(level[i], level[i + 1] ?? level[i])));
    out.push((level = next));
  }
  return out;
}
export function merkleRoot(ids) {
  if (!ids.length) return new Uint8Array(32);
  const l = levels(ids);
  return l[l.length - 1][0];
}
export function merkleBranch(ids, pos) {
  const out = [];
  let p = pos;
  for (const level of levels(ids).slice(0, -1)) {
    const sib = level[p ^ 1] ?? level[p];
    out.push(bytesToHex(reverse(sib)));
    p >>= 1;
  }
  return out;
}

export function headerHex(height, time = 1791790000 + height) {
  const h = new Uint8Array(120);
  h.set(u32(0x20001000), 0);
  h.set(u32(time), 68);
  h.set(u32(height), 76);
  return bytesToHex(h);
}

export { hashToHex, reverse, sha256d };
