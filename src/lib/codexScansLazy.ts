import type * as CodexScans from "./codexScans.js";

/** The ~510 KB scan-requirement table loads on demand. The seam is TypeScript
 *  because the dead-code audit cannot follow a dynamic import inside a Svelte script. */
export function loadCodexScans(): Promise<typeof CodexScans> {
  return import("./codexScans.js");
}
