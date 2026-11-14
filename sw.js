/* Service worker : met l'appli en cache pour qu'elle s'ouvre sans réseau.
 * Pour publier une nouvelle version, changer VERSION (et VERSION_APP dans app.js). */
const VERSION = 'budget-1.7.0';
const FICHIERS = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // l'API passe directement
  // Réseau d'abord (pour recevoir les mises à jour), cache si hors connexion.
  e.respondWith(
    fetch(req).then(rep => {
      const copie = rep.clone();
      caches.open(VERSION).then(c => c.put(req, copie));
      return rep;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
