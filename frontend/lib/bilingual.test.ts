import { describe, expect, it } from "vitest";
import { bilingualMarkdown, figureWarnings, numberedPositions, type Bilingual, type BilingualRow } from "./bilingual";

const row = (kind: BilingualRow["kind"], source: string, target = "", figuresKept = true): BilingualRow => ({ kind, source, target, figuresKept });

describe("numberedPositions", () => {
  it("counts numbered lines again after any other line", () => {
    const rows = [row("numbered", "a"), row("numbered", "b"), row("paragraph", "c"), row("numbered", "d"), row("heading", "e")];
    expect(numberedPositions(rows)).toEqual([1, 2, 0, 1, 0]);
  });
});

describe("figureWarnings", () => {
  it("counts translated lines whose figures differ, and not lines that were not translated", () => {
    expect(figureWarnings([row("paragraph", "a", "x", false), row("paragraph", "b", "y", true), row("paragraph", "c", "", false)])).toBe(1);
    expect(figureWarnings([])).toBe(0);
  });
});

describe("bilingualMarkdown", () => {
  it("gives each line and then its translation, and the vocabulary", () => {
    const result: Bilingual = {
      language: "German",
      rows: [row("heading", "Rent", "Miete"), row("bullet", "Notice is 60 days.", "Die Frist beträgt 60 Tage."), row("paragraph", "Pets are not allowed.")],
      vocabulary: [{ word: "notice", translation: "Kündigung" }],
      missing: 1,
    };
    expect(bilingualMarkdown("Lease", "English", result)).toBe(
      [
        "# Lease",
        "",
        "English | German",
        "",
        "## Rent",
        "## *Miete*",
        "",
        "- Notice is 60 days.",
        "- *Die Frist beträgt 60 Tage.*",
        "",
        "Pets are not allowed.",
        "",
        "## Vocabulary",
        "",
        "- notice = Kündigung",
        "",
      ].join("\n"),
    );
  });
});
