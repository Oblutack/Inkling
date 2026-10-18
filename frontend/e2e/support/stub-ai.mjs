// A stand-in for the Python AI service, so the end-to-end tests are fast, free and deterministic.
// It speaks the same HTTP contract the Go gateway expects (see python-ai-service/main.py):
//   GET  /healthz
//   POST /summarize-text[?stream=true]   JSON {text}
//   POST /overview[?stream=true]         JSON {name, documents}: a briefing that lists them
//   POST /extract                        JSON {name, text, fields}: a value and a quote for every field
//   POST /compare                        JSON {old, new, language}: sentence i against sentence i, as a comparison
//   POST /summarize-url[?stream=true]    JSON {url}: the page is titled "Page from <host>"
//   POST /summarize | /summarize-multiple[?stream=true]   multipart file(s); a recording's text is a transcript,
//                                                          photos are pages (text names the file, type and size)
//   POST /chat                           JSON {text, question, history}
//   POST /embed                          JSON {texts, kind}: word-bucket vectors, synonyms share a bucket
//   POST /read | /read-url               multipart file(s) | JSON {url}: the text of a document, with no summary made
//   POST /study                          JSON {summary, text, kind}: three flashcards, or a three-question quiz
// Magic inputs: text containing FAIL_ME makes the "model" fail; SLOW_ME makes it write slowly.
import http from "node:http";

const PORT = Number(process.env.STUB_AI_PORT ?? 18081);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Filenames of the uploaded parts; the stub does not read the PDFs themselves.
function uploadedNames(body) {
  return [...body.toString("latin1").matchAll(/filename="([^"]+)"/g)].map((m) => m[1]);
}

// The uploaded parts with their type and size, so a test can see what the browser really sent (a photo made smaller, say).
function uploadedParts(body) {
  const text = body.toString("latin1");
  const parts = [];
  for (const m of text.matchAll(/filename="([^"]+)"\r\nContent-Type: ([^\r]+)\r\n\r\n/g)) {
    const from = m.index + m[0].length;
    const to = text.indexOf("\r\n--", from);
    parts.push({ name: m[1], type: m[2], size: (to < 0 ? text.length : to) - from });
  }
  return parts;
}
const isPhoto = (name) => /\.(jpe?g|png|webp)$/i.test(name);
// The field the gateway adds for signed-in people: it allows pictures of text to be read.
const mayRead = (body) => /name="ocr"\r\n\r\ntrue/.test(body.toString("latin1"));

const words = (text) => text.split(/\s+/).filter(Boolean);
// `options` (the query string of a text summary) lets tests see which style, length and standing instructions arrived.
const summaryOf = (subject, source, options) => {
  const lines = [
    "## Stub summary",
    "",
    `- Subject: ${subject}`,
    `- Opening words: ${words(source).slice(0, 8).join(" ")}`,
    `- Words in source: ${words(source).length}`,
  ];
  if (options) {
    const instructions = options.get("instructions");
    lines.push(
      `- Options: ${options.get("style") ?? "default"}, ${options.get("word_count") ?? "150"} words, ${options.get("language") ?? "English"}` +
        (instructions ? `, instructions: ${instructions}` : "")
    );
  }
  return lines.join("\n");
};

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function streamSummary(res, summary, doneExtra, { slow, fail }) {
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "status", stage: "preparing" });
  send({ type: "status", stage: "summarizing", done: 1, total: 2 });
  await sleep(40);
  send({ type: "status", stage: "summarizing", done: 2, total: 2 });
  if (fail) {
    send({ type: "error", status: 502, message: "The language model is unavailable. Please try again." });
    return res.end();
  }
  send({ type: "status", stage: "writing" });
  for (const piece of summary.match(/\S+\s*/g) ?? []) {
    await sleep(slow ? 500 : 15);
    if (res.destroyed || res.writableEnded) return;
    send({ type: "delta", text: piece });
  }
  send({ type: "done", ...doneExtra });
  res.end();
}

// A stand-in for an embedding model: each word lands in a bucket, and words of one group ("cat",
// "dog", "pet") share one, so a question about pets is close to a passage about cats and dogs.
const MEANING = {
  pet: ["cat", "cats", "dog", "dogs", "pet", "pets", "animal", "animals"],
  money: ["rent", "pay", "payment", "cost", "price", "fee", "euros"],
};
const GROUP_OF = Object.fromEntries(Object.entries(MEANING).flatMap(([group, words]) => words.map((w) => [w, group])));
const STOP = new Set(["can", "the", "and", "are", "not", "for", "how", "what", "with", "from", "this", "that", "does", "much", "keep"]);
const DIM = 64;

