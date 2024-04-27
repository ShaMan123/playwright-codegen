import type { PlaywrightTestConfig } from "@playwright/test";
import { devices } from "@playwright/test";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
const config: PlaywrightTestConfig = {
  testDir: "./tests",
  /* Maximum time one test can run for. */
  timeout: 30 * 1000,
  testMatch: "*.spec.ts",
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 1 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Do not update snapshot on CI */
  updateSnapshots: process.env.CI ? "none" : "missing",
  /* Configure snapshot names to be the same across platforms for CI */
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ["list"],
    ["html", { outputFolder: "./test-report", open: "on-failure" }],
    ["json", { outputFile: "./test-results/test-results.json" }],
  ],
  outputDir: "./test-results",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Maximum time each action such as `click()` can take. Defaults to 0 (no limit). */
    actionTimeout: 0,
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: "http://localhost:8000",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "retain-on-failure",
    video: process.env.CI ? "retain-on-failure" : "on",
    screenshot: process.env.CI ? "only-on-failure" : "on",
    viewport: { width: 900, height: 700 },
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        browserName: "chromium",
        launchOptions: { devtools: !process.env.CI },
      },
    },
  ],

  /* Run your local dev server before starting the tests */
  webServer: [
    {
      command: "npm run serve",
      port: 8000,
      reuseExistingServer: !process.env.CI,
    },
  ],
};

export default config;
