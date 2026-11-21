import type { AgeTier } from "@prisma/client";

/**
 * Static display name for a tier, independent of the configurable
 * AgeTierSetting labels. NOT_APPLICABLE is the organisation/school tier
 * (#1440); it never has a settings row, so it always renders as "N/A".
 *
 * Lives in a plain module (#5066) so server code — the generated booking
 * invoice — can use it; `use-age-tier-options.ts` is a client module and
 * re-exports it.
 */
export function formatAgeTierName(tier: AgeTier | string): string {
  if (tier === "NOT_APPLICABLE") {
    return "N/A";
  }
  return tier.charAt(0) + tier.slice(1).toLowerCase();
}

/**
 * A tier's display name: the club's configured AgeTierSetting label when it
 * has one, else the static name (`formatAgeTierName`). The one rule the age-tier
 * pickers (`getAgeTierLabel`) and the generated booking invoice (#5066) read;
 * `configuredLabel` looks the tier up in whatever the caller loaded.
 */
export function ageTierLabel(
  tier: AgeTier | string,
  configuredLabel: (tier: AgeTier | string) => string | undefined,
): string {
  return configuredLabel(tier) ?? formatAgeTierName(tier);
}
