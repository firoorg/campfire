// Handing a file to the person: the encrypted backup (lib/backup_file.js), its cloud copy, and
// the payment history as CSV (lib/tx_csv.js). The share sheet where the browser has one for
// files (iPhone: Save to Files, AirDrop), else a download. Nothing is uploaded anywhere.

export { CLOUD_MIN_PASSWORD } from './backup_file.js';

/**
 * How a saved file reaches the person's cloud here. 'ios': the share sheet's Save to Files, then
 * iCloud Drive. 'mac': Safari's share sheet on a Mac has no Save to Files, so a download, then
 * iCloud Drive in Finder. 'other': the share sheet (Google Drive, Dropbox, ...) or a download.
 * iPadOS presents itself as a Mac with touch.
 */
export function cloudPlatform(nav = globalThis.navigator) {
  const ua = (nav && nav.userAgent) || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return 'ios';
  if (/Macintosh/.test(ua)) return 'mac';
  return 'other';
}

/** Share sheet where the browser has one for files, else a download. Needs a fresh tap. */
export async function deliverExport(file, { download = false, title = 'Firo PWA' } = {}) {
  if (!download && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    let can = false;
    try {
      can = navigator.canShare({ files: [file] });
    } catch {
      can = false;
    }
    if (can) {
      try {
        await navigator.share({ files: [file], title });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        // Not allowed here: fall back to a download.
      }
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

/** "1.2 KB": a file's size for people. */
export function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} bytes`;
  if (n < 1e6) return `${(n / 1000).toFixed(1)} KB`;
  return `${(n / 1e6).toFixed(1)} MB`;
}
