import type { Importance } from "./compare";
import type { MessageKey } from "./i18n";

// A page the person watches, as the API lists it.
export interface Watch {
  id: number;
  url: string;
  title: string;
  everyHours: number;
  paused: boolean;
  failures: number;
  lastError: string;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  createdAt: string;
  // How many changes are kept in the history, and the newest of them.
  changes: number;
  latest: { foundAt: string; bottomLine: string; topImportance: Importance | "" } | null;
}

export interface WatchList {
  watches: Watch[];
  // How many pages one person may watch, and the fewest hours between checks.
  limit: number;
  minHours: number;
}

// One kept change, without the changes themselves (they are fetched when it is opened).
export interface WatchChangeSummary {
  id: number;
  foundAt: string;
  title: string;
  bottomLine: string;
  topImportance: Importance | "";
  counts: Record<string, number>;
}

// What a check found (also what "check now" answers).
export interface CheckResult {
  status: "unchanged" | "identical" | "changed" | "waiting" | "failed";
  changes: number;
  important: number;
  message?: string;
}

// How often a page can be checked: the choices offered, in hours. (The API accepts any whole number of hours from the least
// allowed up to 30 days; these are the ones that are easy to choose between.)
export const EVERY_CHOICES = [12, 24, 72, 168] as const;

const EVERY_LABELS: Record<number, MessageKey> = {
  12: "watch.every12",
  24: "watch.every24",
  72: "watch.every72",
  168: "watch.every168",
};

// The text key for a number of hours, when it is one of the usual choices.
export function everyLabelKey(hours: number): MessageKey | null {
  return EVERY_LABELS[hours] ?? null;
}

// The choices that may be picked: the usual ones the server allows, and the current one if it is something else.
export function everyOptions(current: number, minHours: number): number[] {
  const choices: number[] = EVERY_CHOICES.filter((h) => h >= minHours);
  if (!choices.includes(current)) choices.push(current);
  return choices.sort((a, b) => a - b);
}

// The site a page is on, for showing next to its title ("news.example").
export function hostOf(address: string): string {
  try {
    return new URL(address).hostname.replace(/^www\./, "");
  } catch {
    return address;
  }
}
