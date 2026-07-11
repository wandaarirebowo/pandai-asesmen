/**
 * PANDAI — pustaka OMR (Optical Mark Recognition) mode offline.
 * Semua di sisi klien, tanpa pustaka eksternal, agar berjalan offline di HP low-end.
 *
 * Alur: cetak naskah + LJK (window.print) → siswa mengisi bulatan →
 *       guru memindai LJK via kamera → deteksi 4 titik kalibrasi → transformasi
 *       perspektif → baca bulatan & strip identitas → verifikasi → kirim (skoring di server).
 *
 * Ruang kanonik LJK: X ∈ [0,1000], Y ∈ [0,1414] (rasio A4 potret).
 */
(function () {
  'use strict';

  // ---------- RNG deterministik (xmur3 + mulberry32) ----------
  function rng(seedStr) {
    var h = 1779033703 ^ seedStr.length;
    for (var i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    var a = (h >>> 0) || 42;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function acakArr(arr, r) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /** Urutan soal deterministik per varian; soal grup (se-stimulus) tetap utuh. */
  function urutanVarian(soalArr, paketId, varian) {
    var unit = [], peta = {};
    soalArr.forEach(function (s) {
      var k = s.stimulusId || ('_t_' + s.soalId);
      if (!peta[k]) { peta[k] = []; unit.push(peta[k]); }
      peta[k].push(s);
    });
    var urut = acakArr(unit, rng(paketId + '|' + varian));
    var out = [];
    urut.forEach(function (u) { u.forEach(function (s) { out.push(s); }); });
    return out;
  }

  // ---------- tata letak kanonik ----------
  var FID = [{ x: 55, y: 55 }, { x: 945, y: 55 }, { x: 945, y: 1359 }, { x: 55, y: 1359 }]; // TL,TR,BR,BL
  var FID_SIZE = 44;            // sisi kotak fiducial (kanonik)
  var IDENT_Y = 130, IDENT_N = 12, IDENT_X0 = 250, IDENT_X1 = 750, IDENT_SIZE = 30;
  var WHITE_REF = { x: 500, y: 178 };

  function identCells() {
    var cells = [], step = (IDENT_X1 - IDENT_X0) / (IDENT_N - 1);
    for (var i = 0; i < IDENT_N; i++) cells.push({ x: IDENT_X0 + i * step, y: IDENT_Y });
    return cells;
  }
  /** Kodekan indeks siswa + varian menjadi pola 12 sel (2 anchor + 10 bit). */
  function identBits(siswaIndex, varianB) {
    var bits = [1]; // anchor awal selalu hitam
    var v = (varianB ? 1 : 0) | ((siswaIndex & 0x1FF) << 1); // bit0=varian, bit1..9=index (0..511)
    for (var i = 0; i < 10; i++) bits.push((v >> i) & 1);
    bits.push(1); // anchor akhir
    return bits; // panjang 12
  }
  function decodeIdentBits(bits) {
    // bits: array 0/1 panjang 12; abaikan anchor [0] dan [11]
    var v = 0;
    for (var i = 0; i < 10; i++) v |= (bits[1 + i] ? 1 : 0) << i;
    return { varianB: (v & 1) === 1, siswaIndex: v >> 1 };
  }

  /** Hitung tata letak lengkap (untuk render DAN sampling). */
  function tataLetak(orderedSoal) {
    var band0 = 235, band1 = 1300;
    var lineUnits = orderedSoal.map(function (s) {
      if (s.bentuk === 'PGK_KATEGORI' && s.opsi && s.opsi.pernyataan) return s.opsi.pernyataan.length;
      return 1;
    });
    var totalLines = lineUnits.reduce(function (a, b) { return a + b; }, 0) || 1;
    var lineH = Math.min(42, (band1 - band0) / totalLines);
    var r = Math.min(15, lineH * 0.32);
    var bx0 = 175, bxs = 92;

    var bubbles = [], rows = [], y = band0;
    orderedSoal.forEach(function (s, qi) {
      var nomor = qi + 1;
      if (s.bentuk === 'PG' || s.bentuk === 'PGK_MCMA') {
        var cy = y + lineH / 2, n = (s.opsi || []).length;
        var refs = [];
        for (var i = 0; i < n; i++) {
          var b = { x: bx0 + i * bxs, y: cy, r: r, soalId: s.soalId, bentuk: s.bentuk, opsiIdx: i, huruf: 'ABCDE'[i] };
          bubbles.push(b); refs.push(b);
        }
        rows.push({ soalId: s.soalId, bentuk: s.bentuk, nomor: nomor, y: cy, bubbles: refs });
        y += lineH;
      } else if (s.bentuk === 'PGK_KATEGORI' && s.opsi) {
        var kat = s.opsi.kategori, per = s.opsi.pernyataan;
        var subRows = [];
        per.forEach(function (pt, pi) {
          var cyy = y + lineH / 2;
          var bB = { x: bx0, y: cyy, r: r, soalId: s.soalId, bentuk: s.bentuk, pernyataanIdx: pi, kategori: 'B', huruf: kat[0][0] };
          var bS = { x: bx0 + bxs, y: cyy, r: r, soalId: s.soalId, bentuk: s.bentuk, pernyataanIdx: pi, kategori: 'S', huruf: kat[1][0] };
          bubbles.push(bB); bubbles.push(bS);
          subRows.push({ pernyataanIdx: pi, y: cyy, bB: bB, bS: bS });
          y += lineH;
        });
        rows.push({ soalId: s.soalId, bentuk: s.bentuk, nomor: nomor, kategori: kat, subRows: subRows });
      } else { // ISIAN: tidak didukung OMR
        rows.push({ soalId: s.soalId, bentuk: 'ISIAN', nomor: nomor, y: y + lineH / 2, isian: true });
        y += lineH;
      }
    });
    return { fid: FID, fidSize: FID_SIZE, ident: { cells: identCells(), size: IDENT_SIZE },
      whiteRef: WHITE_REF, bubbles: bubbles, rows: rows, r: r, lineH: lineH };
  }

  // ---------- homografi 4 titik (kanonik → citra) ----------
  function solve(A, b) {
    var n = b.length;
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var rr = col + 1; rr < n; rr++) if (Math.abs(A[rr][col]) > Math.abs(A[piv][col])) piv = rr;
      var tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
      var tb = b[col]; b[col] = b[piv]; b[piv] = tb;
      if (Math.abs(A[col][col]) < 1e-9) return null;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === col) continue;
        var f = A[r2][col] / A[col][col];
        for (var c = col; c < n; c++) A[r2][c] -= f * A[col][c];
        b[r2] -= f * b[col];
      }
    }
    var x = [];
    for (var i = 0; i < n; i++) x.push(b[i] / A[i][i]);
    return x;
  }
  /** src: 4 titik kanonik {x,y}; dst: 4 titik citra {x,y} (urutan sama). */
  function homografi(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var X = src[i].x, Y = src[i].y, x = dst[i].x, yy = dst[i].y;
      A.push([X, Y, 1, 0, 0, 0, -X * x, -Y * x]); b.push(x);
      A.push([0, 0, 0, X, Y, 1, -X * yy, -Y * yy]); b.push(yy);
    }
    var h = solve(A, b);
    if (!h) return null;
    return function (X, Y) {
      var d = h[6] * X + h[7] * Y + 1;
      return { x: (h[0] * X + h[1] * Y + h[2]) / d, y: (h[3] * X + h[4] * Y + h[5]) / d };
    };
  }

  // ---------- citra ----------
  function keAbuAbu(imgData) {
    var d = imgData.data, n = imgData.width * imgData.height, g = new Uint8ClampedArray(n);
    for (var i = 0; i < n; i++) g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
    return g;
  }
  /** Deteksi 4 fiducial di sudut. Return [TL,TR,BR,BL] atau null. */
  function deteksiFiducial(gray, w, h) {
    var reg = [
      { x0: 0, y0: 0, x1: 0.34 * w, y1: 0.34 * h },
      { x0: 0.66 * w, y0: 0, x1: w, y1: 0.34 * h },
      { x0: 0.66 * w, y0: 0.66 * h, x1: w, y1: h },
      { x0: 0, y0: 0.66 * h, x1: 0.34 * w, y1: h }
    ];
    var hasil = [];
    for (var q = 0; q < 4; q++) {
      var p = pusatGelap(gray, w, h, reg[q]);
      if (!p) return null;
      hasil.push(p);
    }
    return hasil;
  }
  function pusatGelap(gray, w, h, reg) {
    var x0 = reg.x0 | 0, y0 = reg.y0 | 0, x1 = reg.x1 | 0, y1 = reg.y1 | 0;
    var jum = 0, n = 0, mn = 255;
    for (var y = y0; y < y1; y += 2) for (var x = x0; x < x1; x += 2) {
      var v = gray[y * w + x]; jum += v; n++; if (v < mn) mn = v;
    }
    if (!n) return null;
    var mean = jum / n;
    var T = mean * 0.55; if (T < mn + 20) T = mn + 20;
    // grid kasar → sel terpadat gelap
    var GX = 16, GY = 16, cw = (x1 - x0) / GX, ch = (y1 - y0) / GY;
    var cnt = [];
    for (var gy = 0; gy < GY; gy++) { cnt.push([]); for (var gx = 0; gx < GX; gx++) cnt[gy].push(0); }
    for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) {
      if (gray[yy * w + xx] < T) {
        var cx = Math.min(GX - 1, ((xx - x0) / cw) | 0), cyy = Math.min(GY - 1, ((yy - y0) / ch) | 0);
        cnt[cyy][cx]++;
      }
    }
    var best = -1, bgx = 0, bgy = 0;
    for (var a = 0; a < GY; a++) for (var bb = 0; bb < GX; bb++) if (cnt[a][bb] > best) { best = cnt[a][bb]; bgx = bb; bgy = a; }
    if (best < (cw * ch) * 0.25) return null; // sel terpadat pun tidak cukup gelap → gagal
    // centroid piksel gelap di sekitar sel terpadat (±2 sel)
    var rx0 = x0 + Math.max(0, bgx - 2) * cw, rx1 = x0 + Math.min(GX, bgx + 3) * cw;
    var ry0 = y0 + Math.max(0, bgy - 2) * ch, ry1 = y0 + Math.min(GY, bgy + 3) * ch;
    var sx = 0, sy = 0, sn = 0;
    for (var y2 = ry0 | 0; y2 < ry1; y2++) for (var x2 = rx0 | 0; x2 < rx1; x2++) {
      if (gray[y2 * w + x2] < T) { sx += x2; sy += y2; sn++; }
    }
    if (!sn) return null;
    return { x: sx / sn, y: sy / sn };
  }
  /** Rata-rata kegelapan (0..255) pada cakram di sekitar (X,Y) kanonik. */
  function kegelapan(gray, w, h, map, X, Y, radCanon, skala) {
    var c = map(X, Y);
    var rad = Math.max(2, radCanon * skala * 0.8);
    var sum = 0, n = 0;
    for (var dy = -rad; dy <= rad; dy += 1) for (var dx = -rad; dx <= rad; dx += 1) {
      if (dx * dx + dy * dy > rad * rad) continue;
      var px = (c.x + dx) | 0, py = (c.y + dy) | 0;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      sum += 255 - gray[py * w + px]; n++;
    }
    return n ? sum / n : 0;
  }

  /**
   * Baca satu LJK. Return { fid, ident:{siswaIndex,varianB,bits}, jawabanPosisi, kegelapanBubble }.
   * layout = tataLetak(orderedSoal untuk varian yang terbaca).
   * Jika varian belum diketahui, panggil dua tahap: bacaIdentitas dulu, lalu bacaJawaban.
   */
  function skalaDari(fid) {
    var dTop = Math.hypot(fid[1].x - fid[0].x, fid[1].y - fid[0].y);
    return dTop / (FID[1].x - FID[0].x); // citra px per satuan kanonik
  }
  function bacaIdentitas(gray, w, h, fid) {
    var map = homografi(FID, fid); if (!map) return null;
    var sk = skalaDari(fid);
    var cells = identCells();
    var white = kegelapan(gray, w, h, map, WHITE_REF.x, WHITE_REF.y, 14, sk);
    var raw = cells.map(function (c) { return kegelapan(gray, w, h, map, c.x, c.y, IDENT_SIZE / 2, sk); });
    var anchor = (raw[0] + raw[raw.length - 1]) / 2;
    var T = (white + anchor) / 2;
    var bits = raw.map(function (v) { return v > T ? 1 : 0; });
    var dec = decodeIdentBits(bits);
    dec.bits = bits; dec.map = map; dec.skala = sk; dec.white = white; dec.anchor = anchor;
    return dec;
  }
  function bacaJawaban(gray, w, h, fid, orderedSoal) {
    var map = homografi(FID, fid); if (!map) return null;
    var sk = skalaDari(fid);
    var lay = tataLetak(orderedSoal);
    var jawaban = {}, debug = [];
    lay.rows.forEach(function (row) {
      if (row.isian) { jawaban[row.soalId] = undefined; return; }
      if (row.bentuk === 'PG') {
        var vals = row.bubbles.map(function (b) { return kegelapan(gray, w, h, map, b.x, b.y, b.r, sk); });
        var mx = Math.max.apply(null, vals), idx = vals.indexOf(mx);
        var kedua = vals.slice().sort(function (a, b) { return b - a; })[1] || 0;
        jawaban[row.soalId] = (mx > 90 && mx > kedua * 1.35) ? idx : undefined;
        debug.push({ soalId: row.soalId, vals: vals });
      } else if (row.bentuk === 'PGK_MCMA') {
        var arr = [];
        row.bubbles.forEach(function (b) { if (kegelapan(gray, w, h, map, b.x, b.y, b.r, sk) > 110) arr.push(b.opsiIdx); });
        jawaban[row.soalId] = arr.length ? arr : undefined;
      } else if (row.bentuk === 'PGK_KATEGORI') {
        var res = [];
        row.subRows.forEach(function (sr) {
          var vB = kegelapan(gray, w, h, map, sr.bB.x, sr.bB.y, sr.bB.r, sk);
          var vS = kegelapan(gray, w, h, map, sr.bS.x, sr.bS.y, sr.bS.r, sk);
          res.push((Math.max(vB, vS) > 90) ? (vB >= vS ? 'B' : 'S') : null);
        });
        jawaban[row.soalId] = res;
      }
    });
    return { jawaban: jawaban, debug: debug, layout: lay, map: map, skala: sk };
  }

  window.OMR = {
    urutanVarian: urutanVarian, tataLetak: tataLetak, identBits: identBits,
    keAbuAbu: keAbuAbu, deteksiFiducial: deteksiFiducial, homografi: homografi,
    bacaIdentitas: bacaIdentitas, bacaJawaban: bacaJawaban, FID: FID, skalaDari: skalaDari,
    kegelapan: kegelapan
  };
})();
