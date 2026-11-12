import type { AgeTier } from "@prisma/client";

/**
 * Static display name for a tier, independent of the configurable
 * AgeTierSetting labels. NOT_APPLICABLE is the organisation/school tier
 * (#1440); it never has a settings row, so it always renders as "N/A".
 *
 * Lives in a plain module (fork #115) so server code — the booking invoice PDF —
 * can use it; `use-age-tier-options.ts` is a client module and re-exports it.
 */
export function formatAgeTierName(tier: AgeTier | string): string {
  if (tier === "NOT_APPLICABLE") {
    return "N/A";
  }
  return tier.charAt(0) + tier.slice(1).toLowerCase();
}
