'use strict';

/* ============================================================
 * sw.js — service worker PWA.
 *
 * - Précache la coquille du jeu (HTML, CSS, JS, sprites clés).
 * - Statique : stale-while-revalidate (rapide, se met à jour en
 *   arrière-plan) ; navigation : réseau d'abord, cache en secours.
 * - /socket.io/ n'est JAMAIS caché : hors-ligne, le script ne se
 *   charge pas et le client bascule automatiquement en mode solo
 *   (ServerSim + sauvegarde locale).
 *
 * Incrémenter VERSION pour forcer un rafraîchissement complet.
 * ============================================================ */

const VERSION = 'wildrift-v72-siege-window';

const CORE = [
  '/',
  '/css/style.css',
  '/js/config.js',
  '/js/world.js',
  '/js/server.js',
  '/js/net.js',
  '/js/render.js',
  '/js/ui.js',
  '/js/main.js',
  '/assets/personnages_small.png',
  '/assets/bosses/wyrm_ancestral.png',
  '/assets/accessories/wyrm_wings.png',
  '/assets/mounts/rejeton_wyrm_ancestral.png',
  '/assets/mounts/cheval.png',
  '/assets/mounts/loup.png',
  '/assets/mounts/tigre.png',
  '/assets/mounts/panthere.png',
  '/assets/mounts/sac_voyage.png',
  '/manifest.webmanifest',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-512.png',
  '/assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* ---------- Notifications push (Endurance pleine, siège résolu, ami, MP) ---------- */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'FERALIA Online';
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    tag: 'feralia-' + title,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const c of clientsList) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Temps réel + santé : toujours le réseau, jamais de cache
  if (url.pathname.startsWith('/socket.io/') || url.pathname === '/health') return;

  // Navigation : réseau d'abord (mises à jour), coquille en secours
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Statique : stale-while-revalidate
  e.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
