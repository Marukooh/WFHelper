import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  // Loaded CI runners can miss the Electron mount timeout; local runs do not retry.
  retries: process.env.CI ? 2 : 0,
  fullyParallel: false,
  // File-level only, so tests keep sharing their beforeAll app. CI stays serial:
  // its runners have four vCPUs and a flaky retry there fails the whole job.
  workers: process.env.CI ? 1 : 4,
  reporter: [["list"]],
});
