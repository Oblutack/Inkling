import { describe, expect, it } from "vitest";
import { englishT } from "./i18n";
import { markTerms, pagesText, termIndexOf, type GlossaryTerm } from "./glossary";

const term = (text: string, pages: number[] = []): GlossaryTerm => ({ term: text, explanation: `About ${text}.`, pages });

describe("markTerms", () => {
  it("links the first place of each term, whatever its case", () => {
    expect(markTerms("The Escrow account holds money. Escrow again.", [term("escrow")])).toBe(
      "The [Escrow](#term-0) account holds money. Escrow again.",
    );
  });

  it("finds a term only as a whole word", () => {
    expect(markTerms("The apartment is part of the party.", [term("art")])).toBe("The apartment is part of the party.");
    expect(markTerms("Fine art, not artisan.", [term("art")])).toBe("Fine [art](#term-0), not artisan.");
  });

  it("takes the longer term when two overlap, and each only once", () => {
    const terms = [term("deposit"), term("security deposit")];
    expect(markTerms("A security deposit is a deposit.", terms)).toBe("A [security deposit](#term-1) is a [deposit](#term-0).");
  });

  it("matches a term across a change of spacing, and in any language", () => {
    expect(markTerms("A security  deposit.", [term("security deposit")])).toBe("A [security  deposit](#term-0).");
    expect(markTerms("Depozit se vraća. Štednja.", [term("depozit"), term("štednja")])).toBe("[Depozit](#term-0) se vraća. [Štednja](#term-1).");
  });

  it("leaves headings, code and existing links alone", () => {
    const text = "## Escrow rules\n`escrow` and [escrow](https://x.example) and escrow.";
    expect(markTerms(text, [term("escrow")])).toBe("## Escrow rules\n`escrow` and [escrow](https://x.example) and [escrow](#term-0).");
  });

  it("works inside bold text and list items", () => {
    expect(markTerms("- **Arrears** are due.", [term("arrears")])).toBe("- **[Arrears](#term-0)** are due.");
  });

  it("copes with characters that mean something in a pattern", () => {
    expect(markTerms("Use C++ (and .NET) here.", [term("C++"), term(".NET")])).toBe("Use [C++](#term-0) (and [.NET](#term-1)) here.");
  });

  it("is the same text when there is nothing to link", () => {
    expect(markTerms("Plain text.", [])).toBe("Plain text.");
    expect(markTerms("Plain text.", [term("")])).toBe("Plain text.");
    expect(markTerms("Plain text.", [term("missing")])).toBe("Plain text.");
  });
});

describe("termIndexOf", () => {
  it("reads the number of a term link and nothing else", () => {
    expect(termIndexOf("#term-3")).toBe(3);
    expect(termIndexOf("#term-0")).toBe(0);
    expect(termIndexOf("#term-x")).toBeNull();
    expect(termIndexOf("https://x.example")).toBeNull();
    expect(termIndexOf(undefined)).toBeNull();
  });
});

describe("pagesText", () => {
  it("says which pages", () => {
    expect(pagesText([], englishT)).toBe("");
    expect(pagesText([2], englishT)).toBe("page 2");
    expect(pagesText([1, 3, 6], englishT)).toBe("pages 1, 3, 6");
  });
});
