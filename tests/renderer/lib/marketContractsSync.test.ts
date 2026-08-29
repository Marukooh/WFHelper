import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../../src/lib/ipc.js", () => ({ invoke: mocks.invoke }));

import {
  beginContractsWrite,
  commitContracts,
  ensureRivenContractsLoaded,
  invalidateRivenContractsRefresh,
} from "../../../src/lib/marketContractsSync.js";
import { handleWfmNotification } from "../../../src/lib/wfmNotifications.js";
import {
  clearMarketAccountState,
  marketContracts,
  marketSession,
  marketViewState,
} from "../../../src/stores/market.js";
import type { Translator } from "../../../src/lib/i18n.js";
import type { WfmContractsResult } from "../../../src/types/market.js";

const translate = ((key: string) => key) as Translator;

function contractPage(ids: string[], page: number, hasMore: boolean): WfmContractsResult {
  return {
    contracts: ids.map((id) => ({ id, weaponUrlName: "rubico" })),
    page,
    totalPages: null,
    hasMore,
  } as WfmContractsResult;
}

function listedIds(): string[] {
  return get(marketContracts).contracts.map((contract) => contract.id);
}

// The loader remembers which account it last read in full, so every test signs
// in as its own user and cannot inherit a previous test's cache.
let userSeq = 0;
function signIn(userName = `tenno-${++userSeq}`): void {
  marketSession.set({ loggedIn: true, userName, platform: "pc" });
}

beforeEach(() => {
  mocks.invoke.mockReset();
  clearMarketAccountState();
});

describe("ensureRivenContractsLoaded", () => {
  it("stays quiet and hits nothing while signed out", async () => {
    mocks.invoke.mockResolvedValue({ loggedIn: false, userName: null, platform: "pc" });
    await expect(ensureRivenContractsLoaded()).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("wfmGetSession");
  });

  it("walks every page into the shared store", async () => {
    signIn();
    mocks.invoke
      .mockResolvedValueOnce(contractPage(["a"], 1, true))
      .mockResolvedValueOnce(contractPage(["b"], 2, false));

    await expect(ensureRivenContractsLoaded()).resolves.toBe(true);
    expect(listedIds()).toEqual(["a", "b"]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("skips the refetch inside the cache window", async () => {
    signIn();
    mocks.invoke.mockResolvedValue(contractPage(["a"], 1, false));
    await ensureRivenContractsLoaded();
    await ensureRivenContractsLoaded();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("refetches on demand inside the cache window", async () => {
    signIn();
    mocks.invoke.mockResolvedValue(contractPage(["a"], 1, false));
    await ensureRivenContractsLoaded();
    await ensureRivenContractsLoaded(true);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  // The Market tab pages lazily and stamps the same timestamp, so a fresh but
  // half-loaded store must not be mistaken for the whole listing set.
  it("completes a store the Market tab only paged partway through", async () => {
    signIn();
    marketContracts.set(contractPage(["a"], 1, true));
    marketViewState.update((state) => ({ ...state, contractsLastFetch: Date.now() }));
    mocks.invoke.mockResolvedValue(contractPage(["a", "b"], 1, false));

    await ensureRivenContractsLoaded();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(listedIds()).toEqual(["a", "b"]);
  });

  it("keeps the last good listings when a page fails", async () => {
    signIn();
    marketContracts.set(contractPage(["a"], 1, false));
    mocks.invoke.mockResolvedValue({ error: "warframe.market is down" });

    await expect(ensureRivenContractsLoaded(true)).resolves.toBe(false);
    expect(listedIds()).toEqual(["a"]);
  });

  it("reports a thrown request as a failure", async () => {
    signIn();
    mocks.invoke.mockRejectedValue(new Error("offline"));
    await expect(ensureRivenContractsLoaded(true)).resolves.toBe(false);
  });

  it("shares one request between concurrent callers", async () => {
    signIn();
    mocks.invoke.mockResolvedValue(contractPage(["a"], 1, false));
    await Promise.all([ensureRivenContractsLoaded(), ensureRivenContractsLoaded()]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  // Joining the in-flight load would answer the button from the cache the
  // background load is about to fill, so the click would do nothing.
  it("still refetches when a manual refresh races a background load", async () => {
    signIn();
    mocks.invoke.mockResolvedValue(contractPage(["a"], 1, false));
    const background = ensureRivenContractsLoaded();
    const manual = ensureRivenContractsLoaded(true);
    await Promise.all([background, manual]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  // A listing the user just created, edited or removed is announced this way,
  // and the module cache used to outlive it by up to ten minutes.
  it("refetches after the orders-changed handler resets the fetch times", async () => {
    signIn();
    mocks.invoke.mockResolvedValue(contractPage(["a"], 1, false));
    await ensureRivenContractsLoaded();

    handleWfmNotification({ type: "orders-changed" }, translate);
    await ensureRivenContractsLoaded();

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("refetches after a listing edit invalidates the cache", async () => {
    signIn();
    mocks.invoke.mockResolvedValue(contractPage(["a"], 1, false));
    await ensureRivenContractsLoaded();

    invalidateRivenContractsRefresh();
    await ensureRivenContractsLoaded();

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  // The Market tab writes the same store one page at a time, so a page-one reply
  // that lands late would shrink a list the Rivens tab already paged in full.
  it("cannot regress a complete list to a stale page one", async () => {
    signIn();
    const stale = beginContractsWrite();
    mocks.invoke.mockResolvedValue(contractPage(["a", "b"], 1, false));
    await ensureRivenContractsLoaded(true);

    expect(commitContracts(stale, contractPage(["a"], 1, true))).toBe(false);
    expect(listedIds()).toEqual(["a", "b"]);
    expect(get(marketContracts).hasMore).toBe(false);
  });

  it("drops a page walk that a listing removal overtook", async () => {
    signIn();
    marketContracts.set(contractPage(["a"], 1, false));
    let releasePage: (result: WfmContractsResult) => void = () => {};
    const pendingPage = new Promise<WfmContractsResult>((resolve) => {
      releasePage = resolve;
    });
    mocks.invoke.mockImplementationOnce(() => pendingPage);

    const walk = ensureRivenContractsLoaded(true);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1));
    // The user removes the auction while the walk is still out.
    marketContracts.set(contractPage([], 1, false));
    invalidateRivenContractsRefresh();
    releasePage(contractPage(["a"], 1, false));

    await expect(walk).resolves.toBe(true);
    expect(listedIds()).toEqual([]);
  });

  it("does not serve one account's listings to the next", async () => {
    signIn("first");
    mocks.invoke.mockResolvedValue(contractPage(["a"], 1, false));
    await ensureRivenContractsLoaded();

    clearMarketAccountState();
    signIn("second");
    mocks.invoke.mockResolvedValue(contractPage(["b"], 1, false));
    await ensureRivenContractsLoaded();

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(listedIds()).toEqual(["b"]);
  });
});
