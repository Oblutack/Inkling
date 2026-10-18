import { describe, expect, it } from "vitest";
import { everyLabelKey, everyOptions, hostOf } from "./watch";

describe("everyOptions", () => {
  it("offers the usual choices the server allows", () => {
    expect(everyOptions(24, 12)).toEqual([12, 24, 72, 168]);
    expect(everyOptions(72, 24)).toEqual([24, 72, 168]);
  });

  it("keeps the current choice even when it is not a usual one, in order", () => {
    expect(everyOptions(48, 12)).toEqual([12, 24, 48, 72, 168]);
    expect(everyOptions(500, 12)).toEqual([12, 24, 72, 168, 500]);
  });
});

describe("everyLabelKey", () => {
  it("names the usual choices only", () => {
    expect(everyLabelKey(24)).toBe("watch.every24");
    expect(everyLabelKey(168)).toBe("watch.every168");
    expect(everyLabelKey(48)).toBeNull();
  });
});

describe("hostOf", () => {
  it("is the site without www", () => {
    expect(hostOf("https://www.news.example/terms?x=1")).toBe("news.example");
    expect(hostOf("http://docs.example.org:8080/a")).toBe("docs.example.org");
  });

  it("falls back to what it was given", () => {
    expect(hostOf("not an address")).toBe("not an address");
  });
});
