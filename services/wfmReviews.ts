import { withScope } from "./logger";
import { request, WfmApiError } from "./wfmClient";
import { probeProfileSlug } from "./wfmProfileSlug";

const log = withScope("wfmReviews");

export type SendRepResult = "sent" | "already-exists" | "user-not-found" | "failed";

export async function sendPlusRep(username: string): Promise<SendRepResult> {
  const name = String(username || "").trim();
  if (!name) return "failed";

  try {
    // No minted slug means the name is already one, or there is no such profile,
    // which the POST reports as a 404 of its own.
    const slug = (await probeProfileSlug(name)) ?? name;
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
