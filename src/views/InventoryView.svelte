<script lang="ts">
  import { onDestroy, onMount } from "svelte";

  import { tr } from "../lib/i18n.js";
  import { parsedItems, wfmItems, inventoryData, itemDb } from "../stores/data.js";
  import { masteryData } from "../stores/mastery.js";
  import { marketOrders } from "../stores/market.js";
  import { ensureMarketOrdersLoaded } from "../lib/marketOrdersSync.js";
  import { attachPartMasteryFlags, buildPartMasteryResolver } from "../lib/parentMastery.js";
  import { relicDb } from "../stores/relics.js";
  import InventoryHeader from "../components/inventory/InventoryHeader.svelte";
  import InventoryGrid from "../components/inventory/InventoryGrid.svelte";
  import InventoryOrderBookPanel from "../components/inventory/InventoryOrderBookPanel.svelte";
  import SharedFilterBar from "../components/SharedFilterBar.svelte";
  import ResourcesView from "./ResourcesView.svelte";
  import ChipToggleRow from "../components/inventory/ChipToggleRow.svelte";
  import { parseResources } from "../lib/inventory.js";
  import {
    EQUIPMENT_CATEGORY_ORDER,
    classifyForFoundry,
  } from "../lib/inventory/foundryResources.js";
  import { applySharedFiltersAndSort } from "../lib/filters.js";
  import {
    EVERYTHING_DEFAULT_SOURCES,
    EVERYTHING_SOURCES,
    INVENTORY_FILTERS,
    buildBaseInventoryItems,
    buildInventoryViewItems,
    buildOrderLookups,
    metricNeedsFromFilters,
    shouldHydrateMetrics,
    type InventoryBaseItem,
    type InventoryFilterTab,
    type InventoryViewItem,
    type MetricNeeds,
  } from "../lib/inventoryMarket.js";
  import { buildRelicSearchKeywordIndex } from "../lib/relic.js";
  import { readStorage, writeStorage } from "../lib/persistence.js";
  import { startupPriceCacheReady } from "../lib/startupLoader.js";
  import { log } from "../lib/log.js";
  import {
    getRankedHotsetEntries,
    getRankedHotsetSeenAt,
    recordRankedHotsetEntry,
  } from "../lib/wfm/rankedHotset.js";
  import { getInventoryHydrationController } from "../stores/inventoryHydration.js";
  import { ARCANE_STAND_IN_ART } from "../data/arcaneStandInArt.js";
  import { devMode, degradedIcons } from "../stores/devMode.js";
  import { sharedFilters, updateSharedFilters } from "../stores/filters.js";
  import { activeItem } from "../stores/modals.js";
  import { isRankedGroup } from "../../config/shared/numeric.js";
  import type { SharedSortKey, SharedFiltersState } from "../types/filters.js";

  const METRIC_VISIBLE_PREFETCH_LIMIT = 42;
  const METRIC_BACKGROUND_PREFETCH_LIMIT = 210;
  const HOTSET_REFRESH_DELAY_MS = 4_000;
  const HOTSET_REFRESH_LIMIT = 12;

  const FILTER_TAB_KEY = "wf_inventory_tab";
  const EVERYTHING_SOURCES_KEY = "wf_inventory_everything_sources";
  // Stored as the hidden set so a category the game adds later shows up by default.
  const FULL_SETS_HIDDEN_KEY = "wf_inventory_full_sets_hidden_categories";

  function restoreFilterTab(): InventoryFilterTab {
    const raw = readStorage(FILTER_TAB_KEY);
    const known = INVENTORY_FILTERS.some((entry) => entry.key === raw);
    return known ? (raw as InventoryFilterTab) : "all_parts";
  }

  function restoreEverythingSources(): InventoryFilterTab[] {
    const raw = readStorage(EVERYTHING_SOURCES_KEY);
    if (raw == null) return [...EVERYTHING_DEFAULT_SOURCES];
    // An empty saved list is a real choice (everything hidden), so only an
    // absent key falls back to the defaults.
    const saved = raw
      .split(",")
      .filter((key): key is InventoryFilterTab =>
        EVERYTHING_SOURCES.includes(key as InventoryFilterTab),
      );
    return saved;
  }

  // Only sorts the active tab can actually compute; anything else would
  // silently fall back to a name sort (metrics missing on those items).
  $: FULL_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["platinum", $tr("common.platinum")],
    ["ducats", $tr("common.ducats")],
    ["amount", $tr("filters.amount")],
    ["ducatonator", $tr("filters.ducatonator")],
    ["complete_sets", $tr("filters.completeSets")],
    ["missing_parts", $tr("filters.partsToComplete")],
  ] as Array<[SharedSortKey, string]>;
  $: PRICED_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["platinum", $tr("common.platinum")],
    ["amount", $tr("filters.amount")],
  ] as Array<[SharedSortKey, string]>;
  $: RESOURCE_SORT_OPTIONS = [
    ["name", $tr("common.name")],
    ["amount", $tr("filters.amount")],
  ] as Array<[SharedSortKey, string]>;
  $: SORT_OPTIONS_BY_TAB = {
    all_parts: FULL_SORT_OPTIONS,
    full_sets: FULL_SORT_OPTIONS,
    resources: RESOURCE_SORT_OPTIONS,
  } as Partial<Record<InventoryFilterTab, Array<[SharedSortKey, string]>>>;

  let filter: InventoryFilterTab = restoreFilterTab();
  let everythingSources: InventoryFilterTab[] = restoreEverythingSources();
  let hiddenSetCategories: string[] = (readStorage(FULL_SETS_HIDDEN_KEY) ?? "")
    .split(",")
    .filter((entry) => entry.length > 0);
  let missingIconsOnly = false;
  let showFilterPanel = false;
  // Full Sets lists sellable spares; this folds in the sets still missing parts.
  let showIncompleteSets = false;
  let selectedInternalName: string | null = null;
  let orderBookPanelOpen = false;
  const FILTERS = INVENTORY_FILTERS;
  const inventoryFilters = sharedFilters("inventory");

  const hydration = getInventoryHydrationController();
  const hydrationMetrics = hydration.metricsByKey;
  let hotsetRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let hotsetRefreshSignature = "";
  let hotsetRefreshCompletedSignature = "";

  function trackRankedHotset(item: InventoryBaseItem | null | undefined): void {
    if (!item || !isRankedGroup(item.inventoryGroup) || !item.marketSlug) return;
    recordRankedHotsetEntry(item.marketSlug, item.maxRank);
  }

  function prefetchVisibleMetrics(items: InventoryBaseItem[], needs: MetricNeeds): void {
    const hydrationCandidates = items.filter((item) => shouldHydrateMetrics(item));
    const visible = hydrationCandidates.slice(0, METRIC_VISIBLE_PREFETCH_LIMIT);
    const background = hydrationCandidates.slice(
      METRIC_VISIBLE_PREFETCH_LIMIT,
      METRIC_VISIBLE_PREFETCH_LIMIT + METRIC_BACKGROUND_PREFETCH_LIMIT,
    );

    // the startup snapshot doesn't cover every slug, so the visible slice may fetch
    hydration.enqueue(visible, $wfmItems, { ...needs, network: true });
    hydration.enqueue(background, $wfmItems, { ...needs, ducats: false, orders: false });
  }

  function handleFilterSelect(event: CustomEvent<InventoryFilterTab>): void {
    filter = event.detail;
    writeStorage(FILTER_TAB_KEY, filter);
    // Resources hides the advanced panel, so a carried-over amount would cut
    // rows with no control and no badge to reveal it.
    if (filter === "resources" && $inventoryFilters.minimumAmount > 0) {
      updateSharedFilters("inventory", { minimumAmount: 0 });
    }
  }

  function toggleEverythingSource(source: InventoryFilterTab): void {
    everythingSources = everythingSources.includes(source)
      ? everythingSources.filter((entry) => entry !== source)
      : [...everythingSources, source];
    writeStorage(EVERYTHING_SOURCES_KEY, everythingSources.join(","));
  }

  function toggleIncompleteSets(): void {
    showIncompleteSets = !showIncompleteSets;
    // Fewest-parts-first on arrival; don't fight a deliberate re-sort.
    if (showIncompleteSets && $inventoryFilters.sortBy !== "missing_parts") {
      updateSharedFilters("inventory", { sortBy: "missing_parts", sortDirection: "asc" });
    }
  }

  function handleToggleFilterPanel(): void {
    showFilterPanel = !showFilterPanel;
  }

  function handleItemSelect(event: CustomEvent<InventoryViewItem>): void {
    selectedInternalName = event.detail.internalName;
    orderBookPanelOpen = true;

    if (!wfmItemsLoaded) return;
    const selectedBaseItem = tabBaseItems.find(
      (entry) => entry.internalName === event.detail.internalName,
    );
    if (selectedBaseItem && shouldHydrateMetrics(selectedBaseItem)) {
      trackRankedHotset(selectedBaseItem);
      hydration.enqueue([selectedBaseItem], $wfmItems, {
        price: true,
        ducats: false,
        orders: true,
        network: true,
      });
    }
  }

  // Rows without a parsed backing (generated set rows) have no detail modal.
  $: detailKeys = new Set($parsedItems.map((entry) => entry.internalName));

  function handleItemExpand(event: CustomEvent<InventoryViewItem>): void {
    const parsed = $parsedItems.find((entry) => entry.internalName === event.detail.internalName);
    // Base items predate hydration - carry the slug so the modal prices by it.
    if (parsed) activeItem.set({ ...parsed, marketSlug: event.detail.marketSlug });
  }

  function closeOrderBookPanel(): void {
    selectedInternalName = null;
    orderBookPanelOpen = false;
  }

  function handleItemVisible(event: CustomEvent<InventoryViewItem>): void {
    // before the catalog loads, cards carry guessed slugs - don't fetch with those
    if (!wfmItemsLoaded) return;
    const visibleBaseItem = tabBaseItems.find(
      (entry) => entry.internalName === event.detail.internalName,
    );
    if (!visibleBaseItem || !shouldHydrateMetrics(visibleBaseItem)) return;
    trackRankedHotset(visibleBaseItem);

    // Everything mixes ranked and unranked rows, so the item decides, not the tab.
    hydration.enqueue([visibleBaseItem], $wfmItems, {
      price: true,
      ducats: false,
      orders: isRankedGroup(visibleBaseItem.inventoryGroup),
      network: true,
    });
  }

  function clearHotsetRefreshTimer(): void {
    if (!hotsetRefreshTimer) return;
    clearTimeout(hotsetRefreshTimer);
    hotsetRefreshTimer = null;
  }

  function buildHotsetRefreshSignature(items: InventoryBaseItem[]): string {
    const topHotset = getRankedHotsetEntries()
      .slice(0, HOTSET_REFRESH_LIMIT)
      .map((entry) => `${entry.slug}:r${entry.maxRank}`)
      .join("|");
    return `${items.length}:${topHotset}`;
  }

  function maybeScheduleRankedHotsetRefresh(items: InventoryBaseItem[]): void {
    if (!$startupPriceCacheReady) return;
    if (!wfmItemsLoaded) return;

    const signature = buildHotsetRefreshSignature(items);
    if (signature === hotsetRefreshSignature || signature === hotsetRefreshCompletedSignature) {
      return;
    }

    hotsetRefreshSignature = signature;
    clearHotsetRefreshTimer();
    hotsetRefreshTimer = setTimeout(() => {
      hotsetRefreshTimer = null;
      const topHotset = getRankedHotsetEntries().slice(0, HOTSET_REFRESH_LIMIT);
      if (topHotset.length === 0) {
        hotsetRefreshCompletedSignature = signature;
        return;
      }

      const bySlug = new Map(topHotset.map((entry) => [entry.slug, entry]));
      const queue = items
        .filter((item) => item.marketSlug && bySlug.has(item.marketSlug))
        .sort((a, b) => getRankedHotsetSeenAt(b.marketSlug) - getRankedHotsetSeenAt(a.marketSlug))
        .slice(0, HOTSET_REFRESH_LIMIT);

      if (queue.length > 0) {
        hydration.enqueue(queue, $wfmItems, {
          price: true,
          ducats: false,
          orders: true,
          network: true,
        });
        log.info(`[Inventory] queued ranked hotset refresh (${queue.length} items)`);
      }

      hotsetRefreshCompletedSignature = signature;
    }, HOTSET_REFRESH_DELAY_MS);
  }

  /** Sets carry "Full Set" as their label, so bucket them by the root item instead. */
  function setCategoryFor(item: InventoryBaseItem, db: typeof $itemDb): string {
    const root = item.internalName.replace(/#set$/, "");
    return classifyForFoundry(root, root, db);
  }

  function orderedSetCategories(items: InventoryBaseItem[], db: typeof $itemDb): string[] {
    const present = new Set(items.map((item) => setCategoryFor(item, db)));
    return EQUIPMENT_CATEGORY_ORDER.filter((category) => present.has(category));
  }

  function toggleSetCategory(category: string): void {
    hiddenSetCategories = hiddenSetCategories.includes(category)
      ? hiddenSetCategories.filter((entry) => entry !== category)
      : [...hiddenSetCategories, category];
    writeStorage(FULL_SETS_HIDDEN_KEY, hiddenSetCategories.join(","));
  }

  function limitToEnabledSources(
    items: InventoryBaseItem[],
    tab: InventoryFilterTab,
    enabled: ReadonlySet<string>,
  ): InventoryBaseItem[] {
    if (tab !== "everything") return items;
    return items.filter((item) => enabled.has(item.inventoryGroup));
  }

  function mergeKeywords(base: string[] | undefined, extra: string[]): string[] {
    const merged = Array.isArray(base) ? [...base] : [];
    for (const keyword of extra) {
      if (!merged.includes(keyword)) {
        merged.push(keyword);
      }
    }
    return merged;
  }

  onMount(() => {
    hydration.resume();
    // The "Order placed" badges read the orders store, which only the Market
    // tab used to fill; straight-to-inventory sessions saw every item as unlisted.
    void ensureMarketOrdersLoaded();
  });

  onDestroy(() => {
    clearHotsetRefreshTimer();

    hydration.pause();
  });

  $: ({ orderedNames, orderedSlugs } = buildOrderLookups($marketOrders));
  $: incompleteSetBaseItems =
    filter === "full_sets" && showIncompleteSets
      ? buildBaseInventoryItems(
          $parsedItems,
          "incomplete_sets",
          $wfmItems,
          orderedNames,
          orderedSlugs,
          $relicDb,
        )
      : [];
  $: everythingSourceOptions = EVERYTHING_SOURCES.flatMap((source) => {
    const labelKey = FILTERS.find((entry) => entry.key === source)?.labelKey;
    return labelKey ? [{ key: source as string, label: $tr(labelKey) }] : [];
  });
  $: enabledEverythingSources = new Set<string>(everythingSources);
  // Categories are data values, not UI copy, so they stay untranslated here too.
  $: fullSetCategoryOptions =
    filter === "full_sets"
      ? orderedSetCategories(tabBaseItems, $itemDb).map((key) => ({ key, label: key }))
      : [];
  $: enabledSetCategories = new Set<string>(
    fullSetCategoryOptions
      .map((option) => option.key)
      .filter((key) => !hiddenSetCategories.includes(key)),
  );
  $: showEverythingResources = filter === "everything" && enabledEverythingSources.has("resources");
  $: tabBaseItems = limitToEnabledSources(
    [
      ...buildBaseInventoryItems(
        $parsedItems,
        filter,
        $wfmItems,
        orderedNames,
        orderedSlugs,
        $relicDb,
      ),
      ...incompleteSetBaseItems,
    ],
    filter,
    enabledEverythingSources,
  );
  $: allRankedBaseItems = [
    ...buildBaseInventoryItems(
      $parsedItems,
      "mods",
      $wfmItems,
      orderedNames,
      orderedSlugs,
      $relicDb,
    ),
    ...buildBaseInventoryItems(
      $parsedItems,
      "arcanes",
      $wfmItems,
      orderedNames,
      orderedSlugs,
      $relicDb,
    ),
  ];
  $: tabItems = buildInventoryViewItems(tabBaseItems, $hydrationMetrics);
  $: relicSearchKeywordIndex = buildRelicSearchKeywordIndex($relicDb);
  $: searchableTabItems =
    filter !== "relics" && filter !== "everything"
      ? tabItems
      : tabItems.map((item) => {
          const relicKeywords = relicSearchKeywordIndex[item.internalName] || [];
          if (relicKeywords.length === 0) return item;

          return {
            ...item,
            keywords: mergeKeywords(item.keywords, relicKeywords),
          };
        });
  $: selectedItem = selectedInternalName
    ? tabItems.find((entry) => entry.internalName === selectedInternalName) || null
    : null;
  $: partMastery = buildPartMasteryResolver($itemDb, $masteryData);
  $: masteredTabItems = attachPartMasteryFlags(searchableTabItems, partMastery);
  $: sortedTabItems = applySharedFiltersAndSort(masteredTabItems, $inventoryFilters);
  $: filtered =
    filter === "full_sets" && hiddenSetCategories.length > 0
      ? sortedTabItems.filter((item) => enabledSetCategories.has(setCategoryFor(item, $itemDb)))
      : sortedTabItems;
  $: visibleItems =
    $devMode && missingIconsOnly
      ? filtered.filter(
          (item) =>
            !item.displayImageUrl ||
            item.usesFallbackArt ||
            ARCANE_STAND_IN_ART.has(item.internalName) ||
            $degradedIcons.has(item.name),
        )
      : filtered;
  $: resourceList =
    $inventoryData && Object.keys($itemDb).length > 0
      ? parseResources($inventoryData, $itemDb)
      : [];
  function filterAndSortResources(
    list: typeof resourceList,
    filters: typeof $inventoryFilters,
  ): typeof resourceList {
    const search = filters.search.trim().toLowerCase();
    const searched = search
      ? list.filter(
          (r) =>
            r.name.toLowerCase().includes(search) || r.internalName.toLowerCase().includes(search),
        )
      : list;
    const gated =
      filters.minimumAmount > 0
        ? searched.filter((r) => r.count >= filters.minimumAmount)
        : searched;
    const dir = filters.sortDirection === "asc" ? 1 : -1;
    return [...gated].sort((a, b) =>
      filters.sortBy === "amount" ? (a.count - b.count) * dir : a.name.localeCompare(b.name) * dir,
    );
  }

  $: filteredResources = filterAndSortResources(resourceList, $inventoryFilters);
  $: filteredTotalCount =
    filter === "resources"
      ? filteredResources.length
      : visibleItems.length + (showEverythingResources ? filteredResources.length : 0);
  function countActiveAdvancedFilters(state: SharedFiltersState): number {
    let active = 0;
    if (state.orderPlaced !== "all") active++;
    if (state.mastered !== "all") active++;
    if (state.spares !== "all") active++;
    if (state.vaulted !== "all") active++;
    if (state.partType !== "all") active++;
    if (state.favorite !== "all") active++;
    if (state.equipped !== "all") active++;
    if (state.leveledUp !== "all") active++;
    if (state.minimumPlatinum > 0) active++;
    if (state.minimumAmount > 0) active++;
    return active;
  }
  $: activeAdvancedCount = countActiveAdvancedFilters($inventoryFilters);
  $: showDucats = filter === "all_parts" || filter === "full_sets" || filter === "everything";
  $: metricNeeds = metricNeedsFromFilters($inventoryFilters, filter);
  $: wfmItemsLoaded = Object.keys($wfmItems).length > 0;
  $: if ($startupPriceCacheReady && wfmItemsLoaded) {
    prefetchVisibleMetrics(filtered, metricNeeds);
    maybeScheduleRankedHotsetRefresh(allRankedBaseItems);
  }
</script>

<section class="view active">
  <InventoryHeader
    totalCount={filteredTotalCount}
    filters={FILTERS}
    activeFilter={filter}
    {showFilterPanel}
    sortOptions={SORT_OPTIONS_BY_TAB[filter] ?? PRICED_SORT_OPTIONS}
    advancedCount={activeAdvancedCount}
    filtersEnabled={filter !== "resources"}
    on:filter={handleFilterSelect}
    on:toggle={handleToggleFilterPanel}
  >
    {#if showFilterPanel && filter !== "resources"}
      <div
        class="inventory-filter-popover mb-3.5 max-h-[67vh] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--ui-panel-border)] bg-[var(--ui-panel-bg)] p-2.5 shadow-[var(--ui-panel-shadow)] [backdrop-filter:var(--ui-backdrop-blur)]"
      >
        <SharedFilterBar scope="inventory" showBasic={false} showAdvanced={true} />
      </div>
    {/if}
  </InventoryHeader>

  {#if filter === "resources"}
    <ResourcesView resources={filteredResources} />
  {:else}
    <div
      class="grid grid-cols-1 items-start gap-3 {orderBookPanelOpen
        ? 'min-[1101px]:grid-cols-[minmax(0,1fr)_360px]'
        : ''}"
    >
      <div class="min-w-0" data-tour="inventory-grid">
        {#if filter === "everything"}
          <ChipToggleRow
            rowName="everything-sources"
            label={$tr("inventory.everythingInclude")}
            options={everythingSourceOptions}
            enabled={enabledEverythingSources}
            onToggle={(key) => toggleEverythingSource(key as InventoryFilterTab)}
          />
        {/if}
        {#if filter === "full_sets"}
          <ChipToggleRow
            rowName="full-set-categories"
            label={$tr("common.category")}
            options={fullSetCategoryOptions}
            enabled={enabledSetCategories}
            onToggle={toggleSetCategory}
          />
        {/if}
        {#if filter === "full_sets"}
          <label
            class="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary"
          >
            <input
              type="checkbox"
              class="accent-[color:var(--accent)]"
              checked={showIncompleteSets}
              on:change={toggleIncompleteSets}
            />
            {$tr("inventory.showIncompleteSets")}
          </label>
        {/if}
        {#if $devMode}
          <label
            class="mb-2 flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary"
          >
            <input
              type="checkbox"
              class="accent-[color:var(--accent)]"
              bind:checked={missingIconsOnly}
            />
            {$tr("inventory.missingIconsDev")}
          </label>
        {/if}
        <InventoryGrid
          items={visibleItems}
          {showDucats}
          {detailKeys}
          on:select={handleItemSelect}
          on:visible={handleItemVisible}
          on:expand={handleItemExpand}
        />

        {#if showEverythingResources && filteredResources.length > 0}
          <!-- Resources have their own row shape, so Everything appends the real
               Resources list rather than faking inventory cards for them. -->
          <h3 class="mb-2 mt-4 font-display text-sm uppercase tracking-[0.05em] text-text-muted">
            {$tr("nav.resources")}
          </h3>
          <ResourcesView resources={filteredResources} />
        {/if}
      </div>

      {#if orderBookPanelOpen}
        <InventoryOrderBookPanel item={selectedItem} onClose={closeOrderBookPanel} />
      {/if}
    </div>
  {/if}
</section>

<style>
  .inventory-filter-popover :global(.shared-filter-bar) {
    margin-bottom: 0;
  }
  .inventory-filter-popover :global(.shared-filter-controls) {
    align-items: flex-start;
    gap: 0.5rem;
  }
  .inventory-filter-popover :global(.shared-chip-group) {
    flex-direction: column;
    align-items: stretch;
    gap: 0.3rem;
  }
  .inventory-filter-popover :global(.shared-chip-group .filter-tabs) {
    width: 100%;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
</style>
