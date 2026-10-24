// lib/session.js as lib/auth_ui.js sees it, for a screen test: a wallet with or without a passkey
// (app.record.passkey), the password "right" opening it, Face ID answering yes, each try recorded.
export const tries = [];
export const hasPasskey = (app) => Boolean(app && app.record && app.record.passkey);
export async function openWithPasswordFor(_app, pw) {
  tries.push(['password', pw]);
  if (pw !== 'right') throw Object.assign(new Error('wrong'), { code: 'wrong_secret' });
  return new Uint8Array(32);
}
export async function openWithPasskeyFor() {
  tries.push(['passkey']);
  return new Uint8Array(32);
}
