import { clubTaxPeriodOn, loadClubTaxSchedule } from "@/lib/club-tax-settings";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import {
  openingCreditsExemptHealthProblem,
  openingCreditsSharedAccountHealthProblem,
} from "@/lib/xero-opening-credits-exempt-guards";
import { getXeroConnectedOrganisation } from "@/lib/xero-organisation";
import { xeroTaxCategoryLabel, xeroTaxCategoryRateProblem } from "@/lib/xero-tax-categories";
import { loadXeroTaxCategoryMappings, type XeroTaxCategoryMappings } from "@/lib/xero-tax-category-mappings";
import { xeroTaxCodeProblem, type XeroTaxRateOption } from "@/lib/xero-tax-rate-options";
import { readXeroTaxRatesOrNull } from "@/lib/xero-tax-rates";
import { countOpenXeroTaxOverrideMismatches, xeroTaxOverridePauseProblem } from "@/lib/xero-tax-override-safeguard";

/**
 * DOES XERO STILL AGREE WITH THE CLUB'S TAX TREATMENT? (#4632). The writer
 * checks a period's code when it is saved; this checks the period in force
 * today against what Xero says now, since a treasurer can archive a rate or
 * change the organisation's tax status in Xero at any time. The cases:
 *
 * - the code in force is missing, inactive or not usable on revenue;
 * - its rate in Xero differs from the period's rate;
 * - the organisation's `PaysTax` disagrees with the registered flag;
 * - a mapped tax category (#5209) names a rate Xero no longer has, has made
 *   inactive, or no longer fits the category, or was mapped in a different
 *   Xero organisation from the one connected now;
 * - the Opening Credits account is mapped, a registered period applies today
 *   or is scheduled, and the Exempt category has no usable rate (#4988), so
 *   spent opening credits are waiting or will wait, and a card booking's
 *   invoice operation fails;
 * - the Opening Credits account is stored on the Xero account another mapping
 *   uses (#4988), which the mapping screen and the config import refuse but two
 *   writes at once can still leave (#5391).
 *
 * And one the app found itself (#5208): Xero changed the GST sent on an invoice,
 * so the journal's GST overrides are paused until finance resumes them.
 *
 * Read outside any transaction. `checked` is false when Xero could not be read
 * at all, so a screen says "not checked" rather than "fine".
 */
export interface XeroTaxHealth {
  checked: boolean;
  problems: string[];
}

export async function readXeroTaxHealth(): Promise<XeroTaxHealth> {
  const [schedule, zone, rates, organisation, mappings, pausedInvoices] = await Promise.all([
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
    readXeroTaxRatesOrNull(),
    getXeroConnectedOrganisation(),
    loadXeroTaxCategoryMappings(),
    countOpenXeroTaxOverrideMismatches(),
  ]);
  const today = clubToday(zone);
  const period = clubTaxPeriodOn(schedule, today);
  const problems: string[] = [];
  const codeProblem = rates === null ? null : xeroTaxCodeProblem(rates, period);
  if (codeProblem) problems.push(codeProblem);
  // A failed read may still carry the last good value; prefer it (`XeroConnectedOrganisation`).
  const paysTax = organisation.paysTax;
  if (paysTax !== null && paysTax !== period.gstRegistered) {
    problems.push(
      period.gstRegistered
        ? "The club's tax setting says it is GST-registered, but Xero says the organisation does not pay tax."
        : "The club's tax setting says it is not GST-registered, but Xero says the organisation pays tax.",
    );
  }
  problems.push(...categoryProblems(mappings, rates));
  // #4988: the state the settings screens refuse to create, reported when it arises another way.
  const openingCredits = await openingCreditsExemptHealthProblem({ schedule, today, mappings, rates });
  if (openingCredits) problems.push(openingCredits);
  const sharedAccount = await openingCreditsSharedAccountHealthProblem(mappings);
  if (sharedAccount) problems.push(sharedAccount);
  const pause = xeroTaxOverridePauseProblem(pausedInvoices);
  if (pause) problems.push(pause);
  return { checked: rates !== null || paysTax !== null, problems };
}

/** A mapped category Xero can no longer carry. A tenant mismatch needs no Xero read; a rate problem does. */
function categoryProblems(mappings: XeroTaxCategoryMappings, rates: readonly XeroTaxRateOption[] | null): string[] {
  // Not connected: there is no organisation to judge against, and nothing sends.
  if (mappings.tenantId === null) return [];
  return mappings.rows.flatMap((row) => {
    if (!row.currentTenant) {
      return [`${xeroTaxCategoryLabel(row.category)}: mapped in a different Xero organisation from the one connected now; map it again.`];
    }
    const problem = rates === null ? null : xeroTaxCategoryRateProblem(rates, row.category, row.taxType);
    return problem ? [problem] : [];
  });
}
