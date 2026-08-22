import { persistedBoolean } from "../lib/persistence.js";

export const hideFounderMasteryItems = persistedBoolean("wf_hide_founder_mastery_items", false);
export const hideFoundryClaims = persistedBoolean("wf_hide_foundry_claims", true);
export const autoFocusSearch = persistedBoolean("wf_auto_focus_search", false);
