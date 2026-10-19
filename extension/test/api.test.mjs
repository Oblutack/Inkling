import assert from "node:assert/strict";
import { test } from "node:test";
import { InklingError, MAX_EXPLAIN_CHARS, MAX_TEXT_CHARS, errorFromResponse, explainText, keyUsage, saveForLater, summarizeText, summarizeUrl } from "../lib/api.js";
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
    [409, { error: "Your reading list is full." }, "list_full"],
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

test("a page is saved for later by its address, and nothing is streamed", async () => {
  const fetchImpl = fakeFetch(201, { id: 12, title: "A post", summary: "x", alreadySaved: false }, { "X-Quota-Remaining": "40" });
  const result = await saveForLater({ ...base, url: "https://blog.example/post", language: "German", fetchImpl });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.pathname, "/v1/reading-list");
  assert.equal(url.searchParams.get("language"), "German");
  assert.equal(url.searchParams.has("stream"), false);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.credentials, "omit");
  assert.deepEqual(JSON.parse(init.body), { url: "https://blog.example/post" });
  assert.deepEqual(result, { id: 12, title: "A post", alreadySaved: false, quotaRemaining: 40 });
});

test("a text is saved for later when the page has no address to read, and long text is cut", async () => {
  const fetchImpl = fakeFetch(201, { id: 3, title: "T" });
  await saveForLater({ ...base, text: "a".repeat(MAX_TEXT_CHARS + 10), fetchImpl });
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).text.length, MAX_TEXT_CHARS);
});

test("a page that was saved already is reported as such", async () => {
  const result = await saveForLater({ ...base, url: "https://blog.example/post", fetchImpl: fakeFetch(200, { id: 12, title: "A post", alreadySaved: true }) });
  assert.equal(result.alreadySaved, true);
  assert.equal(result.quotaRemaining, null);
});

test("saving fails with the code of the reason", async () => {
  await assert.rejects(saveForLater({ ...base, url: "https://x.example", fetchImpl: fakeFetch(409, { error: "full" }) }), (error) => error.code === "list_full");
  await assert.rejects(saveForLater({ ...base, url: "https://x.example", fetchImpl: fakeFetch(422, { error: "unreadable" }) }), (error) => error.code === "bad_request");
  await assert.rejects(saveForLater({ ...base, url: "https://x.example", fetchImpl: fakeFetch(201, {}) }), (error) => error.code === "ai_failed");
});

test("selected words are explained, plainly or more simply, and nothing is streamed or saved", async () => {
  const fetchImpl = fakeFetch(200, { explanation: "It means money held by a third party." }, { "X-Quota-Remaining": "9" });
  const result = await explainText({ ...base, text: "The deposit sits in escrow.", language: "German", fetchImpl });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.pathname, "/v1/explain");
  assert.equal(url.searchParams.has("stream"), false);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.credentials, "omit");
  assert.deepEqual(JSON.parse(init.body), { text: "The deposit sits in escrow.", simpler: false, language: "German" });
  assert.deepEqual(result, { explanation: "It means money held by a third party.", clipped: false, quotaRemaining: 9 });

  const again = fakeFetch(200, { explanation: "Simple." });
  await explainText({ ...base, text: "Escrow.", simpler: true, fetchImpl: again });
  assert.deepEqual(JSON.parse(again.calls[0].init.body), { text: "Escrow.", simpler: true });
});

test("a selection that is too long is cut, and the person is told", async () => {
  const fetchImpl = fakeFetch(200, { explanation: "x" });
  const result = await explainText({ ...base, text: "a".repeat(MAX_EXPLAIN_CHARS + 50), fetchImpl });
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).text.length, MAX_EXPLAIN_CHARS);
  assert.equal(result.clipped, true);
});

test("an explanation that is empty, and a refusal, are failures with a code", async () => {
  await assert.rejects(explainText({ ...base, text: "t", fetchImpl: fakeFetch(200, { explanation: "  " }) }), (error) => error.code === "ai_failed");
  await assert.rejects(explainText({ ...base, text: "t", fetchImpl: fakeFetch(429, { code: "quota_exceeded" }) }), (error) => error.code === "quota");
});
