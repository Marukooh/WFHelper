import { MISS_META_PREFIX, MISS_ORDER_SUMMARY_PREFIX, MISS_PRICE_PREFIX, SKIP_UNTRADABLE_PREFIX } from '../constants';
import type { Env } from '../types';
import { getWorkerConfig } from '../config';
import { getJsonFromKv } from '../utils';
import {
	buildOrderSummaryPayload,
	fetchMetaPayload,
	fetchOrdersPayload,
	fetchPricePayload,
	markPriceNoData,
	markUntradable,
	putMetaPayload,
	putOrderSummaryPayload,
	putOrderSummarySubtypePayload,
	putPricePayload,
} from './prewarm';
import { workerMissOrderSummarySubtypeKey, workerOrderSummarySubtypeCacheKey, type OrderSubtype } from './orderSubtype';
import { barePriceFetchRank, fetchCatalogSlugs, readRankedSlugsFromKv } from './prewarmCatalog';
import { normalizeRankFilter } from '../../../../config/shared/numeric';
import { isExcludedRankedMarketItem, isWfmExcludedSlug } from '../../../../config/shared/wfmExclusions';
import { workerMissCacheKey, workerOrderSummaryCacheKey, workerPriceCacheKey } from '../../../../config/shared/wfmCacheKeys';

type AutoReadResult =
	| { status: 'ok'; data: Record<string, unknown>; cacheHit: boolean }
	| { status: 'not_found'; data: null; cacheHit: boolean }
	| { status: 'unavailable'; data: null; cacheHit: false };
interface HydrateResult {
	data: Record<string, unknown> | null;
	transient: boolean;
}

type AutoStatsKey = keyof typeof autoStats;

interface ReadThroughDescriptor {
	namespace: KVNamespace;
	cacheKey: string;
	missKey: string;
	isStale: (data: Record<string, unknown> | null, env: Env) => boolean;
	hydrate: (markNoData: boolean) => Promise<HydrateResult>;
	stats: {
		cacheHit: AutoStatsKey;
		negativeHit: AutoStatsKey;
		staleRefreshQueued: AutoStatsKey;
	};
	canQueueRefresh?: () => boolean;
	beforeMissCheck?: () => Promise<boolean>;
	onBeforeMissHit?: () => void;
}

const priceInFlight = new Map<string, Promise<HydrateResult>>();
const metaInFlight = new Map<string, Promise<HydrateResult>>();
const orderSummaryInFlight = new Map<string, Promise<HydrateResult>>();

const ORDER_SUMMARY_BREAKER_THRESHOLD = 6;
const ORDER_SUMMARY_BREAKER_COOLDOWN_MS = 90_000;
const CATALOG_SLUG_SET_TTL_MS = 5 * 60 * 1000;
const LOCAL_UNTRADABLE_SKIP_TTL_MS = 6 * 60 * 60 * 1000;

let catalogSlugSetCache: { expiresAt: number; slugs: Set<string> } | null = null;
const localUntradableSkipCache = new Map<string, number>();

// The breaker is isolate-local by design: it stops local retry storms without adding a KV
// read to every request. Other isolates may each incur up to the failure threshold.
let localOrderSummaryTransientStreak = 0;
let localOrderSummaryCircuitOpenUntil = 0;

const autoStats = {
	priceCacheHits: 0,
	priceHydrated: 0,
	priceNegativeHits: 0,
	priceStaleRefreshQueued: 0,
	metaCacheHits: 0,
	metaHydrated: 0,
	metaNegativeHits: 0,
	metaUntradableSkips: 0,
	metaStaleRefreshQueued: 0,
	orderSummaryCacheHits: 0,
	orderSummaryHydrated: 0,
	orderSummaryNegativeHits: 0,
	orderSummaryStaleRefreshQueued: 0,
	orderSummaryUnavailable: 0,
	orderSummaryCircuitOpen: 0,
};

function timestampFromRecord(data: Record<string, unknown> | null): number {
	if (!data) return 0;
	const ts = Number(data.timestamp || 0);
	return Number.isFinite(ts) ? ts : 0;
}

function isStale(data: Record<string, unknown> | null, env: Env): boolean {
	const ts = timestampFromRecord(data);
	if (ts <= 0) return true;
	return Date.now() - ts > getWorkerConfig(env).staleRefreshSec * 1000;
}

function isOrderSummaryStale(data: Record<string, unknown> | null, env: Env): boolean {
	const ts = timestampFromRecord(data);
	if (ts <= 0) return true;
	return Date.now() - ts > getWorkerConfig(env).orderSummaryStaleRefreshSec * 1000;
}

