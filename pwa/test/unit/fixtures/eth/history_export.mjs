// What Stack Wallet's history index (GET /export) answers, in its own shape
// (field names and types as served in 2026-10), for anvil's account 0 and
// made-up counterparties. Built here rather than recorded, so it carries no
// real person's history.
export const ME = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
export const ALICE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const BOB = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
export const TOKEN_ADDR = '0x2744ea5ac9b11cb5e3cd63d3a88e858336aeddc2'; // rsFIRO, 8 decimals
export const USDT_ADDR = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const word = (hex) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`;
export const h = (n) => `0x${n.toString(16).padStart(64, '0')}`;

export function txs() {
  return {
    data: [
      // 1 ETH in, from Alice
      { blockHash: h(0xb1), blockNumber: 100, date: '2026-01-01 00:00:00 UTC', ether: '1', from: ALICE, gas: 21000, gasCost: 21000000000000, gasPrice: 1000000000, gasUsed: 21000, hash: h(1), nonce: 7, receipt: { contractAddress: '0x0', effectiveGasPrice: 1000000000, gasUsed: 21000, logs: [], status: 1 }, timestamp: 1767225600, to: ME, traces: [], transactionIndex: 3, value: '1000000000000000000' },
      // 0.25 ETH out, to Bob: the fee is gasUsed x effectiveGasPrice, exactly (gasCost is a JSON number; here it is wrong on purpose)
      { blockHash: h(0xb2), blockNumber: 200, from: ME, gas: 21000, gasCost: 1, gasPrice: 30000000000, gasUsed: 21000, hash: h(2), nonce: 0, receipt: { effectiveGasPrice: 12345678901, gasUsed: 21000, logs: [], status: 1 }, timestamp: 1767312000, to: BOB, value: '250000000000000000' },
      // a rsFIRO transfer this address sent: a 0-ETH contract call, shown through its token log
      { blockHash: h(0xb3), blockNumber: 300, from: ME, gas: 60000, gasCost: 0, gasPrice: 1, gasUsed: 51000, hash: h(3), input: '0xa9059cbb', nonce: 1, receipt: { effectiveGasPrice: 2000000000, gasUsed: 51000, logs: [], status: 1 }, timestamp: 1767398400, to: TOKEN_ADDR, value: '0', hasToken: true },
      // a failed payment out: the fee was spent, nothing moved
      { blockHash: h(0xb4), blockNumber: 400, from: ME, gas: 21000, gasCost: 0, gasPrice: 1, gasUsed: 21000, hash: h(4), nonce: 2, receipt: { effectiveGasPrice: 1000000000, gasUsed: 21000, logs: [], status: 0 }, timestamp: 1767484800, to: BOB, value: '5' },
      // junk the parser must drop
      { hash: 'nope', from: ME, to: BOB, value: '1' },
      { hash: h(5), from: ALICE, to: BOB, value: '1', blockNumber: 500 }, // does not name this address
      { hash: h(6), from: ME, to: BOB, value: 1.5, blockNumber: 600 }, // not an integer
      null,
    ],
  };
}

export function tokenLogs() {
  return {
    data: [
      // 12.5 rsFIRO out to Bob (h(3) above)
      { address: TOKEN_ADDR, blockHash: h(0xb3), blockNumber: 300, data: word((1250000000).toString(16)), logIndex: 5, timestamp: 1767398400, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', word(ME.slice(2)), word(BOB.slice(2))], transactionHash: h(3), transactionIndex: 1 },
      // 100 rsFIRO in from Alice, in a transaction this address did not send
      { address: TOKEN_ADDR, blockHash: h(0xb7), blockNumber: 700, data: word((10000000000).toString(16)), logIndex: 0, timestamp: 1767657600, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', word(ALICE.slice(2)), word(ME.slice(2))], transactionHash: h(7), transactionIndex: 0 },
      // an Approval: not a movement
      { address: TOKEN_ADDR, blockNumber: 800, data: word('ff'), logIndex: 1, timestamp: 1767744000, topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', word(ME.slice(2)), word(BOB.slice(2))], transactionHash: h(8), transactionIndex: 0 },
      // claims to be rsFIRO but was emitted by another contract
      { address: USDT_ADDR, blockNumber: 900, data: word('01'), logIndex: 0, timestamp: 1767830400, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', word(ALICE.slice(2)), word(ME.slice(2))], transactionHash: h(9), transactionIndex: 0 },
    ],
  };
}
