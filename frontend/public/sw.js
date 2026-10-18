// A deliberately small service worker. It makes Inkling installable, shows a friendly page when the network is gone, and
// catches what another app shares to Inkling from the phone's Share menu.
//
// It never stores summaries, documents or API answers: everything else goes straight to the network, so nothing stale or
// private can be served from a cache. The one exception is a share, which has to be kept for the moment between the Share
// menu and the page that opens: it is held in its own cache, read and removed by that page, and in any case thrown away
// after an hour.
const OFFLINE_CACHE = "inkling-offline-v1";
const SHARE_CACHE = "inkling-share";
const OFFLINE_URL = "/offline.html";
const SHARE_PATH = "/share-target";
const SHARE_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_SHARED_FILES = 5;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop the offline pages of older versions of this worker (and nothing else: a share waiting for its page stays).
      for (const name of await caches.keys()) {
        if (name !== OFFLINE_CACHE && name !== SHARE_CACHE) await caches.delete(name);
      }
      await dropOldShares();
      await self.clients.claim();
    })()
  );
});

// A share that was never opened is removed once it is old.
async function dropOldShares() {
  const cache = await caches.open(SHARE_CACHE);
  const meta = await cache.match("/share-data/meta");
  if (!meta) return;
  try {
    const { at } = await meta.json();
    if (typeof at === "number" && Date.now() - at < SHARE_MAX_AGE_MS) return;
  } catch {
    // unreadable: remove it
  }
  await caches.delete(SHARE_CACHE);
}

// Keeps what was shared (a title, text, an address, up to a few files) and sends the browser on to the page that shows it.
async function keepShare(request) {
  try {
    const form = await request.formData();
    await caches.delete(SHARE_CACHE); // a new share replaces the last one
    const cache = await caches.open(SHARE_CACHE);
    const files = form.getAll("files").filter((f) => typeof f === "object" && f !== null && "size" in f && f.size > 0).slice(0, MAX_SHARED_FILES);
    const text = (name) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, 200000) : "";
    };
    const meta = {
      at: Date.now(),
      title: text("title"),
      text: text("text"),
      url: text("url"),
      files: files.map((f) => ({ name: f.name || "file", type: f.type || "application/octet-stream", size: f.size })),
    };
    await cache.put("/share-data/meta", new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
    for (const [i, file] of files.entries()) {
      await cache.put(`/share-data/file-${i}`, new Response(file, { headers: { "content-type": file.type || "application/octet-stream" } }));
    }
    return Response.redirect("/share", 303);
  } catch {
    return Response.redirect("/share?missing=1", 303);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method === "POST" && new URL(request.url).pathname === SHARE_PATH) {
    event.respondWith(keepShare(request));
    return;
  }
  // Only whole-page visits are answered offline; scripts, images and API calls just fail, as they would without a worker.
  if (request.mode !== "navigate") return;
  event.respondWith(fetch(request).catch(async () => (await caches.match(OFFLINE_URL)) ?? Response.error()));
});
