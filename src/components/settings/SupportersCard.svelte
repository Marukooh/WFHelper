<script lang="ts">
  import { onMount } from "svelte";
  import { tr } from "../../lib/i18n.js";
  import SettingsSection from "./SettingsSection.svelte";
  import {
    loadSupporters,
    SUPPORTER_TIER_ORDER,
    type Supporter,
    type SupporterTier,
  } from "../../lib/supporters.js";

  // Patreon tier product names, shown as-is in every locale.
  const TIER_LABELS: Record<SupporterTier, string> = {
    biggest: "Biggest Supporter",
    big: "Big Supporter",
    basic: "Basic",
  };

  let supporters: Supporter[] = $state([]);

  onMount(() => {
    void loadSupporters().then((list) => {
      supporters = list;
    });
  });

  const groups = $derived(
    SUPPORTER_TIER_ORDER.map((tier) => ({
      tier,
      label: TIER_LABELS[tier],
      names: supporters.filter((entry) => entry.tier === tier).map((entry) => entry.name),
    })).filter((group) => group.names.length > 0),
  );
</script>

{#if groups.length > 0}
  <SettingsSection
    title={$tr("settings.supportersTitle")}
    description={$tr("settings.supportersDesc")}
  >
    <div class="mt-2.5 grid gap-2.5" data-supporters>
      {#each groups as group (group.tier)}
        <div>
          <div
            class="mb-1 text-[var(--font-small-size,0.82rem)] font-semibold uppercase tracking-[0.05em] text-text-muted"
          >
            {group.label}
          </div>
          <div class="flex flex-wrap gap-1.5">
            <!-- Index key: patron display names are not unique and a duplicate
                 keyed entry is a fatal error in Svelte 5. -->
            {#each group.names as name, i (i)}
              <span
                class="rounded-full border border-accent-dim bg-accent-glow px-2.5 py-0.5 text-[var(--font-small-size,0.82rem)] text-text-primary"
                >{name}</span
              >
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </SettingsSection>
{/if}
