// Rosen's lock addresses (contracts release 7.1.1, checked on live crossings), on their own so a
// screen can refuse them as a payment's recipient without loading the bridge (lib/rosen/rosen.js
// re-exports them as LOCK). Coins paid to one without the bridge's details are lost.
export const LOCK = Object.freeze({
  firo: 'aEF6fyd5jjCPcbiEBZJ2g8583caUme8T7Y',
  ethereum: '0x451698faa07fc68301af622a3ad42205f13c6e4b',
  bsc: '0x34c9f8a268df15fb38811800cb6e7f6a109cd0e7',
});
