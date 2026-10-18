// Kuenta — Service worker: guarda solo la "cáscara" de la app para abrir rápido.
// Nunca guarda datos financieros ni respuestas de Supabase.
const CACHE = 'kuenta-v8';
const SHELL = ['./', 'index.html', 'app.js', 'config.js', 'manifest.json', 'icons/logo-mark.png', 'terminos.html', 'privacidad.html', 'legal.css', 'legal.js', 'icons/favicon-48.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/somar-labs.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // Supabase y CDNs van directo a la red
  if (url.search) return; // nunca guardar visitas con parámetros (p. ej. ?invite=)
  // Red primero (siempre la versión más nueva); si no hay internet, usa la copia guardada.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
