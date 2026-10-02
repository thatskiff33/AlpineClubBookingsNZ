import { HutLeaderAssignmentSource, type Prisma } from "@prisma/client";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import {
  isGuestActiveOnNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { memberName } from "@/lib/member-serialization";
import {
  deriveHutLeaderDayHalves,
  type HutLeaderOnNight,
} from "@/lib/hut-leader-handover";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
} from "@/lib/club-time";

/**
 * IS LODGE NIGHT D COVERED BY A HUT LEADER? — the one answer (#3818, `INV-DATE-030`).
 *
 * A night is covered when an assignment's nights include D **and** the person
 * on it is in the lodge that night. An assignment row alone used to be enough,
 * which is how a leader who left on Wednesday morning still "covered" Wednesday
 * night: the auto-assign cron (and many manual rows) stamped `endDate` as the
 * checkout day, and every reader took the row's dates at their word (#3789).
 * Presence settles it without touching the rows, so those rows heal themselves
 * and there is no backfill.
 *
 * Presence is decided per row, by what the row is:
 *
 *  - **A custodian (bed-holding) assignment** is present on every night it
 *    covers, inclusive. Its bed hold IS its occupancy (`INV-LIFE-062`); a
 *    custodian has no `BookingGuest`, so asking for a stay would discard every
 *    custodian.
 *  - **A school-booking teacher row** (`source = SCHOOL_BOOKING`) is present on
 *    the school booking's own nights. See {@link isSchoolRowPresentOnNight}.
 *  - **Every other row** needs its member on an operational stay at the SAME
 *    lodge that night: a `BookingGuest` row for that member, on a non-deleted
 *    booking in `OPERATIONAL_STAY_BOOKING_STATUSES` (the same set that decides a
 *    night needs a leader at all), operationally consented, and active on the
 *    night by `isGuestActiveOnNight` — the frozen night-model predicate, reused,
 *    never restated (`INV-DATE-003`/`INV-DATE-005`). A cancelled, bumped or
 *    archived stay is simply not loaded, so it covers nothing.
 *
 * Every coverage reader goes through this module — the dashboard card, the
 * sidebar badge, the stuck-state tile, the hut-leaders calendar, the
 * eligible-members suggestions and the auto-assign cron's already-covered probe.
 * `hut-leader-night-cover-census.test.ts` fails a reader that reads assignment
 * dates as coverage on its own.
 */

/** One assignment row, as the coverage question needs it. */
export type HutLeaderShift = {
  id: string;
  memberId: string;
  lodgeId: string | null;
  startDate: Date;
  endDate: Date;
  source: HutLeaderAssignmentSource | `${HutLeaderAssignmentSource}`;
  bedId: string | null;
  member?: { firstName: string | null; lastName: string | null } | null;
  lodge?: { name: string; active?: boolean } | null;
};

/** One member's stay segment, as presence needs it. */
export type HutLeaderStay = GuestStayRange & {
  memberId: string | null;
  booking: { lodgeId: string | null; checkIn: Date; checkOut: Date };
};

export type HutLeaderNightCoverScope =
  | { kind: "lodge"; lodgeId: string }
  | { kind: "all" };

export type HutLeaderNightCoverDb = {
  hutLeaderAssignment: {
    findMany(args: unknown): Promise<HutLeaderShift[]>;
  };
  bookingGuest: {
    findMany(args: unknown): Promise<HutLeaderStay[]>;
  };
};

/**
 * What the loader accepts: the Prisma client, a transaction client, or a test
 * double speaking the two reads. The select shape is this module's own, so the
 * narrowing cast inside the loader is to the rows it asked for.
 */
export type HutLeaderNightCoverReader =
  | HutLeaderNightCoverDb
  | Pick<Prisma.TransactionClient, "hutLeaderAssignment" | "bookingGuest">;

export type HutLeaderNightCover = {
  /** The assignments that validly cover `night` at `lodgeId`, in load order. */
  coveringShifts(lodgeId: string | null, night: Date): HutLeaderShift[];
  /** Whether any assignment validly covers `night` at `lodgeId`. */
  isCovered(lodgeId: string | null, night: Date): boolean;
  /** Every assignment loaded, valid or not, for callers that name lodges. */
  readonly shifts: readonly HutLeaderShift[];
};

/** Does the row's own date span claim `night`? Inclusive both ends. */
function shiftClaimsNight(shift: HutLeaderShift, night: Date): boolean {
  const time = night.getTime();
  return shift.startDate.getTime() <= time && time <= shift.endDate.getTime();
}

