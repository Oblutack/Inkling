import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, hostOf, isConfigured, loadSettings, looksLikeKey, normalizeBaseUrl, permissionPattern, saveSettings, sanitize } from "../lib/settings.js";

test("an https address is accepted and tidied", () => {
  assert.deepEqual(normalizeBaseUrl("https://api.example.com/"), { ok: true, url: "https://api.example.com" });
  assert.deepEqual(normalizeBaseUrl("  https://api.example.com:8443/inkling/  "), { ok: true, url: "https://api.example.com:8443/inkling" });
});

test("plain http is for this machine only", () => {
  assert.equal(normalizeBaseUrl("http://localhost:8080").ok, true);
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8080").ok, true);
  assert.equal(normalizeBaseUrl("http://example.com").ok, false);
  assert.equal(normalizeBaseUrl("http://localhost.evil.example").ok, false);
  assert.equal(normalizeBaseUrl("http://192.168.1.10:8080").ok, false);
});

test("anything that is not a plain server address is refused", () => {
  for (const bad of ["", "api.example.com", "ftp://api.example.com", "javascript:alert(1)", "https://user:pass@api.example.com", "https://api.example.com/?x=1", "https://api.example.com/#top", null, undefined, 42]) {
    assert.equal(normalizeBaseUrl(bad).ok, false, String(bad));
  }
});

test("the browser is asked for one server and nothing else", () => {
  assert.equal(permissionPattern("https://api.example.com:8443/inkling"), "https://api.example.com/*");
  assert.equal(permissionPattern("http://localhost:8080"), "http://localhost/*");
  assert.equal(hostOf("https://api.example.com:8443/x"), "api.example.com:8443");
});

test("a key looks like an Inkling key", () => {
  assert.equal(looksLikeKey("ink_" + "a".repeat(40)), true);
  assert.equal(looksLikeKey("  ink_" + "A1-_".repeat(10) + " "), true);
  for (const bad of ["", "ink_", "ink_short", "sk-" + "a".repeat(40), "INK_" + "a".repeat(40), "ink_ with spaces " + "a".repeat(30), null]) {
    assert.equal(looksLikeKey(bad), false, String(bad));
  }
});

test("it is configured only with a good address and a good key", () => {
  const key = "ink_" + "a".repeat(40);
  assert.equal(isConfigured({ baseUrl: "https://api.example.com", apiKey: key }), true);
  assert.equal(isConfigured({ baseUrl: "", apiKey: key }), false);
  assert.equal(isConfigured({ baseUrl: "https://api.example.com", apiKey: "nope" }), false);
  assert.equal(isConfigured(DEFAULTS), false);
});

test("whatever is stored, the settings that come out can be used", () => {
  assert.deepEqual(sanitize(undefined), DEFAULTS);
  assert.deepEqual(sanitize("junk"), DEFAULTS);
  const s = sanitize({ language: "Klingon", style: "rude", wordCount: 7, save: "yes", baseUrl: 5, apiKey: {} });
  assert.deepEqual(s, DEFAULTS);
  assert.equal(sanitize({ language: "German", style: "bullets", wordCount: 300, save: true }).language, "German");
  assert.equal(sanitize({ wordCount: 300 }).wordCount, 300);
});

function memoryArea() {
  const data = {};
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
  };
}

test("settings are saved a piece at a time and loaded whole", async () => {
  const area = memoryArea();
  assert.deepEqual(await loadSettings(area), DEFAULTS);
  await saveSettings({ style: "brief" }, area);
  await saveSettings({ save: true, language: "French" }, area);
  const loaded = await loadSettings(area);
  assert.equal(loaded.style, "brief");
  assert.equal(loaded.save, true);
  assert.equal(loaded.language, "French");
  assert.equal(loaded.wordCount, 150);
  await saveSettings({ style: "not a style" }, area);
  assert.equal((await loadSettings(area)).style, "default"); // a bad value is not kept
});
