import { describe, expect, it } from "vitest";
import { cardsCsv, cardsFileName, shuffled } from "./study";

// A source of "random" numbers that always runs through the same sequence.
function steady() {
  let n = 0;
  const values = [0.1, 0.9, 0.5, 0.3];
  return () => values[n++ % values.length];
}

describe("shuffled", () => {
  it("keeps every item exactly once and leaves the original alone", () => {
    const original = [1, 2, 3, 4, 5, 6];
    const result = shuffled(original);
    expect([...result].sort()).toEqual(original);
    expect(original).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gives the same order for the same random numbers", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(shuffled(items, steady())).toEqual(shuffled(items, steady()));
    expect(shuffled(items, steady())).not.toEqual(items);
  });

  it("handles empty and single lists", () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(["only"])).toEqual(["only"]);
  });

  it("actually reorders", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(shuffled([1, 2, 3, 4]).join(""));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe("cardsCsv", () => {
  it("is two columns with no header, quoted where needed, with a byte order mark", () => {
    const text = cardsCsv([
      { front: "What is rent?", back: "950 euros, paid monthly" },
      { front: 'The word "deposit"', back: "Money kept\nuntil you leave" },
    ]);
    expect(text).toBe('﻿What is rent?,"950 euros, paid monthly"\r\n"The word ""deposit""","Money kept\nuntil you leave"\r\n');
  });

  it("does not let a spreadsheet run a card as a formula", () => {
    const text = cardsCsv([{ front: '=HYPERLINK("http://evil.example")', back: "+1 and @someone" }]);
    expect(text).toContain(`"'=HYPERLINK(`);
    expect(text).toContain("'+1 and @someone");
  });

  it("is just the byte order mark when there are no cards", () => {
    expect(cardsCsv([])).toBe("﻿\r\n");
  });
});

describe("cardsFileName", () => {
  it("is made from the title", () => {
    expect(cardsFileName("Cell biology notes.pdf")).toBe("Cell-biology-notes-flashcards.csv");
    expect(cardsFileName("Lease v2")).toBe("Lease-v2-flashcards.csv");
  });

  it("has a plain name when the title has nothing to use", () => {
    expect(cardsFileName("***")).toBe("flashcards.csv");
  });
});
