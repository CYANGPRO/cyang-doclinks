const LOCAL801_CACHE_PREFIX = "local801-";
const CACHE_NAME = `${LOCAL801_CACHE_PREFIX}static-v3`;
const STATIC_ASSETS = [
  "/offline.html",
  "/icons/local801-icon.svg",
  "/icons/local801-maskable.svg",
  "/icons/apple-touch-icon.svg",
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
            new Response("A secure internet connection is required for Local 801 Engage.", {
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }),
        ),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  const title = "Local 801 Engage";
  const options = {
    body: "You have a Local 801 Engage update.",
    icon: "/icons/local801-icon.svg",
    badge: "/icons/local801-maskable.svg",
    data: { url: "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data?.url || "/"));
});
