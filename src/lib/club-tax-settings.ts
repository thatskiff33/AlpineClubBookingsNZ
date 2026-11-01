import type { Prisma } from "@prisma/client";
import {
  calendarDateOfDateOnlyInstant,
  compareCalendarDates,
  requireCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";

/**
 * The club's GST treatment for member-money journal postings (#4626, Ledger
 * M3a; decision D3 in `docs/design/member-money-ledger.md`). `INV-CONFIG-001`:
 * whether a club is GST-registered, and at what rate, is a club's answer, never
 * a constant.
 *
 * One singleton row (`id = "default"`), the house pattern for a configuration
 * domain. An ABSENT row means today's treatment, the one every Xero document
 * already renders (GST-inclusive prices, the 15% output code): registered, 1500
 * basis points, in force since 1 October 2010, when New Zealand's rate became
 * 15%. So a deployment that never writes the row posts exactly what it invoices.
 * The migration's column defaults equal these values, and
 * `club-tax-settings.test.ts` reads the migration to hold them together.
 *
 * Prices are GST-inclusive gross cents everywhere in the app, so inclusive is
 * the treatment itself, not a setting: no code prices exclusively, and a flag
 * nothing honours would be a lie in the schema.
 *
 * Unlike the display readers, this one is allowed to throw: a money posting
 * whose tax treatment cannot be read must fail, never fall back to a guess.
 */
export const CLUB_TAX_SETTINGS_ID = "default";

/** A rate above 100% makes no tax law's sense, and lets one cent's tax eat the whole cent. */
export const MAX_TAX_RATE_BASIS_POINTS = 10_000;

export interface ClubTaxSettings {
  gstRegistered: boolean;
  /** Integer basis points: 1500 is 15%. */
  taxRateBasisPoints: number;
  /** The first club civil date this treatment covers. */
  effectiveFrom: CalendarDate;
}

export const CLUB_TAX_SETTINGS_DEFAULTS: Readonly<ClubTaxSettings> = Object.freeze({
  gstRegistered: true,
  taxRateBasisPoints: 1500,
  effectiveFrom: requireCalendarDate("2010-10-01"),
});

/** What a posting needs to know: whether to split tax out of a gross amount, and at what rate. */
export type ClubTaxTreatment =
  | { registered: false }
  | { registered: true; rateBasisPoints: number; taxCode: string };

/** D3: a charge whose split cannot be derived is a defect to fix, never a guess. */
export class ClubTaxTreatmentUnavailableError extends Error {
  constructor(readonly date: CalendarDate, readonly effectiveFrom: CalendarDate) {
    super(`No tax treatment is recorded for ${date}: the club's tax setting starts on ${effectiveFrom}.`);
    this.name = "ClubTaxTreatmentUnavailableError";
  }
}

function requireRate(rate: number): number {
  if (!Number.isSafeInteger(rate) || rate < 0 || rate > MAX_TAX_RATE_BASIS_POINTS) {
    throw new Error(`A tax rate must be whole basis points from 0 to ${MAX_TAX_RATE_BASIS_POINTS}; got ${rate}.`);
  }
  return rate;
}

/** The frozen code a taxed leg records, so a reversal can repeat its treatment exactly. */
export function clubTaxCode(rateBasisPoints: number): string {
  return `GST_INCLUSIVE_${requireRate(rateBasisPoints)}BP`;
}

/** The treatment in force on a club civil date. Pure: callers resolve it before their transaction. */
export function clubTaxTreatmentOn(settings: ClubTaxSettings, date: CalendarDate): ClubTaxTreatment {
  if (compareCalendarDates(date, settings.effectiveFrom) < 0) {
    throw new ClubTaxTreatmentUnavailableError(date, settings.effectiveFrom);
  }
  if (!settings.gstRegistered) return { registered: false };
  const rateBasisPoints = requireRate(settings.taxRateBasisPoints);
  return { registered: true, rateBasisPoints, taxCode: clubTaxCode(rateBasisPoints) };
}

/** The stored setting, or the defaults when no row has been written. */
export async function loadClubTaxSettings(
  db: Pick<Prisma.TransactionClient, "clubTaxSettings">,
): Promise<ClubTaxSettings> {
  const row = await db.clubTaxSettings.findUnique({
    where: { id: CLUB_TAX_SETTINGS_ID },
    select: { gstRegistered: true, taxRateBasisPoints: true, effectiveFrom: true },
  });
  if (!row) return { ...CLUB_TAX_SETTINGS_DEFAULTS };
  return {
    gstRegistered: row.gstRegistered,
    taxRateBasisPoints: requireRate(row.taxRateBasisPoints),
    effectiveFrom: calendarDateOfDateOnlyInstant(row.effectiveFrom),
  };
}
