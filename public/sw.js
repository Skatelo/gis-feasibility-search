// Minimal service worker — its ONLY job is to make the site installable as a
// standalone web app. It does NOT cache anything: every request (pages, assets,
// and every API/proxy call) goes straight to the network, exactly like the
// browser. So the installed app on iOS, Android and desktop is byte-for-byte
// identical to the live website — same code, same data, no offline staleness,
// no reduced functionality.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove any caches left by earlier versions so nothing stale is ever served.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// A pass-through fetch handler: it does NOT call respondWith(), so the browser
// handles every request natively. Present only so browsers that still gate the
// install prompt on a fetch handler will offer "Install app".
self.addEventListener('fetch', () => { /* network, handled by the browser */ });
