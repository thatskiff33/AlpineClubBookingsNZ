import "server-only";

import { randomUUID } from "node:crypto";

import { buildStructuredAuditLogCreateArgs, getAuditRequestContext } from "@/lib/audit";
import {
  CLUB_TAX_SETTINGS_ID,
  clubTaxPeriodOn,
  loadClubTaxSchedule,
  requireTaxRate,
  type ClubTaxPeriod,
} from "@/lib/club-tax-settings";
import {
  addCalendarDays,
  clubToday,
  compareCalendarDates,
  dateOnlyInstantOf,
  type CalendarDate,
  type ClubTimeZone,
} from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import { xeroTaxCodeProblem } from "@/lib/xero-tax-rate-options";
import { readXeroTaxRates } from "@/lib/xero-tax-rates";

/**
 * THE ONE WRITER of the club's tax treatment (#4632), behind `PUT` and `DELETE
 * /api/admin/club-tax`. `club-tax-settings-one-writer-census.test.ts` holds every
 * other production path to reads. The route validates the body and authorises
 * a Full Admin; this decides what may change and records it.
 *
 * HISTORY IS APPEND-ONLY. A change is a new period that starts on a future club
 * date — tomorrow at the earliest — and cancelling one deletes a period that has
 * not started. Nothing here touches the `"default"` baseline row or a period
 * already in force: every document already sent to Xero and every journal leg
 * already posted was rendered under a period that stays exactly as it was, and
 * a booking made before a change keeps the old treatment for its whole life
 * (owner decision A, `xero-tax-anchors.ts`).
 *
 * XERO MUST CARRY THE CODE. A registered period names a Xero tax type that Xero's
 * own tax-rate list shows active, usable on revenue and at the period's rate, so
 * the rate the journal splits at and the code Xero splits under cannot disagree.
 * The list is read fresh and BEFORE the transaction (`INV-LOCK-004`): a provider
 * call is never made under a database transaction. When Xero cannot be read the
 * change is refused, never saved on a guess.
 *
 * SERIALIZABLE, AND NO ADVISORY LOCK (`INV-LOCK-001`): one table plus its audit
 * row, the `writeClubFormat` shape. A write only adds or removes a period that
 * starts after today, so it cannot race a render or a posting about any date up
 * to today. Serializable aborts the loser of two saves for one date; the route
 * answers that, P2002 and P2028 a retryable 503.
 */

/** A period to schedule; the writer derives what an unregistered period stores. */
export interface ClubTaxChange {
  gstRegistered: boolean;
  taxRateBasisPoints: number;
  xeroTaxType: string | null;
  effectiveFrom: CalendarDate;
}

export type ClubTaxWriteRefusal =
  | { refused: "not-future"; earliest: CalendarDate }
  | { refused: "xero-code"; message: string }
  | { refused: "xero-unreadable" }
  | { refused: "already-scheduled" }
  | { refused: "unchanged" }
  | { refused: "not-found" };

export type ClubTaxWriteOutcome = { changed: true; period: ClubTaxPeriod } | ClubTaxWriteRefusal;

/** The first club date a change may start on: tomorrow. */
export async function earliestClubTaxChangeDate(): Promise<CalendarDate> {
  return earliestChangeDateIn(await readClubTimeZoneOutsideRequest());
}

function earliestChangeDateIn(zone: ClubTimeZone): CalendarDate {
  return addCalendarDays(clubToday(zone), 1);
}

/**
 * Re-checked inside the transaction, after the Xero read: a save checked at
 * 23:59 must not commit a period that started at midnight, which bookings
 * made in between were already posted without.
 */
function startedRefusal(effectiveFrom: CalendarDate, zone: ClubTimeZone): ClubTaxWriteRefusal | null {
  const earliest = earliestChangeDateIn(zone);
  return compareCalendarDates(effectiveFrom, earliest) < 0 ? { refused: "not-future", earliest } : null;
}

/** What an unregistered period stores: no rate and no Xero code, as the schema's CHECK requires. */
function periodOf(change: ClubTaxChange): ClubTaxPeriod {
  if (!change.gstRegistered) {
    return { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: change.effectiveFrom };
  }
  return {
    gstRegistered: true,
    taxRateBasisPoints: requireTaxRate(change.taxRateBasisPoints),
    xeroTaxType: change.xeroTaxType?.trim() || null,
    effectiveFrom: change.effectiveFrom,
  };
}

