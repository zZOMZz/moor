importScripts('/notification-worker.js');
const CACHE = 'personal-shell-__BUILD__';
const ASSETS = [
  /* __ASSETS__ */
];
self.addEventListener('install', (e) =>
  // Keep the previous worker and its hashed assets while any of its pages are
  // open. The browser activates this version after those clients have closed.
  // Switching a worker must never force-reload a composer or replay an operation.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))),
);
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('personal-shell-') && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || !ASSETS.includes(u.pathname))
    return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => (await c.match(u.pathname)) || fetch(e.request)),
  );
});
