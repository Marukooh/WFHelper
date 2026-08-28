import type { DecodedRiven } from "../types/ipc.js";

type NamedRiven = Pick<DecodedRiven, "weaponName" | "rivenName">;

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * The in-game link tag, e.g. "[Ack & Brunt Cronitor]". Built from the English
 * game names the chat and warframe.market both key on, never a translated label.
 */
export function rivenChatTag(riven: NamedRiven): string {
  const weapon = collapse(riven.weaponName ?? "");
  const full = collapse(riven.rivenName ?? "");
  if (!weapon) return full ? `[${full}]` : "";

  // rivenName already carries the weapon on the decoded side; a bare suffix
  // reaches the same tag, so strip the prefix only when it is actually there.
  const suffix = full.toLowerCase().startsWith(weapon.toLowerCase())
    ? full.slice(weapon.length).trim()
    : full;
  return suffix ? `[${weapon} ${suffix}]` : `[${weapon}]`;
}

/** The chat line a seller pastes: "WTS [Ack & Brunt Cronitor] 120p". */
export function rivenWtsLine(riven: NamedRiven, platinum: number): string {
  const price = Number.isFinite(platinum) ? Math.max(0, Math.round(platinum)) : 0;
  return `WTS ${rivenChatTag(riven)} ${price}p`;
}
