import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";
const realBackend = process.env.PLAYWRIGHT_REAL_BACKEND === "1";
if (realBackend && !process.env.E2E_PASSWORD?.trim()) {
  throw new Error(
    "PLAYWRIGHT_REAL_BACKEND=1 requires E2E_PASSWORD from the environment; no reusable E2E password is stored in source.",
  );
}
const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT ?? "8000";
const backendURL = process.env.PLAYWRIGHT_BACKEND_URL ?? `http://127.0.0.1:${backendPort}`;
const externalBackend = Boolean(process.env.PLAYWRIGHT_BACKEND_URL);

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: realBackend ? /auth\.spec\.ts/ : /real-backend\.spec\.ts/,
  fullyParallel: !realBackend,
  workers: realBackend ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : realBackend
      ? [
          ...(!externalBackend ? [{
            command: "node scripts/start-e2e-backend.mjs",
            url: `${backendURL}/api/health`,
            reuseExistingServer: false,
            timeout: 120_000,
          }] : []),
          {
            command: "npm run dev -- --host 127.0.0.1",
            url: baseURL,
            reuseExistingServer: false,
            env: {
              ...process.env,
              VITE_API_PROXY_TARGET: backendURL,
            },
          },
        ]
      : {
          command: "npm run dev -- --host 127.0.0.1",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
        },
});
