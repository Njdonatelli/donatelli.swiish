/* global self, caches */
// Kill switch. Browsers that installed the Swiish worker keep asking for this URL; answering with a
// worker that removes itself (and the app-shell cache it filled) is the only way to reach them, because
// a cached index.html would otherwise keep serving the old app offline.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => client.navigate(client.url));
    })()
  );
});
