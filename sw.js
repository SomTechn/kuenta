// Kuenta — Service worker: guarda solo la "cáscara" de la app para abrir rápido.
// Nunca guarda datos financieros ni respuestas de Supabase.
const CACHE = 'kuenta-v13';
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

// Notificaciones push (recordatorios, pagos programados y cuotas). Solo texto: nunca saldos.
const SCREENS = ['add', 'scheduled', 'debt', 'debts', 'savings', 'alerts', 'budgets', 'goals'];
self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = {title: 'Kuenta', body: e.data ? e.data.text() : ''}; }
  const d = p.data || {};
  const screen = SCREENS.includes(d.screen) ? d.screen : 'alerts';
  const id = /^[0-9a-f-]{36}$/i.test(d.id || '') ? d.id : '';
  e.waitUntil(self.registration.showNotification(String(p.title || 'Kuenta').slice(0, 120), {
    body: String(p.body || '').slice(0, 240), tag: String(p.tag || 'kuenta').slice(0, 80),
    icon: 'icons/icon-192.png', badge: 'icons/favicon-48.png', lang: 'es',
    data: {url: `./?go=${screen}${id ? '&id=' + id : ''}`},
    actions: screen === 'add' ? [{action: 'add', title: 'Registrar ahora'}] : []
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.action === 'add' ? './?go=add' : (e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    const w = list.find(c => c.url.startsWith(self.registration.scope));
    if (w){ w.postMessage({type: 'kuenta-go', url}); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
