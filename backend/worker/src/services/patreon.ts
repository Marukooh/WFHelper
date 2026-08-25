import { PATREON_EXCLUSIONS_KEY, PATREON_SUPPORTERS_KEY, PATREON_TOKENS_KEY } from '../constants';
import { getWorkerConfig } from '../config';
import { logEvent } from './logging';
import type { Env, Supporter, SupporterTier, SupportersPayload } from '../types';
import { getJsonFromKv } from '../utils';

const PATREON_ORIGIN = 'https://www.patreon.com';
const MEMBERS_PAGE_SIZE = 200;
// Bounds on untrusted upstream data: a runaway `links.next` chain, an oversized
// KV value, or a hostile display name must not be able to grow without limit.
const MAX_MEMBER_PAGES = 50;
const MAX_SUPPORTERS = 5000;
const MAX_SUPPORTER_NAME_LENGTH = 100;
const MAX_EXCLUSIONS = 1000;
const MAX_EXCLUSION_LENGTH = 200;

const TIER_RANK: Record<SupporterTier, number> = { basic: 1, big: 2, biggest: 3 };

type PatreonSyncResult =
	| { ok: true; status: 'synced'; count: number }
	| { ok: true; status: 'not_configured'; count: 0 }
	| { ok: false; error: string };

interface PatreonTokens {
	accessToken: string;
	refreshToken: string;
}

interface ParsedMember {
	id: string;
	name: string;
	tier: SupporterTier;
}

type MemberWalkResult = { status: 'ok'; members: ParsedMember[] } | { status: 'unauthorized' } | { status: 'error'; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function trimmedString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function sanitizeSupporterName(value: unknown): string {
	return trimmedString(value).replace(/\s+/g, ' ').slice(0, MAX_SUPPORTER_NAME_LENGTH);
}

function sanitizeSupporters(value: unknown): Supporter[] {
	if (!Array.isArray(value)) return [];
	const supporters: Supporter[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const name = sanitizeSupporterName(entry.name);
		const tier = entry.tier;
		if (!name) continue;
		if (tier !== 'basic' && tier !== 'big' && tier !== 'biggest') continue;
		supporters.push({ name, tier });
		if (supporters.length >= MAX_SUPPORTERS) break;
	}
	return supporters;
}

function sortSupporters(supporters: Supporter[]): Supporter[] {
	return [...supporters].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || a.name.localeCompare(b.name));
}

function sanitizeExclusionList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const entries: string[] = [];
	for (const entry of value) {
		const trimmed = trimmedString(entry).slice(0, MAX_EXCLUSION_LENGTH);
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		entries.push(trimmed);
		if (entries.length >= MAX_EXCLUSIONS) break;
	}
	return entries;
}

async function readExclusions(env: Env): Promise<string[]> {
	const raw = await env.ITEM_META.get(PATREON_EXCLUSIONS_KEY);
	if (!raw) return [];
	try {
		return sanitizeExclusionList(JSON.parse(raw));
	} catch {
		return [];
	}
}

