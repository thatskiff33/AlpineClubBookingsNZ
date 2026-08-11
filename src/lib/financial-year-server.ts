/**
 * Server-side resolution of the membership financial year-end month.
 *
 * Resolves the effective month in this order:
 *   1. admin override (MembershipLockoutSettings.financialYearEndMonthOverride)
 *   2. the connected Xero organisation's accounting financial year
 *   3. March (the default)
 *
 * The resolved value is written into the synchronous cache in
 * `financial-year.ts` so the season helpers stay synchronous. This module is
 * server-only (it touches Prisma and Xero), so it must never be imported into
 * client bundles.
 */

import type { PrismaClient } from "@prisma/client";

import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  setFinancialYearEndMonth,
} from "@/lib/financial-year";
import {
  loadMembershipLockoutSettings,
  MEMBERSHIP_LOCKOUT_SETTINGS_ID,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import { prisma } from "@/lib/prisma";
import { getXeroFinancialYearEndMonth } from "@/lib/xero-organisation";

/**
 * Resolve the effective year-end month, update the in-process cache, and return
 * it. Safe to call on every gated request: it reseeds the cache for this
 * instance so the synchronous helpers are correct.
 */
export async function refreshFinancialYearConfig(): Promise<number> {
  const month = await resolveFinancialYearEndMonth();
  setFinancialYearEndMonth(month);
  return month;
}

/**
 * Resolve the effective year-end month without touching the cache. Returns the
 * pieces needed by the admin UI as well.
 */
async function resolveFinancialYearEndMonth(): Promise<number> {
  const { effectiveMonth } = await getFinancialYearResolution();
  return effectiveMonth;
}

export interface FinancialYearResolution {
  /** The override set by the admin, or null when following Xero. */
  overrideMonth: number | null;
  /** The connected Xero organisation's year-end month, or null. */
  xeroMonth: number | null;
  /** The resolved month actually in effect (1-12). */
  effectiveMonth: number;
}

/**
 * The two relations the provider-free resolution reads, as a structural type so a
 * `Prisma.TransactionClient` satisfies it.
 *
 * A caller that has opened a bounded read-only transaction MUST pass it: reading
 * these two rows on the global client instead would put them outside that
 * transaction's snapshot and outside its statement timeout, which is the whole
 * boundary such a caller opened the transaction to get.
 */
export type StoredFinancialYearDb = Pick<
  PrismaClient,
  "membershipLockoutSettings" | "xeroToken"
>;

export type StoredFinancialYearResolution =
  | {
      ok: true;
      effectiveMonth: number;
      source: "override" | "default_without_xero";
    }
  | { ok: false; reason: "connected_xero_month_not_stored" };

/**
 * Provider-free resolution for read-only diagnostics.
 *
 * A stored override is authoritative. With no override, March is authoritative
 * only when persisted state proves there is no connected Xero tenant. The
 * organisation month is not persisted locally, so a connected tenant must be
 * reported as unavailable rather than guessed from the cold process cache or
 * fetched from Xero. Only the token row's existence is selected; credential
 * columns never cross this boundary.
 */
export async function getStoredFinancialYearResolution(
  db: StoredFinancialYearDb = prisma,
): Promise<StoredFinancialYearResolution> {
  // Read this row STRICTLY. `loadMembershipLockoutSettings` intentionally treats
  // every database error as a migration-era missing table and returns defaults;
  // that is acceptable for the product fallback but not for evidence. A rejected
  // read must propagate so Diagnostics reports `evidence_unavailable` rather than
  // claiming the March default was observed.
  const persisted = await db.membershipLockoutSettings.findUnique({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    select: {
      mode: true,
      financialYearEndMonthOverride: true,
      textFallbackEnabled: true,
      useFeeScheduleItemCodes: true,
    },
  });
  // A genuinely absent singleton row still has the product's documented defaults.
  // Keep the canonical normalizer so malformed persisted values fail closed in the
  // same direction as every membership path.
  const settings = normalizeMembershipLockoutSettings(persisted);
  const overrideMonth = settings.financialYearEndMonthOverride;
  if (overrideMonth !== null) {
    return { ok: true, effectiveMonth: overrideMonth, source: "override" };
  }

  const connectedTenant = await db.xeroToken.findFirst({
    where: { tenantId: { not: null } },
    select: { id: true },
  });
  return connectedTenant
    ? { ok: false, reason: "connected_xero_month_not_stored" }
    : {
        ok: true,
        effectiveMonth: DEFAULT_FINANCIAL_YEAR_END_MONTH,
        source: "default_without_xero",
      };
}

export async function getFinancialYearResolution(): Promise<FinancialYearResolution> {
  const settings = await loadMembershipLockoutSettings();
  const overrideMonth = settings.financialYearEndMonthOverride;
  const xeroMonth =
    overrideMonth == null ? await getXeroFinancialYearEndMonth() : null;
  const effectiveMonth =
    overrideMonth ?? xeroMonth ?? DEFAULT_FINANCIAL_YEAR_END_MONTH;
  return { overrideMonth, xeroMonth, effectiveMonth };
}
