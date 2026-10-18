// Reads what the service worker kept when something was shared to Inkling (see public/sw.js). It lives in its own cache for
// the moment between the Share menu and the page that opens, and is removed once used or after an hour.

const SHARE_CACHE = "inkling-share";
const MAX_AGE_MS = 60 * 60 * 1000;

export interface SharedPayload {
  title: string;
  text: string;
  url: string;
  files: File[];
}

interface Meta {
  at: number;
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; size: number }[];
}

export async function readShare(): Promise<SharedPayload | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const response = await cache.match("/share-data/meta");
    if (!response) return null;
    const meta = (await response.json()) as Meta;
    if (typeof meta.at !== "number" || Date.now() - meta.at > MAX_AGE_MS) {
      await caches.delete(SHARE_CACHE);
      return null;
    }
    const files: File[] = [];
    for (let i = 0; i < (meta.files?.length ?? 0); i++) {
      const stored = await cache.match(`/share-data/file-${i}`);
      if (stored) files.push(new File([await stored.blob()], meta.files[i].name, { type: meta.files[i].type }));
    }
    return { title: meta.title ?? "", text: meta.text ?? "", url: meta.url ?? "", files };
  } catch {
    return null;
  }
}

export async function clearShare(): Promise<void> {
  try {
    if (typeof caches !== "undefined") await caches.delete(SHARE_CACHE);
  } catch {
    // nothing to do
  }
}
