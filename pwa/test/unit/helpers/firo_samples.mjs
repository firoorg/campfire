// Firo addresses with the right shape for tests (lib/firo_uri.js addressShape). Shape only: they
// are made up and hold no checksum; never pay them.
const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
let x = 7;
let body = '';
for (let i = 0; i < 141; i++) {
  x = (x * 1103515245 + 12345) & 0x7fffffff;
  body += BECH[x % BECH.length];
}
export const SPARK = `sm1${body}`;
// A real mainnet transparent address (the Spark name fee address Campfire pays to).
export const TRANSPARENT = 'aFA2TbqG9cnhhzX5Yny2pBJRK5EaEqLCH7';
export const EXCHANGE = 'EXXbT5rKpDu4YYrcrmL7Uh9x2Q3s2nYFiQs';
export const ETH_ADDR = '0x52908400098527886E0F7030069857D2E4169EE7';
