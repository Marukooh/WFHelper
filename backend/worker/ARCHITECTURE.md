# Worker architecture

`backend/worker` is the shared Warframe Market cache used by the desktop app. This document
covers runtime ownership and invariants. See `README.md` for setup and operator commands.

## Runtime layout

- `src/index.ts` handles CORS rejection, route dispatch, 404 responses, request logging, and cron.
- `src/routes/public.ts` owns health, bootstrap, snapshot, item-catalog, price, meta, and order
  routes.
- `src/routes/admin.ts` owns authenticated prewarm, catalog, hotset, and status routes.
- `src/services/readThrough.ts` owns cache-first reads, stale refresh, negative markers, and
  in-flight deduplication.
- `src/services/prewarm.ts` owns catalog walks, upstream refreshes, snapshot patches, and the
  `SnapshotCoordinator` Durable Object.
- `src/security/rateLimit.ts` selects Cloudflare Rate Limiting bindings.
- `src/security/dailyBudget.ts` owns the sampled request budget and `DailyBudgetCounter` Durable
  Object.
- `src/security/bootstrap.ts` issues and verifies optional short-lived public API tokens.

Keep `src/index.ts` thin. Route and service behavior belongs in the modules above.

## Public request flow

Public requests pass through these controls:

1. CORS allowlist validation for requests with an `Origin` header.
2. A route-specific Cloudflare Rate Limiting binding keyed by the connecting IP.
3. The daily request budget.
4. Bootstrap token validation where required.
5. Slug and rank validation before any upstream request.
6. KV read-through, stale refresh, and negative-cache handling.

Rank validation reads the ranked order-summary catalog through a five-minute isolate cache. An
empty catalog is never cached, because callers treat it as `catalog_unavailable`.

Electron and command-line clients normally omit `Origin` and are allowed. Browser origins must
match `ALLOW_ORIGIN`. `clientIp()` trusts only `cf-connecting-ip`.

Rate Limiting binding defaults in `wrangler.jsonc` are per IP:

- health: 5 per minute
- bootstrap and full orders: 60 per minute
- prices, meta, and order summaries: 200 per minute
- snapshot and item catalog: 2 per minute
- admin: 60 per minute

Public limiter failures fail open to preserve app reads. Admin limiter failures fail closed with
`503 rate_limit_unavailable`. Zone-level WAF rules remain the first line of defense.

## Snapshot

`GET /v1/snapshot` serves KV key `snapshot:full:v1`. The snapshot contains the desktop price,
meta, and ranked order-summary caches.

- The route is public because startup requests it before bootstrap completes.
- `Cache-Control: public, max-age=7200` allows the Cache API to reuse the serialized body at a PoP.
- Cache hits still execute the Worker and its request guards. They avoid the KV read, validation,
  serialization, and response-body reconstruction.
- The ETag is a SHA-256 digest of the exact client response body plus the desktop cache version.
- Matching `If-None-Match` requests return 304 for both Cache API hits and KV reads.
- Invalid or missing snapshots return 503 and are never cached as valid data.

Prewarm batches call `patchSnapshot()` after their writes. `SnapshotCoordinator` serializes the
read-modify-write operation so concurrent cron and admin batches cannot overwrite each other. A
full catalog walk gradually fills the snapshot without a bulk KV rebuild or a 1000-subrequest
spike.

Do not restore the deleted admin snapshot-build route. It previously rebuilt from a truncated KV
scan and could replace a complete snapshot with partial data.

Snapshot key translation must stay compatible with the desktop importers. Ranked worker keys such
as `price:{slug}:r{n}` become `{slug}:rank-v3:r{n}` in the snapshot.

## WFM item catalog

`GET /v1/wfm-items` serves the desktop-safe projection of the Warframe Market item catalog from
KV key `catalog:client-items:v1`. The catalog refresh writes this key alongside the slug catalog,
and the route keeps its response in the edge cache for six hours.

If the client-shaped key is absent, the route first follows the normal refresh cadence. A fresh
slug catalog from an older deployment can make that refresh a no-op, so the route then forces one
upstream refresh before returning `503 catalog_not_ready`. Empty upstream responses never replace
a valid catalog.

The catalog response carries the same body ETag treatment as the snapshot, keyed by
`WFM_ITEMS_CACHE_VERSION`. The ETag is stored in the edge-cached entry, so matching
`If-None-Match` requests return 304 from both the Cache API hit and a freshly built body.

## Relic order subtypes

`GET /v1/order-summary/{slug}?subtype=intact|exceptional|flawless|radiant` serves relic prices per
refinement. Relics are absent from the ranked catalog, so the subtype path replaces rank validation
instead of extending it: the slug must end in `_relic` and the subtype must be one of the four
values, or the route returns `400 invalid_subtype` before any upstream request.

Hydration reuses the normal orders fetch and filters it to the requested subtype; an order without a
`subtype` field counts as intact. Cache and negative-marker keys carry a `:s{subtype}` segment
(`orders-summary:{slug}:s{subtype}`, `miss:orders-summary:v1:{slug}:s{subtype}`) so they never
collide with the ranked `:r{rank}` family. TTL, stale refresh, and negative markers are unchanged.
Subtype entries stay out of the snapshot; the desktop requests them on demand.

Bare `/v1/order-summary/{slug}` requests keep the existing rank-required behavior.

## Supporter credits (Discord-sourced)

`GET /v1/supporters` serves KV key `supporters:discord:v1` as
`{ ok: true, updatedAt, supporters: [{ name, tier }] }` with tier `basic | big | biggest`. The route
is public, needs no bootstrap token, uses the price/meta rate-limit class, and is edge-cached for one
hour. A missing or empty key returns `updatedAt: null` with an empty list and is never edge-cached,
so the first sync after setup appears immediately.