/**
 * A school-booking teacher row's presence: the school booking's own nights,
 * arrival through checkout − 1.
 *
 * The school writer stamps the row with `request.checkIn .. request.checkOut`
 * (`school-booking-request.ts`), so the row's span IS the booking's stay and its
 * last calendar day is the departure morning. Teachers are not `BookingGuest`
 * rows, so their presence cannot be read the way a member's is; this keeps
 * teacher rows counting as cover on the nights the school is actually there,
 * as #2926 decided, and stops them covering the night after the school leaves.
 * `hut-leader-night-cover-census.test.ts` pins the writer's stamp, because this
 * derivation is only true while the writer writes the checkout day.
 *
 * THIS IS THE ONE BRANCH #3819 (lane C) REPLACES with the per-lodge setting of
 * which kinds of leader may cover a school booking's nights. Replace it here;
 * do not add a second definition beside it.
 */
function isSchoolRowPresentOnNight(shift: HutLeaderShift, night: Date): boolean {
  const time = night.getTime();
  return shift.startDate.getTime() <= time && time < shift.endDate.getTime();
}

function isShiftPresentOnNight(
  shift: HutLeaderShift,
  night: Date,
  staysByMember: ReadonlyMap<string, readonly HutLeaderStay[]>,
): boolean {
  if (shift.bedId) return true;
  if (shift.source === HutLeaderAssignmentSource.SCHOOL_BOOKING) {
    return isSchoolRowPresentOnNight(shift, night);
  }
  const stays = staysByMember.get(shift.memberId);
  if (!stays) return false;
  return stays.some(
    (stay) =>
      stay.booking.lodgeId === shift.lodgeId &&
      isGuestActiveOnNight(stay, night, stay.booking),
  );
}

/** Does this row need a member stay to be present? (Custodians and teachers do not.) */
function needsMemberStay(shift: HutLeaderShift): boolean {
  return !shift.bedId && shift.source !== HutLeaderAssignmentSource.SCHOOL_BOOKING;
}

/**
 * The pure core: given the assignment rows and their members' stays, answer the
 * coverage question for any (lodge, night). No I/O, so every rule above is
 * testable without a database.
 */
export function buildHutLeaderNightCover(
  shifts: readonly HutLeaderShift[],
  stays: readonly HutLeaderStay[],
): HutLeaderNightCover {
  const staysByMember = new Map<string, HutLeaderStay[]>();
  for (const stay of stays) {
    if (!stay.memberId) continue;
    const list = staysByMember.get(stay.memberId) ?? [];
    list.push(stay);
    staysByMember.set(stay.memberId, list);
  }

  const coveringShifts = (lodgeId: string | null, night: Date) =>
    shifts.filter(
      (shift) =>
        shift.lodgeId === lodgeId &&
        shiftClaimsNight(shift, night) &&
        isShiftPresentOnNight(shift, night, staysByMember),
    );

  return {
    shifts,
    coveringShifts,
    isCovered: (lodgeId, night) => coveringShifts(lodgeId, night).length > 0,
  };
}

/**
 * Load the cover for every lodge in `scope` over the inclusive night window
 * `[from, to]`. Two reads, whatever the window: the assignments, then the stays
 * of the members on them — never one read per night or per member, because the
 * dashboard and the sidebar badge run this on every admin page load.
 *
 * Pass the transaction client when the answer decides a write (the cron's
 * locked re-ask): it is a read, so it is only authoritative under that lock.
 */
export async function loadHutLeaderNightCover(
  reader: HutLeaderNightCoverReader,
  input: { scope: HutLeaderNightCoverScope; from: Date; to: Date },
): Promise<HutLeaderNightCover> {
  const db = reader as unknown as HutLeaderNightCoverDb;
  const shifts = await db.hutLeaderAssignment.findMany({
    where: {
      ...(input.scope.kind === "lodge" ? { lodgeId: input.scope.lodgeId } : {}),
      startDate: { lte: input.to },
      endDate: { gte: input.from },
    },
    select: {
      id: true,
      memberId: true,
      lodgeId: true,
      startDate: true,
      endDate: true,
      source: true,
      bedId: true,
      member: { select: { firstName: true, lastName: true } },
      lodge: { select: { name: true, active: true } },
    },
  });

  const memberShifts = shifts.filter(needsMemberStay);
  if (memberShifts.length === 0) {
    return buildHutLeaderNightCover(shifts, []);
  }

  const memberIds = [...new Set(memberShifts.map((shift) => shift.memberId))];
  const lodgeIds = [
    ...new Set(
      memberShifts
        .map((shift) => shift.lodgeId)
        .filter((lodgeId): lodgeId is string => lodgeId !== null),
    ),
  ];

  const stays = await db.bookingGuest.findMany({
    where: {
      memberId: { in: memberIds },
      booking: {
        lodgeId: { in: lodgeIds },
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        deletedAt: null,
        checkIn: { lte: input.to },
        checkOut: { gt: input.from },
      },
      ...OPERATIONALLY_PRESENT_GUEST_WHERE,
    },
    select: {
      memberId: true,
      stayStart: true,
      stayEnd: true,
      nights: { select: { stayDate: true } },
      booking: { select: { lodgeId: true, checkIn: true, checkOut: true } },
    },
  });

  return buildHutLeaderNightCover(shifts, stays);
}

