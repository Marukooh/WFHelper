import fs from "node:fs";

import { test, expect, type Page } from "@playwright/test";

import {
  closeElectronTestHarness,
  launchElectronTestHarness,
  openView,
  writeHarnessInventory,
  type ElectronTestHarness,
} from "./electronTestHarness";

const SHOTS =
  process.env.LAYOUT_SHOTS ??
  "C:/Users/User/AppData/Local/Temp/claude/D--Github-wfhelper-public/925a51d2-d97e-4c8f-8e5a-a9d040b31dcc/scratchpad/layout-shots";

/**
 * Label beside control, both measured. A wrapped control shares no line with its
 * label, so `stacked` and `overlaps` are the two ways a row can end up.
 */
async function measureSettingsRows(page: Page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".settings-control-row"));
    const measured = rows
      .map((row) => {
        const kids = Array.from(row.children) as HTMLElement[];
        if (kids.length < 2) return null;
        const label = kids[0]!.getBoundingClientRect();
        const control = kids[kids.length - 1]!.getBoundingClientRect();
        return {
          name: (kids[0]!.textContent ?? "").trim().slice(0, 40),
          overflows: row.scrollWidth > row.clientWidth + 1,
          overlaps:
            Math.min(label.right, control.right) - Math.max(label.left, control.left) > 0.5 &&
            Math.min(label.bottom, control.bottom) - Math.max(label.top, control.top) > 0.5,
          stacked: control.top >= label.bottom - 1,
          controlWidth: Math.round(control.width),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return {
      count: measured.length,
      overlapping: measured.filter((entry) => entry.overlaps).map((entry) => entry.name),
      overflowing: measured.filter((entry) => entry.overflows).map((entry) => entry.name),
      stacked: measured.filter((entry) => entry.stacked).map((entry) => entry.name),
      // A control squeezed to nothing is the other half of the same defect.
      collapsed: measured.filter((entry) => entry.controlWidth < 8).map((entry) => entry.name),
    };
  });
}

async function openSettings(page: Page, width: number, forcedColumn?: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await openView(page, "settings");
  await expect(page.locator(".settings-control-row").first()).toBeVisible();
  // The masonry floor is 320px today; force it lower to exercise the degradation.
  await page.evaluate((column) => {
    for (const grid of Array.from(document.querySelectorAll<HTMLElement>(".settings-masonry"))) {
      grid.style.columns = column ? `${column}px` : "";
    }
  }, forcedColumn);
}

/**
 * The metric strip is nowrap, so a column narrower than the strip pushes the
 * numbers out to the left across the name column, where the status tag sits.
 */
async function measureRelicCards(page: Page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>(".relic-compact-card"));
    let worstSpill = 0;
    let narrowestCard = Infinity;
    let wrappedHeads = 0;
    let narrowestName = Infinity;
    const collisions: string[] = [];
    for (const card of cards) {
      const head = card.querySelector<HTMLElement>(".relic-compact-head");
      const tag = card.querySelector<HTMLElement>(".relic-status-tag");
      if (!head || !tag) continue;
      const evColumn = head.children[head.children.length - 1] as HTMLElement;
      const strip = evColumn.querySelector<HTMLElement>("div");
      if (!strip) continue;
      const tagRect = tag.getBoundingClientRect();
      const columnRect = evColumn.getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      narrowestCard = Math.min(narrowestCard, card.clientWidth);
      // A wrapped head drops the price block onto its own row, which is what
      // left the name column half empty and the whole card a row taller.
      if (evColumn.getBoundingClientRect().top >= tagRect.bottom - 1) wrappedHeads += 1;
      const nameColumn = head.children[1] as HTMLElement;
      narrowestName = Math.min(narrowestName, nameColumn.getBoundingClientRect().width);
      worstSpill = Math.max(worstSpill, columnRect.left - stripRect.left);
      if (
        Math.min(tagRect.right, stripRect.right) - Math.max(tagRect.left, stripRect.left) > 0.5 &&
        Math.min(tagRect.bottom, stripRect.bottom) - Math.max(tagRect.top, stripRect.top) > 0.5
      ) {
        collisions.push((card.querySelector(".relic-row-name")?.textContent ?? "").trim());
      }
    }
    return {
      cards: cards.length,
      narrowestCard: Math.round(narrowestCard),
      worstSpill: Math.round(worstSpill),
      collisions: collisions.slice(0, 6),
      collisionCount: collisions.length,
      wrappedHeads,
      narrowestName: Math.round(narrowestName),
      cardHeight: Math.round(cards[0]?.getBoundingClientRect().height ?? 0),
    };
  });
}

