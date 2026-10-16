// A fake Spark client with the interface of src/lib/firo/spark_iface.js, for
// the backend tests: no cryptography, just bookkeeping. Coins are "ours" when
// the test registered them with own(); their linking tag is fakeTag(id), so a
// test spends one by listing that tag as used.

import { bech32m } from '../../src/vendor/noble/scure-base/index.js';
import { sha256, concatBytes, bytesToHex, utf8ToBytes } from '../../src/lib/firo/bytes.js';
import { lTagHash } from '../../src/lib/firo/tx.js';
import { fakeTag } from './firo_fake_chain.mjs';

const key60 = (coin) => bytesToHex(coin.subarray(0, 60));

/** As the real library hands spent coins back: the coin itself, without the set's tx hash and context (fakeCoin bodies are 60 bytes). */
const body = (coin) => (coin instanceof Uint8Array && coin.length > 60 ? coin.subarray(0, 60) : coin);

export class FakeSpark {
  constructor() {
    this.mine = new Map(); // first 60 bytes hex → {id, value, memo, diversifier}
    this.calls = [];
    this.fee = 10000n;
  }

  /** Marks a fake coin (firo_fake_chain fakeCoin) as ours. */
  own(c, { value, memo = '', diversifier = 1 } = {}) {
    this.mine.set(key60(c.coin), { id: c.id, value: value ?? c.value, memo, diversifier });
    return lTagHash(fakeTag(c.id));
  }

  _addr(seed, diversifier, isTestNet) {
    const raw = sha256(concatBytes(seed, utf8ToBytes(`d${diversifier}`)));
    const bytes = concatBytes(raw, raw, raw.subarray(0, 20));
    return bech32m.encode(isTestNet ? 'st' : 'sm', bech32m.toWords(bytes), 200);
  }

  async getFullViewKey({ keyData, index }) {
    this.calls.push('getFullViewKey');
    return concatBytes(sha256(keyData), Uint8Array.of(index));
  }

  async getAddress({ keyData, diversifier, isTestNet }) {
    return this._addr(sha256(concatBytes(sha256(keyData), Uint8Array.of(1))), diversifier, isTestNet);
  }

  async getAddressFromFullViewKey({ fullViewKey, diversifier, isTestNet }) {
    return this._addr(sha256(fullViewKey), diversifier, isTestNet);
  }

  async isValidSparkAddress({ address }) {
    return !address.includes('qqqqqqqqqqqqqqqqqqqqqq');
  }

  async identifyCoins({ coins }) {
    this.calls.push(`identify:${coins.length}`);
    return coins.map(({ coin }) => {
      const m = this.mine.get(key60(coin));
      if (!m) return null;
      return { value: m.value, memo: m.memo, diversifier: m.diversifier, lTagHash: lTagHash(fakeTag(m.id)) };
    });
  }

  async serializeMintContext({ inputs }) {
    this.calls.push('serializeMintContext');
    this.lastMintInputs = inputs;
    return utf8ToBytes(inputs.map((i) => `${i.txid}:${i.vout}`).join(','));
  }

  async createSparkMintRecipients({ outputs, serialContext, generate }) {
    this.calls.push(`mint:${generate}`);
    if (generate) this.lastMintContext = serialContext;
    return outputs.map((o) => ({ script: concatBytes(Uint8Array.of(0xd1), generate ? sha256(concatBytes(serialContext, utf8ToBytes(o.address))) : new Uint8Array(32), new Uint8Array(200)), value: o.value }));
  }

  async estimateSparkFee({ coins, sendAmount, subtractFee }) {
    this.calls.push('estimate');
    const have = coins.reduce((s, c) => s + this._value(c), 0n);
    if (have < sendAmount + (subtractFee ? 0n : this.fee)) throw new Error('Insufficient funds');
    return this.fee;
  }

  _value(c) {
    return this.mine.get(key60(c.coin))?.value ?? 0n;
  }

  async createSparkSpendTransaction(args) {
    this.calls.push('spend');
    this.lastSpend = args;
    const need = [...args.recipients, ...args.privateRecipients].reduce((s, r) => s + r.value, 0n) + (args.recipients.some((r) => r.subtractFee) ? 0n : this.fee);
    const used = [];
    let sum = 0n;
    for (const c of args.coins) {
      if (sum >= need) break;
      used.push(c);
      sum += this._value(c);
    }
    const outs = args.privateRecipients.map(() => concatBytes(Uint8Array.of(0xd2), new Uint8Array(100)));
    if (sum > need) outs.push(concatBytes(Uint8Array.of(0xd2), new Uint8Array(100).fill(9))); // change
    return { payload: concatBytes(Uint8Array.of(2), args.txHashSig), outputScripts: outs, fee: this.fee, usedCoins: used.map((c) => ({ coin: body(c.coin), groupId: c.groupId })) };
  }
}
