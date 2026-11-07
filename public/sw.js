// Caches the app shell so it opens instantly; live AC data always comes from the PC.
const CACHE = "ac-remote-v3";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest",
    "/icons/icon-192.png", "/fonts/inter-latin-400-normal.woff2", "/fonts/inter-latin-500-normal.woff2",
    "/fonts/inter-latin-600-normal.woff2", "/fonts/inter-latin-700-normal.woff2"];

self.addEventListener("install", e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
    const url = new URL(e.request.url);
    if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
    // Network first, so updates show up straight away; cache when the PC can't be reached.
    e.respondWith(
        fetch(e.request).then(res => {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
            return res;
        }).catch(() => caches.match(e.request)),
    );
});
