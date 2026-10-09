// Offline support: the app shell and every song in songs/songs.json are cached
// on install; afterwards files are served from cache and refreshed in the background.
const CACHE = 'vr-sifir-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/main.js',
  './js/audio.js',
  './js/songs-db.js',
  './lib/three.module.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './songs/songs.json',
];

async function cacheSongs(cache) {
  try {
    const res = await fetch('./songs/songs.json', { cache: 'no-cache' });
    const { songs = [] } = await res.json();
    await Promise.all(songs.map(async (s) => {
      const url = './songs/' + s.file;
      if (!(await cache.match(url))) await cache.add(url);
    }));
  } catch (e) {
    console.warn('SW: songs not cached', e);
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await cacheSongs(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
    await cacheSongs(await caches.open(CACHE));
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok && res.status === 200) {
        cache.put(req, res.clone());
        if (req.url.endsWith('/songs/songs.json')) cacheSongs(cache);
      }
      return res;
    });
    if (cached) {
      e.waitUntil(network.catch(() => {}));
      return cached;
    }
    return network;
  })());
});
