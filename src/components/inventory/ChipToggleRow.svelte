<script lang="ts">
  export let label: string;
  export let options: Array<{ key: string; label: string }> = [];
  /** Keys switched on; callers persist the complement so later additions default on. */
  export let enabled: ReadonlySet<string>;
  export let onToggle: (key: string) => void;
  /** Identifies this row for tests; individual chips carry data-chip. */
  export let rowName: string;
</script>

{#if options.length > 0}
  <div class="shared-chip-group shared-chip-group--wrap mb-2 w-fit" data-chip-row={rowName}>
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
