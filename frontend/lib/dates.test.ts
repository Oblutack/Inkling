import { describe, expect, it } from "vitest";
import { calendarEntries, dayLocale, daysUntil, localToday, longDay, nextDay, onCalendar, parseDay, type FoundDate } from "./dates";

const base: FoundDate = { what: "Lease ends", date: "2027-02-28", repeat: "none", relative: "", quote: "It ends.", page: null, verified: true, reason: "" };

describe("parseDay", () => {
  it("reads real calendar days only", () => {
    expect(parseDay("2027-02-28")).toEqual({ year: 2027, month: 2, day: 28 });
    expect(parseDay("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseDay("2027-02-29")).toBeNull();
    expect(parseDay("2027-13-01")).toBeNull();
    expect(parseDay("28 February 2027")).toBeNull();
  });
});

describe("nextDay", () => {
  it("goes over the end of a month and a year", () => {
    expect(nextDay("2027-02-28")).toBe("2027-03-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2027-12-31")).toBe("2028-01-01");
  });

  it("leaves what it cannot read", () => {
    expect(nextDay("soon")).toBe("soon");
  });
});

describe("daysUntil", () => {
  it("counts calendar days, ahead and behind", () => {
    expect(daysUntil("2027-03-01", "2027-02-28")).toBe(1);
    expect(daysUntil("2027-02-28", "2027-02-28")).toBe(0);
    expect(daysUntil("2027-02-20", "2027-02-28")).toBe(-8);
  });

  it("is not thrown by the clocks changing", () => {
    expect(daysUntil("2027-03-29", "2027-03-27")).toBe(2);
    expect(daysUntil("2027-10-31", "2027-10-30")).toBe(1);
  });

  it("is null for what is not a day", () => {
    expect(daysUntil("x", "2027-02-28")).toBeNull();
  });
});

describe("localToday", () => {
  it("is the day on the person's own clock", () => {
    expect(localToday(new Date(2027, 0, 5, 23, 59))).toBe("2027-01-05");
    expect(localToday(new Date(2027, 11, 31, 0, 1))).toBe("2027-12-31");
  });
});

describe("dayLocale", () => {
  it("keeps the region of the browser when it speaks the interface language", () => {
    expect(dayLocale("en", ["en-GB", "de"])).toBe("en-GB");
    expect(dayLocale("de", ["en-US", "de-AT"])).toBe("de-AT");
  });

  it("otherwise uses the interface language", () => {
    expect(dayLocale("fr", ["en-US"])).toBe("fr");
    expect(dayLocale("bs", [])).toBe("bs");
  });
});

describe("longDay", () => {
  it("writes the day out in the language asked for", () => {
    expect(longDay("2027-02-28", "en-GB")).toBe("28 February 2027");
    expect(longDay("2027-02-28", "de-DE")).toBe("28. Februar 2027");
  });

  it("does not move to another day in any time zone", () => {
    expect(longDay("2027-01-01", "en-GB")).toBe("1 January 2027");
  });
});

describe("what is ready for a calendar", () => {
  it("needs a day that checked out", () => {
    expect(onCalendar(base)).toBe(true);
    expect(onCalendar({ ...base, verified: false })).toBe(false);
    expect(onCalendar({ ...base, date: null, relative: "within 30 days" })).toBe(false);
  });

  it("lists them soonest first", () => {
    const later = { ...base, what: "Later", date: "2027-06-01" };
    const sooner = { ...base, what: "Sooner", date: "2027-01-01" };
    const waiting = { ...base, what: "Waits", date: null, relative: "within 30 days" };
    expect(calendarEntries([later, waiting, sooner]).map((d) => d.what)).toEqual(["Sooner", "Later"]);
  });
});
