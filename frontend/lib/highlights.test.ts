import { describe, expect, it } from "vitest";
import { canHighlight, forFile, inPageOrder, onPage, quoteFrom, shortQuote, type Highlight } from "./highlights";

const h = (id: number, page: number, fileId: number | null = 1, quote = "some words"): Highlight => ({ id, fileId, page, quote, note: "", createdAt: "2026-10-19T10:00:00Z" });

describe("quoteFrom and canHighlight", () => {
  it("turns selected words into one line", () => {
    expect(quoteFrom("  The notice\n  period   is\tsixty days ")).toBe("The notice period is sixty days");
  });

  it("offers to highlight a few words and not a letter or a whole book", () => {
    expect(canHighlight("a")).toBe(false);
    expect(canHighlight("ab")).toBe(true);
    expect(canHighlight("x".repeat(1000))).toBe(true);
    expect(canHighlight("x".repeat(1001))).toBe(false);
  });
});

describe("shortQuote", () => {
  it("keeps a short passage and cuts a long one", () => {
    expect(shortQuote("A short passage.")).toBe("A short passage.");
    const cut = shortQuote("word ".repeat(60));
    expect(cut.length).toBeLessThanOrEqual(120);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("onPage, forFile and inPageOrder", () => {
  const all = [h(3, 2), h(1, 1), h(2, 2, 9), h(4, 1, null)];

  it("picks the highlights of a page in the order they were made", () => {
    expect(onPage(all, 2).map((x) => x.id)).toEqual([2, 3]);
    expect(onPage(all, 7)).toEqual([]);
  });

  it("picks those of a file, and those with no file belong to all", () => {
    expect(forFile(all, 1).map((x) => x.id)).toEqual([3, 1, 4]);
    expect(forFile(all, 9).map((x) => x.id)).toEqual([2, 4]);
  });

  it("lists by page and then in the order made", () => {
    expect(inPageOrder(all).map((x) => x.id)).toEqual([1, 4, 2, 3]);
  });
});
