import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { prewarmBatch } from '../src/services/prewarm';
import { fetchCatalogSlugs } from '../src/services/prewarmCatalog';
import { getOrHydratePrice } from '../src/services/readThrough';

const CATALOG_SLUGS_KEY = 'catalog:slugs:v1';
const RANKED_CATALOG_KEY = 'order-summary:catalog:v1';
const originalFetch = globalThis.fetch;

interface StatsRow {
	rank?: number;
	median: number;
	minutesAgo: number;
}

beforeEach(() => {
	(env as unknown as Record<string, string>).CATALOG_SLUG_GUARD_ENABLED = '0';
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = originalFetch;
});

async function seedCatalog(slug: string): Promise<void> {
	await env.ITEM_META.put(CATALOG_SLUGS_KEY, JSON.stringify({ updatedAt: Date.now(), slugs: [slug], rankedSummaryCatalog: [] }));
}

async function seedRankedCatalog(entries: Array<{ slug: string; maxRank: number }> | null): Promise<void> {
	if (entries == null) {
		await env.ITEM_META.delete(RANKED_CATALOG_KEY);
		return;
	}
	await env.ITEM_META.put(RANKED_CATALOG_KEY, JSON.stringify({ updatedAt: Date.now(), entries }));
}

function statsPayload(rows: StatsRow[]): unknown {
	return {
		payload: {
			statistics_closed: {
				'48hours': rows.map((row) => ({
					datetime: new Date(Date.now() - row.minutesAgo * 60 * 1000).toISOString(),
					order_type: 'sell',
					median: row.median,
					...(row.rank == null ? {} : { mod_rank: row.rank }),
				})),
			},
		},
	};
}

function jsonOk(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Serves meta + statistics for one slug; `stats` may return a raw Response to model failures. */
function mockWfm(slug: string, stats: () => unknown): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === `https://api.warframe.market/v2/items/${slug}`) {
			return jsonOk({ data: { slug, tradable: true, i18n: { en: {} } } });
		}
		if (url === `https://api.warframe.market/v1/items/${slug}/statistics`) {
			const result = stats();
			return result instanceof Response ? result : jsonOk(result);
		}
		throw new Error(`Unexpected url: ${url}`);
	});
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

