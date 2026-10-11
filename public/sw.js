// Only static files are cached. Pages, form posts and CSV exports always go to the network,
// so no customer or order data is ever stored on the device.
const CACHE = "om-static-v1";
// "/offline" (not "/offline.html"): Cloudflare redirects .html URLs, and a redirected
// response can't be used to answer a page navigation.
const OFFLINE_URL = "/offline";
const STATIC_FILES = [
  "/style.css",
  "/app.js",
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(STATIC_FILES.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error())
    );
    return;
  }

  if (!STATIC_FILES.includes(url.pathname)) return;

  // Network first so a deploy's new CSS/JS always matches the freshly loaded page; cache only when offline.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(async () => (await cache.match(request, { ignoreSearch: true })) || Response.error())
    )
  );
});
