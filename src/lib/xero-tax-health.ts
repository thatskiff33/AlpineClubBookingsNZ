import { clubTaxPeriodOn, loadClubTaxSchedule } from "@/lib/club-tax-settings";
import { clubToday } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import { getXeroConnectedOrganisation } from "@/lib/xero-organisation";
import { xeroTaxCodeProblem } from "@/lib/xero-tax-rate-options";
import { readXeroTaxRatesOrNull } from "@/lib/xero-tax-rates";

/**
 * DOES XERO STILL AGREE WITH THE CLUB'S TAX TREATMENT? (#4632). The writer
 * checks a period's code when it is saved; this checks the period in force
 * today against what Xero says now, since a treasurer can archive a rate or
 * change the organisation's tax status in Xero at any time. Three cases:
 *
 * - the code in force is missing, inactive or not usable on revenue;
 * - its rate in Xero differs from the period's rate;
 * - the organisation's `PaysTax` disagrees with the registered flag.
 *
 * Read outside any transaction. `checked` is false when Xero could not be read
 * at all, so a screen says "not checked" rather than "fine".
 */
export interface XeroTaxHealth {
  checked: boolean;
  problems: string[];
}

export async function readXeroTaxHealth(): Promise<XeroTaxHealth> {
  const [schedule, zone, rates, organisation] = await Promise.all([
    loadClubTaxSchedule(prisma),
    readClubTimeZoneOutsideRequest(),
    readXeroTaxRatesOrNull(),
    getXeroConnectedOrganisation(),
  ]);
  const period = clubTaxPeriodOn(schedule, clubToday(zone));
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
  return { checked: rates !== null || paysTax !== null, problems };
}
