<script lang="ts">
  import CollapsibleSection from "../CollapsibleSection.svelte";
  import { nextDailyResetUtc, nextWeeklyResetUtc, parseIsoDate, timeTo } from "../../lib/format.js";
  import { tr, type MessageKey, type Translator } from "../../lib/i18n.js";
  import { send } from "../../lib/ipc.js";
  import { clockStore } from "../../lib/timers.js";
  import { buildWikiUrl } from "../../lib/wikiUrl.js";
  import { componentOwnership, inventoryData, itemDb } from "../../stores/data.js";
  import { activeItem } from "../../stores/modals.js";
  import { buildParsedItemFromDb } from "../../lib/parsedItemFromDb.js";
  import { worldData } from "../../stores/world.js";
  import type { NightwaveChallenge, WorldAlert } from "../../types/world.js";
  import { resolveCircuitChoices, type CircuitChoice } from "../../lib/world.js";
  import IconButtonCard from "./IconButtonCard.svelte";
  import WorldToggleIcon from "./WorldToggleIcon.svelte";
  import {
    addCustomTask,
    expiryPeriodKey,
    loadTracker,
    pruneDynamicProgress,
    removeCustomTask,
    saveTracker,
    setTrackerCount,
    setTrackerPeriod,
    setTrackerTarget,
    toggleTrackerHidden,
    trackerCount,
    trackerGroup,
    trackerList,
    trackerPeriodKey,
    type TrackerGroup,
    type TrackerState,
    type TrackerUserPeriod,
  } from "../../lib/world/dailies.js";
  import { trackerExpiries, trackerLive } from "../../lib/world/dailiesLive.js";
  import { loadCollapsedSections, toggleCollapsedSection } from "../../lib/world/useWorldView.js";

  const GROUP_TITLES: Record<TrackerGroup, MessageKey> = {
    daily: "dailies.groupDaily",
    nightwave: "dailies.groupNightwave",
    weekly: "dailies.groupWeekly",
    vendors: "dailies.groupVendors",
    alerts: "dailies.groupAlerts",
  };
  /** Under an hour reads as warning, under ten minutes as danger. */
  const URGENT_MS = 60 * 60_000;
  const CRITICAL_MS = 10 * 60_000;

  const clock = clockStore(1000);

  let tracker = $state<TrackerState>(loadTracker());
  let collapsed = $state<Record<string, boolean>>(loadCollapsedSections());
  let editing = $state(false);
  let expanded = $state<Record<string, boolean>>({});
  let draftLabel = $state("");
  let draftPeriod = $state<TrackerUserPeriod>("daily");

  const nowMs = $derived($clock);
  const now = $derived(new Date(nowMs));
  const wd = $derived($worldData);
  const expiries = $derived(trackerExpiries(wd));

  interface Row {
    kind: "task" | "header";
    id: string;
    label: string;
    detail?: string | undefined;
    lines?: string[] | undefined;
    /** Circuit rewards, shown as an owned-marked icon strip when expanded. */
    circuit?: CircuitChoice[] | undefined;
    badge?: string | undefined;
    group: TrackerGroup;
    periodKey: string | null;
    count: number;
    target: number;
    done: boolean;
    hidden: boolean;
    custom: boolean;
    /** Nightwave acts and alerts rotate away, so they are not customisable. */
    dynamic: boolean;
    /** Only plain daily/weekly tasks may be retimed; the rest follow the game. */
    retimeable: boolean;
    period: string;
    wiki?: string | undefined;
    expiry?: string | null | undefined;
  }

  function taskRow(base: Partial<Row> & Pick<Row, "id" | "label" | "group" | "periodKey">): Row {
    const target = base.target ?? 1;
    const count = trackerCount(tracker, base.id, base.periodKey);
    return {
      kind: "task",
      count,
      target,
      done: count >= target,
      hidden: tracker.hidden.includes(base.id),
      custom: false,
      dynamic: false,
      retimeable: false,
      period: base.period ?? "",
      ...base,
    };
  }

  const circuitRewards = $derived({
    circuitNormal: resolveCircuitChoices(circuitChoices("normal"), $itemDb, $inventoryData),
    circuitSteelPath: resolveCircuitChoices(circuitChoices("hard"), $itemDb, $inventoryData),
  });

  function openReward(choice: CircuitChoice): void {
    const entry = $itemDb[choice.uniqueName];
    if (!entry) return;
    activeItem.set(buildParsedItemFromDb(choice.uniqueName, entry, $componentOwnership));
  }

  function circuitChoices(category: string): string[] {
    return (wd?.duviriCycle?.choices ?? []).find((set) => set.category === category)?.choices ?? [];
  }

  function builtinRows(t: Translator): Row[] {
    return trackerList(tracker).map((task) => {
      const periodKey = trackerPeriodKey(task.period, now, expiries);
      const live = task.label ? {} : trackerLive(task.id, wd, t, nowMs);
      const row = taskRow({
        id: task.id,
        label: task.label ?? t(`dailies.task.${task.id}` as MessageKey),
        group: trackerGroup(task.period),
        periodKey,
        target: task.target,
        wiki: task.wiki,
        period: task.period,
      });
      const circuit =
        task.id === "circuitNormal" || task.id === "circuitSteelPath"
          ? circuitRewards[task.id]
          : [];
      return {
        ...row,
        custom: Boolean(task.label),
        retimeable: task.period === "daily" || task.period === "weekly",
        detail: live.detail,
        lines: live.lines?.length ? live.lines : undefined,
        circuit: circuit.length > 0 ? circuit : undefined,
        expiry: live.expiry,
      };
    });
  }

  function nightwaveRows(t: Translator): Row[] {
    const season = wd?.nightwave;
    if (!season || season.challenges.length === 0) return [];
    const ordered: NightwaveChallenge[] = [...season.challenges].sort(
      (a, b) => rank(a.isDaily, a.isElite) - rank(b.isDaily, b.isElite),
    );
    const rows: Row[] = [];
    let lastHeader = "";
    for (const act of ordered) {
      const header = act.isDaily ? "nwDaily" : act.isElite ? "nwElite" : "nwWeekly";
      if (header !== lastHeader) {
        lastHeader = header;
        rows.push({
          ...taskRow({ id: `nwhead:${header}`, label: "", group: "nightwave", periodKey: null }),
          kind: "header",
          label: t(`dailies.${header}` as MessageKey),
        });
      }
      rows.push({
        ...taskRow({
          id: `nw:${act.id}`,
          label: act.title,
          group: "nightwave",
          periodKey: expiryPeriodKey("nw", act.expiry),
        }),
        dynamic: true,
        detail: act.description,
        badge: t("dailies.standing", { amount: act.standing.toLocaleString() }),
        expiry: act.expiry,
      });
    }
    return rows;
  }

  function rank(isDaily: boolean, isElite: boolean): number {
    if (isDaily) return 0;
    return isElite ? 2 : 1;
  }

  function alertRows(t: Translator): Row[] {
    return (wd?.alerts ?? []).map((alert: WorldAlert) => {
      const rewards = [
        ...alert.items.map((item) => (item.count > 1 ? `${item.count}x ${item.name}` : item.name)),
        alert.credits > 0
          ? t("world.creditsAmount", { amount: alert.credits.toLocaleString() })
          : "",
      ].filter(Boolean);
      return {
        ...taskRow({
          id: `alert:${alert.id}`,
          label: `${alert.mission} - ${alert.node}`,
          group: "alerts",
          periodKey: expiryPeriodKey("alert", alert.expiry),
        }),
        dynamic: true,
        detail: rewards.join(" - "),
        badge: t("dailies.levelRange", {
          min: String(alert.minLevel),
          max: String(alert.maxLevel),
        }),
        expiry: alert.expiry,
      };
    });
  }

  const rows = $derived<Row[]>([...builtinRows($tr), ...nightwaveRows($tr), ...alertRows($tr)]);

  const liveIds = $derived(new Set(rows.filter((row) => row.kind === "task").map((row) => row.id)));

  function commit(next: TrackerState): void {
    const pruned = pruneDynamicProgress(next, liveIds);
    tracker = pruned;
    saveTracker(pruned);
  }

  function toggleSection(key: string): void {
    collapsed = toggleCollapsedSection(collapsed, key);
  }

  function groupRows(group: TrackerGroup): Row[] {
    if (tracker.hidden.includes(`section:${group}`) && !editing) return [];
    const visible = rows.filter(
      (row) => row.group === group && (editing || row.kind === "header" || !row.hidden),
    );
    // A header left with no task under it would render as a stray label.
    return visible.filter(
      (row, index) => row.kind === "task" || visible[index + 1]?.kind === "task",
    );
  }

  function toggleDone(row: Row): void {
    commit(setTrackerCount(tracker, row.id, row.periodKey, row.done ? 0 : row.target));
  }

  function bump(row: Row, delta: number): void {
    commit(setTrackerCount(tracker, row.id, row.periodKey, row.count + delta));
  }

  function addDraft(): void {
    const next = addCustomTask(tracker, draftLabel, draftPeriod);
    if (next === tracker) return;
    draftLabel = "";
    commit(next);
  }

  function countdown(expiry: string | null | undefined): string {
    const date = parseIsoDate(expiry ?? null);
    return date ? timeTo(date, nowMs) : "";
  }

  function remainingMs(expiry: string | null | undefined): number {
    const date = parseIsoDate(expiry ?? null);
    return date ? date.getTime() - nowMs : Number.POSITIVE_INFINITY;
  }

  function groupMeta(group: TrackerGroup): string {
    const parts: string[] = [];
    if (group === "daily") {
      parts.push($tr("dailies.resetsIn", { time: timeTo(nextDailyResetUtc(now), nowMs) }));
    } else if (group === "weekly") {
      parts.push($tr("dailies.resetsIn", { time: timeTo(nextWeeklyResetUtc(now), nowMs) }));
    } else if (group === "nightwave" && wd?.nightwave) {
      parts.push(
        $tr("dailies.seasonEnds", {
          season: String(wd.nightwave.season),
          time: countdown(wd.nightwave.expiry),
        }),
      );
    }
    const shown = rows.filter((row) => row.kind === "task" && row.group === group && !row.hidden);
    if (shown.length > 0) {
      const done = shown.filter((row) => row.done).length;
      parts.push(
        done === shown.length
          ? $tr("dailies.allDone")
          : $tr("dailies.groupProgress", { done: String(done), total: String(shown.length) }),
      );
    }
    return parts.join(" - ");
  }
