// A Playwright reporter for GitHub Actions: each failed test becomes an error annotation (which can be read without logging in to
// GitHub, unlike the job's log), with the first lines of what went wrong. GitHub shows at most 10 annotations of a kind per step.
const strip = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
const escape = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export default class GithubErrors {
  constructor() {
    this.printed = 0;
  }
  printsToStdio() {
    return false;
  }
  onTestEnd(test, result) {
    if (result.status === "passed" || result.status === "skipped" || this.printed >= 10) return;
    this.printed += 1;
    const lines = strip(result.error?.message).split("\n").filter((line) => line.trim()).slice(0, 14);
    const title = `${test.parent.project()?.name ?? ""}: ${test.title}${result.retry ? ` (retry ${result.retry})` : ""}`;
    console.log(`::error title=${escape(title.slice(0, 120))}::${escape(lines.join("\n"))}`);
  }
}
