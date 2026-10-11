import { describe, expect, it } from "vitest";
import { cleanCode, looksLikeAppCode, recoveryFileText } from "./twoFactor";

describe("a code from the app", () => {
  it("is six digits, however they were grouped", () => {
    for (const typed of ["123456", " 123 456 ", "123-456", "123 456"]) {
      expect(looksLikeAppCode(typed)).toBe(true);
      expect(cleanCode(typed)).toBe("123456");
    }
  });

  it("is nothing else", () => {
    for (const typed of ["", "12345", "1234567", "12345a", "abcdef", "k3m9x-h2q7a"]) {
      expect(looksLikeAppCode(typed)).toBe(false);
    }
  });
});

describe("the recovery file", () => {
  it("holds the codes and says what they are for", () => {
    const text = recoveryFileText("me@example.com", ["k3m9x-h2q7a", "p4n8r-w6t2c"], new Date("2026-10-11T10:00:00Z"));
    expect(text).toContain("Account: me@example.com");
    expect(text).toContain("Made on: 2026-10-11");
    expect(text).toContain("k3m9x-h2q7a\np4n8r-w6t2c");
    expect(text).toContain("works once");
  });
});
