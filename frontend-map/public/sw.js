// Offline-tolerant caching for DIGDHRISHTI: keeps the app usable (last-known camera
// registry, alerts, and app shell) when the network drops mid-shift, instead
// of going blank. Deliberately narrow in scope:
//   - GET only. Every PATCH/POST/PUT/DELETE (alert status updates, camera
//     writes) passes straight through untouched -- caching a mutation, or
//     serving one from cache, would silently corrupt state.
//   - Live media (HLS manifests/segments under /stream/, WebRTC WHEP) is
//     never cached. A cached video chunk is not "offline tolerance", it's a
//     frozen frame pretending to be live -- worse than an honest error.
//   - Everything else (same-origin app shell + cross-origin registry/
//     watchlist JSON) is network-first with a cache fallback: always prefer
//     a live answer, only fall back to the last-known one when the network
//     genuinely fails.
const CACHE_NAME = 'netra-runtime-v1';

const NEVER_CACHE = /\/stream\/|\.m3u8($|\?)|\.ts($|\?)|\/whep($|\?)/;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Web Push -- an alert (watchlist match, congestion, camera-down,
// escalation; see backend-registry/backend-watchlist's push_service.py)
// arrives here even when no tab has the app open. Payload shape is always
// {title, body, url} -- url is what notificationclick below opens.
self.addEventListener('push', (event) => {
  let payload = { title: 'DIGDHRISHTI', body: 'New alert', url: '/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Malformed/non-JSON push payload -- show the generic fallback above
    // rather than silently dropping the notification.
  }

  event.waitUntil(
    // No icon set: this PWA doesn't ship one yet (manifest.json's own
    // icons array is empty too) -- browsers fall back to a default
    // notification icon rather than showing a broken image.
    self.registration.showNotification(payload.title, {
      body: payload.body,
      data: { url: payload.url },
    })
  );
});

// Focuses an existing DIGDHRISHTI tab if one's already open (navigating it
// to the alert's page) rather than always opening a new one -- an officer
// with the app already open in the background shouldn't end up with two tabs.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (NEVER_CACHE.test(request.url)) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Only cache genuinely good responses -- caching a 401/500 would mean
        // "offline" serves back the same error forever instead of the last
        // real data.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
