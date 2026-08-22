<script lang="ts">
  export let label: string;
  export let options: Array<{ key: string; label: string }> = [];
  /** Keys currently switched on. Anything absent renders as off. */
  export let enabled: ReadonlySet<string>;
  export let onToggle: (key: string) => void;
  /** Identifies this row for tests; individual chips carry data-chip. */
  export let rowName: string;
</script>

{#if options.length > 0}
  <div class="mb-2 flex flex-wrap items-center gap-2" data-chip-row={rowName}>
    <span class="text-xs uppercase tracking-[0.05em] text-text-muted">{label}</span>
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
