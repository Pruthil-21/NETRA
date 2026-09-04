'use client';

import { useEffect } from 'react';

/** Registers public/sw.js once on mount. Renders nothing -- this is a side
 * effect, not UI. Registration failures (unsupported browser, dev-server
 * quirks) are swallowed: a missing service worker should degrade to "no
 * offline cache", never break the app itself. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  return null;
}

export default ServiceWorkerRegistration;
