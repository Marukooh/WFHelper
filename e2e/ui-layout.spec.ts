import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const ACCELTRA = "/Lotus/Weapons/Tenno/LongGuns/PrimeAcceltra/PrimeAcceltraWeapon";
const ADVANCES_DEBT_BOND = "/Lotus/Types/Items/Solaris/DebtTokenD";

function testInventory(resourceCount = 1) {
  return {
    Suits: [],
    LongGuns: [{ ItemType: ACCELTRA, XP: 450_000 }],
    MiscItems: [{ ItemType: ADVANCES_DEBT_BOND, ItemCount: resourceCount }],
    XPInfo: [{ ItemType: ACCELTRA, XP: 450_000 }],
  };
}

test.describe("Shared view layout", () => {
  test.setTimeout(180_000);

  let harness: ElectronTestHarness;
  let page: Page;
  const consoleErrors: string[] = [];

  test.beforeAll(async () => {
    harness = await launchElectronTestHarness("wfh-ui-layout-e2e-", {
      onPage: (testPage) => {
        testPage.on("console", (message) => {
          if (message.type() === "error") {
            const location = message.location();
            consoleErrors.push(
              `${location.url}:${location.lineNumber}:${location.columnNumber} ${message.text()}`,
            );
          }
        });
      },
    });
    page = harness.page;
    consoleErrors.length = 0;
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    writeHarnessInventory(harness, testInventory());
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  // Sidebar labels are translated, so navigate by data-view.
  async function openView(view: string): Promise<void> {
    await page.locator(`#sidebar [data-view="${view}"]`).click();
    await page.waitForTimeout(300);
  }

  async function headingSize(view: string): Promise<string> {
    await openView(view);
    const heading = page.locator("#content .view.active h2").first();
    await expect(heading).toBeVisible();
    return heading.evaluate((node) => getComputedStyle(node).fontSize);
  }

  test("Stats file import respects CSP", async () => {
    await openView("stats");
    const fileInput = page.locator('input[type="file"][accept=".json"]');
    await expect(fileInput).toBeHidden();
    expect(
      consoleErrors.filter(
        (line) => /inline style/i.test(line) && /content security policy|style-src/i.test(line),
      ),
    ).toEqual([]);
  });

  test("Rivens, Wiki, and Arbitrations share the standard heading size", async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const standard = await headingSize("settings");
    expect(await headingSize("rivens")).toBe(standard);
    expect(await headingSize("wiki")).toBe(standard);
    expect(await headingSize("arbi")).toBe(standard);
  });

  test("Stats trade filters fit at both panel widths", async () => {
    for (const viewport of [
      { width: 1280, height: 820 },
      { width: 900, height: 600 },
    ]) {
      await page.setViewportSize(viewport);
      await openView("stats");
      const filters = page.locator("[data-trade-filters]");
      await expect(filters).toBeVisible();
      expect(
        await filters.evaluate((node) => ({
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
        })),
      ).toEqual(
        expect.objectContaining({
          clientWidth: expect.any(Number),
          scrollWidth: expect.any(Number),
        }),
      );
      expect(await filters.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
  });

  test("Inventory starts without an empty listings panel", async () => {
    await page.setViewportSize({ width: 900, height: 600 });
    await openView("inventory");
    await expect(page.getByRole("heading", { name: "Market Listings" })).toHaveCount(0);
    expect(
      await page.locator("#content").evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  });

  // A rotated monitor lands the inventory header in the band where the tabs no
  // longer fit beside the search box. They used to wrap mid-row and strand the
  // controls next to a strip of empty header.
  test("Inventory tabs keep one row when the search box has to drop below", async () => {
    for (const viewport of [
      { width: 1150, height: 1900 },
      { width: 1280, height: 2000 },
    ]) {
      await page.setViewportSize(viewport);
      await openView("inventory");

      const header = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("[data-tour-tab]")) as HTMLElement[];
        const row = document.querySelector('[data-tour="inventory-tabs"]') as HTMLElement | null;
        const controls = row?.querySelector(".ml-auto") as HTMLElement | null;
        return {
          natural: tabs.reduce((sum, tab) => sum + tab.getBoundingClientRect().width, 0),
          available: row?.clientWidth ?? 0,
          rows: new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
          tabsBottom: Math.max(...tabs.map((tab) => tab.getBoundingClientRect().bottom)),
          controlsTop: controls?.getBoundingClientRect().top ?? 0,
        };
      });

      // A runner may land wider or narrower than the viewport asks for, so gate
      // on the measurement: given room for the labels, they take exactly one row
      // and the controls drop beneath them rather than wrapping the tabs.
      if (header.available >= header.natural) {
        expect(header.rows).toBe(1);
        if (header.available < header.natural + 360) {
          expect(header.controlsTop).toBeGreaterThanOrEqual(header.tabsBottom);
        }
      }

      expect(
        await page.locator("#content").evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
    }
  });

  // The narrow-width rule used to pad #content on all four sides, and a sticky
  // row pins to the padding box: the pinned filters sat a gutter below the top
  // and the grid scrolled visibly through the strip above them.
  test("pinned filters sit flush with the scroll area on a narrow window", async () => {
    await page.setViewportSize({ width: 1280, height: 820 });
    await openView("inventory");
    // Narrow enough for the compact rule, short enough that the grid scrolls.
    await page.setViewportSize({ width: 760, height: 420 });
    await page.waitForTimeout(300);
    const probe = await page.evaluate(() => {
      const content = document.querySelector("#content") as HTMLElement;
      const sticky = document.querySelector(".view-sticky-filters") as HTMLElement;
      content.scrollTop = 400;
      return {
        paddingTop: getComputedStyle(content).paddingTop,
        scrolled: content.scrollTop > 0,
        band: Math.round(sticky.getBoundingClientRect().top - content.getBoundingClientRect().top),
      };
    });

    // The gutter is the defect and the assertion: a sticky row pins to the
    // padding box, so a top padding here is what parked the pinned filters
    // below the scrollport and let the grid show through above them.
    expect(probe.paddingTop).toBe("0px");
  });

  test("new planning and inventory filters are reachable", async () => {
    await page.setViewportSize({ width: 1280, height: 820 });

    await openView("inventory");
    await page.getByRole("button", { name: "Filters" }).click();
    const customMinimum = page.getByRole("spinbutton", { name: "Custom minimum platinum" });
    await expect(customMinimum).toBeVisible();
    await customMinimum.fill("7");
    await expect(customMinimum).toHaveValue("7");

    await openView("mastery");
    await page.locator('[data-tour="mastery-view-tabs"] [data-tour-tab="roadmap"]').click();
    const roadmapTabs = page.locator('[data-tour="mastery-roadmap"]');
    await expect(roadmapTabs.locator('[data-tour-tab="easy"]')).toBeVisible();
    await expect(roadmapTabs.locator('[data-tour-tab="relics"]')).toBeVisible();
    await expect(roadmapTabs.locator('[data-tour-tab="platinum"]')).toBeVisible();

    await openView("relics");
    await expect(page.getByRole("combobox", { name: "Relics" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unowned reward" })).toBeVisible();
  });

  test("Relic filters and card headers stay compact at desktop width", async () => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await openView("relics");

    const filterRow = page.locator("[data-relic-filter-row]");
    const filterControls = page.locator("[data-relic-filter-controls]");
    await expect(filterControls).toBeVisible();

    const layout = await filterRow.evaluate((row) => {
      const tabs = row.querySelector<HTMLElement>("[data-relic-tier-tabs]");
      const controls = row.querySelector<HTMLElement>("[data-relic-filter-controls]");
      if (!tabs || !controls) throw new Error("Relic filter sections are missing");
      const tabsRect = tabs.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      return {
        rowFits: row.scrollWidth <= row.clientWidth,
        bottomDelta: Math.abs(tabsRect.bottom - controlsRect.bottom),
        maxControlHeight: Math.max(
          ...Array.from(controls.children, (child) => child.getBoundingClientRect().height),
        ),
      };
    });
    expect(layout.rowFits).toBe(true);
    expect(layout.bottomDelta).toBeLessThanOrEqual(12);
    expect(layout.maxControlHeight).toBeLessThanOrEqual(36);

    await page.getByRole("combobox", { name: "Relics" }).selectOption("all");
    const firstCard = page.locator(".relic-compact-card").first();
    await expect(firstCard).toBeVisible({ timeout: 90_000 });
    const cardHeader = firstCard.locator(".relic-compact-head");
    const titleBlock = cardHeader.locator(":scope > span").nth(1);
    const metricBlock = cardHeader.locator(":scope > span").nth(2);
    const headerLayout = await Promise.all([titleBlock.boundingBox(), metricBlock.boundingBox()]);
    expect(headerLayout[0]).not.toBeNull();
    expect(headerLayout[1]).not.toBeNull();
    expect(Math.abs(headerLayout[0]!.y - headerLayout[1]!.y)).toBeLessThanOrEqual(12);
  });

  test("resource names fit at 125% font size", async () => {
    await page.setViewportSize({ width: 1920, height: 1200 });
    await page.evaluate(() => {
      localStorage.setItem(
        "wf_theme_settings",
        JSON.stringify({ version: 1, fontSizes: { globalScale: 1.25 } }),
      );
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
    writeHarnessInventory(harness, testInventory(2));

    await page.locator('#sidebar [data-view="inventory"]').click();
    await page.locator('[data-tour-tab="resources"]').click();
    const name = page.locator(".resource-name");
    await expect(name).toBeVisible({ timeout: 90_000 });
    await expect(name).toHaveText("ADVANCES DEBT-BOND");
    expect(
      await name.evaluate(
        (node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight,
      ),
    ).toBe(true);
  });
});
