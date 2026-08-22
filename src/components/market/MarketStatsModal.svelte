<script lang="ts">
  import ModalShell from "../ModalShell.svelte";
  import MarketBrowseStats from "./MarketBrowseStats.svelte";
  import { tr } from "../../lib/i18n.js";

  export let slug: string;
  export let title: string;
  export let onClose: () => void;
</script>

<ModalShell ariaLabel={title} {onClose}>
  <div class="market-stats-panel" data-market-stats-modal>
    <div class="mb-3 flex items-start justify-between gap-2">
      <div class="min-w-0">
        <h3 class="m-0 font-display text-lg text-text-primary">{title}</h3>
        <span class="text-xs text-text-muted">{$tr("browse.tabStatistics")}</span>
      </div>
      <button
        class="btn-secondary btn-sm !px-2"
        aria-label={$tr("common.close")}
        title={$tr("common.close")}
        on:click={onClose}>&times;</button
      >
    </div>
    <MarketBrowseStats {slug} />
  </div>
</ModalShell>

<style>
  /* The chart sizes itself from clientWidth, so the panel needs a real width
     rather than the shrink-to-fit the detail modals use. */
  .market-stats-panel {
    position: relative;
    z-index: 1;
    width: min(1040px, calc(100vw - 3rem));
    max-height: calc(100vh - 6rem);
    overflow-y: auto;
    padding: 1rem;
    border: 1px solid var(--ui-panel-border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    box-shadow: var(--ui-panel-shadow);
  }
</style>
