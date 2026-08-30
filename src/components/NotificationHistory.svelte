<script lang="ts">
  import ModalShell from "./ModalShell.svelte";
  import { locale, tr } from "../lib/i18n.js";
  import { clearNotificationHistory, notificationHistory } from "../stores/notifications.js";

  let { onClose }: { onClose: () => void } = $props();

  // Formatted at render, never stored: a language switch has to repaint it.
  function formatAt(at: string, code: string): string {
    const stamp = new Date(at);
    return Number.isNaN(stamp.getTime()) ? at : stamp.toLocaleString(code);
  }
</script>

<ModalShell ariaLabel={$tr("notifications.title")} {onClose}>
  <div class="detail-panel notification-panel" data-notification-history>
    <div class="mb-3 flex items-start justify-between gap-2">
      <h3 class="m-0 font-display text-lg text-text-primary">{$tr("notifications.title")}</h3>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class="btn-secondary btn-sm"
          data-notification-clear
          disabled={$notificationHistory.length === 0}
          onclick={() => void clearNotificationHistory()}>{$tr("notifications.clearAll")}</button
        >
        <button
          class="btn-secondary btn-sm !px-2"
          data-notification-close
          aria-label={$tr("common.close")}
          title={$tr("common.close")}
          onclick={onClose}>&times;</button
        >
      </div>
    </div>

    {#if $notificationHistory.length === 0}
      <p class="m-0 py-6 text-center text-sm text-text-muted" data-notification-empty>
        {$tr("notifications.empty")}
      </p>
    {:else}
      <ul class="m-0 grid list-none gap-1 p-0">
        {#each $notificationHistory as entry (entry.id)}
          <li
            class="grid grid-cols-[auto_1fr] items-start gap-x-2 rounded-md border border-border px-2.5 py-2"
            data-notification-entry
            data-notification-kind={entry.kind}
          >
            <span class="notification-dot mt-1.5" aria-hidden="true"></span>
            <div class="min-w-0">
              <div class="flex items-baseline justify-between gap-2">
                <span class="truncate text-sm text-text-primary">{entry.title}</span>
                <span class="shrink-0 text-[11px] text-text-muted"
                  >{formatAt(entry.at, $locale)}</span
                >
              </div>
              <p class="m-0 break-words text-xs text-text-muted">{entry.body}</p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</ModalShell>

<style>
  .notification-panel {
    width: min(540px, calc(100vw - 3rem));
    padding: 1rem;
  }
  /* One dot per kind; the list has no room for a legend column. */
  .notification-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 999px;
    background: var(--text-muted);
  }
  [data-notification-kind="trade"] .notification-dot {
    background: var(--success);
  }
  [data-notification-kind="message"] .notification-dot {
    background: var(--info);
  }
  [data-notification-kind="world"] .notification-dot {
    background: var(--accent);
  }
</style>
