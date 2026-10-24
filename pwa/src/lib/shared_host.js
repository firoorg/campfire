// Hosts that serve many people's files from one origin, the copies the app updates from among them:
// a wallet opened there would share its storage with every other page on that host, and any of them
// could read or replace it (public audit, H9). Those copies serve release files only; the app
// refuses to run from them (app.js). No imports: it loads with the first screen.

/** Whether `hostname` is such a shared host. */
export function sharedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return /\.github\.io$/.test(h) || h === 'raw.githubusercontent.com' || h === 'cdn.jsdelivr.net' || h === 'fastly.jsdelivr.net' || h === 'gcore.jsdelivr.net';
}
