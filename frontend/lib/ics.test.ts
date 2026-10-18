import { describe, expect, it } from "vitest";
import type { FoundDate } from "./dates";
import { buildIcs, escapeText, foldLine, icsFileName } from "./ics";

const lease: FoundDate = {
  what: "Lease ends",
  date: "2027-02-28",
  repeat: "none",
  relative: "",
  quote: "The lease ends on 28 February 2027.",
  page: null,
  verified: true,
  reason: "",
};
const now = new Date(Date.UTC(2026, 9, 18, 12, 0, 0));
const options = { documentTitle: "Lease, v1", documentId: 7, now };

describe("escapeText", () => {
  it("escapes what the format reserves", () => {
    expect(escapeText("a, b; c\\d\ne")).toBe("a\\, b\\; c\\\\d\\ne");
  });
});

describe("foldLine", () => {
  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("cuts a long line at 75 bytes and continues after a space", () => {
    const folded = foldLine(`DESCRIPTION:${"x".repeat(200)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toHaveLength(75);
    expect(lines.slice(1).every((l) => l.startsWith(" ") && l.length <= 75)).toBe(true);
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(`DESCRIPTION:${"x".repeat(200)}`);
  });

  it("never splits a character", () => {
    const text = `SUMMARY:${"é".repeat(60)}${"日".repeat(30)}`;
    const folded = foldLine(text);
    const bytes = (s: string) => new TextEncoder().encode(s).length;
    expect(folded.split("\r\n").every((l) => bytes(l) <= 75)).toBe(true);
    expect(folded.split("\r\n").map((l, i) => (i === 0 ? l : l.slice(1))).join("")).toBe(text);
  });
});

describe("buildIcs", () => {
  it("makes a calendar with an all-day event for each date that is ready", () => {
    const ics = buildIcs([lease, { ...lease, what: "Unsure", verified: false }, { ...lease, what: "Waits", date: null, relative: "within 30 days" }], options);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("DTSTART;VALUE=DATE:20270228");
    expect(ics).toContain("DTEND;VALUE=DATE:20270301");
    expect(ics).toContain("DTSTAMP:20261018T120000Z");
    expect(ics).toContain("SUMMARY:Lease ends");
    expect(ics).toContain("The lease ends on 28 February 2027.");
    expect(ics).toContain('From "Lease\\, v1":');
    expect(ics).not.toContain("Unsure");
    expect(ics).not.toContain("Waits");
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\n\r]/);
  });

  it("gives an event the same id each time, and different events different ids", () => {
    const uids = (text: string) => [...text.matchAll(/UID:(\S+)/g)].map((m) => m[1]);
    const other = { ...lease, what: "Rent", date: "2027-03-01" };
    const once = uids(buildIcs([lease, other], options));
    expect(once[0]).not.toBe(once[1]);
    expect(uids(buildIcs([lease, other], { ...options, now: new Date() }))).toEqual(once);
    expect(uids(buildIcs([lease], { ...options, documentId: 8 }))[0]).not.toBe(once[0]);
  });

  it("repeats an event the document says repeats", () => {
    expect(buildIcs([{ ...lease, repeat: "monthly" }], options)).toContain("RRULE:FREQ=MONTHLY");
    expect(buildIcs([{ ...lease, repeat: "yearly" }], options)).toContain("RRULE:FREQ=YEARLY");
    expect(buildIcs([{ ...lease, repeat: "weekly" }], options)).toContain("RRULE:FREQ=WEEKLY");
    expect(buildIcs([lease], options)).not.toContain("RRULE");
  });

  it("adds a reminder when asked", () => {
    expect(buildIcs([lease], options)).not.toContain("VALARM");
    expect(buildIcs([lease], { ...options, reminder: "1d" })).toContain("TRIGGER:-P1D");
    expect(buildIcs([lease], { ...options, reminder: "1w" })).toContain("TRIGGER:-P7D");
  });

  it("is a valid empty calendar when nothing is ready", () => {
    expect(buildIcs([], options)).not.toContain("VEVENT");
  });

  it("cannot be bent by a quote that holds line breaks or file keywords", () => {
    const sneaky = { ...lease, quote: "Ends.\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Pay me" };
    const ics = buildIcs([sneaky], options);
    // as lines of the file (a folded line continues after a space), there is one event and one summary
    expect(ics.match(/^BEGIN:VEVENT/gm)).toHaveLength(1);
    expect(ics.match(/^END:VEVENT/gm)).toHaveLength(1);
    expect(ics.match(/^SUMMARY:/gm)).toHaveLength(1);
  });
});

describe("icsFileName", () => {
  it("is the title, safe to save", () => {
    expect(icsFileName("Lease v1.pdf")).toBe("Lease-v1-dates.ics");
    expect(icsFileName("../../etc/passwd")).toBe("etc-passwd-dates.ics");
    expect(icsFileName("???")).toBe("dates-dates.ics");
    expect(icsFileName("Договор аренды")).toBe("Договор-аренды-dates.ics");
  });
});
