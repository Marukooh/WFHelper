import { get } from "svelte/store";

import { invoke } from "./ipc.js";
import { isIpcError } from "./ipcGuards.js";
import {
  marketContracts,
  marketSession,
  marketViewState,
  setMarketViewState,
} from "../stores/market.js";
import type { WfmContract } from "../types/market.js";

const CONTRACTS_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 40;
// A hard stop so a paging bug on the WFM side cannot spin the fetch forever.
const MAX_PAGES = 10;

let inFlight: Promise<boolean> | null = null;
let lastFullFetch: { at: number; user: string | null } | null = null;

// The shared timestamp only proves page one is fresh, because the Market tab
// pages lazily; a partial store would leave later rivens wrongly unmarked.
function hasFreshFullList(user: string | null): boolean {
  const now = Date.now();
  if (lastFullFetch && lastFullFetch.user === user && now - lastFullFetch.at < CONTRACTS_TTL_MS) {
    return true;
  }
  return (
    now - get(marketViewState).contractsLastFetch < CONTRACTS_TTL_MS &&
    !get(marketContracts).hasMore
  );
}

async function fetchAllContracts(user: string | null): Promise<boolean> {
  const byId = new Map<string, WfmContract>();
  let page = 1;
  let lastPage = 1;
  let hasMore = false;

  while (page <= MAX_PAGES) {
    const result = await invoke("wfmGetContracts", { page, limit: PAGE_SIZE });
    // A failed page leaves the previous listings in place; a half-written store
    // would blank the markers on every riven past the failure.
    if (isIpcError(result)) return false;

    for (const contract of result.contracts) byId.set(contract.id, contract);
    lastPage = result.page;
    hasMore = result.hasMore;
    if (!hasMore) break;
    page += 1;
  }

  marketContracts.set({
    contracts: [...byId.values()],
    page: lastPage,
    totalPages: null,
    hasMore,
  });
  lastFullFetch = { at: Date.now(), user };
  setMarketViewState({ contractsLastFetch: Date.now() });
  return true;
}

/**
 * Fills the shared contracts store with the user's riven auctions. Read-only and
 * never polled; resolves false only on a failed request, so signing out is quiet.
 */
export function ensureRivenContractsLoaded(force = false): Promise<boolean> {
  // A manual refresh must not be answered by a background load that is about to
  // resolve from the cache, so it queues behind it instead of joining it.
  if (inFlight && !force) return inFlight;

  const run = async (): Promise<boolean> => {
    if (!get(marketSession).loggedIn) {
      try {
        const session = await invoke("wfmGetSession");
        if (!session.loggedIn) {
          lastFullFetch = null;
          return true;
        }
        marketSession.set(session);
      } catch {
        return true;
      }
    }
    const user = get(marketSession).userName;
    if (!force && hasFreshFullList(user)) return true;
    try {
      return await fetchAllContracts(user);
    } catch {
      return false;
    }
  };

  const started = (inFlight ?? Promise.resolve(true)).then(run);
  inFlight = started;
  void started.finally(() => {
    if (inFlight === started) inFlight = null;
  });
  return started;
}