function noteOrderSummaryTransient(): void {
	localOrderSummaryTransientStreak += 1;
	if (localOrderSummaryTransientStreak >= ORDER_SUMMARY_BREAKER_THRESHOLD) {
		localOrderSummaryCircuitOpenUntil = Date.now() + ORDER_SUMMARY_BREAKER_COOLDOWN_MS;
		autoStats.orderSummaryCircuitOpen += 1;
	}
}

function noteOrderSummaryRecovery(): void {
	localOrderSummaryTransientStreak = 0;
	localOrderSummaryCircuitOpenUntil = 0;
}

function orderSummaryCircuitOpen(): boolean {
	return localOrderSummaryCircuitOpenUntil > Date.now();
}

async function setNegativeMarker(namespace: KVNamespace, key: string, env: Env): Promise<void> {
	await namespace.put(key, '1', {
		expirationTtl: getWorkerConfig(env).noDataTtlSec,
	});
}

function noteLocalUntradableSkip(slug: string): void {
	localUntradableSkipCache.set(slug, Date.now() + LOCAL_UNTRADABLE_SKIP_TTL_MS);
}

function clearLocalUntradableSkip(slug: string): void {
	localUntradableSkipCache.delete(slug);
}

function hasLocalUntradableSkip(slug: string): boolean {
	const cachedUntil = localUntradableSkipCache.get(slug) || 0;
	if (cachedUntil > Date.now()) return true;
	if (cachedUntil > 0) localUntradableSkipCache.delete(slug);
	return false;
}

async function hasUntradableSkipMarker(env: Env, slug: string): Promise<boolean> {
	if (hasLocalUntradableSkip(slug)) return true;

	const marker = await env.ITEM_META.get(`${SKIP_UNTRADABLE_PREFIX}${slug}`);
	if (!marker) return false;

	noteLocalUntradableSkip(slug);
	return true;
}

async function slugMissingFromCatalog(env: Env, slug: string): Promise<boolean> {
	if (!getWorkerConfig(env).catalogSlugGuardEnabled) return false;

	const now = Date.now();
	if (!catalogSlugSetCache || catalogSlugSetCache.expiresAt <= now) {
		const slugs = await fetchCatalogSlugs(env, false);
		catalogSlugSetCache = {
			expiresAt: now + CATALOG_SLUG_SET_TTL_MS,
			slugs: new Set(slugs),
		};
	}

	if (catalogSlugSetCache.slugs.size === 0) return false;
	return !catalogSlugSetCache.slugs.has(slug);
}

async function hydratePrice(env: Env, slug: string, markNoData: boolean, rank: number | null): Promise<HydrateResult> {
	const requestKey = workerPriceCacheKey(slug, rank);
	const missKey = workerMissCacheKey(MISS_PRICE_PREFIX, slug, rank);

	const inFlight = priceInFlight.get(requestKey);
	if (inFlight) return inFlight;

	const task = (async () => {
		// The bare key follows the same rank rule as the prewarm sweep. Without it a live read
		// would overwrite a ranked slug's rank 0 median with a mixed-rank one every 21 hours.
		const barePinnedRank = rank == null ? barePriceFetchRank(slug, await readRankedSlugsFromKv(env)) : null;
		const fetchRank = rank ?? barePinnedRank;
		const result = await fetchPricePayload(slug, fetchRank != null ? { rank: fetchRank } : undefined);
		if (!result.data) {
			// Only negatively cache confirmed "no data" - never cache transient errors (429/5xx).
			// A pinned slug with no rank 0 sale drops its mixed-rank entry, as the sweep does.
			if (markNoData && !result.transient) {
				if (result.inactive || (barePinnedRank != null && result.noSales)) {
					await markPriceNoData(env, slug, rank);
				} else {
					await setNegativeMarker(env.PRICE_CACHE, missKey, env);
				}
			}
			return { data: null, transient: result.transient };
		}

		await env.PRICE_CACHE.delete(missKey);
		autoStats.priceHydrated += 1;
		const data = await putPricePayload(env, slug, result.data, rank);
		return { data, transient: false };
	})()
		.catch(() => ({ data: null, transient: true }))
		.finally(() => {
			priceInFlight.delete(requestKey);
		});

	priceInFlight.set(requestKey, task);
	return task;
}

async function hydrateMeta(env: Env, slug: string, markNoData: boolean): Promise<HydrateResult> {
	const inFlight = metaInFlight.get(slug);
	if (inFlight) return inFlight;

	const task = (async () => {
		const result = await fetchMetaPayload(slug);
		if (!result.data) {
			// Only negatively cache confirmed "no data" - never cache transient errors (429/5xx).
			if (markNoData && !result.transient) {
				await setNegativeMarker(env.ITEM_META, `${MISS_META_PREFIX}${slug}`, env);
			}
			return { data: null, transient: result.transient };
		}

		if (!result.data.tradable) {
			autoStats.metaUntradableSkips += 1;
			await markUntradable(env, slug);
			noteLocalUntradableSkip(slug);
			return { data: null, transient: false };
		}

		await env.ITEM_META.delete(`${MISS_META_PREFIX}${slug}`);
		await env.ITEM_META.delete(`${SKIP_UNTRADABLE_PREFIX}${slug}`);
		clearLocalUntradableSkip(slug);
		autoStats.metaHydrated += 1;
		const data = await putMetaPayload(env, result.data);
		return { data, transient: false };
	})()
		.catch(() => ({ data: null, transient: true }))
		.finally(() => {
			metaInFlight.delete(slug);
		});

	metaInFlight.set(slug, task);
	return task;
}

