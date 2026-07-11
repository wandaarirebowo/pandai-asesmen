/**
 * PANDAI — klien API bersama.
 * - PANDAI.api(action, data)            : panggil backend (janji/promise)
 * - PANDAI.kirimAntre(action, data)     : masuk antrean tahan-gagal (autosave/submit/log)
 * - PANDAI.sesi() / simpanSesi() / keluar()
 * Antrean disimpan di localStorage, dikirim ulang otomatis dengan backoff
 * (5 dtk → 15 dtk → 1 mnt → 5 mnt) dan saat jaringan kembali online (PRD 5.3).
 */
(function () {
  var KUNCI_SESI = 'pandai_sesi';
  var KUNCI_ANTRE = 'pandai_antrean';
  var JEDA = [5000, 15000, 60000, 300000];
  var timerAntre = null;

  function config() { return window.PANDAI_CONFIG || { APPS_SCRIPT_URL: '' }; }
  function adaBackend() { return !!config().APPS_SCRIPT_URL; }

  function sesi() {
    try { return JSON.parse(localStorage.getItem(KUNCI_SESI) || 'null'); } catch (e) { return null; }
  }
  function simpanSesi(s) { localStorage.setItem(KUNCI_SESI, JSON.stringify(s)); }
  function keluar() {
    var s = sesi();
    if (s && adaBackend()) { api('auth.logout', { token: s.token }).catch(function () {}); }
    localStorage.removeItem(KUNCI_SESI);
    location.href = hitungAkar() + 'index.html';
  }
  function hitungAkar() {
    return location.pathname.indexOf('/frontend/') !== -1 ? '../' : './';
  }

  /** Panggilan API dasar. Content-Type text/plain agar bebas preflight CORS di Apps Script. */
  function api(action, data) {
    if (!adaBackend()) {
      return Promise.reject(new Error('MODE_DEMO: backend belum dikonfigurasi (isi config.js)'));
    }
    var s = sesi();
    return fetch(config().APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: s ? s.token : '', action: action, data: data || {} })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || 'Kesalahan server');
        return j.data;
      });
  }

  // ---------- antrean tahan-gagal ----------
  function bacaAntre() {
    try { return JSON.parse(localStorage.getItem(KUNCI_ANTRE) || '[]'); } catch (e) { return []; }
  }
  function tulisAntre(a) { localStorage.setItem(KUNCI_ANTRE, JSON.stringify(a)); }

  /** Masukkan ke antrean lalu coba kirim. Item identik (attemptId) tidak digandakan. */
  function kirimAntre(action, data) {
    var a = bacaAntre();
    var id = data && data.attemptId ? action + ':' + data.attemptId : action + ':' + Date.now() + ':' + Math.random();
    if (!a.some(function (x) { return x.id === id; })) {
      a.push({ id: id, action: action, data: data, gagal: 0 });
      tulisAntre(a);
    }
    prosesAntre();
    return id;
  }

  function prosesAntre() {
    if (timerAntre) return;
    var a = bacaAntre();
    if (!a.length || !adaBackend()) { siarkanStatus(); return; }
    var item = a[0];
    api(item.action, item.data).then(function () {
      var b = bacaAntre().filter(function (x) { return x.id !== item.id; });
      tulisAntre(b);
      siarkanStatus();
      prosesAntre();
    }).catch(function (err) {
      // galat non-jaringan yang bersifat permanen → buang agar antrean tidak macet
      var pesan = String(err && err.message || err);
      if (pesan.indexOf('MODE_DEMO') === -1 && pesan.indexOf('Failed to fetch') === -1 &&
          pesan.indexOf('NetworkError') === -1 && pesan.indexOf('load failed') === -1) {
        // server menjawab tapi menolak (mis. TERKUNCI) → simpan galat, teruskan item berikut
        item.galatTerakhir = pesan;
      }
      var b = bacaAntre();
      if (b.length && b[0].id === item.id) { b[0].gagal = (b[0].gagal || 0) + 1; b[0].galatTerakhir = pesan; tulisAntre(b); }
      var jeda = JEDA[Math.min((item.gagal || 0), JEDA.length - 1)];
      siarkanStatus();
      timerAntre = setTimeout(function () { timerAntre = null; prosesAntre(); }, jeda);
    });
  }

  function siarkanStatus() {
    try {
      document.dispatchEvent(new CustomEvent('pandai:antrean', { detail: { tertunda: bacaAntre().length, online: navigator.onLine } }));
    } catch (e) {}
  }

  window.addEventListener('online', function () {
    if (timerAntre) { clearTimeout(timerAntre); timerAntre = null; }
    prosesAntre();
  });

  // ---------- enkripsi paket pra-unduh (AES-GCM, kunci per-perangkat) ----------
  // Melindungi soal yang sudah diunduh H-1 dari terbaca di penyimpanan perangkat
  // (mis. HP sekolah dipakai bergantian). Payload memang tak memuat kunci jawaban;
  // ini pertahanan berlapis atas isi soal. Kunci disimpan per-perangkat (bukan rahasia
  // mutlak), tetapi ciphertext tak terbaca oleh aplikasi/pengguna lain tanpa menjalankan kode ini.
  var KUNCI_DEV = 'pandai_devkey';
  function adaCrypto() { return typeof crypto !== 'undefined' && crypto.subtle; }
  function b64(buf) { var b = ''; var a = new Uint8Array(buf); for (var i = 0; i < a.length; i++) b += String.fromCharCode(a[i]); return btoa(b); }
  function unb64(s) { var b = atob(s); var a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function kunciPerangkat() {
    return new Promise(function (resolve, reject) {
      var simpan = localStorage.getItem(KUNCI_DEV);
      if (simpan) {
        crypto.subtle.importKey('raw', unb64(simpan), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']).then(resolve, reject);
      } else {
        crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']).then(function (k) {
          crypto.subtle.exportKey('raw', k).then(function (raw) {
            localStorage.setItem(KUNCI_DEV, b64(raw)); resolve(k);
          }, reject);
        }, reject);
      }
    });
  }
  function enkripsi(obj) {
    if (!adaCrypto()) return Promise.resolve('PLAIN:' + JSON.stringify(obj)); // fallback peramban sangat lama
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = new TextEncoder().encode(JSON.stringify(obj));
    return kunciPerangkat().then(function (k) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, data);
    }).then(function (ct) { return 'ENC:' + b64(iv) + '.' + b64(ct); });
  }
  function dekripsi(str) {
    if (!str) return Promise.resolve(null);
    if (str.indexOf('PLAIN:') === 0) return Promise.resolve(JSON.parse(str.slice(6)));
    if (str.indexOf('ENC:') !== 0) { try { return Promise.resolve(JSON.parse(str)); } catch (e) { return Promise.resolve(null); } }
    var bagian = str.slice(4).split('.');
    var iv = unb64(bagian[0]), ct = unb64(bagian[1]);
    return kunciPerangkat().then(function (k) {
      return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, k, ct);
    }).then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); })
      .catch(function () { return null; });
  }
  function simpanTerenkripsi(kunci, obj) { return enkripsi(obj).then(function (s) { localStorage.setItem(kunci, s); return true; }); }
  function bacaTerenkripsi(kunci) { return dekripsi(localStorage.getItem(kunci)); }

  // ---------- PWA: manifest + service worker ----------
  function pasangPWA() {
    var akar = hitungAkar();
    if (!document.querySelector('link[rel="manifest"]')) {
      var l = document.createElement('link'); l.rel = 'manifest'; l.href = akar + 'manifest.webmanifest';
      document.head.appendChild(l);
    }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      var a = document.createElement('link'); a.rel = 'apple-touch-icon'; a.href = akar + 'assets/icons/icon-192.png';
      document.head.appendChild(a);
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register(akar + 'service-worker.js', { scope: akar }).catch(function () {});
      });
    }
  }
  pasangPWA();

  window.PANDAI = {
    api: api, kirimAntre: kirimAntre, prosesAntre: prosesAntre, antrean: bacaAntre,
    sesi: sesi, simpanSesi: simpanSesi, keluar: keluar, adaBackend: adaBackend, akar: hitungAkar,
    simpanTerenkripsi: simpanTerenkripsi, bacaTerenkripsi: bacaTerenkripsi
  };
})();
