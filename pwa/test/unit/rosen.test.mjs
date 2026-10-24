// lib/rosen on real crossings (test/fixtures/rosen_real.json, tools/rosen_fixtures.mjs) and on the
// fee rule. No refund exists on Rosen, so the builders are tested by rebuilding real transactions
// byte for byte, and the trackers by recognising real deliveries and refusing near-misses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  quote, encodePayload, decodePayload, firoLockOutputs, verifyFiroLockTx, evmExitCall, verifyEvmExitCall,
  eventIdOfFiroLock, isEvmDelivery, isFiroPayout, firoDestinationScript, evmAddressBytes, RosenError, LOCK, RSFIRO, NETWORK_FEE,
} from '../../src/lib/rosen/rosen.js';
import { decodeTx } from '../../src/lib/firo/tx.js';
import { NETWORKS } from '../../src/lib/firo/params.js';

const MAIN = NETWORKS.main;
const R = JSON.parse(readFileSync(new URL('../fixtures/rosen_real.json', import.meta.url), 'utf8'));
const hex = (b) => Buffer.from(b).toString('hex');
const SAT = 100000000n;

test('FIRO -> BNB Chain, the real 2,500 FIRO lock: its payload reads back and rebuilds byte for byte', () => {
  const d = decodeTx(R.firoLockToBsc.hex, MAIN);
  assert.equal(d.txid, R.firoLockToBsc.txid);
  const lockOut = d.vout.find((o) => o.address === LOCK.firo);
  assert.equal(BigInt(lockOut.value), 2500n * SAT);
  const op = d.vout.find((o) => o.type === 'nulldata');
  const p = decodePayload(op.data, MAIN);
  assert.equal(p.to, 'bsc');
  assert.equal(p.bridgeFee, 1250000000n); // 12.5 FIRO: 0.5% of 2,500
  assert.equal(p.networkFee, 1669737n);
  assert.match(p.destination, /^0x[0-9a-f]{40}$/);
  assert.equal(hex(encodePayload({ to: 'bsc', bridgeFee: p.bridgeFee, networkFee: p.networkFee, destination: p.destination }, MAIN)), hex(op.data));
  // The plan this wallet would make for it, checked against the real transaction.
  const plan = { to: 'bsc', destination: p.destination, amount: 2500n * SAT, bridgeFee: p.bridgeFee, networkFee: p.networkFee, ...firoLockOutputs({ to: 'bsc', destination: p.destination, amount: 2500n * SAT, bridgeFee: p.bridgeFee, networkFee: p.networkFee }, MAIN) };
  const others = d.vout.filter((o) => o.type !== 'nulldata' && o.address !== LOCK.firo).map((o) => o.address);
  assert.deepEqual(verifyFiroLockTx(R.firoLockToBsc.hex, plan, { net: MAIN, isOwnChange: (a) => others.includes(a) }), []);
  // …and refused when anything differs, or when change goes elsewhere.
  assert.ok(verifyFiroLockTx(R.firoLockToBsc.hex, { ...plan, amount: 2400n * SAT }, { net: MAIN, isOwnChange: (a) => others.includes(a) }).length > 0);
  assert.ok(verifyFiroLockTx(R.firoLockToBsc.hex, plan, { net: MAIN, isOwnChange: () => false }).length > 0);
  const wrongDest = firoLockOutputs({ to: 'bsc', destination: `0x${'11'.repeat(20)}`, amount: 2500n * SAT, bridgeFee: p.bridgeFee, networkFee: p.networkFee }, MAIN);
  assert.ok(verifyFiroLockTx(R.firoLockToBsc.hex, { ...plan, ...wrongDest, destination: `0x${'11'.repeat(20)}` }, { net: MAIN, isOwnChange: (a) => others.includes(a) }).length > 0);
});

