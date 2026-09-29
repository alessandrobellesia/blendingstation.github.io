const CACHE_NAME = 'tanklabel-v32';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './styles.css',
  './ocr-engine.js',
  './export-utils.js',
  './digit-templates.js',
  './bluetooth-print.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

// Install: pre-carica tutti gli asset sempre freschi dalla rete
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        ASSETS.map(url =>
          fetch(url, { cache: 'no-store' })
            .then(r => { if (r.ok) cache.put(url, r); })
            .catch(() => {}) // se offline durante install, ignora
        )
      )
    )
  );
  self.skipWaiting(); // attiva subito senza aspettare che tutte le tab chiudano
});

// Activate: elimina cache vecchie e prendi controllo immediato
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // controlla tutte le tab aperte subito
});

// Fetch: NETWORK FIRST per tutti i file
// → quando online ottieni sempre la versione più recente
// → quando offline usa la cache come fallback
self.addEventListener('fetch', event => {
  // Ignora richieste non-GET e cross-origin
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(response => {
        // Aggiorna la cache con la versione fresca
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() =>
        // Offline: usa la cache
        caches.match(event.request)
          .then(cached => cached || caches.match('./index.html'))
      )
  );
});

// Messaggio dalla pagina per forzare aggiornamento
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
