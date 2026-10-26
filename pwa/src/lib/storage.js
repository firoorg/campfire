// Whether the browser keeps this app's storage (the wallets in IndexedDB, the
// verified copy in Cache Storage) or may clear it under pressure. Asked for once
// a wallet exists; the answer is shown in Settings -> About. No network.
//
// Chrome grants it silently, and only to a site it trusts more: installed, bookmarked, allowed to
// notify, or often used. So it is asked again when one of those changes while the app runs: the app
// installed (here), notifications allowed (screens/notifications.js).
import { t } from './i18n.js';

let watching = false;

export async function refreshPersistence(app, { request = false } = {}) {
  const s = navigator.storage;
  if (!s || typeof s.persisted !== 'function') {
    app.persisted = null;
    return null;
  }
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    window.addEventListener('appinstalled', () => {
      if (app.record) refreshPersistence(app, { request: true });
    });
  }
  try {
    let kept = await s.persisted();
    if (!kept && request && typeof s.persist === 'function') kept = await s.persist();
    app.persisted = Boolean(kept);
  } catch {
    app.persisted = null;
  }
  return app.persisted;
}

export function persistenceText(persisted) {
  if (persisted === true) return 'kept';
  if (persisted === false) return t('may be cleared by the system');
  return t('unknown in this browser');
}
