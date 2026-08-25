import type { Env, SupporterTier } from './types';
import { clamp, parsePositiveInt } from './utils';

// Tier ids are opaque Patreon strings, so the map is validated by value only.
function parsePatreonTierMap(raw: string | undefined): Record<string, SupporterTier> {
	const map: Record<string, SupporterTier> = {};
	if (!raw || !raw.trim()) return map;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return map;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;

	for (const [tierId, tier] of Object.entries(parsed as Record<string, unknown>)) {
		const id = tierId.trim();
		if (!id) continue;
		if (tier === 'basic' || tier === 'big' || tier === 'biggest') map[id] = tier;
	}
	return map;
}

interface WorkerConfig {
	cacheTtlSec: number;
	noDataTtlSec: number;
	staleRefreshSec: number;
	orderSummaryCacheTtlSec: number;
	orderSummaryStaleRefreshSec: number;
	catalogRefreshHours: number;
	adminPrewarmMaxBatch: number;
	prewarmBatchSize: number;
	orderSummaryPrewarmBatchSize: number;
	bootstrapTokenTtlSec: number;
	publicRateLimitEnabled: boolean;
	dailyBudgetEnabled: boolean;
	catalogSlugGuardEnabled: boolean;
	dailyBudgetMaxRequests: number;
	dailyBudgetSampleRate: number;
	patreonCampaignId: string;
	patreonClientId: string;
	patreonTierMap: Record<string, SupporterTier>;
}

export function getWorkerConfig(env: Env): WorkerConfig {
	return {
		cacheTtlSec: clamp(parsePositiveInt(env.CACHE_TTL_SEC, 86400), 60, 604800),
		noDataTtlSec: clamp(parsePositiveInt(env.NO_DATA_TTL_SEC, 900), 60, 604800),
		staleRefreshSec: clamp(parsePositiveInt(env.STALE_REFRESH_SEC, 75600), 120, 604800),
		orderSummaryCacheTtlSec: clamp(parsePositiveInt(env.ORDERS_SUMMARY_CACHE_TTL_SEC, 172800), 300, 604800),
		orderSummaryStaleRefreshSec: clamp(parsePositiveInt(env.ORDERS_SUMMARY_STALE_REFRESH_SEC, 75600), 60, 604800),
		catalogRefreshHours: clamp(parsePositiveInt(env.CATALOG_REFRESH_HOURS, 24), 1, 168),
		adminPrewarmMaxBatch: clamp(parsePositiveInt(env.ADMIN_PREWARM_MAX_BATCH, 100), 1, 100),
		prewarmBatchSize: parsePositiveInt(env.PREWARM_BATCH_SIZE, 125),
		orderSummaryPrewarmBatchSize: parsePositiveInt(env.ORDER_SUMMARY_PREWARM_BATCH_SIZE, 36),
		bootstrapTokenTtlSec: clamp(parsePositiveInt(env.BOOTSTRAP_TOKEN_TTL_SEC, 900), 60, 3600),
		publicRateLimitEnabled: (env.PUBLIC_RATE_LIMIT_ENABLED || '1').trim() !== '0',
		dailyBudgetEnabled: (env.DAILY_BUDGET_ENABLED || '1').trim() !== '0',
		catalogSlugGuardEnabled: (env.CATALOG_SLUG_GUARD_ENABLED || '1').trim() !== '0',
		dailyBudgetMaxRequests: clamp(parsePositiveInt(env.DAILY_BUDGET_MAX_REQUESTS, 300000), 1, 10000000),
		dailyBudgetSampleRate: clamp(parsePositiveInt(env.DAILY_BUDGET_SAMPLE_RATE, 100), 1, 1000),
		patreonCampaignId: (env.PATREON_CAMPAIGN_ID || '').trim(),
		patreonClientId: (env.PATREON_CLIENT_ID || '').trim(),
		patreonTierMap: parsePatreonTierMap(env.PATREON_TIER_MAP),
	};
}