test("Rosen's event id is BLAKE2b-256 of the lock's txid text, and the real BNB Chain delivery carries it", () => {
  const id = eventIdOfFiroLock(R.firoLockToBsc.txid);
  assert.equal(id, R.firoLockToBsc.eventId);
  const del = R.firoLockToBsc.bscDelivery;
  assert.ok(del.input.toLowerCase().endsWith(id));
  const p = decodePayload(decodeTx(R.firoLockToBsc.hex, MAIN).vout.find((o) => o.type === 'nulldata').data, MAIN);
  const receive = 2500n * SAT - p.bridgeFee - p.networkFee; // 2,487.48330263
  assert.equal(receive, 248748330263n);
  const want = { to: 'bsc', destination: p.destination, receive, lockTxid: R.firoLockToBsc.txid };
  assert.equal(isEvmDelivery(del, want), true);
  // Near-misses are not arrivals.
  assert.equal(isEvmDelivery(del, { ...want, receive: receive - 1n }), false);
  assert.equal(isEvmDelivery(del, { ...want, lockTxid: R.ethExitToFiro.firoPayout.txid }), false);
  assert.equal(isEvmDelivery({ ...del, from: `0x${'22'.repeat(20)}` }, want), false);
  assert.equal(isEvmDelivery(del, { ...want, destination: `0x${'33'.repeat(20)}` }), false);
});

test('Ethereum -> FIRO, the real 3,000 rsFIRO exit: the call rebuilds byte for byte, and the payout is recognised', () => {
  const exit = R.ethExitToFiro.exit;
  assert.equal(exit.to.toLowerCase(), RSFIRO.ethereum);
  const data = exit.input.toLowerCase().replace(/^0x/, '');
  const p = decodePayload(data.slice(8 + 128), MAIN);
  assert.equal(p.to, 'firo');
  assert.equal(p.bridgeFee, 15n * SAT);
  assert.equal(p.networkFee, 500452n);
  assert.match(p.destination, /^a[1-9A-HJ-NP-Za-km-z]{33}$/);
  const call = evmExitCall({ from: 'ethereum', destination: p.destination, amount: 3000n * SAT, bridgeFee: p.bridgeFee, networkFee: p.networkFee }, MAIN);
  assert.equal(call.data, `0x${data}`);
  assert.equal(call.to, RSFIRO.ethereum);
  const plan = { from: 'ethereum', destination: p.destination, amount: 3000n * SAT, bridgeFee: p.bridgeFee, networkFee: p.networkFee };
  assert.deepEqual(verifyEvmExitCall(call, plan, MAIN), []);
  assert.ok(verifyEvmExitCall({ ...call, value: 1n }, plan, MAIN).length > 0);
  assert.ok(verifyEvmExitCall(call, { ...plan, amount: 2999n * SAT }, MAIN).length > 0);
  // Rosen's FIRO payout: from its lock address, 2,984.99999548 for an estimate of 2,984.99499548.
  const estimate = 3000n * SAT - p.bridgeFee - p.networkFee;
  assert.equal(isFiroPayout(R.ethExitToFiro.firoPayout.hex, { destination: p.destination, receive: estimate }, MAIN), true);
  assert.equal(isFiroPayout(R.ethExitToFiro.firoPayout.hex, { destination: p.destination, receive: estimate + NETWORK_FEE.firo + 1n }, MAIN), false);
  assert.equal(isFiroPayout(R.firoLockToBsc.hex, { destination: p.destination, receive: estimate }, MAIN), false, 'not from the lock address');
});

test('BNB Chain -> FIRO, the real 3,000 rsFIRO exit rebuilds byte for byte', () => {
  const exit = R.bscExitToFiro.exit;
  const data = exit.input.toLowerCase().replace(/^0x/, '');
  const p = decodePayload(data.slice(8 + 128), MAIN);
  assert.equal(p.to, 'firo');
  assert.equal(p.bridgeFee, 15n * SAT);
  const call = evmExitCall({ from: 'bsc', destination: p.destination, amount: BigInt(`0x${data.slice(8 + 64, 8 + 128)}`), bridgeFee: p.bridgeFee, networkFee: p.networkFee }, MAIN);
  assert.equal(call.data, `0x${data}`);
  assert.equal(call.to, RSFIRO.bsc);
});