function embed(text) {
  const vector = new Float32Array(DIM);
  for (let word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (word.length <= 2 || STOP.has(word)) continue;
    word = GROUP_OF[word] ?? word;
    let hash = 2166136261;
    for (const ch of word) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    vector[hash % DIM] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return Buffer.from(new Float32Array(vector.map((v) => v / norm)).buffer).toString("base64");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://stub");
  const stream = url.searchParams.get("stream") === "true";

  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { status: "ok" });
  if (req.method !== "POST") return json(res, 404, { detail: "not found" });

  const body = await readBody(req);

  if (url.pathname === "/summarize-text") {
    const { text = "" } = JSON.parse(body.toString("utf8") || "{}");
    const flags = { slow: text.includes("SLOW_ME"), fail: text.includes("FAIL_ME") };
    const summary = summaryOf("pasted text", text, url.searchParams);
    if (stream) return streamSummary(res, summary, { text }, flags);
    if (flags.fail) return json(res, 502, { detail: "The language model is unavailable. Please try again." });
    return json(res, 200, { summary, text });
  }

  if (url.pathname === "/extract") {
    // Every field is found and checked, except where its name says otherwise ("missing", "unverified", "instruction",
    // "formula"). A document called "suspicious" is reported as having instructions for an AI in it.
    // A document called "boom" makes it fail.
    const { name = "", fields = [] } = JSON.parse(body.toString("utf8") || "{}");
    if (String(name).toLowerCase().includes("boom")) return json(res, 502, { detail: "The language model failed to extract the fields." });
    return json(res, 200, {
      name,
      fields: fields.map((field) => {
        const lower = String(field.name).toLowerCase();
        const found = !lower.includes("missing");
        const formula = lower.includes("formula");
        return {
          name: field.name,
          type: field.type,
          value: found ? (formula ? "=HYPERLINK(\"http://evil.example\",\"click\")" : `Value of ${field.name}`) : "",
          quote: found ? `The document says: ${field.name}` : "",
          page: found ? 1 : null,
          found,
          verified: found && !lower.includes("unverified") && !lower.includes("instruction"),
          reason: !found
            ? ""
            : lower.includes("instruction")
              ? "The quote comes from text that reads like an instruction to an AI."
              : lower.includes("unverified")
                ? "The quote was not found in the document."
                : "",
        };
      }),
      suspicious: String(name).toLowerCase().includes("suspicious"),
    });
  }

  if (url.pathname === "/compare") {
    // A stand-in for the comparison: sentence number i of the old text against sentence number i of the new one.
    // A document called "boom" makes it fail; the same text twice is "no differences".
    const { old = {}, new: neu = {}, language = "" } = JSON.parse(body.toString("utf8") || "{}");
    if (String(old.name ?? "").toLowerCase().includes("boom")) return json(res, 502, { detail: "The language model failed to compare the documents." });
    const sentences = (text) => String(text ?? "").split(/(?<=[.!?])\s+/).filter(Boolean);
    const a = sentences(old.text);
    const b = sentences(neu.text);
    const numbers = (text) => String(text ?? "").match(/\d+/g) ?? [];
    const changes = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      const kind = a[i] === undefined ? "added" : b[i] === undefined ? "removed" : "changed";
      const gone = numbers(a[i]).filter((n) => !numbers(b[i]).includes(n));
      const came = numbers(b[i]).filter((n) => !numbers(a[i]).includes(n));
      changes.push({
        id: changes.length + 1,
        kind,
        before: a[i] ?? "",
        after: b[i] ?? "",
        beforePage: a[i] === undefined ? null : 1,
        afterPage: b[i] === undefined ? null : 1,
        segments: kind === "changed" ? [["del", a[i]], ["ins", b[i]]] : null,
        numbers: { removed: gone, added: came },
        importance: gone.length || came.length ? "high" : kind === "changed" ? "medium" : "low",
        summary: `Stub: sentence ${i + 1} was ${kind}.`,
        impact: "Stub: it could matter.",
        explained: true,
        suspicious: /ignore .*instructions/i.test(`${a[i] ?? ""} ${b[i] ?? ""}`),
      });
    }
    const counts = { added: 0, removed: 0, changed: 0, moved: 0 };
    for (const change of changes) counts[change.kind] += 1;
    return json(res, 200, {
      identical: changes.length === 0,
      counts,
      changes,
      bottomLine: changes.length ? `Stub bottom line (${language || "same language"}): ${changes.length} changes.` : "",
      explained: true,
      omitted: 0,
      suspicious: changes.some((change) => change.suspicious),
    });
  }

  if (url.pathname === "/overview") {
    const { name = "", documents = [] } = JSON.parse(body.toString("utf8") || "{}");
    const summary = [
      "## Stub overview",
      "",
      `- Collection: ${name}`,
      `- Documents: ${documents.length}`,
      `- Names: ${documents.map((d) => d.name.split("\n")[0]).join(" / ")}`,
      `- Options: ${url.searchParams.get("style") ?? "default"}, ${url.searchParams.get("word_count") ?? "300"} words, ${url.searchParams.get("language") ?? "English"}`,
    ].join("\n");
    const flags = { slow: name.includes("slow"), fail: name.includes("fail") };
    if (stream) return streamSummary(res, summary, { filename: `Overview: ${name}` }, flags);
    if (flags.fail) return json(res, 502, { detail: "The language model is unavailable. Please try again." });
    return json(res, 200, { filename: `Overview: ${name}`, summary });
  }

  // A document read only to be studied: the text, with no summary made (the same refusals as for a summary).
  if (url.pathname === "/read-url") {
    const { url: address = "" } = JSON.parse(body.toString("utf8") || "{}");
    if (address.includes("private.example")) {
      return json(res, 422, { detail: "That address is not on the public internet, so Inkling cannot open it." });
    }
    return json(res, 200, { filename: `Page from ${new URL(address).hostname}`, text: `(stub) article text read from ${address}` });
  }

  if (url.pathname === "/read") {
    const names = uploadedNames(body);
    return json(res, 200, { filename: names.join(", "), text: `(stub) text read from ${names.join(", ")}` });
  }

  if (url.pathname === "/summarize-url") {
    const { url: address = "" } = JSON.parse(body.toString("utf8") || "{}");
    // Addresses the real service would refuse, so tests can see how the page shows the reason.
    if (address.includes("private.example")) {
      return json(res, 422, { detail: "That address is not on the public internet, so Inkling cannot open it." });
    }
    if (address.includes("empty.example")) {
      return json(res, 422, { detail: "Inkling could not find readable text on that page." });
    }
    const title = `Page from ${new URL(address).hostname}`;
    const text = `(stub) article text read from ${address}`;
    const summary = summaryOf(title, text, url.searchParams);
    if (stream) return streamSummary(res, summary, { filename: title, text }, { slow: address.includes("slow.example") });
    return json(res, 200, { filename: title, summary, text });
  }

  if (url.pathname === "/summarize" || url.pathname === "/summarize-multiple") {
    const names = uploadedNames(body);
    const pictures = uploadedParts(body).filter((p) => isPhoto(p.name));
    if (pictures.length > 0 && !mayRead(body)) {
      return json(res, 422, { detail: "Sign in to have the text in photos read." });
    }
    // Photos are the pages of one document, wherever they come among the files (as in the real service).
    const filename = [
      ...names.filter((n) => !isPhoto(n)),
      ...(pictures.length > 0
        ? [pictures.length === 1 ? pictures[0].name : `${pictures[0].name} (+${pictures.length - 1} more photos)`]
        : []),
    ].join(", ");
    if (pictures.length > 0 && pictures.length === names.length) {
      const pages = pictures.map((p) => `Text read from the photo ${p.name} (${p.size} bytes).`);
      const photoText = pages.join("\f");
      const summary = summaryOf(filename, photoText);
      if (stream) return streamSummary(res, summary, { filename, text: photoText }, {});
      return json(res, 200, { filename, summary, text: photoText });
    }
    // A recording is transcribed first: its text is a transcript with the time of each paragraph.
    const recording = names.length === 1 && /\.(mp3|m4a|wav|ogg|flac|webm|mp4|mpeg|mpga)$/i.test(names[0]);
    const text = recording
      ? `Transcript of ${filename} (length 1:00).

[0:00] The stub transcript of ${filename}.

[0:30] Priya will send the budget by Friday.`
      : `(stub) extracted text of ${filename}`;
    const summary = summaryOf(filename, text);
    if (stream) return streamSummary(res, summary, { filename, text }, {});
    return json(res, 200, { filename, summary, text });
  }

  if (url.pathname === "/passages") {
    const { text = "" } = JSON.parse(body.toString("utf8") || "{}");
    // The text of a stubbed PDF is a placeholder; give it one passage that matches the e2e PDF's page 2.
    if (text.startsWith("(stub) extracted text of")) {
      return json(res, 200, {
        passages: [{ text: "Stub passage that the answer cites.", page: 2, pageEnd: 2, document: null }],
      });
    }
    const passages = text
      .split(/\n\n/)
      .filter((p) => p.trim())
      .map((p) => ({ text: p, page: null, pageEnd: null, document: null }));
    return json(res, 200, { passages });
  }

  if (url.pathname === "/suggest") {
    return json(res, 200, {
      questions: ["What is the main point?", "Who is this written for?", "What happens next?", "Why does it matter?"],
    });
  }

  if (url.pathname === "/study") {
    if (body.toString("utf8").includes("FAIL_ME")) return json(res, 502, { detail: "The language model failed to write flashcards." });
    const { kind = "flashcards" } = JSON.parse(body.toString("utf8") || "{}");
    if (kind === "quiz") {
      return json(res, 200, {
        kind,
        questions: [
          { question: "Quiz question one?", options: ["Wrong A", "Right one", "Wrong C", "Wrong D"], answer: 1, explanation: "Because one." },
          { question: "Quiz question two?", options: ["Right two", "Wrong B", "Wrong C", "Wrong D"], answer: 0, explanation: "Because two." },
          { question: "Quiz question three?", options: ["Wrong A", "Wrong B", "Wrong C", "Right three"], answer: 3, explanation: "Because three." },
        ],
      });
    }
    return json(res, 200, {
      kind,
      cards: [
        { front: "Front of card one", back: "Back of card one" },
        { front: "Front of card two", back: "Back of card two" },
        { front: "Front of card three", back: "Back of card three" },
      ],
    });
  }

  if (url.pathname === "/embed") {
    const { texts = [] } = JSON.parse(body.toString("utf8") || "{}");
    return json(res, 200, { model: "stub-embeddings", dim: DIM, minScore: 0.3, vectors: texts.map(embed) });
  }

  if (url.pathname === "/ask") {
    const { question = "", passages = [] } = JSON.parse(body.toString("utf8") || "{}");
    // Cite the first passage the gateway chose: that is how a test sees which documents were searched.
    const cited = passages.slice(0, 1);
    return json(res, 200, {
      answer: `Stub library answer to "${question}" from ${passages.length} passage(s)${cited.length ? " [1]" : ""}.`,
      sources: cited,
    });
  }

  if (url.pathname === "/podcast") {
    const { language = "" } = JSON.parse(body.toString("utf8") || "{}");
    return json(res, 200, {
      title: `Stub episode about the document${language ? ` (${language})` : ""}`,
      turns: [
        { speaker: "A", text: "So what is this document about?" },
        { speaker: "B", text: "It is a stub document used in tests." },
        { speaker: "A", text: "What is the main point?" },
        { speaker: "B", text: "That the player reads every line in order." },
        { speaker: "A", text: "Anything to remember?" },
        { speaker: "B", text: "Yes: two voices, one conversation." },
      ],
    });
  }

  if (url.pathname === "/proof") {
    const { text = "" } = JSON.parse(body.toString("utf8") || "{}");
    const passage = { id: 1, text: "Stub passage that the answer cites.", page: 2, pageEnd: 2, coverage: 0.92 };
    const sentence = (text, support, extra = {}) => ({
      text, kind: "claim", support, coverage: 0.8, missingNumbers: [], elsewhereNumbers: [], passages: [passage], ...extra,
    });
    return json(res, 200, {
      sentences: [
        { text: "Stub summary", kind: "heading", support: null, coverage: 0, missingNumbers: [], elsewhereNumbers: [], passages: [] },
        sentence("The first claim is backed word for word.", "strong"),
        sentence("The second claim is paraphrased.", "weak", { coverage: 0.5 }),
        sentence("The third claim says 99 things.", "none", { coverage: 0.1, missingNumbers: ["99"], passages: [] }),
      ],
      claims: 3, found: 1, partly: 1, notFound: 1,
      // Magic text: pretend the summary is in another language than the document.
      verifiable: !text.includes("LANGUAGE_MISMATCH"),
    });
  }

  if (url.pathname === "/chat") {
    const { question = "", text = "" } = JSON.parse(body.toString("utf8") || "{}");
    const answer = `Stub answer to "${question}" (the document has ${words(text).length} words)`;
    // Magic questions: NOCITE gets an answer with no citations; INVENTED also uses a marker that
    // matches no source (the real service strips those; the UI must still never link them).
    if (question.includes("NOCITE")) return json(res, 200, { answer: `${answer}.`, sources: [] });
    const invented = question.includes("INVENTED") ? " and [9]" : "";
    return json(res, 200, {
      answer: `${answer} [1]${invented}.`,
      // A recording's passages begin with the time they were said, and have no page.
      sources: text.startsWith("Transcript of")
        ? [{ id: 1, text: "[0:30] Priya will send the budget by Friday.", page: null, pageEnd: null, document: null }]
        : [{ id: 1, text: "Stub passage that the answer cites.", page: 2, pageEnd: 2, document: null }],
    });
  }

  return json(res, 404, { detail: "not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`stub AI service on :${PORT}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