async function readPrice(slug: string): Promise<Record<string, unknown> | null> {
	const raw = await env.PRICE_CACHE.get(`price:${slug}`);
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function readSnapshotPrice(slug: string): Promise<Record<string, unknown> | undefined> {
	const raw = await env.PRICE_CACHE.get('snapshot:full:v1');
	if (!raw) return undefined;
	const snapshot = JSON.parse(raw) as { prices?: Record<string, Record<string, unknown>> };
	return snapshot.prices?.[slug];
}

describe('unranked prewarm sweep rank pinning', () => {
	it('stores the rank 0 median for a slug the ranked catalog knows', async () => {
		const slug = 'wf_test_sweep_ranked_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.priceUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
		expect(await readSnapshotPrice(slug)).toMatchObject({ status: 'ok', median: 50 });
	});

	it('leaves an unranked slug on the rank-agnostic latest median', async () => {
		const slug = 'wf_test_sweep_unranked_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug: 'wf_test_sweep_other_ranked_slug', maxRank: 5 }]);
		mockWfm(slug, () =>
			statsPayload([
				{ median: 11, minutesAgo: 120 },
				{ median: 17, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.priceUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 17, rank: null });
	});

	it('treats an empty stored ranked catalog as authoritative and prices rank-agnostically', async () => {
		const slug = 'wf_test_sweep_empty_catalog_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([]);
		mockWfm(slug, () =>
			statsPayload([
				{ median: 50, minutesAgo: 120 },
				{ median: 123, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.failures).toBe(0);
		expect(result.priceUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 123, rank: null });
	});

	it('preserves the cached bare price when the ranked catalog is missing', async () => {
		const slug = 'wf_test_sweep_no_catalog_slug';
		await seedCatalog(slug);
		await seedRankedCatalog(null);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 50, rank: null, timestamp: Date.now() }));
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.failures).toBe(0);
		expect(result.priceUpdated).toBe(0);
		// Meta keeps sweeping; only the rank-sensitive half is held back.
		expect(result.metaUpdated).toBe(1);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBeNull();
	});

	it('preserves the cached bare price when the ranked catalog read throws', async () => {
		const slug = 'wf_test_sweep_catalog_throws_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 50, rank: null, timestamp: Date.now() }));
		mockWfm(slug, () => statsPayload([{ rank: 10, median: 123, minutesAgo: 10 }]));

		const brokenEnv = {
			...env,
			ITEM_META: {
				...env.ITEM_META,
				get: vi.fn(async (key: string) => {
					if (key === RANKED_CATALOG_KEY) throw new Error('kv unavailable');
					return env.ITEM_META.get(key);
				}),
				put: env.ITEM_META.put.bind(env.ITEM_META),
				delete: env.ITEM_META.delete.bind(env.ITEM_META),
			},
		} as unknown as Env;

		const result = await prewarmBatch(brokenEnv, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.failures).toBe(0);
		expect(result.priceUpdated).toBe(0);
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBeNull();
	});

	it('drops the stale bare price when a ranked slug has no rank 0 sale', async () => {
		const slug = 'wf_test_sweep_no_rank0_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 999, rank: null, timestamp: Date.now() }));
		mockWfm(slug, () => statsPayload([{ rank: 10, median: 123, minutesAgo: 10 }]));

		const result = await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(result.priceUpdated).toBe(0);
		expect(await readPrice(slug)).toBeNull();
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBe('1');
		expect(await readSnapshotPrice(slug)).toMatchObject({ status: 'no_data', median: null });
	});

	it('keeps the stored ranked catalog when a refresh returns no ranked items', async () => {
		const kept = [{ slug: 'wf_test_sweep_kept_ranked_slug', maxRank: 10 }];
		await seedRankedCatalog(kept);
		globalThis.fetch = vi.fn(async () =>
			jsonOk({ data: [{ slug: 'wf_test_sweep_plain_slug', tradable: true, i18n: { en: { name: 'Plain' } } }] }),
		) as unknown as typeof fetch;

		const slugs = await fetchCatalogSlugs(env as Env, true);

		expect(slugs).toEqual(['wf_test_sweep_plain_slug']);
		const stored = JSON.parse(String(await env.ITEM_META.get(RANKED_CATALOG_KEY))) as { entries?: unknown };
		expect(stored.entries).toEqual(kept);
	});

	it('keeps the cached bare price when the ranked stats fetch fails transiently', async () => {
		const slug = 'wf_test_sweep_transient_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, rank: null, timestamp: Date.now() }));
		mockWfm(slug, () => new Response('boom', { status: 503 }));

		await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(await readPrice(slug)).toMatchObject({ slug, median: 42 });
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBeNull();
	});

	it('keeps the cached bare price when a ranked stats fetch fails permanently', async () => {
		const slug = 'wf_test_sweep_permanent_slug';
		await seedCatalog(slug);
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(`price:${slug}`, JSON.stringify({ slug, median: 42, rank: null, timestamp: Date.now() }));
		mockWfm(slug, () => new Response('nope', { status: 404 }));

		await prewarmBatch(env as Env, { reason: 'manual', batchSize: 1, resetCursor: true });

		expect(await readPrice(slug)).toMatchObject({ slug, median: 42 });
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBeNull();
	});
});

describe('read-through price rank pinning', () => {
	async function hydrate(slug: string): Promise<Awaited<ReturnType<typeof getOrHydratePrice>>> {
		const ctx = createExecutionContext();
		const result = await getOrHydratePrice(env as Env, slug, ctx);
		await waitOnExecutionContext(ctx);
		return result;
	}

	it('keeps the rank 0 median when a stale ranked price refreshes on a live read', async () => {
		const slug = 'wf_test_read_stale_ranked_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		await env.PRICE_CACHE.put(
			`price:${slug}`,
			JSON.stringify({ slug, median: 50, rank: null, timestamp: Date.now() - 30 * 60 * 60 * 1000 }),
		);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await hydrate(slug);

		expect(result.status).toBe('ok');
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
	});

	it('hydrates a missing ranked price from its rank 0 sales', async () => {
		const slug = 'wf_test_read_miss_ranked_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await hydrate(slug);

		expect(result.data).toMatchObject({ median: 50 });
		expect(await readPrice(slug)).toMatchObject({ slug, median: 50, rank: null });
	});

	it('prices rank-agnostically when the ranked catalog is unavailable', async () => {
		const slug = 'wf_test_read_no_catalog_slug';
		await seedRankedCatalog(null);
		mockWfm(slug, () =>
			statsPayload([
				{ rank: 0, median: 50, minutesAgo: 120 },
				{ rank: 10, median: 123, minutesAgo: 10 },
			]),
		);

		const result = await hydrate(slug);

		expect(result.data).toMatchObject({ median: 123 });
	});

	it('marks no data when a ranked slug has no rank 0 sale', async () => {
		const slug = 'wf_test_read_no_rank0_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () => statsPayload([{ rank: 10, median: 123, minutesAgo: 10 }]));

		const result = await hydrate(slug);

		expect(result.status).toBe('not_found');
		expect(await readPrice(slug)).toBeNull();
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBe('1');
	});

	it('leaves no negative marker when a ranked read fails transiently', async () => {
		const slug = 'wf_test_read_transient_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () => new Response('boom', { status: 503 }));

		const result = await hydrate(slug);

		expect(result.status).toBe('unavailable');
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBeNull();
	});

	it('negatively caches a permanent ranked read failure without the rank 0 drop', async () => {
		const slug = 'wf_test_read_permanent_slug';
		await seedRankedCatalog([{ slug, maxRank: 10 }]);
		mockWfm(slug, () => new Response('nope', { status: 404 }));

		const result = await hydrate(slug);

		expect(result.status).toBe('not_found');
		expect(await env.PRICE_CACHE.get(`miss:price:v2:${slug}`)).toBe('1');
	});
});
