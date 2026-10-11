// What the person has chosen, and what is checked about it. Kept in this browser only (chrome.storage.local, which is
// never synced to other devices), so the key does not leave the machine except to go to the Inkling address.

export const DEFAULTS = Object.freeze({
  baseUrl: "",
  apiKey: "",
  language: "English",
  wordCount: 150,
  style: "default",
  save: false,
});

// Keep in step with the API (docs/openapi.yaml).
export const LANGUAGES = [
  ["English", "en"],
  ["Spanish", "es"],
  ["French", "fr"],
  ["German", "de"],
  ["Italian", "it"],
  ["Portuguese", "pt"],
  ["Dutch", "nl"],
  ["Polish", "pl"],
  ["Turkish", "tr"],
  ["Russian", "ru"],
  ["Serbian", "sr"],
  ["Croatian", "hr"],
  ["Bosnian", "bs"],
  ["Chinese", "zh"],
  ["Japanese", "ja"],
];
export const STYLES = ["default", "bullets", "brief", "simple", "takeaways"];
export const LENGTHS = [
  { words: 100, label: "lengthShort" },
  { words: 150, label: "lengthMedium" },
  { words: 300, label: "lengthLong" },
  { words: 500, label: "lengthDetailed" },
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The address of the Inkling server, made tidy: https only (plain http is allowed for the machine itself, which is how
// it is tried out), no login in the address, no query, no trailing slash. Returns { ok, url } or { ok: false }.
export function normalizeBaseUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? "").trim());
  } catch {
    return { ok: false };
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return { ok: false };
  if (url.username || url.password || url.search || url.hash) return { ok: false };
  return { ok: true, url: (url.origin + url.pathname).replace(/\/+$/, "") };
}

// The pattern the browser is asked to allow: the one server, nothing else.
export function permissionPattern(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}

export function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return String(baseUrl);
  }
}

export function looksLikeKey(key) {
  return /^ink_[A-Za-z0-9_-]{16,}$/.test(String(key ?? "").trim());
}

export function isConfigured(settings) {
  return normalizeBaseUrl(settings.baseUrl).ok && looksLikeKey(settings.apiKey);
}

// Whatever is stored, what comes back is something the rest of the code can use.
export function sanitize(stored) {
  const s = { ...DEFAULTS, ...(stored && typeof stored === "object" ? stored : {}) };
  if (!LANGUAGES.some(([name]) => name === s.language)) s.language = DEFAULTS.language;
  if (!STYLES.includes(s.style)) s.style = DEFAULTS.style;
  if (!LENGTHS.some((l) => l.words === s.wordCount)) s.wordCount = DEFAULTS.wordCount;
  s.save = s.save === true;
  s.baseUrl = typeof s.baseUrl === "string" ? s.baseUrl : "";
  s.apiKey = typeof s.apiKey === "string" ? s.apiKey : "";
  return s;
}

export async function loadSettings(area = chrome.storage.local) {
  return sanitize(await area.get(Object.keys(DEFAULTS)));
}

export async function saveSettings(patch, area = chrome.storage.local) {
  const current = await loadSettings(area);
  const next = sanitize({ ...current, ...patch });
  await area.set(next);
  return next;
}
