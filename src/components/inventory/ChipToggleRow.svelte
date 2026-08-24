<script lang="ts">
  export let label: string;
  export let options: Array<{ key: string; label: string }> = [];
  /**
   * Keys currently switched on. Anything absent renders as off; callers persist
   * the complement so a key a later release adds defaults to on.
   */
  export let enabled: ReadonlySet<string>;
  export let onToggle: (key: string) => void;
  /** Identifies this row for tests; individual chips carry data-chip. */
  export let rowName: string;
</script>

{#if options.length > 0}
  <div class="shared-chip-group mb-2 flex w-fit" data-chip-row={rowName}>
    <span class="shared-chip-label">{label}</span>
    <div class="filter-tabs">
      {#each options as option (option.key)}
        <button
          class="filter-tab"
          class:active={enabled.has(option.key)}
          aria-pressed={enabled.has(option.key)}
          data-chip={option.key}
          on:click={() => onToggle(option.key)}>{option.label}</button
        >
      {/each}
    </div>
  </div>
{/if}

<style>
  /* Filter-bar chip groups hold a handful of chips; these rows carry a whole
     category list, so they wrap instead of overflowing the view. */
  .filter-tabs {
    flex-wrap: wrap;
  }
</style>
