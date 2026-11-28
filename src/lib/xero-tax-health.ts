import { clubTaxPeriodOn, loadClubTaxSchedule } from "@/lib/club-tax-settings";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import { normalizeXeroAccountClass } from "@/lib/xero-account-class";
import { MAPPING_LABELS, normalizeMappingCode } from "@/lib/xero-account-mapping-keys";
import { readLastStoredChartOfAccounts } from "@/lib/xero-admin-cache";
import { hutFeeRefundLineCodes } from "@/lib/xero-hut-fee-line-codes";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { expenseRefundRateReason, rateRefusedOnExpenses, readRefundableTaxTypes } from "@/lib/xero-refund-expense-tax";
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
 *   uses (#4988), which the mapping screen and the config import refuse, each
 *   under the key the other holds (#5391), but a row written before that, or
 *   straight to the database, can still carry;
 * - Hut Fee Refunds is mapped to an expense account and Xero says a code a
 *   refund note can still carry cannot be used on expenses (#5235), so Xero
 *   would reject refund credit notes.
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
  const refundAccount = await hutFeeRefundsExpenseAccountProblem(rates);
  if (refundAccount) problems.push(refundAccount);
  const pause = xeroTaxOverridePauseProblem(pausedInvoices);
  if (pause) problems.push(pause);
  return { checked: rates !== null || paysTax !== null, problems };
}

/**
 * HUT FEE REFUNDS ON AN EXPENSE ACCOUNT (#5235). Reported when the account the
 * refund line names (`hutFeeRefundLineCodes`) is an expense account in the
 * chart last stored and Xero says one of the tax codes a refund note can still
 * carry cannot be used on expenses (`readRefundableTaxTypes`: every registered
 * period refundable bookings can still anchor to, not only today's). The
 * mapping save refuses to create this; the line reports it when it arises
 * another way, such as a rate changed in Xero. The chart is read even after its
 * hour is up, so the warning does not clear itself once nobody has opened an
 * account screen for a while.
 *
 * Null whenever one of them cannot be established: no stored chart or one that
 * could not be read, a code the chart does not list, or a line that takes its
 * account from a Xero item. Nothing is read while Xero's rates could not be read.
 */
async function hutFeeRefundsExpenseAccountProblem(
  rates: readonly XeroTaxRateOption[] | null,
): Promise<string | null> {
  if (rates === null) return null;
  // The rates first: a club with no registered period a refund can reach, or
  // whose codes Xero allows on expenses, has nothing to place in the chart.
  const rate = rateRefusedOnExpenses(await readRefundableTaxTypes(), rates);
  if (!rate) return null;
  const [mapping, chart] = await Promise.all([
    getResolvedAccountMapping("hutFeeRefunds"),
    readLastStoredChartOfAccounts(),
  ]);
  const lineAccount = normalizeMappingCode(hutFeeRefundLineCodes(mapping).accountCode);
  const account = chart?.find((row) => normalizeMappingCode(row.code) === lineAccount);
  if (!lineAccount || !account || normalizeXeroAccountClass(account.class) !== "EXPENSE") return null;
  return `${MAPPING_LABELS.hutFeeRefunds} is mapped to an expense account. ${expenseRefundRateReason(rate)} Map ${MAPPING_LABELS.hutFeeRefunds} to a revenue account, or ask your accountant which account and tax rate refunds should use.`;
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
