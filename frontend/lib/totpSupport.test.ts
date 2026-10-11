import { describe, expect, it } from "vitest";
import { totpCode } from "../e2e/support/totp";

// The browser tests play the authenticator app with this code, so it is checked against the standards' own examples:
// RFC 6238 appendix B (SHA-1, shown with the last six digits) for the secret "12345678901234567890".
describe("the code the browser tests use for the authenticator app", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("is the code the standard gives at these times", () => {
    expect(totpCode(secret, 0, 59_000)).toBe("287082");
    expect(totpCode(secret, 0, 1_111_111_109_000)).toBe("081804");
    expect(totpCode(secret, 0, 1_234_567_890_000)).toBe("005924");
    expect(totpCode(secret, 0, 2_000_000_000_000)).toBe("279037");
  });

  it("changes every 30 seconds, and can be asked for a step ahead", () => {
    expect(totpCode(secret, 0, 29_999)).toBe(totpCode(secret, 0, 0));
    expect(totpCode(secret, 0, 30_000)).not.toBe(totpCode(secret, 0, 29_999));
    expect(totpCode(secret, 1, 59_000)).toBe(totpCode(secret, 0, 89_000));
  });

  it("reads the key as it is shown to people, in groups of four and any case", () => {
    expect(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", 0, 59_000)).toBe("287082");
  });
});
