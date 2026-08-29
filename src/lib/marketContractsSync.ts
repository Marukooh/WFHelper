import { get } from "svelte/store";

import { invoke } from "./ipc.js";
import { isIpcError } from "./ipcGuards.js";
import {
  invalidateContractsFreshness,
  isCurrentContractsWrite,
  marketContracts,
  marketSession,
  marketViewState,
  reserveContractsWrite,
  setMarketViewState,
} from "../stores/market.js";
import type { WfmContract, WfmContractsResult } from "../types/market.js";

const CONTRACTS_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 40;
// A hard stop so a paging bug on the WFM side cannot spin the fetch forever.
const MAX_PAGES = 10;

let inFlight: Promise<boolean> | null = null;
// The store stamp of the last list this module paged to the end. Read back from
// the store, so any other writer moving the stamp retires the mark by itself.
let completedAt: { at: number; user: string | null } | null = null;

export function beginContractsWrite(): number {
  return reserveContractsWrite();
}

/**
 * Publishes a contracts result unless a newer reservation took over. Completeness
 * is tracked apart from the token, which cannot tell page one from a whole list.
 */
export function commitContracts(token: number, next: WfmContractsResult): boolean {
  if (!isCurrentContractsWrite(token)) return false;
  marketContracts.set(next);
  setMarketViewState({ contractsLastFetch: Date.now() });
  return true;
}

/**
 * Drops every in-flight write and the freshness mark, so the next read pages the
 * list again. Call it after anything that creates, edits or removes a listing.
 */
export function invalidateRivenContractsRefresh(): void {
  completedAt = null;
  invalidateContractsFreshness();
}

// Freshness alone proves only page one, because the Market tab pages lazily and
// stamps the same timestamp; a partial store would leave later rivens unmarked.
function hasFreshFullList(user: string | null): boolean {
  const stamp = get(marketViewState).contractsLastFetch;
  if (!stamp || Date.now() - stamp >= CONTRACTS_TTL_MS) return false;
  if (completedAt && completedAt.user === user && completedAt.at === stamp) return true;
  return !get(marketContracts).hasMore;
}

async function fetchAllContracts(user: string | null): Promise<boolean> {
  const token = beginContractsWrite();
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

  const published = commitContracts(token, {
    contracts: [...byId.values()],
    page: lastPage,
    totalPages: null,
    hasMore,
  });
  // Losing the store to a newer writer is not a request failure, but this list
  // is no longer what the store holds, so it may not claim the list is complete.
  if (published && !hasMore) {
    completedAt = { at: get(marketViewState).contractsLastFetch, user };
  }
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
          completedAt = null;
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