/**
 * The single-night form: is `night` covered at `lodgeId`? The auto-assign
 * cron's already-covered probe, asked once cheaply and once under the lodge
 * capacity lock with the transaction client.
 */
export async function isHutLeaderNightCovered(
  db: HutLeaderNightCoverReader,
  input: { lodgeId: string; night: Date },
): Promise<boolean> {
  const cover = await loadHutLeaderNightCover(db, {
    scope: { kind: "lodge", lodgeId: input.lodgeId },
    from: input.night,
    to: input.night,
  });
  return cover.isCovered(input.lodgeId, input.night);
}

/**
 * The leaders validly on duty for `night` at `lodgeId`, as the day-halves
 * derivation (`hut-leader-handover.ts`) reads them.
 */
export function hutLeadersOnNight(
  cover: HutLeaderNightCover,
  lodgeId: string | null,
  night: Date,
): HutLeaderOnNight[] {
  return cover.coveringShifts(lodgeId, night).map((shift) => ({
    memberId: shift.memberId,
    name: shift.member ? memberName(shift.member) : "",
  }));
}

/** The distinct lodges the cover holds assignments for, in first-seen order. */
function coverLodges(
  cover: HutLeaderNightCover,
): Array<{ lodgeId: string | null; lodgeName: string | null; lodgeActive: boolean | null }> {
  const seen = new Map<string, { lodgeId: string | null; lodgeName: string | null; lodgeActive: boolean | null }>();
  for (const shift of cover.shifts) {
    const key = shift.lodgeId ?? "";
    if (seen.has(key)) continue;
    seen.set(key, {
      lodgeId: shift.lodgeId,
      lodgeName: shift.lodge?.name ?? null,
      lodgeActive: shift.lodge?.active ?? null,
    });
  }
  return [...seen.values()];
}

/** A stored lodge night moved by whole calendar days (zone-free). */
function shiftNight(night: Date, days: number): Date {
  return dateOnlyInstantOf(addCalendarDays(calendarDateOfDateOnlyInstant(night), days));
}

function eachNight(from: Date, to: Date): Date[] {
  const nights: Date[] = [];
  for (let night = from; night.getTime() <= to.getTime(); night = shiftNight(night, 1)) {
    nights.push(night);
  }
  return nights;
}

/** One covered lodge night and who validly covers it (the calendar's input). */
export type HutLeaderNightLeaders = {
  date: string;
  lodgeId: string | null;
  leaders: HutLeaderOnNight[];
};

/** Every covered lodge night in `[from, to]`, date ascending. */
export function listHutLeaderNightLeaders(
  cover: HutLeaderNightCover,
  input: { from: Date; to: Date },
): HutLeaderNightLeaders[] {
  const rows: HutLeaderNightLeaders[] = [];
  const lodges = coverLodges(cover);
  for (const night of eachNight(input.from, input.to)) {
    for (const lodge of lodges) {
      const leaders = hutLeadersOnNight(cover, lodge.lodgeId, night);
      if (leaders.length > 0) {
        rows.push({ date: calendarDateOfDateOnlyInstant(night), lodgeId: lodge.lodgeId, leaders });
      }
    }
  }
  return rows;
}

/** One changeover: the leader of night D − 1 hands over to the leader of night D. */
export type HutLeaderHandover = {
  /** Calendar day D: the morning belongs to `from`, the afternoon to `to`. */
  date: string;
  lodgeId: string | null;
  lodgeName: string | null;
  lodgeActive: boolean | null;
  from: HutLeaderOnNight[];
  to: HutLeaderOnNight[];
};

/**
 * Every handover on a day in `[from, to]`: a day whose morning and afternoon
 * have different leaders and both have one (`deriveHutLeaderDayHalves`). The
 * cover must reach back to the night before `from`, because the morning of
 * `from` belongs to that night.
 */
export function listHutLeaderHandovers(
  cover: HutLeaderNightCover,
  input: { from: Date; to: Date },
): HutLeaderHandover[] {
  const handovers: HutLeaderHandover[] = [];
  const lodges = coverLodges(cover);
  for (const day of eachNight(input.from, input.to)) {
    for (const lodge of lodges) {
      const halves = deriveHutLeaderDayHalves(
        hutLeadersOnNight(cover, lodge.lodgeId, shiftNight(day, -1)),
        hutLeadersOnNight(cover, lodge.lodgeId, day),
      );
      if (!halves.isHandover) continue;
      handovers.push({
        date: calendarDateOfDateOnlyInstant(day),
        ...lodge,
        from: [...halves.morning],
        to: [...halves.afternoon],
      });
    }
  }
  return handovers;
}
