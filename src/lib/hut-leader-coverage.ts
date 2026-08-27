import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { countActiveGuestsForNight } from "@/lib/booking-guest-stay-ranges";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import {
  loadHutLeaderLookaheadDays,
  normalizeHutLeaderLookaheadDays,
  type LodgeSettingsReader,
} from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";

/**
 * ONE UNCOVERED LODGE-NIGHT, never a bare calendar night (#2917).
 *
 * Each lodge runs its own hut leader, so "this night needs a leader" is only ever
 * true *of a lodge*. A night on which two lodges are both uncovered is therefore
 * two rows — same `date`, different `lodgeId` — and `bookingCount`/`guestCount`
 * describe that lodge alone. Merging them, as this result did before, told an
 * officer a number without telling them where to send anyone, and the auto-assign
 * cron had already been made per (lodge, night) by #2915/#2916; this is the read
 * side agreeing with the writer side.
 *
 * A single-lodge club sees exactly what it saw before: one row per uncovered
 * night, with the same counts.
 */
export interface UnassignedHutLeaderDate {
  date: string;
  /**
   * The lodge that is uncovered. Null only if a booking row carries no lodge,
   * which the schema's non-null `Booking.lodgeId` should make unreachable — it is
   * tolerated rather than assumed so a legacy row cannot throw a dashboard.
   */
  lodgeId: string | null;
  /** For display; callers must not use it as an identity (see the Presentation Rule). */
  lodgeName: string | null;
  /**
   * Whether that lodge is still active.
   *
   * `false` is the archived-but-occupied case, and it is deliberately reported
   * rather than filtered away. Deactivating a lodge that still has future
   * bookings is permitted with `force` (`findLodgeDeactivationRefusal` in
   * `src/lib/lodge-deactivation-guard.ts` reports them and can be overridden)
   * and does not cancel them, so real guests still arrive on those nights and
   * still need a leader. An uncovered night nobody can see is worse than one
   * that is awkward to clear, so the row stays and names its lodge.
   *
   * Null only where `lodgeId` is null (the legacy lodge-less row below).
   */
  lodgeActive: boolean | null;
  bookingCount: number;
  guestCount: number;
}

type HutLeaderBooking = {
  lodgeId: string | null;
  lodge?: { name: string; active?: boolean } | null;
  checkIn: Date;
  checkOut: Date;
  guests?: Array<{
    stayStart?: Date | null;
    stayEnd?: Date | null;
    nights?: Array<{ stayDate: Date }> | null;
  }> | null;
  _count?: {
    guests?: number;
  };
};

type HutLeaderCoverageDb = LodgeSettingsReader & {
  booking: {
    findMany(args: unknown): Promise<HutLeaderBooking[]>;
  };
  hutLeaderAssignment: {
    findMany(args: unknown): Promise<
      Array<{ lodgeId: string | null; startDate: Date; endDate: Date }>
    >;
  };
};

