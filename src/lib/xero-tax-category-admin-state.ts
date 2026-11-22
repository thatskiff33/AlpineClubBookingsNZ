import "server-only";

import { clubTaxPeriodOn, loadClubTaxSchedule } from "@/lib/club-tax-settings";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import {
  XERO_TAX_CATEGORIES,
  xeroTaxCategoryRateProblem,
  type XeroTaxCategoryKey,
} from "@/lib/xero-tax-categories";
import { loadXeroTaxCategoryMappings, mappedTaxTypeFor } from "@/lib/xero-tax-category-mappings";
import { registeredNowOrLater } from "@/lib/xero-tax-category-prerequisites";
import type { XeroTaxRateOption } from "@/lib/xero-tax-rate-options";
import { readXeroTaxRatesOrNull } from "@/lib/xero-tax-rates";

/**
 * What the "Tax categories" card on the Xero screens shows (#5209), served by
 * `GET /api/admin/xero/tax-categories` to any admin with `finance:view`. Every
 * read runs outside any transaction (`INV-LOCK-004`), and nothing in it names a
 * member: the club's categories, their mapped Xero codes and Xero's rates.
 */
export interface XeroTaxCategoryAdminRow {
  key: XeroTaxCategoryKey;
  label: string;
  description: string;
  noSenderYet: string | null;
  /** Sales tax on income comes from the GST / tax treatment card; the rest are mapped here. */
  source: "tax-treatment" | "mapping";
  /** The code in use: today's period's for income, the connected organisation's mapping otherwise. */
  taxType: string | null;
  /** A mapping saved while another Xero organisation was connected, so it reads as unmapped. */
  otherOrganisation: boolean;
  /** Why Xero cannot carry the mapped code now; null when it can, or when it could not be checked. */
  problem: string | null;
}

export interface XeroTaxCategoryAdminState {
  connected: boolean;
  /** Whether a registered period is in force today or scheduled later; otherwise no category is used. */
  registeredNowOrLater: boolean;
  registeredToday: boolean;
  categories: XeroTaxCategoryAdminRow[];
  /** Xero's tax rates, for the pickers; null when Xero could not be read. */
  rates: XeroTaxRateOption[] | null;
}

export async function readXeroTaxCategoryAdminState(): Promise<XeroTaxCategoryAdminState> {
  const [schedule, zone, mappings, rates] = await Promise.all([
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
    loadXeroTaxCategoryMappings(),
    readXeroTaxRatesOrNull(),
  ]);
  const today = clubToday(zone);
  const inForce = clubTaxPeriodOn(schedule, today);

  const categories = XERO_TAX_CATEGORIES.map((definition): XeroTaxCategoryAdminRow => {
    const shared = {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      noSenderYet: "noSenderYet" in definition ? definition.noSenderYet : null,
    };
    if (definition.key === "SALES_TAX_ON_INCOME") {
      return { ...shared, source: "tax-treatment", taxType: inForce.xeroTaxType, otherOrganisation: false, problem: null };
    }
    const row = mappings.rows.find((candidate) => candidate.category === definition.key);
    const taxType = mappedTaxTypeFor(mappings, definition.key);
    return {
      ...shared,
      source: "mapping",
      taxType,
      otherOrganisation: row !== undefined && !row.currentTenant,
      problem: taxType !== null && rates !== null ? xeroTaxCategoryRateProblem(rates, definition.key, taxType) : null,
    };
  });

  return {
    connected: mappings.tenantId !== null,
    registeredNowOrLater: registeredNowOrLater(schedule, today),
    registeredToday: inForce.gstRegistered,
    categories,
    rates,
  };
}
