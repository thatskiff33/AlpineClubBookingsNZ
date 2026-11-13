import type { Prisma } from "@prisma/client";
import {
  calendarDateOfDateOnlyInstant,
  compareCalendarDates,
  requireCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import { DEFAULT_XERO_OUTPUT_TAX_TYPE } from "@/lib/xero-tax-rendering";

/**
 * The club's GST treatment (#4626, Ledger M3a; decision D3 in
 * `docs/design/member-money-ledger.md`), the ONE answer both the member-money
 * journal and every Xero document render from (#4632). `INV-CONFIG-001`:
 * whether a club is GST-registered, at what rate, and under which Xero tax code,
 * is a club's answer, never a constant.
 *
 * A SCHEDULE OF DATED PERIODS in one table (#4632). The `"default"` row is the
 * baseline; an ABSENT baseline means today's treatment, the one every Xero
 * document rendered before #4632 (GST-inclusive prices, the 15% output code):
 * registered, 1500 basis points, in force since 1 October 2010, when New
 * Zealand's rate became 15%. So a deployment that never writes a row renders and
 * posts exactly what it always did. The migrations' column defaults equal these
 * values, and `club-tax-settings.test.ts` reads them to hold them together.
 * Later rows are changes a Full Admin scheduled from a future club date
 * (`club-tax-settings-write.ts`, the one writer): history is never edited.
 *
 * WHICH PERIOD A CHARGE TAKES is fixed by its anchor date, never the date it is
 * rendered or posted (#4632, owner decision A): a booking keeps the treatment
 * in force when it was made, for its whole life, so every invoice, edit, credit
 * note and journal leg for it agree (`xero-tax-anchors.ts`).
 *
 * Prices are GST-inclusive gross cents everywhere in the app, so inclusive is
 * the treatment itself, not a setting: no code prices exclusively, and a flag
 * nothing honours would be a lie in the schema.
 *
 * Unlike the display readers, this one is allowed to throw: a money posting or
 * a Xero document whose tax treatment cannot be read must fail, never fall back
 * to a guess.
 */
export const CLUB_TAX_SETTINGS_ID = "default";

/** A rate above 100% makes no tax law's sense, and lets one cent's tax eat the whole cent. */
export const MAX_TAX_RATE_BASIS_POINTS = 10_000;

/**
 * A tax percentage as whole basis points (15 is 1500, 12.5 is 1250), or null
 * when it is not a finite number. A rate, never money: it lives here, outside
 * the money modules, because basis points are this schedule's unit.
 */
export function percentToBasisPoints(percent: unknown): number | null {
  return typeof percent === "number" && Number.isFinite(percent) ? Math.round(percent * 100) : null;
}

/** One period of the schedule: the treatment in force from `effectiveFrom` until the next period starts. */
export interface ClubTaxPeriod {
  gstRegistered: boolean;
  /** Integer basis points: 1500 is 15%. */
  taxRateBasisPoints: number;
  /** The Xero tax type this period's revenue lines carry; null when the club is not registered. */
  xeroTaxType: string | null;
  /** The first club civil date this treatment covers. */
  effectiveFrom: CalendarDate;
}

/** The periods in start order. The first is the baseline; a date before it has no treatment. */
export type ClubTaxSchedule = readonly ClubTaxPeriod[];

export const CLUB_TAX_SETTINGS_DEFAULTS: Readonly<ClubTaxPeriod> = Object.freeze({
  gstRegistered: true,
  taxRateBasisPoints: 1500,
  xeroTaxType: DEFAULT_XERO_OUTPUT_TAX_TYPE,
  effectiveFrom: requireCalendarDate("2010-10-01"),
});

/** The schedule of a club that never wrote a row. */
export const DEFAULT_CLUB_TAX_SCHEDULE: ClubTaxSchedule = Object.freeze([CLUB_TAX_SETTINGS_DEFAULTS]);

/**
 * What a posting or a Xero document needs to know: whether to split tax out of
 * a gross amount, at what rate, the journal's frozen leg code, and Xero's code.
 */
export type ClubTaxTreatment =
  | { registered: false }
  | { registered: true; rateBasisPoints: number; taxCode: string; xeroTaxType: string };

/** D3: a charge whose split cannot be derived is a defect to fix, never a guess. */
export class ClubTaxTreatmentUnavailableError extends Error {
  constructor(readonly date: CalendarDate, readonly effectiveFrom: CalendarDate) {
    super(`No tax treatment is recorded for ${date}: the club's tax setting starts on ${effectiveFrom}.`);
    this.name = "ClubTaxTreatmentUnavailableError";
  }
}

export function requireTaxRate(rate: number): number {
  if (!Number.isSafeInteger(rate) || rate < 0 || rate > MAX_TAX_RATE_BASIS_POINTS) {
    throw new Error(`A tax rate must be whole basis points from 0 to ${MAX_TAX_RATE_BASIS_POINTS}; got ${rate}.`);
  }
  return rate;
}

/** The frozen code a taxed leg records, so a reversal can repeat its treatment exactly. */
export function clubTaxCode(rateBasisPoints: number): string {
  return `GST_INCLUSIVE_${requireTaxRate(rateBasisPoints)}BP`;
}

/** A period's shape as the schema's CHECKs hold it: a registered period names a Xero code, an unregistered one none. */
function requirePeriod(period: ClubTaxPeriod): ClubTaxPeriod {
  requireTaxRate(period.taxRateBasisPoints);
  const code = period.xeroTaxType;
  if (period.gstRegistered && (code === null || code.trim().length === 0)) {
    throw new Error(`The tax period from ${period.effectiveFrom} is registered but names no Xero tax type.`);
  }
  if (!period.gstRegistered && code !== null) {
    throw new Error(`The tax period from ${period.effectiveFrom} is not registered but names Xero tax type ${code}.`);
  }
  return period;
}

/** The period in force on a club civil date: the last one starting on or before it. */
export function clubTaxPeriodOn(schedule: ClubTaxSchedule, date: CalendarDate): ClubTaxPeriod {
  let inForce: ClubTaxPeriod | undefined;
  for (const period of schedule) {
    if (compareCalendarDates(period.effectiveFrom, date) > 0) break;
    inForce = period;
  }
  if (!inForce) {
    throw new ClubTaxTreatmentUnavailableError(date, schedule[0]?.effectiveFrom ?? CLUB_TAX_SETTINGS_DEFAULTS.effectiveFrom);
  }
  return inForce;
}

/** The treatment in force on a club civil date. Pure: callers resolve the schedule before their transaction. */
export function clubTaxTreatmentOn(schedule: ClubTaxSchedule, date: CalendarDate): ClubTaxTreatment {
  const period = requirePeriod(clubTaxPeriodOn(schedule, date));
  if (!period.gstRegistered) return { registered: false };
  const rateBasisPoints = period.taxRateBasisPoints;
  return { registered: true, rateBasisPoints, taxCode: clubTaxCode(rateBasisPoints), xeroTaxType: period.xeroTaxType! };
}

/** The columns a period is read from: the one select every reader of the table uses. */
export const CLUB_TAX_PERIOD_SELECT = {
  id: true,
  gstRegistered: true,
  taxRateBasisPoints: true,
  xeroTaxType: true,
  effectiveFrom: true,
} as const satisfies Prisma.ClubTaxSettingsSelect;

type StoredPeriod = Prisma.ClubTaxSettingsGetPayload<{ select: typeof CLUB_TAX_PERIOD_SELECT }>;

function periodOfRow(row: StoredPeriod): ClubTaxPeriod {
  return requirePeriod({
    gstRegistered: row.gstRegistered,
    taxRateBasisPoints: row.taxRateBasisPoints,
    xeroTaxType: row.xeroTaxType,
    effectiveFrom: calendarDateOfDateOnlyInstant(row.effectiveFrom),
  });
}

/**
 * THE ONE READER (#4632): the stored schedule, in start order. The baseline is
 * the `"default"` row, or the code defaults when it was never written; every
 * other row is a later period. A later row starting on or before the baseline
 * is a defect in the data, refused rather than silently reordered.
 */
export async function loadClubTaxSchedule(
  db: Pick<Prisma.TransactionClient, "clubTaxSettings">,
): Promise<ClubTaxSchedule> {
  const rows = await db.clubTaxSettings.findMany({ select: CLUB_TAX_PERIOD_SELECT, orderBy: { effectiveFrom: "asc" } });
  const stored = rows.find((row) => row.id === CLUB_TAX_SETTINGS_ID);
  const baseline = stored ? periodOfRow(stored) : CLUB_TAX_SETTINGS_DEFAULTS;
  const later = rows.filter((row) => row.id !== CLUB_TAX_SETTINGS_ID).map(periodOfRow);
  for (const period of later) {
    if (compareCalendarDates(period.effectiveFrom, baseline.effectiveFrom) <= 0) {
      throw new Error(`The tax period from ${period.effectiveFrom} starts on or before the baseline (${baseline.effectiveFrom}).`);
    }
  }
  return Object.freeze([baseline, ...later]);
}
