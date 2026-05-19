import type { AgeTier } from "@prisma/client";
import {
  getAgeTierSettings,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { requiresPaidSubscriptionForAgeTier as requiresPaidSubscriptionForAgeTierRule } from "@/lib/policies/subscription";

export function requiresPaidSubscriptionForAgeTier(
  ageTier: AgeTier | null | undefined,
  settings: AgeTierSettingData[]
): boolean {
  return requiresPaidSubscriptionForAgeTierRule(ageTier, settings);
}

export async function requiresPaidSubscriptionForAgeTierFromSettings(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  const settings = await getAgeTierSettings();
  return requiresPaidSubscriptionForAgeTier(ageTier, settings);
}
