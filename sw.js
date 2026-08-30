const CACHE = 'presencer-v7';
// La libreria Supabase sta su CDN: senza copia in cache, un avvio senza rete
// (o con rete lenta) lascia l'app senza login e con la schermata vuota.
const VENDOR = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './native.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).then(() => c.add(VENDOR).catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) {
    // La libreria da CDN: prima la cache (avvio immediato e funzionante offline),
    // aggiornandola in background. Tutto il resto (API Supabase) passa diretto.
    if (e.request.url === VENDOR) {
      e.respondWith(
        caches.match(e.request).then(hit => {
          const net = fetch(e.request).then(res => {
            if (res && res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
            return res;
          }).catch(() => hit);
          return hit || net;
        })
      );
    }
    return;
  }

  // network-first: quando c'è connessione usa sempre la versione più recente
  // (offline, o rete lenta, torna alla copia in cache così l'app resta usabile)
  e.respondWith(
    fetch(e.request).then(res => {
      caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
      for(const client of list){
        if('focus' in client) return client.focus();
      }
      return clients.openWindow ? clients.openWindow(target) : null;
    })
  );
});