test("the fee: the larger of exactly $10 in FIRO (rounded up) or 0.5%; 0.5% from where it reaches that; no price or an absurd one, no quote", () => {
  const price = 0.9486;
  const small = quote({ from: 'firo', to: 'bsc', amount: 100n * SAT, firoUsd: price });
  assert.equal(small.bridgeFee, small.minBridgeFee);
  assert.ok(Number(small.minBridgeFee) / 1e8 >= 10 / price, 'never below $10');
  assert.ok(Number(small.minBridgeFee) / 1e8 <= (10 / price) + 0.0001, 'exactly $10: no margin over it (the rule since 2026-10-15)');
  assert.equal(small.networkFee, NETWORK_FEE.bsc);
  assert.equal(small.receive, 100n * SAT - small.bridgeFee - small.networkFee);
  assert.ok(small.costPct > 10 && small.warnings.length === 1);
  assert.equal(small.minBridgeFee, 1054190000n); // $10 at $0.9486, up to 1/10,000 FIRO
  assert.equal(small.zeroFrom, 2109n * SAT); // 0.5% of 2,109 FIRO >= 10.5419 FIRO
  const big = quote({ from: 'firo', to: 'ethereum', amount: 5000n * SAT, firoUsd: price });
  assert.equal(big.bridgeFee, 25n * SAT);
  assert.equal(big.networkFee, NETWORK_FEE.ethereum);
  const back = quote({ from: 'bsc', to: 'firo', amount: 3000n * SAT, firoUsd: price });
  assert.equal(back.bridgeFee, 15n * SAT);
  assert.equal(back.networkFee, NETWORK_FEE.firo);
  const tiny = quote({ from: 'firo', to: 'bsc', amount: 5n * SAT, firoUsd: price });
  assert.equal(tiny.ok, false);
  assert.equal(tiny.receive, 0n);
  assert.throws(() => quote({ from: 'firo', to: 'bsc', amount: 100n * SAT, firoUsd: null }), (e) => e instanceof RosenError && e.code === 'no-price');
  // A price no one should believe: no quote (audit D-05).
  assert.throws(() => quote({ from: 'firo', to: 'bsc', amount: 100n * SAT, firoUsd: 400 }), (e) => e.code === 'no-price' && /cannot be right/.test(e.message));
  assert.throws(() => quote({ from: 'firo', to: 'bsc', amount: 100n * SAT, firoUsd: 0.001 }), (e) => e.code === 'no-price');
  assert.throws(() => quote({ from: 'ethereum', to: 'bsc', amount: 100n * SAT, firoUsd: price }), (e) => e.code === 'route');
});

test('destinations Rosen cannot pay are refused before any bytes exist', () => {
  assert.throws(() => firoDestinationScript('sm1x92ksewr9x6jv60pdl2ruweukrlr2pvc392rr4mn40wx0c666trsrfa3dsh6ttqu3lm8hw9ldqxaxs0tcmpc8emx0zrdvjp2jp5fa9q94x90kx7xgfjmnvc4kmrxwwsgj3pru2q79sh26', MAIN), (e) => e.code === 'destination');
  assert.throws(() => firoDestinationScript('0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2', MAIN), (e) => e.code === 'destination');
  assert.throws(() => evmAddressBytes('aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y'), (e) => e.code === 'destination');
  // A mixed-case address with a broken checksum (one letter's case flipped).
  assert.throws(() => evmAddressBytes('0x2744eA5Ac9b11CB5E3CD63D3a88E858336aEddc2'), (e) => e.code === 'destination');
  assert.equal(hex(evmAddressBytes('0x2744eA5Ac9b11CB5E3CD63D3a88E858336aEddC2')), '2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2');
  assert.throws(() => encodePayload({ to: 'ergo', bridgeFee: 1n, networkFee: 1n, destination: 'x' }, MAIN), (e) => e.code === 'route');
});
