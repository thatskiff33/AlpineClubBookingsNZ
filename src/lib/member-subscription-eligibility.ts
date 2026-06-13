import type { AgeTier } from "@prisma/client";
import {
  getAgeTierSettings,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
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

/**
 * Membership subscriptions are invoiced and reconciled through Xero. When the
 * Xero module is effectively disabled (deploy capability AND admin setting,
 * via loadEffectiveModuleFlags), members can never reach PAID, so the
 * "subscription must be paid" rule must not be enforced at booking time.
 */
export async function isSubscriptionEnforcementActive(): Promise<boolean> {
  const flags = await loadEffectiveModuleFlags();
  return flags.xeroIntegration;
}

/**
 * Booking-time subscription gate: the age-tier rule applies only while the
 * Xero module is effectively enabled. Booking-time policy check sites use
 * this instead of the raw age-tier rule so the Xero-off bypass is consistent.
 */
export async function requiresPaidSubscriptionForBooking(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  if (!(await isSubscriptionEnforcementActive())) {
    return false;
  }
  return requiresPaidSubscriptionForAgeTierFromSettings(ageTier);
}
