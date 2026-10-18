import { en } from "./i18n/en";
import type { MessageKey, Translate } from "./i18n";

// A contract checked against a list of things worth looking for: each item found (with the document's own quote and page),
// unclear (said, but not confirmable), or not found. This is a reading aid, not legal advice.
export type ChecklistKind = "lease" | "job_offer" | "freelance" | "nda" | "purchase";

export const KINDS: readonly ChecklistKind[] = ["lease", "job_offer", "freelance", "nda", "purchase"];

export type ItemStatus = "found" | "unclear" | "missing";

export interface ChecklistItem {
  id: string;
  status: ItemStatus;
  value: string;
  quote: string;
  page: number | null;
  reason: string;
}

export interface UnusualClause {
  what: string;
  quote: string;
  page: number | null;
}

export interface ChecklistResult {
  kind: ChecklistKind;
  items: ChecklistItem[];
  counts: Record<ItemStatus, number>;
  unusual: UnusualClause[];
  // False when looking for unusual clauses failed (the items are fine).
  unusualChecked: boolean;
  suspicious: boolean;
  foundAt: string;
  cached: boolean;
}

export function kindLabelKey(kind: ChecklistKind): MessageKey {
  return `checklist.kind.${kind}` as MessageKey;
}

// The name of an item in the person's language; one the web app does not know yet is shown from its id ("early_end" -> "Early end").
export function itemLabel(kind: string, id: string, t: Translate): string {
  const key = `checklist.item.${kind}.${id}`;
  if (key in en) return t(key as MessageKey);
  const words = id.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The items in the order they are worth reading: what is not there first (often the most useful), then what is unclear,
// then what was found. Each group keeps the order of the checklist.
export function groupItems(items: readonly ChecklistItem[]): Record<ItemStatus, ChecklistItem[]> {
  return {
    missing: items.filter((i) => i.status === "missing"),
    unclear: items.filter((i) => i.status === "unclear"),
    found: items.filter((i) => i.status === "found"),
  };
}

export const GROUP_ORDER: readonly ItemStatus[] = ["missing", "unclear", "found"];

// What marks each status: a shape as well as words, so colour is never all there is.
export const STATUS_MARK: Record<ItemStatus, string> = { found: "✓", unclear: "?", missing: "✗" };
