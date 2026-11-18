/**
 * The work-party facts more than one module needs (INV-SSOT), with no
 * database or server dependency so the calendar's shared modules can import
 * them too.
 *
 * - **Open:** a work party members can still select is active, and its
 *   internal promo is active and not archived. `OPEN_WORK_PARTY_EVENT_WHERE` is
 *   that rule as a query; `isOpenWorkPartyEvent` is the same rule on a row
 *   already read. The booking picker, the booking-create and promo-validate
 *   checks, the member page and dashboard card (#5148) and the calendar's
 *   visibility filter all use one of the two. Any other work-party rule that
 *   asks "is it open?" (for example #5149's correction refusal) calls
 *   `isOpenWorkPartyEvent` rather than writing the test inline.
 * - **The window:** `startDate`/`endDate` are date-only columns holding the
 *   first and the LAST discounted night, both inclusive. A stay covering the
 *   whole window checks out the day after the last night (booking stays are
 *   half-open), which is `workPartyCheckOutDay`.
 */
import type { Prisma } from "@prisma/client";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  compareCalendarDates,
  countClubNights,
  type CalendarDate,
} from "@/lib/club-time";

export const OPEN_WORK_PARTY_EVENT_WHERE = {
  active: true,
  promoCode: { active: true, archivedAt: null },
} satisfies Prisma.WorkPartyEventWhereInput;

export function isOpenWorkPartyEvent(event: {
  active: boolean;
  promoCode: { active: boolean; archivedAt: Date | null };
}): boolean {
  return (
    event.active && event.promoCode.active && !event.promoCode.archivedAt
  );
}

/**
 * Still upcoming (#5148): its LAST night is on or after the club's today, so a
 * work party finishing tonight still counts. `today` is the club's today as a
 * date-only instant (`clubTodayDateOnlyInstant()`). The query form and the row
 * form are the same rule; the dashboard card, the Join stay and "Add to
 * calendar" all use one of them.
 */
export function upcomingWorkPartyWhere(today: Date) {
  return { endDate: { gte: today } } satisfies Prisma.WorkPartyEventWhereInput;
}

export function isUpcomingWorkParty(
  event: { endDate: Date },
  today: Date,
): boolean {
  return (
    compareCalendarDates(
      calendarDateOfDateOnlyInstant(event.endDate),
      calendarDateOfDateOnlyInstant(today),
    ) >= 0
  );
}

/** The first discounted night, as a club calendar day. */
export function workPartyFirstNight(event: { startDate: Date }): CalendarDate {
  return calendarDateOfDateOnlyInstant(event.startDate);
}

/** The morning after the last discounted night: the window's exclusive end. */
export function workPartyCheckOutDay(event: { endDate: Date }): CalendarDate {
  return addCalendarDays(calendarDateOfDateOnlyInstant(event.endDate), 1);
}

/** How many nights the window holds, first and last both counted. */
export function workPartyNightCount(event: {
  startDate: Date;
  endDate: Date;
}): number {
  return countClubNights(workPartyFirstNight(event), workPartyCheckOutDay(event));
}

/**
 * The member work party page (#5148). It sits under `/dashboard`, a root the
 * app already owns, so the app reserves no `/work-parties` word and a club can
 * still publish a website page at that address (owner decision, 15 Nov 2026).
 * The dashboard card and the calendar's "Open the work party" link both build
 * it here.
 */
export function memberWorkPartyHref(workPartyEventId: string): string {
  return `/dashboard/work-parties/${encodeURIComponent(workPartyEventId)}`;
}

/** The booking page's query parameter a "Join Work Party" link carries. */
export const WORK_PARTY_JOIN_PARAM = "workParty";

/** "Join Work Party": the booking page, told which work party to fill in. */
export function bookJoinWorkPartyHref(workPartyEventId: string): string {
  return `/book?${WORK_PARTY_JOIN_PARAM}=${encodeURIComponent(workPartyEventId)}`;
}
