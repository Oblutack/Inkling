import { describe, expect, it } from "vitest";
import { cardLine, libraryZip, libraryZipName, noteFileName, noteMarkdown, noteTag, yamlString, type Note } from "./obsidian";
import { buildZip, crc32 } from "./zip";

const note = (patch: Partial<Note> = {}): Note => ({
  id: 7,
  title: "Lease terms",
  createdAt: "2026-10-18T10:00:00.000Z",
  tags: ["housing", "legal docs"],
  summary: "## Rent\n- 950 euros per month.",
  url: "",
  flashcards: [],
  ...patch,
});

// A small reader for what buildZip makes, to check it the way a zip program would.
function readZip(bytes: Uint8Array): Array<{ name: string; text: string; crc: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    expect(view.getUint16(at + 8, true) & 0x0800).toBe(0x0800); // UTF-8 names
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, text: new TextDecoder().decode(data), crc });
    at += 46 + nameLength;
  }
  return out;
}

describe("crc32", () => {
  it("is the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("buildZip", () => {
  it("holds every file with its name, text and check value", () => {
    const zip = buildZip([
      { name: "a.md", data: "first" },
      { name: "Folder/ü ö.md", data: "second — with “quotes”" },
      { name: "empty.md", data: "" },
    ]);
    expect(readZip(zip).map((f) => [f.name, f.text])).toEqual([
      ["a.md", "first"],
      ["Folder/ü ö.md", "second — with “quotes”"],
      ["empty.md", ""],
    ]);
  });

  it("is a valid empty zip for nothing", () => {
    expect(readZip(buildZip([]))).toEqual([]);
  });

  it("keeps the time it was made", () => {
    const zip = buildZip([{ name: "a.md", data: "x" }], new Date(2026, 9, 18, 14, 30, 10));
    const view = new DataView(zip.buffer);
    expect(view.getUint16(10, true)).toBe((14 << 11) | (30 << 5) | 5);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (10 << 5) | 18);
  });
});

describe("yamlString and noteTag and cardLine", () => {
  it("quote a text safely for YAML", () => {
    expect(yamlString('A "quoted": title\nwith a line')).toBe('"A \\"quoted\\": title\\nwith a line"');
    expect(yamlString("x\u0001y")).toBe('"xy"');
  });

  it("make a tag Obsidian takes", () => {
    expect(noteTag("legal docs")).toBe("legal-docs");
    expect(noteTag(" #Housing, costs ")).toBe("Housing-costs");
    expect(noteTag("zdravlje i škola")).toBe("zdravlje-i-škola");
    expect(noteTag("%%%")).toBe("");
  });

  it("put a card on one line and keep :: for the divider only", () => {
    expect(cardLine("What is\nthe notice?")).toBe("What is the notice?");
    expect(cardLine("a::b")).toBe("a: :b");
  });
});

describe("noteMarkdown", () => {
  it("has front matter, then the summary", () => {
    expect(noteMarkdown(note())).toBe(
      [
        "---",
        'title: "Lease terms"',
        "created: 2026-10-18T10:00:00.000Z",
        "inkling-id: 7",
        "tags:",
        "  - housing",
        "  - legal-docs",
        "---",
        "",
        "## Rent",
        "- 950 euros per month.",
        "",
      ].join("\n"),
    );
  });

  it("names the page it came from", () => {
    expect(noteMarkdown(note({ url: "https://blog.example/post?a=1&b=2" }))).toContain('source: "https://blog.example/post?a=1&b=2"');
  });

  it("writes flashcards as question::answer lines, and tags the note for the plugin", () => {
    const text = noteMarkdown(
      note({
        flashcards: [
          { front: "Notice period?", back: "60 days" },
          { front: "Deposit\nreturned when?", back: "Within 30 days" },
          { front: "", back: "no front" },
        ],
      }),
    );
    expect(text).toContain("## Flashcards\n\nNotice period?::60 days\nDeposit returned when?::Within 30 days\n");
    expect(text).not.toContain("no front");
    expect(text).toContain("  - flashcards");
  });

  it("lists the highlights as quotes with their notes", () => {
    const text = noteMarkdown(
      note({
        highlights: [
          { page: 2, quote: "Notice\nis 60 days", note: "ask about it" },
          { page: 5, quote: "No pets", note: "" },
          { page: 6, quote: " ", note: "nothing marked" },
        ],
      }),
    );
    expect(text).toContain("## Highlights\n\n> Notice is 60 days (page 2)\n\n**Note:** ask about it\n\n> No pets (page 5)\n");
    expect(text).not.toContain("nothing marked");
  });

  it("is a note with only flashcards for a study set", () => {
    const text = noteMarkdown(note({ summary: "", tags: [], flashcards: [{ front: "Q", back: "A" }] }));
    expect(text).toBe(['---', 'title: "Lease terms"', "created: 2026-10-18T10:00:00.000Z", "inkling-id: 7", "tags:", "  - flashcards", "---", "", "## Flashcards", "", "Q::A", ""].join("\n"));
  });

  it("copes with a title that would break YAML and a date that is not one", () => {
    const text = noteMarkdown(note({ title: 'Cost: "big" # not a comment', createdAt: "never" }));
    expect(text).toContain('title: "Cost: \\"big\\" # not a comment"');
    expect(text).not.toContain("created:");
  });
});

describe("noteFileName", () => {
  it("drops what a file name cannot hold and keeps letters of any language", () => {
    const used = new Set<string>();
    expect(noteFileName('Lease: "terms"/v2?', used)).toBe("Lease terms v2.md");
    expect(noteFileName("Договор аренды #1", used)).toBe("Договор аренды 1.md");
    expect(noteFileName("   ", used)).toBe("Untitled.md");
    expect(noteFileName("...hidden", used)).toBe("hidden.md");
    expect(noteFileName("lease-agreement.PDF", used)).toBe("lease-agreement.md");
    expect(noteFileName("Meeting.m4a", used)).toBe("Meeting.md");
    expect(noteFileName("Version 2.5", used)).toBe("Version 2.5.md");
  });

  it("numbers a name that is taken, whatever its case", () => {
    const used = new Set<string>();
    expect(noteFileName("Notes", used)).toBe("Notes.md");
    expect(noteFileName("notes", used)).toBe("notes (2).md");
    expect(noteFileName("NOTES", used)).toBe("NOTES (3).md");
  });

  it("is never longer than a file name should be", () => {
    expect(noteFileName("x".repeat(300), new Set()).length).toBeLessThanOrEqual(103);
  });
});

describe("libraryZip", () => {
  it("has one Markdown file per note in a folder", () => {
    const zip = libraryZip([note(), note({ id: 8 }), note({ id: 9, title: "Other" })]);
    expect(readZip(zip).map((f) => f.name)).toEqual(["Inkling/Lease terms.md", "Inkling/Lease terms (2).md", "Inkling/Other.md"]);
    expect(readZip(zip)[2].text).toContain("inkling-id: 9");
  });

  it("is named for the day", () => {
    expect(libraryZipName(new Date(2026, 9, 5))).toBe("inkling-notes-2026-10-05.zip");
  });
});
