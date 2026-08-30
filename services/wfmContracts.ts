import { withScope } from "./logger";
import { normalizeErrorMessage } from "../config/shared/errors";

import { request, requestV2 } from "./wfmClient";
import { getInGameName, getProfileSlug } from "./wfmSession";
import { toNonEmptyString } from "../config/shared/stringValidation";
import { toFiniteNumber } from "../config/shared/numeric";
import { formatWfmAssetUrl, titleFromSlug } from "../config/shared/wfm";
import type {
  WfmContract,
  WfmContractAttribute,
  WfmContractsQuery,
  WfmContractsResult,
} from "../config/shared/wfmContracts";

const log = withScope("wfmContracts");

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 40;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

const SKIPPABLE_HTTP_STATUSES = new Set([301, 302, 303, 400, 404, 405]);

let _resolvedEndpointName: string | null = null;

interface PageInfo {
  page: number;
  totalPages: number | null;
  hasMore: boolean;
}

interface ExtractedContracts extends PageInfo {
  rows: Record<string, unknown>[];
}

interface EndpointCandidate {
  name: string;
  api: "v1" | "v2";
  /** Built from the account slug when `needsSlug`; the argument is ignored otherwise. */
  path: (profileSlug: string) => string;
  needsSlug: boolean;
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    const s = toNonEmptyString(value);
    if (s) return s;
  }
  return null;
}

function normalizeAttribute(rawAttribute: unknown): WfmContractAttribute | null {
  if (!rawAttribute || typeof rawAttribute !== "object") return null;
  const attr = rawAttribute as Record<string, unknown>;

  const urlName = firstNonEmpty(attr.url_name, attr.urlName, attr.name) ?? "unknown";
  const label = firstNonEmpty(attr.display_name, attr.displayName) ?? titleFromSlug(urlName);

  const numericValue = toFiniteNumber(attr.value);
  const value: number | string | null =
    numericValue != null ? numericValue : toNonEmptyString(attr.value);

  const positive: boolean | null =
    typeof attr.positive === "boolean"
      ? attr.positive
      : typeof attr.is_positive === "boolean"
        ? attr.is_positive
        : null;

  return {
    urlName,
    label,
    value,
    positive,
  };
}

