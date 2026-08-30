import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { type ElectronTestHarness, launchElectronTestHarness } from "./electronTestHarness";

const SEEDED = [
  {
    id: "seed-1",
    at: "2026-08-30T09:00:00.000Z",
    kind: "world",
    title: "Cetus",
    body: "Night begins in 5 minutes",
  },
  {
    id: "seed-2",
    at: "2026-08-30T10:00:00.000Z",
    kind: "trade",
    title: "Listing Closed",
    body: "Ash Prime Chassis 45p with Buyer",
  },
];

let harness: ElectronTestHarness;

test.beforeAll(async () => {
  // Stored oldest-first, the order main persists them in.
  harness = await launchElectronTestHarness("wfhelper-notifications-", {
    userDataFiles: { "notification-log.json": SEEDED },
  });
});

test.afterAll(async () => {
  await harness?.app.close();
  fs.rmSync(harness.sandboxDir, { recursive: true, force: true });
});

test("the status bar bell opens the stored notification history", async () => {
  const { page } = harness;
  const bell = page.locator("[data-notification-open]");

  await expect(bell).toBeVisible();
  await expect(bell.locator(".bell-count")).toHaveText("2");

  await bell.click();

  const entries = page.locator("[data-notification-entry]");
  await expect(entries).toHaveCount(2);
  // Newest first.
  await expect(entries.first()).toContainText("Listing Closed");
  await expect(entries.first()).toHaveAttribute("data-notification-kind", "trade");
  await expect(entries.last()).toContainText("Cetus");

  await page
    .locator("[data-notification-history]")
    .screenshot({ path: path.join("test-results", "notification-history.png") });
});

test("clearing empties the list and the badge", async () => {
  const { page } = harness;

  await page.locator("[data-notification-clear]").click();

  await expect(page.locator("[data-notification-empty]")).toBeVisible();
  await expect(page.locator("[data-notification-entry]")).toHaveCount(0);
  await expect(page.locator(".bell-count")).toHaveCount(0);
});

test("the settings test button records a notification", async () => {
  const { page } = harness;

  // The previous test left the history modal open over the sidebar.
  await page.locator("[data-notification-close]").click();
  await expect(page.locator("[data-notification-history]")).toHaveCount(0);

  await page.locator('#sidebar [data-view="settings"]').click();
  // Dev-only button; the sandbox runs unpackaged, so it appears once the runtime
  // info resolves.
  await page.locator("[data-test-notification]").click();

  const bell = page.locator("[data-notification-open]");
  await expect(bell.locator(".bell-count")).toHaveText("1");

  await bell.click();
  await expect(page.locator("[data-notification-entry]")).toHaveCount(1);
  await expect(page.locator("[data-notification-entry]").first()).toContainText(
    "Test notification",
  );
});
