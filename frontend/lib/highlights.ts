// Highlights and notes in the original PDF: a passage the person marked on a page, with a note they wrote about it.
export interface Highlight {
  id: number;
  // The stored original it was marked in (null for one that was made without a file).
  fileId: number | null;
  page: number;
  quote: string;
  note: string;
  createdAt: string;
}

// The shortest and longest passage that can be highlighted (the same as the server takes).
export const MIN_QUOTE = 2;
export const MAX_QUOTE = 1000;
export const MAX_NOTE = 2000;

// Selected words as the one line that is kept: runs of spaces and line breaks become one space.
export function quoteFrom(selected: string): string {
  return selected.replace(/\s+/g, " ").trim();
}

// Whether a selection is worth offering to highlight.
export function canHighlight(quote: string): boolean {
  return quote.length >= MIN_QUOTE && quote.length <= MAX_QUOTE;
}

// A passage shortened for a list: the start of it, with "…" when there is more.
export function shortQuote(quote: string, max = 120): string {
  const text = quoteFrom(quote);
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

// The highlights of a page, in the order they were made.
export function onPage(highlights: readonly Highlight[], page: number): Highlight[] {
  return highlights.filter((h) => h.page === page).sort((a, b) => a.id - b.id);
}

// The highlights that belong to a file of the document (one made without a file belongs to every file).
export function forFile(highlights: readonly Highlight[], fileId: number): Highlight[] {
  return highlights.filter((h) => h.fileId === null || h.fileId === fileId);
}

// By page, then in the order made: how they are listed on the document.
export function inPageOrder(highlights: readonly Highlight[]): Highlight[] {
  return [...highlights].sort((a, b) => a.page - b.page || a.id - b.id);
}
