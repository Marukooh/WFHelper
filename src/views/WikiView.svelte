<script lang="ts">
  import { onMount } from "svelte";

  import { invoke } from "../lib/ipc.js";
  import { itemDb, componentOwnership } from "../stores/data.js";
  import { addSavedSearch, removeSavedSearch, savedSearches } from "../stores/savedSearches.js";
  import { activeItem } from "../stores/modals.js";
  import { buildItemNameIndex } from "../lib/componentResolution.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import { tr as t } from "../lib/i18n.js";
  import { stripQuantityPrefix } from "../../config/shared/quantityPrefix.js";
  import type { DropRow, DropSearchMode } from "../types/drops.js";

  let query = "";
  let mode: DropSearchMode = "item";
  let rows: DropRow[] = [];
  let total = 0;
  let loading = false;
  let searched = false;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestToken = 0;
  let searchEl: HTMLInputElement | null = null;

  function clearSearch(): void {
    query = "";
    onInput();
    searchEl?.focus();
  }

  // Per-mode lists: an item search saved under "By item" reruns as an item search.
  $: savedStore = savedSearches(`wiki:${mode}`);
  $: currentSearchSaved = $savedStore.some((s) => s.toLowerCase() === query.trim().toLowerCase());

  function applySavedSearch(text: string): void {
    query = text;
    void runSearch();
  }

  const RARITY_COLOUR: Record<string, string> = {
    Common: "var(--rarity-common)",
    Uncommon: "var(--rarity-uncommon)",
    Rare: "var(--rarity-rare)",
    Legendary: "var(--rarity-rare)",
  };

  function formatChance(chance: number): string {
    if (!Number.isFinite(chance)) return "";
    const rounded = Math.round(chance * 100) / 100;
    return `${rounded}%`;
  }

  async function runSearch(): Promise<void> {
    const q = query.trim();
    if (!q) {
      rows = [];
      total = 0;
      searched = false;
      return;
    }
    const token = ++requestToken;
    loading = true;
    try {
      const result = await invoke("searchDrops", q, mode);
      if (token !== requestToken) return; // a newer search superseded this one
      rows = result.rows;
      total = result.total;
      searched = true;
    } finally {
      if (token === requestToken) loading = false;
    }
  }

  function onInput(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    requestToken += 1;
    loading = false;
    if (!query.trim()) {
      rows = [];
      total = 0;
      searched = false;
      return;
    }
    debounceTimer = setTimeout(runSearch, 250);
  }

  function setMode(next: DropSearchMode): void {
    if (mode === next) return;
    mode = next;
    void runSearch();
  }

  // Map display names back to itemDb entries for detail modals. Rows without an
  // entry remain non-clickable.
  $: nameIndex = buildItemNameIndex($itemDb);

  function openItem(name: string): void {
    // Bundled rows like "2X Orokin Cell" carry a quantity prefix the db lacks.
    const uniqueName = nameIndex.get(name) ?? nameIndex.get(stripQuantityPrefix(name));
    if (!uniqueName) return;
    const entry = $itemDb[uniqueName];
    if (!entry) return;
    activeItem.set(buildParsedItemFromDb(uniqueName, entry, $componentOwnership));
  }

  onMount(() => () => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });
</script>

