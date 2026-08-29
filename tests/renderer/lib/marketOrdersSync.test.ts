import { describe, expect, it } from "vitest";

import {
  createMarketOrdersRefreshController,
  reconcileMarketOrders,
} from "../../../src/lib/marketOrdersSync.js";
import type {
  WfmMutationError,
  WfmOrder,
  WfmOrdersResult,
  WfmSession,
} from "../../../src/types/market.js";

function order(id: string, overrides: Partial<WfmOrder> = {}): WfmOrder {
  return {
    id,
    orderType: "sell",
    platinum: 20,
    quantity: 1,
    perTrade: 1,
    visible: true,
    modRank: null,
    itemId: `item-${id}`,
    itemName: `Item ${id}`,
    itemUrlName: `item_${id}`,
    itemThumb: null,
    ...overrides,
  };
}

function orders(sell: WfmOrder[] = [], buy: WfmOrder[] = []): WfmOrdersResult {
  return { sell, buy };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controllerHarness(requests: Array<Promise<WfmOrdersResult | WfmMutationError>>) {
  let session: WfmSession = { loggedIn: true, userName: "Tester", platform: "pc" };
  let current = orders([order("old")]);
  const writes: WfmOrdersResult[] = [];
  let expired = false;

  const controller = createMarketOrdersRefreshController({
    request: () => {
      const request = requests.shift();
      if (!request) throw new Error("Unexpected request");
      return request;
    },
    readSession: () => session,
    readOrders: () => current,
    writeOrders: (next) => {
      current = next;
      writes.push(next);
    },
    syncSelection: () => undefined,
    markFetched: () => undefined,
    expireSession: () => {
      expired = true;
      session = { loggedIn: false, userName: null, platform: "pc" };
    },
  });

  return {
    controller,
    getCurrent: () => current,
    getWrites: () => writes,
    setSession: (next: WfmSession) => {
      session = next;
    },
    didExpire: () => expired,
  };
}

describe("reconcileMarketOrders", () => {
  it("preserves unchanged order and collection references", () => {
    const existing = order("same");
    const current = orders([existing]);
    const reconciled = reconcileMarketOrders(current, orders([{ ...existing }]));

    expect(reconciled).toBe(current);
    expect(reconciled.sell[0]).toBe(existing);
  });

  it.each([
    ["price", { platinum: 45 }],
    ["visibility", { visible: false }],
    ["rank", { modRank: 8 }],
    ["per-trade quantity", { perTrade: 2, quantity: 3 }],
    ["item metadata", { itemName: "Renamed Item", itemThumb: "new-thumb.png" }],
    ["additional API fields", { updatedAt: "2026-08-08T12:00:00Z" }],
  ])("applies an external %s change", (_label, change) => {
    const existing = order("changed");
    const incoming = order("changed", change);
    const reconciled = reconcileMarketOrders(orders([existing]), orders([incoming]));

    expect(reconciled.sell[0]).toBe(incoming);
  });

  it("preserves unchanged rows while adding and removing listings", () => {
    const kept = order("kept");
    const reconciled = reconcileMarketOrders(
      orders([order("removed"), kept]),
      orders([{ ...kept }, order("added")]),
    );

    expect(reconciled.sell.map((entry) => entry.id)).toEqual(["kept", "added"]);
    expect(reconciled.sell[0]).toBe(kept);
  });
});

describe("market order refresh lifecycle", () => {
  it("ignores an older response that finishes after a newer refresh", async () => {
    const first = deferred<WfmOrdersResult | WfmMutationError>();
    const second = deferred<WfmOrdersResult | WfmMutationError>();
    const harness = controllerHarness([first.promise, second.promise]);

    const firstRefresh = harness.controller.refresh();
    const secondRefresh = harness.controller.refresh();
    second.resolve(orders([order("new")]));
    expect((await secondRefresh).status).toBe("updated");
    first.resolve(orders([order("stale")]));
    expect((await firstRefresh).status).toBe("stale");

    expect(harness.getCurrent().sell.map((entry) => entry.id)).toEqual(["new"]);
    expect(harness.getWrites()).toHaveLength(1);
  });

  it("drops a response after the account logs out", async () => {
    const pending = deferred<WfmOrdersResult | WfmMutationError>();
    const harness = controllerHarness([pending.promise]);

    const refresh = harness.controller.refresh();
    harness.setSession({ loggedIn: false, userName: null, platform: "pc" });
    pending.resolve(orders([order("wrong-account")]));

    expect((await refresh).status).toBe("stale");
    expect(harness.getCurrent().sell.map((entry) => entry.id)).toEqual(["old"]);
    expect(harness.getWrites()).toHaveLength(0);
  });

  it("does not start a second background request while one is active", async () => {
    const pending = deferred<WfmOrdersResult | WfmMutationError>();
    const harness = controllerHarness([pending.promise]);

    const firstRefresh = harness.controller.refresh({ background: true });
    expect((await harness.controller.refresh({ background: true })).status).toBe("skipped");
    pending.resolve(orders([order("fresh")]));
    await firstRefresh;

    expect(harness.getCurrent().sell.map((entry) => entry.id)).toEqual(["fresh"]);
  });

  it("expires the local session on an authentication error", async () => {
    const harness = controllerHarness([Promise.resolve({ error: "Session expired" })]);

    const outcome = await harness.controller.refresh();

    expect(outcome).toEqual({
      status: "error",
      error: "Session expired",
      authExpired: true,
    });
    expect(harness.didExpire()).toBe(true);
  });
});

describe("invalidateMarketOrdersRefresh", () => {
  // An orders-changed push has to discard a walk that started before it, or the
  // pre-change list lands after the refetch and looks fresh.
  it("drops a walk that was already in flight", async () => {
    const pending = deferred<WfmOrdersResult>();
    const harness = controllerHarness([pending.promise]);

    const inFlight = harness.controller.refresh();
    harness.controller.invalidate();
    pending.resolve(orders([order("stale")]));
    await inFlight;

    expect(harness.getWrites()).toEqual([]);
    expect(harness.getCurrent().sell[0]?.id).toBe("old");
  });
});