function sameTreatment(a: ClubTaxPeriod, b: ClubTaxPeriod): boolean {
  return a.gstRegistered === b.gstRegistered
    && a.taxRateBasisPoints === b.taxRateBasisPoints
    && a.xeroTaxType === b.xeroTaxType;
}

function auditPeriod(period: ClubTaxPeriod) {
  return {
    gstRegistered: period.gstRegistered,
    taxRateBasisPoints: period.taxRateBasisPoints,
    xeroTaxType: period.xeroTaxType,
    effectiveFrom: period.effectiveFrom,
  };
}

export async function scheduleClubTaxChange({
  change,
  actingMemberId,
  request,
}: {
  change: ClubTaxChange;
  actingMemberId: string;
  request: Request;
}): Promise<ClubTaxWriteOutcome> {
  const period = periodOf(change);
  const zone = await readClubTimeZoneOutsideRequest();
  const notFuture = startedRefusal(period.effectiveFrom, zone);
  if (notFuture) return notFuture;

  if (period.gstRegistered) {
    let rates;
    try {
      rates = await readXeroTaxRates({ fresh: true });
    } catch {
      return { refused: "xero-unreadable" };
    }
    const problem = xeroTaxCodeProblem(rates, period);
    if (problem) return { refused: "xero-code", message: problem };
  }

  return prisma.$transaction(
    async (tx) => {
      const started = startedRefusal(period.effectiveFrom, zone);
      if (started) return started;
      const schedule = await loadClubTaxSchedule(tx);
      if (schedule.some((existing) => existing.effectiveFrom === period.effectiveFrom)) {
        return { refused: "already-scheduled" as const };
      }
      // A period repeating the one it would follow changes nothing a document or a posting carries.
      if (sameTreatment(clubTaxPeriodOn(schedule, addCalendarDays(period.effectiveFrom, -1)), period)) {
        return { refused: "unchanged" as const };
      }
      await tx.clubTaxSettings.create({
        data: {
          id: randomUUID(),
          gstRegistered: period.gstRegistered,
          taxRateBasisPoints: period.taxRateBasisPoints,
          // Explicit even when null: the column defaults to the baseline code, which the CHECK refuses on an unregistered row.
          xeroTaxType: period.xeroTaxType,
          effectiveFrom: dateOnlyInstantOf(period.effectiveFrom),
          updatedByMemberId: actingMemberId,
        },
      });
      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "CLUB_TAX_TREATMENT_SCHEDULED",
          actor: { memberId: actingMemberId },
          entity: { type: "ClubTaxSettings", id: period.effectiveFrom },
          // Installation configuration, like CLUB_FORMAT_UPDATED.
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: `Club tax treatment change scheduled from ${period.effectiveFrom}`,
          metadata: { period: auditPeriod(period) },
          request: getAuditRequestContext(request),
        }),
      );
      return { changed: true as const, period };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function cancelScheduledClubTaxChange({
  effectiveFrom,
  actingMemberId,
  request,
}: {
  effectiveFrom: CalendarDate;
  actingMemberId: string;
  request: Request;
}): Promise<ClubTaxWriteOutcome> {
  const zone = await readClubTimeZoneOutsideRequest();
  // A period that has started is history: documents and postings were rendered under it.
  const notFuture = startedRefusal(effectiveFrom, zone);
  if (notFuture) return notFuture;

  return prisma.$transaction(
    async (tx) => {
      const started = startedRefusal(effectiveFrom, zone);
      if (started) return started;
      const schedule = await loadClubTaxSchedule(tx);
      const period = schedule.slice(1).find((existing) => existing.effectiveFrom === effectiveFrom);
      if (!period) return { refused: "not-found" as const };
      await tx.clubTaxSettings.deleteMany({
        where: { effectiveFrom: dateOnlyInstantOf(effectiveFrom), id: { not: CLUB_TAX_SETTINGS_ID } },
      });
      await tx.auditLog.create(
        buildStructuredAuditLogCreateArgs({
          action: "CLUB_TAX_TREATMENT_SCHEDULE_CANCELLED",
          actor: { memberId: actingMemberId },
          entity: { type: "ClubTaxSettings", id: effectiveFrom },
          category: "admin",
          severity: "important",
          outcome: "success",
          summary: `Scheduled club tax treatment change from ${effectiveFrom} cancelled`,
          metadata: { period: auditPeriod(period) },
          request: getAuditRequestContext(request),
        }),
      );
      return { changed: true as const, period };
    },
    { isolationLevel: "Serializable" },
  );
}