function toIsoTimestamp(value: unknown): string | null {
  const s = toNonEmptyString(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeContract(raw: unknown): WfmContract | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const item = (r.item && typeof r.item === "object" ? r.item : {}) as Record<string, unknown>;
  const i18nEn = ((item.i18n as Record<string, unknown> | undefined)?.en ?? {}) as Record<
    string,
    unknown
  >;
  const itemSlug = firstNonEmpty(item.url_name, r.item_url_name);
  const weaponSlug = firstNonEmpty(
    item.weapon_url_name,
    item.weaponUrlName,
    r.weapon_url_name,
    r.weaponUrlName,
  );

  const itemName =
    firstNonEmpty(
      i18nEn.item_name,
      i18nEn.itemName,
      item.item_name,
      item.itemName,
      item.weapon_name,
      item.weaponName,
      r.item_name,
      r.itemName,
    ) ?? (weaponSlug ? `${titleFromSlug(weaponSlug)} Riven` : "Riven Contract");

  const itemThumb = formatWfmAssetUrl(
    firstNonEmpty(item.thumb, item.icon, item.image, r.thumb, r.icon),
  );

  const buyoutPlatinum = toFiniteNumber(r.buyout_price ?? r.buyoutPrice);
  const startingPlatinum = toFiniteNumber(r.starting_price ?? r.startingPrice);
  const listedPrice =
    toFiniteNumber(r.platinum) ??
    toFiniteNumber(r.price) ??
    buyoutPlatinum ??
    startingPlatinum ??
    0;

  const attributesRaw = Array.isArray(item.attributes)
    ? item.attributes
    : Array.isArray(r.attributes)
      ? r.attributes
      : [];

  const id = firstNonEmpty(r.id, r._id, r.contract_id, r.contractId);

  if (!id) return null;

  const directSell =
    r.is_direct_sell === true ||
    r.isDirectSell === true ||
    (buyoutPlatinum != null &&
      buyoutPlatinum > 0 &&
      (startingPlatinum == null || startingPlatinum <= 0));

  return {
    id,
    itemName: itemName || "Riven Contract",
    itemId: firstNonEmpty(item.id, r.itemId),
    itemUrlName: itemSlug || weaponSlug || null,
    weaponUrlName: weaponSlug || null,
    rivenSuffix: weaponSlug ? firstNonEmpty(item.name, r.riven_name) : null,
    itemThumb,
    platinum: Math.max(0, Math.round(Math.abs(listedPrice))),
    buyoutPlatinum:
      buyoutPlatinum != null ? Math.max(0, Math.round(Math.abs(buyoutPlatinum))) : null,
    startingPlatinum:
      startingPlatinum != null ? Math.max(0, Math.round(Math.abs(startingPlatinum))) : null,
    quantity: Math.max(1, Math.round(Math.abs(toFiniteNumber(r.quantity) ?? 1))),
    visible: r.visible !== false,
    modRank: toFiniteNumber(item.mod_rank ?? item.rank ?? r.mod_rank ?? r.rank),
    rerolls: toFiniteNumber(item.re_rolls ?? item.reRolls ?? r.re_rolls ?? r.reRolls),
    masteryLevel: toFiniteNumber(
      item.mastery_level ?? item.masteryLevel ?? r.mastery_level ?? r.masteryLevel,
    ),
    polarity: firstNonEmpty(item.polarity, r.polarity, item.mod_polarity),
    minimalReputation: toFiniteNumber(r.minimal_reputation ?? r.minimalReputation),
    isDirectSell: directSell,
    listedAt: toIsoTimestamp(r.created_at ?? r.createdAt),
    updatedAt: toIsoTimestamp(r.updated_at ?? r.updatedAt),
    note: firstNonEmpty(r.note),
    stats: attributesRaw
      .map(normalizeAttribute)
      .filter((attribute): attribute is WfmContractAttribute => attribute != null),
    listingUrl: `https://warframe.market/auction/${encodeURIComponent(id)}`,
    sourceType: firstNonEmpty(r.type, r.contract_type, r.contractType),
  };
}

function parsePageInfo(container: unknown): PageInfo {
  if (!container || typeof container !== "object") {
    return { page: DEFAULT_PAGE, totalPages: null, hasMore: false };
  }
  const c = container as Record<string, unknown>;

  const page =
    toFiniteNumber(c.page) ||
    toFiniteNumber(c.current_page) ||
    toFiniteNumber(c.currentPage) ||
    DEFAULT_PAGE;

  const totalPages =
    toFiniteNumber(c.total_pages) ||
    toFiniteNumber(c.totalPages) ||
    toFiniteNumber(c.last_page) ||
    toFiniteNumber(c.lastPage) ||
    null;

  const hasMore =
    typeof c.has_more === "boolean"
      ? c.has_more
      : typeof c.hasMore === "boolean"
        ? c.hasMore
        : totalPages != null
          ? (page ?? DEFAULT_PAGE) < (totalPages ?? 0)
          : false;

  return { page: page ?? DEFAULT_PAGE, totalPages, hasMore };
}

function extractContracts(data: unknown): ExtractedContracts {
  const d = data as Record<string, unknown> | null;
  const root = (d?.data ?? d?.payload ?? d) as Record<string, unknown> | null;
  const candidates = [root, root?.data, root?.payload].filter(Boolean);

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return { rows: candidate as Record<string, unknown>[], ...parsePageInfo(root) };
    }

    if (!candidate || typeof candidate !== "object") continue;
    const c = candidate as Record<string, unknown>;

    if (Array.isArray(c.contracts)) {
      return { rows: c.contracts as Record<string, unknown>[], ...parsePageInfo(c) };
    }
    if (Array.isArray(c.auctions)) {
      return { rows: c.auctions as Record<string, unknown>[], ...parsePageInfo(c) };
    }
    if (Array.isArray(c.items)) {
      return { rows: c.items as Record<string, unknown>[], ...parsePageInfo(c) };
    }
    if (Array.isArray(c.results)) {
      return { rows: c.results as Record<string, unknown>[], ...parsePageInfo(c) };
    }
  }

  return {
    rows: [],
    page: DEFAULT_PAGE,
    totalPages: null,
    hasMore: false,
  };
}