/** Ordinal string comparison. Never localeCompare: a locale must not be able to
 * reorder an API response, and an ICU build difference between two servers would
 * do exactly that. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type HutLeaderCoverageScope =
  | { kind: "lodge"; lodgeId: string }
  | { kind: "all" };

export async function getUnassignedHutLeaderDates(input: {
  db?: HutLeaderCoverageDb;
  lookAheadDays?: number;
  today?: Date;
  // Explicit date-only window. When BOTH are supplied they replace the
  // today→today+lookahead window (used to paint a calendar month, including
  // past nights for history). When absent, behaviour is exactly as before.
  from?: Date;
  to?: Date;
  // Interactive pages must name one lodge. Club dashboards opt into `all`
  // explicitly, so omission can never widen a lodge read by accident.
  scope: HutLeaderCoverageScope;
}): Promise<UnassignedHutLeaderDate[]> {
  const db = input.db ?? (prisma as unknown as HutLeaderCoverageDb);
  const today = input.today ?? (await clubTodayDateOnlyInstant());

  const hasWindow = input.from != null && input.to != null;
  let windowStart: Date;
  let endDate: Date;
  if (hasWindow) {
    windowStart = input!.from!;
    endDate = input!.to!;
  } else {
    const lookAheadDays =
      input.lookAheadDays ?? (await loadHutLeaderLookaheadDays(db));
    windowStart = today;
    endDate = addDaysDateOnly(
      today,
      normalizeHutLeaderLookaheadDays(lookAheadDays),
    );
  }

  const [assignments, bookings] = await Promise.all([
    db.hutLeaderAssignment.findMany({
      where: {
        ...(input.scope.kind === "lodge"
          ? { lodgeId: input.scope.lodgeId }
          : {}),
        startDate: { lte: endDate },
        endDate: { gte: windowStart },
      },
      select: { lodgeId: true, startDate: true, endDate: true },
    }),
    db.booking.findMany({
      where: {
        // A club-wide read is deliberately NOT filtered to active lodges
        // (#2917 review). Deactivating a lodge that still has future bookings is
        // permitted with `force` and does not cancel them, so an archived lodge
        // can have live guest nights with no leader; filtering it out removed the
        // only signal of a stranded stay from every surface at once — the
        // dashboard card, the sidebar badge and the stuck-state tile — and no
        // other page can show it either. The row is instead reported with
        // `lodgeActive: false` and its lodge named, so an officer can see which
        // lodge it is and that it is archived. The `lodge` scope needs no filter:
        // its callers resolve the id through resolveOptionalActiveLodgeId first.
        ...(input.scope.kind === "lodge"
          ? { lodgeId: input.scope.lodgeId }
          : {}),
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        deletedAt: null,
        checkIn: { lte: endDate },
        checkOut: { gt: windowStart },
      },
      select: {
        lodgeId: true,
        // Named on the row so a club-wide caller can say WHICH lodge without a
        // second query; every row is produced by a booking, so the relation is
        // always loaded where a row exists. `active` travels with the name
        // because a club-wide read can legitimately surface an archived lodge
        // (see the where-clause above).
        lodge: { select: { name: true, active: true } },
        checkIn: true,
        checkOut: true,
        guests: {
          select: {
            stayStart: true,
            stayEnd: true,
            nights: { select: { stayDate: true } },
          },
        },
      },
    }),
  ]);

  function isDateCovered(date: Date, lodgeId: string | null): boolean {
    return assignments.some(
      (assignment) =>
        assignment.lodgeId === lodgeId &&
        assignment.startDate.getTime() <= date.getTime() &&
        assignment.endDate.getTime() >= date.getTime(),
    );
  }

  type LodgeNightStats = {
    lodgeId: string | null;
    lodgeName: string | null;
    lodgeActive: boolean | null;
    bookingCount: number;
    guestCount: number;
  };

  /**
   * The uncovered lodges on one night, keyed by lodge.
   *
   * The trigger condition per lodge is UNCHANGED from the club-wide version: an
   * operational booking occupying that night, at a lodge with no assignment
   * covering it, carrying at least one guest active on that night —
   * `countActiveGuestsForNight`, i.e. `isGuestActiveOnNight`. Only the grouping
   * changed: the counts are now banked per lodge instead of summed across all of
   * them.
   *
   * That night predicate is deliberately NOT the writer side's, and this reader
   * does not claim to match it. The #2916 auto-assign cron filters its guests
   * with `OPERATIONALLY_PRESENT_GUEST_WHERE` (consent null or CONFIRMED) over the
   * operational-DAY model, so two documented divergences remain: a guest on their
   * departure morning is operationally present but is not a night here, and a
   * member guest whose consent is still PENDING raises an amber row here that the
   * cron will never auto-assign for. An amber row an officer clears by hand is
   * the safe direction for both.
   */
  function getBookingStatsByLodge(date: Date): Map<string, LodgeNightStats> {
    const byLodge = new Map<string, LodgeNightStats>();

    for (const booking of bookings) {
      if (isDateCovered(date, booking.lodgeId)) {
        continue;
      }
      if (
        booking.checkIn.getTime() > date.getTime() ||
        booking.checkOut.getTime() <= date.getTime()
      ) {
        continue;
      }

      const legacyGuestCount = booking._count?.guests ?? 0;
      const activeGuestCount = Array.isArray(booking.guests)
        ? countActiveGuestsForNight(booking.guests, date, booking)
        : legacyGuestCount;

      if (activeGuestCount <= 0) {
        continue;
      }

      // "" is the key for a lodge-less legacy row — distinct from every cuid,
      // and it keeps such rows grouped together rather than one row each.
      const key = booking.lodgeId ?? "";
      const stats = byLodge.get(key) ?? {
        lodgeId: booking.lodgeId ?? null,
        lodgeName: booking.lodge?.name ?? null,
        lodgeActive: booking.lodge?.active ?? null,
        bookingCount: 0,
        guestCount: 0,
      };
      stats.bookingCount++;
      stats.guestCount += activeGuestCount;
      byLodge.set(key, stats);
    }

    return byLodge;
  }

  const unassignedDates: UnassignedHutLeaderDate[] = [];

  for (
    let day = windowStart;
    day.getTime() <= endDate.getTime();
    day = addDaysDateOnly(day, 1)
  ) {
    const date = formatDateOnly(day);
    // Deterministic order: date ascending (the loop), then lodge name, then
    // lodge id as the tie-break so two lodges sharing a name never swap places
    // between calls.
    const lodgeNights = [...getBookingStatsByLodge(day).values()].sort(
      (left, right) =>
        compare(left.lodgeName ?? "", right.lodgeName ?? "") ||
        compare(left.lodgeId ?? "", right.lodgeId ?? ""),
    );

    for (const lodgeNight of lodgeNights) {
      unassignedDates.push({ date, ...lodgeNight });
    }
  }

  return unassignedDates;
}

