// Guarda só a "casca" da app para abrir rápido com rede fraca.
// NUNCA guarda respostas da /api (saldos e movimentos vêm sempre do servidor).
const CACHE = 'dobrapay-v6';
const SHELL = ['/', '/index.html', '/style.css', '/i18n.js', '/app.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Rede primeiro (para receber atualizações), cache se estiver sem internet.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});

// Notificações push: mostra a mensagem mesmo com a app fechada.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'DobraPay', {
    body: data.body || '', icon: '/icon.svg', badge: '/icon.svg', data: { url: data.url || '/' },
  }));
});
// Ao tocar na notificação, abre (ou mostra) a app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => 'focus' in c);
    return open ? open.focus() : self.clients.openWindow(e.notification.data.url || '/');
  }));
});
