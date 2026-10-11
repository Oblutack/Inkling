import assert from "node:assert/strict";
import { test } from "node:test";
import { InklingError, MAX_TEXT_CHARS, errorFromResponse, keyUsage, summarizeText, summarizeUrl } from "../lib/api.js";
import { errorText } from "../lib/i18n.js";

const KEY = "ink_" + "k".repeat(40);
const base = { baseUrl: "https://api.example.com", apiKey: KEY };
const choices = { language: "German", wordCount: 300, style: "bullets", save: false };

// A fetch that remembers what it was asked and answers with what the test says.
function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      json: async () => {
        if (body === undefined) throw new Error("not json");
        return body;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

test("text is sent with the key and the choices, and nothing else", async () => {
  const fetchImpl = fakeFetch(200, { summary: "## Summary\nShort.", filename: "Pasted Text" }, { "X-Quota-Remaining": "41" });
  const result = await summarizeText({ ...base, text: "Some page text.", ...choices, fetchImpl });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.origin + url.pathname, "https://api.example.com/v1/summarize-text");
  assert.equal(url.searchParams.get("language"), "German");
  assert.equal(url.searchParams.get("wordCount"), "300");
  assert.equal(url.searchParams.get("style"), "bullets");
  assert.equal(url.searchParams.has("save"), false);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.credentials, "omit"); // never the website's cookie
  assert.deepEqual(JSON.parse(init.body), { text: "Some page text." });
  assert.deepEqual(result, { summary: "## Summary\nShort.", filename: "Pasted Text", id: null, quotaRemaining: 41 });
});

test("keeping the result in the library is asked for, and the saved id comes back", async () => {
  const fetchImpl = fakeFetch(200, { summary: "x", id: 77 });
  const result = await summarizeText({ ...base, text: "t", ...choices, save: true, fetchImpl });
  assert.equal(fetchImpl.calls[0].url.searchParams.get("save"), "true");
  assert.equal(result.id, 77);
});

test("a page's address can be sent instead of its text", async () => {
  const fetchImpl = fakeFetch(200, { summary: "x" });
  await summarizeUrl({ ...base, url: "https://news.example/post.pdf", ...choices, fetchImpl });
  assert.equal(fetchImpl.calls[0].url.pathname, "/v1/summarize-url");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { url: "https://news.example/post.pdf" });
});

test("more text than the API takes is cut, not refused", async () => {
  const fetchImpl = fakeFetch(200, { summary: "x" });
  await summarizeText({ ...base, text: "a".repeat(MAX_TEXT_CHARS + 500), ...choices, fetchImpl });
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).text.length, MAX_TEXT_CHARS);
});

test("the API's own reasons become codes", () => {
  const cases = [
    [401, { code: "invalid_api_key" }, "invalid_key"],
    [401, { code: "api_key_expired" }, "expired_key"],
    [429, { code: "api_key_limit" }, "key_limit"],
    [429, { code: "quota_exceeded" }, "quota"],
    [503, { code: "daily_budget" }, "paused"],
    [429, {}, "rate_limited"],
    [413, {}, "too_large"],
    [502, {}, "ai_failed"],
    [400, { error: "Word count must be between 50 and 1000." }, "bad_request"],
    [418, null, "unknown"],
    [401, null, "invalid_key"],
  ];
  for (const [status, body, code] of cases) assert.equal(errorFromResponse(status, body).code, code, `${status} ${JSON.stringify(body)}`);
  assert.equal(errorFromResponse(429, {}, "12").retryAfter, 12);
  assert.equal(errorFromResponse(429, {}, "soon").retryAfter, 0);
});

test("a failed call raises an error with its code", async () => {
  await assert.rejects(
    summarizeText({ ...base, text: "t", ...choices, fetchImpl: fakeFetch(429, { code: "api_key_limit", error: "limit" }, { "Retry-After": "300" }) }),
    (error) => error instanceof InklingError && error.code === "key_limit" && error.status === 429 && error.retryAfter === 300,
  );
  await assert.rejects(summarizeText({ ...base, text: "t", ...choices, fetchImpl: fakeFetch(500, undefined) }), (error) => error.code === "unknown");
});

test("a server that cannot be reached is a network error, and an abort stays an abort", async () => {
  const down = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(summarizeText({ ...base, text: "t", ...choices, fetchImpl: down }), (error) => error.code === "network");
  const aborted = async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  };
  await assert.rejects(summarizeText({ ...base, text: "t", ...choices, fetchImpl: aborted }), (error) => error.name === "AbortError");
});

test("an answer without a summary is a failure, not an empty screen", async () => {
  for (const body of [{}, { summary: "" }, { summary: "   " }, { summary: 5 }]) {
    await assert.rejects(summarizeText({ ...base, text: "t", ...choices, fetchImpl: fakeFetch(200, body) }), (error) => error.code === "ai_failed");
  }
});

test("what the key may do is read from the usage route", async () => {
  const fetchImpl = fakeFetch(200, { key: { name: "extension", usedToday: 3, dailyLimit: 50 }, summaries: { used: 3, limit: 50 } });
  assert.deepEqual(await keyUsage({ ...base, fetchImpl }), { name: "extension", usedToday: 3, dailyLimit: 50 });
  assert.equal(fetchImpl.calls[0].init.method, "GET");
  assert.equal(fetchImpl.calls[0].init.body, undefined);
  assert.deepEqual(await keyUsage({ ...base, fetchImpl: fakeFetch(200, {}) }), { name: "", usedToday: 0, dailyLimit: null });
});

test("every code has a sentence (the words themselves come from the language files)", () => {
  // outside a browser there are no language files, so the key itself comes back: what matters is that each code is mapped
  const keys = {
    network: "errNetwork",
    invalid_key: "errInvalidKey",
    expired_key: "errExpiredKey",
    key_limit: "errKeyLimit",
    quota: "errQuota",
    too_large: "errTooLarge",
    paused: "errPaused",
    ai_failed: "errAi",
    unknown: "errUnknown",
  };
  for (const [code, key] of Object.entries(keys)) assert.equal(errorText(new InklingError(code), "host"), key, code);
  assert.equal(errorText(new InklingError("rate_limited", { retryAfter: 9 }), "h"), "errRateLimit");
  assert.equal(errorText(new InklingError("rate_limited"), "h"), "errRateLimitSoon");
  assert.equal(errorText(new InklingError("bad_request", { detail: "why" }), "h"), "errBadRequest");
});
