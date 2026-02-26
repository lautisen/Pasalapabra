const CACHE_NAME = 'pasalapabra-v2';
const ASSETS = [
    '/Pasalapabra/',
    '/Pasalapabra/index.html',
    '/Pasalapabra/app.js',
    '/Pasalapabra/styles.css',
    // We intentionally don't aggressively cache the external CDNs in the SW
    // because the browser HTTP cache handles them well enough for PWA install requirements.
    // The google sheets CSV is handled strictly by the LocalStorage logic in app.js.
];

// Install Event: Cache essential files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Archivos en caché para uso offline');
                // The trailing slash in the paths might cause 404s if running locally without a server,
                // but we will use `{ cache: 'reload' }` to ensure it fetches fresh on install if possible.
                return cache.addAll(ASSETS);
            })
            .then(() => self.skipWaiting())
    );
});

// Activate Event: Cleanup old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('Limpiando caché antigua:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
    return self.clients.claim();
});

// Fetch Event: Serve from cache, fallback to network
self.addEventListener('fetch', event => {
    // We only want to handle GET requests
    if (event.request.method !== 'GET') return;

    // Ignore external API endpoints like Google Sheets (which is handled by app.js localStorage)
    if (event.request.url.includes('docs.google.com') || event.request.url.includes('firestore.googleapis.com')) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Return cached version if found
                if (response) {
                    return response;
                }
                // Otherwise fetch from network
                return fetch(event.request).then(
                    function (response) {
                        // Check if we received a valid response
                        if (!response || response.status !== 200 || response.type !== 'basic') {
                            return response;
                        }
                        // Clone the response because it's a stream
                        var responseToCache = response.clone();
                        caches.open(CACHE_NAME)
                            .then(function (cache) {
                                cache.put(event.request, responseToCache);
                            });
                        return response;
                    }
                );
            })
            .catch(() => {
                // Fallback for offline if the resource isn't in cache
                // You could return an offline page here if you had one
                console.log('Offline: No se pudo cargar', event.request.url);
            })
    );
});