function buildQuery(page: number, limit: number): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (limit > 0) params.set("limit", String(limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

// A slug-bearing route takes the slug WFM minted for the account, never the
// in-game name: lowercasing a name that carries punctuation builds a profile
// path that does not exist.
function endpointCandidates(page: number, limit: number): EndpointCandidate[] {
  const query = buildQuery(page, limit);
  const slugged = (build: (user: string) => string) => (profileSlug: string) =>
    build(encodeURIComponent(profileSlug));

  return [
    {
      name: "v1_my_profile_auctions",
      api: "v1",
      path: () => `/profile/auctions${query}`,
      needsSlug: false,
    },
    {
      name: "v1_profile_auctions",
      api: "v1",
      path: slugged((user) => `/profile/${user}/auctions${query}`),
      needsSlug: true,
    },
    {
      name: "v2_contracts_my",
      api: "v2",
      path: () => `/contracts/my${query}`,
      needsSlug: false,
    },
    {
      name: "v2_auctions_my",
      api: "v2",
      path: () => `/auctions/my${query}`,
      needsSlug: false,
    },
    {
      name: "v2_profile_contracts",
      api: "v2",
      path: slugged((user) => `/profile/${user}/contracts${query}`),
      needsSlug: true,
    },
    {
      name: "v2_profile_auctions",
      api: "v2",
      path: slugged((user) => `/profile/${user}/auctions${query}`),
      needsSlug: true,
    },
    {
      name: "v1_profile_contracts",
      api: "v1",
      path: slugged((user) => `/profile/${user}/contracts${query}`),
      needsSlug: true,
    },
  ];
}

async function invokeCandidate(api: "v1" | "v2", path: string): Promise<unknown> {
  if (api === "v2") {
    return requestV2("GET", path);
  }
  return request("GET", path);
}

function isSkippableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = Number((err as Record<string, unknown>).status);
  return SKIPPABLE_HTTP_STATUSES.has(status);
}

export async function getMyContracts({
  page = DEFAULT_PAGE,
  limit = DEFAULT_LIMIT,
}: WfmContractsQuery = {}): Promise<WfmContractsResult> {
  if (!getInGameName()) {
    throw new Error("Not logged in to Warframe.market.");
  }

  const safePage = Math.max(1, Math.round(toFiniteNumber(page) || DEFAULT_PAGE));
  const safeLimit = Math.max(
    MIN_LIMIT,
    Math.min(MAX_LIMIT, Math.round(toFiniteNumber(limit) || DEFAULT_LIMIT)),
  );

  const candidates = endpointCandidates(safePage, safeLimit);
  if (_resolvedEndpointName) {
    candidates.sort((a, b) => {
      if (a.name === _resolvedEndpointName) return -1;
      if (b.name === _resolvedEndpointName) return 1;
      return 0;
    });
  }

  let lastError: unknown = null;
  // Resolving the account slug costs a request of its own, so it waits until a
  // route that needs it is actually reached; undefined means "not asked yet".
  let profileSlug: string | null | undefined;

  for (const candidate of candidates) {
    let slugForPath = "";
    if (candidate.needsSlug) {
      if (profileSlug === undefined) profileSlug = await getProfileSlug();
      if (!profileSlug) continue;
      slugForPath = profileSlug;
    }
    const path = candidate.path(slugForPath);

    try {
      const data = await invokeCandidate(candidate.api, path);
      const extracted = extractContracts(data);
      const contracts = extracted.rows
        .map(normalizeContract)
        .filter((row): row is WfmContract => row != null);

      if (_resolvedEndpointName !== candidate.name) {
        log.info(`[WFMContracts] Resolved endpoint: ${candidate.name}`);
      }
      _resolvedEndpointName = candidate.name;
      return {
        contracts,
        page: extracted.page,
        totalPages: extracted.totalPages,
        hasMore: extracted.hasMore,
      };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        (err as Record<string, unknown>).code === "WFM_UNAUTHORIZED"
      ) {
        throw err;
      }

      if (isSkippableError(err)) {
        log.info(
          `[WFMContracts] ${candidate.api.toUpperCase()} ${path} unavailable (${(err as Record<string, unknown>).status})`,
        );
        if (_resolvedEndpointName === candidate.name) {
          _resolvedEndpointName = null;
        }
        continue;
      }

      lastError = err;
      log.warn(
        `[WFMContracts] ${candidate.api.toUpperCase()} ${path} failed:`,
        normalizeErrorMessage(err),
      );
    }
  }

  if (lastError) throw lastError;

  throw new Error(
    "Unable to load riven contracts. Endpoint path may have changed; verify Warframe.market API route and shape.",
  );
}

/** Close a sold riven auction. v2 has no auction route yet, so this stays v1. */
export async function closeContract(contractId: string): Promise<void> {
  if (!contractId) throw new Error("closeContract: contractId is required.");
  log.info(`[WFMContracts] PUT /auctions/entry/${contractId}/close`);
  await request("PUT", `/auctions/entry/${encodeURIComponent(contractId)}/close`);
}

export const __test__ = {
  normalizeContract,
  extractContracts,
  endpointCandidates,
};
