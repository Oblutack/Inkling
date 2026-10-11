import assert from "node:assert/strict";
import { test } from "node:test";
import { InklingError, summarizeText, summarizeUrl } from "../lib/api.js";
import { parseSseBlock, readEvents } from "../lib/stream.js";

const KEY = "ink_" + "s".repeat(40);
const base = { baseUrl: "https://api.example.com", apiKey: KEY, language: "English", wordCount: 150, style: "default", save: false };

const event = (data) => `data: ${JSON.stringify(data)}\n\n`;

// A response that arrives in the pieces given (as a network sends it, not at the boundaries of events).
function streamed(pieces, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });
  return { ok: status < 300, status, headers: new Headers({ "Content-Type": "text/event-stream", ...headers }), body };
}

function fetching(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return typeof response === "function" ? response(init) : response;
  };
  impl.calls = calls;
  return impl;
}

test("an event is read from its block, and what is not an event is not", () => {
  assert.deepEqual(parseSseBlock('data: {"type":"delta","text":"Hi"}'), { type: "delta", text: "Hi" });
  for (const junk of ["", ": keep-alive", "data: not json", 'data: {"no":"type"}', "data: 5", "event: x"]) assert.equal(parseSseBlock(junk), null, junk);
});

test("events are found however the network cut the stream up", async () => {
  const whole = event({ type: "status", stage: "preparing" }) + event({ type: "delta", text: "Heat " }) + event({ type: "delta", text: "pumps" }) + event({ type: "done" });
  for (const size of [1, 3, 7, 50, whole.length]) {
    const pieces = whole.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"));
    const seen = [];
    await readEvents(streamed(pieces), (e) => seen.push(e.type + (e.text ?? "")));
    assert.deepEqual(seen, ["status", "deltaHeat ", "deltapumps", "done"], `pieces of ${size}`);
  }
  // Windows line endings, and a last event with no blank line after it
  const seen = [];
  await readEvents(streamed(['data: {"type":"delta","text":"a"}\r\n\r\ndata: {"type":"done"}']), (e) => seen.push(e.type));
  assert.deepEqual(seen, ["delta", "done"]);
});

test("the summary grows as it is written, and the saved id and quota come with the end", async () => {
  const fetchImpl = fetching(
    streamed(
      [event({ type: "status", stage: "writing" }), event({ type: "delta", text: "## Summary\n" }), event({ type: "delta", text: "- Heat pumps" }), event({ type: "done", id: 91, filename: "Pasted Text" })],
      { headers: { "X-Quota-Remaining": "7" } },
    ),
  );
  const growth = [];
  const result = await summarizeText({ ...base, text: "t", save: true, fetchImpl, onText: (so_far) => growth.push(so_far) });
  assert.deepEqual(growth, ["## Summary\n", "## Summary\n- Heat pumps"]);
  assert.deepEqual(result, { summary: "## Summary\n- Heat pumps", filename: "Pasted Text", id: 91, quotaRemaining: 7 });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.searchParams.get("stream"), "true");
  assert.equal(url.searchParams.get("save"), "true");
  assert.equal(init.credentials, "omit");
});

test("a page address can be summarized as a stream too", async () => {
  const fetchImpl = fetching(streamed([event({ type: "delta", text: "ok" }), event({ type: "done" })]));
  assert.equal((await summarizeUrl({ ...base, url: "https://x.example/p.pdf", fetchImpl })).summary, "ok");
  assert.equal(fetchImpl.calls[0].url.pathname, "/v1/summarize-url");
});

test("a server that answers with the whole summary at once works as before", async () => {
  const plain = { ok: true, status: 200, headers: new Headers({ "Content-Type": "application/json", "X-Quota-Remaining": "3" }), json: async () => ({ summary: "All at once.", id: 5 }) };
  const growth = [];
  const result = await summarizeText({ ...base, text: "t", fetchImpl: fetching(plain), onText: (s) => growth.push(s) });
  assert.deepEqual(result, { summary: "All at once.", filename: "", id: 5, quotaRemaining: 3 });
  assert.deepEqual(growth, []);
});

test("a refusal before the stream starts is an ordinary error", async () => {
  const refused = { ok: false, status: 429, headers: new Headers({ "Retry-After": "9" }), json: async () => ({ code: "api_key_limit", error: "limit" }) };
  await assert.rejects(summarizeText({ ...base, text: "t", fetchImpl: fetching(refused) }), (e) => e instanceof InklingError && e.code === "key_limit" && e.retryAfter === 9);
});

test("a failure part of the way through is reported, with what its status says", async () => {
  const fetchImpl = fetching(streamed([event({ type: "delta", text: "Half" }), event({ type: "error", status: 502, message: "The language model is unavailable." })]));
  await assert.rejects(summarizeText({ ...base, text: "t", fetchImpl }), (e) => e.code === "ai_failed" && e.detail === "The language model is unavailable.");
  const quota = fetching(streamed([event({ type: "error", status: 429, message: "slow down" })]));
  await assert.rejects(summarizeText({ ...base, text: "t", fetchImpl: quota }), (e) => e.code === "rate_limited");
});

test("a stream that ends without finishing, or without a summary, is a failure and not a silent half answer", async () => {
  for (const pieces of [[event({ type: "delta", text: "Cut off" })], [event({ type: "done" })], [event({ type: "status", stage: "writing" })], []]) {
    await assert.rejects(summarizeText({ ...base, text: "t", fetchImpl: fetching(streamed(pieces)) }), (e) => e.code === "ai_failed", JSON.stringify(pieces));
  }
});

test("a connection that breaks in the middle is a network error", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(event({ type: "delta", text: "Some" })));
      controller.error(new TypeError("network error"));
    },
  });
  const response = { ok: true, status: 200, headers: new Headers({ "Content-Type": "text/event-stream" }), body };
  await assert.rejects(summarizeText({ ...base, text: "t", fetchImpl: fetching(response) }), (e) => e.code === "network");
});

test("stopping part of the way throws an abort that carries what was written", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    async start(c) {
      c.enqueue(new TextEncoder().encode(event({ type: "delta", text: "Written so far" })));
      await new Promise((resolve) => setTimeout(resolve, 5));
      c.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
    },
  });
  const response = { ok: true, status: 200, headers: new Headers({ "Content-Type": "text/event-stream" }), body };
  await assert.rejects(
    summarizeText({ ...base, text: "t", fetchImpl: fetching(response), signal: controller.signal }),
    (e) => e.name === "AbortError" && e.partial === "Written so far",
  );
});