/**
 * Whether a club-wide coverage surface must name the lodge on each row and use
 * the lodge-night noun.
 *
 * Keyed on the CLUB, never on the result. The rule is ADR-002's Presentation
 * Rule — "when exactly one active lodge exists" — measured with the house
 * predicate `countActiveLodges` (`src/lib/lodges.ts`), which is how
 * `booking-request-quotes.ts` and `api/admin/bookings/route.ts` decide the same
 * question. Deriving it from how many lodges the ROWS span was wrong twice over:
 * a three-lodge club whose gaps all sat at one lodge was shown bare dates that
 * never said where to send anyone (the outcome #2917's decision rejected), and
 * the wording flipped between page loads as unrelated lodges gained and lost
 * cover.
 *
 * The second clause is the archived-but-occupied case: a club with exactly one
 * active lodge can still be shown a row for an archived lodge that kept its
 * future bookings, and a bare date there would point the officer at the wrong
 * lodge.
 */
export function coverageNeedsLodgeContext(input: {
  activeLodgeCount: number;
  rows: readonly UnassignedHutLeaderDate[];
}): boolean {
  return (
    input.activeLodgeCount > 1 ||
    input.rows.some((row) => row.lodgeActive === false)
  );
}

/**
 * The lodge label for one row: its name, marked when the lodge is archived.
 *
 * The marker matters because the hut-leaders workspace cannot select an archived
 * lodge (`useLodgeOptions` offers active lodges only), so an officer sent to a
 * bare name they cannot find in the selector would think the dashboard was
 * wrong. Callers apply it only when `coverageNeedsLodgeContext` is true.
 */
export function coverageLodgeLabel(row: UnassignedHutLeaderDate): string | null {
  if (!row.lodgeName) return null;
  return row.lodgeActive === false
    ? `${row.lodgeName}, archived`
    : row.lodgeName;
}
