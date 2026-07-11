/* PANDAI — Service Worker (PWA offline-first untuk app shell).
   Strategi:
   - Permintaan ke Apps Script (script.google.com) & semua POST → langsung ke jaringan, TIDAK di-cache
     (API dinamis; ketahanan offline API ditangani antrean di api.js).
   - Aset statis se-origin (GET) → cache-first + isi ulang di latar (stale-while-revalidate).
   URL relatif diselesaikan terhadap lokasi SW, sehingga aman di GitHub Pages subpath. */
var VERSI = 'pandai-v1.0.0';
var PRECACHE = [
  './', './index.html', './config.js', './manifest.webmanifest',
  './assets/js/api.js', './assets/js/omr.js',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png',
  './frontend/ujian.html', './frontend/guru.html', './frontend/pembuat-soal.html',
  './frontend/pengawas.html', './frontend/dinas.html', './frontend/kepsek.html',
  './frontend/omr.html'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSI).then(function (c) {
    // tambah satu per satu agar satu berkas hilang tidak menggagalkan seluruh precache
    return Promise.all(PRECACHE.map(function (u) {
      return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { if (k !== VERSI) return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                         // POST API → biarkan ke jaringan
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // lintas-origin (Apps Script, gambar Drive) → jaringan
  e.respondWith(
    caches.match(req).then(function (cached) {
      var jaringan = fetch(req).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          var salin = resp.clone();
          caches.open(VERSI).then(function (c) { c.put(req, salin); });
        }
        return resp;
      }).catch(function () { return cached; });
      return cached || jaringan;
    })
  );
});
