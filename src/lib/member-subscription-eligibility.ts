import type { AgeTier } from "@prisma/client";
import {
  getAgeTierSettings,
  type AgeTierSettingData,
} from "@/lib/age-tier";

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

export async function requiresPaidSubscriptionForAgeTierFromSettings(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  const settings = await getAgeTierSettings();
  return requiresPaidSubscriptionForAgeTier(ageTier, settings);
}
