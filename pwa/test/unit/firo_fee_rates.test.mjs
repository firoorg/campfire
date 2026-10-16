// The FIRO wallet's fee rates (lib/firo/transparent.js feeRates): never below the relay fee, never
// above the cap, whatever the server estimates (audit D-03). Live servers were seen estimating under
// the relay fee on 2026-10-15; paying that would leave a transaction nobody relays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TransparentWallet } from '../../src/lib/firo/transparent.js';
import { NETWORKS } from '../../src/lib/firo/params.js';

const rates = (client) => TransparentWallet.prototype.feeRates.call({ client, net: NETWORKS.main });

test('an estimate under the relay fee is raised to it; one above the cap is cut to it; none known: the floor', async () => {
  const under = await rates({ relayFee: async () => 1000n, estimateFee: async () => 400n });
  assert.deepEqual(under, { fast: 1000n, normal: 1000n, slow: 1000n, min: 1000n });
  const absurd = await rates({ relayFee: async () => 1000n, estimateFee: async () => 10n ** 9n });
  assert.equal(absurd.fast, NETWORKS.main.maxFeePerKb);
  const none = await rates({ relayFee: async () => { throw new Error('down'); }, estimateFee: async () => null });
  assert.equal(none.normal, NETWORKS.main.minRelayFeePerKb);
});
