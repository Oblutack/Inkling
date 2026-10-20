import { defineConfig, devices } from "@playwright/test";

// The whole stack is started by the suite itself, on ports that don't clash with a development
// setup (3000/8080): a stub AI service (18081), the Go API (18080) and the production Next build (13000).
const FRONTEND = "http://localhost:13000";
const API = "http://localhost:18080";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: FRONTEND,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // CI installs Playwright's own Chromium; locally the installed Chrome is used.
    channel: process.env.CI ? undefined : "chrome",
    // A fake microphone that plays a test tone, already allowed, so recording from the browser can be tried for real.
    permissions: ["microphone"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  projects: [
    // Everything runs on a desktop, except the phone tests (e2e/mobile.spec.ts), which run twice: in WebKit (the engine of every
    // iPhone browser) with an iPhone's screen, and in Chromium with an Android phone's.
    { name: "desktop", testIgnore: /mobile\.spec\.ts/ },
    {
      name: "iphone",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["iPhone 15"], channel: undefined, permissions: [], launchOptions: {} },
    },
    {
      name: "pixel",
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices["Pixel 7"], channel: undefined },
    },
  ],
  webServer: [
    {
      command: "node e2e/support/stub-ai.mjs",
      url: "http://127.0.0.1:18081/healthz",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node e2e/support/run-api.mjs",
      url: `${API}/readyz`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: "pnpm build && pnpm start -p 13000",
      url: `${FRONTEND}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        NEXT_PUBLIC_API_URL: API,
        NEXT_PUBLIC_GOOGLE_CLIENT_ID: "e2e-test-client",
        // A separate build directory, so a running `pnpm dev` is never disturbed.
        NEXT_DIST_DIR: ".next-e2e",
      },
    },
  ],
});