`services/supporters.ts` owns the sync. It pages the Discord guild members endpoint (`Bot` token
auth, `limit=1000` with `after` pagination), keeps non-bot members whose role ids map through
`DISCORD_ROLE_TIER_MAP`, and takes the highest tier when a member holds several mapped roles. The
published name is the server nickname, then the global display name, then the username. The
Patreon Discord integration assigns the tier roles, so the Patreon API is never called; its
`full_name` is often a legal name and must not be published. Sync is a logged no-op when the
guild id, bot token, or role map is absent. Every successful sync also deletes the retired
Patreon-pipeline keys (`patreon:supporters:v1`, `patreon:tokens:v1`, `patreon:exclusions:v1`),
which held profile names and OAuth tokens.

`supporters:exclusions:v1` is a JSON array of strings. A supporter is excluded when the Discord
user id or the case-insensitive, whitespace-collapsed display name matches an entry (published
names are whitespace-collapsed the same way). `POST /admin/supporters/exclusions`
(`{ set: string[] }`) replaces the list and immediately drops matching names from the published KV
value; a body whose `set` is not an array is rejected with 400 so a malformed call cannot wipe the
list. Raw user ids are never retained, so an id exclusion applies at the next sync.
`POST /admin/supporters/sync` runs the sync and returns `{ ok: true, count, status }`.

Opt-out latency: KV drops the name immediately, but the edge cache can serve the previous list for
up to one hour and the desktop app caches a non-empty list for up to 24 hours, so an excluded name
can stay visible on clients for up to a day after the admin call. Leaving the guild or unlinking
Discord from Patreon removes the role, so those names drop at the next sync without admin action.

Configuration: vars `DISCORD_GUILD_ID` and `DISCORD_ROLE_TIER_MAP` (JSON role id to tier) parsed in
`src/config.ts`; secret `DISCORD_BOT_TOKEN` (the bot needs the Server Members intent and membership
in the guild, no channel permissions). Both supporter KV keys live in `ITEM_META` with no expiration.

## Read-through and prewarm

Confirmed misses use `miss:price:*`, `miss:meta:*`, `miss:orders:*`, and
`miss:orders-summary:*`. Transient upstream errors must not create negative markers.
`skip:untradable:*` prevents repeated metadata requests for excluded items.

The bare `price:{slug}` key is rank-pinned. A rank-agnostic stats window mixes rank 0 and
max-rank sales, so a slug listed in the ranked order-summary catalog prices from its rank 0
sales. Prewarm and the `/v1/prices/{slug}` read-through share `barePriceFetchRank()`, so a live
read cannot overwrite a rank 0 median with a mixed-rank one. An unavailable ranked catalog
(`null`, as opposed to an authoritative empty one) fails open: prewarm skips the price half of
the sweep and the read-through keeps the rank-agnostic median. Only an answered upstream request
may drop a cached price; a transient failure or an HTTP error leaves the last good median.

Prewarm cron runs every 15 minutes; the separate daily `0 4 * * *` trigger runs only the
supporter sync. Current production defaults are:

- `PREWARM_BATCH_SIZE=125`
- `ORDER_SUMMARY_PREWARM_BATCH_SIZE=36`
- 24-hour price/meta TTL
- 48-hour order-summary TTL
- 21-hour stale-refresh threshold for both cache families
- `limits.cpu_ms=1000`

Cron is a rolling backstop. Fresh entries are copied into the snapshot without another upstream
request, while stale entries are refreshed before being patched.

## Daily budget

`DAILY_BUDGET_ENABLED=1` enables a sampled daily request cap. The current cap is 300,000 requests
with a sample rate of 100. Samples are recorded atomically in the `DailyBudgetCounter` Durable
Object named for the UTC day. Unsampled requests never touch the Durable Object; once a sampled
request observes the tripped cap, the isolate caches the trip until the next UTC day and rejects
every request from memory. Tripped requests return `503 daily_budget_exceeded` until the next UTC
day and scheduled prewarm skips work.

Cloudflare billing alerts are still required. Repository code cannot create account-level billing
notifications.

## Bootstrap deployment

Required bootstrap mode must have `BOOTSTRAP_TOKEN_SECRET`; otherwise protected public routes fail
closed. Enable it in this order:

1. Run `npx wrangler secret put BOOTSTRAP_TOKEN_SECRET` from `backend/worker`.
2. Release the desktop app with `VITE_WFM_BACKEND_BOOTSTRAP_ENABLED=1`.
3. Set `PUBLIC_BOOTSTRAP_REQUIRED=1` and deploy the Worker.

Reverse that order when disabling. Older desktop versions fall back to direct Warframe Market
requests if the Worker returns 401.

## Response and cache invariants

- Preserve desktop envelopes: `{ ok, data }` and `{ ok: false, error }`.
- Successful public data may use explicit public cache headers. Auth errors, 404, 410, 429, and
  5xx responses stay `no-store` unless a route has a deliberate negative-cache policy.
- KV TTLs must remain meaningfully longer than stale thresholds.
- `/v1/orders/:slug` stays disabled by default. The desktop normally consumes summaries.
- `GET /healthz` is public-minimal. Detailed status requires admin authorization.
- `workers_dev=false` is required when relying on the custom domain and zone rules.

## Verification

From `backend/worker`:

```bash
npm run typecheck
npm run test -- --run
npm run test:smoke
npm run dev
npm run deploy
```

From the repository root:

```bash
pnpm run backend:typecheck
pnpm run backend:test
pnpm run lint:worker
```

Unit and integration behavior belongs in `test/index.spec.ts`. The scheduled GitHub workflow runs
`test/smoke.spec.ts` against the deployed custom domain every six hours.
