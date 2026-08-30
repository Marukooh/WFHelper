import { withScope } from "./logger";
import { sanitizeWfmSlug } from "../config/shared/wfm";
import { request, requestRedirectTarget, WfmApiError } from "./wfmClient";

const log = withScope("wfmReviews");

export type SendRepResult = "sent" | "already-exists" | "user-not-found" | "failed";

const SLUG_FROM_LOCATION = /\/profile\/([^/?#]+)\/reviews\/?$/;

/** WFM mints the profile slug itself: lowercased, edge punctuation stripped,
 *  spaces turned into hyphens, underscores kept only sometimes. No local rule
 *  reproduces that, so the slug is read back from WFM's own redirect instead of
 *  guessed from the game name. */
async function resolveProfileSlug(name: string): Promise<string> {
  // wfmSession and wfmContracts fold our own account name locally instead. A
  // miss there is one failed GET among fallbacks, but a miss here posts nothing.
  const location = await requestRedirectTarget(`/profile/${encodeURIComponent(name)}/reviews/`);
  // Served directly, so the name is already the slug - or there is no such
  // profile, which the POST reports as a 404 of its own.
  if (!location) return name;

  const captured = SLUG_FROM_LOCATION.exec(location)?.[1];
  if (!captured) return name;
  let slug: string;
  try {
    slug = decodeURIComponent(captured);
  } catch {
    return name;
  }
  // WFM minted this slug itself, so the catalog allowlist is the gate that fits:
  // it keeps path separators out and rejects the dots WFM strips from a name.
  return sanitizeWfmSlug(slug) ?? name;
}

export async function sendPlusRep(username: string): Promise<SendRepResult> {
  const name = String(username || "").trim();
  if (!name) return "failed";

  try {
    const slug = await resolveProfileSlug(name);
    await request("POST", `/profile/${encodeURIComponent(slug)}/review`, {
      json: { review_type: 1, text: "" },
    });
    log.info(`[Rep] +1 rep sent to ${name}`);
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("app.review.already_exist")) {
      log.info(`[Rep] review already exists for ${name}`);
      return "already-exists";
    }
    if (err instanceof WfmApiError && err.status === 404) {
      log.info(`[Rep] no WFM profile named ${name}`);
      return "user-not-found";
    }
    log.warn(`[Rep] failed for ${name}:`, message);
    return "failed";
  }
}
