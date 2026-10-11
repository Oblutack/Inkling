// The summarize routes can answer as server-sent events (?stream=true): the summary arrives a few words at a time. The events:
//   { type: "status", stage, done?, total? }   how far the server has got (not shown here)
//   { type: "delta", text }                    the next piece of the summary
//   { type: "done", filename?, id? }           finished (id: the saved document, when it was asked to be kept)
//   { type: "error", status?, message }        the server gave up part of the way

// One block of the stream ("data: {...}"), or null for what is not an event (a comment, a keep-alive, something broken).
export function parseSseBlock(block) {
  const line = String(block)
    .split("\n")
    .find((l) => l.startsWith("data: "));
  if (!line) return null;
  try {
    const event = JSON.parse(line.slice("data: ".length));
    return event && typeof event.type === "string" ? event : null;
  } catch {
    return null;
  }
}

// Reads a response body as events, calling onEvent for each as it arrives. A chunk can hold several events or only part of
// one, and events are separated by a blank line.
export async function readEvents(response, onEvent) {
  if (!response.body) throw new Error("empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = parseSseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      if (event) onEvent(event);
    }
  }
  const rest = parseSseBlock(buffer);
  if (rest) onEvent(rest);
}
