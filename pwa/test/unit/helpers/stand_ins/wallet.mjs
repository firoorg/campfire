// lib/wallet.js as a screen test needs it: `wallet` is a plain object each test fills (reset());
// the helpers screens import by name are the real ones' words.
export const MIN_CONFIRMATIONS = 1;
export const SPARK_MEMO_MAX = 31;
export const isPendingTx = (tx) => !(Number(tx && tx.confirmations) >= MIN_CONFIRMATIONS);

export const wallet = {};

const listeners = new Set();

/** Empties the stand-in and fills it with `over` on top of a synced wallet holding 9 private and 5 public FIRO. */
export function reset(over = {}) {
  for (const k of Object.keys(wallet)) delete wallet[k];
  listeners.clear();
  Object.assign(
    wallet,
    {
      session: true,
      state: { sync: { canSend: true, title: 'Up to date', detail: '' }, balance: { private: { available: 900000000n, pending: 0n }, public: { available: 500000000n, pending: 0n } }, receive: { spark: 'sm1own', transparent: 'aOwn' }, txs: [], tip: { height: 1000 }, viewOnly: false },
      available(from = 'private') {
        return this.state.balance[from === 'public' ? 'public' : 'private'].available;
      },
      classifyAddress: (a) => (/^sm1/.test(a) ? { kind: 'spark', address: a } : /^a/.test(a) ? { kind: 'transparent', address: a } : { kind: 'invalid' }),
      onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      emit() {
        for (const fn of [...listeners]) fn(this.state);
      },
      pinSparkName: async () => {},
      nameFeeFiro: (n, years = 1) => years,
      nameIsFree: async () => true,
      // The network fee a registration would pay, shown and pinned (L7): 0.0001 FIRO here.
      quoteName: async ({ years = 1 }) => ({ fee: 10000n, total: BigInt(years) * 100000000n + 10000n }),
    },
    over,
  );
  return wallet;
}
reset();
