import { webLinkIn } from "./links";

// What a phone (or another app) hands to Inkling from its Share menu: a title, some text, an address, and files. Apps are not
// consistent: one puts the page's address in `url`, another puts "Title https://address" in `text`, another puts only the
// address in `text`. This turns what came into what to put in the input box.

export interface SharedItem {
  title?: string;
  text?: string;
  url?: string;
}

export type SharedContent =
  | { kind: "files" }
  | { kind: "link"; link: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };

const ANY_LINK = /https?:\/\/[^\s<>"']+/i;

// A link at the end of a sentence is not part of the address ("see https://a.example/x.").
function trimmedLink(raw: string): string {
  return raw.replace(/[.,;:!?)\]}'"]+$/, "");
}

export function interpretShare(item: SharedItem, fileCount: number): SharedContent {
  if (fileCount > 0) return { kind: "files" };

  const title = (item.title ?? "").trim();
  const text = (item.text ?? "").trim();
  const url = (item.url ?? "").trim();

  // The address, when the app says which it is.
  const direct = webLinkIn(url);
  if (direct) return { kind: "link", link: direct };

  // Only an address in the text.
  const alone = webLinkIn(text);
  if (alone) return { kind: "link", link: alone };

  // A short note with an address in it ("Great read https://...", or the page's title and its address): the address is
  // what was meant. A long text that happens to mention an address is a text.
  const found = ANY_LINK.exec(text);
  if (found) {
    const link = trimmedLink(found[0]);
    const rest = text.replace(found[0], "").trim();
    if (webLinkIn(link) && rest.length <= 200 && rest.split(/\s+/).filter(Boolean).length <= 30) return { kind: "link", link };
  }

  const combined = [title && title !== text ? title : "", text].filter(Boolean).join("\n\n");
  if (combined) return { kind: "text", text: combined };
  return { kind: "empty" };
}
