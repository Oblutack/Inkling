import { describe, expect, it } from "vitest";
import { safeLink, savePayload, sourceOf, summaryText, type ReadingItem } from "./reading";

const item = (url: string): ReadingItem => ({ id: 1, title: "T", summary: "S", url, savedAt: "2026-10-18T10:00:00Z", readAt: null, archivedAt: null });

describe("summaryText", () => {
  it("is plain words on one line, with no marks", () => {
    expect(summaryText("## Key points\n- **Rent** is due.\n- Deposit is 1,900 euros.")).toBe("Key points. Rent is due. Deposit is 1,900 euros.");
  });

  it("is empty for nothing", () => {
    expect(summaryText("")).toBe("");
  });
});

describe("sourceOf", () => {
  it("is the site, and nothing for a pasted text", () => {
    expect(sourceOf(item("https://www.blog.example/post/1"))).toBe("blog.example");
    expect(sourceOf(item(""))).toBe("");
  });
});

describe("safeLink", () => {
  it("lets web addresses through and nothing else", () => {
    expect(safeLink("https://blog.example/post")).toBe("https://blog.example/post");
    expect(safeLink("http://blog.example")).toBe("http://blog.example/");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("data:text/html,<b>x</b>")).toBeNull();
    expect(safeLink("not a link")).toBeNull();
  });
});

describe("savePayload", () => {
  it("takes a lone web address as an address", () => {
    expect(savePayload("https://blog.example/post")).toEqual({ url: "https://blog.example/post" });
    expect(savePayload("  blog.example/post  ")).toEqual({ url: "https://blog.example/post" });
  });

  it("takes anything else as a text", () => {
    expect(savePayload("Some thoughts worth keeping for later.")).toEqual({ text: "Some thoughts worth keeping for later." });
    expect(savePayload("see https://blog.example/post for more")).toEqual({ text: "see https://blog.example/post for more" });
    expect(savePayload("hello")).toEqual({ text: "hello" });
  });

  it("is nothing for nothing", () => {
    expect(savePayload("   ")).toBeNull();
  });

  it("does not turn a script address into a link", () => {
    expect(savePayload("javascript:alert(1)")).toEqual({ text: "javascript:alert(1)" });
  });
});
