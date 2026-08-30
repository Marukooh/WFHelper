<script lang="ts">
  import { currentView } from "../stores/app.js";
  import { invoke, send } from "../lib/ipc.js";
  import { tr } from "../lib/i18n.js";
  import { NAV_ICON_URLS } from "../lib/assetUrls.js";
  import { persistedBoolean } from "../lib/persistence.js";
  import { devMode } from "../stores/devMode.js";
  import { hiddenTabs } from "../stores/sidebarTabs.js";
  import { resetTourAutoStart } from "../stores/tour.js";
  import type { MessageKey } from "../lib/i18n.js";
  import type { ViewName } from "../types/views.js";
  import { SIDEBAR_VIEW_ORDER, VIEW_LABEL_KEYS } from "../lib/viewRegistry.js";

  const collapsed = persistedBoolean("sidebar.collapsed", false);
  $: showDevTools = $devMode;

  function toggleCollapsed(): void {
    collapsed.update((value) => !value);
  }

  interface NavItem {
    view: ViewName;
    labelKey: MessageKey;
    icon: string;
  }

  const navItems: NavItem[] = SIDEBAR_VIEW_ORDER.map((view) => ({
    view,
    labelKey: VIEW_LABEL_KEYS[view],
    icon: NAV_ICON_URLS[view],
  }));

  $: visibleNavItems = navItems.filter((item) => !$hiddenTabs.has(item.view));

  // If the active tab gets hidden, fall back to inventory so we never strand
  // the user on a view with no way back to it.
  $: if ($hiddenTabs.has($currentView)) currentView.set("inventory");

  async function loadInventoryFile(): Promise<void> {
    // seeds the helper source without claiming it - Settings owns the switch
    const result = await invoke("openInventoryFile", "helper");
    if (result) currentView.set("inventory");
  }

  function toggleOverlay(): void {
    send("toggle-overlay");
  }

  function testOverlay(): void {
    send("simulate-relic-trigger");
  }

  function testNotification(): void {
    void invoke("sendTestNotification");
  }
</script>

<nav
  id="sidebar"
  class="sidebar-shell flex min-h-0 shrink-0 flex-col justify-between gap-2 overflow-y-auto overflow-x-hidden border-r border-border bg-bg-base px-2.5 py-3.5 {$collapsed
    ? 'w-[3.75rem]'
    : 'w-[var(--sidebar-width)]'}"
  class:sidebar-collapsed={$collapsed}
>
  <div class="flex flex-col gap-0.5">
    <button
      class="nav-btn nav-btn-collapse relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
      title={$collapsed ? $tr("nav.expandSidebar") : $tr("nav.collapseSidebar")}
      aria-label={$collapsed ? $tr("nav.expandSidebar") : $tr("nav.collapseSidebar")}
      on:click={toggleCollapsed}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="h-5 w-5 shrink-0 transition-transform duration-150 {$collapsed ? 'rotate-180' : ''}"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
      <span>{$tr("nav.collapse")}</span>
    </button>
    {#each visibleNavItems as item}
      <button
        data-view={item.view}
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 px-3.5 py-2.5 font-display text-base font-medium tracking-wide transition-colors duration-150 {$currentView ===
        item.view
          ? "bg-accent-glow text-accent before:content-[''] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-1 before:rounded-r before:bg-accent max-[800px]:before:hidden"
          : 'bg-transparent text-text-secondary hover:bg-bg-hover hover:text-text-primary'}"
        aria-current={$currentView === item.view ? "page" : undefined}
        on:click={() => currentView.set(item.view)}
      >
        <img src={item.icon} alt="" class="h-6 w-6 shrink-0 object-contain brightness-[0.85]" />
        <span>{$tr(item.labelKey)}</span>
      </button>
    {/each}
  </div>

  {#if showDevTools}
    <div class="mt-2 flex flex-col gap-0.5">
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
        title={$tr("nav.previewSetupWizard")}
        on:click={() => {
          resetTourAutoStart();
          currentView.set("setup");
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <rect x="4" y="5" width="16" height="14" rx="2" />
          <path d="M8 9h8M8 13h5M16 13h1" />
        </svg>
        <span>{$tr("nav.setup")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-muted transition-colors duration-150 hover:bg-bg-hover hover:text-text-secondary"
        title={$tr("nav.testTitle")}
        on:click={testOverlay}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <path d="M9 3h6l1 6-3.5 2L16 21H8l3.5-10L8 9l1-6z" />
        </svg>
        <span>{$tr("nav.test")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
        title={$tr("nav.overlayTitle")}
        on:click={toggleOverlay}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <polygon points="12,2 22,12 12,22 2,12" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
        <span>{$tr("nav.overlay")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
        title={$tr("nav.testNotificationTitle")}
        data-test-notification
        on:click={testNotification}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <path d="M18 16V11a6 6 0 10-12 0v5l-2 3h16l-2-3z" />
          <path d="M10 21h4" />
        </svg>
        <span>{$tr("nav.testNotification")}</span>
      </button>
      <button
        class="nav-btn relative flex w-full cursor-pointer items-center gap-3 rounded-md border-0 bg-transparent px-3.5 py-2.5 font-display text-base font-medium tracking-wide text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
        on:click={loadInventoryFile}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          class="h-6 w-6 shrink-0"
        >
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span>{$tr("nav.loadJson")}</span>
      </button>
    </div>
  {/if}
</nav>

<style>
  .sidebar-collapsed :global(.nav-btn span) {
    display: none;
  }
  .sidebar-collapsed :global(.nav-btn) {
    justify-content: center;
    padding-left: 0.5rem;
    padding-right: 0.5rem;
    gap: 0;
  }
  @media (max-width: 800px) {
    .nav-btn :global(span) {
      display: none;
    }
    .nav-btn {
      justify-content: center;
      padding-left: 0.625rem;
      padding-right: 0.625rem;
    }
  }
</style>