async function hydrateOrderSummary(
	env: Env,
	slug: string,
	markNoData: boolean,
	rank: number | null,
	subtype: OrderSubtype | null = null,
): Promise<HydrateResult> {
	const requestKey = subtype ? workerOrderSummarySubtypeCacheKey(slug, subtype) : workerOrderSummaryCacheKey(slug, rank);
	const missKey = subtype
		? workerMissOrderSummarySubtypeKey(MISS_ORDER_SUMMARY_PREFIX, slug, subtype)
		: workerMissCacheKey(MISS_ORDER_SUMMARY_PREFIX, slug, rank);

	if (orderSummaryCircuitOpen()) {
		autoStats.orderSummaryUnavailable += 1;
		return { data: null, transient: true };
	}

	const inFlight = orderSummaryInFlight.get(requestKey);
	if (inFlight) return inFlight;

	const task = (async () => {
		const result = await fetchOrdersPayload(slug, subtype ? { subtype } : rank != null ? { rank } : undefined);
		if (!result.data) {
			if (result.transient) {
				noteOrderSummaryTransient();
				autoStats.orderSummaryUnavailable += 1;
			} else {
				noteOrderSummaryRecovery();
			}

			if (markNoData && !result.transient) {
				await setNegativeMarker(env.PRICE_CACHE, missKey, env);
			}
			return { data: null, transient: result.transient };
		}

		noteOrderSummaryRecovery();
		const data = buildOrderSummaryPayload(result.data.slug, subtype ? null : rank, result.data, subtype);
		await env.PRICE_CACHE.delete(missKey);
		if (subtype) {
			await putOrderSummarySubtypePayload(env, result.data.slug, data, subtype);
		} else {
			await putOrderSummaryPayload(env, result.data.slug, data, rank);
		}

		autoStats.orderSummaryHydrated += 1;
		return { data, transient: false };
	})()
		.catch(() => {
			noteOrderSummaryTransient();
			autoStats.orderSummaryUnavailable += 1;
			return { data: null, transient: true };
		})
		.finally(() => {
			orderSummaryInFlight.delete(requestKey);
		});

	orderSummaryInFlight.set(requestKey, task);
	return task;
}

async function withReadThrough(env: Env, ctx: ExecutionContext | undefined, descriptor: ReadThroughDescriptor): Promise<AutoReadResult> {
	const cached = await getJsonFromKv(descriptor.namespace, descriptor.cacheKey);
	if (cached) {
		autoStats[descriptor.stats.cacheHit] += 1;
		const canQueueRefresh = descriptor.canQueueRefresh ? descriptor.canQueueRefresh() : true;
		if (ctx && canQueueRefresh && descriptor.isStale(cached, env)) {
			autoStats[descriptor.stats.staleRefreshQueued] += 1;
			ctx.waitUntil(
				descriptor.hydrate(false).then(() => {
					return;
				}),
			);
		}
		return { status: 'ok', data: cached, cacheHit: true };
	}

	if (descriptor.beforeMissCheck && (await descriptor.beforeMissCheck())) {
		descriptor.onBeforeMissHit?.();
		return { status: 'not_found', data: null, cacheHit: false };
	}

	const missMarker = await descriptor.namespace.get(descriptor.missKey);
	if (missMarker) {
		autoStats[descriptor.stats.negativeHit] += 1;
		return { status: 'not_found', data: null, cacheHit: true };
	}

	const hydrated = await descriptor.hydrate(true);
	if (hydrated.data) {
		return { status: 'ok', data: hydrated.data, cacheHit: false };
	}

	return hydrated.transient ? { status: 'unavailable', data: null, cacheHit: false } : { status: 'not_found', data: null, cacheHit: false };
}

