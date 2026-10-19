import type { Translate } from "./i18n";

// The glossary of a document: specialist terms with a plain explanation of each and the pages they are on. A term that is in the
// summary is underlined there, with its explanation on hover and focus.
export interface GlossaryTerm {
  term: string;
  explanation: string;
  // The pages of the document it appears on (none for a text with no pages).
  pages: number[];
}

export interface Glossary {
  terms: GlossaryTerm[];
  suspicious: boolean;
  foundAt?: string;
  cached?: boolean;
}

// Where a term in the summary points to in the glossary: "#term-3" (the number is its place in the list).
export const TERM_PREFIX = "#term-";

export function termIndexOf(href: string | undefined): number | null {
  if (!href || !href.startsWith(TERM_PREFIX)) return null;
  const n = Number(href.slice(TERM_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A summary's Markdown with the first place of each term turned into a link to it ("[escrow](#term-0)"). Headings, code and
// existing links are left alone, longer terms win over shorter ones inside them, and a term is only found as a whole word.
export function markTerms(markdown: string, terms: readonly GlossaryTerm[]): string {
  const wanted = terms
    .map((t, index) => ({ text: t.term.trim(), index }))
    .filter((t) => t.text.length >= 2)
    .sort((a, b) => b.text.length - a.text.length);
  if (wanted.length === 0) return markdown;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(${wanted.map((t) => t.text.split(/\s+/).map(escapeRegex).join("\\s+")).join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  const indexOf = new Map(wanted.map((t) => [t.text.toLowerCase().replace(/\s+/g, " "), t.index]));
  const done = new Set<number>();

  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return line;
      // code and links stay as they are
      return line
        .split(/(`[^`]*`|\[[^\]]*\]\([^)]*\))/)
        .map((part, i) => {
          if (i % 2 === 1) return part;
          return part.replace(pattern, (found) => {
            const index = indexOf.get(found.toLowerCase().replace(/\s+/g, " "));
            if (index === undefined || done.has(index)) return found;
            done.add(index);
            return `[${found}](${TERM_PREFIX}${index})`;
          });
        })
        .join("");
    })
    .join("\n");
}

// "page 2", "pages 2 and 5", "pages 1, 3 and 6" for the pages a term is on.
export function pagesText(pages: readonly number[], t: Translate): string {
  if (pages.length === 0) return "";
  if (pages.length === 1) return t("glossary.page", { n: pages[0] });
  return t("glossary.pages", { list: pages.join(", ") });
}
