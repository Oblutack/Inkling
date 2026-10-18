// Dates and deadlines found in a document, as the API sends them.
export type DateRepeat = "none" | "weekly" | "monthly" | "yearly";

export interface FoundDate {
  what: string;
  // A calendar day (YYYY-MM-DD), or null when the document only says "within 30 days of moving out" or gives a day and month
  // without a year (then `relative` has the document's words).
  date: string | null;
  repeat: DateRepeat;
  relative: string;
  // The document's own sentence the date was read from, and its page when the document has pages.
  quote: string;
  page: number | null;
  // Whether the date was found in the sentence by a program, not only reported by the model.
  verified: boolean;
  reason: string;
}

export interface FoundDates {
  dates: FoundDate[];
  suspicious: boolean;
  cached: boolean;
}

// A date that can be put on a calendar: it has a day and that day checked out in the sentence.
export function onCalendar(d: FoundDate): d is FoundDate & { date: string } {
  return d.date !== null && d.verified;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

// The day as numbers, or null when the text is not a real calendar day.
export function parseDay(day: string): { year: number; month: number; day: number } | null {
  const m = ISO.exec(day);
  if (!m) return null;
  const [year, month, dom] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, dom));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== dom) return null;
  return { year, month, day: dom };
}

// The day after (YYYY-MM-DD): an all-day event ends on the day after it, in a calendar file.
export function nextDay(day: string): string {
  const parts = parseDay(day);
  if (!parts) return day;
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return next.toISOString().slice(0, 10);
}

// Whole days from `today` to `day` (negative when it has passed). Both are calendar days, so daylight saving cannot skew it.
export function daysUntil(day: string, today: string): number | null {
  const a = parseDay(day);
  const b = parseDay(today);
  if (!a || !b) return null;
  const ms = Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
  return Math.round(ms / 86_400_000);
}

// Today in the person's own time zone, as YYYY-MM-DD.
export function localToday(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// The locale to write days in: the language of the interface, with the region the browser is set to when it is the same
// language (so "en" is written the way a person in the UK or the US is used to).
export function dayLocale(language: string, browser: readonly string[] = []): string {
  const base = language.toLowerCase();
  const own = browser.find((l) => l.toLowerCase() === base || l.toLowerCase().startsWith(base + "-"));
  return own ?? language;
}

// A day written for reading in the person's language: "28 February 2027".
export function longDay(day: string, locale?: string): string {
  const parts = parseDay(day);
  if (!parts) return day;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// What is on a calendar, in order: dated ones first, soonest first.
export function calendarEntries(dates: FoundDate[]): Array<FoundDate & { date: string }> {
  return dates.filter(onCalendar).sort((a, b) => a.date.localeCompare(b.date) || a.what.localeCompare(b.what));
}
