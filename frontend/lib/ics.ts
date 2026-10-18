import { calendarEntries, nextDay, parseDay, type DateRepeat, type FoundDate } from "./dates";

// A calendar file (iCalendar, .ics) that any calendar app opens: Google, Apple, Outlook and the rest. Every date is an
// all-day event, so no time zone can move it to another day. Nothing is sent anywhere: the file is made in the browser.

export type Reminder = "none" | "1d" | "1w";

const RRULES: Record<DateRepeat, string | null> = {
  none: null,
  weekly: "FREQ=WEEKLY",
  monthly: "FREQ=MONTHLY",
  yearly: "FREQ=YEARLY",
};

const TRIGGERS: Record<Exclude<Reminder, "none">, string> = { "1d": "-P1D", "1w": "-P7D" };

// Text in a calendar file: backslash, semicolon, comma and line breaks are written the way the format asks.
export function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Lines in a calendar file are at most 75 bytes; a longer one goes on in the next line, which starts with a space. The
// cut never splits a character.
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    // the first line has 75 bytes, the next ones 74 (their first is the space)
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

function compact(day: string): string {
  return day.replace(/-/g, "");
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// A short stable text for the id of an event, so adding the same file twice does not double the events.
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface IcsOptions {
  // The document the dates are from: named in each event, with the sentence it was read from.
  documentTitle: string;
  documentId: number;
  reminder?: Reminder;
  now?: Date;
}

// A calendar file with one event for each date that is ready for a calendar (the ones with a day, that checked out).
export function buildIcs(dates: FoundDate[], options: IcsOptions): string {
  const now = options.now ?? new Date();
  const reminder = options.reminder ?? "none";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Inkling//Dates//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const entry of calendarEntries(dates)) {
    if (!parseDay(entry.date)) continue;
    const uid = `${hash(`${options.documentId}|${entry.date}|${entry.what}`)}-${options.documentId}@inkling`;
    const description = [`From "${options.documentTitle}":`, entry.quote].filter(Boolean).join("\n");
    lines.push("BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp(now)}`);
    lines.push(`DTSTART;VALUE=DATE:${compact(entry.date)}`, `DTEND;VALUE=DATE:${compact(nextDay(entry.date))}`);
    lines.push(`SUMMARY:${escapeText(entry.what)}`, `DESCRIPTION:${escapeText(description)}`);
    const rule = RRULES[entry.repeat];
    if (rule) lines.push(`RRULE:${rule}`);
    if (reminder !== "none") {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(entry.what)}`, `TRIGGER:${TRIGGERS[reminder]}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// The name of the file to save: the document's title, without what a file name cannot hold.
export function icsFileName(title: string): string {
  const base = title
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "dates"}-dates.ics`;
}

// Offers the file for saving. (A browser opens it with the calendar app, or saves it, as the person has set it up.)
export function downloadIcs(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked later: some browsers have not started the download by the time click returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
