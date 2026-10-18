// Builds and runs the Go API for the end-to-end tests, writing its log to e2e/.tmp/api.log so the
// tests can read the "emailed" links (MAIL_PROVIDER=log prints them there).
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, "..", "..", "..", "go-api");
const tmpDir = join(here, "..", ".tmp");
mkdirSync(tmpDir, { recursive: true });

const bin = join(tmpDir, process.platform === "win32" ? "api.exe" : "api");
execFileSync("go", ["build", "-o", bin, "."], { cwd: apiDir, stdio: "inherit" });

// CI provides E2E_DSN. Locally, reuse the docker compose database with a separate "summarizer_e2e"
// database so the tests never touch development data.
function localDsn() {
  const envFile = join(here, "..", "..", "..", ".env");
  const password = existsSync(envFile)
    ? (readFileSync(envFile, "utf8").match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1] ?? "").trim()
    : "";
  try {
    execFileSync(
      "docker",
      ["exec", "summarizer-db", "psql", "-U", "user", "-d", "postgres", "-c", "CREATE DATABASE summarizer_e2e"],
      { stdio: "ignore" }
    );
  } catch {
    // Already exists, or docker is not available: the connection below reports any real problem.
  }
  return `host=localhost port=5433 user=user password=${password} dbname=summarizer_e2e sslmode=disable`;
}

const log = createWriteStream(join(tmpDir, "api.log"), { flags: "w" });
const child = spawn(bin, [], {
  cwd: apiDir,
  env: {
    ...process.env,
    DSN: process.env.E2E_DSN ?? localDsn(),
    PORT: "18080",
    AI_SERVICE_URL: "http://127.0.0.1:18081",
    GOOGLE_CLIENT_ID: "e2e-test-client",
    CORS_ALLOWED_ORIGINS: "http://localhost:13000",
    FRONTEND_URL: "http://localhost:13000",
    COOKIE_SECURE: "false",
    COOKIE_SAMESITE: "lax",
    MAIL_PROVIDER: "log",
    REQUIRE_EMAIL_VERIFICATION: "false",
    // A watched page may be checked again at once, so the tests can see a change without waiting ten minutes.
    WATCH_CHECK_NOW_MINUTES: "0",
    TURNSTILE_SECRET: "",
    // Two-step sign-in needs a key for its secrets (32 bytes, base64); this one is only for the tests.
    TOTP_ENCRYPTION_KEY: Buffer.from("e2e-key-e2e-key-e2e-key-e2e-key!").toString("base64"),
    QUOTA_SUMMARIES_PER_DAY: "50",
    QUOTA_CHAT_PER_DAY: "200",
    // The spending guard is on, with room for the whole suite (every test visits from the same address).
    ANON_SUMMARIES_PER_DAY: "1000",
    AI_REQUESTS_PER_DAY: "100000",
    // Every test signs up and logs in from the same address; lift the per-IP limits for the suite.
    RATE_LIMIT_MULTIPLIER: "100",
    LOG_FORMAT: "json",
    GIN_MODE: "release",
  },
});
child.stdout.pipe(log);
child.stderr.pipe(log);
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill());
