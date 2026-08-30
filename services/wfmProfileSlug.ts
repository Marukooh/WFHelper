import { sanitizeWfmSlug } from "../config/shared/wfm";
import { requestRedirectTarget } from "./wfmClient";

const SLUG_FROM_LOCATION = /\/profile\/([^/?#]+)\/reviews\/?$/;

/** The slug warframe.market minted for a profile name, read back from its own
 *  redirect. WFM mints it itself - lowercased, edge punctuation stripped, spaces
 *  turned into hyphens, underscores kept only sometimes - so no local rule
 *  reproduces it. Callers own the fallback for the null cases below. */
export async function probeProfileSlug(name: string): Promise<string | null> {
  const location = await requestRedirectTarget(`/profile/${encodeURIComponent(name)}/reviews/`);
  // Null covers three answers alike: WFM serves the name directly, there is no
  // such profile, or the probe failed.
  const captured = location ? SLUG_FROM_LOCATION.exec(location)?.[1] : null;
  if (!captured) return null;
  try {
    // WFM minted this, so the catalog allowlist is the gate that fits: it keeps
    // path separators out and rejects the dots WFM strips from a name.
    return sanitizeWfmSlug(decodeURIComponent(captured));
  } catch {
    return null;
  }
}