export async function getOrHydratePrice(
	env: Env,
	slug: string,
	ctx?: ExecutionContext,
	rankInput?: number | null,
): Promise<AutoReadResult> {
	if (isWfmExcludedSlug(slug)) {
		return { status: 'not_found', data: null, cacheHit: true };
	}

	const rank = normalizeRankFilter(rankInput);
	const cacheKey = workerPriceCacheKey(slug, rank);
	const missKey = workerMissCacheKey(MISS_PRICE_PREFIX, slug, rank);
	return withReadThrough(env, ctx, {
		namespace: env.PRICE_CACHE,
		cacheKey,
		missKey,
		isStale,
		hydrate: (markNoData) => hydratePrice(env, slug, markNoData, rank),
		stats: {
			cacheHit: 'priceCacheHits',
			negativeHit: 'priceNegativeHits',
			staleRefreshQueued: 'priceStaleRefreshQueued',
		},
		beforeMissCheck: () => slugMissingFromCatalog(env, slug),
	});
}

export async function getOrHydrateMeta(env: Env, slug: string, ctx?: ExecutionContext): Promise<AutoReadResult> {
	if (isWfmExcludedSlug(slug)) {
		return { status: 'not_found', data: null, cacheHit: true };
	}
	if (hasLocalUntradableSkip(slug)) {
		autoStats.metaUntradableSkips += 1;
		return { status: 'not_found', data: null, cacheHit: true };
	}

	return withReadThrough(env, ctx, {
		namespace: env.ITEM_META,
		cacheKey: `meta:${slug}`,
		missKey: `${MISS_META_PREFIX}${slug}`,
		isStale,
		hydrate: (markNoData) => hydrateMeta(env, slug, markNoData),
		stats: {
			cacheHit: 'metaCacheHits',
			negativeHit: 'metaNegativeHits',
			staleRefreshQueued: 'metaStaleRefreshQueued',
		},
		beforeMissCheck: async () => (await slugMissingFromCatalog(env, slug)) || (await hasUntradableSkipMarker(env, slug)),
		onBeforeMissHit: () => {
			autoStats.metaUntradableSkips += 1;
		},
	});
}

export async function getOrHydrateOrderSummary(
	env: Env,
	slug: string,
	ctx?: ExecutionContext,
	rankInput?: number | null,
): Promise<AutoReadResult> {
	if (isWfmExcludedSlug(slug) || isExcludedRankedMarketItem(null, slug)) {
		return { status: 'not_found', data: null, cacheHit: true };
	}

	const rank = normalizeRankFilter(rankInput);
	const cacheKey = workerOrderSummaryCacheKey(slug, rank);
	const missKey = workerMissCacheKey(MISS_ORDER_SUMMARY_PREFIX, slug, rank);
	return withReadThrough(env, ctx, {
		namespace: env.PRICE_CACHE,
		cacheKey,
		missKey,
		isStale: isOrderSummaryStale,
		hydrate: (markNoData) => hydrateOrderSummary(env, slug, markNoData, rank),
		stats: {
			cacheHit: 'orderSummaryCacheHits',
			negativeHit: 'orderSummaryNegativeHits',
			staleRefreshQueued: 'orderSummaryStaleRefreshQueued',
		},
		canQueueRefresh: () => !orderSummaryCircuitOpen(),
	});
}

export async function getOrHydrateOrderSummaryBySubtype(
	env: Env,
	slug: string,
	subtype: OrderSubtype,
	ctx?: ExecutionContext,
): Promise<AutoReadResult> {
	if (isWfmExcludedSlug(slug)) {
		return { status: 'not_found', data: null, cacheHit: true };
	}

	return withReadThrough(env, ctx, {
		namespace: env.PRICE_CACHE,
		cacheKey: workerOrderSummarySubtypeCacheKey(slug, subtype),
		missKey: workerMissOrderSummarySubtypeKey(MISS_ORDER_SUMMARY_PREFIX, slug, subtype),
		isStale: isOrderSummaryStale,
		hydrate: (markNoData) => hydrateOrderSummary(env, slug, markNoData, null, subtype),
		stats: {
			cacheHit: 'orderSummaryCacheHits',
			negativeHit: 'orderSummaryNegativeHits',
			staleRefreshQueued: 'orderSummaryStaleRefreshQueued',
		},
		canQueueRefresh: () => !orderSummaryCircuitOpen(),
	});
}

export function getAutoCacheStats(): Record<string, number> {
	return {
		...autoStats,
		orderSummaryCircuitActive: orderSummaryCircuitOpen() ? 1 : 0,
		orderSummaryCircuitRetryAfterMs: Math.max(0, localOrderSummaryCircuitOpenUntil - Date.now()),
	};
}

export function getAutoCacheConfig(env: Env): Record<string, number> {
	const config = getWorkerConfig(env);
	return {
		cacheTtlSec: config.cacheTtlSec,
		noDataTtlSec: config.noDataTtlSec,
		staleRefreshSec: config.staleRefreshSec,
		orderSummaryCacheTtlSec: config.orderSummaryCacheTtlSec,
		orderSummaryStaleRefreshSec: config.orderSummaryStaleRefreshSec,
	};
}
