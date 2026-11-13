/**
 * The member side of work parties (fork #118): the dashboard card's list, the
 * `/work-parties/[id]` page and API, and the stay a "Join Work Party" click
 * fills into the booking page.
 *
 * Every read filters on `OPEN_WORK_PARTY_EVENT_WHERE`, so an inactive work
 * party (or one whose internal promo was switched off) is never shown, and an
 * id that is not open answers "not found". Nothing here selects the internal
 * promo code: a member must never see it, because the discount only enters a
 * booking through the work party selection.
 *
 * Dates: the work party's `startDate`/`endDate` are date-only columns holding
 * the first and the LAST discounted night, both inclusive. Booking stays are
 * half-open, so the stay a Join fills in checks out the day after `endDate`.
 * `today` is the club's today as a date-only instant
 * (`clubTodayDateOnlyInstant()`), passed in so this module stays usable outside
 * a request.
 */
import { prisma } from "@/lib/prisma";
import {
  calendarDateOfDateOnlyInstant,
  compareCalendarDates,
} from "@/lib/club-time";
import {
  OPEN_WORK_PARTY_EVENT_WHERE,
  workPartyCheckOutDay,
  workPartyFirstNight,
} from "@/lib/work-party-rules";

const MEMBER_WORK_PARTY_SELECT = {
  id: true,
  name: true,
  description: true,
  startDate: true,
  endDate: true,
  discountPercent: true,
  lodgeId: true,
  lodge: { select: { name: true } },
} as const;

/** The work party as a member sees it — never the internal promo code. */
export interface MemberWorkPartyDTO {
  id: string;
  name: string;
  description: string | null;
  /** First discounted night, `yyyy-MM-dd`. */
  startDate: string;
  /** Last discounted night (inclusive), `yyyy-MM-dd`. */
  endDate: string;
  discountPercent: number;
  /** Null for a club-wide work party, bookable at any lodge. */
  lodgeId: string | null;
  lodgeName: string | null;
  /**
   * The stay "Join Work Party" fills in, or null when it can no longer be
   * joined (its last night is before the club's today). Check-in is the first
   * night not already past; check-out is the morning after the last night.
   */
  join: { checkIn: string; checkOut: string } | null;
}

type MemberWorkPartyRow = {
  id: string;
  name: string;
  description: string | null;
  startDate: Date;
  endDate: Date;
  discountPercent: number;
  lodgeId: string | null;
  lodge: { name: string } | null;
};

/**
 * The stay a Join fills in. A work party that has started is joined from the
 * club's today, since a booking cannot check in in the past; one whose last
 * night has gone cannot be joined.
 */
export function workPartyJoinStay(
  workParty: { startDate: Date; endDate: Date },
  today: Date,
): { checkIn: string; checkOut: string } | null {
  const todayDay = calendarDateOfDateOnlyInstant(today);
  const lastNight = calendarDateOfDateOnlyInstant(workParty.endDate);
  if (compareCalendarDates(lastNight, todayDay) < 0) return null;
  const firstNight = workPartyFirstNight(workParty);
  return {
    checkIn: compareCalendarDates(firstNight, todayDay) < 0 ? todayDay : firstNight,
    checkOut: workPartyCheckOutDay(workParty),
  };
}

function toMemberWorkParty(
  row: MemberWorkPartyRow,
  today: Date,
): MemberWorkPartyDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    startDate: workPartyFirstNight(row),
    endDate: calendarDateOfDateOnlyInstant(row.endDate),
    discountPercent: row.discountPercent,
    lodgeId: row.lodgeId,
    lodgeName: row.lodge?.name ?? null,
    join: workPartyJoinStay(row, today),
  };
}

/** One open work party for the member page and API, or null (→ 404). */
export async function findMemberWorkParty(
  id: string,
  today: Date,
): Promise<MemberWorkPartyDTO | null> {
  const row = await prisma.workPartyEvent.findFirst({
    where: { id, ...OPEN_WORK_PARTY_EVENT_WHERE },
    select: MEMBER_WORK_PARTY_SELECT,
  });
  return row ? toMemberWorkParty(row, today) : null;
}

/**
 * Upcoming open work parties for the dashboard card: those whose last night is
 * on or after the club's today, soonest first. `take` is the card's limit.
 */
export async function listUpcomingMemberWorkParties(
  today: Date,
  take: number,
): Promise<MemberWorkPartyDTO[]> {
  const rows = await prisma.workPartyEvent.findMany({
    where: { ...OPEN_WORK_PARTY_EVENT_WHERE, endDate: { gte: today } },
    select: MEMBER_WORK_PARTY_SELECT,
    orderBy: [{ startDate: "asc" }, { endDate: "asc" }, { id: "asc" }],
    take,
  });
  return rows.map((row) => toMemberWorkParty(row, today));
}
