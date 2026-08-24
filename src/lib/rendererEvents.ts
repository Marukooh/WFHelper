import { get } from "svelte/store";

import { invoke, on } from "./ipc.js";
import { onInventoryLoaded } from "./actions.js";
import { tr } from "./i18n.js";
import { handleWfmNotification } from "./wfmNotifications.js";
import { statusText } from "../stores/app.js";
import { pendingArbiRunId, subscribeArbiRunSaved } from "../stores/arbiRuns.js";
import { currentView } from "../stores/app.js";
import { itemDb, parsedItems } from "../stores/data.js";
import { masteryData } from "../stores/mastery.js";
import { applyClosedWfmListing } from "../stores/market.js";
import { addToast } from "../stores/toasts.js";
import { applyUpdateState } from "../stores/updates.js";

/** Main-process events that outlive whichever view happens to be mounted.
 * App.svelte only calls this and disposes it; none of it is layout. */
export function initRendererEvents(): () => void {
  const unsubscribes = [
    // Runs land in the index even while the Arbitrations tab is unmounted.
    subscribeArbiRunSaved(),

    on("inventory-updated", async (data) => {
      if (data && !(data as { error?: unknown }).error) {
        await onInventoryLoaded(data);
        // SetupView routes itself during the wizard; navigating here would tear it down
        statusText.set({
          key: "app.liveUpdateStatus",
          params: { count: get(parsedItems).length },
        });
      }
    }),

    on("inventory-status-updated", (status) => {
      if (status.lastError) {
        statusText.set({
          key: "app.inventoryWatcherError",
          params: { error: status.lastError.message },
        });
      } else if (status.found) {
        statusText.set({ key: "app.itemsLoaded", params: { count: get(parsedItems).length } });
      }
    }),

    on("app-update-status", (state) => applyUpdateState(state, true)),

    on("wfm:notification", (notification) => handleWfmNotification(notification, get(tr))),

    // Lives here, not in MarketView: the trade lands while the user is in-game,
    // long before the (lazy) Market tab is mounted.
    on("trade-recorded", (data) => {
      for (const match of data?.wfmMatches ?? []) applyClosedWfmListing(match);
    }),

    // Post-run overlay "Detailed Stats" button: open the arbi tab on that run.
    on("arbi-open-run", (runId) => {
      pendingArbiRunId.set(runId);
      currentView.set("arbi");
    }),

    // DE overlay refresh can add items/icons after startup; re-pull the affected stores.
    on("item-db-updated", async () => {
      const db = await invoke("getItemDatabase");
      itemDb.set(db || {});
      invoke("getMasteryProgress")
        .then((md) => masteryData.set(md))
        .catch((err) => console.warn("[Mastery] getMasteryProgress failed:", err));
    }),
  ];

  // Main raises fallbackHint once per remembered XWayland failure.
  void invoke("getLinuxDisplay").then((display) => {
    if (!display?.fallbackHint) return;
    const t = get(tr);
    addToast({
      level: "warning",
      title: t("app.overlayFallbackTitle"),
      message: t("app.overlayFallbackMessage"),
      durationMs: 15000,
    });
  });

  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