async function openRelics(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await openView(page, "relics");
  await page.getByRole("combobox", { name: "Relics" }).selectOption("all");
  await expect(page.locator(".relic-compact-card").first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(400);
}

test.describe("Settings rows and relic cards degrade without colliding", () => {
  test.setTimeout(300_000);

  let harness: ElectronTestHarness;
  let page: Page;

  test.beforeAll(async () => {
    fs.mkdirSync(SHOTS, { recursive: true });
    harness = await launchElectronTestHarness("wfh-settings-relic-layout-e2e-");
    page = harness.page;
  });

  test.afterAll(async () => {
    await closeElectronTestHarness(harness);
  });

  test("settings control rows never overlap their control at 125% font size", async () => {
    await page.evaluate(() => {
      localStorage.setItem(
        "wf_theme_settings",
        JSON.stringify({ version: 1, fontSizes: { globalScale: 1.25 } }),
      );
    });
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });

    for (const width of [700, 900, 1100]) {
      await openSettings(page, width);
      const layout = await measureSettingsRows(page);
      await page.screenshot({ path: `${SHOTS}/settings-${width}.png` });

      expect(layout.count, `no settings rows rendered at ${width}px`).toBeGreaterThan(5);
      expect(layout.overlapping, `label and control overlap at ${width}px`).toEqual([]);
      expect(layout.overflowing, `row overflows its card at ${width}px`).toEqual([]);
      expect(layout.collapsed, `control squeezed away at ${width}px`).toEqual([]);
    }
  });

  test("a settings column narrower than the masonry floor stacks the control", async () => {
    await openSettings(page, 1240, 240);
    const layout = await measureSettingsRows(page);
    await page.screenshot({ path: `${SHOTS}/settings-narrow-column.png` });

    expect(layout.overlapping, "label and control overlap in a narrow column").toEqual([]);
    expect(layout.overflowing, "row overflows a narrow column").toEqual([]);
    expect(layout.collapsed, "control squeezed away in a narrow column").toEqual([]);
    // Wrapping is the intended escape hatch, so at least one control must use it.
    expect(layout.stacked.length, "no control dropped below its label").toBeGreaterThan(0);

    await page.evaluate(() => localStorage.removeItem("wf_theme_settings"));
    await page.reload();
    await expect(page.locator("#sidebar")).toBeVisible({ timeout: 90_000 });
  });

  test("relic status tag never reaches the price row", async () => {
    const relicNames = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          api?: { getRelicDatabase?: () => Promise<{ byUniqueName?: Record<string, unknown> }> };
        }
      ).api;
      const db = await api?.getRelicDatabase?.();
      return Object.keys(db?.byUniqueName ?? {});
    });
    expect(relicNames.length, "relic database is empty").toBeGreaterThan(0);
    writeHarnessInventory(harness, {
      Suits: [],
      LevelKeys: relicNames
        .filter((name) => name.endsWith("Bronze"))
        .slice(0, 30)
        .map((ItemType) => ({ ItemType, ItemCount: 4 })),
    });

    // 1600 keeps the head on one row; 1240 is narrow enough that it has to wrap.
    for (const width of [1600, 1240]) {
      await openRelics(page, width);
      const layout = await measureRelicCards(page);
      await page.screenshot({ path: `${SHOTS}/relics-${width}.png` });

      expect(layout.cards, `no relic cards rendered at ${width}px`).toBeGreaterThan(5);
      expect(layout.collisions, `status tag hits the price row at ${width}px`).toEqual([]);
      expect(layout.collisionCount).toBe(0);
      // The numbers must stay inside their column instead of spilling onto the name.
      expect(layout.worstSpill, `price row spills left at ${width}px`).toBeLessThanOrEqual(1);
      expect(layout.wrappedHeads, `card head wrapped at ${width}px`).toBe(0);
      // Below this the relic name truncates to "Lith ..." on every card.
      expect(layout.narrowestName, `name column squeezed at ${width}px`).toBeGreaterThanOrEqual(80);
    }
  });
});
