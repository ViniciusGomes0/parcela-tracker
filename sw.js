'use strict';
var CACHE = 'parcelas-v5';
var ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest'];

self.addEventListener('install', function (ev) {
  self.skipWaiting();
  ev.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(ASSETS); })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Network-first for the app shell: always try to fetch the latest version first,
// only falling back to cache when offline (so updates show up on the very next load).
self.addEventListener('fetch', function (ev) {
  if (ev.request.method !== 'GET') return;
  ev.respondWith(
    fetch(ev.request).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(ev.request, copy); });
      }
      return res;
    }).catch(function () { return caches.match(ev.request); })
  );
});
