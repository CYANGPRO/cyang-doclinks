const LOCAL801_CACHE_PREFIX = "local801-";
const CACHE_NAME = `${LOCAL801_CACHE_PREFIX}static-v4`;
const STATIC_ASSETS = [
  "/offline.html",
  "/icons/local801-icon.svg",
  "/icons/local801-maskable.svg",
  "/icons/local801-192.png",
  "/icons/local801-512.png",
  "/icons/local801-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(LOCAL801_CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin || request.method !== "GET") return;

  const isStaticAsset = url.pathname.startsWith("/icons/") || url.pathname === "/offline.html";
  if (isStaticAsset) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/offline.html").then(
          (hit) =>
            hit ||
            new Response("Engaging Local 801 needs a secure internet connection.", {
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }),
        ),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  const title = "Engaging Local 801";
  const options = {
    body: "You have an Engaging Local 801 update.",
    icon: "/icons/local801-192.png",
    badge: "/icons/local801-maskable-512.png",
    data: { url: "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
