// The calls to the Inkling API for programs (docs/openapi.yaml). Nothing here touches the page or the screen.

// Keep in step with the API: the most text it takes in one request (maxLength of /v1/summarize-text).
export const MAX_TEXT_CHARS = 200_000;

// Every failure has a `code` that the screen turns into a sentence in the person's language.
export class InklingError extends Error {
  constructor(code, { status = 0, retryAfter = 0, detail = "" } = {}) {
    super(`${code}${status ? ` (${status})` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "InklingError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

// What the API said, as a code. It names its own reasons (`code`) for the ones a person can act on.
export function errorFromResponse(status, body, retryAfterHeader) {
  const code = body && typeof body.code === "string" ? body.code : "";
  const detail = body && typeof body.error === "string" ? body.error : "";
  const retryAfter = Number.parseInt(retryAfterHeader ?? "", 10) || 0;
  const known = {
    invalid_api_key: "invalid_key",
    api_key_expired: "expired_key",
    api_key_limit: "key_limit",
    quota_exceeded: "quota",
    daily_budget: "paused",
  };
  if (known[code]) return new InklingError(known[code], { status, retryAfter, detail });
  if (status === 401) return new InklingError("invalid_key", { status, detail });
  if (status === 413) return new InklingError("too_large", { status, detail });
  if (status === 429) return new InklingError("rate_limited", { status, retryAfter, detail });
  if (status === 503) return new InklingError("paused", { status, retryAfter, detail });
  if (status === 502 || status === 504) return new InklingError("ai_failed", { status, detail });
  if (status === 400 || status === 422) return new InklingError("bad_request", { status, detail });
  return new InklingError("unknown", { status, detail });
}

async function request({ baseUrl, apiKey, path, query = {}, body, signal, fetchImpl = fetch }) {
  const url = new URL(baseUrl + path);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit", // never the website's cookie: this is the key's business only
      signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    throw new InklingError("network");
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    // not JSON: handled below by status
  }
  if (!response.ok) throw errorFromResponse(response.status, json, response.headers.get("Retry-After"));
  return { json, response };
}

function number(headers, name) {
  const value = Number.parseInt(headers.get(name) ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function asSummary({ json, response }) {
  if (!json || typeof json.summary !== "string" || !json.summary.trim()) throw new InklingError("ai_failed", { status: response.status });
  return {
    summary: json.summary,
    filename: typeof json.filename === "string" ? json.filename : "",
    id: Number.isInteger(json.id) ? json.id : null,
    quotaRemaining: number(response.headers, "X-Quota-Remaining"),
  };
}

// The options a summary is made with: { language, wordCount, style, save }.
function options({ language, wordCount, style, save }) {
  return { language, wordCount, style, save: save ? "true" : undefined };
}

export async function summarizeText({ baseUrl, apiKey, text, signal, fetchImpl, ...choices }) {
  const clipped = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  return asSummary(await request({ baseUrl, apiKey, signal, fetchImpl, path: "/v1/summarize-text", query: options(choices), body: { text: clipped } }));
}

// For a page whose text cannot be read in the browser (a PDF in the browser's own viewer): the server reads the address.
export async function summarizeUrl({ baseUrl, apiKey, url, signal, fetchImpl, ...choices }) {
  return asSummary(await request({ baseUrl, apiKey, signal, fetchImpl, path: "/v1/summarize-url", query: options(choices), body: { url } }));
}

// What the key is and what it has done today (does not count as a request).
export async function keyUsage({ baseUrl, apiKey, signal, fetchImpl }) {
  const { json } = await request({ baseUrl, apiKey, signal, fetchImpl, path: "/v1/usage" });
  const key = json && typeof json.key === "object" && json.key ? json.key : {};
  return {
    name: typeof key.name === "string" ? key.name : "",
    usedToday: Number.isInteger(key.usedToday) ? key.usedToday : 0,
    dailyLimit: Number.isInteger(key.dailyLimit) ? key.dailyLimit : null,
  };
}
