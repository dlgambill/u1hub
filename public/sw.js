// U1 Print Hub service worker — v2.5.0
// Deliberately does NOT cache anything: the Hub is a live dashboard and the
// red version-mismatch banner is the source of truth for staleness. This
// worker exists only to satisfy PWA install criteria on the phone.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