</script>

{#snippet section(group: TrackerGroup)}
  {@const list = groupRows(group)}
  {#if list.length > 0}
    {@const sectionHidden = tracker.hidden.includes(`section:${group}`)}
    <div class="dailies-section" class:dailies-section--off={sectionHidden}>
      <CollapsibleSection
        title={$tr(GROUP_TITLES[group])}
        collapsed={collapsed[`dailies-${group}`]}
        onToggle={() => toggleSection(`dailies-${group}`)}
      >
        <div class="dailies-meta" data-task-meta={group}>
          <span>{groupMeta(group)}</span>
          {#if editing && (group === "nightwave" || group === "alerts")}
            <button
              class="dailies-icon"
              title={sectionHidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
              aria-label={sectionHidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
              onclick={() => commit(toggleTrackerHidden(tracker, `section:${group}`))}
              >{sectionHidden ? "+" : "x"}</button
            >
          {/if}
        </div>

        {#each list as row (row.id)}
          {#if row.kind === "header"}
            <p class="dailies-subhead">{row.label}</p>
          {:else}
            {@const left = remainingMs(row.expiry)}
            <div class="dailies-row" class:dailies-row--off={row.hidden}>
              <label class="dailies-label">
                <input
                  type="checkbox"
                  class="dailies-check"
                  checked={row.done}
                  data-task={row.id}
                  onchange={() => toggleDone(row)}
                />
                <span class="min-w-0">
                  <span class="dailies-name" class:dailies-name--done={row.done}>{row.label}</span>
                  {#if row.detail}
                    <span class="dailies-detail">{row.detail}</span>
                  {/if}
                </span>
              </label>

              {#if row.badge}
                <span class="dailies-badge">{row.badge}</span>
              {/if}

              {#if row.target > 1}
                <div class="flex shrink-0 items-center gap-1">
                  <button
                    class="dailies-step"
                    title={$tr("dailies.decrement")}
                    aria-label={$tr("dailies.decrement")}
                    onclick={() => bump(row, -1)}>-</button
                  >
                  <span class="w-8 text-center font-display text-xs text-text-primary"
                    >{row.count}/{row.target}</span
                  >
                  <button
                    class="dailies-step"
                    title={$tr("dailies.increment")}
                    aria-label={$tr("dailies.increment")}
                    onclick={() => bump(row, 1)}>+</button
                  >
                </div>
              {/if}

              {#if row.expiry}
                <span
                  class="dailies-time"
                  class:dailies-time--warn={left < URGENT_MS}
                  class:dailies-time--crit={left < CRITICAL_MS}>{countdown(row.expiry)}</span
                >
              {/if}

              {#if row.lines || row.circuit}
                <button
                  class="dailies-icon"
                  title={expanded[row.id] ? $tr("dailies.collapse") : $tr("dailies.expand")}
                  aria-label={expanded[row.id] ? $tr("dailies.collapse") : $tr("dailies.expand")}
                  aria-expanded={Boolean(expanded[row.id])}
                  data-task-expand={row.id}
                  onclick={() => (expanded = { ...expanded, [row.id]: !expanded[row.id] })}
                >
                  <WorldToggleIcon collapsed={!expanded[row.id]} />
                </button>
              {/if}

              {#if row.wiki}
                {@const page = row.wiki}
                <button
                  class="dailies-icon"
                  title={$tr("dailies.openWiki")}
                  aria-label={$tr("dailies.openWiki")}
                  onclick={() => send("open-external", buildWikiUrl(page))}
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
                    <path
                      d="M9 2h5v5l-1.8-1.8L9 8.4 7.6 7l3.2-3.2L9 2zM4 4h3v1.5H4v7h7V9.5h1.5V13a.5.5 0 0 1-.5.5H3.5A.5.5 0 0 1 3 13V4.5A.5.5 0 0 1 3.5 4H4z"
                    />
                  </svg>
                </button>
              {/if}

              {#if editing && !row.dynamic}
                {#if row.retimeable}
                  <select
                    class="dailies-input"
                    title={$tr("dailies.periodTitle")}
                    value={row.period}
                    onchange={(event) =>
                      commit(
                        setTrackerPeriod(
                          tracker,
                          row.id,
                          event.currentTarget.value === "weekly" ? "weekly" : "daily",
                        ),
                      )}
                  >
                    <option value="daily">{$tr("dailies.groupDaily")}</option>
                    <option value="weekly">{$tr("dailies.groupWeekly")}</option>
                  </select>
                {/if}
                <button
                  class="dailies-icon"
                  title={row.hidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
                  aria-label={row.hidden ? $tr("dailies.showTask") : $tr("dailies.hideTask")}
                  onclick={() => commit(toggleTrackerHidden(tracker, row.id))}
                  >{row.hidden ? "+" : "x"}</button
                >
                {#if row.custom}
                  <input
                    class="dailies-input dailies-target"
                    type="number"
                    min="1"
                    max="99"
                    title={$tr("dailies.targetTitle")}
                    value={row.target}
                    onchange={(event) =>
                      commit(setTrackerTarget(tracker, row.id, Number(event.currentTarget.value)))}
                  />
                  <button
                    class="dailies-icon dailies-icon--danger"
                    title={$tr("dailies.removeTask")}
                    aria-label={$tr("dailies.removeTask")}
                    onclick={() => commit(removeCustomTask(tracker, row.id))}>&#8722;</button
                  >
                {/if}
              {/if}
            </div>

            {#if expanded[row.id]}
              {#if row.lines}
                <ul class="dailies-sublist">
                  {#each row.lines as line (line)}
                    <li>{line}</li>
                  {/each}
                </ul>
              {/if}
              {#if row.circuit}
                <div class="dailies-icons">
                  {#each row.circuit as choice (choice.uniqueName)}
                    <IconButtonCard
                      name={choice.displayName ?? choice.name}
                      imageUrl={choice.imageUrl}
                      owned={choice.owned}
                      size={80}
                      borderWidth="1.5"
                      onClick={() => openReward(choice)}
                    />
                  {/each}
                </div>
              {/if}
            {/if}
          {/if}
        {/each}
      </CollapsibleSection>
    </div>
  {/if}
{/snippet}

<div class="flex flex-col">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
    <p class="m-0 text-sm text-text-secondary">
      {wd ? $tr("dailies.manualHint") : $tr("dailies.awaitingWorldData")}
    </p>
    <div class="flex items-center gap-3">
      {#if editing && tracker.hidden.length > 0}
        <span class="text-xs text-text-secondary"
          >{$tr("dailies.hiddenCount", { count: String(tracker.hidden.length) })}</span
        >
      {/if}
      <button
        class="btn-secondary btn-sm"
        data-tracker-edit
        aria-pressed={editing}
        onclick={() => (editing = !editing)}
      >
        {editing ? $tr("dailies.customizeDone") : $tr("dailies.customize")}
      </button>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-x-8 max-[1100px]:grid-cols-1">
    <div class="flex flex-col">
      {@render section("daily")}
      {@render section("nightwave")}
      {@render section("alerts")}
    </div>
    <div class="flex flex-col">
      {@render section("weekly")}
      {@render section("vendors")}
    </div>
  </div>

  {#if editing}
    <div class="dailies-section flex flex-wrap items-center gap-2">
      <input
        class="dailies-input dailies-name-input"
        type="text"
        maxlength="60"
        placeholder={$tr("dailies.addPlaceholder")}
        bind:value={draftLabel}
        onkeydown={(event) => event.key === "Enter" && addDraft()}
      />
      <select class="dailies-input" title={$tr("dailies.periodTitle")} bind:value={draftPeriod}>
        <option value="daily">{$tr("dailies.groupDaily")}</option>
        <option value="weekly">{$tr("dailies.groupWeekly")}</option>
      </select>
      <button class="btn-secondary btn-sm" disabled={!draftLabel.trim()} onclick={addDraft}>
        {$tr("dailies.addTask")}
      </button>
    </div>
  {/if}
</div>

<style>
  .dailies-section {
    padding: 0.85rem 0;
    border-top: 1px solid var(--border);
  }

  .dailies-section:first-child {
    border-top: none;
  }

  .dailies-section--off {
    opacity: 0.45;
  }

  .dailies-meta {
    align-items: center;
    color: var(--text-secondary);
    display: flex;
    font-size: 0.72rem;
    gap: 0.5rem;
    padding-bottom: 0.35rem;
  }

  .dailies-subhead {
    color: var(--text-secondary);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0.5rem 0 0.15rem;
    text-transform: uppercase;
  }

  .dailies-row {
    align-items: center;
    border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
    display: flex;
    gap: 0.5rem;
    padding: 0.32rem 0;
  }

  .dailies-row:last-child {
    border-bottom: none;
  }

  .dailies-row--off {
    opacity: 0.45;
  }

  .dailies-label {
    align-items: center;
    cursor: pointer;
    display: flex;
    flex: 1 1 auto;
    gap: 0.5rem;
    min-width: 0;
  }

  .dailies-name {
    color: var(--text-primary);
    display: block;
    font-size: 0.86rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dailies-name--done {
    color: var(--text-secondary);
    text-decoration: line-through;
  }

  .dailies-detail {
    color: var(--text-secondary);
    display: block;
    font-size: 0.72rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dailies-badge {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    border-radius: var(--radius-md);
    color: var(--accent);
    flex-shrink: 0;
    font-size: 0.66rem;
    padding: 0.05rem 0.3rem;
    white-space: nowrap;
  }

  .dailies-time {
    color: var(--text-secondary);
    flex-shrink: 0;
    font-family: var(--font-display);
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    min-width: 3.4rem;
    text-align: right;
    white-space: nowrap;
  }

  .dailies-time--warn {
    color: var(--warning);
  }

  .dailies-time--crit {
    color: var(--danger);
  }

  .dailies-sublist {
    color: var(--text-secondary);
    font-size: 0.72rem;
    list-style: none;
    margin: 0 0 0.35rem;
    padding: 0 0 0 1.5rem;
  }

  .dailies-sublist li {
    padding: 0.1rem 0;
  }

  .dailies-icons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    padding: 0.25rem 0 0.5rem 1.5rem;
  }

  .dailies-check {
    accent-color: var(--accent);
    flex-shrink: 0;
    height: 0.95rem;
    width: 0.95rem;
  }

  .dailies-step,
  .dailies-icon {
    align-items: center;
    background: color-mix(in srgb, var(--bg-raised) 70%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    display: inline-flex;
    flex-shrink: 0;
    height: 1.25rem;
    justify-content: center;
    min-width: 1.25rem;
    transition:
      border-color 0.15s,
      color 0.15s;
  }

  .dailies-step:hover,
  .dailies-icon:hover {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .dailies-icon--danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  .dailies-input {
    background: color-mix(in srgb, var(--bg-deep) 60%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    flex-shrink: 0;
    font-size: 0.78rem;
    padding: 0.15rem 0.3rem;
  }

  .dailies-name-input {
    min-width: 12rem;
  }

  .dailies-target {
    width: 2.75rem;
  }
</style>