<section class="view active">
  <div class="mx-auto flex w-full max-w-[1040px] flex-col gap-4 py-4">
    <header class="view-header mb-0">
      <div class="flex flex-col gap-1">
        <h2>{$t("wiki.title")}</h2>
        <p class="m-0 text-sm text-text-secondary">
          {$t("wiki.description")}
        </p>
      </div>
    </header>

    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-[240px] flex-1">
        <input
          type="search"
          class="w-full rounded-lg border border-border bg-bg-soft px-3 py-2 pr-8 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent [&::-webkit-search-cancel-button]:hidden"
          placeholder={mode === "item"
            ? $t("wiki.searchPlaceholderItem")
            : $t("wiki.searchPlaceholderPlace")}
          bind:value={query}
          bind:this={searchEl}
          on:input={onInput}
          autocomplete="off"
          spellcheck="false"
          data-search-focus
        />
        {#if query}
          <button
            type="button"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer rounded border-0 bg-transparent px-1.5 py-0.5 text-base leading-none text-text-muted hover:text-text-primary"
            aria-label={$t("common.clearSearch")}
            on:click={clearSearch}>&times;</button
          >
        {/if}
      </div>
      <button
        type="button"
        class="shrink-0 rounded-lg border border-border px-3 py-2 text-sm disabled:cursor-default disabled:opacity-40 {currentSearchSaved
          ? 'bg-accent-glow text-accent'
          : 'bg-bg-soft text-text-secondary hover:text-text-primary'}"
        disabled={!query.trim()}
        title={currentSearchSaved ? $t("wiki.searchAlreadySaved") : $t("wiki.saveSearch")}
        on:click={() => addSavedSearch(`wiki:${mode}`, query)}>★</button
      >
      <div class="flex shrink-0 overflow-hidden rounded-lg border border-border">
        <button
          type="button"
          class="px-3 py-2 text-sm font-display {mode === 'item'
            ? 'bg-accent-glow text-accent'
            : 'bg-bg-soft text-text-secondary hover:text-text-primary'}"
          on:click={() => setMode("item")}>{$t("wiki.byItem")}</button
        >
        <button
          type="button"
          class="border-l border-border px-3 py-2 text-sm font-display {mode === 'place'
            ? 'bg-accent-glow text-accent'
            : 'bg-bg-soft text-text-secondary hover:text-text-primary'}"
          on:click={() => setMode("place")}>{$t("wiki.byLocation")}</button
        >
      </div>
    </div>

    {#if $savedStore.length > 0}
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs uppercase tracking-[0.05em] text-text-muted">{$t("common.saved")}</span
        >
        {#each $savedStore as s (s)}
          <span
            class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm {query.trim() ===
            s
              ? 'border-accent/50 bg-accent-glow text-accent'
              : 'border-border bg-bg-soft text-text-secondary'}"
          >
            <button
              type="button"
              class="cursor-pointer border-0 bg-transparent p-0 text-inherit hover:text-text-primary"
              title={$t("wiki.searchThis")}
              on:click={() => applySavedSearch(s)}>{s}</button
            >
            <button
              type="button"
              class="cursor-pointer border-0 bg-transparent p-0 text-inherit opacity-60 hover:opacity-100"
              title={$t("wiki.removeSearch")}
              on:click={() => removeSavedSearch(`wiki:${mode}`, s)}>×</button
            >
          </span>
        {/each}
      </div>
    {/if}

    {#if loading && rows.length === 0}
      <div
        class="rounded-lg border border-dashed border-border bg-bg-soft px-3 py-6 text-center text-sm text-text-secondary"
      >
        {$t("common.searching")}
      </div>
    {:else if !searched}
      <div
        class="rounded-lg border border-dashed border-border bg-bg-soft px-3 py-6 text-center text-sm text-text-secondary"
      >
        {$t("wiki.typeToSearch")}
      </div>
    {:else if rows.length === 0}
      <div
        class="rounded-lg border border-dashed border-border bg-bg-soft px-3 py-6 text-center text-sm text-text-secondary"
      >
        {$t("wiki.noResults", { query: query.trim() })}
      </div>
    {:else}
      <div class="overflow-hidden rounded-lg border border-border">
        <table class="w-full border-collapse text-sm">
          <thead>
            <tr class="bg-bg-soft text-left text-xs uppercase tracking-[0.05em] text-text-muted">
              <th class="px-3 py-2 font-medium">{$t("common.item")}</th>
              <th class="px-3 py-2 font-medium">{$t("wiki.col.dropsFrom")}</th>
              <th class="px-3 py-2 text-right font-medium">{$t("wiki.col.rarity")}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.item + "|" + row.place + "|" + row.rarity + "|" + row.chance)}
              <tr class="border-t border-border/60 hover:bg-bg-hover">
                <td class="px-3 py-1.5">
                  {#if nameIndex.has(row.item) || nameIndex.has(stripQuantityPrefix(row.item))}
                    <button
                      type="button"
                      class="cursor-pointer border-0 bg-transparent p-0 text-left text-text-primary hover:text-accent hover:underline"
                      on:click={() => openItem(row.item)}>{row.item}</button
                    >
                  {:else}
                    <span class="text-text-primary">{row.item}</span>
                  {/if}
                </td>
                <td class="px-3 py-1.5 text-text-secondary">{row.place}</td>
                <td class="px-3 py-1.5 text-right whitespace-nowrap">
                  <span
                    class="font-semibold"
                    style="color:{RARITY_COLOUR[row.rarity] ?? 'var(--text-muted)'}"
                    >{row.rarity}</span
                  >
                  <span class="ml-1.5 text-accent">{formatChance(row.chance)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if total > rows.length}
        <p class="m-0 text-center text-xs text-text-muted">
          {$t("wiki.showingResults", { shown: rows.length, total })}
        </p>
      {/if}
    {/if}
  </div>
</section>