// Published names are whitespace-collapsed by sanitizeSupporterName, so the
// exclusion side must collapse the same way or a double-spaced entry never matches.
function exclusionNameKey(value: string): string {
	return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function excludeSupporters(members: ParsedMember[], exclusions: string[]): ParsedMember[] {
	if (exclusions.length === 0) return members;
	const byId = new Set(exclusions);
	const byName = new Set(exclusions.map(exclusionNameKey));
	return members.filter((member) => !byId.has(member.id) && !byName.has(exclusionNameKey(member.name)));
}

export async function readPublishedSupporters(env: Env): Promise<SupportersPayload> {
	const stored = await getJsonFromKv(env.ITEM_META, PATREON_SUPPORTERS_KEY);
	const supporters = sanitizeSupporters(stored?.supporters);
	const updatedAt = trimmedString(stored?.updatedAt);
	if (supporters.length === 0) return { updatedAt: null, supporters: [] };
	return { updatedAt: updatedAt || null, supporters };
}

async function writeSupporters(env: Env, supporters: Supporter[], updatedAt: string): Promise<void> {
	await env.ITEM_META.put(PATREON_SUPPORTERS_KEY, JSON.stringify({ updatedAt, supporters }));
}

async function readTokens(env: Env): Promise<PatreonTokens | null> {
	// Rotated tokens live in KV; the env values are only the initial seed.
	const stored = await getJsonFromKv(env.ITEM_META, PATREON_TOKENS_KEY);
	const storedAccess = trimmedString(stored?.accessToken);
	const storedRefresh = trimmedString(stored?.refreshToken);
	if (storedAccess && storedRefresh) return { accessToken: storedAccess, refreshToken: storedRefresh };

	const seedAccess = trimmedString(env.PATREON_ACCESS_TOKEN);
	const seedRefresh = trimmedString(env.PATREON_REFRESH_TOKEN);
	if (seedAccess && seedRefresh) return { accessToken: seedAccess, refreshToken: seedRefresh };
	return null;
}

async function persistTokens(env: Env, tokens: PatreonTokens): Promise<void> {
	await env.ITEM_META.put(PATREON_TOKENS_KEY, JSON.stringify({ ...tokens, updatedAt: new Date().toISOString() }));
}

async function refreshTokens(env: Env, refreshToken: string): Promise<PatreonTokens | null> {
	const clientId = getWorkerConfig(env).patreonClientId;
	const clientSecret = trimmedString(env.PATREON_CLIENT_SECRET);
	if (!clientId || !clientSecret) return null;

	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: clientId,
		client_secret: clientSecret,
	});

	let response: Response;
	try {
		response = await fetch(`${PATREON_ORIGIN}/api/oauth2/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: body.toString(),
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return null;
	}
	if (!isRecord(payload)) return null;

	const accessToken = trimmedString(payload.access_token);
	const nextRefreshToken = trimmedString(payload.refresh_token) || refreshToken;
	if (!accessToken) return null;

	const tokens = { accessToken, refreshToken: nextRefreshToken };
	await persistTokens(env, tokens);
	return tokens;
}

function membersUrl(campaignId: string): string {
	const url = new URL(`${PATREON_ORIGIN}/api/oauth2/v2/campaigns/${encodeURIComponent(campaignId)}/members`);
	url.searchParams.set('include', 'currently_entitled_tiers');
	url.searchParams.set('fields[member]', 'full_name,patron_status');
	url.searchParams.set('page[count]', String(MEMBERS_PAGE_SIZE));
	return url.toString();
}

// Upstream controls `links.next`, so only Patreon's own API path may be followed.
function nextPageUrl(payload: Record<string, unknown>): string | null {
	const links = payload.links;
	if (!isRecord(links)) return null;
	const next = trimmedString(links.next);
	if (!next) return null;
	try {
		const url = new URL(next);
		if (url.origin !== PATREON_ORIGIN) return null;
		if (!url.pathname.startsWith('/api/oauth2/v2/')) return null;
		return url.toString();
	} catch {
		return null;
	}
}

function highestTier(entitledTierIds: string[], tierMap: Record<string, SupporterTier>): SupporterTier | null {
	let best: SupporterTier | null = null;
	for (const tierId of entitledTierIds) {
		const tier = tierMap[tierId];
		if (!tier) continue;
		if (!best || TIER_RANK[tier] > TIER_RANK[best]) best = tier;
	}
	return best;
}

function parseEntitledTierIds(relationships: unknown): string[] {
	if (!isRecord(relationships)) return [];
	const entitled = relationships.currently_entitled_tiers;
	if (!isRecord(entitled) || !Array.isArray(entitled.data)) return [];
	return entitled.data
		.map((entry) => (isRecord(entry) ? trimmedString(entry.id) : ''))
		.filter((tierId): tierId is string => tierId.length > 0);
}

function parseMembersPage(payload: Record<string, unknown>, tierMap: Record<string, SupporterTier>): ParsedMember[] {
	if (!Array.isArray(payload.data)) return [];

	const members: ParsedMember[] = [];
	for (const entry of payload.data) {
		if (!isRecord(entry)) continue;
		const id = trimmedString(entry.id);
		const attributes = entry.attributes;
		if (!id || !isRecord(attributes)) continue;
		if (trimmedString(attributes.patron_status) !== 'active_patron') continue;

		const name = sanitizeSupporterName(attributes.full_name);
		if (!name) continue;

		const tier = highestTier(parseEntitledTierIds(entry.relationships), tierMap);
		if (!tier) continue;

		members.push({ id, name, tier });
	}
	return members;
}

async function walkMembers(campaignId: string, accessToken: string, tierMap: Record<string, SupporterTier>): Promise<MemberWalkResult> {
	const members: ParsedMember[] = [];
	const seenIds = new Set<string>();
	let url: string | null = membersUrl(campaignId);

	for (let page = 0; page < MAX_MEMBER_PAGES && url; page += 1) {
		let response: Response;
		try {
			response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
		} catch {
			return { status: 'error', error: 'patreon_unreachable' };
		}

		if (response.status === 401) return { status: 'unauthorized' };
		if (!response.ok) return { status: 'error', error: `patreon_http_${response.status}` };

		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			return { status: 'error', error: 'patreon_invalid_payload' };
		}
		if (!isRecord(payload)) return { status: 'error', error: 'patreon_invalid_payload' };

		for (const member of parseMembersPage(payload, tierMap)) {
			if (seenIds.has(member.id)) continue;
			seenIds.add(member.id);
			members.push(member);
			if (members.length >= MAX_SUPPORTERS) return { status: 'ok', members };
		}

		url = nextPageUrl(payload);
	}

	return { status: 'ok', members };
}

export async function syncPatreonSupporters(env: Env, reason: 'cron' | 'manual'): Promise<PatreonSyncResult> {
	const { patreonCampaignId, patreonTierMap } = getWorkerConfig(env);
	const tokens = patreonCampaignId ? await readTokens(env) : null;
	if (!patreonCampaignId || !tokens) {
		// Deploys without Patreon credentials stay green; this is configuration, not failure.
		logEvent({ type: reason === 'cron' ? 'cron' : 'admin', route: 'patreon:sync', status: 204 });
		return { ok: true, status: 'not_configured', count: 0 };
	}

	let walk = await walkMembers(patreonCampaignId, tokens.accessToken, patreonTierMap);
	if (walk.status === 'unauthorized') {
		const refreshed = await refreshTokens(env, tokens.refreshToken);
		if (!refreshed) {
			logEvent({ type: 'error', route: 'patreon:sync', status: 401, error: 'patreon_token_refresh_failed' });
			return { ok: false, error: 'patreon_token_refresh_failed' };
		}
		walk = await walkMembers(patreonCampaignId, refreshed.accessToken, patreonTierMap);
	}

	if (walk.status === 'unauthorized') {
		logEvent({ type: 'error', route: 'patreon:sync', status: 401, error: 'patreon_unauthorized' });
		return { ok: false, error: 'patreon_unauthorized' };
	}
	if (walk.status === 'error') {
		logEvent({ type: 'error', route: 'patreon:sync', status: 502, error: walk.error });
		return { ok: false, error: walk.error };
	}

	const exclusions = await readExclusions(env);
	const supporters = sortSupporters(excludeSupporters(walk.members, exclusions).map(({ name, tier }) => ({ name, tier })));
	await writeSupporters(env, supporters, new Date().toISOString());

	logEvent({ type: reason === 'cron' ? 'cron' : 'admin', route: 'patreon:sync', status: 200, count: supporters.length });
	return { ok: true, status: 'synced', count: supporters.length };
}

export async function replacePatreonExclusions(env: Env, value: unknown): Promise<{ exclusions: number; removed: number }> {
	const exclusions = sanitizeExclusionList(value);
	await env.ITEM_META.put(PATREON_EXCLUSIONS_KEY, JSON.stringify(exclusions));

	// Raw member ids are never retained, so an id exclusion applies at the next
	// sync; a name exclusion is applied to the published list immediately.
	const published = await readPublishedSupporters(env);
	const byName = new Set(exclusions.map(exclusionNameKey));
	const kept = published.supporters.filter((supporter) => !byName.has(exclusionNameKey(supporter.name)));
	const removed = published.supporters.length - kept.length;
	if (removed > 0) await writeSupporters(env, kept, published.updatedAt || new Date().toISOString());

	logEvent({ type: 'admin', route: 'patreon:exclusions', status: 200, count: exclusions.length });
	return { exclusions: exclusions.length, removed };
}
