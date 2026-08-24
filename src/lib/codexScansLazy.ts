import type * as CodexScans from "./codexScans.js";

/** codexScans reaches the ~510 KB scan-requirement table and the codex panel is
 *  its only consumer, so it loads on demand instead of at app launch. The seam
 *  lives in TypeScript because the dead-code audit cannot follow a dynamic
 *  import written inside a Svelte script block. */
export function loadCodexScans(): Promise<typeof CodexScans> {
  return import("./codexScans.js");
}
