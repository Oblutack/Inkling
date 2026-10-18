import { toPlainText } from "./markdownText";
import { hostOf } from "./watch";

// The reading list: pages and texts saved to read later, each with a short summary made when it was saved.
export type ReadingState = "unread" | "read" | "archived";

export interface ReadingItem {
  // The id of the document behind the item.
  id: number;
  title: string;
  summary: string;
  // The page it came from, or "" for a pasted text.
  url: string;
  savedAt: string;
  readAt: string | null;
  archivedAt: string | null;
}

export interface ReadingCounts {
  unread: number;
  read: number;
  archived: number;
}

export interface ReadingList {
  items: ReadingItem[];
  counts: ReadingCounts;
}

export const STATES: readonly ReadingState[] = ["unread", "read", "archived"];

// The summary as plain words on one line or a few, for showing under a title: no Markdown marks.
export function summaryText(summary: string): string {
  return toPlainText(summary).replace(/\s*\n\s*/g, " ").trim();
}

// Where an item is from, for showing next to its title: the site, or nothing for a pasted text.
export function sourceOf(item: ReadingItem): string {
  return item.url ? hostOf(item.url) : "";
}

// Whether a link may be put in a page as a link: only web addresses (a saved address is checked by the server, this is the
// second lock).
export function safeLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

// What a person typed or pasted into the "save for later" box, as the server wants it: a lone web address is an address.
export function savePayload(input: string): { url: string } | { text: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/\s/.test(trimmed) && safeLink(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) && /[.]/.test(trimmed)) {
    return { url: /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}` };
  }
  return { text: trimmed };
}
