// lib/eth/send_raw.js for a test of what a caller asks of it: each request is kept (captured), none is
// shown or sent; it answers as a sent one.
export const captured = [];
export async function sendRaw(_app, req) {
  captured.push(req);
  return { hash: `0x${'ab'.repeat(32)}`, sent: true };
}
