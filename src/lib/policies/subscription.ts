import type { AgeTier } from "@prisma/client";
import type { AgeTierSettingData } from "./age-tier";

export function requiresPaidSubscriptionForAgeTier(
  ageTier: AgeTier | null | undefined,
  settings: AgeTierSettingData[]
): boolean {
  if (!ageTier) {
    return true;
  }

  return (
    settings.find((setting) => setting.tier === ageTier)
      ?.subscriptionRequiredForBooking ?? true
  );
}
