<script lang="ts">
  import { onMount } from "svelte";

  import { invoke } from "../lib/ipc.js";
  import { tr, type MessageKey } from "../lib/i18n.js";
  import type { DisplayPreference, LinuxDisplayInfo } from "../../config/shared/linuxDisplay.js";

  const OPTIONS: Array<{ value: DisplayPreference; labelKey: MessageKey; hintKey: MessageKey }> = [
    {
      value: "auto",
      labelKey: "settings.linuxDisplayAuto",
      hintKey: "settings.linuxDisplayAutoHint",
    },
    {
      value: "x11",
      labelKey: "settings.linuxDisplayX11",
      hintKey: "settings.linuxDisplayX11Hint",
    },
    {
      value: "wayland",
      labelKey: "settings.linuxDisplayWayland",
      hintKey: "settings.linuxDisplayWaylandHint",
    },
  ];

  let info: LinuxDisplayInfo | null = null;
  let changed = false;

  onMount(async () => {
    info = await invoke("getLinuxDisplay");
  });

  async function choose(preference: DisplayPreference): Promise<void> {
    if (!info || info.preference === preference) return;
    info = await invoke("setLinuxDisplay", preference);
    changed = true;
  }
</script>

<div>
  <h3
    class="m-0 mb-1.5 font-display text-[var(--font-heading-size,0.95rem)] font-semibold tracking-[0.03em] text-text-primary"
  >
    {$tr("settings.linuxDisplayTitle")}
  </h3>
  <p class="text-[var(--font-small-size,0.82rem)] text-text-secondary">
    {$tr("settings.linuxDisplayDesc")}
  </p>
</div>

{#if info?.noXServer}
  <p class="mt-2 text-[var(--font-small-size,0.82rem)] text-warning">
    {$tr("settings.linuxDisplayNoXServer")}
  </p>
{/if}

<div class="mt-2.5 flex flex-wrap gap-2">
  {#each OPTIONS as option (option.value)}
    <button
      class={info?.preference === option.value ? "btn-primary btn-sm" : "btn-secondary btn-sm"}
      title={$tr(option.hintKey)}
      disabled={!info}
      on:click={() => choose(option.value)}>{$tr(option.labelKey)}</button
    >
  {/each}
</div>

{#if changed}
  <p class="mt-2 text-[var(--font-small-size,0.82rem)] text-warning">
    {$tr("settings.linuxDisplayRestartToApply")}
  </p>
{/if}
