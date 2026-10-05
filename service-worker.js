const CACHE_NAME = 'blending-station-v43';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// Install: cache all assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches and take control immediately.
// Only our own: TankLabel's caches live on the same origin.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k.startsWith('blending-station-') && k !== CACHE_NAME)
        .map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first for HTML, cache fallback for rest
self.addEventListener('fetch', event => {
  // Non intercettare richieste verso TankLabel: è un'app separata
  const url = new URL(event.request.url);
  if (url.pathname.includes('/tanklabel/')) {
    return;
  }

  if (event.request.mode === 'navigate') {
    // Always try network first for page navigation
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Update cache with fresh version
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request);
      })
    );
  }
});

// Listen for messages from the page
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
