import { describe, expect, it } from "vitest";

import { resolveCircuitChoices, resolveVendorItems } from "../../../src/lib/world.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

const TORID = "/Lotus/Weapons/Tenno/LongGuns/Torid";
const ADAPTER = "/Lotus/Types/Items/MiscItems/IncarnonAdapters/Primary/ToridIncarnonUnlocker";
const EXCALIBUR = "/Lotus/Powersuits/Excalibur/Excalibur";

const DB: Record<string, ItemDbEntry> = {
  [TORID]: { name: "Torid", imageUrl: "torid-base.png", category: "Primary" },
  [ADAPTER]: {
    name: "Torid Incarnon Genesis",
    imageUrl: "torid-incarnon.png",
    category: "Misc",
  },
  [`${ADAPTER}Blueprint`]: {
    name: "Torid Incarnon Genesis Blueprint",
    imageUrl: "torid-incarnon-bp.png",
  },
  [EXCALIBUR]: { name: "Excalibur", imageUrl: "excalibur.png", category: "Warframe" },
};

describe("circuit choice art", () => {
  it("shows the Incarnon Genesis art for a Steel Path weapon", () => {
    const [torid] = resolveCircuitChoices(["Torid"], DB, null);

    expect(torid.imageUrl).toBe("torid-incarnon.png");
    expect(torid.uniqueName).toBe(TORID);
  });

  // The circuit row used to hand the view a single name field, so a localized
  // database still drew the English one here.
  it("carries the localized name without losing the English one", () => {
    const localized: Record<string, ItemDbEntry> = {
      ...DB,
      [TORID]: { ...DB[TORID], displayName: "토리드" },
    };

    const [torid] = resolveCircuitChoices(["Torid"], localized, null);

    expect(torid.name).toBe("Torid");
    expect(torid.displayName).toBe("토리드");
  });

  it("still reads ownership off the base weapon", () => {
    const [torid] = resolveCircuitChoices(["Torid"], DB, { LongGuns: [{ ItemType: TORID }] });

    expect(torid.owned).toBe(true);
  });

  it("leaves warframes on their own portrait", () => {
    const [frame] = resolveCircuitChoices(["Excalibur"], DB, null);

    expect(frame.imageUrl).toBe("excalibur.png");
  });

  it("matches warframestat's 'And' spelling against DE's '&' names", () => {
    const ACK = "/Lotus/Weapons/Tenno/Melee/Sword/AckAndBrunt";
    const db = { ...DB, [ACK]: { name: "Ack & Brunt", imageUrl: "ack.png", category: "Melee" } };

    const [ack] = resolveCircuitChoices(["Ack And Brunt"], db, null);

    expect(ack.uniqueName).toBe(ACK);
    expect(ack.name).toBe("Ack & Brunt");
    expect(ack.imageUrl).toBe("ack.png");
  });
});

const SUBSUMED_INVENTORY = {
  InfestedFoundry: { ConsumedSuits: [{ s: EXCALIBUR }] },
};

describe("subsumed circuit frames", () => {
  it("keeps a subsumed frame owned and flags it", () => {
    const [frame] = resolveCircuitChoices(["Excalibur"], DB, SUBSUMED_INVENTORY);

    expect(frame.owned).toBe(true);
    expect(frame.subsumed).toBe(true);
  });

  it("leaves a frame held in Suits unflagged", () => {
    const [frame] = resolveCircuitChoices(["Excalibur"], DB, {
      Suits: [{ ItemType: EXCALIBUR }],
    });

    expect(frame.owned).toBe(true);
    expect(frame.subsumed).toBeUndefined();
  });

  it("never flags a weapon", () => {
    const [torid] = resolveCircuitChoices(["Torid"], DB, SUBSUMED_INVENTORY);

    expect(torid.subsumed).toBeUndefined();
  });

  it("flags vendor stock the same way", () => {
    const [frame] = resolveVendorItems([EXCALIBUR], DB, SUBSUMED_INVENTORY);

    expect(frame.owned).toBe(true);
    expect(frame.subsumed).toBe(true);
  });
});
