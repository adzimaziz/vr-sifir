# VR Sifir 🥽✖️

Permainan sifir VR gaya **Beat Saber** untuk **Pico 4** (WebXR, main terus dalam Pico Browser).
Soalan seperti **5 × 4 = ?** datang bersama 3 kiub jawapan mengikut rentak lagu — hayun pedang dan pukul jawapan yang betul!

**Main:** https://adzimaziz.github.io/vr-sifir/

## Ciri-ciri
- Pilih sifir 1–12 (boleh pilih beberapa sekaligus) sebelum mula.
- Pilih lagu: lagu dalam folder `songs/`, muzik terbina, atau **tambah lagu terus dari Pico** (disimpan dalam peranti).
- Rentak (BPM) dikesan automatik; boleh laras sendiri (÷2, ×2, atau taip BPM).
- 3 tahap: Mudah, Sederhana, Sukar.
- Kombo & pengganda markah (x2, x4, x8), getaran controller, rekod markah tertinggi.
- Jawapan salah/terlepas → jawapan betul ditunjuk (hijau) dan disenaraikan di "Ulang kaji".
- Boleh main **offline** selepas dibuka sekali (PWA + service worker).

## Kawalan Pico 4
| Butang | Fungsi |
|---|---|
| Hayun pedang (kiri merah, kanan biru) | Pukul kiub jawapan / butang dalam VR |
| Trigger / A / X | Tekan butang utama panel (MULA, SAMBUNG, MAIN LAGI) |
| B / Y | Jeda / sambung |
| Butang Pico (tekan lama) | Tengahkan semula pandangan |

Mod skrin (komputer, untuk cuba): gerakkan tetikus untuk hayun, `ESC` jeda, `Enter` butang utama.

## Main di Pico 4
1. Buka **Pico Browser** → `https://adzimaziz.github.io/vr-sifir/`
2. Pilih sifir, lagu dan tahap → tekan **🥽 Main dalam VR**.
3. Untuk offline: buka sekali semasa ada internet (semua fail & lagu disimpan automatik).
   Jika Pico Browser tunjuk pilihan *Install / Add to library*, pasang untuk ikon aplikasi.

## Tambah lagu
**Cara 1 – dalam repo (untuk semua pemain):** letak fail `.mp3` dalam `songs/` dan tambah ke `songs/songs.json`:
```json
{
  "songs": [
    { "title": "Cream Soda (Cute BGM)", "file": "cream-soda.mp3" },
    { "title": "Lagu Baru", "file": "lagu-baru.mp3", "bpm": 120 }
  ]
}
```
`bpm` dan `offset` (saat ke rentak pertama) adalah pilihan — jika tiada, dikesan automatik.
Selepas tambah lagu, naikkan `CACHE` dalam `sw.js` (contoh `vr-sifir-v2`) supaya peranti muat turun versi baru.

**Cara 2 – terus dari Pico:** dalam menu, tekan **＋ Tambah lagu dari peranti** dan pilih fail audio.

## Struktur
```
index.html        menu 2D
js/main.js        permainan (Three.js + WebXR)
js/audio.js       muzik, pengesan rentak, muzik terbina, bunyi kesan
js/songs-db.js    simpanan lagu peranti (IndexedDB)
lib/              three.js r170 (disimpan lokal untuk offline)
songs/            lagu + songs.json
sw.js             cache offline
```

Uji di komputer: `python -m http.server 8765` → http://localhost:8765 (service worker dimatikan di localhost; tambah `?sw` untuk uji offline).
