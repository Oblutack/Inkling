import { buildZip } from "./zip";

// Notes for other apps: each saved summary as a Markdown file with front matter (title, date, tags, source page), the way
// Obsidian reads it, and flashcards in the form the Spaced Repetition plugin reads ("question::answer"). Notion imports the same
// Markdown files (and a zip of them). Everything is made here in the browser from what the API sends.

export interface Note {
  id: number;
  title: string;
  createdAt: string;
  tags: string[];
  summary: string;
  url: string;
  flashcards: Array<{ front: string; back: string }>;
  // The passages the person marked in the original PDF, with their notes.
  highlights?: Array<{ page: number; quote: string; note: string }>;
}

// A text as YAML knows it: in double quotes, with the same escapes as JSON (JSON is YAML).
export function yamlString(text: string): string {
  return JSON.stringify(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""));
}

// A tag as Obsidian takes it: no spaces and none of the characters that end a tag.
export function noteTag(tag: string): string {
  return tag
    .trim()
    .replace(/[\s,#]+/g, "-")
    .replace(/[^\p{L}\p{N}_\-/]/gu, "")
    .replace(/^-+|-+$/g, "");
}

// One line, for the front or the back of a card (the plugin reads a card from a single line).
export function cardLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/::/g, ": :").trim();
}

export function noteMarkdown(note: Note): string {
  const tags = [...new Set(note.tags.map(noteTag).filter(Boolean))];
  if (note.flashcards.length > 0 && !tags.includes("flashcards")) tags.push("flashcards");
  const lines = ["---", `title: ${yamlString(note.title.replace(/\s+/g, " ").trim() || "Untitled")}`];
  const created = new Date(note.createdAt);
  if (!Number.isNaN(created.getTime())) lines.push(`created: ${created.toISOString()}`);
  if (note.url) lines.push(`source: ${yamlString(note.url)}`);
  lines.push(`inkling-id: ${note.id}`);
  if (tags.length > 0) lines.push("tags:", ...tags.map((tag) => `  - ${tag}`));
  lines.push("---", "");
  if (note.summary.trim()) lines.push(note.summary.trim(), "");
  if (note.flashcards.length > 0) {
    lines.push("## Flashcards", "");
    for (const card of note.flashcards) {
      const front = cardLine(card.front);
      const back = cardLine(card.back);
      if (front && back) lines.push(`${front}::${back}`);
    }
    lines.push("");
  }
  const highlights = note.highlights ?? [];
  if (highlights.length > 0) {
    lines.push("## Highlights", "");
    for (const h of highlights) {
      const quote = h.quote.replace(/\s+/g, " ").trim();
      if (!quote) continue;
      lines.push(`> ${quote} (page ${h.page})`);
      const written = h.note.replace(/\s+/g, " ").trim();
      if (written) lines.push("", `**Note:** ${written}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// A file name from a title: what a file name cannot hold is dropped (letters of any language stay), and a name that is taken
// gets " (2)", " (3)"... `used` is the names so far, in lower case.
export function noteFileName(title: string, used: Set<string>): string {
  const base =
    title
      .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+/, "")
      .slice(0, 100)
      .trim() || "Untitled";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
  used.add(name.toLowerCase());
  return `${name}.md`;
}

export const LIBRARY_FOLDER = "Inkling";

// Every note as a zip: one Markdown file each, in a folder, ready to be dropped into an Obsidian vault or imported by Notion.
export function libraryZip(notes: readonly Note[], now: Date = new Date()): Uint8Array<ArrayBuffer> {
  const used = new Set<string>();
  const entries = notes.map((note) => ({ name: `${LIBRARY_FOLDER}/${noteFileName(note.title, used)}`, data: noteMarkdown(note) }));
  return buildZip(entries, now);
}

export function libraryZipName(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `inkling-notes-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.zip`;
}
