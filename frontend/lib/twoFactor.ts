// Small helpers for two-step sign-in (an authenticator app). Nothing here talks to the server.

// What was typed as a code from the app, as plain digits ("123 456", "123-456" and "123456" are the same code).
export function cleanCode(input: string): string {
  return input.replace(/[\s -]/g, "");
}

// Whether it is six digits, which is all the server accepts as a code from the app.
export function looksLikeAppCode(input: string): boolean {
  return /^\d{6}$/.test(cleanCode(input));
}

// The text of the file offered for download, so the recovery codes can be kept outside the browser.
export function recoveryFileText(email: string, codes: string[], when = new Date()): string {
  return [
    "Inkling recovery codes",
    `Account: ${email}`,
    `Made on: ${when.toISOString().slice(0, 10)}`,
    "",
    "Each code works once, if you cannot use your authenticator app. Keep this file somewhere safe.",
    "",
    ...codes,
    "",
  ].join("\n");
}

export const RECOVERY_FILE_NAME = "inkling-recovery-codes.txt";
