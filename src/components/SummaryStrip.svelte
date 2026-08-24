<script context="module" lang="ts">
  export type SummaryStripItem = {
    key: string;
    label: string;
    value: string | number;
    tone?: "default" | "success" | "warning" | "danger";
    icon?: string | null;
    subtext?: string;
    subtextTone?: "default" | "success" | "warning" | "danger";
  };
</script>

<script lang="ts">
  import ThemedPanel from "./ThemedPanel.svelte";

  export let items: SummaryStripItem[] = [];
  export let variant: "stats" | "mastery" | "grid" = "stats";

  function toneClass(tone: SummaryStripItem["tone"]): string {
    if (tone === "success") return "text-success";
    if (tone === "warning") return "text-warning";
    if (tone === "danger") return "text-danger";
    return "text-text-primary";
  }

  function subtextToneClass(tone: SummaryStripItem["subtextTone"]): string {
    return tone && tone !== "default" ? toneClass(tone) : "text-text-secondary";
  }
</script>

<ThemedPanel
  className={variant === "mastery"
    ? "flex w-full min-w-0 flex-wrap items-stretch px-5 py-3"
    : variant === "grid"
      ? "grid [grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))] gap-x-8 gap-y-4 px-6 py-4"
      : "flex flex-wrap items-stretch gap-y-2 px-4 py-3"}
>
  {#if $$slots.leading && variant !== "grid"}
    <div class="flex shrink-0 items-center pr-4"><slot name="leading" /></div>
  {/if}

  {#each items as item, index (item.key)}
    {#if (index > 0 || $$slots.leading) && variant !== "grid"}
      <span class="self-stretch w-px bg-[color:var(--ui-panel-border)]" aria-hidden="true"></span>
    {/if}

    {#if variant === "grid"}
      <!-- Stacked cells in even columns: wraps whole cells, never mid-strip. -->
      <div class="flex min-w-0 flex-col gap-1.5">
        <span
          class="whitespace-nowrap text-xs font-semibold uppercase tracking-wide text-text-muted"
        >
          {item.label}
        </span>
        <span
          class="font-display whitespace-nowrap text-3xl font-bold leading-none {toneClass(
            item.tone,
          )}"
        >
          {item.value}
        </span>
        {#if item.subtext}
          <span class="text-xs font-semibold {subtextToneClass(item.subtextTone)}"
            >{item.subtext}</span
          >
        {/if}
      </div>
    {:else if variant === "mastery"}
      <!-- Full-width strip: cells stay compact so a fullscreen row does not
           blow the numbers up past the cards it sits above. -->
      <div class="flex flex-col justify-center gap-1 px-4">
        <div class="flex items-center gap-3">
          <span class="font-display text-3xl font-bold leading-none {toneClass(item.tone)}"
            >{item.value}</span
          >
          <span class="text-base font-semibold text-text-secondary">{item.label}</span>
        </div>
        {#if item.subtext}
          <span class="text-sm font-semibold {subtextToneClass(item.subtextTone)}"
            >{item.subtext}</span
          >
        {/if}
      </div>
    {:else}
      <!-- min-w-fit so nowrap cells never paint into their neighbor -->
      <div class="flex min-w-fit flex-1 items-center gap-2.5 px-3.5">
        {#if item.icon}
          <img src={item.icon} alt="" class="h-8 w-8 shrink-0 object-contain opacity-90" />
        {/if}
        <div class="flex flex-1 flex-col gap-1">
          <div class="flex items-baseline gap-2 flex-wrap">
            <!-- nowrap so labels can't collide with values in image captures -->
            <span
              class="whitespace-nowrap text-sm font-semibold uppercase tracking-wide text-text-primary"
            >
              {item.label}
            </span>
            <span
              class="whitespace-nowrap text-xl font-bold leading-none tracking-tight {toneClass(
                item.tone,
              )}"
            >
              {item.value}
            </span>
          </div>
          {#if item.subtext}
            <span class="text-xs font-semibold {subtextToneClass(item.subtextTone)}"
              >{item.subtext}</span
            >
          {/if}
        </div>
      </div>
    {/if}
  {/each}
</ThemedPanel>
